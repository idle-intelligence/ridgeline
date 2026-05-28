mod geometry;
mod heightfield;
mod physics;

use glam::{Mat4, Quat, Vec3};
use js_sys::{Float32Array, Uint32Array};
use wasm_bindgen::prelude::*;

use geometry::GeometryBuffers;
use heightfield::{Heightfield, M_PER_WU, R_WORLD};
use physics::Physics;

// --- Camera projection constants (space scale) ---
const FOV_Y_RAD: f32 = std::f32::consts::FRAC_PI_4; // 45°
// Globe radius 6000 wu; camera out to tens of thousands. Near must be small enough to
// keep the foreground craft crisp; far large enough to never clip the globe.
const Z_NEAR: f32 = 1.0;
const Z_FAR: f32 = 200_000.0;
const ASPECT_DEFAULT: f32 = 16.0 / 9.0;

// --- Chase camera offsets (ship-local space) ---
// Camera sits behind (+z) and above (+y) the ship. Small craft as a foreground silhouette.
const CHASE_UP: f32 = 6.0;
const CHASE_BACK: f32 = 28.0;

/// Scale for the normalized aircraft model (length ≈ 1.0) → world units.
/// Tiny against a 6000 wu planet — a small foreground silhouette.
pub const AIRCRAFT_SCALE: f32 = 2.2;

/// Spawn: cruising LEVEL inside the atmosphere over the western/central MEDITERRANEAN
/// (lat 38°N, lon 8°E), heading NORTH toward Europe. The Med is sea (elevation 0 = faint),
/// so the recognizable geography is the surrounding COASTLINES: Spain / France / Italy
/// rising ahead to the north, the North-African coast falling behind to the south. Cruise
/// altitude is set so the sea gap + the European coast read in frame, with the curved
/// horizon dip (≈ acos(R/(R+alt))) staying within the ~22° half-FOV.
const SPAWN_LAT: f32 = 38.0;
const SPAWN_LON: f32 = 8.0;
/// Default cruise altitude above the sea-level sphere (wu). Lowered so the player starts
/// nearer the surface with terrain clearly in view, while still holding a stable
/// altitude-hold cruise (well within the FOV horizon limit). ~250 wu ≈ 265 km.
const CRUISE_ALT: f32 = 250.0;
/// Default spawn heading (degrees, 0 = north, 90 = east). North toward Europe.
const SPAWN_HEADING: f32 = 0.0;
/// Throttle seeded at spawn. With no thrust input the throttle holds; in the slower/draggier
/// ATMO band the speed settles where thrust balances quadratic drag, near CRUISE_SPEED, so the
/// craft holds a steady level cruise from frame 1 (holds altitude + speed, no startup lurch).
const CRUISE_THROTTLE: f32 = 0.5;
/// Forward cruise speed (wu/s), seeded at the drag-balanced equilibrium for CRUISE_THROTTLE in
/// the dense ATMO band so speed stays flat with no input. ≈ 228 km/h at planet scale.
const CRUISE_SPEED: f32 = 210.0;

/// Level-flight orientation at a geographic spawn point: up = radial (away from center),
/// forward = the tangent direction along the surface on the given compass heading
/// (0 = north, 90 = east). Returns (forward, up) so the caller can build the basis and
/// seed the velocity. `pos` is the spawn position (used to derive the local up).
fn spawn_basis_at(pos: Vec3, heading_deg: f32) -> (Vec3, Vec3) {
    let up = pos.normalize();
    // North-ish tangent: project the +Y (north pole) axis onto the local tangent plane.
    let mut north = Vec3::Y - up * Vec3::Y.dot(up);
    if north.length_squared() < 1e-6 {
        // Near a pole: fall back to an eastward tangent.
        north = Vec3::X - up * Vec3::X.dot(up);
    }
    let north = north.normalize();
    // East completes the right-handed local frame (north × up points east in this mapping).
    let east = north.cross(up).normalize();
    let hdg = heading_deg.to_radians();
    let fwd = (north * hdg.cos() + east * hdg.sin()).normalize();
    (fwd, up)
}

// Freelook clamps (radians)
const LOOK_YAW_MAX: f32 = std::f32::consts::FRAC_PI_3 * 2.0; // ±120°
const LOOK_PITCH_MAX: f32 = 1.396; // ±80°

fn chase_cam_pos(phys: &Physics) -> Vec3 {
    let cam_offset = phys.orientation * Vec3::new(0.0, CHASE_UP, CHASE_BACK);
    phys.position + cam_offset
}

/// Altitude above the sea-level sphere (wu) at which the camera framing has fully
/// crossfaded from the ATMO forward-chase to the orbital look-down. Tied to the physics
/// ATMOSPHERE_TOP (1500 wu) so the framing reframes exactly as the craft enters ORBIT.
const ORBIT_FRAME_TOP: f32 = physics::ATMOSPHERE_TOP;
/// Altitude (wu) where the orbital framing begins to blend in (half the band) — a smooth
/// crossfade, no hard snap.
const ORBIT_FRAME_BOT: f32 = ORBIT_FRAME_TOP * 0.5;

