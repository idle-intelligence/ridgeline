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
//   [0,      BAND1)  → (1,  2)    very near: every row, dense columns
//   [BAND1,  BAND2)  → (2,  4)
//   [BAND2,  BAND3)  → (4,  8)
//   [BAND3,  BAND4)  → (8,  16)
//   [BAND4,  BAND5)  → (16, 32)
//   [BAND5,  FAR)    → (32, 64)   far: thin rows, coarse columns
//
// Hard far-cull beyond FAR_CULL_Z.
//
// Output order: farthest row first (back-to-front painter's order).

use crate::heightfield::Heightfield;
use glam::Vec3;

// ── Distance bands (world units from camera z) ────────────────────────────────

/// Hard far-cull distance.
const FAR_CULL_Z: f32 = 14_000.0;

/// Band thresholds (ascending). Each band index maps to a stride pair below.
/// The world is ±6000 wu with 8192 grid rows/cols, so ~1.46 wu per cell.
const BANDS: [f32; 6] = [300.0, 800.0, 2_000.0, 4_500.0, 8_000.0, FAR_CULL_Z];

/// (row_stride, col_stride) per band index (power-of-two, index-aligned).
/// col_stride is relative to the 8192-column grid.
///   near  (<300wu):  every 4th row, every 64th col  → ~200 rows, 128 cols  = ~25k fill verts
///   mid1  (<800wu):  every 8th row, every 128th col → sparse but smooth
///   mid2  (<2000wu): every 16th row, every 256th col
///   mid3  (<4500wu): every 32nd row, every 512th col
///   mid4  (<8000wu): every 64th row, every 1024th col
///   far   (< cull):  every 128th row, every 2048th col
const STRIDES: [(u32, u32); 6] = [
    (4,   64),
    (8,   128),
    (16,  256),
    (32,  512),
    (64,  1024),
    (128, 2048),
];

// ─────────────────────────────────────────────────────────────────────────────

pub struct GeometryBuffers {
    pub fill_verts: Vec<f32>,
    pub fill_draws: Vec<u32>,
    pub line_verts: Vec<f32>,
    pub line_draws: Vec<u32>,
}

pub fn generate(hf: &Heightfield, cam_pos: Vec3, cam_fwd: Vec3) -> GeometryBuffers {
    let baseline_y = hf.elev_world_min - 5.0;
    let cam_fwd_n = cam_fwd.normalize_or_zero();

    // ── Collect visible rows (back-to-front) ──────────────────────────────────
    // We need painter's order: sort by forward projection, farthest first.
    // Collect eligible rows first, then sort.
    let mut visible: Vec<(u32, f32, f32)> = Vec::new(); // (row, dist_z, fwd_proj)

    for row in 0..hf.height {
        let world_z = hf.row_z(row);
        let dist_z = (world_z - cam_pos.z).abs();

        if dist_z > FAR_CULL_Z {
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
    // conservative per-row: max columns at coarsest col_stride=2 for near, up to width/2
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
        emit_row(hf, *row, world_z, col_stride, baseline_y, &mut fill_verts, true);
        let fill_count = ((fill_verts.len() - fill_before) / 3) as u32;
        if fill_count > 0 {
            fill_draws.push(fill_start);
            fill_draws.push(fill_count);
        }

        // Line strip
        let line_start = (line_verts.len() / 3) as u32;
        let line_before = line_verts.len();
        emit_row(hf, *row, world_z, col_stride, baseline_y, &mut line_verts, false);
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
fn emit_row(
    hf: &Heightfield,
    row: u32,
    world_z: f32,
    stride: u32,
    baseline_y: f32,
    out: &mut Vec<f32>,
    fill: bool,
) {
    let last_col = hf.width - 1;
    let mut col = 0u32;
    loop {
        let c = col.min(last_col);
        let x = hf.col_x(c);
        let y_top = hf.sample(row, c);

        if fill {
            out.extend_from_slice(&[x, baseline_y, world_z]);
            out.extend_from_slice(&[x, y_top, world_z]);
        } else {
            out.extend_from_slice(&[x, y_top, world_z]);
        }

        if c == last_col {
            break;
        }
        col = (col + stride).min(last_col);
    }
}
