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
//   hides the back side of the globe behind it. Only emitted from afar (when the globe
//   reads as a DISC); see the gate at the occluder block — at low/mid altitude the dome's
//   coarse facets would graze and tear the front-side rings, and the back side isn't in
//   frame anyway, so it is suppressed there.
//
// LOD (index-anchored, power-of-two strides → no swimming):
//   row `r` rendered iff `r % row_stride == 0`; longitude sample `c` iff `c % col_stride == 0`.
//   Strides are chosen PER-RING / PER-SEGMENT from the DISTANCE of that geometry to the
//   camera (not a single global altitude). Near the camera → fine (stride 1–2, dense lon);
//   far across the globe / near the limb → coarse. Distances are quantized into bands and
//   strides are powers of two anchored to grid index, so the rendered set changes only at
//   discrete band boundaries (nothing swims).
//
// HARD GEOMETRY BUDGET (bounds gen cost at ~constant for ANY altitude):
//   The per-distance LOD coarsens FAR geometry but never caps the TOTAL emitted vertex count,
//   so as the camera climbs and more of the hemisphere becomes visible the per-frame work
//   used to balloon (the trace's 42 ms → 208 ms climb). To bound it, ALL per-distance strides
//   are multiplied by a power-of-two global `lod_boost` chosen from the QUANTIZED camera
//   altitude (lod_boost_for_altitude): near the surface boost = 1 (full detail, budget easily
//   met); higher up the whole-frame mesh coarsens so the emitted count stays bounded (the
//   from-altitude globe is coarser — fine, you're far away). Sub-ring interpolation is forced
//   off above low altitude (subring_cap). Bands are quantized → no per-frame reselection crawl.
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

/// Occluder sphere radius — below sea level so it never z-fights ocean rings AND so the dark
/// dome can never depth-win over the bright terrain rings at ORBITAL distance, where the depth
/// buffer (Z_NEAR 1, Z_FAR 200000) has almost no resolution: a 6-wu sea-level/dome gap there
/// quantizes to the same depth and the coarse dome facets occlude the front-side rings (the
/// orbit globe read as a featureless dark disc). Pushed to 0.985 (~88 wu below sea level) so the
/// terrain rings sit comfortably nearer the camera than the dome at any altitude — the rings
/// always win the depth test and the orbital relief shows. The dome still solidly hides the far
/// hemisphere (it's a full sphere) and the inset is far below the smallest visible relief.
const OCCLUDER_R: f32 = R_WORLD * 0.985;

/// Gate (radians) for emitting the dark occluder dome: only when the globe's disc half-angle
/// asin(R/|cam|) is below this — i.e. the globe reads as a disc and the back-side rings could
/// otherwise show through. Set to the vertical half-FOV (~22.5°) plus a pad, so the dome is
/// present for the whole from-afar / disc regime but suppressed once the globe fills the view
/// (low/mid altitude), where its coarse facets would graze and tear the front-side rings.
const OCCLUDER_FOV_GATE: f32 = 0.55; // ~31.5°

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
    pub fill_indices: Vec<u32>,
    pub line_verts: Vec<f32>,
    pub line_draws: Vec<u32>,
    pub line_strengths: Vec<f32>,
    pub line_elevations: Vec<f32>,
    pub line_indices: Vec<u32>,
}

/// WebGL2 fixed primitive-restart index for UNSIGNED_INT (always enabled).
pub const RESTART_INDEX: u32 = 0xFFFF_FFFF;

impl GeometryBuffers {
    fn clear(&mut self) {
        self.fill_verts.clear();
        self.fill_draws.clear();
        self.fill_strengths.clear();
        self.fill_elevations.clear();
        self.fill_indices.clear();
        self.line_verts.clear();
        self.line_draws.clear();
        self.line_strengths.clear();
        self.line_elevations.clear();
        self.line_indices.clear();
    }
}

