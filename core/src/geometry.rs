// Per-frame geometry generation.
//
// Each heightfield row is a constant-latitude strip:
//   - fill: triangle-strip from a baseline y (below terrain min) up to the elevation profile
//   - line: polyline along the ridge profile only
//
// LOD scheme (stable, index-anchored):
//
// ROW LOD — row `r` is rendered iff `r % row_stride == 0`.
//   row_stride is a power-of-two determined solely by the row's distance from the camera.
//   Because the grid is always sampled at row indices 0, stride, 2*stride, …, the set of
//   rendered rows does NOT change with sub-grid camera movement — only at discrete LOD
//   pop boundaries (power-of-two aligned).
//
// COLUMN LOD — within a rendered row, sample column `c` iff `c % col_stride == 0`.
//   col_stride is also a power-of-two determined by the row's distance.
//   Constant along the row (no per-column variation = no diagonal artifacts).
//   Always includes the last column so strips close.
//
// Distance bands → (row_stride, col_stride):
//   [0,       1500)   → (4,   32)    ultra-near
//   [1500,    6000)   → (8,   64)    near
//   [6000,    15000)  → (16,  128)
//   [15000,   28000)  → (32,  256)
//   [28000,   45000)  → (64,  512)
//   [45000,   65000)  → (128, 1024)
//   [65000,   90000)  → (256, 2048)
//   [90000,   FAR)    → (512, 4096)
//
// Per-vertex strength (0..1):
//   Each vertex gets a "strength" in [0..1] that drives alpha blending in the renderer.
//   Strength is 1.0 in the interior of each band and ramps toward 0 at:
//     (a) the far-cull distance (far-fade, hides the speckle/pop horizon)
//     (b) the outer edge of each band (outer-fade, softens LOD seam appearance)
//   The near edge of each band is NOT faded (rows are always 100% opaque as they enter).
//   This eliminates the "diagonal density wall" seam and the far speckle.
//
// Hard far-cull beyond far_cull (computed from camera altitude each frame).
//
// Earth curvature: each emitted vertex has y reduced by d²/(2R) where d is horizontal
// (XZ-plane) distance from the camera and R = CURVE_R world units.
//
// Output order: farthest row first (back-to-front painter's order).

use crate::heightfield::Heightfield;
use glam::Vec3;

// ── Distance bands (world units from camera z) ────────────────────────────────
//
// WORLD_HALF=40000 → world spans ±40000 wu. Far-cull peaks ~70000 wu at altitude.
// Bands are spaced so transitions happen far from camera (sub-pixel at distance)
// and the camera travels a long way before any band boundary crosses a visible row.

/// Band thresholds (ascending). Each band index maps to a stride pair below.
const BANDS: [f32; 8] = [
    1_500.0,
    6_000.0,
    15_000.0,
    28_000.0,
    45_000.0,
    65_000.0,
    90_000.0,
    f32::MAX,
];

/// (row_stride, col_stride) per band index (power-of-two, index-aligned).
const STRIDES: [(u32, u32); 8] = [
    (4,   32),
    (8,   64),
    (16,  128),
    (32,  256),
    (64,  512),
    (128, 1024),
    (256, 2048),
    (512, 4096),
];

// ── Altitude-driven far-cull ─────────────────────────────────────────────────
/// Baseline far-cull at sea level (world units).
const FAR_CULL_BASE: f32 = 18_000.0;
/// Far-cull increase per world unit of altitude (linear gain).
/// At altitude 1000 wu → cull ~28k wu; at 5000 wu → cull ~68k wu.
const FAR_CULL_ALT_GAIN: f32 = 10.0;
/// Minimum far-cull.
const FAR_CULL_MIN: f32 = 12_000.0;
/// Maximum far-cull regardless of altitude (80000 wu world span; keep below that).
const FAR_CULL_MAX: f32 = 70_000.0;

/// Strength fade begins this far before the hard cull boundary.
const FAR_FADE_MARGIN: f32 = 6_000.0;

/// Each LOD band's outer edge fades its rows over this width (world units).
/// Softens the seam where a coarser band takes over from a finer one.
const BAND_OUTER_FADE: f32 = 2_000.0;