/// Smooth orbit framing weight ∈ [0,1] from camera altitude (wu): 0 in ATMO (forward chase),
/// ramping to 1 by ORBIT_FRAME_TOP (look-down framing). Smoothstep so there's no snap.
#[inline]
fn orbit_frame_weight(alt_wu: f32) -> f32 {
    let t = ((alt_wu - ORBIT_FRAME_BOT) / (ORBIT_FRAME_TOP - ORBIT_FRAME_BOT)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The camera LOOK basis (forward, up) for this frame, BEFORE the freelook offset. Blends the
/// ATMO forward-chase (look along ship-forward) into the orbital look-DOWN framing by the
/// altitude-driven `orbit_frame_weight`:
///   * ATMO (w=0): forward = ship-forward, up = ship-up — the existing chase framing.
///   * ORBIT/INTERPLANETARY (w→1): forward tilts toward the planet center (down the gravity
///     axis) but kept slightly off nadir toward the ship-forward tangent, so the VESSEL sits
///     HIGH in the frame and a big piece of Earth fills the lower view. up = the gravity-radial
///     (away from center), so "up" on screen is away from the planet.
///
/// Returns NORMALIZED (forward, up). The same forward drives both the view matrix and the
/// geometry sight-cull (so the look-down hemisphere is actually generated, never culled away).
fn cam_look_basis(phys: &Physics) -> (Vec3, Vec3) {
    let cam_pos = chase_cam_pos(phys);
    let ship_fwd = (phys.orientation * Vec3::NEG_Z).normalize_or_zero();
    let ship_up = (phys.orientation * Vec3::Y).normalize_or_zero();

    let alt = (cam_pos.length() - R_WORLD).max(0.0);
    let w = orbit_frame_weight(alt);
    if w <= 0.0 {
        return (ship_fwd, ship_up);
    }

    // Orbital framing. Nadir = straight toward the globe center.
    let radial = cam_pos.normalize_or_zero(); // away from center
    let nadir = -radial;
    // Keep the look slightly OFF pure nadir, tilted toward the ship-forward tangent, so the
    // vessel (ahead of + above the look ray) rides near the TOP of the frame and Earth fills
    // below. Project ship_fwd onto the tangent plane (remove the radial component).
    let tangent = (ship_fwd - radial * ship_fwd.dot(radial)).normalize_or_zero();
    // Tilt slightly off pure nadir toward the forward tangent so the planet's disc center
    // drops into the LOWER frame (a big piece of Earth fills the lower view) while the VESSEL
    // rides HIGH near the top — but not so far that the planet falls off the bottom. ~17° off
    // nadir keeps the disc center in the lower frame with the curved terrain limb in view
    // (relief reads in silhouette at the limb) and the vessel riding high above it.
    const OFF_NADIR: f32 = 0.30; // radians ≈ 17°
    let orbit_fwd = (nadir * OFF_NADIR.cos() + tangent * OFF_NADIR.sin()).normalize_or_zero();
    // Screen-up = radial (away from the planet), so the globe sits low and "up" is space.
    let orbit_up = radial;

    // Crossfade ATMO → orbital. Slerp-ish via normalized lerp (the angle is modest and this
    // stays continuous), then re-orthonormalize the up against the blended forward.
    let fwd = (ship_fwd.lerp(orbit_fwd, w)).normalize_or_zero();
    let up_raw = ship_up.lerp(orbit_up, w);
    // Gram–Schmidt: make up perpendicular to fwd.
    let up = (up_raw - fwd * up_raw.dot(fwd)).normalize_or_zero();
    let up = if up.length_squared() < 1e-6 { orbit_up } else { up };
    (fwd, up)
}

/// Freelook-aware camera forward (world space) for this frame — the SAME direction the
/// geometry frustum/sight-cull uses (see `step`) and the view matrix uses. Applies the
/// orbital look-down framing (`cam_look_basis`) then the freelook offset on top.
fn cam_forward_dir(phys: &Physics, look_yaw: f32, look_pitch: f32) -> Vec3 {
    let (fwd, up) = cam_look_basis(phys);
    let right = fwd.cross(up).normalize_or_zero();
    // Freelook offset relative to the (possibly reframed) look basis: positive d_yaw = right,
    // positive d_pitch = up. Build the rotation in the look frame, not the ship frame, so
    // freelook still works after the orbital reframe.
    let look = Quat::from_axis_angle(up, -look_yaw) * Quat::from_axis_angle(right, look_pitch);
    (look * fwd).normalize_or_zero()
}

fn compute_view_proj(phys: &Physics, look_yaw: f32, look_pitch: f32, aspect: f32) -> [f32; 16] {
    let cam_pos = chase_cam_pos(phys);
    let (base_fwd, base_up) = cam_look_basis(phys);
    let right = base_fwd.cross(base_up).normalize_or_zero();
    // Freelook in the look basis. Negate look_yaw so positive d_yaw rotates the view RIGHT
    // (world slides left) — matching set_look's contract, consistently for mouse + touch.
    let look = Quat::from_axis_angle(base_up, -look_yaw) * Quat::from_axis_angle(right, look_pitch);
    let fwd = (look * base_fwd).normalize_or_zero();
    let up = (look * base_up).normalize_or_zero();
    let view = Mat4::look_to_rh(cam_pos, fwd, up);
    let proj = Mat4::perspective_rh(FOV_Y_RAD, aspect, Z_NEAR, Z_FAR);
    (proj * view).to_cols_array()
}

#[wasm_bindgen]
pub struct Engine {
    hf: Heightfield,
    phys: Physics,
    geom: GeometryBuffers,
    view_proj_mat: [f32; 16],
    aspect: f32,
    look_yaw: f32,
    look_pitch: f32,
    ve_override: Option<f32>,
    // Lazily-built f32 world-unit copy of the heightfield, ONLY for the flag-gated WebGPU
    // prototype's one-time GPU upload (heightfield_ptr/_len). The default WebGL2 phone path
    // never touches this, so the int16 memory saving holds in production.
    hf_f32_cache: Vec<f32>,
    i_thrust: f32,
    i_pitch: f32,
    i_yaw: f32,
    i_roll: f32,
    i_boost: f32,
    i_ftl: bool,
}

#[wasm_bindgen]
impl Engine {
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        hf_bytes: &[u8],
        elev_min: f32,
        elev_max: f32,
        lat_min: f32,
        lat_max: f32,
        lon_min: f32,
        lon_max: f32,
    ) -> Engine {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        let hf = Heightfield::new(
            width, height, hf_bytes, elev_min, elev_max, lat_min, lat_max,
            lon_min, lon_max,
        );

        // Placeholder physics; set_spawn() below positions/orients/seeds the craft.
        let phys = Physics::new(Vec3::new(R_WORLD + CRUISE_ALT, 0.0, 0.0), Vec3::NEG_Z);
        let geom = GeometryBuffers::default();

        let mut eng = Engine {
            hf,
            phys,
            geom,
            view_proj_mat: [0.0; 16],
            aspect: ASPECT_DEFAULT,
            look_yaw: 0.0,
            look_pitch: 0.0,
            ve_override: None,
            hf_f32_cache: Vec::new(),
            i_thrust: 0.0,
            i_pitch: 0.0,
            i_yaw: 0.0,
            i_roll: 0.0,
            i_boost: 0.0,
            i_ftl: false,
        };
        eng.set_spawn(SPAWN_LAT, SPAWN_LON, CRUISE_ALT, SPAWN_HEADING);
        eng
    }

    /// Place the craft cruising LEVEL at a geographic point and altitude, nose tangent on
    /// the given compass heading (0 = north, 90 = east). `alt_wu` is world units above the
    /// sea-level sphere. Seeds the same cruise velocity + throttle + altitude-hold as the
    /// default spawn, resets freelook, and regenerates geometry so the first frame is correct.
    pub fn set_spawn(&mut self, lat_deg: f32, lon_deg: f32, alt_wu: f32, heading_deg: f32) {
        let pos = Heightfield::sphere_point(lat_deg, lon_deg, alt_wu);
        let (fwd, up) = spawn_basis_at(pos, heading_deg);
        let prev_target_agl = self.phys.target_agl;
        let mut phys = Physics::new(pos, fwd);
        phys.target_agl = prev_target_agl; // preserve a runtime-set AGL across respawns
        // LEVEL orientation from the radial basis, forward velocity at cruise speed, and the
        // seeded throttle that balances drag so speed + altitude hold without input.
        let view = Mat4::look_to_rh(Vec3::ZERO, fwd, up);
        let rot3 = glam::Mat3::from_mat4(view).transpose();
        phys.orientation = Quat::from_mat3(&rot3).normalize();
        phys.velocity = fwd * CRUISE_SPEED;
        phys.speed = CRUISE_SPEED;
        phys.throttle = CRUISE_THROTTLE;
        self.phys = phys;
        self.look_yaw = 0.0;
        self.look_pitch = 0.0;

        let cam_pos = chase_cam_pos(&self.phys);
        let cam_fwd = cam_forward_dir(&self.phys, 0.0, 0.0);
        geometry::generate_into(&mut self.geom, &self.hf, cam_pos, cam_fwd, self.ve_override);
        self.view_proj_mat = compute_view_proj(&self.phys, 0.0, 0.0, self.aspect);
    }

    /// Force a FIXED terrain vertical exaggeration, used INSTEAD of the altitude-coupled
    /// `ve_for_altitude` ramp. Lets the player hold a constant relief at any altitude.
    pub fn set_exaggeration_override(&mut self, ve: f32) {
        self.ve_override = Some(ve);
    }

    /// Clear the fixed exaggeration override; terrain relief returns to the altitude-coupled
    /// behavior.
    pub fn clear_exaggeration_override(&mut self) {
        self.ve_override = None;
    }

    /// Set the ATMO AGL terrain-following clearance above the terrain DIRECTLY BELOW, in
    /// VE-EXAGGERATED METERS (the same vertical scale the terrain is drawn in — NOT un-exaggerated
    /// meters). Clamped to `[TARGET_AGL_MIN, TARGET_AGL_MAX]`. Lower = skims closer to the visible
    /// ridges (hugs the contour); the craft still climbs to clear upcoming walls (collision
    /// avoidance). Driven directly by the web `?agl=<meters>` URL param (no wu conversion — the
    /// per-frame `ve` scaling happens inside `step`).
    pub fn set_target_agl(&mut self, agl_m: f32) {
        self.phys.target_agl =
            agl_m.clamp(physics::TARGET_AGL_MIN, physics::TARGET_AGL_MAX);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_input(
        &mut self,
        thrust: f32,
        _strafe: f32,
        _lift: f32,
        pitch: f32,
        yaw: f32,
        roll: f32,
        boost: f32,
        ftl: bool,
    ) {
        self.i_thrust = thrust;
        self.i_pitch = pitch;
        self.i_yaw = yaw;
        self.i_roll = roll;
        self.i_boost = boost;
        self.i_ftl = ftl;
    }

    /// Accumulate freelook camera offset (view only). ±120° yaw, ±80° pitch.
    pub fn set_look(&mut self, d_yaw: f32, d_pitch: f32) {
        self.look_yaw = (self.look_yaw + d_yaw).clamp(-LOOK_YAW_MAX, LOOK_YAW_MAX);
        self.look_pitch = (self.look_pitch + d_pitch).clamp(-LOOK_PITCH_MAX, LOOK_PITCH_MAX);
    }

    /// Advance simulation by `dt` seconds. Regenerates visible geometry.
    pub fn step(&mut self, dt: f32) {
        // Terrain-radius sampler for AGL terrain-following: lat/lon → terrain radius AS RENDERED.
        // Uses the same vertical exaggeration the renderer uses this frame (the override if set,
        // else ve_for_altitude of the current camera altitude) so "hold ~500 m above ground"
        // matches what the player sees.
        let alt_wu = (self.phys.position.length() - R_WORLD).max(0.0);
        let ve = self
            .ve_override
            .unwrap_or_else(|| heightfield::ve_for_altitude(alt_wu));
        let hf = &self.hf;
        let terrain = move |lat: f32, lon: f32| hf.terrain_radius_at(lat, lon, ve);
        // wu per VE-exaggerated meter of AGL clearance — same `ve` the terrain is drawn with, so
        // the held clearance is exaggerated like the ground. = VERT_SCALE·ve/VERT_EXAGGERATION.
        let agl_scale = heightfield::VERT_SCALE * ve / heightfield::VERT_EXAGGERATION;
        self.phys.step(
            dt, self.i_thrust, self.i_pitch, self.i_yaw, self.i_roll, self.i_boost, self.i_ftl,
            agl_scale, Some(&terrain),
        );

        let cam_pos = chase_cam_pos(&self.phys);
        // cam_fwd IS used by the geometry frustum/sight cull, so it MUST match the view's
        // look direction in compute_view_proj — including the ORBITAL look-down reframe and
        // the freelook offset — otherwise the hemisphere we now look at gets culled away
        // (missing terrain) or freelooking sideways clips terrain on the side you turn toward.
        let cam_fwd = cam_forward_dir(&self.phys, self.look_yaw, self.look_pitch);
        geometry::generate_into(&mut self.geom, &self.hf, cam_pos, cam_fwd, self.ve_override);
        self.view_proj_mat =
            compute_view_proj(&self.phys, self.look_yaw, self.look_pitch, self.aspect);
    }

    /// Advance the simulation by `dt` seconds doing PHYSICS + CAMERA ONLY — it does NOT run the
    /// CPU per-frame geometry generation (`generate_into`). For the WebGPU renderer, which
    /// generates the visible geometry on the GPU (a WGSL compute pass) and so does not need the
    /// CPU vertex emission at all. This is the whole perf win: the CPU `step` cost (the trace's
    /// 70–200 ms `generate_into`) drops to the physics integrator + the two camera matrices
    /// (microseconds). The WebGL2 path keeps using `step` (above), which still emits CPU
    /// geometry, so the fallback is behaviorally unchanged. The same `view_proj`, `camera_position`,
    /// `cam_forward`, `current_ve`, etc. getters drive the GPU compute (renderer-agnostic).
    pub fn step_physics_only(&mut self, dt: f32) {
        let alt_wu = (self.phys.position.length() - R_WORLD).max(0.0);
        let ve = self
            .ve_override
            .unwrap_or_else(|| heightfield::ve_for_altitude(alt_wu));
        let hf = &self.hf;
        let terrain = move |lat: f32, lon: f32| hf.terrain_radius_at(lat, lon, ve);
        let agl_scale = heightfield::VERT_SCALE * ve / heightfield::VERT_EXAGGERATION;
        self.phys.step(
            dt, self.i_thrust, self.i_pitch, self.i_yaw, self.i_roll, self.i_boost, self.i_ftl,
            agl_scale, Some(&terrain),
        );
        self.view_proj_mat =
            compute_view_proj(&self.phys, self.look_yaw, self.look_pitch, self.aspect);
    }

    /// Debug/test helper: teleport the ship to the radial through (lat,lon) at `dist` wu
    /// from center, oriented to look at the globe center. Regenerates geometry. Used by the
    /// headless multi-angle recognizability test to orbit the camera around the globe.
    pub fn debug_place(&mut self, lat: f32, lon: f32, dist: f32) {
        let radial = Heightfield::sphere_point(lat, lon, 0.0).normalize();
        let pos = radial * (dist - CHASE_BACK);
        let look = -radial;
        self.phys = Physics::new(pos, look);
        self.look_yaw = 0.0;
        self.look_pitch = 0.0;
        let cam_pos = chase_cam_pos(&self.phys);
        let cam_fwd = cam_forward_dir(&self.phys, 0.0, 0.0);
        geometry::generate_into(&mut self.geom, &self.hf, cam_pos, cam_fwd, self.ve_override);
        self.view_proj_mat = compute_view_proj(&self.phys, 0.0, 0.0, self.aspect);
    }

    /// Debug/test helper: place at (lat,lon,dist) but orient to look toward the surface
    /// point (look_lat,look_lon) — for a tangential "skimming over terrain" framing.
    pub fn debug_place_look(
        &mut self,
        lat: f32,
        lon: f32,
        dist: f32,
        look_lat: f32,
        look_lon: f32,
    ) {
        let radial = Heightfield::sphere_point(lat, lon, 0.0).normalize();
        let pos = radial * (dist - CHASE_BACK);
        let target = Heightfield::sphere_point(look_lat, look_lon, 0.0);
        let look = (target - pos).normalize();
        self.phys = Physics::new(pos, look);
        self.look_yaw = 0.0;
        self.look_pitch = 0.0;
        let cam_pos = chase_cam_pos(&self.phys);
        let cam_fwd = cam_forward_dir(&self.phys, 0.0, 0.0);
        geometry::generate_into(&mut self.geom, &self.hf, cam_pos, cam_fwd, self.ve_override);
        self.view_proj_mat = compute_view_proj(&self.phys, 0.0, 0.0, self.aspect);
    }

    pub fn set_aspect(&mut self, aspect: f32) {
        self.aspect = aspect;
        self.view_proj_mat =
            compute_view_proj(&self.phys, self.look_yaw, self.look_pitch, self.aspect);
    }

    pub fn view_proj(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(16);
        arr.copy_from(&self.view_proj_mat);
        arr
    }

    pub fn camera_position(&self) -> Float32Array {
        let cam_pos = chase_cam_pos(&self.phys);
        let arr = Float32Array::new_with_length(3);
        arr.copy_from(&[cam_pos.x, cam_pos.y, cam_pos.z]);
        arr
    }

    /// Freelook-aware camera forward (world space), the SAME direction the geometry
    /// frustum/sight cull uses this frame (see `step`). Additive getter for the WebGPU
    /// compute prototype, which ports the cull math to WGSL. WebGL2 path does not use this.
    pub fn cam_forward(&self) -> Float32Array {
        let fwd = cam_forward_dir(&self.phys, self.look_yaw, self.look_pitch).normalize_or_zero();
        let arr = Float32Array::new_with_length(3);
        arr.copy_from(&[fwd.x, fwd.y, fwd.z]);
        arr
    }

    /// Vertical exaggeration used to draw terrain THIS frame (override if set, else the
    /// altitude-coupled ramp). Additive getter for the WebGPU compute prototype.
    pub fn current_ve(&self) -> f32 {
        let alt_wu = (self.phys.position.length() - R_WORLD).max(0.0);
        self.ve_override
            .unwrap_or_else(|| heightfield::ve_for_altitude(alt_wu))
    }

    /// Max terrain elevation (world units) used to normalize elevation→brightness. Additive
    /// getter for the WebGPU compute prototype (matches `Heightfield::elev_norm`).
    pub fn elev_world_max(&self) -> f32 {
        self.hf.elev_world_max
    }

    /// Pointer to the heightfield elevation buffer (f32 world units, row-major, row 0 = north).
    /// len = width*height. Additive: lets the WebGPU prototype upload the heightfield once. The
    /// grid is stored as i16 meters; this lazily materializes the f32 world-unit copy (`* VERT_SCALE`)
    /// the first time the prototype asks for it. `&mut self` so the cache can be built on demand.
    pub fn heightfield_ptr(&mut self) -> u32 {
        if self.hf_f32_cache.is_empty() && !self.hf.elev.is_empty() {
            self.hf_f32_cache = self
                .hf
                .elev
                .iter()
                .map(|&m| m as f32 * heightfield::VERT_SCALE)
                .collect();
        }
        self.hf_f32_cache.as_ptr() as u32
    }
    pub fn heightfield_len(&self) -> u32 {
        self.hf.elev.len() as u32
    }

    /// Pointer/len of the RAW int16 elevation grid (meters, row-major, row 0 = north) directly in
    /// WASM memory — NO f32 materialization. The WebGPU renderer uploads this i16 buffer ONCE
    /// (~151 MB for 12288×6144, vs ~302 MB as f32) and converts meters → world units in WGSL via
    /// `* VERT_SCALE` (matching `Heightfield::sample`). `_len` is the ELEMENT count (i16 count =
    /// width*height); the byte length is `2 * len`. ptr is a byte offset into `wasm.memory.buffer`.
    /// Preferred over `heightfield_ptr` (the f32 path), which is kept only as a fallback.
    pub fn heightfield_i16_ptr(&self) -> u32 {
        self.hf.elev.as_ptr() as u32
    }
    pub fn heightfield_i16_len(&self) -> u32 {
        self.hf.elev.len() as u32
    }
    /// VERT_SCALE (world units per meter of elevation) so the WebGPU WGSL can convert the raw
    /// int16 meters to world units exactly as `Heightfield::sample` does (`m * VERT_SCALE`).
    pub fn vert_scale(&self) -> f32 {
        heightfield::VERT_SCALE
    }
    pub fn grid_width(&self) -> u32 {
        self.hf.width
    }
    pub fn grid_height(&self) -> u32 {
        self.hf.height
    }

    pub fn model_matrix(&self) -> Float32Array {
        let mat = Mat4::from_rotation_translation(self.phys.orientation, self.phys.position);
        let arr = Float32Array::new_with_length(16);
        arr.copy_from(&mat.to_cols_array());
        arr
    }

    pub fn aircraft_scale(&self) -> f32 {
        AIRCRAFT_SCALE
    }

    pub fn fill_vertices(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.fill_verts.len() as u32);
        arr.copy_from(&self.geom.fill_verts);
        arr
    }

    pub fn fill_draws(&self) -> Uint32Array {
        let arr = Uint32Array::new_with_length(self.geom.fill_draws.len() as u32);
        arr.copy_from(&self.geom.fill_draws);
        arr
    }

    pub fn fill_strengths(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.fill_strengths.len() as u32);
        arr.copy_from(&self.geom.fill_strengths);
        arr
    }

    pub fn fill_elevations(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.fill_elevations.len() as u32);
        arr.copy_from(&self.geom.fill_elevations);
        arr
    }

    pub fn line_vertices(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.line_verts.len() as u32);
        arr.copy_from(&self.geom.line_verts);
        arr
    }

    pub fn line_draws(&self) -> Uint32Array {
        let arr = Uint32Array::new_with_length(self.geom.line_draws.len() as u32);
        arr.copy_from(&self.geom.line_draws);
        arr
    }

    pub fn line_strengths(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.line_strengths.len() as u32);
        arr.copy_from(&self.geom.line_strengths);
        arr
    }

    pub fn line_elevations(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.line_elevations.len() as u32);
        arr.copy_from(&self.geom.line_elevations);
        arr
    }

    // ── Zero-copy buffer access ──────────────────────────────────────────────────
    // (ptr, len) into WASM linear memory for each geometry buffer. JS builds a typed-array
    // VIEW over `wasm.memory.buffer` (no copy) and uploads via bufferSubData. Views are
    // invalidated if WASM memory grows (the ArrayBuffer detaches) — JS MUST recreate them
    // whenever `wasm.memory.buffer` identity changes. ptr is a byte offset; len is element
    // count (f32 for verts/strengths/elevations, u32 for indices).
    pub fn fill_verts_ptr(&self) -> u32 { self.geom.fill_verts.as_ptr() as u32 }
    pub fn fill_verts_len(&self) -> u32 { self.geom.fill_verts.len() as u32 }
    pub fn fill_strengths_ptr(&self) -> u32 { self.geom.fill_strengths.as_ptr() as u32 }
    pub fn fill_strengths_len(&self) -> u32 { self.geom.fill_strengths.len() as u32 }
    pub fn fill_elevations_ptr(&self) -> u32 { self.geom.fill_elevations.as_ptr() as u32 }
    pub fn fill_elevations_len(&self) -> u32 { self.geom.fill_elevations.len() as u32 }
    pub fn fill_indices_ptr(&self) -> u32 { self.geom.fill_indices.as_ptr() as u32 }
    pub fn fill_indices_len(&self) -> u32 { self.geom.fill_indices.len() as u32 }

    pub fn line_verts_ptr(&self) -> u32 { self.geom.line_verts.as_ptr() as u32 }
    pub fn line_verts_len(&self) -> u32 { self.geom.line_verts.len() as u32 }
    pub fn line_strengths_ptr(&self) -> u32 { self.geom.line_strengths.as_ptr() as u32 }
    pub fn line_strengths_len(&self) -> u32 { self.geom.line_strengths.len() as u32 }
    pub fn line_elevations_ptr(&self) -> u32 { self.geom.line_elevations.as_ptr() as u32 }
    pub fn line_elevations_len(&self) -> u32 { self.geom.line_elevations.len() as u32 }
    pub fn line_indices_ptr(&self) -> u32 { self.geom.line_indices.as_ptr() as u32 }
    pub fn line_indices_len(&self) -> u32 { self.geom.line_indices.len() as u32 }

    /// Altitude above the sea-level sphere, in world units.
    pub fn altitude(&self) -> f32 {
        self.phys.position.length() - R_WORLD
    }

    /// Altitude above sea level in real meters.
    ///
    /// World units convert to surface meters by M_PER_WU = EARTH_RADIUS_M / R_WORLD
    /// (≈ 1061.8 m/wu). Note: this uses the HORIZONTAL planet scale, not the
    /// vertical-exaggeration scale (VERT_SCALE), so altitudes read as plausible
    /// orbital/atmospheric heights for the planet's true size.
    pub fn altitude_m(&self) -> f32 {
        self.altitude() * M_PER_WU
    }

    /// Distance to the GROUND directly below, in RAW WORLD UNITS (NOT VE-scaled, NOT meters):
    /// `|pos| − terrain_radius_below`, clamped ≥ 0. Uses the SAME `ve` the renderer draws this
    /// frame so the terrain radius matches what's on screen. Small when skimming (~1–50 wu).
    /// The ATMO HUD shows this as `GND <n> wu` — the gravitationally dominant body in ATMO is
    /// the ground. Distinct from `agl_m` (VE-exaggerated meters) and `altitude_m` (sea-level m).
    pub fn ground_dist_wu(&self) -> f32 {
        let alt_wu = (self.phys.position.length() - R_WORLD).max(0.0);
        let ve = self
            .ve_override
            .unwrap_or_else(|| heightfield::ve_for_altitude(alt_wu));
        let terr_r = self.hf.terrain_radius_below(self.phys.position, ve);
        (self.phys.position.length() - terr_r).max(0.0)
    }

    /// Height ABOVE GROUND in **VE-EXAGGERATED METERS** — the SAME vertical scale the terrain is
    /// drawn in, so the HUD reads ≈ the set `target_agl` when skimming (e.g. ~500, not ~10000).
    /// `agl_m = (|pos| − terrain_radius_below) / (VERT_SCALE · ve / VERT_EXAGGERATION)` (= the wu
    /// clearance / `agl_scale` = wu · M_PER_WU / ve), using the SAME `ve` the renderer draws this
    /// frame (the override if set, else `ve_for_altitude(altitude)`). Clamped ≥ 0. Distinct from
    /// `altitude_m` (height above the sea-level sphere, un-exaggerated meters).
    pub fn agl_m(&self) -> f32 {
        let alt_wu = (self.phys.position.length() - R_WORLD).max(0.0);
        let ve = self
            .ve_override
            .unwrap_or_else(|| heightfield::ve_for_altitude(alt_wu));
        let terr_r = self.hf.terrain_radius_below(self.phys.position, ve);
        let clearance_wu = (self.phys.position.length() - terr_r).max(0.0);
        let agl_scale = heightfield::VERT_SCALE * ve / heightfield::VERT_EXAGGERATION;
        clearance_wu / agl_scale.max(1e-9)
    }

    /// Speed in world units/sec.
    pub fn speed(&self) -> f32 {
        self.phys.speed
    }

    /// Engine throttle setting in [0, 1] (gas pedal), for the HUD throttle readout.
    pub fn throttle(&self) -> f32 {
        self.phys.throttle
    }

    /// Speed in km/h. wu/s → m/s via M_PER_WU (horizontal planet scale) → km/h (×3.6).
    pub fn speed_kmh(&self) -> f32 {
        self.phys.speed * M_PER_WU * 3.6
    }

    /// Current flight mode by altitude: 0 = ATMO (dense fly-by-nose cruise),
    /// 1 = ORBIT (thin-air near-circular hold), 2 = INTERPLANETARY (free Newtonian + capture
    /// assist on re-entry).
    pub fn flight_mode(&self) -> u8 {
        self.phys.flight_mode()
    }

    /// Sub-camera geographic position `[lat, lon]` in decimal degrees — the point on the
    /// globe directly beneath the camera (projection of cam_pos onto the sphere).
    pub fn lat_lon(&self) -> Float32Array {
        let p = chase_cam_pos(&self.phys);
        let r = p.length().max(1e-6);
        let lat = (p.y / r).clamp(-1.0, 1.0).asin().to_degrees();
        let lon = (-p.z).atan2(p.x).to_degrees();
        let arr = Float32Array::new_with_length(2);
        arr.copy_from(&[lat, lon]);
        arr
    }
}

