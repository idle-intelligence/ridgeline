#!/usr/bin/env python3
"""
Offline SRTM3 data-bake for the ridgeline flight game.

Fetches SRTM3 (~90 m) elevation for a France bounding box, samples it into a
regular lat/lon grid, fills voids, and writes a compact binary heightfield plus
metadata that the Rust/WASM core and JS shell load directly.

Outputs (written to ../  i.e. ridgeline/data/):
  heightfield.bin  - little-endian int16 meters, row-major,
                     north->south rows, west->east columns
  meta.json        - grid + format description
  water_mask.bin   - optional uint8 0/1, 1 = flat water, same dims/order
  preview.png      - grayscale elevation preview

Reads SRTM HGT tiles directly out of the srtm.py tile cache (~/.cache/srtm)
and vectorizes sampling with numpy, which is far faster than per-point
get_elevation() calls for million-cell grids.
"""
import argparse
import json
import math
import os
import struct
import sys

import numpy as np

# srtm tiles store a square_side x square_side grid of big-endian int16,
# row 0 = north edge, col 0 = west edge, this sentinel = void/no-data.
SRTM_NODATA = -32768

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, ".."))  # ridgeline/data/


def _tile_array(geo_data, lat_tile, lon_tile):
    """Return (square_side x square_side) int32 array for the 1x1deg tile whose
    SW corner is (lat_tile, lon_tile), or None if no tile exists / ocean.

    NODATA cells are returned as SRTM_NODATA so the caller can fill them.
    """
    # Query a point safely inside the tile so srtm.py picks the right file.
    f = geo_data.get_file(lat_tile + 0.5, lon_tile + 0.5)
    if f is None or not getattr(f, "data", None):
        return None, None
    side = int(math.sqrt(len(f.data) / 2.0))
    arr = np.frombuffer(f.data, dtype=">i2").astype(np.int32)
    arr = arr.reshape(side, side)  # row 0 = north, col 0 = west
    return arr, side


def fetch_grid(bbox, width, height, srtm_cache=None, synthetic=False):
    """Sample SRTM3 onto a regular grid.

    Returns (elev int32 [height,width], filled_bool, source_str).
    Grid row 0 = lat_max (north), col 0 = lon_min (west).
    elev cells that are still void after tile assembly carry SRTM_NODATA.
    """
    lat_min, lat_max = bbox["lat_min"], bbox["lat_max"]
    lon_min, lon_max = bbox["lon_min"], bbox["lon_max"]

    # Target sample coordinates. North->south rows, west->east cols.
    lats = np.linspace(lat_max, lat_min, height)
    lons = np.linspace(lon_min, lon_max, width)

    if synthetic:
        return _synthetic_grid(lats, lons), "SYNTHETIC"

    import srtm
    geo_data = srtm.get_data(srtm1=False, srtm3=True,
                             local_cache_dir=srtm_cache or "")

    out = np.full((height, width), SRTM_NODATA, dtype=np.int32)

    # Iterate over the 1x1deg tiles the bbox spans; for each, gather the
    # target grid columns/rows that fall inside it and vector-sample.
    tile_lat0 = math.floor(lat_min)
    tile_lat1 = math.floor(lat_max - 1e-9)
    tile_lon0 = math.floor(lon_min)
    tile_lon1 = math.floor(lon_max - 1e-9)

    tiles_total = (tile_lat1 - tile_lat0 + 1) * (tile_lon1 - tile_lon0 + 1)
    tiles_done = 0
    tiles_missing = 0

    for tlat in range(tile_lat0, tile_lat1 + 1):
        # rows of the target grid that fall in [tlat, tlat+1)
        row_idx = np.where((lats >= tlat) & (lats < tlat + 1))[0]
        if row_idx.size == 0:
            continue
        for tlon in range(tile_lon0, tile_lon1 + 1):
            col_idx = np.where((lons >= tlon) & (lons < tlon + 1))[0]
            tiles_done += 1
            sys.stderr.write(
                f"\r  tiles {tiles_done}/{tiles_total} "
                f"(N{tlat} E{tlon})        ")
            sys.stderr.flush()
            if col_idx.size == 0:
                continue
            arr, side = _tile_array(geo_data, tlat, tlon)
            if arr is None:
                tiles_missing += 1
                continue  # leave as NODATA (typically open ocean)

            # Map target lat/lon -> tile row/col (nearest sample).
            # tile row 0 is the north edge (lat = tlat+1), col 0 is west edge.
            sub_lats = lats[row_idx]
            sub_lons = lons[col_idx]
            trows = np.round((tlat + 1 - sub_lats) * (side - 1)).astype(int)
            tcols = np.round((sub_lons - tlon) * (side - 1)).astype(int)
            np.clip(trows, 0, side - 1, out=trows)
            np.clip(tcols, 0, side - 1, out=tcols)

            block = arr[np.ix_(trows, tcols)]
            out[np.ix_(row_idx, col_idx)] = block

    sys.stderr.write("\n")
    if tiles_missing:
        sys.stderr.write(
            f"  {tiles_missing}/{tiles_total} tiles missing "
            f"(ocean or unavailable) -> filled as sea level\n")
    return out, "SRTM3"


