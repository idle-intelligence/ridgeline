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
/// Cruise altitude above the sea-level sphere (wu). Above sea level, below the
/// FOV horizon limit so the planet + horizon are visible ahead in level flight.
const CRUISE_ALT: f32 = 400.0;
/// Forward cruise speed (wu/s). Seeded to match the hands-off (idle-throttle) terminal at
/// this altitude so speed stays flat with no input.
const CRUISE_SPEED: f32 = 450.0;
/// Throttle seeded at spawn. Equal to the idle/hands-off throttle so, with no input, the
/// engine already sits at the level it settles to → steady cruise from frame 1.
const CRUISE_THROTTLE: f32 = 0.30;

/// Ship spawn position: on the cruise-altitude sphere over (SPAWN_LAT, SPAWN_LON).
fn spawn_position() -> Vec3 {
    Heightfield::sphere_point(SPAWN_LAT, SPAWN_LON, CRUISE_ALT)
}

/// Level-flight orientation at spawn: up = radial (away from center), forward = the
/// tangent direction pointing NORTH along the surface (perpendicular to up). Returns
/// (forward, up) so the caller can build the basis and seed the velocity.
fn spawn_basis() -> (Vec3, Vec3) {
    let up = spawn_position().normalize();
    // North-ish tangent: project the +Y (north pole) axis onto the local tangent plane.
    let mut fwd = Vec3::Y - up * Vec3::Y.dot(up);
    if fwd.length_squared() < 1e-6 {
        // Near a pole: fall back to an eastward tangent.
        fwd = Vec3::X - up * Vec3::X.dot(up);
    }
    (fwd.normalize(), up)
}

/// Look direction at spawn: tangent (level, horizontal), pointing north.
fn spawn_look() -> Vec3 {
    spawn_basis().0
}

// Freelook clamps (radians)
const LOOK_YAW_MAX: f32 = std::f32::consts::FRAC_PI_3 * 2.0; // ±120°
const LOOK_PITCH_MAX: f32 = 1.396; // ±80°

fn chase_cam_pos(phys: &Physics) -> Vec3 {
    let cam_offset = phys.orientation * Vec3::new(0.0, CHASE_UP, CHASE_BACK);
    phys.position + cam_offset
}

fn compute_view_proj(phys: &Physics, look_yaw: f32, look_pitch: f32, aspect: f32) -> [f32; 16] {
    let cam_pos = chase_cam_pos(phys);
    let look_offset = Quat::from_rotation_y(look_yaw) * Quat::from_rotation_x(look_pitch);
    let cam_orient = phys.orientation * look_offset;
    let fwd = cam_orient * Vec3::NEG_Z;
    let up = cam_orient * Vec3::Y;
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
        water_bytes: &[u8],
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
            width, height, hf_bytes, water_bytes, elev_min, elev_max, lat_min, lat_max,
            lon_min, lon_max,
        );

        let pos = spawn_position();
        let look = spawn_look();
        let mut phys = Physics::new(pos, look);
        // Seed a stable in-atmosphere cruise: build a LEVEL orientation from the radial
        // basis (up = radial, forward = north tangent), move forward at cruise speed, and
        // seed the throttle that balances drag so speed + altitude hold without input.
        let (fwd, up) = spawn_basis();
        let view = Mat4::look_to_rh(Vec3::ZERO, fwd, up);
        let rot3 = glam::Mat3::from_mat4(view).transpose();
        phys.orientation = Quat::from_mat3(&rot3).normalize();
        phys.velocity = fwd * CRUISE_SPEED;
        phys.speed = CRUISE_SPEED;
        phys.throttle = CRUISE_THROTTLE;
        let view_proj_mat = compute_view_proj(&phys, 0.0, 0.0, ASPECT_DEFAULT);

        let cam_pos = chase_cam_pos(&phys);
        let cam_fwd = phys.orientation * Vec3::NEG_Z;
        let geom = geometry::generate(&hf, cam_pos, cam_fwd);

        Engine {
            hf,
            phys,
            geom,
            view_proj_mat,
            aspect: ASPECT_DEFAULT,
            look_yaw: 0.0,
            look_pitch: 0.0,
            i_thrust: 0.0,
            i_pitch: 0.0,
            i_yaw: 0.0,
            i_roll: 0.0,
            i_boost: 0.0,
            i_ftl: false,
        }
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
        self.phys.step(
            dt, self.i_thrust, self.i_pitch, self.i_yaw, self.i_roll, self.i_boost, self.i_ftl,
        );

        let cam_pos = chase_cam_pos(&self.phys);
        // Horizon cull is view-independent (uses cam position), so cam_fwd is unused by
        // geometry; we still pass the camera look direction for completeness.
        let look_offset =
            Quat::from_rotation_y(self.look_yaw) * Quat::from_rotation_x(self.look_pitch);
        let cam_fwd = (self.phys.orientation * look_offset) * Vec3::NEG_Z;
        self.geom = geometry::generate(&self.hf, cam_pos, cam_fwd);
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
        let cam_fwd = self.phys.orientation * Vec3::NEG_Z;
        self.geom = geometry::generate(&self.hf, cam_pos, cam_fwd);
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
        let cam_fwd = self.phys.orientation * Vec3::NEG_Z;
        self.geom = geometry::generate(&self.hf, cam_pos, cam_fwd);
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

    /// Speed in world units/sec.
    pub fn speed(&self) -> f32 {
        self.phys.speed
    }

    /// Speed in km/h. wu/s → m/s via M_PER_WU (horizontal planet scale) → km/h (×3.6).
    pub fn speed_kmh(&self) -> f32 {
        self.phys.speed * M_PER_WU * 3.6
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