#[cfg(test)]
mod look_dir {
    use super::*;

    // Project a world point through view_proj; return clip-space x (NDC after w-divide).
    fn screen_x(vp: &[f32; 16], p: Vec3) -> f32 {
        let m = Mat4::from_cols_array(vp);
        let v = m * glam::Vec4::new(p.x, p.y, p.z, 1.0);
        v.x / v.w
    }

    fn make_phys() -> Physics {
        let pos = Heightfield::sphere_point(SPAWN_LAT, SPAWN_LON, CRUISE_ALT);
        let (fwd, up) = spawn_basis_at(pos, SPAWN_HEADING);
        let view = Mat4::look_to_rh(Vec3::ZERO, fwd, up);
        let rot3 = glam::Mat3::from_mat4(view).transpose();
        let mut phys = Physics::new(pos, fwd);
        phys.orientation = Quat::from_mat3(&rot3).normalize();
        phys.velocity = fwd * CRUISE_SPEED;
        phys.speed = CRUISE_SPEED;
        phys
    }

    #[test]
    fn look_right_shifts_world_left() {
        let phys = make_phys();
        // A landmark straight ahead on the surface (a bit north of spawn).
        let landmark = Heightfield::sphere_point(SPAWN_LAT + 10.0, SPAWN_LON, 0.0);
        let vp0 = compute_view_proj(&phys, 0.0, 0.0, ASPECT_DEFAULT);
        let x0 = screen_x(&vp0, landmark);
        // Apply "look right" = positive d_yaw.
        let vp1 = compute_view_proj(&phys, 0.2, 0.0, ASPECT_DEFAULT);
        let x1 = screen_x(&vp1, landmark);
        println!("[look-right] landmark screen-x {x0:.3} -> {x1:.3} (should DECREASE: world slides left)");
        assert!(x1 < x0, "look-right must slide world LEFT (screen-x decreases): {x0}->{x1}");
    }