/// Build a single restart-delimited index list from `(start,count)` draw pairs: each strip's
/// vertex indices in order, separated by RESTART_INDEX. One `gl.drawElements(mode, …,
/// UNSIGNED_INT)` then draws every strip disconnected (WebGL2 fixed restart, always enabled).
fn build_restart_indices(draws: &[u32], out: &mut Vec<u32>) {
    out.clear();
    let mut i = 0;
    while i + 1 < draws.len() {
        let start = draws[i];
        let count = draws[i + 1];
        if i > 0 {
            out.push(RESTART_INDEX);
        }
        for v in 0..count {
            out.push(start + v);
        }
        i += 2;
    }
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
fn strides_for_distance(dist_wu: f32, boost: u32) -> (u32, u32) {
    let (r, c) = if dist_wu < 150.0 {
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
    };
    // Global LOD boost (power of two, quantized by altitude band — see lod_boost_for_altitude).
    // Multiplying BOTH strides keeps the rendered set index-anchored (still stride multiples
    // of a power of two), so coarsening to stay under budget never makes geometry swim.
    (r * boost, c * boost)
}

/// HARD GEOMETRY BUDGET — global LOD boost.
///
/// `eng.step()` cost is ~linear in the emitted vertex count, and that count grows as the
/// camera climbs (more of the hemisphere becomes visible) — the per-distance LOD coarsens
/// far geometry but never caps the TOTAL work, so a high-altitude frame emitted ~3× the
/// vertices of a low one (the trace's 42 ms → 208 ms climb). To bound the cost at ~constant
/// regardless of altitude (and of data resolution) we multiply ALL per-distance strides by a
/// power-of-two `boost` chosen from the camera ALTITUDE. Higher altitude → more visible →
/// bigger boost → coarser whole-frame mesh → roughly constant emitted vertex count.
///
/// The boost is keyed to QUANTIZED altitude bands (not a continuous function) so the rendered
/// stride set changes only at discrete boundaries — nothing crawls/shimmers as you climb.
/// Near the surface boost = 1 (detail unchanged: the budget is easily met there). The bands
/// are tuned so the worst regimes (mid-to-orbit, where the whole hemisphere is in the sight
/// cone) stay under the vertex budget; the from-altitude globe is coarser, which is fine —
/// you are far away.
#[inline]
fn lod_boost_for_altitude(alt_wu: f32) -> u32 {
    if alt_wu < 12000.0 {
        // ATMO + ORBIT: full per-distance detail (boost 1). The far view is nearly free
        // (~0.6 ms / ~7k verts at the OLD boost-4 — see docs/reports/trace-20260528.md), so
        // the old high-altitude boost OVER-COARSENED the orbital globe into a featureless
        // disc. At boost 1 the orbit view renders at the same index-anchored strides used near
        // the surface — recognizable continents with clear relief, ~80k verts / a few ms gen,
        // still bounded by the far band's own coarse (16,16) stride. ATMO is unchanged (it was
        // already boost 1 below 1500). No swimming (strides stay power-of-two index multiples).
        1
    } else {
        // INTERPLANETARY (alt > ORBIT_TOP ≈ 12000): the whole globe shrinks to a small disc,
        // so a ×2 boost keeps the from-deep-space frame cheap with no perceptible detail loss.
        2
    }
}

/// Sub-ring subdivision factor for the near-surface "Joy Division" density: how many rings
/// to render per data-row gap (1 = no subdivision). Index-anchored: the sub-ring positions
/// are fixed fractional row indices (k/factor), NOT camera-relative, so nothing swims. The
/// factor ramps DOWN with distance so the added density stays bounded — only the nearest
/// bands get extra rings; far geometry renders at the raw data rows.
#[inline]
fn subring_factor_for_distance(dist_wu: f32, cap: u32) -> u32 {
    let f = if dist_wu < 150.0 {
        4 // right under / in front of the camera: dense intermediate rings
    } else if dist_wu < 400.0 {
        3
    } else if dist_wu < 900.0 {
        2
    } else {
        1 // far: raw data rows only
    };
    // Sub-rings are only useful when skimming the surface; at mid/high altitude they are pure
    // cost (extra interpolated rings that add no readable detail from far away). The per-frame
    // `cap` (1 above low altitude) forces them off there.
    f.min(cap.max(1))
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

/// Coarsening factor for the FILL occluder relative to the LINE stations. The dark fill is
/// only a flat depth-occluder, so it can be generated far coarser in row AND column than the
/// bright lines without any visible change. Pushed slightly inward (FILL_R_INSET) so the
/// coarser mesh can never poke through / tear the finer bright lines.
const FILL_COARSEN: u32 = 3;
/// Radius multiplier for the per-ring fill occluder so a coarser fill sits a hair below the
/// bright lines (same trick as the dome's OCCLUDER_R) and cannot tear through them.
const FILL_R_INSET: f32 = 0.999;

pub fn generate_into(
    buf: &mut GeometryBuffers,
    hf: &Heightfield,
    cam_pos: Vec3,
    cam_fwd: Vec3,
    ve_override: Option<f32>,
) {
    buf.clear();
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

    // ── HARD GEOMETRY BUDGET ────────────────────────────────────────────────────
    // Global LOD boost + sub-ring cap, both keyed to the QUANTIZED camera altitude. These
    // bound the per-frame emitted vertex count to ~constant at ANY altitude (and independent
    // of data resolution): higher altitude → coarser whole-frame strides + sub-rings off, so
    // the climb no longer balloons gen time. Quantized bands → no per-frame reselection crawl.
    let altitude = cam_len - R_WORLD;
    let lod_boost = lod_boost_for_altitude(altitude);
    // Sub-ring interpolation is only worth its cost when skimming the surface; force it off
    // (cap = 1) above low altitude. Below the first LOD band keep the full near-surface density.
    let subring_cap = if altitude < 1500.0 { u32::MAX } else { 1 };

    // Reused persistent buffers (cleared above): refer to them through locals for brevity.
    let fill_verts = &mut buf.fill_verts;
    let fill_draws = &mut buf.fill_draws;
    let fill_strengths = &mut buf.fill_strengths;
    let fill_elevations = &mut buf.fill_elevations;
    let line_verts = &mut buf.line_verts;
    let line_draws = &mut buf.line_draws;
    let line_strengths = &mut buf.line_strengths;
    let line_elevations = &mut buf.line_elevations;

    // ── Occluder sphere (dark, hides far side via depth) ───────────────────────
    // Distance-LOD'd lat/lon tessellation. We tessellate the full sphere but choose the
    // band step and longitude step per-band from that band's distance to the camera, and
    // drop bands fully behind the horizon or outside the sight cone. Near the surface only
    // a small dense patch survives; from afar the whole hemisphere is tessellated coarsely.
    //
    // The dark dome is only needed when the globe reads as a DISC — i.e. when the whole
    // near hemisphere + limb sit inside the FOV and you could otherwise see the back-side
    // rings through the front. That happens only from far out. When the globe fills the
    // view (low/mid altitude, curved-horizon framing) the back hemisphere is never in
    // frame — the ridge lines already back-face cull themselves at the horizon — so the
    // dome contributes nothing but TROUBLE: its coarse faceted surface, sampled far coarser
    // than the ridge lines, crosses in front of the near-limb / near-sub-camera rings and
    // depth-culls them, tearing wedges out of the globe (the reported artifact at ~1000 km
    // and near the poles). So emit the dome only once the globe subtends less than the
    // vertical half-FOV (fits as a disc) — exactly the from-afar regime where it's needed
    // and where its facets are far from the camera and never graze the front rings.
    // Globe disc half-angle as seen from the camera = asin(R/cam_len) = asin(horizon_dot).
    // Emit the dome only when the disc fits within the gate angle (the from-afar regime).
    let disc_half_angle = horizon_dot.clamp(0.0, 1.0).asin();
    if disc_half_angle < OCCLUDER_FOV_GATE {
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

            let (lat_stride, lon_stride) = strides_for_distance(nearest, lod_boost);
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
    // Per-ring filled occlusion is active exactly where the dome is OFF (near/mid regime).
    // The dome handles the far/disc regime; here we instead fill the surface between
    // consecutive rendered (sub-)rings so near terrain solidly occludes far terrain/rings.
    let emit_fills = disc_half_angle >= OCCLUDER_FOV_GATE;
    // Choose the row step per-ring from that ring's distance to the camera. We advance the
    // row index by `row_step` (index-anchored), so the set of rendered rows changes only at
    // band boundaries → no swimming. The row_step for a ring is taken from the nearest point
    // of that ring to the camera.
    let mut row = 0u32;
    while row < hf.height {
        // Distance of this ring's NEAREST point to the camera. The ring is a circle of
        // radius R·cosφ at height y=R·sinφ; its closest point lies at the camera's own
        // longitude. Computing it analytically (one sphere_point) is far cheaper than
        // probing many longitudes and is camera-deterministic → still index-anchored.
        let p = Heightfield::sphere_point(hf.row_lat(row), cam_lon_deg, 0.0);
        let nearest = (p - cam_pos).length();
        let (row_step, ring_col_stride) = strides_for_distance(nearest, lod_boost);

        // Sub-ring subdivision: render `factor` rings across this [row, row+row_step] gap,
        // at fixed fractional indices `row + k·row_step/factor` (index-anchored → no swimming),
        // interpolating elevation between the bracketing data rows. Density ramps down with
        // distance via `subring_factor_for_distance` so the cost stays bounded.
        let factor = subring_factor_for_distance(nearest, subring_cap);
        let sub_count = factor.max(1);

        for sub in 0..sub_count {
            // Fractional row in [row, row+row_step]. The data rows bracketing it are
            // `r_lo = floor`, with interpolation fraction `frac` between r_lo and r_lo+1.
            let f_global = row as f32 + (sub as f32) * (row_step as f32) / (sub_count as f32);
            let f_global = f_global.min((hf.height - 1) as f32);
            let r_lo = f_global.floor() as u32;
            let frac = f_global - r_lo as f32;
            let lat = hf.row_lat_frac(r_lo, frac);
            emit_ring(
                hf, r_lo, frac, lat, ve, cam_pos, cam_dir, cam_fwd, horizon_dot, cos_half,
                cam_lon_deg, ring_col_stride, last_col,
                line_verts, line_strengths, line_elevations, line_draws,
            );
        }

        row += row_step;
    }

    // ── Per-ring filled occlusion (near/mid regime) ─────────────────────────────
    // Fill the surface between consecutive RAW DATA rows with a background-colored,
    // terrain-following TRIANGLE_STRIP — a flat dark depth-occluder, NOT a detail surface.
    // It is generated FAR COARSER than the bright lines (decoupled stride): no sub-ring
    // interpolation, the row step coarsened ×FILL_COARSEN, and the column stride coarsened
    // ×FILL_COARSEN. It is nudged slightly inward (FILL_R_INSET) so the coarse mesh sits a
    // hair below the bright lines and can never poke through / tear them. fill_elevations = 0
    // → drawn flat at the dark fill color (like the dome). This is the dominant vertex cut.
    if emit_fills {
        let mut frow = 0u32;
        let mut prev: Option<(u32, f32, u32)> = None; // (row, lat, col_stride)
        while frow < hf.height {
            let p = Heightfield::sphere_point(hf.row_lat(frow), cam_lon_deg, 0.0);
            let nearest = (p - cam_pos).length();
            let (row_step, ring_col_stride) = strides_for_distance(nearest, lod_boost);
            let fill_row_step = (row_step * FILL_COARSEN).max(1);
            let fill_col_stride = (ring_col_stride * FILL_COARSEN).max(1);
            let lat = hf.row_lat(frow);
            if let Some((pr, plat, pstride)) = prev {
                let stride = pstride.max(fill_col_stride);
                emit_fill_strip(
                    hf, pr, 0.0, plat, frow, 0.0, lat, ve, cam_dir, cam_fwd, cam_pos,
                    horizon_dot, cos_half, cam_lon_deg, stride, last_col,
                    fill_verts, fill_strengths, fill_elevations, fill_draws,
                );
            }
            prev = Some((frow, lat, fill_col_stride));
            frow += fill_row_step;
        }
    }

    // The `&mut buf.*` locals are no longer used past here; build the restart-delimited
    // index lists directly from the now-released draw arrays.
    let fill_draws_owned = std::mem::take(&mut buf.fill_draws);
    build_restart_indices(&fill_draws_owned, &mut buf.fill_indices);
    buf.fill_draws = fill_draws_owned;
    let line_draws_owned = std::mem::take(&mut buf.line_draws);
    build_restart_indices(&line_draws_owned, &mut buf.line_indices);
    buf.line_draws = line_draws_owned;
}

/// Emit a background-colored TRIANGLE_STRIP filling the surface between two consecutive
/// rendered rings A (`ra`+`fa`, `lat_a`) and B (`rb`+`fb`, `lat_b`), following the terrain.
/// Sweeps longitude on the SAME stride-aligned column stations as the lines (`stride`), so
/// the fill shares vertices with the ridge lines (no z-fighting / tearing). Strength per
/// vertex fades at the limb; elevation is 0 so it draws at the flat dark fill color. The
/// strip is split into runs wherever both edge vertices fall behind the horizon / out of
/// sight, so it never fills across the limb.
#[allow(clippy::too_many_arguments)]
fn emit_fill_strip(
    hf: &Heightfield,
    ra: u32,
    fa: f32,
    lat_a: f32,
    rb: u32,
    fb: f32,
    lat_b: f32,
    ve: f32,
    cam_dir: Vec3,
    cam_fwd: Vec3,
    cam_pos: Vec3,
    horizon_dot: f32,
    cos_half: f32,
    cam_lon_deg: f32,
    stride: u32,
    last_col: u32,
    fill_verts: &mut Vec<f32>,
    fill_strengths: &mut Vec<f32>,
    fill_elevations: &mut Vec<f32>,
    fill_draws: &mut Vec<u32>,
) {
    let cut = horizon_dot - HORIZON_MARGIN;
    // Visible-longitude window: union of the two rings' arcs (use the wider), padded like
    // the lines so the fill window matches what the lines emit.
    let ha = visible_lon_half_deg(lat_a, cam_dir, cut);
    let hb = visible_lon_half_deg(lat_b, cam_dir, cut);
    let visible_half = match (ha, hb) {
        (None, None) => return,
        (Some(a), Some(b)) => a.max(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
    };
    let pad_deg = 40.0;
    let window_half = visible_half + pad_deg;

    let lon_span = hf.lon_max - hf.lon_min;
    let full = window_half >= 180.0 || lon_span < 360.0 - 1e-3;
    let to_col = |lon: f32| -> i64 {
        (((lon - hf.lon_min) / lon_span) * (hf.width - 1) as f32).round() as i64
    };

    let mut run_start: Option<u32> = None;
    let mut run_added = 0usize;
    let mut run_visible = false;

    let flush = |fill_verts: &mut Vec<f32>,
                     fill_strengths: &mut Vec<f32>,
                     fill_elevations: &mut Vec<f32>,
                     fill_draws: &mut Vec<u32>,
                     run_start: &mut Option<u32>,
                     run_added: &mut usize,
                     run_visible: &mut bool| {
        if let Some(start) = run_start.take() {
            let count = (fill_verts.len() / 3) as u32 - start;
            if count >= 3 && *run_visible {
                fill_draws.push(start);
                fill_draws.push(count);
            } else {
                fill_verts.truncate((start as usize) * 3);
                fill_strengths.truncate(fill_strengths.len() - *run_added);
                fill_elevations.truncate(fill_elevations.len() - *run_added);
            }
        }
        *run_added = 0;
        *run_visible = false;
    };

    let emit_col = |c: u32,
                        fill_verts: &mut Vec<f32>,
                        fill_strengths: &mut Vec<f32>,
                        fill_elevations: &mut Vec<f32>,
                        fill_draws: &mut Vec<u32>,
                        run_start: &mut Option<u32>,
                        run_added: &mut usize,
                        run_visible: &mut bool| {
        let lon = hf.col_lon(c);
        // Nudge the fill occluder slightly inward (FILL_R_INSET) so the coarser fill mesh sits
        // a hair below the bright lines and cannot poke through / tear them.
        let pa = Heightfield::sphere_point_scaled(
            lat_a, lon, hf.sample_row_frac(ra, fa, c), ve,
        ) * FILL_R_INSET;
        let pb = Heightfield::sphere_point_scaled(
            lat_b, lon, hf.sample_row_frac(rb, fb, c), ve,
        ) * FILL_R_INSET;
        let sa = point_strength(pa, cam_dir, horizon_dot);
        let sb = point_strength(pb, cam_dir, horizon_dot);
        let vis = (sa > 0.0 && in_sight(cam_pos, cam_fwd, pa, cos_half))
            || (sb > 0.0 && in_sight(cam_pos, cam_fwd, pb, cos_half));
        if vis {
            if run_start.is_none() {
                *run_start = Some((fill_verts.len() / 3) as u32);
            }
            fill_verts.extend_from_slice(&[pa.x, pa.y, pa.z, pb.x, pb.y, pb.z]);
            fill_strengths.push(sa);
            fill_strengths.push(sb);
            fill_elevations.push(0.0);
            fill_elevations.push(0.0);
            *run_added += 2;
            *run_visible = true;
        } else {
            flush(
                fill_verts, fill_strengths, fill_elevations, fill_draws,
                run_start, run_added, run_visible,
            );
        }
    };

    if full {
        let mut col = 0u32;
        loop {
            let c = col.min(last_col);
            emit_col(
                c, fill_verts, fill_strengths, fill_elevations, fill_draws,
                &mut run_start, &mut run_added, &mut run_visible,
            );
            if c == last_col {
                break;
            }
            col = (col + stride).min(last_col);
        }
    } else {
        let c_center = to_col(cam_lon_deg);
        let half_cols = (((window_half / lon_span) * (hf.width - 1) as f32).ceil() as i64).max(1);
        let raw_lo = c_center - half_cols;
        let raw_hi = c_center + half_cols;
        let st = stride as i64;
        let lo = raw_lo.div_euclid(st) * st;
        let mut k = lo;
        while k <= raw_hi {
            let c = k.rem_euclid(hf.width as i64) as u32;
            emit_col(
                c, fill_verts, fill_strengths, fill_elevations, fill_draws,
                &mut run_start, &mut run_added, &mut run_visible,
            );
            k += st;
        }
    }
    flush(
        fill_verts, fill_strengths, fill_elevations, fill_draws,
        &mut run_start, &mut run_added, &mut run_visible,
    );
}

/// Emit one latitude ring at fractional data-row (`r0` + `frac`), latitude `lat`. Sweeps
/// longitude (windowed to the visible arc), samples interpolated elevation, applies horizon +
/// sight cull, and pushes LINE_STRIP run(s) into the line buffers.
#[allow(clippy::too_many_arguments)]
fn emit_ring(
    hf: &Heightfield,
    r0: u32,
    frac: f32,
    lat: f32,
    ve: f32,
    cam_pos: Vec3,
    cam_dir: Vec3,
    cam_fwd: Vec3,
    horizon_dot: f32,
    cos_half: f32,
    cam_lon_deg: f32,
    ring_col_stride: u32,
    last_col: u32,
    line_verts: &mut Vec<f32>,
    line_strengths: &mut Vec<f32>,
    line_elevations: &mut Vec<f32>,
    line_draws: &mut Vec<u32>,
) {
    {
        // Bound the longitude sweep to the arc that can be visible (horizon window widened
        // by a generous pad covering the sight cone + fade band), so we don't iterate the
        // whole far side of every near ring. The emitted columns are still stride multiples
        // (index-anchored) — the window only limits WHICH stride multiples we visit, and a
        // large pad means the window never clips terrain that should appear at the edge.
        let cut = horizon_dot - HORIZON_MARGIN;
        let visible_half = match visible_lon_half_deg(lat, cam_dir, cut) {
            None => return, // ring entirely beyond the limb
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
            let h = hf.sample_row_frac(r0, frac, c);
            let p = Heightfield::sphere_point_scaled(lat, lon, h, ve);
            let s = point_strength(p, cam_dir, horizon_dot);
            let visible = s > 0.0 && in_sight(cam_pos, cam_fwd, p, cos_half);
            if visible {
                if run_start.is_none() {
                    *run_start = Some((line_verts.len() / 3) as u32);
                }
                line_verts.extend_from_slice(&[p.x, p.y, p.z]);
                line_strengths.push(s);
                line_elevations.push(hf.elev_norm_frac(r0, frac, c));
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
                emit(c, line_verts, line_strengths, line_elevations,
                    line_draws, &mut run_start);
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
                emit(c, line_verts, line_strengths, line_elevations,
                    line_draws, &mut run_start);
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
    }
}
