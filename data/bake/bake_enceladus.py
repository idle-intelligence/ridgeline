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
SRC_W, SRC_H = 8049, 4025
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
    """Inspect GeoTIFF tags; return (dtype, shape, nodata, need_roll)."""
    import tifffile
    print(f"\n=== Enceladus GeoTIFF inspection ===")
    with tifffile.TiffFile(ENCELADUS_FILE) as tif:
        page = tif.pages[0]
        dtype = page.dtype
        shape = (page.imagelength, page.imagewidth)
        nodata_val = None
        x_origin = None

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
                if len(vals) >= 6:
                    x_origin = vals[3]

        print(f"  dtype   : {dtype}")
        print(f"  shape   : {shape[1]} x {shape[0]}  (width x height)")
        print(f"  nodata  : {nodata_val}")

    need_roll = True
    if x_origin is not None:
        print(f"  x_origin (lon of left edge): {x_origin}")
        if x_origin < -90:
            need_roll = False
            print("  lon convention: -180..180 already (no roll)")
        else:
            print("  lon convention: 0..360E (will roll by half-width)")
    else:
        print("  lon convention: unknown (assuming -180..180, no roll)")
        need_roll = False

    return dtype, shape, nodata_val, need_roll


def load_elev(dtype, shape, nodata_val, need_roll):
    """Read Enceladus DEM -> float32 elevation metres above reference sphere."""
    import tifffile

    H, W = shape
    print(f"\nloading {ENCELADUS_FILE} ({W}x{H}, dtype={dtype}) ...")
    data = tifffile.imread(ENCELADUS_FILE)
    print(f"  loaded shape: {data.shape}, dtype: {data.dtype}")
    print(f"  raw range: {data.min():.4f} .. {data.max():.4f}  (expected ~km)")

    elev = data.astype(np.float64)

    # Mask nodata before converting units
    nodata_count = 0
    if nodata_val is not None:
        mask = np.abs(elev - nodata_val) < 1e-3 * abs(nodata_val + 1)
        nodata_count = int(mask.sum())
        if nodata_count > 0:
            print(f"  nodata pixels: {nodata_count:,}  (will fill with valid mean after km->m)")

    # Source is in KILOMETRES — convert to metres
    print("  converting km -> m (x1000)")
    elev *= 1000.0
    print(f"  elev range after km->m: {elev.min():.0f} .. {elev.max():.0f} m")

    if nodata_count > 0:
        valid_mean = float(elev[~mask].mean())
        elev[mask] = valid_mean
        print(f"  filled {nodata_count:,} nodata pixels with valid mean ({valid_mean:.0f} m)")

    elev = elev.astype(np.float32)
    print(f"  elev range (metres above ref): {elev.min():.0f} .. {elev.max():.0f}")

    if need_roll:
        elev = np.roll(elev, W // 2, axis=1)
        print(f"  rolled by {W // 2} cols to center on 0° meridian")

    return elev


def resample_to(arr, out_h, out_w):
    """Resample 2-D array to (out_h, out_w) using area-mean blocks where exact,
    or numpy bilinear interpolation for non-integer ratios."""
    src_h, src_w = arr.shape
    if src_h % out_h == 0 and src_w % out_w == 0:
        fh = src_h // out_h
        fw = src_w // out_w
        print(f"  exact block-mean resample: /{fh} rows, /{fw} cols")
        return arr.reshape(out_h, fh, out_w, fw).mean(axis=(1, 3)).astype(np.float32)
    else:
        print(f"  non-integer ratio {src_w}x{src_h} -> {out_w}x{out_h}, using numpy bilinear")
        # Map output pixel centres to source coordinates
        row_coords = np.linspace(0, src_h - 1, out_h)
        col_coords = np.linspace(0, src_w - 1, out_w)
        r0 = np.floor(row_coords).astype(np.int32)
        c0 = np.floor(col_coords).astype(np.int32)
        r1 = np.clip(r0 + 1, 0, src_h - 1)
        c1 = np.clip(c0 + 1, 0, src_w - 1)
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

    dtype, shape, nodata_val, need_roll = inspect_tiff()
    elev = load_elev(dtype, shape, nodata_val, need_roll)

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
