#!/usr/bin/env python3
"""
Global Pluto elevation data-bake for the ridgeline explore mode.

Downloads the NASA New Horizons LORRI/MVIC global DEM (July 2017) and writes
the project binary format resampled to 11520x5760.

  pluto_heightfield.bin  - little-endian int16 METERS relative to the
                           1188300 m reference sphere, row-major,
                           row 0 = NORTH (lat +90), col 0 = WEST (lon -180)
  pluto_meta.json        - grid + format description (includes coverage_note)
  pluto_preview.png      - small global grayscale elevation preview

Source: NASA New Horizons mission, LORRI/MVIC instruments, July 2017 DEM.
URL: https://planetarymaps.usgs.gov/mosaic/Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif

CRITICAL NOTE ON COVERAGE: New Horizons only imaged one hemisphere during its
2015 flyby. The encounter hemisphere (~0-180E) has real topographic data; the
unimaged far side (~180-360E / 180W-0) fills with exactly 0 (reference level)
and renders as featureless 'ocean'. Expect roughly ~50% real coverage.

Feature checks:
  - Sputnik Planitia (~20N 180E = -180W, encounter hemisphere) is a deep basin ~-3.5 km
  - Tenzing/al-Idrisi Montes near Sputnik western rim are high
  - Range ~-4..+6 km globally

Reference mean radius: 1188300 m.
Rotation: 6.38723 days, RETROGRADE (negative angular velocity convention).
Lon convention: check tiepoints — may be 0..360E, roll if needed.
"""
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, ".."))  # ridgeline/data/
CACHE_DIR = os.path.join(HERE, "cache")

PLUTO_URL = ("https://planetarymaps.usgs.gov/mosaic/"
             "Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif")
PLUTO_NAME = "Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif"
PLUTO_FILE = os.path.join(CACHE_DIR, PLUTO_NAME)

PLUTO_RADIUS_M = 1188300
SOURCE = ("NASA New Horizons mission, LORRI/MVIC instruments; "
          "Pluto New Horizons Global DEM 300m July 2017, public domain")

# Source dims: 24888x12444, int16 metres
SRC_W, SRC_H = 24888, 12444
# Resample to 11520x5760
OUT_W, OUT_H = 11520, 5760

# Threshold: pixels within this range of the fill value are considered synthetic
FILL_DETECT_THRESHOLD_M = 5  # +/-5 m around 0 considered flat synthetic fill


def download():
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(PLUTO_FILE) and os.path.getsize(PLUTO_FILE) > 200_000_000:
        print(f"using cached {PLUTO_FILE} ({os.path.getsize(PLUTO_FILE)/1e6:.0f} MB)")
        return
    print(f"downloading {PLUTO_URL}  (~591 MB, be patient)")
    import subprocess
    subprocess.run(
        ["curl", "-L", "--progress-bar", "-o", PLUTO_FILE, PLUTO_URL],
        check=True,
    )
    print(f"  saved {os.path.getsize(PLUTO_FILE)/1e6:.0f} MB")


def inspect_tiff():
    """Inspect GeoTIFF tags; return (dtype, shape, nodata, need_roll)."""
    import tifffile
    import xml.etree.ElementTree as ET

    print(f"\n=== Pluto GeoTIFF inspection ===")
    with tifffile.TiffFile(PLUTO_FILE) as tif:
        page = tif.pages[0]
        dtype = page.dtype
        shape = (page.imagelength, page.imagewidth)
        nodata_val = None
        x_origin = None
        scale = 1.0
        offset = 0.0

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
            if tag.name == "GDAL_METADATA":
                xml_str = tag.value
                print(f"  GDAL_METADATA: {xml_str[:300]}")
                try:
                    root = ET.fromstring(xml_str)
                    for item in root.iter("Item"):
                        role = item.get("role", "")
                        if role == "scale":
                            scale = float(item.text)
                        elif role == "offset":
                            offset = float(item.text)
                except Exception as e:
                    print(f"  WARNING: could not parse GDAL_METADATA XML: {e}")

        print(f"  dtype   : {dtype}")
        print(f"  shape   : {shape[1]} x {shape[0]}  (width x height)")
        print(f"  nodata  : {nodata_val}")
        print(f"  scale   : {scale}  offset: {offset}")

    need_roll = False
    if x_origin is not None:
        print(f"  x_origin (lon of left edge): {x_origin}")
        if x_origin < -90:
            need_roll = False
            print("  lon convention: -180..180 already (no roll)")
        else:
            need_roll = True
            print("  lon convention: 0..360E (will roll by half-width)")
    else:
        print("  lon convention: unknown from tiepoints — inspecting actual source")
        need_roll = False

    return dtype, shape, nodata_val, scale, offset, need_roll


