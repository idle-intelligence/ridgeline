// Per-frame geometry generation for the SPHERE model.
//
// The world is a globe of stacked latitude rings centered at the origin.
//
// LINE channel = bright latitude rings. For each visible ring (a row of the grid),
//   a LINE_STRIP of 3D sphere points sweeping longitude. Per-vertex elevation drives
//   brightness (ocean rings dim, land bright); per-vertex strength fades at the limb.
//
// FILL channel = a dark OCCLUDER SPHERE at radius R_world*0.999 (just below sea level
//   so it never z-fights the h=0 ocean rings). A coarse lat/lon tessellation of the
//   visible hemisphere, drawn TRIANGLE_STRIP per occluder ring. fill_elevations = 0
//   (it's the dark sphere); fill_strengths ~1, fading at the limb. Depth test then
//   hides the back side of the globe behind it.
//
// LOD (index-anchored, power-of-two strides → no swimming):
//   row `r` rendered iff `r % row_stride == 0`; longitude sample `c` iff `c % col_stride == 0`.
//   Strides chosen by camera altitude (distance to surface): far → coarse (cheap whole
//   globe), close → fine. The same stride set is used globe-wide each frame so the set of
//   rendered rows/cols changes only at discrete power-of-two boundaries.
//
// Horizon / back-face cull (view-independent): a surface point P is visible iff
//   dot(normalize(P), normalize(cam_pos)) > R_world/|cam_pos| − margin. Rings entirely
//   beyond the limb are skipped; within a ring, longitude samples beyond the limb are
//   dropped (the strip is split into visible runs).
//
// Strength fade: ramps to 0 as a point approaches the horizon, so rings dissolve at the
//   edge of the visible hemisphere instead of popping.

use crate::heightfield::{Heightfield, R_WORLD};
use glam::Vec3;

/// Occluder sphere radius — just below sea level so it never z-fights ocean rings.
const OCCLUDER_R: f32 = R_WORLD * 0.999;

/// Horizon cull margin (subtracted from the horizon dot threshold) so geometry slightly
/// past the geometric limb is still emitted and fades out smoothly rather than popping.
const HORIZON_MARGIN: f32 = 0.04;

/// Fade band (in dot-product units above the horizon threshold) over which strength
/// ramps 0→1. Points right at the horizon are strength 0; well inside are 1.
const FADE_BAND: f32 = 0.12;

pub struct GeometryBuffers {
    pub fill_verts: Vec<f32>,
    pub fill_draws: Vec<u32>,
    pub fill_strengths: Vec<f32>,
    pub fill_elevations: Vec<f32>,
    pub line_verts: Vec<f32>,
    pub line_draws: Vec<u32>,
    pub line_strengths: Vec<f32>,
    pub line_elevations: Vec<f32>,
}

/// Choose (row_stride, col_stride) — both powers of two — from camera altitude above
/// the sea-level sphere (world units). Far away → coarse; diving in → fine.
fn strides_for_altitude(altitude_wu: f32) -> (u32, u32) {
    // altitude is |cam_pos| - R_WORLD. Spawn is ~2*R → alt ~12000.
    // Whole-globe view is dense enough that coastlines/continents read clearly; perf
    // headroom is large, so we spend it on the far LOD (the "that's Earth!" view).
    if altitude_wu > 6000.0 {
        (16, 16) // whole globe in view: dense — continents read clearly
    } else if altitude_wu > 1500.0 {
        (8, 8)
    } else if altitude_wu > 700.0 {
        (4, 8)
    } else if altitude_wu > 120.0 {
        (2, 4)
    } else {
        (1, 2) // skimming the surface: fine detail
    }
}

/// Visibility strength of a surface point given the camera direction and horizon threshold.
/// Returns 0 if culled (behind horizon + margin), ramping 0→1 across FADE_BAND.
#[inline]
fn point_strength(p: Vec3, cam_dir: Vec3, horizon_dot: f32) -> f32 {
    let d = p.normalize_or_zero().dot(cam_dir);
    let cut = horizon_dot - HORIZON_MARGIN;
    if d <= cut {
        0.0
    } else {
        ((d - cut) / FADE_BAND).clamp(0.0, 1.0)
    }
}