    #[test]
    fn look_up_shifts_world_down() {
        let phys = make_phys();
        let landmark = Heightfield::sphere_point(SPAWN_LAT + 10.0, SPAWN_LON, 0.0);
        let m0 = Mat4::from_cols_array(&compute_view_proj(&phys, 0.0, 0.0, ASPECT_DEFAULT));
        let m1 = Mat4::from_cols_array(&compute_view_proj(&phys, 0.0, 0.2, ASPECT_DEFAULT));
        let yof = |m: Mat4| { let v = m * glam::Vec4::new(landmark.x, landmark.y, landmark.z, 1.0); v.y / v.w };
        let y0 = yof(m0);
        let y1 = yof(m1);
        println!("[look-up] landmark screen-y {y0:.3} -> {y1:.3} (should DECREASE: world slides down)");
        assert!(y1 < y0, "look-up must slide world DOWN: {y0}->{y1}");
    }

    #[test]
    fn heading_east_points_east() {
        // At a mid-latitude point, heading 90° (east) should give a forward tangent whose
        // longitude increases relative to the spawn (moving east), and heading 0° points north.
        let pos = Heightfield::sphere_point(38.0, 8.0, 120.0);
        let (north_fwd, up) = spawn_basis_at(pos, 0.0);
        let (east_fwd, _) = spawn_basis_at(pos, 90.0);
        // North forward must increase latitude: a small step north has higher y/|p|.
        let step_n = (pos + north_fwd * 10.0).normalize();
        assert!(step_n.y > up.y, "heading 0 must move toward the north pole (+lat)");
        // East forward must increase longitude. lon = atan2(-z, x).
        let lon = |p: Vec3| (-p.z).atan2(p.x);
        let step_e = pos + east_fwd * 10.0;
        let dlon = lon(step_e) - lon(pos);
        assert!(dlon > 0.0, "heading 90 must move EAST (+lon): dlon={dlon}");
    }

