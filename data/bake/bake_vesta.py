#!/usr/bin/env python3
"""
Global Vesta elevation data-bake for the ridgeline explore mode (Vesta).

Downloads the Dawn HAMO DTM DLR Global GeoTIFF (USGS Astrogeology) and writes
the project binary format resampled to 11520×5760 (same grid as Mars/Mercury):

  vesta_heightfield.bin - little-endian int16 METERS above the 255000 m
                          reference sphere, row-major, row 0 = NORTH (lat +90),
                          col 0 = WEST (lon -180) -> east (+180)
  vesta_meta.json       - grid + format description
  vesta_preview.png     - small global grayscale elevation preview

Source: NASA Dawn mission / DLR / USGS Astrogeology Science Center,
  Vesta_Dawn_HAMO_DTM_DLR_Global_48ppd.tif
  17280×8640 float32, public domain.

NOTE — SHAPE: Vesta is highly non-spherical (triaxial, 286×278×223 km axes).
The sphere-mapped render will look very lumpy; that is expected and physically
correct — the dramatic topography is part of the appeal.

ENCODING (verified at runtime via GeoTIFF tags):
  The source is float32, values likely local RADII in metres (~255,000 m).
  We subtract the 255000 m reference to obtain metres of topography.  We
  verify by checking raw median against VESTA_RADIUS_M and printing all tags.

LON-ORIGIN QUIRK (documented):
  The Vesta dataset is derived from Dawn images in the Claudia double prime
  meridian system. However, USGS products have historically been delivered with
  a ~150° eastward shift relative to the IAU Claudia system. We determine the
  actual longitude of the left edge from the ModelTiepointTag and record the
  convention honestly in the meta (lon_convention note). We roll to -180..180
  if the tiepoint indicates a 0..360E grid; otherwise we leave it as-is.
  The meta records whatever origin the output actually uses.

Physical constants:
  Reference radius : 255,000 m  (255 km IAU mean)
  Rotation period  : 5.342 h

Downsample: 17280×8640 → 11520×5760. Factor = 1.5 — not integer, so we use
scipy.ndimage.zoom (bilinear, order=1) or numpy fallback.
"""
import json
import os
import sys
import xml.etree.ElementTree as ET

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, ".."))   # ridgeline/data/
CACHE_DIR = os.path.join(HERE, "cache")

VESTA_URL = ("https://planetarymaps.usgs.gov/mosaic/"
             "Vesta_Dawn_HAMO_DTM_DLR_Global_48ppd.tif")
VESTA_NAME = "Vesta_Dawn_HAMO_DTM_DLR_Global_48ppd.tif"
VESTA_FILE = os.path.join(CACHE_DIR, VESTA_NAME)

VESTA_RADIUS_M = 255_000          # IAU mean reference radius, metres
SOURCE = ("NASA Dawn mission / DLR / USGS Astrogeology Science Center, "
          "Vesta Dawn HAMO DTM DLR Global 48ppd, public domain")

SRC_W, SRC_H = 17280, 8640       # native 48 ppd
OUT_W, OUT_H = 11520, 5760       # project grid (same as Mars/Mercury)


def download():
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(VESTA_FILE) and os.path.getsize(VESTA_FILE) > 100_000_000:
        print(f"using cached {VESTA_FILE} ({os.path.getsize(VESTA_FILE)/1e6:.0f} MB)")
        return
    print(f"downloading {VESTA_URL}  (~570 MB, be patient)")
    import subprocess
    # curl -L follows redirects (USGS -> S3); -C - resumes partial downloads.
    cmd = ["curl", "-L", "-C", "-", "--progress-bar", "-o", VESTA_FILE, VESTA_URL]
    result = subprocess.run(cmd)
    if result.returncode != 0:
        sys.exit(f"curl failed with code {result.returncode}")
    print(f"  saved {os.path.getsize(VESTA_FILE)/1e6:.0f} MB")


