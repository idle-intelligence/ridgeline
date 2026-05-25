// Per-frame geometry generation.
//
// Each heightfield row is a constant-latitude strip:
//   - fill: triangle-strip from a baseline y (below terrain min) up to the elevation profile
//   - line: polyline along the ridge profile only
//
// LOD scheme (two axes):
//
// ROW LOD — at most ROW_BUDGET strips rendered per frame regardless of grid height.
//   Rows are divided into 5 distance tiers; each tier gets a weighted slice of the budget
//   (near tiers denser). Hard far-cull beyond FAR_CULL_Z wu from camera.
//
// COLUMN LOD — each row is sampled to at most COL_NEAR_POINTS (close) or COL_FAR_POINTS
//   (distant) evenly-spaced points. The last column is always included so strips close.
//
// Output order: farthest row first (back-to-front painter's order).

use crate::heightfield::Heightfield;
use glam::Vec3;

// ── Row budget ────────────────────────────────────────────────────────────────

/// Hard far-cull distance (world units from camera z).
const FAR_CULL_Z: f32 = 14_000.0;

/// Maximum strips emitted per frame regardless of grid size.
const ROW_BUDGET: usize = 200;

/// Distance tier thresholds (world units). Must be ascending, last ≥ FAR_CULL_Z.
const ROW_TIER_THRESHOLDS: [f32; 5] = [400.0, 1200.0, 3000.0, 6000.0, 14_000.0];

/// Budget weights per tier (near tiers get proportionally more strips).
const ROW_TIER_WEIGHTS: [usize; 5] = [8, 6, 5, 4, 3]; // sum = 26

// ── Column budget ─────────────────────────────────────────────────────────────

/// Max sample points per row for near rows (dist_z ≤ COL_FAR_DIST).
const COL_NEAR_POINTS: u32 = 320;
/// Max sample points per row for distant rows.
const COL_FAR_POINTS: u32 = 128;
/// Distance beyond which far-column count applies.
const COL_FAR_DIST: f32 = 3_000.0;

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

    // ── Collect visible rows ──────────────────────────────────────────────────
    // For each row: (row_index, dist_z, fwd_proj_for_sort)
    let mut visible: Vec<(u32, f32, f32)> = Vec::new();

    for row in 0..hf.height {
        let world_z = hf.row_z(row);
        let dist_z = (world_z - cam_pos.z).abs();

        if dist_z > FAR_CULL_Z {
            continue;
        }

        // Loose forward-hemisphere cull (~114° half-angle)
        let to_row = Vec3::new(cam_pos.x, cam_pos.y, world_z) - cam_pos;
        if to_row.normalize_or_zero().dot(cam_fwd_n) < -0.4 {
            continue;
        }

        let fwd_proj = Vec3::new(0.0, 0.0, world_z).dot(cam_fwd_n) - cam_pos.dot(cam_fwd_n);
        visible.push((row, dist_z, fwd_proj));
    }

    // Sort farthest-first (painter's order)
    visible.sort_unstable_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    // ── Row budget: sub-sample within each tier ───────────────────────────────
    let selected = apply_row_budget(&visible);

    // ── Emit geometry ─────────────────────────────────────────────────────────
    // Preallocate conservatively: ROW_BUDGET rows × COL_NEAR_POINTS columns × 2 verts/col × 3 floats
    let cap = ROW_BUDGET * COL_NEAR_POINTS as usize * 2 * 3;
    let mut fill_verts: Vec<f32> = Vec::with_capacity(cap);
    let mut fill_draws: Vec<u32> = Vec::with_capacity(ROW_BUDGET * 2);
    let mut line_verts: Vec<f32> = Vec::with_capacity(cap / 2);
    let mut line_draws: Vec<u32> = Vec::with_capacity(ROW_BUDGET * 2);

    for (row, dist_z) in selected {
        let world_z = hf.row_z(row);
        let max_cols = if dist_z > COL_FAR_DIST { COL_FAR_POINTS } else { COL_NEAR_POINTS };
        let col_stride = col_stride_for(hf.width, max_cols);

        // Fill strip
        let fill_start = (fill_verts.len() / 3) as u32;
        let fill_before = fill_verts.len();
        emit_row(hf, row, world_z, col_stride, baseline_y, &mut fill_verts, true);
        let fill_count = ((fill_verts.len() - fill_before) / 3) as u32;
        if fill_count > 0 {
            fill_draws.push(fill_start);
            fill_draws.push(fill_count);
        }

        // Line strip
        let line_start = (line_verts.len() / 3) as u32;
        let line_before = line_verts.len();
        emit_row(hf, row, world_z, col_stride, baseline_y, &mut line_verts, false);
        let line_count = ((line_verts.len() - line_before) / 3) as u32;
        if line_count > 0 {
            line_draws.push(line_start);
            line_draws.push(line_count);
        }
    }

    GeometryBuffers { fill_verts, fill_draws, line_verts, line_draws }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn tier_of(dist_z: f32) -> usize {
    for (i, &t) in ROW_TIER_THRESHOLDS.iter().enumerate() {
        if dist_z < t { return i; }
    }
    ROW_TIER_THRESHOLDS.len() - 1
}

/// Sub-sample the sorted visible list to ≤ ROW_BUDGET entries.
/// Near tiers receive more budget; within each tier rows are evenly spaced.
fn apply_row_budget(visible: &[(u32, f32, f32)]) -> Vec<(u32, f32)> {
    // Count rows per tier
    let mut tier_count = [0usize; 5];
    for &(_, dist_z, _) in visible {
        tier_count[tier_of(dist_z)] += 1;
    }

    // Allocate budget per tier (weighted, capped by available rows)
    let weight_sum: usize = ROW_TIER_WEIGHTS.iter().sum();
    let mut tier_budget = [0usize; 5];
    let mut allocated = 0usize;
    for i in 0..5 {
        let alloc = (ROW_BUDGET * ROW_TIER_WEIGHTS[i] / weight_sum).min(tier_count[i]);
        tier_budget[i] = alloc;
        allocated += alloc;
    }
    // Give unused budget to tiers that have remaining rows (nearest first)
    let mut spare = ROW_BUDGET.saturating_sub(allocated);
    for i in 0..5 {
        if spare == 0 { break; }
        let extra = (tier_count[i].saturating_sub(tier_budget[i])).min(spare);
        tier_budget[i] += extra;
        spare -= extra;
    }

    // Walk sorted list (back-to-front) and evenly select within each tier.
    // Bresenham accumulator: select row `seen` if acc >= 1, then acc -= 1.
    let mut tier_seen = [0usize; 5];
    let mut tier_acc = [0.0f32; 5]; // fractional accumulator
    let mut out: Vec<(u32, f32)> = Vec::with_capacity(ROW_BUDGET);

    for &(row, dist_z, _) in visible {
        let t = tier_of(dist_z);
        let budget = tier_budget[t];
        let count = tier_count[t];

        if budget > 0 && count > 0 {
            // Advance accumulator by budget/count each row; emit when ≥ 1
            tier_acc[t] += budget as f32 / count as f32;
            if tier_acc[t] >= 1.0 {
                tier_acc[t] -= 1.0;
                out.push((row, dist_z));
            }
        }
        tier_seen[t] += 1;
    }

    out
}

/// Column stride so that `width` columns produce at most `max_points` samples.
#[inline]
fn col_stride_for(width: u32, max_points: u32) -> u32 {
    if max_points == 0 || width <= max_points {
        1
    } else {
        // ceiling division: ensures we don't exceed max_points
        width.div_ceil(max_points)
    }
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

        if c == last_col { break; }
        col = (col + stride).min(last_col);
    }
}
