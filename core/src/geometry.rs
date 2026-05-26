// Per-frame geometry generation for the SPHERE model.
//
// The world is a globe of stacked latitude rings centered at the origin.
//
// LINE channel = bright latitude rings. For each visible ring (a row of the grid),
//   a LINE_STRIP of 3D sphere points sweeping longitude. Per-vertex elevation drives
//   brightness (ocean rings dim, land bright); per-vertex strength fades at the limb.
//
// FILL channel = a dark OCCLUDER SPHERE at radius R_world*0.999 (just below sea level
//   so it never z-fights the h=0 ocean rings). A lat/lon tessellation of the visible
//   hemisphere, drawn TRIANGLE_STRIP per occluder ring. fill_elevations = 0
//   (it's the dark sphere); fill_strengths ~1, fading at the limb. Depth test then
//   hides the back side of the globe behind it.
//
// LOD (index-anchored, power-of-two strides → no swimming):
//   row `r` rendered iff `r % row_stride == 0`; longitude sample `c` iff `c % col_stride == 0`.
//   Strides are chosen PER-RING / PER-SEGMENT from the DISTANCE of that geometry to the
//   camera (not a single global altitude). Near the camera → fine (stride 1–2, dense lon);
//   far across the globe / near the limb → coarse. Distances are quantized into bands and
//   strides are powers of two anchored to grid index, so the rendered set changes only at
//   discrete band boundaries (nothing swims). When the whole globe is in view (far away) all
//   rings land in roughly the same distance band, so the from-afar view is unchanged.
//
// Horizon / back-face cull (view-independent): a surface point P is visible iff
//   dot(normalize(P), normalize(cam_pos)) > R_world/|cam_pos| − margin.
//
// Frustum / sight cull (view-dependent): geometry whose direction from the camera falls
//   outside the camera FOV (plus a generous margin) is dropped. Uses the FREELOOK-AWARE
//   camera forward (phys.orientation * look_offset * -Z), the same direction the view
//   matrix uses — NOT the raw ship heading.
//
// Strength fade: ramps to 0 as a point approaches the horizon, so rings dissolve at the
//   edge of the visible hemisphere instead of popping.

use crate::heightfield::{ve_for_altitude, Heightfield, R_WORLD};
use glam::Vec3;

/// Occluder sphere radius — just below sea level so it never z-fights ocean rings.
const OCCLUDER_R: f32 = R_WORLD * 0.999;

/// Horizon cull margin (subtracted from the horizon dot threshold) so geometry slightly
/// past the geometric limb is still emitted and fades out smoothly rather than popping.
const HORIZON_MARGIN: f32 = 0.04;

/// Fade band (in dot-product units above the horizon threshold) over which strength
/// ramps 0→1. Points right at the horizon are strength 0; well inside are 1.
const FADE_BAND: f32 = 0.12;

/// Half-angle of the sight cone for frustum culling, in radians. Generous: covers the
/// 45° vertical FOV, its horizontal spread at wide aspect, plus a large pad so panning /
/// turning never pops terrain in at the screen edge. cos of this is precomputed per frame.
/// ~85° half-angle (≈170° total cone) — very forgiving; the per-distance LOD is the real win.
const SIGHT_HALF_ANGLE: f32 = 1.483; // ~85°

#[derive(Default)]
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

