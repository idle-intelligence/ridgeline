#!/usr/bin/env python3
"""
Global Mercury elevation data-bake for the ridgeline explore mode (Mercury).

Downloads the USGS MESSENGER global DEM GeoTIFF and writes the project binary
format at half native resolution (÷2 block mean):

  mercury_heightfield.bin - little-endian int16 METERS relative to the 2439400 m
                            reference sphere, row-major, row 0 = NORTH (lat +90),
                            col 0 = WEST (lon -180) -> east (+180)
  mercury_meta.json       - grid + format description
  mercury_preview.png     - small global grayscale elevation preview

Source: USGS Astrogeology Science Center / NASA MESSENGER, Mercury MESSENGER
USGS DEM Global 665m v2, public domain.

Script inspects actual GeoTIFF tags (dtype, nodata, scale/offset, lon convention)
at runtime and adapts accordingly (prints all findings).
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, ".."))   # ridgeline/data/
CACHE_DIR = os.path.join(HERE, "cache")

MERCURY_URL = ("https://planetarymaps.usgs.gov/mosaic/"
               "Mercury_Messenger_USGS_DEM_Global_665m_v2.tif")
MERCURY_NAME = "Mercury_Messenger_USGS_DEM_Global_665m_v2.tif"
MERCURY_FILE = os.path.join(CACHE_DIR, MERCURY_NAME)

# Reference sphere radius (MESSENGER standard), metres.
MERCURY_RADIUS_M = 2439400
SOURCE = ("USGS Astrogeology Science Center / NASA MESSENGER, "
          "Mercury MESSENGER USGS DEM Global 665m v2, public domain")

# Native dims: 23040 x 11520 at 64 ppd.
SRC_W, SRC_H = 23040, 11520
# Downsample ÷2 -> 11520 x 5760
OUT_W, OUT_H = SRC_W // 2, SRC_H // 2


def download():
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(MERCURY_FILE) and os.path.getsize(MERCURY_FILE) > 100_000_000:
        print(f"using cached {MERCURY_FILE} ({os.path.getsize(MERCURY_FILE)/1e6:.0f} MB)")
        return
    print(f"downloading {MERCURY_URL}  (~506 MB, be patient)")
    import subprocess
    subprocess.run(
        ["curl", "-L", "--progress-bar", "-o", MERCURY_FILE, MERCURY_URL],
        check=True,
    )
    print(f"  saved {os.path.getsize(MERCURY_FILE)/1e6:.0f} MB")


def inspect_tiff():
    """Return (dtype, shape, nodata, scale, offset, need_roll) after inspecting tags."""
    import tifffile
    import xml.etree.ElementTree as ET

    print(f"\n=== Mercury GeoTIFF inspection ===")
    with tifffile.TiffFile(MERCURY_FILE) as tif:
        page = tif.pages[0]
        dtype = page.dtype
        shape = (page.imagelength, page.imagewidth)
        nodata_val = None
        scale = 1.0
        offset = 0.0
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
            # Parse GDAL_METADATA XML for SCALE/OFFSET per-band
            if tag.name == "GDAL_METADATA":
                xml_str = tag.value
                print(f"  tag {tag.code} GDAL_METADATA: {xml_str[:300]}")
                try:
                    root = ET.fromstring(xml_str)
                    for item in root.iter("Item"):
                        role = item.get("role", "")
                        if role == "scale":
                            scale = float(item.text)
                            print(f"  GDAL scale: {scale}")
                        elif role == "offset":
                            offset = float(item.text)
                            print(f"  GDAL offset: {offset}")
                except Exception as e:
                    print(f"  WARNING: could not parse GDAL_METADATA XML: {e}")

        print(f"  dtype   : {dtype}")
        print(f"  shape   : {shape[1]} x {shape[0]}  (width x height)")
        print(f"  nodata  : {nodata_val}")
        print(f"  scale   : {scale}  offset: {offset}")

    # Lon convention: x_origin near 0 => 0..360E (need roll); near -180 => already centered.
    need_roll = True
    if x_origin is not None:
        print(f"  x_origin (lon of left edge): {x_origin}")
        if x_origin < -90:
            need_roll = False
            print("  lon convention: -180..180 already (no roll)")
        else:
            print("  lon convention: 0..360E (will roll by half-width)")
    else:
        print("  lon convention: assuming 0..360E (no tiepoint found; will roll)")

    return dtype, shape, nodata_val, scale, offset, need_roll


def load_elev(dtype, shape, nodata_val, scale, offset, need_roll):
    """Read Mercury DEM -> float32 elevation metres above reference sphere."""
    import tifffile

    H, W = shape
    print(f"\nloading {MERCURY_FILE} ({W}x{H}, dtype={dtype}) ...")
    data = tifffile.imread(MERCURY_FILE)
    print(f"  loaded shape: {data.shape}, dtype: {data.dtype}")
    print(f"  raw range: {data.min()} .. {data.max()}")

    # Convert to float for processing
    elev = data.astype(np.float64)

    # Apply nodata mask before scale/offset
    nodata_count = 0
    if nodata_val is not None:
        if np.issubdtype(data.dtype, np.integer):
            mask = data == int(nodata_val)
        else:
            mask = np.abs(elev - nodata_val) < 1.0
        nodata_count = int(mask.sum())
        if nodata_count > 0:
            print(f"  nodata pixels: {nodata_count:,}  (will fill with valid mean after decode)")

    # Decode raw values to metres above reference sphere.
    # Priority:
    #   1. GDAL SCALE/OFFSET from GeoTIFF metadata (elev = raw * scale + offset)
    #   2. Radius-encoded detection (median near MERCURY_RADIUS_M -> subtract)
    #   3. Assume raw values are already metres
    raw_median = float(np.median(data[data != int(nodata_val)] if nodata_val is not None else data))
    if scale != 1.0 or offset != 0.0:
        print(f"  applying GDAL scale={scale}, offset={offset}  (elev = raw * scale + offset)")
        elev = elev * scale + offset
    elif abs(raw_median - MERCURY_RADIUS_M) < 10000:
        print(f"  DETECTED: radius-encoded (median {raw_median:.0f} ≈ ref radius {MERCURY_RADIUS_M})")
        print(f"  Decoding: elev = raw - {MERCURY_RADIUS_M}")
        elev = elev - MERCURY_RADIUS_M
    else:
        print(f"  raw median: {raw_median:.0f}  (assuming metres above ref sphere already)")

    # Fill nodata after decoding
    if nodata_count > 0:
        if np.issubdtype(data.dtype, np.integer):
            mask = data == int(nodata_val)
        else:
            mask = np.abs(data.astype(np.float64) - nodata_val) < 1.0
        valid_mean = float(elev[~mask].mean())
        elev[mask] = valid_mean
        print(f"  filled {nodata_count:,} nodata pixels with valid mean ({valid_mean:.0f} m)")

    elev = elev.astype(np.float32)
    print(f"  elev range (metres above ref): {elev.min():.0f} .. {elev.max():.0f}")

    if need_roll:
        elev = np.roll(elev, W // 2, axis=1)
        print(f"  rolled by {W // 2} cols to center on 0° meridian")

    return elev


def block_reduce_2(arr):
    """Exact block mean downsample by factor 2."""
    H, W = arr.shape
    return arr.reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3))


def main():
    download()

    dtype, shape, nodata_val, scale, offset, need_roll = inspect_tiff()
    elev = load_elev(dtype, shape, nodata_val, scale, offset, need_roll)

    H_src, W_src = elev.shape
    print(f"\ndownsampling {W_src}x{H_src} -> {W_src//2}x{H_src//2} by block mean ÷2 ...")
    elev_ds = block_reduce_2(elev.astype(np.float64)).astype(np.float32)
    H, W = elev_ds.shape
    print(f"  done: {W}x{H}")

    elev16 = np.round(np.clip(elev_ds, -32768, 32767)).astype("<i2")
    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "mercury_heightfield.bin")
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
        "reference_radius_m": MERCURY_RADIUS_M,
        "source": SOURCE,
    }
    meta_path = os.path.join(OUT_DIR, "mercury_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    from PIL import Image
    pe = elev16.astype(np.float64)
    span = max(elev_max, -elev_min, 1)
    img = np.clip((pe / span) * 127 + 128, 0, 255).astype(np.uint8)
    Image.fromarray(img, "L").resize((2048, 1024)).save(
        os.path.join(OUT_DIR, "mercury_preview.png"))

    print("\n=== mercury bake summary ===")
    print(f"dims        : {W} x {H}  ({W*H:,} cells)  [downsampled ÷2 from {W_src}x{H_src}]")
    print(f"elev range  : {elev_min} .. {elev_max} m (rel. {MERCURY_RADIUS_M} m ref sphere)")
    print(f"ref radius  : {MERCURY_RADIUS_M} m")
    print(f"source      : {SOURCE}")
    for p in (hf_path, meta_path):
        print(f"  {p}  ({os.path.getsize(p)/1024/1024:.2f} MiB)")

    verify(elev16)


def verify(elev16):
    """Spot-check known Mercury features. row 0 = +90N, col 0 = -180W."""
    h, w = elev16.shape

    def sample(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return int(elev16[min(max(r, 0), h - 1), min(max(c, 0), w - 1)])

    checks = [
        # Caloris basin interior: relatively lower, ~30N 190E = -170E
        ("Caloris basin interior ~30N -170E (low)", 30.0, -170.0, lambda v: v < 1000),
        # North polar region: expect varied terrain
        ("North pole area 85N 0E (present)", 85.0, 0.0, lambda v: True),
        # Global range plausibility: Mercury relief ~10km total
        ("Global max > 2000 m", 0.0, 0.0, lambda v: True),  # checked separately
    ]

    print("\n=== mercury feature sanity ===")
    all_ok = True
    for name, lat, lon, ok in checks[:2]:
        v = sample(lat, lon)
        good = ok(v)
        all_ok &= good
        print(f"  [{'OK ' if good else '??'}] {name}: {v} m")

    elev_min = int(elev16.min())
    elev_max = int(elev16.max())
    range_ok = elev_max > 2000 and elev_min < -2000
    all_ok &= range_ok
    print(f"  [{'OK ' if range_ok else '??'}] "
          f"Global range plausible (expect ~±5 km): {elev_min} .. {elev_max} m")

    mean_val = float(elev16.astype(np.float64).mean())
    print(f"  global mean: {mean_val:.0f} m")
    print("checks passed" if all_ok else "some checks unexpected — inspect preview")


if __name__ == "__main__":
    main()
