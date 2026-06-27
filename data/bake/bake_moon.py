#!/usr/bin/env python3
"""
Global lunar elevation data-bake for the ridgeline explore mode (the Moon).

Downloads NASA LRO LOLA global DEM (LDEM, public domain) from the PDS
Geosciences Node and writes the project binary format, matching bake_earth.py:

  moon_heightfield.bin - little-endian int16 METERS relative to the 1737.4 km
                         lunar reference sphere, row-major,
                         row 0 = NORTH (lat +90) -> south (lat -90),
                         col 0 = WEST (lon -180) -> east (+180)
  moon_meta.json       - grid + format description (global bbox, ref radius)
  moon_preview.png     - small global grayscale elevation preview

Unlike Earth there is NO ocean / sea-level clamp: the Moon's reference is the
geometric sphere and basins are genuinely below it (down to ~ -9 km). The full
relief (~ -9.1 km .. +10.8 km) is preserved.

LOLA encoding (from the PDS .LBL): LSB int16, SCALING_FACTOR 0.5, OFFSET
1737400 (radius). Elevation above the sphere = DN * 0.5. Columns run 0..360 E,
so we roll by half-width to match our -180..180 (col 0 = west) convention.

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

# LOLA global DEM, single global equirectangular .IMG (LSB int16, detached label).
# Available ppd → native dims: 4→1440x720, 16→5760x2880, 64→23040x11520.
LDEM_BASE = ("https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/"
             "lrolol_1xxx/data/lola_gdr/cylindrical/img/")
LDEM_DIMS = {4: (1440, 720), 16: (5760, 2880), 64: (23040, 11520)}

SCALING_FACTOR = 0.5             # DN -> meters (elevation above ref sphere)
MOON_RADIUS_M = 1737400          # LOLA reference sphere

# Defaults: ldem_16 native (fast). --ppd 64 downsampled to 8192x4096 gives ~2.7x
# more linear detail (530 MB download).
PPD = 16
SRC_W, SRC_H = LDEM_DIMS[PPD]
WIDTH = SRC_W
HEIGHT = SRC_H


def src_url_file(ppd):
    name = f"ldem_{ppd}.img"
    return LDEM_BASE + name, os.path.join(CACHE_DIR, name)


def download():
    os.makedirs(CACHE_DIR, exist_ok=True)
    url, path = src_url_file(PPD)
    min_bytes = SRC_W * SRC_H * 2 - 1000
    if os.path.exists(path) and os.path.getsize(path) >= min_bytes:
        print(f"using cached {path} ({os.path.getsize(path)/1e6:.0f} MB)")
        return
    print(f"downloading {url}")
    import urllib.request
    urllib.request.urlretrieve(url, path)
    print(f"  saved {os.path.getsize(path)/1e6:.0f} MB")


def load_elev():
    """Read the LOLA .IMG -> float32 elevation [SRC_H,SRC_W] in meters above
    the 1737.4 km sphere, row 0 = north, col 0 = west (-180)."""
    _, path = src_url_file(PPD)
    dn = np.fromfile(path, dtype="<i2")
    if dn.size != SRC_W * SRC_H:
        sys.exit(f"unexpected ldem_{PPD} size: {dn.size} != {SRC_W*SRC_H}")
    dn = dn.reshape(SRC_H, SRC_W)            # row 0 = north already
    elev = dn.astype(np.float32) * SCALING_FACTOR
    # LOLA columns run 0..360 E; roll by half-width so col 0 -> -180 (west),
    # putting the Earth-facing near side (~0 lon) at the grid center.
    elev = np.roll(elev, SRC_W // 2, axis=1)
    return elev


def resample(elev, w, h):
    if (w, h) == (SRC_W, SRC_H):
        return elev
    # Area-mean (block reduce) only when the source divides EXACTLY by the target —
    # otherwise `elev[:h*fy, :w*fx]` would crop (drop) the remainder of the globe.
    # For non-exact ratios, nearest-sample across the FULL range (no crop).
    if w <= SRC_W and h <= SRC_H and SRC_W % w == 0 and SRC_H % h == 0:
        fy, fx = SRC_H // h, SRC_W // w
        return elev.reshape(h, fy, w, fx).mean(axis=(1, 3)).astype(np.float32)
    print(f"  WARNING: {SRC_W}x{SRC_H} not an integer multiple of {w}x{h}; "
          f"using nearest-sample (consider a divisor target like "
          f"{SRC_W//3}x{SRC_H//3}).")
    rows = np.round(np.linspace(0, SRC_H - 1, h)).astype(int)
    cols = np.round(np.linspace(0, SRC_W - 1, w)).astype(int)
    return np.asarray(elev[np.ix_(rows, cols)])


def main():
    global WIDTH, HEIGHT, PPD, SRC_W, SRC_H
    ap = argparse.ArgumentParser()
    ap.add_argument("--ppd", type=int, default=PPD, choices=sorted(LDEM_DIMS),
                    help="LOLA source resolution (pixels/degree)")
    ap.add_argument("--width", type=int, default=None)
    ap.add_argument("--height", type=int, default=None)
    args = ap.parse_args()
    PPD = args.ppd
    SRC_W, SRC_H = LDEM_DIMS[PPD]
    # Default output: native for 4/16; downsample 64 -> 7680x3840 (an EXACT 1/3 of the
    # 23040x11520 source, so the area-mean reduce covers the whole globe with no crop).
    WIDTH = args.width if args.width else (7680 if PPD == 64 else SRC_W)
    HEIGHT = args.height if args.height else (3840 if PPD == 64 else SRC_H)
    source = f"NASA LRO LOLA LDEM {PPD} ppd (PDS Geosciences Node)"

    download()
    elev = load_elev()
    if (WIDTH, HEIGHT) != (SRC_W, SRC_H):
        print(f"resampling LOLA {SRC_W}x{SRC_H} -> {WIDTH}x{HEIGHT}")
        elev = resample(elev, WIDTH, HEIGHT)

    elev16 = np.round(np.clip(elev, -32768, 32767)).astype("<i2")
    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "moon_heightfield.bin")
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
        "reference_radius_m": MOON_RADIUS_M,
        "source": source,
    }
    meta_path = os.path.join(OUT_DIR, "moon_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    # preview (full range -> grayscale, sphere reference = mid-gray)
    from PIL import Image
    pe = elev16.astype(np.float64)
    span = max(elev_max, -elev_min, 1)
    img = np.clip((pe / span) * 127 + 128, 0, 255).astype(np.uint8)
    Image.fromarray(img, "L").resize((2048, 1024)).save(
        os.path.join(OUT_DIR, "moon_preview.png"))

    print("\n=== moon bake summary ===")
    print(f"dims        : {WIDTH} x {HEIGHT}  ({WIDTH*HEIGHT:,} cells)")
    print(f"elev range  : {elev_min} .. {elev_max} m (rel. 1737.4 km sphere)")
    print(f"source      : {source}")
    for p in (hf_path, meta_path):
        print(f"  {p}  ({os.path.getsize(p)/1024/1024:.2f} MiB)")

    verify(elev16)


def verify(elev16):
    """Spot-check known lunar features. row 0 = +90N, col 0 = -180W."""
    h, w = elev16.shape

    def sample(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return int(elev16[min(max(r, 0), h - 1), min(max(c, 0), w - 1)])

    # Near side faces Earth at ~0 lon. Maria (low, near or below ref sphere);
    # far-side highlands and South Pole-Aitken rim are high/low extremes.
    checks = [
        ("Mare Imbrium 35N -15E (low mare)",     35.0, -15.0, lambda v: v < 0),
        ("Mare Serenitatis 28N 17.5E (low)",     28.0, 17.5,  lambda v: v < 1000),
        ("Far-side highlands 0N 180E (high)",     0.0, 180.0, lambda v: v > 1000),
        ("Tycho area -43N -11E (rugged)",       -43.0, -11.0, lambda v: abs(v) < 8000),
    ]
    print("\n=== lunar feature sanity ===")
    all_ok = True
    for name, lat, lon, ok in checks:
        v = sample(lat, lon)
        good = ok(v)
        all_ok &= good
        print(f"  [{'OK ' if good else '??'}] {name}: {v} m")
    print("range plausible" if all_ok else "some checks unexpected (inspect preview)")


if __name__ == "__main__":
    main()
