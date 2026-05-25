mod geometry;
mod heightfield;
mod physics;

use glam::{Mat4, Quat, Vec3};
use js_sys::{Float32Array, Uint32Array};
use wasm_bindgen::prelude::*;

use geometry::GeometryBuffers;
use heightfield::Heightfield;
use physics::Physics;

// --- Camera projection constants ---
const FOV_Y_RAD: f32 = std::f32::consts::FRAC_PI_4; // 45°
const Z_NEAR: f32 = 1.0;
const Z_FAR: f32 = 40000.0;
const ASPECT_DEFAULT: f32 = 16.0 / 9.0;

// --- Chase camera offsets (ship-local space) ---
// Camera sits behind (+z = back) and above (+y) the ship.
const CHASE_UP: f32 = 5.0;     // world units above ship
const CHASE_BACK: f32 = 25.0;  // world units behind ship (along +z body axis)

/// Scale to apply to the normalized aircraft model (length ≈ 1.0) in world units.
/// A value of 8.0 makes the craft ~8 wu tip-to-tail, clearly visible at chase distance.
pub const AIRCRAFT_SCALE: f32 = 8.0;

/// Spawn camera placement:
///   - Near south edge of terrain, above max elevation + 100 wu.
///   - Looking toward the center-north so the Alps fill the horizon.
fn spawn_position(hf: &Heightfield) -> Vec3 {
    let z = hf.z_min + (hf.z_max - hf.z_min) * 0.1;
    let y = hf.elev_world_max + 100.0;
    Vec3::new(0.0, y, z)
}

fn spawn_look(hf: &Heightfield) -> Vec3 {
    let pos = spawn_position(hf);
    let mid_elev = hf.elev_world_min + (hf.elev_world_max - hf.elev_world_min) * 0.5;
    let target = Vec3::new(0.0, mid_elev, hf.z_max * 0.8);
    (target - pos).normalize()
}

// Freelook clamps (radians)
const LOOK_YAW_MAX: f32 = std::f32::consts::FRAC_PI_3 * 2.0;  // ±120°
const LOOK_PITCH_MAX: f32 = 1.396;                              // ±80°

fn compute_view_proj(phys: &Physics, look_yaw: f32, look_pitch: f32, aspect: f32) -> [f32; 16] {
    // Chase camera: position is behind and above the ship in ship-local space.
    let cam_offset = phys.orientation * Vec3::new(0.0, CHASE_UP, CHASE_BACK);
    let cam_pos = phys.position + cam_offset;

    // View direction: ship orientation + freelook offset.
    let look_offset = Quat::from_rotation_y(look_yaw) * Quat::from_rotation_x(look_pitch);
    let cam_orient = phys.orientation * look_offset;
    let fwd = cam_orient * Vec3::NEG_Z;
    let up  = cam_orient * Vec3::Y;

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
    // freelook camera offset (view only, does not affect flight physics)
    look_yaw: f32,
    look_pitch: f32,
    // pending inputs (set_input → step)
    i_thrust: f32,
    i_pitch: f32,
    i_yaw: f32,
    i_roll: f32,
    i_boost: f32,
    i_ftl: bool,
}

