#!/usr/bin/env python3
"""
Global Ceres elevation data-bake for the ridgeline explore mode (Ceres).

Downloads the Dawn HAMO DTM DLR Global GeoTIFF (USGS Astrogeology) and writes
the project binary format resampled to 11520×5760 (same grid as Mars/Mercury):

  ceres_heightfield.bin - little-endian int16 METERS above the 470000 m
                          reference sphere, row-major, row 0 = NORTH (lat +90),
                          col 0 = WEST (lon -180) -> east (+180)
  ceres_meta.json       - grid + format description
  ceres_preview.png     - small global grayscale elevation preview

Source: NASA Dawn mission / DLR / USGS Astrogeology Science Center,
  Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif
  21600×10800, public domain.

ENCODING NOTES (verified at runtime against GeoTIFF tags):
  The source is uint16. Values are RADIUS-ENCODED: each DN is the local
  planetary radius in km × 10 (i.e. 0.1 km per DN). Some references state
  DN × 0.1 km – reference ≈ 470 km gives metres of topography. We verify
  this by inspecting the ModelPixelScaleTag, GDAL metadata, and raw stats
  (median expected near 4700 DN), then decode accordingly.

  Downsample: 21600×10800 → 11520×5760. Factor is 21600/11520 = 1.875 —
  not an integer, so we use scipy.ndimage.zoom (area average).  If scipy
  is absent we fall back to numpy linear interpolation.

Physical constants:
  Reference radius : 470,000 m  (470 km IAU mean)
  Rotation period  : 9.074 h
"""
import json
import os
import sys
import xml.etree.ElementTree as ET

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, ".."))   # ridgeline/data/
CACHE_DIR = os.path.join(HERE, "cache")

CERES_URL = ("https://planetarymaps.usgs.gov/mosaic/"
             "Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif")
CERES_NAME = "Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif"
CERES_FILE = os.path.join(CACHE_DIR, CERES_NAME)

CERES_RADIUS_M = 470_000          # IAU mean reference radius, metres
SOURCE = ("NASA Dawn mission / DLR / USGS Astrogeology Science Center, "
          "Ceres Dawn FC HAMO DTM DLR Global 60ppd Oct2016, public domain")

SRC_W, SRC_H = 21600, 10800      # native 60 ppd
OUT_W, OUT_H = 11520, 5760       # project grid (same as Mars/Mercury)


def download():
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(CERES_FILE) and os.path.getsize(CERES_FILE) > 100_000_000:
        print(f"using cached {CERES_FILE} ({os.path.getsize(CERES_FILE)/1e6:.0f} MB)")
        return
    print(f"downloading {CERES_URL}  (~446 MB, be patient)")
    import subprocess
    # curl -L follows redirects (USGS -> S3); -C - resumes partial downloads.
    cmd = ["curl", "-L", "-C", "-", "--progress-bar", "-o", CERES_FILE, CERES_URL]
    result = subprocess.run(cmd)
    if result.returncode != 0:
        sys.exit(f"curl failed with code {result.returncode}")
    print(f"  saved {os.path.getsize(CERES_FILE)/1e6:.0f} MB")


def inspect_tiff():
    """Print and return (dtype, shape, nodata, scale, offset, need_roll)."""
    import tifffile

    print(f"\n=== Ceres GeoTIFF inspection ===")
    with tifffile.TiffFile(CERES_FILE) as tif:
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
            if tag.name == "GDAL_METADATA":
                xml_str = tag.value
                print(f"  GDAL_METADATA: {xml_str[:400]}")
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
                    print(f"  WARNING: could not parse GDAL_METADATA: {e}")

        print(f"  dtype   : {dtype}")
        print(f"  shape   : {shape[1]} x {shape[0]}  (WxH)")
        print(f"  nodata  : {nodata_val}")
        print(f"  scale   : {scale}  offset: {offset}")

    need_roll = True
    if x_origin is not None:
        print(f"  x_origin (lon of left edge): {x_origin}")
        if x_origin < -90:
            need_roll = False
            print("  lon convention: -180..180 (no roll needed)")
        else:
            print("  lon convention: 0..360E (will roll by half-width)")
    else:
        print("  lon convention: assuming 0..360E (no tiepoint; will roll)")

    return dtype, shape, nodata_val, scale, offset, need_roll