def inspect_tiff():
    """Print and return (dtype, shape, nodata, scale, offset, need_roll, lon_note)."""
    import tifffile

    print(f"\n=== Vesta GeoTIFF inspection ===")
    with tifffile.TiffFile(VESTA_FILE) as tif:
        page = tif.pages[0]
        dtype = page.dtype
        shape = (page.imagelength, page.imagewidth)
        nodata_val = None
        scale = 1.0
        offset = 0.0
        x_origin = None
        pixel_scale = None

        for tag in page.tags.values():
            if tag.name in ("GDAL_NODATA", "GDALNoDataValue"):
                try:
                    nodata_val = float(tag.value)
                except Exception:
                    pass
            if tag.name == "ModelPixelScaleTag":
                pixel_scale = tag.value
                print(f"  ModelPixelScaleTag: {pixel_scale}")
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

    # Determine lon convention from tiepoint.
    # The ModelTiepointTag x_origin is in PROJECTED METRES (equirectangular), not degrees.
    # For Vesta at 48ppd, pixel scale = 92.72 m/px; grid width 17280 px × 92.72 = 1.602 Mm.
    # x_origin ≈ -801106 m ≈ -(grid_width / 2), meaning the grid is centred on lon 0°.
    # Since x_origin is a large negative metre value (< -90 by many orders of magnitude),
    # the < -90 check correctly identifies this as already in -180..180 convention.
    need_roll = True
    if x_origin is not None:
        print(f"  x_origin (projected left-edge, metres): {x_origin:.3f}")
        if x_origin < -90:
            # Large negative projected metres → grid is centred, already -180..180
            lon_note = (f"equirectangular projection centred on lon 0° "
                        f"(tiepoint x0={x_origin:.0f} m ≈ -half_width); output lon -180..180; "
                        f"NOTE: USGS Vesta products use Claudia coordinate system (IAU 2015); "
                        f"no additional lon shift applied")
            need_roll = False
            print(f"  lon convention: centred -180..180 (no roll needed)")
        else:
            # Small positive value → 0..360E degrees
            lon_note = (f"source lon_origin={x_origin:.2f}° (0..360E); "
                        f"rolled by half-width to output -180..180")
            print(f"  lon convention: 0..360E degrees (will roll by half-width)")
    else:
        need_roll = True
        lon_note = "no tiepoint found; assuming 0..360E; rolled to -180..180"
        print("  lon convention: no tiepoint; assuming 0..360E (will roll)")

    return dtype, shape, nodata_val, scale, offset, need_roll, lon_note