def _synthetic_grid(lats, lons):
    """Deterministic fake terrain so the binary format is testable offline.
    A couple of gaussian 'peaks' + ridges. Clearly not real data."""
    H, W = lats.size, lons.size
    yy, xx = np.meshgrid(np.linspace(0, 1, H), np.linspace(0, 1, W),
                         indexing="ij")
    z = (1800 * np.exp(-(((xx - 0.4) ** 2 + (yy - 0.35) ** 2) / 0.02))
         + 1200 * np.exp(-(((xx - 0.65) ** 2 + (yy - 0.6) ** 2) / 0.03))
         + 400 * np.sin(xx * 25) * np.sin(yy * 18))
    z = np.clip(z, 0, None)
    return z.astype(np.int32)


def fill_voids(elev):
    """Fill SRTM_NODATA holes by nearest-valid value (vectorized BFS-free
    distance transform fallback). Returns (filled int32, method_str)."""
    void = elev == SRTM_NODATA
    if not void.any():
        return elev, "none_needed"
    valid = ~void
    if not valid.any():
        # entire grid void: clamp to 0 (sea level)
        elev = np.zeros_like(elev)
        return elev, "all_void_to_zero"
    try:
        from scipy import ndimage
        idx = ndimage.distance_transform_edt(
            void, return_distances=False, return_indices=True)
        elev = elev[tuple(idx)]
        return elev, "nearest_valid_edt"
    except Exception:
        # Lightweight fallback: iterative dilation fill (no scipy dep).
        filled = elev.copy()
        m = void.copy()
        # Replace voids with min valid as a seed, then smooth-fill by
        # repeatedly averaging in 4-neighbour valid values.
        filled[m] = 0
        for _ in range(64):
            if not m.any():
                break
            up = np.roll(filled, 1, 0)
            dn = np.roll(filled, -1, 0)
            lf = np.roll(filled, 1, 1)
            rt = np.roll(filled, -1, 1)
            upm = np.roll(~m, 1, 0)
            dnm = np.roll(~m, -1, 0)
            lfm = np.roll(~m, 1, 1)
            rtm = np.roll(~m, -1, 1)
            cnt = (upm + dnm + lfm + rtm).astype(np.float64)
            ssum = (up * upm + dn * dnm + lf * lfm + rt * rtm)
            fillable = m & (cnt > 0)
            filled[fillable] = (ssum[fillable] / cnt[fillable]).astype(np.int32)
            m = m & ~fillable
        return filled, "nearest_valid_dilation"


def detect_water(elev, water_ntile=8, lake_flatness=3):
    """Flat-water mask via the RidgeShirts approach: low elevation percentile
    OR very small local gradient. Returns uint8 [H,W] with 1 = water."""
    e = elev.astype(np.float64)
    rng = e.max() - e.min()
    if rng <= 0:
        return np.zeros(elev.shape, dtype=np.uint8)
    norm = (e - e.min()) / rng

    is_low = norm < np.percentile(norm, water_ntile)

    # Local gradient magnitude on a 3x3 neighbourhood (max-min), scaled to 0-255
    # like img_as_ubyte to mirror ridge_map's rank.gradient(square(3)).
    u8 = (norm * 255).astype(np.float64)
    lo = u8.copy()
    hi = u8.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            sh = np.roll(np.roll(u8, dy, 0), dx, 1)
            lo = np.minimum(lo, sh)
            hi = np.maximum(hi, sh)
    grad = hi - lo
    is_flat = grad < lake_flatness

    return (is_low | is_flat).astype(np.uint8)


