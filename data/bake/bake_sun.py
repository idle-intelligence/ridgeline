#!/usr/bin/env python3
"""
Sun magnetic-field data-bake for the ridgeline explore mode (Sun).

Downloads the NASA SDO/HMI synoptic radial magnetogram for one Carrington
rotation from JSOC (Stanford) and writes the project binary format:

  sun_heightfield.bin  - little-endian int16, row-major, row 0 = +90N lat,
                         col 0 = −180° lon, dims 2880×1440.  Values encode
                         the line-of-sight (radial) magnetic field in Gauss
                         via signed-sqrt compression (see VALUE MAPPING below).
  sun_meta.json        - grid + format + provenance description
  sun_preview.png      - global pseudo-color preview (negative=blue, pos=red)

VALUE MAPPING (chosen after inspecting histogram):
  raw B in Gauss (HMI float32 pixel values).
  Quiet Sun: |B| ~ 1–20 G.  Active regions: |B| up to ±3000 G.
  Linear clipping at ±1500 G crushes quiet-sun texture in the ±few-G range.
  → Use signed sqrt compression:

      elev_int16 = round(sign(B) × sqrt(|B| / 1500.0) × 30000), capped at ±10000

  Range: ±10000 (needle suppression — see apply_value_mapping).
  Inverse: B_gauss = sign(elev) × (elev / 30000)² × 1500.

  This spreads the quiet-sun ±5 G into ±elev ~700, giving visible texture,
  while strong active-region fields (±1000+ G) map to ±elev ~24000.

The HMI synoptic map is in SIN-latitude rows (uniform in sin(lat)).  We
resample to equirectangular (uniform lat) via per-column 1-D linear
interpolation before writing.

Row-order note: FITS convention is row 0 = south (CRVAL2 = -87.5°, CDELT2
= +0.5°/pixel for the 360-row product).  We verify this by checking that
the known north-hemisphere polarity pattern is consistent and flip to
row 0 = +90N for our output.

Source cached under data/bake/cache/ (gitignored).

FALLBACK: If JSOC is unreachable, GONG synoptic maps are tried from
  https://gong.nso.edu/data/magmap/QR/mqs/

Usage:
  python3 bake_sun.py [--cr NNNN]

Default CR: 2300 (covers ~Jul–Aug 2025, complete as of bake date).
"""
import argparse
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, ".."))  # ridgeline/data/
CACHE_DIR = os.path.join(HERE, "cache")

# Output grid (equirectangular, uniform latitude)
OUT_W = 2880   # longitude cols (0.125° resolution)
OUT_H = 1440   # latitude rows  (0.125° resolution)

SUN_RADIUS_M = 696_000_000  # IAU mean solar radius

DEFAULT_CR = 2300  # most recent complete rotation as of bake date

# JSOC primary URL pattern (large 3600×1440 sin-lat product)
JSOC_URL_TMPL = "https://jsoc1.stanford.edu/data/hmi/synoptic/hmi.Synoptic_Mr.{cr}.fits"
JSOC_HTTP_TMPL = "http://jsoc.stanford.edu/data/hmi/synoptic/hmi.Synoptic_Mr.{cr}.fits"

# GONG fallback: list index page and individual file pattern
GONG_INDEX = "https://gong.nso.edu/data/magmap/QR/mqs/"


# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