pub fn generate(hf: &Heightfield, cam_pos: Vec3, _cam_fwd: Vec3) -> GeometryBuffers {
    let cam_len = cam_pos.length().max(R_WORLD + 1.0);
    let cam_dir = cam_pos / cam_len;
    // Horizon plane: points with dot(P̂, cam_dir) > R/|cam| are on the near hemisphere.
    let horizon_dot = (R_WORLD / cam_len).clamp(-1.0, 1.0);
    let altitude_wu = cam_len - R_WORLD;
    let (row_stride, col_stride) = strides_for_altitude(altitude_wu);

    let mut fill_verts: Vec<f32> = Vec::new();
    let mut fill_draws: Vec<u32> = Vec::new();
    let mut fill_strengths: Vec<f32> = Vec::new();
    let mut fill_elevations: Vec<f32> = Vec::new();
    let mut line_verts: Vec<f32> = Vec::new();
    let mut line_draws: Vec<u32> = Vec::new();
    let mut line_strengths: Vec<f32> = Vec::new();
    let mut line_elevations: Vec<f32> = Vec::new();

    // ── Occluder sphere (dark, hides far side via depth) ───────────────────────
    // Coarse lat/lon tessellation. We tessellate the whole sphere but skip rings whose
    // every vertex is fully culled; per-vertex strength fades at the limb.
    {
        // Build occluder on a fixed coarse grid independent of terrain resolution.
        let occ_lat_steps = 96; // rings of latitude
        let occ_lon_steps = 96; // segments of longitude
        // Iterate adjacent latitude pairs → one TRIANGLE_STRIP per band.
        for li in 0..occ_lat_steps {
            let lat_a = 90.0 - 180.0 * (li as f32) / (occ_lat_steps as f32);
            let lat_b = 90.0 - 180.0 * ((li + 1) as f32) / (occ_lat_steps as f32);

            let strip_start = (fill_verts.len() / 3) as u32;
            let strip_before = fill_verts.len();
            let mut any_visible = false;

            for lj in 0..=occ_lon_steps {
                let lon = -180.0 + 360.0 * (lj as f32) / (occ_lon_steps as f32);
                let pa = Heightfield::sphere_point(lat_a, lon, OCCLUDER_R - R_WORLD);
                let pb = Heightfield::sphere_point(lat_b, lon, OCCLUDER_R - R_WORLD);
                let sa = point_strength(pa, cam_dir, horizon_dot);
                let sb = point_strength(pb, cam_dir, horizon_dot);
                if sa > 0.0 || sb > 0.0 {
                    any_visible = true;
                }
                fill_verts.extend_from_slice(&[pa.x, pa.y, pa.z]);
                fill_verts.extend_from_slice(&[pb.x, pb.y, pb.z]);
                fill_strengths.push(sa);
                fill_strengths.push(sb);
                fill_elevations.push(0.0);
                fill_elevations.push(0.0);
            }

            if any_visible {
                let count = ((fill_verts.len() - strip_before) / 3) as u32;
                fill_draws.push(strip_start);
                fill_draws.push(count);
            } else {
                // discard this fully-culled band (rewind parallel buffers)
                let added = 2 * (occ_lon_steps + 1);
                fill_verts.truncate(strip_before);
                fill_strengths.truncate(fill_strengths.len() - added);
                fill_elevations.truncate(fill_elevations.len() - added);
            }
        }
    }

    // ── Latitude rings (bright lines) ──────────────────────────────────────────
    let last_col = hf.width - 1;
    for row in (0..hf.height).step_by(row_stride as usize) {
        let lat = hf.row_lat(row);

        // Sweep longitude, splitting into visible runs (strips broken at the limb).
        let mut run_start: Option<u32> = None; // vertex index where current run began
        let mut col = 0u32;
        loop {
            let c = col.min(last_col);
            let lon = hf.col_lon(c);
            let h = hf.sample(row, c);
            let p = Heightfield::sphere_point(lat, lon, h);
            let s = point_strength(p, cam_dir, horizon_dot);
            let en = hf.elev_norm(row, c);

            if s > 0.0 {
                if run_start.is_none() {
                    run_start = Some((line_verts.len() / 3) as u32);
                }
                line_verts.extend_from_slice(&[p.x, p.y, p.z]);
                line_strengths.push(s);
                line_elevations.push(en);
            } else if let Some(start) = run_start.take() {
                // close the run
                let count = (line_verts.len() / 3) as u32 - start;
                if count >= 2 {
                    line_draws.push(start);
                    line_draws.push(count);
                } else {
                    // single-vertex run is useless; drop it
                    line_verts.truncate((start as usize) * 3);
                    line_strengths.truncate(start as usize);
                    line_elevations.truncate(start as usize);
                }
            }

            if c == last_col {
                break;
            }
            col = (col + col_stride).min(last_col);
        }
        // close a run that reaches the wrap-around end
        if let Some(start) = run_start.take() {
            let count = (line_verts.len() / 3) as u32 - start;
            if count >= 2 {
                line_draws.push(start);
                line_draws.push(count);
            } else {
                line_verts.truncate((start as usize) * 3);
                line_strengths.truncate(start as usize);
                line_elevations.truncate(start as usize);
            }
        }
    }

    GeometryBuffers {
        fill_verts, fill_draws, fill_strengths, fill_elevations,
        line_verts, line_draws, line_strengths, line_elevations,
    }
}