#[wasm_bindgen]
impl Engine {
    /// Construct the engine.
    ///
    /// - `width`, `height`: grid dimensions (from meta.json)
    /// - `hf_bytes`: raw int16 LE, len = width*height*2
    /// - `water_bytes`: u8 0/1, len = width*height
    /// - `elev_min`, `elev_max`: meters
    /// - `lat_min`, `lat_max`, `lon_min`, `lon_max`: degrees
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
            width, height, hf_bytes, water_bytes,
            elev_min, elev_max,
            lat_min, lat_max, lon_min, lon_max,
        );

        let pos = spawn_position(&hf);
        let look = spawn_look(&hf);
        let phys = Physics::new(pos, look);
        let view_proj_mat = compute_view_proj(&phys, 0.0, 0.0, ASPECT_DEFAULT);

        // Generate initial geometry so getters work before first step
        let cam_offset = phys.orientation * Vec3::new(0.0, CHASE_UP, CHASE_BACK);
        let cam_pos = phys.position + cam_offset;
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

    /// Set per-frame input axes. Call before `step`.
    ///
    /// - `thrust`: f32 -1..1  throttle up/down
    /// - `_strafe`: unused (pass 0)
    /// - `_lift`:   unused (pass 0)
    /// - `pitch`:  f32 rad/s  mouse-Y + keys
    /// - `yaw`:    f32 rad/s  mouse-X + rudder keys
    /// - `roll`:   f32 rad/s  A/D keys
    /// - `boost`:  f32 0..1   Shift = boost
    /// - `ftl`:    bool       Space-hold = FTL
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

    /// Accumulate freelook camera offset from pointer-lock mouse deltas.
    ///
    /// `d_yaw`: positive = look right (radians), `d_pitch`: positive = look up (radians).
    /// Offsets are clamped to ±120° yaw and ±80° pitch; they persist across frames.
    /// Physics/velocity are unaffected — only the view matrix changes.
    pub fn set_look(&mut self, d_yaw: f32, d_pitch: f32) {
        self.look_yaw = (self.look_yaw + d_yaw).clamp(-LOOK_YAW_MAX, LOOK_YAW_MAX);
        self.look_pitch = (self.look_pitch + d_pitch).clamp(-LOOK_PITCH_MAX, LOOK_PITCH_MAX);
    }

    /// Advance simulation by `dt` seconds. Regenerates visible geometry.
    pub fn step(&mut self, dt: f32) {
        self.phys.step(
            dt,
            self.i_thrust,
            self.i_pitch, self.i_yaw, self.i_roll,
            self.i_boost, self.i_ftl,
        );

        let cam_offset = self.phys.orientation * Vec3::new(0.0, CHASE_UP, CHASE_BACK);
        let cam_pos = self.phys.position + cam_offset;
        let cam_fwd = self.phys.orientation * Vec3::NEG_Z;
        self.geom = geometry::generate(&self.hf, cam_pos, cam_fwd);
        self.view_proj_mat = compute_view_proj(&self.phys, self.look_yaw, self.look_pitch, self.aspect);
    }

    /// Set viewport aspect ratio (width / height). Call on init and on resize.
    pub fn set_aspect(&mut self, aspect: f32) {
        self.aspect = aspect;
        self.view_proj_mat = compute_view_proj(&self.phys, self.look_yaw, self.look_pitch, self.aspect);
    }

    /// Column-major proj*view matrix (16 f32). Pass directly to gl.uniformMatrix4fv.
    pub fn view_proj(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(16);
        arr.copy_from(&self.view_proj_mat);
        arr
    }

    /// Camera world position [x, y, z] — chase-cam position, behind and above ship.
    pub fn camera_position(&self) -> Float32Array {
        let cam_offset = self.phys.orientation * Vec3::new(0.0, CHASE_UP, CHASE_BACK);
        let cam_pos = self.phys.position + cam_offset;
        let arr = Float32Array::new_with_length(3);
        arr.copy_from(&[cam_pos.x, cam_pos.y, cam_pos.z]);
        arr
    }

    /// Column-major model matrix (16 f32) for the aircraft mesh.
    ///
    /// = translate(ship_position) * rotate(ship_orientation)
    ///
    /// Does NOT bake AIRCRAFT_SCALE — web multiplies vertices by `eng.aircraft_scale()`
    /// when building the scaled mesh, keeping model_matrix pure position+rotation.
    pub fn model_matrix(&self) -> Float32Array {
        let mat = Mat4::from_rotation_translation(self.phys.orientation, self.phys.position);
        let arr = Float32Array::new_with_length(16);
        arr.copy_from(&mat.to_cols_array());
        arr
    }

    /// Scale factor for the normalized aircraft model (nose-to-tail ≈ 1 wu → world units).
    pub fn aircraft_scale(&self) -> f32 {
        AIRCRAFT_SCALE
    }

    /// Packed fill triangle-strip vertices [x,y,z, ...].
    pub fn fill_vertices(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.fill_verts.len() as u32);
        arr.copy_from(&self.geom.fill_verts);
        arr
    }

    /// Fill draw list: flat [start, count, ...] vertex-index pairs, back-to-front.
    pub fn fill_draws(&self) -> Uint32Array {
        let arr = Uint32Array::new_with_length(self.geom.fill_draws.len() as u32);
        arr.copy_from(&self.geom.fill_draws);
        arr
    }

    /// Packed ridge line-strip vertices [x,y,z, ...].
    pub fn line_vertices(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.line_verts.len() as u32);
        arr.copy_from(&self.geom.line_verts);
        arr
    }

    /// Line draw list: flat [start, count, ...] vertex-index pairs, back-to-front.
    pub fn line_draws(&self) -> Uint32Array {
        let arr = Uint32Array::new_with_length(self.geom.line_draws.len() as u32);
        arr.copy_from(&self.geom.line_draws);
        arr
    }

    /// Altitude above terrain baseline (world units).
    pub fn altitude(&self) -> f32 {
        self.phys.position.y - self.hf.elev_world_min
    }

    /// Current speed (world units/sec).
    pub fn speed(&self) -> f32 {
        self.phys.speed
    }
}