/// Compute per-frame far-cull distance from camera altitude (world-space y, sea = 0).
#[inline]
fn far_cull(cam_y: f32) -> f32 {
    let altitude = cam_y.max(0.0);
    (FAR_CULL_BASE + FAR_CULL_ALT_GAIN * altitude).clamp(FAR_CULL_MIN, FAR_CULL_MAX)
}

// ── Earth curvature ───────────────────────────────────────────────────────────
/// Effective planet radius in world units.
/// WORLD_HALF=40000 → world ~6x larger than before → R scales accordingly.
/// R≈360000 gives a visibly curved horizon at high altitude without warping nearby terrain.
const CURVE_R: f32 = 360_000.0;


// ─────────────────────────────────────────────────────────────────────────────

pub struct GeometryBuffers {
    pub fill_verts: Vec<f32>,
    pub fill_draws: Vec<u32>,
    pub fill_strengths: Vec<f32>,
    pub line_verts: Vec<f32>,
    pub line_draws: Vec<u32>,
    pub line_strengths: Vec<f32>,
}

pub fn generate(hf: &Heightfield, cam_pos: Vec3, cam_fwd: Vec3) -> GeometryBuffers {
    // Pull baseline well below terrain minimum so fill polygons fully occlude each other.
    let baseline_y = hf.elev_world_min - 200.0;
    let cam_fwd_n = cam_fwd.normalize_or_zero();

    // Altitude-driven far-cull: camera y is world-space (sea = 0).
    let far_cull_dist = far_cull(cam_pos.y);

    // ── Collect visible rows (back-to-front) ──────────────────────────────────
    let mut visible: Vec<(u32, f32, f32)> = Vec::new(); // (row, dist_z, fwd_proj)

    for row in 0..hf.height {
        let world_z = hf.row_z(row);
        let dist_z = (world_z - cam_pos.z).abs();

        if dist_z > far_cull_dist {
            continue;
        }

        // Loose forward-hemisphere cull (~114° half-angle).
        let to_row = Vec3::new(cam_pos.x, cam_pos.y, world_z) - cam_pos;
        if to_row.normalize_or_zero().dot(cam_fwd_n) < -0.4 {
            continue;
        }

        // Determine row_stride for this distance band.
        let band = band_of(dist_z);
        let row_stride = STRIDES[band].0;

        // Index-anchored: only render rows whose index is aligned to the stride.
        if row % row_stride != 0 {
            continue;
        }

        let fwd_proj = Vec3::new(0.0, 0.0, world_z).dot(cam_fwd_n) - cam_pos.dot(cam_fwd_n);
        visible.push((row, dist_z, fwd_proj));
    }

    // Sort farthest-first (painter's order).
    visible.sort_unstable_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    // ── Emit geometry ─────────────────────────────────────────────────────────
    let est_rows = visible.len();
    let col_cap = (hf.width / 32 + 2) as usize;
    let cap = est_rows * col_cap * 2 * 3;
    let mut fill_verts: Vec<f32> = Vec::with_capacity(cap);
    let mut fill_draws: Vec<u32> = Vec::with_capacity(est_rows * 2);
    let mut fill_strengths: Vec<f32> = Vec::with_capacity(cap / 3);
    let mut line_verts: Vec<f32> = Vec::with_capacity(cap / 2);
    let mut line_draws: Vec<u32> = Vec::with_capacity(est_rows * 2);
    let mut line_strengths: Vec<f32> = Vec::with_capacity(cap / 6);

    for (row, dist_z, _) in &visible {
        let world_z = hf.row_z(*row);
        let band = band_of(*dist_z);
        let col_stride = STRIDES[band].1;

        // Compute per-row strength (0..1): fades near far-cull AND at band outer edge.
        let strength = row_strength(*dist_z, band, far_cull_dist);

        // Fill strip
        let fill_start = (fill_verts.len() / 3) as u32;
        let fill_before = fill_verts.len();
        emit_row(hf, *row, world_z, col_stride, baseline_y, cam_pos, &mut fill_verts, true);
        let fill_count = ((fill_verts.len() - fill_before) / 3) as u32;
        if fill_count > 0 {
            fill_draws.push(fill_start);
            fill_draws.push(fill_count);
            // Two vertices per column (baseline + top) in fill strip.
            for _ in 0..fill_count {
                fill_strengths.push(strength);
            }
        }

        // Line strip
        let line_start = (line_verts.len() / 3) as u32;
        let line_before = line_verts.len();
        emit_row(hf, *row, world_z, col_stride, baseline_y, cam_pos, &mut line_verts, false);
        let line_count = ((line_verts.len() - line_before) / 3) as u32;
        if line_count > 0 {
            line_draws.push(line_start);
            line_draws.push(line_count);
            for _ in 0..line_count {
                line_strengths.push(strength);
            }
        }
    }

    GeometryBuffers { fill_verts, fill_draws, fill_strengths, line_verts, line_draws, line_strengths }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Map a distance to a band index.
#[inline]
fn band_of(dist_z: f32) -> usize {
    for (i, &t) in BANDS.iter().enumerate() {
        if dist_z < t {
            return i;
        }
    }
    BANDS.len() - 1
}

/// Compute per-row strength in [0..1].
///
/// Fades toward 0 at:
///   (a) the far-cull boundary (FAR_FADE_MARGIN before it)
///   (b) the outer edge of this row's band (BAND_OUTER_FADE wide ramp)
///
/// This eliminates the rushing far-edge pop (far-fade) and the diagonal density
/// seam where coarser bands take over from finer ones (band outer-fade).
#[inline]
fn row_strength(dist_z: f32, band: usize, far_cull_dist: f32) -> f32 {
    // Far-fade: linear ramp from 1→0 over FAR_FADE_MARGIN before hard cull.
    let far_fade_start = (far_cull_dist - FAR_FADE_MARGIN).max(0.0);
    let far_strength = if dist_z >= far_cull_dist {
        0.0
    } else if dist_z > far_fade_start {
        1.0 - (dist_z - far_fade_start) / FAR_FADE_MARGIN
    } else {
        1.0
    };

    // Band outer-fade: rows near the outer boundary of their band fade toward 0
    // so they blend with the next coarser band that takes over beyond this threshold.
    let band_outer = BANDS[band]; // outer threshold for this band (except last)
    let band_outer_fade_strength = if band == BANDS.len() - 1 || band_outer == f32::MAX {
        // Last (infinite) band: no outer fade (hard cull handles it via far_strength).
        1.0
    } else {
        let fade_start = (band_outer - BAND_OUTER_FADE).max(0.0);
        if dist_z > fade_start {
            1.0 - (dist_z - fade_start) / BAND_OUTER_FADE
        } else {
            1.0
        }
    };

    far_strength.min(band_outer_fade_strength).clamp(0.0, 1.0)
}

/// Emit vertices for one row into `out`.
/// fill=true: alternating (baseline, top) pairs for TRIANGLE_STRIP.
/// fill=false: top-only for LINE_STRIP.
///
/// Earth curvature: each vertex's y is reduced by d²/(2·CURVE_R) where d is the
/// horizontal (XZ-plane) distance from cam_pos. The baseline vertex gets the same
/// drop so fill strips don't open gaps at the bottom.
#[allow(clippy::too_many_arguments)]
fn emit_row(
    hf: &Heightfield,
    row: u32,
    world_z: f32,
    stride: u32,
    baseline_y: f32,
    cam_pos: Vec3,
    out: &mut Vec<f32>,
    fill: bool,
) {
    let last_col = hf.width - 1;
    let mut col = 0u32;
    let dz = world_z - cam_pos.z;
    loop {
        let c = col.min(last_col);
        let x = hf.col_x(c);
        let y_top = hf.sample(row, c);

        // Horizontal distance from camera for curvature drop.
        let dx = x - cam_pos.x;
        let d2 = dx * dx + dz * dz;
        let drop = d2 / (2.0 * CURVE_R);

        if fill {
            out.extend_from_slice(&[x, baseline_y - drop, world_z]);
            out.extend_from_slice(&[x, y_top - drop, world_z]);
        } else {
            out.extend_from_slice(&[x, y_top - drop, world_z]);
        }

        if c == last_col {
            break;
        }
        col = (col + stride).min(last_col);
    }
}
