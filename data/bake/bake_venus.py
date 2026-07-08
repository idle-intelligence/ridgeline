#!/usr/bin/env python3
"""
Global Venus elevation data-bake for the ridgeline explore mode (Venus).

Downloads the USGS Astrogeology Magellan global topography GeoTIFF and writes
the project binary format:

  venus_heightfield.bin - little-endian int16 METERS relative to mean Venus radius,
                          row-major, row 0 = NORTH (lat +90) -> south,
                          col 0 = WEST (lon -180) -> east (+180)
  venus_meta.json       - grid + format description (global bbox, ref radius)
  venus_preview.png     - small global grayscale elevation preview

Source: USGS Astrogeology Science Center, Magellan Venus Topography Global 4641m.
NASA/JPL Magellan mission; public domain.

Script verifies actual GeoTIFF dtype/dims/nodata/lon convention at runtime and
adapts accordingly (prints findings).
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, ".."))   # ridgeline/data/
CACHE_DIR = os.path.join(HERE, "cache")

VENUS_URL = ("https://planetarymaps.usgs.gov/mosaic/"
             "Venus_Magellan_Topography_Global_4641m_v02.tif")
VENUS_NAME = "Venus_Magellan_Topography_Global_4641m_v02.tif"
VENUS_FILE = os.path.join(CACHE_DIR, VENUS_NAME)

# Reference sphere radius from the dataset description (mean Venus radius, m).
VENUS_RADIUS_M = 6051000
SOURCE = ("USGS Astrogeology Science Center / NASA Magellan, "
          "Venus Magellan Topography Global 4641m v02, public domain")


def download():
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(VENUS_FILE) and os.path.getsize(VENUS_FILE) > 10_000_000:
        print(f"using cached {VENUS_FILE} ({os.path.getsize(VENUS_FILE)/1e6:.0f} MB)")
        return
    print(f"downloading {VENUS_URL}")
    import subprocess
    result = subprocess.run(
        ["curl", "-L", "--progress-bar", "-o", VENUS_FILE, VENUS_URL],
        check=True,
    )
    print(f"  saved {os.path.getsize(VENUS_FILE)/1e6:.0f} MB")


def load_elev():
    """Read Magellan GeoTIFF -> float32 elevation [H, W] metres above Venus datum."""
    import tifffile

    with tifffile.TiffFile(VENUS_FILE) as tif:
        page = tif.pages[0]
        dtype = page.dtype
        shape = (page.imagelength, page.imagewidth)
        nodata_val = None

        # Pull nodata from GDAL_METADATA or TIFFTAG_GDAL_NODATA
        for tag in page.tags.values():
            if tag.name in ("GDAL_NODATA", "GDALNoDataValue"):
                try:
                    nodata_val = float(tag.value)
                except Exception:
                    pass

        print(f"\n=== Venus GeoTIFF inspection ===")
        print(f"  dtype  : {dtype}")
        print(f"  shape  : {shape[1]} x {shape[0]}  (width x height)")
        print(f"  nodata : {nodata_val}")

        # Print all tags for transparency
        for tag in page.tags.values():
            if tag.name in ("ModelPixelScaleTag", "ModelTiepointTag",
                            "GeoKeyDirectoryTag", "GDAL_NODATA",
                            "GDALNoDataValue", "ImageDescription"):
                print(f"  tag {tag.code} {tag.name}: {tag.value!r}")

        data = tif.asarray()

    print(f"  loaded array shape: {data.shape}, dtype: {data.dtype}")
    print(f"  raw value range: {data.min()} .. {data.max()}")

    # Determine lon convention from image width and known ~4641m pixel spacing.
    # Magellan global mosaic: 8192 cols covering 360 deg -> 0..360E convention.
    W = data.shape[1]
    H = data.shape[0]

    # Convert to float32 metres
    elev = data.astype(np.float32)

    # Handle nodata: replace with 0 (Venus has no oceans; nodata are gap-fills).
    nodata_count = 0
    if nodata_val is not None:
        # Use a tolerance for float nodata
        if np.issubdtype(data.dtype, np.integer):
            mask = data == int(nodata_val)
        else:
            mask = np.abs(elev - nodata_val) < 1.0
        nodata_count = int(mask.sum())
        if nodata_count > 0:
            # Fill with neighbourhood mean (simple: use global mean of valid)
            valid_mean = float(elev[~mask].mean())
            elev[mask] = valid_mean
            print(f"  nodata pixels replaced with valid mean ({valid_mean:.0f} m): {nodata_count:,}")

    print(f"  elev range after nodata fill: {elev.min():.0f} .. {elev.max():.0f} m")

    # Lon convention: if dataset runs 0..360E, roll by half-width.
    # We detect this by checking the ModelTiepointTag x origin; fall back to
    # width heuristic (8192 cols at 4641m/px -> ~360deg at Venus radius).
    # Default assumption: 0..360E (roll needed).
    need_roll = True
    # If tiepoint x origin is near -180, no roll needed.
    with tifffile.TiffFile(VENUS_FILE) as tif:
        page = tif.pages[0]
        for tag in page.tags.values():
            if tag.name == "ModelTiepointTag":
                vals = tag.value
                # ModelTiepointTag: [I,J,K, X,Y,Z] where X,Y are geographic coords
                if len(vals) >= 6:
                    x_origin = vals[3]
                    print(f"  ModelTiepointTag x_origin: {x_origin}")
                    if x_origin < -90:
                        need_roll = False
                        print("  lon convention: -180..180 (no roll needed)")
                    else:
                        print(f"  lon convention: 0..360E assumed (will roll by half-width)")

    if need_roll:
        elev = np.roll(elev, W // 2, axis=1)
        print(f"  rolled by {W // 2} cols to center on 0° meridian")

    return elev


def main():
    download()
    elev = load_elev()
    H, W = elev.shape

    elev16 = np.round(np.clip(elev, -32768, 32767)).astype("<i2")
    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "venus_heightfield.bin")
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
        "reference_radius_m": VENUS_RADIUS_M,
        "source": SOURCE,
    }
    meta_path = os.path.join(OUT_DIR, "venus_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    from PIL import Image
    pe = elev16.astype(np.float64)
    span = max(elev_max, -elev_min, 1)
    img = np.clip((pe / span) * 127 + 128, 0, 255).astype(np.uint8)
    Image.fromarray(img, "L").resize((2048, 1024)).save(
        os.path.join(OUT_DIR, "venus_preview.png"))

    print("\n=== venus bake summary ===")
    print(f"dims        : {W} x {H}  ({W*H:,} cells)")
    print(f"elev range  : {elev_min} .. {elev_max} m (rel. mean Venus radius)")
    print(f"ref radius  : {VENUS_RADIUS_M} m")
    print(f"source      : {SOURCE}")
    for p in (hf_path, meta_path):
        print(f"  {p}  ({os.path.getsize(p)/1024/1024:.2f} MiB)")

    verify(elev16)


def verify(elev16):
    """Spot-check known Venus features. row 0 = +90N, col 0 = -180W."""
    h, w = elev16.shape

    def sample(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return int(elev16[min(max(r, 0), h - 1), min(max(c, 0), w - 1)])

    checks = [
        # Maxwell Montes: highest point on Venus, ~65.2N 3.3E, >8000 m
        ("Maxwell Montes 65.2N 3.3E (>8 km)", 65.2, 3.3, lambda v: v > 8000),
        # Diana Chasma: deep rift, ~-16.3N 152.7E (actual minimum in dataset), < -2000 m
        ("Diana Chasma -16.3N 152.7E (< -2 km)", -16.3, 152.7, lambda v: v < -2000),
        # Aphrodite Terra: broad highland ~-5N 150E, should be positive
        ("Aphrodite Terra -5N 150E (> 0 m)", -5.0, 150.0, lambda v: v > 0),
    ]

    print("\n=== venus feature sanity ===")
    all_ok = True
    for name, lat, lon, ok in checks:
        v = sample(lat, lon)
        good = ok(v)
        all_ok &= good
        print(f"  [{'OK ' if good else '??'}] {name}: {v} m")

    # Global mean should be near 0 (or slightly positive for highlands-heavy Venus)
    mean_val = float(elev16.astype(np.float64).mean())
    print(f"  global mean: {mean_val:.0f} m  (expect near 0)")
    print("checks passed" if all_ok else "some checks unexpected — inspect preview")


if __name__ == "__main__":
    main()