def load_elev(dtype, shape, nodata_val, scale, offset, need_roll):
    """Read Vesta DEM -> float32 metres above 255 km reference sphere."""
    import tifffile

    H, W = shape
    print(f"\nloading {VESTA_FILE} ({W}x{H}, dtype={dtype}) ...")
    data = tifffile.imread(VESTA_FILE)
    print(f"  loaded shape: {data.shape}, dtype: {data.dtype}")
    print(f"  raw range: {data.min():.1f} .. {data.max():.1f}")
    print(f"  raw median: {np.median(data):.1f}  mean: {data.mean():.1f}")

    elev = data.astype(np.float64)

    # Apply nodata mask
    nodata_count = 0
    nodata_mask = None
    if nodata_val is not None:
        if np.isnan(nodata_val):
            nodata_mask = ~np.isfinite(data)
        elif np.issubdtype(data.dtype, np.integer):
            nodata_mask = data == int(nodata_val)
        else:
            nodata_mask = np.abs(elev - nodata_val) < 1.0
        nodata_count = int(nodata_mask.sum())
        if nodata_count > 0:
            print(f"  nodata pixels: {nodata_count:,}  (will fill after decode)")

    # Also mask NaN/Inf regardless of nodata tag
    nan_mask = ~np.isfinite(elev)
    nan_count = int(nan_mask.sum())
    if nan_count > 0:
        print(f"  NaN/Inf pixels: {nan_count:,}  (will fill with valid mean)")
        if nodata_mask is not None:
            nodata_mask = nodata_mask | nan_mask
        else:
            nodata_mask = nan_mask
        nodata_count = int(nodata_mask.sum())
        elev[nan_mask] = 0.0  # temporary so stats work

    raw_median = float(np.median(data[~nan_mask] if nan_count > 0 else data))
    print(f"  raw median (valid): {raw_median:.1f}")

    # Decode DN -> metres above reference sphere.
    if scale != 1.0 or offset != 0.0:
        print(f"  applying GDAL scale={scale}, offset={offset}")
        elev = elev * scale + offset
    elif abs(raw_median - VESTA_RADIUS_M) < 50_000:
        # Float32 values are local radii in metres; subtract reference.
        print(f"  DETECTED: radius-encoded metres (median {raw_median:.0f} ≈ ref {VESTA_RADIUS_M} m)")
        print(f"  Decoding: elev = raw - {VESTA_RADIUS_M}")
        elev = elev - VESTA_RADIUS_M
    elif abs(raw_median) < 50_000:
        print(f"  raw median {raw_median:.0f} close to 0; treating as metres above ref sphere")
    else:
        print(f"  WARNING: unrecognized DN range (median {raw_median:.0f}); using raw as metres")

    # Fill nodata/NaN after decoding
    if nodata_count > 0 and nodata_mask is not None:
        valid = ~nodata_mask
        valid_mean = float(elev[valid].mean())
        elev[nodata_mask] = valid_mean
        print(f"  filled {nodata_count:,} nodata/NaN pixels with valid mean ({valid_mean:.0f} m)")

    elev = elev.astype(np.float32)
    print(f"  elev range (m above {VESTA_RADIUS_M} m ref): {elev.min():.0f} .. {elev.max():.0f}")

    if need_roll:
        elev = np.roll(elev, W // 2, axis=1)
        print(f"  rolled by {W//2} cols: lon convention now -180..180 (col 0 = W)")

    return elev


def resample_to(elev, out_h, out_w):
    """Resample float32 array from src shape to (out_h, out_w).

    17280x8640 → 11520x5760: factor 1.5 — not integer, use scipy zoom.
    """
    src_h, src_w = elev.shape
    if (src_h, src_w) == (out_h, out_w):
        return elev

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
    c0 = np.floor(col_idx).astype(int).clip(0, src_w - 1)
    c1 = (c0 + 1) % src_w          # periodic lon wrap (no dateline seam)
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


def flatten_poles(elev, blend_deg=1.0):
    """Collapse each polar row to its own row mean and cosine-blend that constant
    into the neighbouring rows over the last `blend_deg` of latitude.

    Vesta's north was in winter darkness during Dawn's HAMO stereo campaign, so
    the DLR DTM carries several km of unconstrained, longitude-varying relief on
    the rows nearest +90°.  Those rows collapse to a single point on the render
    sphere, so the spread becomes a radial sawtooth crown.  Forcing the exact
    pole row constant is not enough on its own — it would leave a step at row 1 —
    hence the C1 (zero-derivative at both ends) cosine ramp.
    """
    h = elev.shape[0]
    dlat = 180.0 / (h - 1)
    n = max(1, int(round(blend_deg / dlat)))
    for rows in (range(0, n + 1), range(h - 1, h - n - 2, -1)):
        rows = list(rows)
        cap = float(elev[rows[0]].mean())
        spread = float(elev[rows[0]].max() - elev[rows[0]].min())
        print(f"  pole row {rows[0]}: mean {cap:.0f} m, spread {spread:.0f} m "
              f"-> flattened, blended over {n} rows ({n * dlat:.2f}°)")
        for i, r in enumerate(rows):
            w = 0.5 * (1.0 + np.cos(np.pi * i / n))   # 1 at the pole -> 0 at the edge
            elev[r] = elev[r] * (1.0 - w) + cap * w
    return elev


def main():
    download()

    dtype, shape, nodata_val, scale, offset, need_roll, lon_note = inspect_tiff()
    elev = load_elev(dtype, shape, nodata_val, scale, offset, need_roll)

    H_src, W_src = elev.shape
    print(f"\nresampling {W_src}x{H_src} -> {OUT_W}x{OUT_H} ...")
    elev_ds = resample_to(elev, OUT_H, OUT_W)
    elev_ds = flatten_poles(elev_ds)
    H, W = elev_ds.shape

    # Vesta terrain range ~-43 km to +38 km (full triaxial relief vs 255 km sphere).
    # This exceeds int16 ±32767 m, so we use 2 m/unit quantization: stored int16
    # value = round(elev_m / 2). The app reads raw i16 * VERT_SCALE; with this
    # encoding, terrain heights are at 2× vertical compression vs 1-m bodies.
    # This is better than clamping which would lose real basin/peak data.
    # Meta records elev_min/elev_max in REAL metres (before quantization) and
    # elev_scale_m so callers can reconstruct: elev_m = i16_value * elev_scale_m.
    QUANT = 2  # metres per int16 unit
    elev_float_min = float(elev_ds.min())
    elev_float_max = float(elev_ds.max())
    elev_ds_q = elev_ds / QUANT
    elev16 = np.round(np.clip(elev_ds_q, -32768, 32767)).astype("<i2")
    clipped_lo = int((elev_ds_q < -32768).sum())
    clipped_hi = int((elev_ds_q > 32767).sum())
    if clipped_lo or clipped_hi:
        print(f"  WARNING: {clipped_lo} pixels below -32768*{QUANT}m, "
              f"{clipped_hi} above +32767*{QUANT}m (clipped after {QUANT}m quantization)")
    else:
        print(f"  {QUANT}m quantization: full range fits in int16 ✓")
    elev_min_real = int(round(elev_float_min))
    elev_max_real = int(round(elev_float_max))
    elev_min = int(elev16.min())
    elev_max = int(elev16.max())

    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "vesta_heightfield.bin")
    elev16.tofile(hf_path)

    meta = {
        "bbox": {"lat_min": -90, "lat_max": 90, "lon_min": -180, "lon_max": 180},
        "width": W,
        "height": H,
        "elev_min": elev_min_real,
        "elev_max": elev_max_real,
        "elev_scale_m": QUANT,
        "elev_i16_min": elev_min,
        "elev_i16_max": elev_max,
        "dtype": "int16",
        "byte_order": "little",
        "row_order": "north_to_south",
        "col_order": "west_to_east",
        "reference_radius_m": VESTA_RADIUS_M,
        "rotation_period_h": 5.342,
        "lon_convention_note": lon_note,
        "source": SOURCE,
    }
    meta_path = os.path.join(OUT_DIR, "vesta_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    from PIL import Image
    pe = elev16.astype(np.float64)
    span = max(elev_max, -elev_min, 1)
    img = np.clip((pe / span) * 127 + 128, 0, 255).astype(np.uint8)
    Image.fromarray(img, "L").resize((2048, 1024)).save(
        os.path.join(OUT_DIR, "vesta_preview.png"))

    print("\n=== vesta bake summary ===")
    print(f"dims        : {W} x {H}  ({W*H:,} cells)  [resampled from {W_src}x{H_src}]")
    print(f"elev range  : {elev_min_real} .. {elev_max_real} m  (real metres, rel. {VESTA_RADIUS_M} m ref sphere)")
    print(f"i16 range   : {elev_min} .. {elev_max}  (×{QUANT} m/unit quantization)")
    print(f"ref radius  : {VESTA_RADIUS_M} m  (255 km)")
    print(f"lon note    : {lon_note}")
    print(f"source      : {SOURCE}")
    for p in (hf_path, meta_path):
        print(f"  {p}  ({os.path.getsize(p)/1024/1024:.2f} MiB)")

    verify(elev16)


def verify(elev16):
    """Spot-check known Vesta features. row 0 = +90N, col 0 = -180W."""
    h, w = elev16.shape

    def sample(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return int(elev16[min(max(r, 0), h - 1), min(max(c, 0), w - 1)])

    # Note: elev16 values are in 2 m/unit (elev_scale_m=2). Multiply by 2 for real metres.
    QUANT = 2

    print("\n=== vesta feature sanity ===")
    # Rheasilvia basin: south-polar region, roughly centered at ~75S.
    # The basin is ~500 km wide; a central peak ~+19 km above reference.
    south_pole = sample(-89, 0) * QUANT
    # Central peak of Rheasilvia: ~75S, ~301E -> lon_180 = 301-360 = -59
    # (approximate — exact location depends on lon convention)
    rheasilvia_peak = sample(-75, -59) * QUANT

    all_ok = True
    print(f"  south pole area (-89N, 0E): {south_pole} m  (real metres)")
    print(f"  Rheasilvia central peak (~-75N, -59E): {rheasilvia_peak} m  (real metres)")

    elev_min_m = int(elev16.min()) * QUANT
    elev_max_m = int(elev16.max()) * QUANT
    # Vesta actual relief: ~-43 km to +38 km vs 255 km reference
    range_ok = elev_max_m > 15_000 and elev_min_m < -15_000
    all_ok &= range_ok
    print(f"  [{'OK ' if range_ok else '??'}] "
          f"Global range (expect ~-43..+38 km actual): {elev_min_m} .. {elev_max_m} m")

    mean_val = float(elev16.astype(np.float64).mean()) * QUANT
    print(f"  global mean: {mean_val:.0f} m")
    print("checks passed" if all_ok else "some checks unexpected — inspect preview")


if __name__ == "__main__":
    main()