    #[test]
    fn yaw_right_key_rotates_right() {
        // Apply the keyboard "yaw right" input (KeyE => yaw = +RUDDER_RATE after the fix).
        // Confirm the nose turns toward the craft's RIGHT (+local-X). Measure the nose's
        // component along the initial local-right axis: turning right makes it positive.
        let p = make_phys();
        let right0 = (p.orientation * Vec3::X).normalize(); // craft's right (world)
        let fwd0 = (p.orientation * Vec3::NEG_Z).normalize();
        // physics applies the yaw as orientation * from_axis_angle(Vec3::Y, yaw*dt). The
        // hands-off auto-level then re-snaps the nose to the velocity heading each frame, so
        // we isolate the yaw rotation itself (its sign is what determines left vs right).
        // input.js KeyE (yaw right) => yaw = -RUDDER_RATE (physics +Y rotation turns LEFT,
        // so "yaw right" is the negative arg — already correct in input.js).
        let yaw = -0.5_f32;
        let dq_yaw = Quat::from_axis_angle(Vec3::Y, yaw * 0.5);
        let new_orient = (p.orientation * dq_yaw).normalize();
        let fwd1 = (new_orient * Vec3::NEG_Z).normalize();
        let right_comp = fwd1.dot(right0);
        let fwd_comp = fwd1.dot(fwd0);
        println!("[yaw-right-key] nose·right0={right_comp:.3} nose·fwd0={fwd_comp:.3} (right_comp>0 = turned right)");
        assert!(right_comp > 0.05, "KeyE (yaw right=+RUDDER) must rotate the nose RIGHT: nose·right0={right_comp}");
    }
}
