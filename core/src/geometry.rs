// Per-frame geometry generation.
//
// Each heightfield row is a constant-latitude strip:
//   - fill: triangle-strip from a baseline y (below terrain min) up to the elevation profile
//   - line: polyline along the ridge profile only
//
// Culling:
//   Rows are skipped when the dot product of (row_center - cam_pos) with cam_fwd is < -0.4.
//   This is a loose hemisphere cull (~114° half-angle FOV gate); no exact frustum needed.
//
// LOD (stride):
//   3 tiers by world-z distance from camera:
//     < 200 wu  → stride 1 (full res)
//     < 400 wu  → stride 2
//     otherwise → stride 4
//
// Baseline:
//   BASELINE_Y = elev_world_min - 5.0 (small gap below lowest terrain for fill aesthetics)
//
// Output order: farthest row first (back-to-front painter's order).

use crate::heightfield::Heightfield;
use glam::Vec3;

const LOD_TIERS: [(f32, u32); 3] = [(3000.0, 1), (6000.0, 2), (f32::MAX, 2)];

pub struct GeometryBuffers {
    pub fill_verts: Vec<f32>,
    pub fill_draws: Vec<u32>,
    pub line_verts: Vec<f32>,
    pub line_draws: Vec<u32>,
}

pub fn generate(hf: &Heightfield, cam_pos: Vec3, cam_fwd: Vec3) -> GeometryBuffers {
    let baseline_y = hf.elev_world_min - 5.0;
    let cam_fwd_n = cam_fwd.normalize_or_zero();

    // Collect visible rows (row index, world_z, forward-projection for sort)
    let mut visible: Vec<(u32, f32, f32)> = Vec::new();

    for row in 0..hf.height {
        let world_z = hf.row_z(row);
        let to_row = (Vec3::new(0.0, cam_pos.y, world_z) - cam_pos).normalize_or_zero();
        if to_row.dot(cam_fwd_n) < -0.4 {
            continue;
        }
        // Forward projection: signed distance along cam_fwd (used for back-to-front sort)
        let fwd_proj = (Vec3::new(0.0, 0.0, world_z) - cam_pos).dot(cam_fwd_n);
        visible.push((row, world_z, fwd_proj));
    }

    // Sort farthest (largest fwd_proj) first
    visible.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    let mut fill_verts: Vec<f32> = Vec::new();
    let mut fill_draws: Vec<u32> = Vec::new();
    let mut line_verts: Vec<f32> = Vec::new();
    let mut line_draws: Vec<u32> = Vec::new();

    for (row, world_z, _) in &visible {
        let row = *row;
        let world_z = *world_z;

        let dist = (world_z - cam_pos.z).abs();
        let stride = lod_stride(dist);

        // --- Fill strip ---
        let fill_start = (fill_verts.len() / 3) as u32;
        let fill_verts_before = fill_verts.len();

        emit_strip_row(hf, row, world_z, stride, baseline_y, &mut fill_verts, true);

        let fill_count = ((fill_verts.len() - fill_verts_before) / 3) as u32;
        if fill_count > 0 {
            fill_draws.push(fill_start);
            fill_draws.push(fill_count);
        }

        // --- Line strip ---
        let line_start = (line_verts.len() / 3) as u32;
        let line_verts_before = line_verts.len();

        emit_strip_row(hf, row, world_z, stride, baseline_y, &mut line_verts, false);

        let line_count = ((line_verts.len() - line_verts_before) / 3) as u32;
        if line_count > 0 {
            line_draws.push(line_start);
            line_draws.push(line_count);
        }
    }

    GeometryBuffers { fill_verts, fill_draws, line_verts, line_draws }
}

/// Emit vertices for one row into `out`.
/// If `fill` = true: emits alternating (baseline, top) pairs for TRIANGLE_STRIP.
/// If `fill` = false: emits top-only vertices for LINE_STRIP.
fn emit_strip_row(
    hf: &Heightfield,
    row: u32,
    world_z: f32,
    stride: u32,
    baseline_y: f32,
    out: &mut Vec<f32>,
    fill: bool,
) {
    // Columns to emit: strided walk + ensure last column is included
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
        // If stride overshot to last_col, loop will emit it and break
    }
}

fn lod_stride(dist: f32) -> u32 {
    for &(threshold, stride) in &LOD_TIERS {
        if dist < threshold {
            return stride;
        }
    }
    LOD_TIERS[LOD_TIERS.len() - 1].1
}
