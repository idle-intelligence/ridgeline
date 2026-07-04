#!/usr/bin/env python3
"""
Global Mars elevation data-bake for the ridgeline explore mode (Mars).

Downloads NASA MGS MOLA MEGDR global topography (megt, public domain) from the
PDS Geosciences Node and writes the project binary format, matching bake_moon.py:

  mars_heightfield.bin - little-endian int16 METERS relative to the Mars areoid,
                         row-major, row 0 = NORTH (lat +90) -> south,
                         col 0 = WEST (lon -180) -> east (+180)
  mars_meta.json       - grid + format description (global bbox, ref radius)
  mars_preview.png     - small global grayscale elevation preview

No sea-level clamp (Mars has no oceans; reference is the areoid). Full relief
(~ -8.2 km Hellas to +21.2 km Olympus Mons) preserved.

MOLA encoding (from the PDS .LBL): MSB (big-endian) int16, value = meters of
topography directly (no SCALING_FACTOR, no OFFSET). Columns run 0..360 E, so we
roll by half-width to match our -180..180 (col 0 = west) convention; row 0 = N.

Source DEM cached under data/bake/cache/ (gitignored, not committed).
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, ".."))  # ridgeline/data/
CACHE_DIR = os.path.join(HERE, "cache")

# MOLA MEGDR global topography (megt), 32 pixels/degree, single global file.
# 11520 x 5760, MSB int16, no header (detached label). ~133 MB. (~1.85 km/px —
# finer than Earth's grid.) For a smaller bake, meg016/megt90n000eb.img is
# 5760x2880; or downsample this by an exact integer factor (÷2 -> 5760x2880).
MEGT_BASE = ("https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/"
             "mgsl_300x/meg032/")
MEGT_NAME = "megt90n000fb.img"
MEGT_URL = MEGT_BASE + MEGT_NAME
MEGT_FILE = os.path.join(CACHE_DIR, MEGT_NAME)

SRC_W, SRC_H = 11520, 5760       # native megt 32 ppd dims
MARS_RADIUS_M = 3389500          # IAU mean Mars radius (areoid global mean)
SOURCE = "NASA MGS MOLA MEGDR 32 ppd megt (PDS Geosciences Node)"

WIDTH = SRC_W
HEIGHT = SRC_H


def download():
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(MEGT_FILE) and os.path.getsize(MEGT_FILE) >= SRC_W * SRC_H * 2 - 1000:
        print(f"using cached {MEGT_FILE} ({os.path.getsize(MEGT_FILE)/1e6:.0f} MB)")
        return
    print(f"downloading {MEGT_URL}")
    import urllib.request
    urllib.request.urlretrieve(MEGT_URL, MEGT_FILE)
    print(f"  saved {os.path.getsize(MEGT_FILE)/1e6:.0f} MB")


def load_elev():
    """Read the MOLA megt .IMG -> float32 elevation [SRC_H,SRC_W] in meters above
    the areoid, row 0 = north, col 0 = west (-180). MOLA is BIG-ENDIAN int16, and
    stores topography in whole meters directly (no scaling/offset)."""
    dn = np.fromfile(MEGT_FILE, dtype=">i2")  # MSB / big-endian
    if dn.size != SRC_W * SRC_H:
        sys.exit(f"unexpected megt size: {dn.size} != {SRC_W*SRC_H}")
    dn = dn.reshape(SRC_H, SRC_W)             # row 0 = north already
    elev = dn.astype(np.float32)              # already meters of topography
    # MOLA columns run 0..360 E; roll by half-width so col 0 -> -180 (west),
    # putting the 0° meridian at the grid center.
    elev = np.roll(elev, SRC_W // 2, axis=1)
    return elev


def resample(elev, w, h):
    if (w, h) == (SRC_W, SRC_H):
        return elev
    # Area-mean only on exact division (else it would crop); nearest otherwise.
    if w <= SRC_W and h <= SRC_H and SRC_W % w == 0 and SRC_H % h == 0:
        fy, fx = SRC_H // h, SRC_W // w
        return elev.reshape(h, fy, w, fx).mean(axis=(1, 3)).astype(np.float32)
    print(f"  WARNING: {SRC_W}x{SRC_H} not an integer multiple of {w}x{h}; nearest-sample.")
    rows = np.round(np.linspace(0, SRC_H - 1, h)).astype(int)
    cols = np.round(np.linspace(0, SRC_W - 1, w)).astype(int)
    return np.asarray(elev[np.ix_(rows, cols)])


def main():
    global WIDTH, HEIGHT
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=WIDTH)
    ap.add_argument("--height", type=int, default=HEIGHT)
    args = ap.parse_args()
    WIDTH, HEIGHT = args.width, args.height

    download()
    elev = load_elev()
    if (WIDTH, HEIGHT) != (SRC_W, SRC_H):
        print(f"resampling MOLA {SRC_W}x{SRC_H} -> {WIDTH}x{HEIGHT}")
        elev = resample(elev, WIDTH, HEIGHT)

    elev16 = np.round(np.clip(elev, -32768, 32767)).astype("<i2")
    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "mars_heightfield.bin")
    elev16.tofile(hf_path)  # C-order rows = north->south, cols = west->east

    meta = {
        "bbox": {"lat_min": -90, "lat_max": 90, "lon_min": -180, "lon_max": 180},
        "width": WIDTH,
        "height": HEIGHT,
        "elev_min": elev_min,
        "elev_max": elev_max,
        "dtype": "int16",
        "byte_order": "little",
        "row_order": "north_to_south",
        "col_order": "west_to_east",
        "reference_radius_m": MARS_RADIUS_M,
        "source": SOURCE,
    }
    meta_path = os.path.join(OUT_DIR, "mars_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    # preview (full range -> grayscale, areoid reference = mid-gray)
    from PIL import Image
    pe = elev16.astype(np.float64)
    span = max(elev_max, -elev_min, 1)
    img = np.clip((pe / span) * 127 + 128, 0, 255).astype(np.uint8)
    Image.fromarray(img, "L").resize((2048, 1024)).save(
        os.path.join(OUT_DIR, "mars_preview.png"))

    print("\n=== mars bake summary ===")
    print(f"dims        : {WIDTH} x {HEIGHT}  ({WIDTH*HEIGHT:,} cells)")
    print(f"elev range  : {elev_min} .. {elev_max} m (rel. areoid)")
    print(f"source      : {SOURCE}")
    for p in (hf_path, meta_path):
        print(f"  {p}  ({os.path.getsize(p)/1024/1024:.2f} MiB)")

    verify(elev16)


def verify(elev16):
    """Spot-check known Mars features. row 0 = +90N, col 0 = -180W."""
    h, w = elev16.shape

    def sample(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return int(elev16[min(max(r, 0), h - 1), min(max(c, 0), w - 1)])

    checks = [
        ("Olympus Mons 18.65N -133.8E (>15km)", 18.65, -133.8, lambda v: v > 15000),
        ("Hellas basin -42.4N 70.5E (<-5km)",  -42.4, 70.5,   lambda v: v < -5000),
        ("Valles Marineris -13N -59E (low)",   -13.0, -59.0,  lambda v: v < 1000),
        ("Tharsis/Ascraeus 11.8N -104.5E (high)", 11.8, -104.5, lambda v: v > 5000),
    ]
    print("\n=== mars feature sanity ===")
    all_ok = True
    for name, lat, lon, ok in checks:
        v = sample(lat, lon)
        good = ok(v)
        all_ok &= good
        print(f"  [{'OK ' if good else '??'}] {name}: {v} m")
    print("range plausible" if all_ok else "some checks unexpected (inspect preview)")


if __name__ == "__main__":
    main()