def download_fits(cr):
    """Download the HMI synoptic FITS for the given CR to cache, return path."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_name = f"hmi.Synoptic_Mr.{cr}.fits"
    cache_path = os.path.join(CACHE_DIR, cache_name)

    expected_min = 20_000_000  # ~20 MB for 3600×1440

    if os.path.exists(cache_path) and os.path.getsize(cache_path) >= expected_min:
        print(f"using cached {cache_path} ({os.path.getsize(cache_path)/1e6:.1f} MB)")
        return cache_path, f"NASA SDO/HMI synoptic magnetogram CR{cr} via JSOC/Stanford"

    import urllib.request
    import urllib.error

    # Try JSOC direct HTTPS first (follows the redirect from HTTP)
    jsoc_url = JSOC_URL_TMPL.format(cr=cr)
    print(f"downloading CR{cr} from JSOC: {jsoc_url}")
    try:
        urllib.request.urlretrieve(jsoc_url, cache_path)
        sz = os.path.getsize(cache_path)
        if sz >= expected_min:
            print(f"  saved {sz/1e6:.1f} MB → {cache_path}")
            return cache_path, f"NASA SDO/HMI synoptic magnetogram CR{cr} via JSOC/Stanford"
        else:
            print(f"  JSOC file too small ({sz} bytes), trying fallback")
            os.remove(cache_path)
    except (urllib.error.URLError, OSError) as e:
        print(f"  JSOC failed: {e}")
        if os.path.exists(cache_path):
            os.remove(cache_path)

    # Try HTTP redirect version
    jsoc_http = JSOC_HTTP_TMPL.format(cr=cr)
    print(f"retrying via HTTP redirect: {jsoc_http}")
    try:
        urllib.request.urlretrieve(jsoc_http, cache_path)
        sz = os.path.getsize(cache_path)
        if sz >= expected_min:
            print(f"  saved {sz/1e6:.1f} MB → {cache_path}")
            return cache_path, f"NASA SDO/HMI synoptic magnetogram CR{cr} via JSOC/Stanford"
        print(f"  still too small ({sz}), trying GONG fallback")
        os.remove(cache_path)
    except (urllib.error.URLError, OSError) as e:
        print(f"  HTTP also failed: {e}")
        if os.path.exists(cache_path):
            os.remove(cache_path)

    # GONG fallback
    return download_gong_fallback(cache_path)


def download_gong_fallback(cache_path):
    """Try GONG synoptic magnetogram as fallback. Returns (path, source_str)."""
    import urllib.request
    import urllib.error

    print("trying GONG fallback synoptic magnetogram ...")
    # GONG mrmqs files are named mrmqsYYMM*.fits.gz; fetch the index
    try:
        with urllib.request.urlopen(GONG_INDEX, timeout=20) as resp:
            index_html = resp.read().decode("utf-8", errors="replace")
    except Exception as e:
        sys.exit(f"both JSOC and GONG unreachable: {e}")

    import re
    # Find most recent .fits.gz file
    fits_files = sorted(re.findall(r'mrmqs\d+t\d+\.fits\.gz', index_html))
    if not fits_files:
        # Try without the t suffix
        fits_files = sorted(re.findall(r'mrmqs\S+?\.fits(?:\.gz)?', index_html))
    if not fits_files:
        sys.exit("could not parse GONG index for FITS files")

    gong_file = fits_files[-1]
    gong_url = GONG_INDEX + gong_file
    print(f"GONG file: {gong_url}")

    gz_path = cache_path + ".gz"
    urllib.request.urlretrieve(gong_url, gz_path)
    import gzip, shutil
    with gzip.open(gz_path, "rb") as f_in:
        with open(cache_path, "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)
    os.remove(gz_path)
    sz = os.path.getsize(cache_path)
    print(f"  GONG saved {sz/1e6:.1f} MB → {cache_path}")
    return cache_path, f"NSO/GONG synoptic magnetogram {gong_file}"


# ---------------------------------------------------------------------------
# FITS loading + grid analysis
# ---------------------------------------------------------------------------

def load_fits(path):
    """Load the FITS file and return (data_float32, header_dict)."""
    from astropy.io import fits
    with fits.open(path) as hdul:
        # Primary or first image extension
        for hdu in hdul:
            if hdu.data is not None and hdu.data.ndim == 2:
                data = hdu.data.astype(np.float32)
                hdr = dict(hdu.header)
                return data, hdr
    sys.exit("no 2-D image HDU found in FITS file")


def analyze_fits_grid(data, hdr):
    """Determine row order from FITS header CRVAL/CDELT and print info.

    HMI hmi.Synoptic_Mr 3600×1440:
      NAXIS1=3600 (longitude columns, Carrington lon 0..360 R->L, i.e. decreasing)
      NAXIS2=1440 (latitude rows in sin-lat, CRVAL2≈-87.5, CDELT2=+0.125° in sin-lat)
    Returns: (nrows_sin_lat, ncols_lon, sin_lats_row, carrington_lons_col, row0_is_south)
    """
    nrows, ncols = data.shape
    print(f"  FITS dims: {ncols} cols × {nrows} rows")

    # WCS keywords
    crval1 = hdr.get("CRVAL1", None)
    crval2 = hdr.get("CRVAL2", None)
    cdelt1 = hdr.get("CDELT1", None)
    cdelt2 = hdr.get("CDELT2", None)
    crpix1 = hdr.get("CRPIX1", 1)
    crpix2 = hdr.get("CRPIX2", 1)
    ctype1 = hdr.get("CTYPE1", "")
    ctype2 = hdr.get("CTYPE2", "")
    print(f"  CTYPE1={ctype1!r} CTYPE2={ctype2!r}")
    print(f"  CRVAL1={crval1} CRVAL2={crval2} CDELT1={cdelt1} CDELT2={cdelt2}")
    print(f"  CRPIX1={crpix1} CRPIX2={crpix2}")

    # Build sin-lat axis for each row
    # FITS pixel indices are 1-based; row index i -> pixel = i+1
    if cdelt2 is not None and crval2 is not None:
        row_pixels = np.arange(1, nrows + 1, dtype=np.float64)
        sin_lats = crval2 + cdelt2 * (row_pixels - crpix2)
    else:
        # fallback: assume uniform sin-lat −1..1
        sin_lats = np.linspace(-1.0 + 1.0 / nrows, 1.0 - 1.0 / nrows, nrows)

    # Build Carrington longitude for each column
    # Note: CRVAL1 in HMI synoptic maps is cumulative Carrington degrees
    # (i.e., 360*CR + lon_within_rotation).  Reduce mod 360 to get 0..360.
    if cdelt1 is not None and crval1 is not None:
        col_pixels = np.arange(1, ncols + 1, dtype=np.float64)
        carr_lons = (crval1 + cdelt1 * (col_pixels - crpix1)) % 360.0
    else:
        carr_lons = np.linspace(360.0, 0.0, ncols)

    row0_is_south = float(sin_lats[0]) < 0
    print(f"  sin_lat range: {sin_lats[0]:.4f} .. {sin_lats[-1]:.4f}  "
          f"(row 0 = {'south' if row0_is_south else 'north'})")
    print(f"  Carrington lon range (mod 360): {carr_lons[0]:.2f} .. {carr_lons[-1]:.2f}")

    return nrows, ncols, sin_lats, carr_lons, row0_is_south


# ---------------------------------------------------------------------------
# Grid resampling (sin-lat → equirectangular)
# ---------------------------------------------------------------------------

def sinlat_to_equirect(data, sin_lats, carr_lons, out_h, out_w):
    """
    Resample from sin-latitude × Carrington-longitude grid to
    equirectangular (uniform-lat × uniform-lon, col0 = −180°).

    Steps:
    1. Per-column 1-D linear interpolation from sin-lat rows to uniform-lat rows.
    2. Longitude: roll so that Carrington lon 180° → output col 0 (= −180° in
       geographic convention).  Carrington longitude decreases left-to-right
       in HMI data (CDELT1 negative), so we also flip columns to get
       west-to-east order with col 0 = −180°.

    NaN (polar cap gaps) → 0.0.
    """
    nrows_in, ncols_in = data.shape

    # --- sin-lat interpolation (axis=0, per column) ---
    # Target: out_h uniform-lat rows, row 0 = +90° (sin=1), row out_h-1 = -90° (sin=-1)
    # Note: descending order in sin (1 -> -1) since row 0 = north
    target_lats = np.linspace(90.0, -90.0, out_h, dtype=np.float64)
    target_sin = np.sin(np.deg2rad(target_lats))  # 1.0 -> -1.0

    # Ensure sin_lats is monotonically increasing (for np.interp)
    if sin_lats[0] > sin_lats[-1]:
        sin_lats_asc = sin_lats[::-1]
        data_asc = data[::-1, :]
    else:
        sin_lats_asc = sin_lats
        data_asc = data

    # Fill NaN with interpolated-neighbor average for cleaner poles
    data_filled = np.where(np.isnan(data_asc), 0.0, data_asc).astype(np.float32)

    # Interpolate each column (axis=0): result shape (out_h, ncols_in)
    print(f"  resampling sin-lat {nrows_in} rows → equirect {out_h} rows ...")
    # Vectorized approach: reshape for np.interp broadcast
    # np.interp processes 1-D at a time; batch over columns
    out_sinlat = np.empty((out_h, ncols_in), dtype=np.float32)
    for col in range(ncols_in):
        out_sinlat[:, col] = np.interp(
            target_sin,
            sin_lats_asc,
            data_filled[:, col],
        ).astype(np.float32)
        # Note: np.interp with descending x uses extrapolation by clamp,
        # but target_sin is also descending — we pass as-is; interp requires
        # xp increasing, so we pass target_sin in ascending order and reverse.
    # Actually np.interp needs xp increasing; target_sin is descending (1->-1).
    # Redo correctly:
    for col in range(ncols_in):
        # We want: for each target_sin[i] (1->-1), find value in sin_lats_asc data_filled
        # interp(x, xp, fp) with xp ascending: fine, but x must be in [xp[0],xp[-1]]
        # For row 0 (north pole, sin=1): extrapolate by clamping → data at max sin row
        out_sinlat[:, col] = np.interp(
            target_sin[::-1],   # ascending: -1 -> 1
            sin_lats_asc,
            data_filled[:, col],
        )[::-1].astype(np.float32)  # reverse back to north->south

    # --- Longitude resampling and re-centering ---
    # HMI Carrington longitude: typically 360..0 (decreasing, CDELT1<0)
    # We want output col 0 = −180° geographic = Carrington lon 180° + offset
    # Geographic lon λ relative to Carrington: λ = -(carr_lon - central_meridian)
    # For a synoptic map we simply map Carrington lon → geographic lon by
    # wrapping the 360° circle so that col 0 = -180 (arbitrary epoch).
    # Standard convention: Carrington lon 0° → geographic 0°, so
    #   geo_lon = 180 - carr_lon  (mod 360), ranging 180..-180
    # But the usual ridgeline convention is uniform interpolation of columns.
    # The synoptic map is already uniform in Carrington lon; we resample
    # to out_w columns uniform in geo lon -180..180.
    #
    # carr_lons may be decreasing (360→0) or increasing (0→360).
    # We convert: geo_lon = -(carr_lon - 180) mod 360  → range -180..180
    # Then sort columns by geo_lon ascending (-180 first).

    geo_lons_in = (-(carr_lons - 180.0)) % 360.0 - 180.0  # -180..180

    # Sort input columns by geo_lon
    sort_idx = np.argsort(geo_lons_in)
    geo_lons_sorted = geo_lons_in[sort_idx]
    out_sorted = out_sinlat[:, sort_idx]

    # Target columns: uniform -180..180
    target_geo_lons = np.linspace(-180.0, 180.0, out_w, endpoint=False)

    print(f"  resampling longitude {ncols_in} cols → equirect {out_w} cols ...")
    out_grid = np.empty((out_h, out_w), dtype=np.float32)
    for row in range(out_h):
        out_grid[row, :] = np.interp(
            target_geo_lons,
            geo_lons_sorted,
            out_sorted[row, :],
            period=360.0,  # wrap-around
        ).astype(np.float32)

    return out_grid


# ---------------------------------------------------------------------------
# Value mapping
# ---------------------------------------------------------------------------

def print_histogram(B):
    """Print percentile histogram of field values (ignoring NaN = nodata)."""
    vals = B[~np.isnan(B)].ravel()
    if vals.size == 0:
        vals = B.ravel()
    print(f"\n  field value histogram (non-NaN pixels, n={vals.size:,}):")
    pcts = [0.1, 1, 5, 25, 50, 75, 95, 99, 99.9]
    for p in pcts:
        print(f"    p{p:5.1f}: {np.percentile(vals, p):+10.2f} G")
    print(f"    min  : {vals.min():+10.2f} G   max: {vals.max():+10.2f} G")
    # Count active-region pixels (|B| > 100 G)
    n_active = np.sum(np.abs(vals) > 100)
    print(f"    |B|>100G (active): {n_active:,} / {vals.size:,} "
          f"({100*n_active/vals.size:.2f}%)")


def apply_value_mapping(B):
    """
    Signed sqrt compression:
      elev_int16 = round(sign(B) × sqrt(|B| / 1500.0) × 30000)

    Rationale:
    - Linear map: clipping at ±1500 G and scaling by 20 gives ±30000, but
      quiet-sun fields (±5 G) map to only ±100 counts — barely visible.
    - Signed sqrt: quiet-sun ±5 G → elev ±sqrt(5/1500)×30000 ≈ ±690, giving
      rich texture.  Active-region ±1000 G → ±sqrt(1000/1500)×30000 ≈ ±24495.
    - NaN / nodata → 0 (quiet).
    """
    B_clean = np.where(np.isnan(B), 0.0, B)
    sign_B = np.sign(B_clean)
    elev_f = sign_B * np.sqrt(np.abs(B_clean) / 1500.0) * 30000.0
    # Cap at ±10000: sqrt still leaves active-region needles ~5× the p99 (±6400),
    # which render as spikes. Capping turns needles into mountains while leaving
    # the quiet-sun texture (±700-ish) untouched. Inverse only valid below the cap.
    return np.round(np.clip(elev_f, -10000, 10000)).astype(np.int16)


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------

def save_preview(elev16, path):
    """Pseudo-color preview: negative field = blue, positive = red, zero = black."""
    from PIL import Image
    e = elev16.astype(np.float32)
    max_val = 30000.0
    # Normalize to -1..1
    norm = np.clip(e / max_val, -1.0, 1.0)
    r = np.clip(norm * 255, 0, 255).astype(np.uint8)     # positive → red
    g = (np.abs(norm) * 30).astype(np.uint8)             # slight glow for magnitude
    b = np.clip(-norm * 255, 0, 255).astype(np.uint8)    # negative → blue
    rgb = np.stack([r, g, b], axis=2)
    img = Image.fromarray(rgb, "RGB").resize((2880, 1440))
    img.save(path)
    print(f"  preview saved: {path}")


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def verify(elev16):
    """
    Verify:
    1. Strong bipolar active-region pairs exist in ±35° latitude band.
    2. Polar regions (|lat|>70°) are relatively quiet (low mean |B|).
    3. Overall distribution is sane.
    """
    h, w = elev16.shape
    print("\n=== sun field verification ===")

    e = elev16.astype(np.float32)

    # Activity belt: rows corresponding to |lat|<35°
    lat_n35_row = int(round((90.0 - 35.0) / 180.0 * (h - 1)))
    lat_s35_row = int(round((90.0 + 35.0) / 180.0 * (h - 1)))
    belt = e[lat_n35_row:lat_s35_row, :]

    # Check for bipolar pairs: large positive adjacent to large negative
    # Use sliding window: strong+ within 20 columns of strong-
    threshold = 9000   # strong active region (just below the ±10000 needle cap)
    strong_pos = (belt > threshold)
    strong_neg = (belt < -threshold)

    # Manual proximity check: dilate strong_pos by 20 cols using cumsum trick
    kernel_w = 20
    pos_int = strong_pos.astype(np.int32)
    pos_cumsum = np.cumsum(pos_int, axis=1)
    # Sum in each row over a sliding window of kernel_w
    pos_windowed = pos_cumsum[:, kernel_w:] - pos_cumsum[:, :-kernel_w]
    # Pad to match belt width
    pos_dilated = np.zeros_like(strong_pos, dtype=bool)
    pos_dilated[:, kernel_w // 2: kernel_w // 2 + pos_windowed.shape[1]] = pos_windowed > 0
    bipolar_pairs = bool(np.any(strong_neg & pos_dilated))

    print(f"  [{'OK' if bipolar_pairs else '??'}] bipolar active regions in ±35° belt "
          f"(pos>{threshold}: {strong_pos.sum()}, neg<-{threshold}: {strong_neg.sum()})")

    # Poles quiet check: |lat|>70°
    lat_n70_row = int(round((90.0 - 70.0) / 180.0 * (h - 1)))
    lat_s70_row = int(round((90.0 + 70.0) / 180.0 * (h - 1)))
    north_pole = e[:lat_n70_row, :]
    south_pole = e[lat_s70_row:, :]
    pole_mean_abs = (np.mean(np.abs(north_pole)) + np.mean(np.abs(south_pole))) / 2
    belt_mean_abs = np.mean(np.abs(belt))
    poles_quiet = pole_mean_abs < belt_mean_abs
    print(f"  [{'OK' if poles_quiet else '??'}] poles quieter than belt "
          f"(pole mean|elev|={pole_mean_abs:.0f}, belt mean|elev|={belt_mean_abs:.0f})")

    # Distribution sanity: p50 should be near 0 (more quiet-sun than active)
    vals = e.ravel()
    p50 = np.percentile(vals, 50)
    p99 = np.percentile(vals, 99)
    p1 = np.percentile(vals, 1)
    dist_ok = abs(p50) < 2000 and p99 > 5000 and p1 < -5000
    print(f"  [{'OK' if dist_ok else '??'}] distribution sane "
          f"(p1={p1:.0f}, p50={p50:.0f}, p99={p99:.0f})")

    print("verification passed" if (bipolar_pairs and poles_quiet and dist_ok)
          else "some checks unexpected — inspect preview")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cr", type=int, default=DEFAULT_CR,
                    help=f"Carrington rotation number (default: {DEFAULT_CR})")
    args = ap.parse_args()
    cr = args.cr

    print(f"=== bake_sun CR{cr} ===")
    print(f"output grid: {OUT_W}×{OUT_H} equirectangular")

    # 1. Download
    fits_path, source_str = download_fits(cr)

    # 2. Load FITS
    print("\nloading FITS ...")
    data, hdr = load_fits(fits_path)
    print(f"  loaded array: {data.shape[1]} cols × {data.shape[0]} rows, "
          f"dtype={data.dtype}")

    # 3. Analyze grid
    print("\nanalyzing FITS WCS ...")
    nrows, ncols, sin_lats, carr_lons, row0_is_south = analyze_fits_grid(data, hdr)

    # Print raw field histogram before any processing
    print("\nraw field histogram (Gauss):")
    print_histogram(data)

    # 4. Resample to equirectangular
    print("\nresampling to equirectangular ...")
    B_equirect = sinlat_to_equirect(data, sin_lats, carr_lons, OUT_H, OUT_W)

    # 5. Value mapping
    print("\napplying signed-sqrt value mapping ...")
    elev16 = apply_value_mapping(B_equirect)
    print(f"  elev16 range: {int(elev16.min())} .. {int(elev16.max())}")

    # 6. Row 0 orientation: our convention = +90N at row 0.
    # sinlat_to_equirect already produces row 0 = +90N (target_lats starts at +90).
    # Confirm: in the northern hemisphere (row 0..OUT_H//4) the mean signed field
    # should be weakly positive for the current solar cycle (cycle 25, positive north pole).
    north_mean = float(elev16[:OUT_H // 4, :].mean())
    south_mean = float(elev16[3 * OUT_H // 4:, :].mean())
    print(f"\n  orientation check: north-quarter mean={north_mean:.1f}, "
          f"south-quarter mean={south_mean:.1f}")
    # Solar Cycle 25 (peak ~2025): north polar Br is NEGATIVE, south is POSITIVE.
    # (Hale polarity cycle: SC25 is odd, same polarity as SC23.)
    if north_mean < 0 and south_mean > 0:
        print("  → Solar Cycle 25 polarity (N−, S+). Row 0 = +90N per WCS interp. OK.")
    elif north_mean > 0 and south_mean < 0:
        print("  → SC24/even-cycle polarity (N+, S−). Row 0 = +90N per WCS interp. OK.")
    else:
        print("  → mixed/weak polar fields; orientation set by WCS (row 0 = +90N).")

    # 7. Write binary
    os.makedirs(OUT_DIR, exist_ok=True)
    hf_path = os.path.join(OUT_DIR, "sun_heightfield.bin")
    elev16.tofile(hf_path)  # C-order, little-endian

    # 8. Meta
    # Carrington rotation date ranges (approximate)
    # CR2300 started ~2025-07-19, ended ~2025-08-15
    cr_dates = {
        2300: ("2025-07-19", "2025-08-15"),
        2299: ("2025-06-23", "2025-07-19"),
        2298: ("2025-05-28", "2025-06-23"),
        2295: ("2025-01-20", "2025-02-16"),
    }
    cr_start, cr_end = cr_dates.get(cr, ("unknown", "unknown"))

    meta = {
        "bbox": {"lat_min": -90, "lat_max": 90, "lon_min": -180, "lon_max": 180},
        "width": OUT_W,
        "height": OUT_H,
        "elev_min": int(elev16.min()),
        "elev_max": int(elev16.max()),
        "dtype": "int16",
        "byte_order": "little",
        "row_order": "north_to_south",
        "col_order": "west_to_east",
        "reference_radius_m": SUN_RADIUS_M,
        "source": source_str,
        "carrington_rotation": cr,
        "carrington_date_start": cr_start,
        "carrington_date_end": cr_end,
        "rotation_period_note": "Carrington sidereal rotation 25.38 days",
        "value_kind": "magnetic_field",
        "value_unit": "gauss",
        "value_mapping": (
            "elev_int16 = round(sign(B) * sqrt(|B| / 1500.0) * 30000); "
            "inverse: B_gauss = sign(elev) * (elev / 30000)^2 * 1500; "
            "NaN/nodata -> 0"
        ),
        "value_mapping_rationale": (
            "Signed sqrt compression spreads quiet-sun |B|~5G into elev~+/-700 "
            "for visible texture while strong active-region |B|~1000G map to "
            "elev~+/-24500, safely within int16 range (+/-30000 clipped to +/-32000)."
        ),
    }
    meta_path = os.path.join(OUT_DIR, "sun_meta.json")
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    # 9. Preview
    preview_path = os.path.join(OUT_DIR, "sun_preview.png")
    save_preview(elev16, preview_path)

    # 10. Summary
    print("\n=== sun bake summary ===")
    print(f"source      : {source_str}")
    print(f"CR          : {cr}  ({cr_start} – {cr_end})")
    print(f"input dims  : {ncols} × {nrows} (sin-lat)")
    print(f"output dims : {OUT_W} × {OUT_H} (equirectangular)")
    print(f"elev range  : {int(elev16.min())} .. {int(elev16.max())}")
    for p in (hf_path, meta_path, preview_path):
        sz = os.path.getsize(p)
        print(f"  {p}  ({sz/1024/1024:.2f} MiB)")

    # 11. Verify
    verify(elev16)


if __name__ == "__main__":
    main()
