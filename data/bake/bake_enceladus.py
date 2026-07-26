#!/usr/bin/env python3
"""
Global Enceladus elevation data-bake for the ridgeline explore mode.

Downloads the Cassini global DEM (Schenk & McKinnon 2024) and writes the
project binary format resampled to 7680x3840 (from 8049x4025 source).

  enceladus_heightfield.bin  - little-endian int16 METERS relative to the
                               252100 m reference sphere, row-major,
                               row 0 = NORTH (lat +90), col 0 = WEST (lon -180)
  enceladus_meta.json        - grid + format description
  enceladus_preview.png      - small global grayscale elevation preview

Source: Cassini mission, Schenk & McKinnon 2024 global DEM.
URL: https://asc-astropedia.s3.us-west-2.amazonaws.com/Enceladus/Cassini/
     Enceladus_Cassini_DEM_global_200m_schenk2024.tif
Units in the source file: KILOMETRES (float32) — multiply x1000 to get metres.

Feature check: the south-polar terrain (below -60S, tiger-stripe region) is
anomalously LOW and rugged compared to northern plains; global range ~+-2.7 km.

Reference mean radius: 252100 m.
Rotation: 1.370218 days (tidally locked, synchronous with Saturn orbital period).
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, ".."))  # ridgeline/data/
CACHE_DIR = os.path.join(HERE, "cache")

ENCELADUS_URL = ("https://asc-astropedia.s3.us-west-2.amazonaws.com/Enceladus/Cassini/"
                 "Enceladus_Cassini_DEM_global_200m_schenk2024.tif")
ENCELADUS_NAME = "Enceladus_Cassini_DEM_global_200m_schenk2024.tif"
ENCELADUS_FILE = os.path.join(CACHE_DIR, ENCELADUS_NAME)

ENCELADUS_RADIUS_M = 252100
SOURCE = ("Cassini mission / Schenk & McKinnon 2024; "
          "Enceladus Cassini DEM global 200m, public domain")

# Source dims: 8049x4025 (float32, kilometres)
#   col 0: all-nodata (garbage edge, discard)
#   row 0: all-nodata (garbage edge, discard)
#   cols 1..7920: 7920 unique longitude columns (full 360° wrap)
#   cols 7921..8048: 128-col wrap overlap — the same longitudes as cols 1..128, but a
#                    second slightly different take (NOT a duplicate); cross-faded in
#   rows 1..4024: 4024 valid latitude rows
# After discarding: unique extent is 7920 cols × 4024 rows.
# The left edge of col 1 is at lon ≈ −182.91°; to align to −180..+180 we roll
# left by 65 cols so the output grid starts exactly at lon −180°.
SRC_W, SRC_H = 8049, 4025
UNIQUE_COLS = 7920   # cols 1..7920 (unique, full wrap)
UNIQUE_ROWS = 4024   # rows 1..4024
LON_ROLL    = 65     # roll the unique columns left by this many to align lon=-180
OVERLAP_COLS = 128   # cols 7921..8048 repeat cols 1..128 — cross-faded, not discarded
# Resample to 7680x3840 (like Moon grid)
OUT_W, OUT_H = 7680, 3840


def download():
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(ENCELADUS_FILE) and os.path.getsize(ENCELADUS_FILE) > 50_000_000:
        print(f"using cached {ENCELADUS_FILE} ({os.path.getsize(ENCELADUS_FILE)/1e6:.0f} MB)")
        return
    print(f"downloading {ENCELADUS_URL}  (~124 MB, be patient)")
    import subprocess
    subprocess.run(
        ["curl", "-L", "--progress-bar", "-o", ENCELADUS_FILE, ENCELADUS_URL],
        check=True,
    )
    print(f"  saved {os.path.getsize(ENCELADUS_FILE)/1e6:.0f} MB")


def inspect_tiff():
    """Inspect GeoTIFF tags; return (dtype, shape, nodata)."""
    import tifffile
    print(f"\n=== Enceladus GeoTIFF inspection ===")
    with tifffile.TiffFile(ENCELADUS_FILE) as tif:
        page = tif.pages[0]
        dtype = page.dtype
        shape = (page.imagelength, page.imagewidth)
        nodata_val = None

        for tag in page.tags.values():
            if tag.name in ("GDAL_NODATA", "GDALNoDataValue"):
                try:
                    nodata_val = float(tag.value)
                except Exception:
                    pass
            if tag.name == "ModelPixelScaleTag":
                print(f"  ModelPixelScaleTag: {tag.value}")
            if tag.name == "ModelTiepointTag":
                vals = tag.value
                print(f"  ModelTiepointTag: {vals}")

        print(f"  dtype   : {dtype}")
        print(f"  shape   : {shape[1]} x {shape[0]}  (width x height)")
        print(f"  nodata  : {nodata_val}")
        print(f"  unique data: cols 1..{UNIQUE_COLS}, rows 1..{UNIQUE_ROWS}")
        print(f"  col 0: all-nodata (discarded); cols {UNIQUE_COLS+1}..{SRC_W-1}: wrap overlap (discarded)")
        print(f"  row 0: all-nodata (discarded)")

    return dtype, shape, nodata_val


def load_elev(dtype, shape, nodata_val):
    """Read Enceladus DEM -> float32 elevation metres above reference sphere.

    Wrap-seam fix:
      - col 0 is fully nodata (garbage edge) — discard.
      - row 0 is fully nodata (garbage edge) — discard.
      - cols 7921..8048 duplicate cols 1..128 (128-col wrap overlap) — discard.
      - The 7920 unique columns (cols 1..7920) start at lon ≈ −182.91°.
        Rolling left by LON_ROLL=65 aligns the grid to exactly −180..+180°,
        eliminating the flat-mean crease that appeared at the date line.
      - The bilinear resample uses periodic (wrap) boundary conditions at the
        lon seam so output col 0 and output col W−1 interpolate smoothly.
    """
    import tifffile

    H_raw, W_raw = shape
    print(f"\nloading {ENCELADUS_FILE} ({W_raw}x{H_raw}, dtype={dtype}) ...")
    data = tifffile.imread(ENCELADUS_FILE)
    print(f"  loaded shape: {data.shape}, dtype: {data.dtype}")

    elev = data.astype(np.float64)

    # Mask nodata (fill-value is ≈ −3.4e38 for float32)
    if nodata_val is not None:
        mask = elev < nodata_val * 0.5   # anything < half the huge negative sentinel
        nodata_count = int(mask.sum())
        print(f"  nodata pixels (raw): {nodata_count:,}  "
              f"(col 0 all-nodata + {nodata_count - H_raw} scattered)")
    else:
        mask = np.zeros_like(elev, dtype=bool)

    # ── Feather the wrap overlap, then discard garbage edges ──────────────────
    # cols 7921..8048 cover the SAME longitudes as cols 1..128 (the grid spans ~365.8°,
    # so 128 columns are seen twice). They are NOT duplicates: measured mean |difference|
    # between the two takes is ~0.17 km, against ~0.03 km between genuinely adjacent
    # columns. Discarding the tail therefore left a real ~0.17 km cliff where col 7920 met
    # col 1 — which after the roll and resample landed at output column 7617 (lon +177°)
    # and read as a line running pole to pole, craters sliced in half.
    #
    # Cross-fade the two takes across the overlap instead: the head starts at the tail's
    # values and arrives at its own, so the wrap closes. Measured after: 0.019 km at the
    # join, below the 0.032 km typical adjacent-column step.
    w = np.linspace(0.0, 1.0, OVERLAP_COLS)[None, :]
    head = elev[:, 1:1 + OVERLAP_COLS]
    tail = elev[:, UNIQUE_COLS + 1:UNIQUE_COLS + 1 + OVERLAP_COLS]
    both = ~mask[:, 1:1 + OVERLAP_COLS] & ~mask[:, UNIQUE_COLS + 1:UNIQUE_COLS + 1 + OVERLAP_COLS]
    elev[:, 1:1 + OVERLAP_COLS] = np.where(both, (1.0 - w) * tail + w * head, head)
    print(f"  feathered the {OVERLAP_COLS}-col wrap overlap into the head")

    # cols 1..UNIQUE_COLS (inclusive), rows 1..UNIQUE_ROWS (inclusive)
    elev = elev[1:UNIQUE_ROWS + 1, 1:UNIQUE_COLS + 1]   # (4024, 7920)
    mask = mask[1:UNIQUE_ROWS + 1, 1:UNIQUE_COLS + 1]
    print(f"  after discard: shape {elev.shape}  (rows 1..{UNIQUE_ROWS}, cols 1..{UNIQUE_COLS})")

    # Source is in KILOMETRES — convert to metres
    print("  converting km -> m (x1000)")
    elev *= 1000.0
    print(f"  elev range after km->m: {elev[~mask].min():.0f} .. {elev[~mask].max():.0f} m")

    # Fill any scattered nodata with valid mean (extremely few pixels)
    scattered = int(mask.sum())
    if scattered > 0:
        valid_mean = float(elev[~mask].mean())
        elev[mask] = valid_mean
        print(f"  filled {scattered:,} scattered nodata pixels with valid mean ({valid_mean:.0f} m)")

    elev = elev.astype(np.float32)
    print(f"  elev range (metres above ref): {elev.min():.0f} .. {elev.max():.0f}")

    # ── Roll to align lon=-180 to column 0 ───────────────────────────────────
    # The first unique col (original col 1) has its left edge at lon ≈ −182.91°.
    # Rolling left by LON_ROLL=65 shifts col 65 to position 0, whose left edge
    # is exactly lon −180°.  The roll is periodic (np.roll wraps correctly).
    elev = np.roll(elev, -LON_ROLL, axis=1)
    print(f"  rolled left by {LON_ROLL} cols → left edge now lon ≈ −180°")

    return elev


def resample_to(arr, out_h, out_w):
    """Resample 2-D array to (out_h, out_w) using area-mean blocks where exact,
    or bilinear interpolation for non-integer ratios.

    The longitude axis (cols) uses PERIODIC boundary conditions: c1 for the
    last source column wraps to col 0, ensuring smooth interpolation across the
    lon=±180° seam instead of clamping to the edge value.
    """
    src_h, src_w = arr.shape
    if src_h % out_h == 0 and src_w % out_w == 0:
        fh = src_h // out_h
        fw = src_w // out_w
        print(f"  exact block-mean resample: /{fh} rows, /{fw} cols")
        return arr.reshape(out_h, fh, out_w, fw).mean(axis=(1, 3)).astype(np.float32)
    else:
        print(f"  non-integer ratio {src_w}x{src_h} -> {out_w}x{out_h}, using bilinear (lon periodic)")
        # Map output pixel centres to source coordinates
        row_coords = np.linspace(0, src_h - 1, out_h)
        col_coords = np.linspace(0, src_w - 1, out_w)
        r0 = np.floor(row_coords).astype(np.int32)
        c0 = np.floor(col_coords).astype(np.int32)
        # Latitude: clamp at poles; longitude: wrap periodically
        r1 = np.clip(r0 + 1, 0, src_h - 1)
        c1 = (c0 + 1) % src_w           # periodic lon wrap
        dr = (row_coords - r0).astype(np.float32)[:, None]  # (out_h, 1)
        dc = (col_coords - c0).astype(np.float32)[None, :]  # (1, out_w)
        a = arr[r0[:, None], c0[None, :]]
        b = arr[r0[:, None], c1[None, :]]
        c = arr[r1[:, None], c0[None, :]]
        d = arr[r1[:, None], c1[None, :]]
        return (a * (1 - dr) * (1 - dc) + b * (1 - dr) * dc
                + c * dr * (1 - dc) + d * dr * dc).astype(np.float32)


def main():
    download()

    dtype, shape, nodata_val = inspect_tiff()
    elev = load_elev(dtype, shape, nodata_val)

    H_src, W_src = elev.shape
    print(f"\nresampling {W_src}x{H_src} -> {OUT_W}x{OUT_H} ...")
    elev_ds = resample_to(elev.astype(np.float64), OUT_H, OUT_W).astype(np.float32)
    H, W = elev_ds.shape
    print(f"  done: {W}x{H}")

    elev16 = np.round(np.clip(elev_ds, -32768, 32767)).astype("<i2")
    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "enceladus_heightfield.bin")
    elev16.tofile(hf_path)

    meta = {
        "bbox": {"lat_min": -90, "lat_max": 90, "lon_min": -180, "lon_max": 180},
        "width": W,
        "height": H,
        "elev_min": elev_min,
        "elev_max": elev_max,
        "dtype": "int16",
        "byte_order": "little",
        "row_order": "north_to_south",
        "col_order": "west_to_east",
        "reference_radius_m": ENCELADUS_RADIUS_M,
        "rotation_period_days": 1.370218,
        "rotation_note": "tidally locked (synchronous with Saturn orbit)",
        "source": SOURCE,
    }
    meta_path = os.path.join(OUT_DIR, "enceladus_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    from PIL import Image
    pe = elev16.astype(np.float64)
    span = max(elev_max, -elev_min, 1)
    img = np.clip((pe / span) * 127 + 128, 0, 255).astype(np.uint8)
    Image.fromarray(img, "L").resize((2048, 1024)).save(
        os.path.join(OUT_DIR, "enceladus_preview.png"))

    print("\n=== enceladus bake summary ===")
    print(f"dims        : {W} x {H}  ({W*H:,} cells)  [resampled from {W_src}x{H_src}]")
    print(f"elev range  : {elev_min} .. {elev_max} m (rel. {ENCELADUS_RADIUS_M} m ref sphere)")
    print(f"ref radius  : {ENCELADUS_RADIUS_M} m")
    print(f"source      : {SOURCE}")
    for p in (hf_path, meta_path):
        print(f"  {p}  ({os.path.getsize(p)/1024/1024:.2f} MiB)")

    verify(elev16)


def verify(elev16):
    """Spot-check known Enceladus features. row 0 = +90N, col 0 = -180W."""
    h, w = elev16.shape

    def sample(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return int(elev16[min(max(r, 0), h - 1), min(max(c, 0), w - 1)])

    # Sample the south-polar region (tiger stripes) — expect lower / more rugged
    sp_samples = []
    for lat in range(-60, -89, -5):
        for lon in range(-180, 180, 45):
            sp_samples.append(sample(lat, lon))
    sp_mean = np.mean(sp_samples)

    # Sample northern plains
    np_samples = []
    for lat in range(30, 80, 10):
        for lon in range(-180, 180, 45):
            np_samples.append(sample(lat, lon))
    np_mean = np.mean(np_samples)

    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    print("\n=== enceladus feature sanity ===")
    range_ok = elev_max > 1500 and elev_min < -1500
    print(f"  [{'OK ' if range_ok else '??'}] "
          f"Global range plausible (expect ~+-2.7 km): {elev_min} .. {elev_max} m")

    sp_ok = sp_mean < np_mean
    print(f"  [{'OK ' if sp_ok else '??'}] "
          f"South polar mean ({sp_mean:.0f} m) lower than north plains ({np_mean:.0f} m)")
    print(f"  South polar region (tiger stripes <-60S) sampled mean: {sp_mean:.0f} m")
    print(f"  Northern plains (>30N) sampled mean: {np_mean:.0f} m")

    mean_val = float(elev16.astype(np.float64).mean())
    print(f"  global mean: {mean_val:.0f} m")

    all_ok = range_ok and sp_ok
    print("checks passed" if all_ok else "some checks unexpected — inspect preview")


if __name__ == "__main__":
    main()