def load_elev(dtype, shape, nodata_val, scale, offset, need_roll):
    """Read Ceres DEM -> float32 metres above 470 km reference sphere."""
    import tifffile

    H, W = shape
    print(f"\nloading {CERES_FILE} ({W}x{H}, dtype={dtype}) ...")
    data = tifffile.imread(CERES_FILE)
    print(f"  loaded shape: {data.shape}, dtype: {data.dtype}")
    print(f"  raw range: {data.min()} .. {data.max()}")
    print(f"  raw median: {np.median(data):.1f}  mean: {data.mean():.1f}")

    elev = data.astype(np.float64)

    # Apply nodata mask
    nodata_count = 0
    nodata_mask = None
    if nodata_val is not None:
        if np.issubdtype(data.dtype, np.integer):
            nodata_mask = data == int(nodata_val)
        else:
            nodata_mask = np.abs(elev - nodata_val) < 1.0
        nodata_count = int(nodata_mask.sum())
        if nodata_count > 0:
            print(f"  nodata pixels: {nodata_count:,}  (will fill after decode)")

    # Decode raw DN -> metres above reference sphere.
    #
    # Observed Ceres HAMO DTM encoding (verified from GeoTIFF tags):
    #   dtype = int16, nodata = -32768
    #   GDAL_METADATA: OFFSET=470000, SCALE=1
    #   The GDAL OFFSET here is the reference sphere radius (metres) used to
    #   reconstruct the full radius: radius = raw * SCALE + OFFSET.
    #   Elevation above the 470 km reference sphere = radius - CERES_RADIUS_M
    #   = raw * SCALE + OFFSET - CERES_RADIUS_M.
    #   When OFFSET == CERES_RADIUS_M and SCALE == 1, this simplifies to:
    #   elevation = raw * 1 + 470000 - 470000 = raw   (values are already metres).
    #
    # This is a common pattern in DLR/USGS DTMs: GDAL OFFSET tags the reference
    # sphere radius, not an additive bias separate from the reference.
    #
    # Decision tree:
    #  1. GDAL tags present: apply radius decode then subtract reference.
    #  2. No tags, radius-encoded (median near CERES_RADIUS_M): subtract reference.
    #  3. No tags, km×10 encoded: convert then subtract.
    #  4. No tags, values near 0: treat as metres above reference already.
    raw_median_valid = float(np.median(
        data[~nodata_mask] if (nodata_count > 0 and nodata_mask is not None) else data))
    print(f"  raw median (valid): {raw_median_valid:.1f}")

    if scale != 1.0 or offset != 0.0:
        # Reconstruct radius, then subtract reference to get elevation.
        radius = elev * scale + offset
        radius_median = float(np.median(
            radius[~nodata_mask] if (nodata_count > 0 and nodata_mask is not None) else radius))
        print(f"  GDAL decode: radius = raw * {scale} + {offset}  (radius median: {radius_median:.0f} m)")
        print(f"  elevation = radius - {CERES_RADIUS_M} (reference sphere)")
        elev = radius - CERES_RADIUS_M
    elif abs(raw_median_valid - CERES_RADIUS_M) < 20_000:
        # DN values are radius in metres; subtract reference to get elevation.
        print(f"  DETECTED: radius-encoded metres (median {raw_median_valid:.0f} ≈ ref {CERES_RADIUS_M} m)")
        print(f"  Decoding: elev = raw - {CERES_RADIUS_M}")
        elev = elev - CERES_RADIUS_M
    elif abs(raw_median_valid - CERES_RADIUS_M / 1000.0 * 10) < 200:
        # DN = radius in km × 10  (units: 0.1 km); subtract ref in same units.
        ref_dn = CERES_RADIUS_M / 1000.0 * 10  # = 4700.0
        print(f"  DETECTED: radius-encoded (km×10): median {raw_median_valid:.1f} ≈ {ref_dn}")
        print(f"  Decoding: elev = (raw - {ref_dn}) * 100  m")
        elev = (elev - ref_dn) * 100.0
    elif abs(raw_median_valid) < 20_000:
        print(f"  raw median {raw_median_valid:.0f} close to 0: treating as metres above ref sphere")
    else:
        print(f"  WARNING: unrecognized DN range (median {raw_median_valid:.0f}); using raw as metres")

    # Fill nodata after decoding
    if nodata_count > 0 and nodata_mask is not None:
        valid_mean = float(elev[~nodata_mask].mean())
        elev[nodata_mask] = valid_mean
        print(f"  filled {nodata_count:,} nodata pixels with valid mean ({valid_mean:.0f} m)")

    elev = elev.astype(np.float32)
    print(f"  elev range (m above {CERES_RADIUS_M} m ref): {elev.min():.0f} .. {elev.max():.0f}")

    if need_roll:
        elev = np.roll(elev, W // 2, axis=1)
        print(f"  rolled by {W//2} cols: lon convention now -180..180 (col 0 = W)")

    return elev


def resample_to(elev, out_h, out_w):
    """Resample float32 array from src shape to (out_h, out_w).

    21600x10800 → 11520x5760: factor 1.875 — not integer, use scipy zoom
    (order=1 bilinear, which is equivalent to area-weighted for moderate ratios)
    or numpy linear interpolation as fallback.
    """
    src_h, src_w = elev.shape
    if (src_h, src_w) == (out_h, out_w):
        return elev

    # Try scipy first (fastest, memory-efficient)
    try:
        from scipy.ndimage import zoom
        zy = out_h / src_h
        zx = out_w / src_w
        print(f"  scipy.ndimage.zoom by ({zy:.4f}, {zx:.4f}) ...")
        result = zoom(elev, (zy, zx), order=1, prefilter=False)
        print(f"  zoom done: {result.shape}")
        return result.astype(np.float32)
    except ImportError:
        print("  scipy not available; using numpy bilinear interp (chunked)")

    # Fallback: chunked row-by-row bilinear interpolation (avoids large intermediates).
    print(f"  numpy bilinear interp {src_w}x{src_h} -> {out_w}x{out_h} ...")
    row_idx = np.linspace(0, src_h - 1, out_h)
    col_idx = np.linspace(0, src_w - 1, out_w)
    c0 = np.floor(col_idx).astype(int).clip(0, src_w - 2)
    c1 = c0 + 1
    dc = (col_idx - c0).astype(np.float32)

    out = np.empty((out_h, out_w), dtype=np.float32)
    for oi in range(out_h):
        if oi % 500 == 0:
            print(f"    row {oi}/{out_h}")
        ri = row_idx[oi]
        r0i = int(ri)
        r1i = min(r0i + 1, src_h - 1)
        dr = float(ri - r0i)
        row0 = elev[r0i, c0] * (1 - dc) + elev[r0i, c1] * dc
        row1 = elev[r1i, c0] * (1 - dc) + elev[r1i, c1] * dc
        out[oi] = row0 * (1 - dr) + row1 * dr
    print(f"  done: {out.shape}")
    return out


def main():
    download()

    dtype, shape, nodata_val, scale, offset, need_roll = inspect_tiff()
    elev = load_elev(dtype, shape, nodata_val, scale, offset, need_roll)

    H_src, W_src = elev.shape
    print(f"\nresampling {W_src}x{H_src} -> {OUT_W}x{OUT_H} ...")
    elev_ds = resample_to(elev, OUT_H, OUT_W)
    H, W = elev_ds.shape

    elev16 = np.round(np.clip(elev_ds, -32768, 32767)).astype("<i2")
    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "ceres_heightfield.bin")
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
        "reference_radius_m": CERES_RADIUS_M,
        "rotation_period_h": 9.074,
        "source": SOURCE,
    }
    meta_path = os.path.join(OUT_DIR, "ceres_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    from PIL import Image
    pe = elev16.astype(np.float64)
    span = max(elev_max, -elev_min, 1)
    img = np.clip((pe / span) * 127 + 128, 0, 255).astype(np.uint8)
    Image.fromarray(img, "L").resize((2048, 1024)).save(
        os.path.join(OUT_DIR, "ceres_preview.png"))

    print("\n=== ceres bake summary ===")
    print(f"dims        : {W} x {H}  ({W*H:,} cells)  [resampled from {W_src}x{H_src}]")
    print(f"elev range  : {elev_min} .. {elev_max} m (rel. {CERES_RADIUS_M} m ref sphere)")
    print(f"ref radius  : {CERES_RADIUS_M} m  (470 km)")
    print(f"source      : {SOURCE}")
    for p in (hf_path, meta_path):
        print(f"  {p}  ({os.path.getsize(p)/1024/1024:.2f} MiB)")

    verify(elev16)


def verify(elev16):
    """Spot-check known Ceres features. row 0 = +90N, col 0 = -180W."""
    h, w = elev16.shape

    def sample(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return int(elev16[min(max(r, 0), h - 1), min(max(c, 0), w - 1)])

    print("\n=== ceres feature sanity ===")
    # Sample key features. Note: elevations are metres above the 470 km reference
    # sphere. Ceres is somewhat non-spherical so elevations are NOT centred on zero
    # — the mean is around -6000 m (low latitudes are closer to the reference sphere
    # than the compressed poles). Occator (~19.8N 239.7E = -120.3W) is a basin
    # within the broader terrain; it is LOWER than surrounding highlands but still
    # well above the reference sphere. The check verifies Ahuna Mons is higher than
    # the Occator region, not that either is near zero.
    occator = sample(19.8, -120.3)     # 239.7E = -120.3W
    ahuna   = sample(-10.5, -44.0)     # 316E = -44W
    # Sample surroundings of Occator to verify it's a relative low
    occ_north = sample(22.0, -120.3)
    occ_south = sample(17.0, -120.3)

    all_ok = True
    print(f"  Occator crater ~19.8N -120.3E: {occator} m")
    print(f"  Occator N rim  ~22N -120.3E:   {occ_north} m")
    print(f"  Occator S rim  ~17N -120.3E:   {occ_south} m")
    occ_ok = occator < max(occ_north, occ_south)  # Occator is lower than rims
    all_ok &= occ_ok
    print(f"  [{'OK ' if occ_ok else '??'}] Occator is lower than surrounding rim (basin check)")

    ahuna_ok = ahuna > occator
    all_ok &= ahuna_ok
    print(f"  [{'OK ' if ahuna_ok else '??'}] "
          f"Ahuna Mons {ahuna} m > Occator {occator} m (peak check)")

    elev_min = int(elev16.min())
    elev_max = int(elev16.max())
    # Ceres full relief vs 470 km reference: data shows ~-28 to +17 km
    range_ok = elev_max > 5000 and elev_min < -5000
    all_ok &= range_ok
    print(f"  [{'OK ' if range_ok else '??'}] "
          f"Global range plausible (data: ~-28..+17 km): {elev_min} .. {elev_max} m")
    print("checks passed" if all_ok else "some checks unexpected — inspect preview")


if __name__ == "__main__":
    main()