def quantify_synthetic_fill(data, nodata_val):
    """Estimate fraction of pixels with no real topographic data.

    For the New Horizons Pluto DEM, the unimaged far-side hemisphere is stored
    as nodata (sentinel -32768). These are the missing/synthetic pixels.
    Returns (fill_fraction, fill_count, total_pixels).
    """
    total_pixels = data.size
    if nodata_val is not None:
        fill_count = int((data == int(nodata_val)).sum())
    else:
        fill_count = 0
    fill_fraction = fill_count / total_pixels if total_pixels > 0 else 0.0
    return fill_fraction, fill_count, total_pixels


def load_elev(dtype, shape, nodata_val, scale, offset, need_roll):
    """Read Pluto DEM -> float32 elevation metres above reference sphere."""
    import tifffile

    H, W = shape
    print(f"\nloading {PLUTO_FILE} ({W}x{H}, dtype={dtype}) ...")
    data = tifffile.imread(PLUTO_FILE)
    print(f"  loaded shape: {data.shape}, dtype: {data.dtype}")
    print(f"  raw range: {data.min()} .. {data.max()}")

    # Quantify synthetic fill BEFORE any processing
    print("\n--- Synthetic fill quantification ---")
    fill_fraction, fill_count, total_pixels = quantify_synthetic_fill(data, nodata_val)
    print(f"  nodata (synthetic/missing) pixels: "
          f"{fill_count:,} / {total_pixels:,} = {fill_fraction*100:.1f}%")
    print(f"  COVERAGE NOTE: ~{(1-fill_fraction)*100:.0f}% of pixels have real topographic "
          f"data; ~{fill_fraction*100:.0f}% are nodata (unimaged far-side, stored as -32768).")
    print(f"  (New Horizons only imaged the ~0-180E encounter hemisphere during July 2015 flyby)")

    elev = data.astype(np.float64)

    # Apply nodata mask
    nodata_count = 0
    if nodata_val is not None:
        if np.issubdtype(data.dtype, np.integer):
            mask = data == int(nodata_val)
        else:
            mask = np.abs(elev - nodata_val) < 1.0
        nodata_count = int(mask.sum())
        if nodata_count > 0:
            print(f"  nodata pixels: {nodata_count:,}  (will fill with 0 = reference level)")

    # Apply scale/offset if present
    if scale != 1.0 or offset != 0.0:
        print(f"  applying GDAL scale={scale}, offset={offset}")
        elev = elev * scale + offset
    else:
        print(f"  no GDAL scale/offset (raw = metres)")

    if nodata_count > 0:
        if np.issubdtype(data.dtype, np.integer):
            mask = data == int(nodata_val)
        else:
            mask = np.abs(data.astype(np.float64) - nodata_val) < 1.0
        elev[mask] = 0.0  # fill with reference level 0 → renders as featureless 'ocean'
        print(f"  filled {nodata_count:,} nodata pixels with 0 (reference level / far side)")

    elev = elev.astype(np.float32)
    print(f"  elev range (metres above ref): {elev.min():.0f} .. {elev.max():.0f}")

    if need_roll:
        elev = np.roll(elev, W // 2, axis=1)
        print(f"  rolled by {W // 2} cols to center on 0° meridian")

    return elev, fill_fraction, fill_count, total_pixels


def resample_to(arr, out_h, out_w):
    """Resample 2-D float array to (out_h, out_w) using area-mean blocks where exact,
    or numpy bilinear interpolation for non-integer ratios."""
    src_h, src_w = arr.shape
    if src_h % out_h == 0 and src_w % out_w == 0:
        fh = src_h // out_h
        fw = src_w // out_w
        print(f"  exact block-mean resample: /{fh} rows, /{fw} cols")
        return arr.reshape(out_h, fh, out_w, fw).mean(axis=(1, 3)).astype(np.float32)
    else:
        print(f"  non-integer ratio {src_w}x{src_h} -> {out_w}x{out_h}, using numpy bilinear")
        row_coords = np.linspace(0, src_h - 1, out_h)
        col_coords = np.linspace(0, src_w - 1, out_w)
        r0 = np.floor(row_coords).astype(np.int32)
        c0 = np.floor(col_coords).astype(np.int32)
        r1 = np.clip(r0 + 1, 0, src_h - 1)
        c1 = np.clip(c0 + 1, 0, src_w - 1)
        dr = (row_coords - r0).astype(np.float32)[:, None]
        dc = (col_coords - c0).astype(np.float32)[None, :]
        a = arr[r0[:, None], c0[None, :]]
        b = arr[r0[:, None], c1[None, :]]
        c = arr[r1[:, None], c0[None, :]]
        d = arr[r1[:, None], c1[None, :]]
        return (a * (1 - dr) * (1 - dc) + b * (1 - dr) * dc
                + c * dr * (1 - dc) + d * dr * dc).astype(np.float32)


def main():
    download()

    dtype, shape, nodata_val, scale, offset, need_roll = inspect_tiff()
    elev, fill_fraction, fill_count, total_pixels = load_elev(
        dtype, shape, nodata_val, scale, offset, need_roll)

    H_src, W_src = elev.shape
    print(f"\nresampling {W_src}x{H_src} -> {OUT_W}x{OUT_H} ...")
    elev_ds = resample_to(elev.astype(np.float64), OUT_H, OUT_W).astype(np.float32)
    H, W = elev_ds.shape
    print(f"  done: {W}x{H}")

    elev16 = np.round(np.clip(elev_ds, -32768, 32767)).astype("<i2")
    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    coverage_note = (
        f"PARTIAL COVERAGE: New Horizons (July 2015 flyby) imaged ~{(1-fill_fraction)*100:.0f}% "
        f"of Pluto. Encounter hemisphere (~0-180E) has real topographic data; "
        f"unimaged terrain (far side ~180-360E, {fill_fraction*100:.1f}% of source pixels) "
        f"sits at reference level 0 and renders as featureless 'ocean'. "
        f"({fill_count:,}/{total_pixels:,} source pixels were nodata/unimaged)"
    )

    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "pluto_heightfield.bin")
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
        "reference_radius_m": PLUTO_RADIUS_M,
        "rotation_period_days": 6.38723,
        "rotation_note": "retrograde rotation (negative angular velocity; tidally locked with Charon)",
        "coverage_note": coverage_note,
        "source": SOURCE,
    }
    meta_path = os.path.join(OUT_DIR, "pluto_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    from PIL import Image
    pe = elev16.astype(np.float64)
    span = max(elev_max, -elev_min, 1)
    img = np.clip((pe / span) * 127 + 128, 0, 255).astype(np.uint8)
    Image.fromarray(img, "L").resize((2048, 1024)).save(
        os.path.join(OUT_DIR, "pluto_preview.png"))

    print("\n=== pluto bake summary ===")
    print(f"dims        : {W} x {H}  ({W*H:,} cells)  [resampled from {W_src}x{H_src}]")
    print(f"elev range  : {elev_min} .. {elev_max} m (rel. {PLUTO_RADIUS_M} m ref sphere)")
    print(f"ref radius  : {PLUTO_RADIUS_M} m")
    print(f"coverage    : {coverage_note}")
    print(f"source      : {SOURCE}")
    for p in (hf_path, meta_path):
        print(f"  {p}  ({os.path.getsize(p)/1024/1024:.2f} MiB)")

    verify(elev16)


def verify(elev16):
    """Spot-check known Pluto features. row 0 = +90N, col 0 = -180W.

    Lon convention (USGS -180..180): encounter hemisphere covers roughly -90E..+90E.
    Sputnik Planitia (the heart-shaped nitrogen ice basin) is near 0-20E, 20-30N.
    Far side (nodata, filled with mean) covers roughly +90E..+180E / -180E..-90E.
    """
    h, w = elev16.shape

    def sample(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return int(elev16[min(max(r, 0), h - 1), min(max(c, 0), w - 1)])

    # Sputnik Planitia: the nitrogen ice basin heart-region, ~20-30N, 0-20E
    sp_vals = [sample(lat, lon)
               for lat in [15, 20, 25, 30]
               for lon in [-10, 0, 10, 20]]
    sp_mean = np.mean(sp_vals) if sp_vals else 0

    # Far side (nodata-filled region) — should be 0 (reference level)
    far_vals = [sample(lat, lon)
                for lat in range(-30, 30, 15)
                for lon in range(100, 170, 20)]
    far_mean = np.mean(far_vals)

    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    print("\n=== pluto feature sanity ===")
    range_ok = elev_max > 3000 and elev_min < -2000
    print(f"  [{'OK ' if range_ok else '??'}] "
          f"Global range plausible (expect ~-4..+6 km): {elev_min} .. {elev_max} m")

    # Sputnik Planitia should be clearly negative (basin, ~-1 to -3 km)
    sp_ok = sp_mean < -200
    print(f"  [{'OK ' if sp_ok else '??'}] "
          f"Sputnik Planitia region (~20-30N, 0-20E) is a basin: mean {sp_mean:.0f} m")

    print(f"  Far-side sampled mean (ref-level 0 fill, ~100-170E): {far_mean:.0f} m")

    mean_val = float(elev16.astype(np.float64).mean())
    print(f"  global mean (biased by fill pixels): {mean_val:.0f} m")

    all_ok = range_ok and sp_ok
    print("checks passed" if all_ok else "some checks unexpected — inspect preview")


if __name__ == "__main__":
    main()
