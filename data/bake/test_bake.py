"""Unit tests for the ridgeline data-bake pipeline.

Focus: guard the resample() regression in bake_moon.py where a block-reduce
silently CROPPED the source when its dims didn't divide evenly by the target,
dropping ~29% of longitude/latitude and stretching the rest (a visible
antimeridian "stitch"). The fix only block-reduces on exact division, else
falls back to nearest-sample across the FULL range.

These tests touch only pure-array helpers; nothing here triggers a download or
reads the cached .img/.nc DEM.
"""
import numpy as np
import pytest

import bake_moon


def _gradient(src_w, src_h):
    """Source where value strictly increases left->right and top->bottom, so
    the bottom-right corner is the unique global max and any crop is detectable."""
    rows = np.arange(src_h, dtype=np.float32)[:, None]
    cols = np.arange(src_w, dtype=np.float32)[None, :]
    return rows * src_w + cols  # unique value per cell, max at [-1, -1]


def _set_src(src_w, src_h):
    bake_moon.SRC_W = src_w
    bake_moon.SRC_H = src_h


@pytest.fixture(autouse=True)
def _restore_globals():
    """resample() reads module globals; snapshot/restore around each test."""
    saved = (bake_moon.SRC_W, bake_moon.SRC_H)
    yield
    bake_moon.SRC_W, bake_moon.SRC_H = saved


# --- 1. exact-divisor coverage -------------------------------------------------

def test_resample_exact_divisor_shape_and_full_coverage():
    src_w, src_h = 12, 6
    w, h = 6, 3
    _set_src(src_w, src_h)
    src = _gradient(src_w, src_h)

    out = bake_moon.resample(src, w, h)

    assert out.shape == (h, w)
    # Block-mean over the WHOLE source: the output corner block must include the
    # source's last row & last column. Mean of bottom-right 2x2 block.
    src_max = src.max()  # bottom-right corner value
    # output[-1,-1] is the mean of the last fy x fx block, which contains src_max.
    assert out[-1, -1] > src.mean()
    # The block-reduce must cover the entire source: mean of all blocks == mean
    # of the whole source (no rows/cols dropped).
    assert out.mean() == pytest.approx(src.mean())
    # And the bottom-right block mean must be close to the source max (not a
    # stretched interior value).
    fy, fx = src_h // h, src_w // w
    expected_corner = src[-fy:, -fx:].mean()
    assert out[-1, -1] == pytest.approx(expected_corner)


def test_resample_exact_divisor_top_left_corner():
    src_w, src_h = 12, 6
    w, h = 6, 3
    _set_src(src_w, src_h)
    src = _gradient(src_w, src_h)
    out = bake_moon.resample(src, w, h)
    fy, fx = src_h // h, src_w // w
    assert out[0, 0] == pytest.approx(src[:fy, :fx].mean())


# --- 2. non-divisor must NOT crop ---------------------------------------------

@pytest.mark.parametrize("src_w,src_h,w,h", [
    (23, 11, 8, 4),   # the real shape class (23040x11520 -> 8192x4096), fx=2 crop
    (10, 10, 3, 3),
    (23040, 11520, 8192, 4096),  # the actual production regression dims
])
def test_resample_non_divisor_no_crop(src_w, src_h, w, h):
    _set_src(src_w, src_h)
    src = _gradient(src_w, src_h)

    out = bake_moon.resample(src, w, h)

    assert out.shape == (h, w)
    # The bottom-right output cell MUST correspond to the source bottom-right
    # corner. The old block-reduce cropped to src[:h*fx... ] and lost it.
    assert out[-1, -1] == pytest.approx(src[-1, -1])
    # Top-left output cell maps to source top-left.
    assert out[0, 0] == pytest.approx(src[0, 0])
    # Output spans the full source value range (no shrunk/stretched subregion).
    assert out.min() == pytest.approx(src.min())
    assert out.max() == pytest.approx(src.max())


def test_resample_non_divisor_uses_full_longitude_span():
    """Regression guard: a horizontal-only gradient (value == column index)
    must reach the last column in the output's last column."""
    src_w, src_h = 23, 5
    w, h = 8, 5
    _set_src(src_w, src_h)
    # value depends only on column -> last column == src_w-1 everywhere.
    src = np.broadcast_to(np.arange(src_w, dtype=np.float32), (src_h, src_w)).copy()

    out = bake_moon.resample(src, w, h)

    assert out.shape == (h, w)
    # Every cell of the output's last column must equal the source's last column
    # value; a crop to fx*w=16 cols would top out at column 15, not 22.
    assert np.allclose(out[:, -1], src_w - 1)


# --- 3. identity ---------------------------------------------------------------

def test_resample_identity_returns_input_unchanged():
    src_w, src_h = 9, 7
    _set_src(src_w, src_h)
    src = _gradient(src_w, src_h)
    out = bake_moon.resample(src, src_w, src_h)
    assert out is src  # identity short-circuit returns the same object
    assert np.array_equal(out, src)


# --- 4. format / convention invariants ----------------------------------------

def test_lola_dn_to_meters_scaling():
    """LOLA encoding: elevation (m) = DN * SCALING_FACTOR (0.5)."""
    assert bake_moon.SCALING_FACTOR == 0.5
    dn = np.array([-1000, 0, 21600], dtype="<i2")
    meters = dn.astype(np.float32) * bake_moon.SCALING_FACTOR
    assert meters.tolist() == [-500.0, 0.0, 10800.0]


def test_longitude_roll_convention():
    """0..360E columns -> -180..180 via np.roll(width//2). Lock the convention:
    a row [0,1,2,3] rolled by 2 becomes [2,3,0,1]."""
    row = np.array([[0, 1, 2, 3]], dtype=np.float32)
    rolled = np.roll(row, row.shape[1] // 2, axis=1)
    assert rolled.tolist() == [[2.0, 3.0, 0.0, 1.0]]


def test_longitude_roll_moves_prime_meridian_to_center():
    """With the real 0..360 layout, column 0 (lon 0E) must land at the grid
    center after the half-width roll (matching load_elev's intent)."""
    w = 8
    lons_0_360 = np.arange(w, dtype=np.float32)[None, :]  # col index == 0..7
    rolled = np.roll(lons_0_360, w // 2, axis=1)
    # original column 0 (lon 0E / prime meridian) now at index w//2 (center).
    assert rolled[0, w // 2] == 0.0


def test_moon_reference_radius():
    assert bake_moon.MOON_RADIUS_M == 1737400
    assert bake_moon.LDEM_DIMS[64] == (23040, 11520)


# --- 5. pure landmark/sampling helper (no DEM download) ------------------------

def test_lat_lon_to_grid_index_mapping():
    """Reproduce the verify() sample() index math and confirm the documented
    orientation: row 0 = +90N, col 0 = -180W (pure arithmetic, no file)."""
    h, w = 4096, 8192

    def sample_index(lat, lon):
        r = int(round((90.0 - lat) / 180.0 * (h - 1)))
        c = int(round((lon + 180.0) / 360.0 * (w - 1)))
        return r, c

    # North pole -> row 0; south pole -> last row.
    assert sample_index(90.0, -180.0) == (0, 0)
    assert sample_index(-90.0, 180.0) == (h - 1, w - 1)
    # Equator / prime meridian -> middle.
    rmid, cmid = sample_index(0.0, 0.0)
    assert rmid == round((h - 1) / 2)
    assert cmid == round((w - 1) / 2)
