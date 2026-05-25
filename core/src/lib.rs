mod geometry;
mod heightfield;
mod physics;

use glam::{Mat4, Vec3};
use js_sys::{Float32Array, Uint32Array};
use wasm_bindgen::prelude::*;

use geometry::GeometryBuffers;
use heightfield::Heightfield;
use physics::Physics;

// --- Camera projection constants ---
const FOV_Y_RAD: f32 = std::f32::consts::FRAC_PI_4; // 45°
const Z_NEAR: f32 = 0.5;
const Z_FAR: f32 = 4000.0;
const ASPECT: f32 = 16.0 / 9.0;

/// Spawn camera placement:
///   - Near south edge of terrain (z = z_min + 10% of span), above max elevation + 40 wu.
///   - Looking toward the center-north, slightly downward, so the Alps fill the horizon.
fn spawn_position(hf: &Heightfield) -> Vec3 {
    let z = hf.z_min + (hf.z_max - hf.z_min) * 0.1;
    let y = hf.elev_world_max + 40.0;
    Vec3::new(0.0, y, z)
}

fn spawn_look(hf: &Heightfield) -> Vec3 {
    let pos = spawn_position(hf);
    let mid_elev = hf.elev_world_min + (hf.elev_world_max - hf.elev_world_min) * 0.5;
    let target = Vec3::new(0.0, mid_elev, hf.z_max * 0.8);
    (target - pos).normalize()
}

fn compute_view_proj(phys: &Physics) -> [f32; 16] {
    let fwd = phys.orientation * Vec3::NEG_Z;
    let up = phys.orientation * Vec3::Y;
    let view = Mat4::look_to_rh(phys.position, fwd, up);
    let proj = Mat4::perspective_rh(FOV_Y_RAD, ASPECT, Z_NEAR, Z_FAR);
    (proj * view).to_cols_array()
}

#[wasm_bindgen]
pub struct Engine {
    hf: Heightfield,
    phys: Physics,
    geom: GeometryBuffers,
    view_proj_mat: [f32; 16],
    // pending inputs (set_input → step)
    i_thrust: f32,
    i_strafe: f32,
    i_lift: f32,
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
        let view_proj_mat = compute_view_proj(&phys);

        // Generate initial geometry so getters work before first step
        let cam_fwd = phys.orientation * Vec3::NEG_Z;
        let geom = geometry::generate(&hf, phys.position, cam_fwd);

        Engine {
            hf,
            phys,
            geom,
            view_proj_mat,
            i_thrust: 0.0,
            i_strafe: 0.0,
            i_lift: 0.0,
            i_pitch: 0.0,
            i_yaw: 0.0,
            i_roll: 0.0,
            i_boost: 0.0,
            i_ftl: false,
        }
    }

    /// Set per-frame input axes. Call before `step`.
    ///
    /// - `thrust`: f32 -1..1  forward/back
    /// - `strafe`: f32 -1..1  left/right
    /// - `lift`:   f32 -1..1  down/up
    /// - `pitch`:  f32 rad/s  mouse-Y + keys
    /// - `yaw`:    f32 rad/s  mouse-X + keys
    /// - `roll`:   f32 rad/s  A/E keys
    /// - `boost`:  f32 0..1   Shift = accelerate
    /// - `ftl`:    bool       Space-hold = very fast
    #[allow(clippy::too_many_arguments)]
    pub fn set_input(
        &mut self,
        thrust: f32,
        strafe: f32,
        lift: f32,
        pitch: f32,
        yaw: f32,
        roll: f32,
        boost: f32,
        ftl: bool,
    ) {
        self.i_thrust = thrust;
        self.i_strafe = strafe;
        self.i_lift = lift;
        self.i_pitch = pitch;
        self.i_yaw = yaw;
        self.i_roll = roll;
        self.i_boost = boost;
        self.i_ftl = ftl;
    }

    /// Advance simulation by `dt` seconds. Regenerates visible geometry.
    pub fn step(&mut self, dt: f32) {
        self.phys.step(
            dt,
            self.i_thrust, self.i_strafe, self.i_lift,
            self.i_pitch, self.i_yaw, self.i_roll,
            self.i_boost, self.i_ftl,
        );

        let cam_fwd = self.phys.orientation * Vec3::NEG_Z;
        self.geom = geometry::generate(&self.hf, self.phys.position, cam_fwd);
        self.view_proj_mat = compute_view_proj(&self.phys);
    }

    /// Column-major proj*view matrix (16 f32). Pass directly to gl.uniformMatrix4fv.
    pub fn view_proj(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(16);
        arr.copy_from(&self.view_proj_mat);
        arr
    }

    /// Camera world position [x, y, z].
    pub fn camera_position(&self) -> Float32Array {
        let p = self.phys.position;
        let arr = Float32Array::new_with_length(3);
        arr.copy_from(&[p.x, p.y, p.z]);
        arr
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

    /// Current speed (world units/sec) based on active boost/ftl state.
    pub fn speed(&self) -> f32 {
        Physics::current_speed(self.i_boost, self.i_ftl)
    }
}
