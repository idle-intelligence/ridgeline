#!/usr/bin/env python3
"""
Global elevation data-bake for the ridgeline flight game.

Downloads the ETOPO 2022 60 arc-second (1 arc-min) ICE-surface global relief
grid from NOAA NCEI (open HTTP, no auth), resamples it to our 12288x6144 grid,
clamps ocean/below-sea-level to exactly 0, and writes the project binary format:

  heightfield.bin  - little-endian int16 meters, row-major,
                     row 0 = NORTH (lat +90) -> south (lat -90),
                     col 0 = WEST (lon -180) -> east (+180)
  meta.json        - grid + format description (global bbox)
  water_mask.bin   - uint8 0/1, 1 = ocean (elev<=0), same dims/order
  preview.png      - small global grayscale elevation preview

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

# ETOPO 2022 v1, 60 arc-second, ice-surface elevation, single global netCDF.
ETOPO_URL = ("https://www.ngdc.noaa.gov/thredds/fileServer/global/"
             "ETOPO2022/60s/60s_surface_elev_netcdf/"
             "ETOPO_2022_v1_60s_N90W180_surface.nc")
ETOPO_FILE = os.path.join(CACHE_DIR, "ETOPO_2022_v1_60s_surface.nc")

WIDTH = 12288
HEIGHT = 6144
SOURCE = "ETOPO 2022 v1 60s ice-surface (NOAA NCEI)"


def download():
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(ETOPO_FILE) and os.path.getsize(ETOPO_FILE) > 10_000_000:
        print(f"using cached {ETOPO_FILE} "
              f"({os.path.getsize(ETOPO_FILE)/1e6:.0f} MB)")
        return
    print(f"downloading {ETOPO_URL}")
    import urllib.request
    urllib.request.urlretrieve(ETOPO_URL, ETOPO_FILE)
    print(f"  saved {os.path.getsize(ETOPO_FILE)/1e6:.0f} MB")


def resample():
    """Load ETOPO and nearest-sample onto our target WIDTHxHEIGHT grid.

    Source: z[lat, lon] float32, lat ascending (S->N), lon ascending (W->E).
    Target: row 0 = +90 (north), col 0 = -180 (west).
    """
    import netCDF4 as nc
    d = nc.Dataset(ETOPO_FILE)
    src_lat = d.variables["lat"][:]   # ascending -89.99..+89.99
    src_lon = d.variables["lon"][:]   # ascending -179.99..+179.99
    z = d.variables["z"]              # (nlat, nlon) float32

    nlat = src_lat.size
    nlon = src_lon.size
    lat0, lat1 = float(src_lat[0]), float(src_lat[-1])
    lon0, lon1 = float(src_lon[0]), float(src_lon[-1])

    # Target cell-center coordinates. Row 0 = north (+90), col 0 = west (-180).
    tgt_lats = np.linspace(90.0 - 90.0 / HEIGHT, -90.0 + 90.0 / HEIGHT, HEIGHT)
    tgt_lons = np.linspace(-180.0 + 180.0 / WIDTH, 180.0 - 180.0 / WIDTH, WIDTH)

    # Map target coords -> source index (nearest). Source axes are linear.
    row_src = np.round((tgt_lats - lat0) / (lat1 - lat0) * (nlat - 1)).astype(int)
    col_src = np.round((tgt_lons - lon0) / (lon1 - lon0) * (nlon - 1)).astype(int)
    np.clip(row_src, 0, nlat - 1, out=row_src)
    np.clip(col_src, 0, nlon - 1, out=col_src)

    # Read source fully into memory (≈933 MB float32) then fancy-index.
    zarr = np.ma.filled(z[:], 0.0).astype(np.float32)
    out = np.asarray(zarr[np.ix_(row_src, col_src)])
    d.close()
    return out


def main():
    global WIDTH, HEIGHT
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=WIDTH)
    ap.add_argument("--height", type=int, default=HEIGHT)
    args = ap.parse_args()
    WIDTH, HEIGHT = args.width, args.height
    download()
    print(f"resampling ETOPO 60s -> {WIDTH}x{HEIGHT}")
    elev = resample()  # float32 [H,W], real meters incl. negative bathymetry

    # Ocean / below sea level -> exactly 0. Land keeps real positive elevation.
    elev = np.clip(elev, 0, 32767)

    water = (elev <= 0).astype(np.uint8)  # 1 = ocean/sea-level
    elev16 = np.round(elev).astype("<i2")

    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "heightfield.bin")
    elev16.tofile(hf_path)  # C-order rows = north->south, cols = west->east

    wpath = os.path.join(OUT_DIR, "water_mask.bin")
    water.tofile(wpath)

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
        "source": SOURCE,
    }
    meta_path = os.path.join(OUT_DIR, "meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    # preview
    from PIL import Image
    pe = elev16.astype(np.float64)
    img = np.clip(pe / max(elev_max, 1) * 255, 0, 255).astype(np.uint8)
    pw, ph = 2048, 1024
    Image.fromarray(img, "L").resize((pw, ph)).save(
        os.path.join(OUT_DIR, "preview.png"))

    print("\n=== bake summary ===")
    print(f"dims        : {WIDTH} x {HEIGHT}  ({WIDTH*HEIGHT:,} cells)")
    print(f"elev range  : {elev_min} .. {elev_max} m")
    print(f"ocean cells : {100.0*water.mean():.1f}%")
    print(f"source      : {SOURCE}")
    for p in (hf_path, wpath, meta_path):
        sz = os.path.getsize(p)
        print(f"  {p}  ({sz/1024/1024:.2f} MiB)")

    verify(elev16)


def verify(elev16):
    """Spot-check known landmarks. row 0 = +90N, col 0 = -180W."""
    def sample(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (HEIGHT - 1)))
        c = int(round((lon + 180.0) / 360.0 * (WIDTH - 1)))
        r = min(max(r, 0), HEIGHT - 1)
        c = min(max(c, 0), WIDTH - 1)
        return int(elev16[r, c])

    checks = [
        ("Everest 28.0N 86.9E (>4000m)", 27.99, 86.93, lambda v: v > 4000),
        ("Cairo 30.0N 31.2E (low +)",    30.0, 31.2,  lambda v: 0 < v < 500),
        ("Mid-Pacific 0N 160W (ocean=0)", 0.0, -160.0, lambda v: v == 0),
        ("Atlantic 0N 30W (ocean=0)",     0.0, -30.0,  lambda v: v == 0),
        ("Aconcagua -32.65 -70W (>3000m)", -32.65, -70.0, lambda v: v > 3000),
        ("Greenland 72N 40W (land>0)",    72.0, -40.0, lambda v: v > 0),
        ("Antarctica -80 0E (land>0)",    -80.0, 0.0,  lambda v: v > 0),
    ]
    print("\n=== landmark verification ===")
    all_ok = True
    for name, lat, lon, ok in checks:
        v = sample(lat, lon)
        good = ok(v)
        all_ok &= good
        print(f"  [{'OK ' if good else 'BAD'}] {name}: {v} m")
    print("ALL PASS" if all_ok else "SOME FAILED")
    if not all_ok:
        sys.exit(3)


if __name__ == "__main__":
    main()
