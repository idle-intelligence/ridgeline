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
//   [0,      200)    → (4,   32)    ultra-near: only within 200wu (craft docked/landed)
//   [200,    1400)   → (8,   64)    near: primary near band, wide to reduce pop frequency
//   [1400,   3500)   → (16,  128)
//   [3500,   7000)   → (32,  256)
//   [7000,   11000)  → (64,  512)
//   [11000,  17000)  → (128, 1024)  base far band
//   [17000,  25000)  → (256, 2048)  high-altitude extension
//   [25000,  FAR)    → (512, 4096)  very-high-altitude extension
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
// Band thresholds are pushed outward and spread wider than the minimum needed so
// that LOD transitions happen far from the camera (sub-pixel / low-contrast) and
// the camera can travel farther before any band boundary crosses a visible row.
// Wider bands = fewer transitions per unit of travel = less wavefront popping.
//
// With VE=20 and terrain up to ~1000 wu tall, near terrain is dense and dramatic;
// far terrain benefit from aggressive culling.

/// Band thresholds (ascending). Each band index maps to a stride pair below.
/// The world is ±6000 wu with 8192 grid rows/cols, so ~1.46 wu per cell.
///
/// LOD wavefront mitigation: eliminating the finest row_stride=4 band reduces the
/// most visible pop (new rows appearing between existing ones at the near transition).
/// stride=8 near terrain at VE=20 still gives dense, dramatic ridgelines (every ~11 wu),
/// while the furthest band transitions happen in the distance where they are imperceptible.
/// Bands are widely-spaced so the camera travels a long way before any transition fires.
const BANDS: [f32; 8] = [200.0, 1_400.0, 3_500.0, 7_000.0, 11_000.0, 17_000.0, 25_000.0, f32::MAX];

/// (row_stride, col_stride) per band index (power-of-two, index-aligned).
/// col_stride is relative to the 8192-column grid.
///   ultra (<200wu):   every 4th row, every 32nd col  — only within 200wu (rare in normal flight)
///   near  (<1400wu):  every 8th row, every 64th col  — primary near band, wide threshold
///   mid1  (<3500wu):  every 16th row, every 128th col
///   mid2  (<7000wu):  every 32nd row, every 256th col
///   mid3  (<11000wu): every 64th row, every 512th col
///   far   (<17000):   every 128th row, every 1024th col
///   xfar  (<25000):   every 256th row, every 2048th col — high-altitude extension
///   xxfar (beyond):   every 512th row, every 4096th col — very-high-altitude extension
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
const FAR_CULL_BASE: f32 = 14_000.0;
/// Far-cull increase per world unit of altitude (linear gain).
/// At altitude 500 wu → cull ~19k wu; at 2000 wu → cull ~30k wu.
const FAR_CULL_ALT_GAIN: f32 = 10.0;
/// Minimum far-cull (applied even when underground).
const FAR_CULL_MIN: f32 = 8_000.0;
/// Maximum far-cull regardless of altitude.
const FAR_CULL_MAX: f32 = 30_000.0;

/// Compute per-frame far-cull distance from camera altitude (world-space y, sea = 0).
#[inline]
fn far_cull(cam_y: f32) -> f32 {
    let altitude = cam_y.max(0.0);
    (FAR_CULL_BASE + FAR_CULL_ALT_GAIN * altitude).clamp(FAR_CULL_MIN, FAR_CULL_MAX)
}

// ── Earth curvature ───────────────────────────────────────────────────────────
/// Effective planet radius in world units.
/// Real Earth 6371 km; scale is ~10.3 wu/km → R ≈ 65600 wu.
/// Tuned to 55000 wu for a visibly curved horizon at high altitude without
/// a noticeable warp up close.
const CURVE_R: f32 = 55_000.0;


// ─────────────────────────────────────────────────────────────────────────────

pub struct GeometryBuffers {
    pub fill_verts: Vec<f32>,
    pub fill_draws: Vec<u32>,
    pub line_verts: Vec<f32>,
    pub line_draws: Vec<u32>,
}

pub fn generate(hf: &Heightfield, cam_pos: Vec3, cam_fwd: Vec3) -> GeometryBuffers {
    // Pull baseline well below terrain minimum so fill polygons fully occlude
    // each other; gap scales with VE (VE=20 → terrain ~10x taller → need deeper baseline).
    let baseline_y = hf.elev_world_min - 50.0;
    let cam_fwd_n = cam_fwd.normalize_or_zero();

    // Altitude-driven far-cull: camera y is world-space (sea = 0).
    let far_cull_dist = far_cull(cam_pos.y);

    // ── Collect visible rows (back-to-front) ──────────────────────────────────
    // We need painter's order: sort by forward projection, farthest first.
    // Collect eligible rows first, then sort.
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
    // conservative per-row: max columns at coarsest col_stride for near, up to width/2
    let col_cap = (hf.width / 2 + 2) as usize;
    let cap = est_rows * col_cap * 2 * 3;
    let mut fill_verts: Vec<f32> = Vec::with_capacity(cap);
    let mut fill_draws: Vec<u32> = Vec::with_capacity(est_rows * 2);
    let mut line_verts: Vec<f32> = Vec::with_capacity(cap / 2);
    let mut line_draws: Vec<u32> = Vec::with_capacity(est_rows * 2);

    for (row, dist_z, _) in &visible {
        let world_z = hf.row_z(*row);
        let band = band_of(*dist_z);
        let col_stride = STRIDES[band].1;

        // Fill strip
        let fill_start = (fill_verts.len() / 3) as u32;
        let fill_before = fill_verts.len();
        emit_row(hf, *row, world_z, col_stride, baseline_y, cam_pos, &mut fill_verts, true);
        let fill_count = ((fill_verts.len() - fill_before) / 3) as u32;
        if fill_count > 0 {
            fill_draws.push(fill_start);
            fill_draws.push(fill_count);
        }

        // Line strip
        let line_start = (line_verts.len() / 3) as u32;
        let line_before = line_verts.len();
        emit_row(hf, *row, world_z, col_stride, baseline_y, cam_pos, &mut line_verts, false);
        let line_count = ((line_verts.len() - line_before) / 3) as u32;
        if line_count > 0 {
            line_draws.push(line_start);
            line_draws.push(line_count);
        }
    }

    GeometryBuffers { fill_verts, fill_draws, line_verts, line_draws }
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