/// Distance-band LOD: choose (row_stride, col_stride) — both powers of two — from the
/// distance (world units) of a piece of geometry to the camera. Near → fine; far → coarse.
/// Bands are fixed so the chosen stride only changes at discrete boundaries (no swimming).
///
/// Distances are in world units. R_WORLD = 6000. Skimming the surface, the patch right
/// under the camera is ~tens–hundreds of wu away; the limb of the near hemisphere is
/// thousands of wu away. From afar (spawn, cam ~18000 from center) every ring is ~12000+
/// wu away → all land in the coarsest band, matching the old whole-globe LOD.
#[inline]
fn strides_for_distance(dist_wu: f32) -> (u32, u32) {
    if dist_wu < 150.0 {
        (1, 2) // right under / in front of the camera: full detail
    } else if dist_wu < 400.0 {
        (2, 4)
    } else if dist_wu < 900.0 {
        (4, 8)
    } else if dist_wu < 1800.0 {
        (8, 16)
    } else if dist_wu < 4000.0 {
        (16, 32)
    } else {
        (16, 16) // far: whole-globe view — same as the legacy from-afar LOD
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

/// Is direction-to-point within the sight cone (frustum cull)? `to_p` need not be
/// normalized. cos_half is the precomputed cosine of the cone half-angle.
#[inline]
fn in_sight(cam_pos: Vec3, cam_fwd: Vec3, p: Vec3, cos_half: f32) -> bool {
    let v = p - cam_pos;
    let len = v.length();
    if len < 1e-3 {
        return true;
    }
    (v / len).dot(cam_fwd) >= cos_half
}

/// Half-width (degrees) of the longitude arc of a latitude ring that can be on the near
/// hemisphere, centered on `cam_lon_deg`. Solves the horizon constraint
/// `cosφ(cx·cosλ − cz·sinλ) + sinφ·cy > cut` for λ. Returns None if no longitude is visible
/// (ring entirely beyond the limb), or Some(half_deg) where half_deg ∈ (0,180]. A generous
/// pad is added by the caller so the sight cone / fade band never clips the visible window.
/// Index-anchored: only used to bound iteration; emitted columns are still stride multiples.
#[inline]
fn visible_lon_half_deg(lat_deg: f32, cam_dir: Vec3, cut: f32) -> Option<f32> {
    let phi = lat_deg.to_radians();
    let (sin_phi, cos_phi) = phi.sin_cos();
    // A·cosλ + B·sinλ form, where the ring point dir is (cosφcosλ, sinφ, −cosφsinλ).
    // dot = cosφ·cx·cosλ + sinφ·cy − cosφ·cz·sinλ.
    let amp = cos_phi * (cam_dir.x * cam_dir.x + cam_dir.z * cam_dir.z).sqrt();
    let base = sin_phi * cam_dir.y;
    if amp < 1e-6 {
        // Degenerate ring (near a pole relative to cam axis): visible iff base alone clears.
        return if base > cut { Some(180.0) } else { None };
    }
    // Need base + amp·cos(λ − δ) > cut  ⇒  cos(λ − δ) > (cut − base)/amp.
    let rhs = (cut - base) / amp;
    if rhs >= 1.0 {
        None // never visible
    } else if rhs <= -1.0 {
        Some(180.0) // whole ring visible
    } else {
        Some(rhs.acos().to_degrees())
    }
}

pub fn generate(
    hf: &Heightfield,
    cam_pos: Vec3,
    cam_fwd: Vec3,
    ve_override: Option<f32>,
) -> GeometryBuffers {
    let cam_len = cam_pos.length().max(R_WORLD + 1.0);
    let cam_dir = cam_pos / cam_len;
    // Horizon plane: points with dot(P̂, cam_dir) > R/|cam| are on the near hemisphere.
    let horizon_dot = (R_WORLD / cam_len).clamp(-1.0, 1.0);
    let cam_fwd = cam_fwd.normalize_or_zero();
    let cos_half = SIGHT_HALF_ANGLE.cos();
    // Camera longitude (degrees) — the nearest point of any latitude ring lies here.
    // Matches the lon = atan2(-z, x) mapping in heightfield::sphere_point / lat_lon().
    let cam_lon_deg = (-cam_pos.z).atan2(cam_pos.x).to_degrees();

    // Altitude-coupled vertical exaggeration: dramatic from space, realistic near the
    // surface. A single global factor this frame → smooth radial scaling, no swimming
    // (lat/lon indices and distance-based LOD strides are unchanged). Only terrain ring
    // radii use `ve`; the occluder sphere and all distance/horizon math stay on real scale.
    // When a fixed exaggeration override is set, use it directly; otherwise the
    // altitude-coupled ramp.
    let ve = ve_override.unwrap_or_else(|| ve_for_altitude(cam_len - R_WORLD));

    let mut fill_verts: Vec<f32> = Vec::new();
    let mut fill_draws: Vec<u32> = Vec::new();
    let mut fill_strengths: Vec<f32> = Vec::new();
    let mut fill_elevations: Vec<f32> = Vec::new();
    let mut line_verts: Vec<f32> = Vec::new();
    let mut line_draws: Vec<u32> = Vec::new();
    let mut line_strengths: Vec<f32> = Vec::new();
    let mut line_elevations: Vec<f32> = Vec::new();

    // ── Occluder sphere (dark, hides far side via depth) ───────────────────────
    // Distance-LOD'd lat/lon tessellation. We tessellate the full sphere but choose the
    // band step and longitude step per-band from that band's distance to the camera, and
    // drop bands fully behind the horizon or outside the sight cone. Near the surface only
    // a small dense patch survives; from afar the whole hemisphere is tessellated coarsely.
    {
        // Base resolution of the occluder grid (finest). Strides subdivide this.
        let occ_lat_base = 192u32; // rings of latitude at finest
        let occ_lon_base = 192u32; // segments of longitude at finest

        // Choose the latitude band step from the distance to the band nearest the camera.
        // We walk bands at index multiples of `lat_step` so the set is index-anchored.
        let mut li = 0u32;
        while li < occ_lat_base {
            let lat_a = 90.0 - 180.0 * (li as f32) / (occ_lat_base as f32);

            // Distance / sight / horizon test along this latitude (sample a few longitudes
            // to find the nearest point of the band to the camera and whether any is visible).
            let mut nearest = f32::INFINITY;
            let mut band_visible = false;
            let probe = 16u32;
            for pj in 0..probe {
                let lon = -180.0 + 360.0 * (pj as f32) / (probe as f32);
                let p = Heightfield::sphere_point(lat_a, lon, OCCLUDER_R - R_WORLD);
                let d = (p - cam_pos).length();
                if d < nearest {
                    nearest = d;
                }
                if point_strength(p, cam_dir, horizon_dot) > 0.0
                    && in_sight(cam_pos, cam_fwd, p, cos_half)
                {
                    band_visible = true;
                }
            }

            let (lat_stride, lon_stride) = strides_for_distance(nearest);
            // occluder needs coarser-than-terrain tessellation; scale the terrain strides
            // down to the occluder grid (it's lower res to begin with).
            let lat_step = lat_stride.max(1);
            let lon_step = (lon_stride / 2).max(1);

            if !band_visible {
                li += lat_step;
                continue;
            }

            let lb = (li + lat_step).min(occ_lat_base);
            let lat_b = 90.0 - 180.0 * (lb as f32) / (occ_lat_base as f32);

            let strip_start = (fill_verts.len() / 3) as u32;
            let strip_before = fill_verts.len();
            let mut added = 0usize;
            let mut any_visible = false;

            let mut lj = 0u32;
            loop {
                let cj = lj.min(occ_lon_base);
                let lon = -180.0 + 360.0 * (cj as f32) / (occ_lon_base as f32);
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
                added += 2;
                if cj == occ_lon_base {
                    break;
                }
                lj = (lj + lon_step).min(occ_lon_base);
            }

            if any_visible {
                let count = ((fill_verts.len() - strip_before) / 3) as u32;
                fill_draws.push(strip_start);
                fill_draws.push(count);
            } else {
                fill_verts.truncate(strip_before);
                fill_strengths.truncate(fill_strengths.len() - added);
                fill_elevations.truncate(fill_elevations.len() - added);
            }

            li += lat_step;
        }
    }

    // ── Latitude rings (bright lines) ──────────────────────────────────────────
    let last_col = hf.width - 1;
    // Choose the row step per-ring from that ring's distance to the camera. We advance the
    // row index by `row_step` (index-anchored), so the set of rendered rows changes only at
    // band boundaries → no swimming. The row_step for a ring is taken from the nearest point
    // of that ring to the camera.
    let mut row = 0u32;
    while row < hf.height {
        let lat = hf.row_lat(row);

        // Distance of this ring's NEAREST point to the camera. The ring is a circle of
        // radius R·cosφ at height y=R·sinφ; its closest point lies at the camera's own
        // longitude. Computing it analytically (one sphere_point) is far cheaper than
        // probing many longitudes and is camera-deterministic → still index-anchored.
        let p = Heightfield::sphere_point(lat, cam_lon_deg, 0.0);
        let nearest = (p - cam_pos).length();
        let (row_step, ring_col_stride) = strides_for_distance(nearest);

        // Bound the longitude sweep to the arc that can be visible (horizon window widened
        // by a generous pad covering the sight cone + fade band), so we don't iterate the
        // whole far side of every near ring. The emitted columns are still stride multiples
        // (index-anchored) — the window only limits WHICH stride multiples we visit, and a
        // large pad means the window never clips terrain that should appear at the edge.
        let cut = horizon_dot - HORIZON_MARGIN;
        let visible_half = match visible_lon_half_deg(lat, cam_dir, cut) {
            None => {
                row += row_step;
                continue; // ring entirely beyond the limb
            }
            Some(h) => h,
        };
        // Pad: fade band (~a few °) + sight-cone slack. Generous — 40° beyond the geometric
        // window so panning never pops. If the whole ring is visible, skip windowing.
        let pad_deg = 40.0;
        let window_half = visible_half + pad_deg;

        // Map [cam_lon − window_half, cam_lon + window_half] to a column index range. The
        // grid spans lon_min..lon_max over 0..width-1. We iterate columns in [c0, c1] (a
        // possibly-wrapping range), snapped to stride multiples, instead of the full sweep.
        let lon_span = hf.lon_max - hf.lon_min;
        let full = window_half >= 180.0 || lon_span < 360.0 - 1e-3;
        let to_col = |lon: f32| -> i64 {
            (((lon - hf.lon_min) / lon_span) * (hf.width - 1) as f32).round() as i64
        };

        let mut run_start: Option<u32> = None;
        // Emit a single column index (already validated as within range). Returns nothing;
        // mutates the run/buffers.
        let emit = |c: u32,
                        line_verts: &mut Vec<f32>,
                        line_strengths: &mut Vec<f32>,
                        line_elevations: &mut Vec<f32>,
                        line_draws: &mut Vec<u32>,
                        run_start: &mut Option<u32>| {
            let lon = hf.col_lon(c);
            let h = hf.sample(row, c);
            let p = Heightfield::sphere_point_scaled(lat, lon, h, ve);
            let s = point_strength(p, cam_dir, horizon_dot);
            let visible = s > 0.0 && in_sight(cam_pos, cam_fwd, p, cos_half);
            if visible {
                if run_start.is_none() {
                    *run_start = Some((line_verts.len() / 3) as u32);
                }
                line_verts.extend_from_slice(&[p.x, p.y, p.z]);
                line_strengths.push(s);
                line_elevations.push(hf.elev_norm(row, c));
            } else if let Some(start) = run_start.take() {
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
        };

        // Build the ordered list of stride-aligned columns to visit.
        let stride = ring_col_stride as i64;
        if full {
            let mut col = 0u32;
            loop {
                let c = col.min(last_col);
                emit(c, &mut line_verts, &mut line_strengths, &mut line_elevations,
                    &mut line_draws, &mut run_start);
                if c == last_col {
                    break;
                }
                col = (col + ring_col_stride).min(last_col);
            }
        } else {
            // Windowed: column range around the camera longitude, snapped DOWN to a stride
            // multiple at the start so the visited indices are deterministic (anchored).
            let c_center = to_col(cam_lon_deg);
            let half_cols = (((window_half / lon_span) * (hf.width - 1) as f32).ceil() as i64)
                .max(1);
            let raw_lo = c_center - half_cols;
            let raw_hi = c_center + half_cols;
            // Snap lo down to a stride multiple (anchored to index 0).
            let lo = raw_lo.div_euclid(stride) * stride;
            let mut k = lo;
            while k <= raw_hi {
                let c = k.rem_euclid(hf.width as i64) as u32; // wrap longitude
                emit(c, &mut line_verts, &mut line_strengths, &mut line_elevations,
                    &mut line_draws, &mut run_start);
                k += stride;
            }
        }
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

        row += row_step;
    }

    GeometryBuffers {
        fill_verts, fill_draws, fill_strengths, fill_elevations,
        line_verts, line_draws, line_strengths, line_elevations,
    }
}