def save_preview(elev, path):
    """Grayscale elevation PNG via Pillow (no matplotlib dep)."""
    from PIL import Image
    e = elev.astype(np.float64)
    lo, hi = e.min(), e.max()
    if hi <= lo:
        img = np.zeros(elev.shape, dtype=np.uint8)
    else:
        img = np.clip((e - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
    Image.fromarray(img, mode="L").save(path)


def main():
    ap = argparse.ArgumentParser(description="Bake SRTM3 -> heightfield.bin")
    ap.add_argument("--lat-min", type=float, default=41.0)
    ap.add_argument("--lat-max", type=float, default=51.5)
    ap.add_argument("--lon-min", type=float, default=-5.5)
    ap.add_argument("--lon-max", type=float, default=9.8)
    ap.add_argument("--width", type=int, default=2048)
    ap.add_argument("--height", type=int, default=2048)
    ap.add_argument("--out-dir", default=OUT_DIR)
    ap.add_argument("--srtm-cache", default=None,
                    help="SRTM tile cache dir (default ~/.cache/srtm)")
    ap.add_argument("--no-water", action="store_true",
                    help="skip water_mask.bin")
    ap.add_argument("--water-ntile", type=float, default=8.0)
    ap.add_argument("--lake-flatness", type=float, default=3.0)
    ap.add_argument("--synthetic", action="store_true",
                    help="generate fake terrain (no network) to test format")
    args = ap.parse_args()

    bbox = {"lat_min": args.lat_min, "lat_max": args.lat_max,
            "lon_min": args.lon_min, "lon_max": args.lon_max}
    W, H = args.width, args.height
    os.makedirs(args.out_dir, exist_ok=True)

    print(f"baking grid {W}x{H} over bbox "
          f"lat[{bbox['lat_min']},{bbox['lat_max']}] "
          f"lon[{bbox['lon_min']},{bbox['lon_max']}] "
          f"{'(SYNTHETIC)' if args.synthetic else '(SRTM3)'}")

    try:
        elev, source = fetch_grid(bbox, W, H, args.srtm_cache, args.synthetic)
    except Exception as e:
        print(f"\nERROR: SRTM fetch failed: {e}", file=sys.stderr)
        print("Re-run with --synthetic to test the pipeline/format offline.",
              file=sys.stderr)
        sys.exit(2)

    elev, fill_method = fill_voids(elev)
    print(f"void-fill: {fill_method}")

    # clamp to [0, int16]: sea sits at exactly 0 (SRTM has no bathymetry; the only
    # sub-zero cells are ocean/void-fill artifacts — land is never below sea level here).
    np.clip(elev, 0, 32767, out=elev)
    elev16 = elev.astype("<i2")  # little-endian int16

    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    hf_path = os.path.join(args.out_dir, "heightfield.bin")
    elev16.tofile(hf_path)  # row-major C order = north->south, west->east

    meta = {
        "bbox": bbox,
        "width": W,
        "height": H,
        "elev_min": elev_min,
        "elev_max": elev_max,
        "dtype": "int16",
        "byte_order": "little",
        "row_order": "north_to_south",
        "col_order": "west_to_east",
        "nodata_fill": fill_method,
        "source": source,
    }
    meta_path = os.path.join(args.out_dir, "meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    files = [(hf_path, os.path.getsize(hf_path)),
             (meta_path, os.path.getsize(meta_path))]

    if not args.no_water:
        water = detect_water(elev, args.water_ntile, args.lake_flatness)
        wpath = os.path.join(args.out_dir, "water_mask.bin")
        water.tofile(wpath)  # uint8, same row/col order
        files.append((wpath, os.path.getsize(wpath)))
        wpct = 100.0 * water.mean()
        print(f"water mask: {wpct:.1f}% of cells flagged as flat water")

    prev_path = os.path.join(args.out_dir, "preview.png")
    save_preview(elev, prev_path)
    files.append((prev_path, os.path.getsize(prev_path)))

    print("\n=== bake summary ===")
    print(f"dims         : {W} x {H}  ({W*H:,} cells)")
    print(f"elev range   : {elev_min} .. {elev_max} m")
    print(f"source       : {source}")
    print("files written:")
    for p, sz in files:
        print(f"  {p}  ({sz/1024/1024:.2f} MiB)" if sz > 1 << 20
              else f"  {p}  ({sz/1024:.1f} KiB)")


if __name__ == "__main__":
    main()
