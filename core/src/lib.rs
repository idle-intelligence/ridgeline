mod geometry;
mod heightfield;
mod physics;

use glam::{Mat4, Quat, Vec3};
use js_sys::{Float32Array, Uint32Array};
use wasm_bindgen::prelude::*;

use geometry::GeometryBuffers;
use heightfield::{Heightfield, VE};
use physics::Physics;

// --- Camera projection constants ---
const FOV_Y_RAD: f32 = std::f32::consts::FRAC_PI_4; // 45°
const Z_NEAR: f32 = 1.0;
const Z_FAR: f32 = 120_000.0; // far plane matches max far-cull (70k wu) with headroom
const ASPECT_DEFAULT: f32 = 16.0 / 9.0;

// --- Chase camera offsets (ship-local space) ---
// Camera sits behind (+z = back) and above (+y) the ship.
// At WORLD_HALF=40000, craft reads tiny against vast terrain; wider chase distance
// so the craft is a small silhouette rather than filling the frame.
const CHASE_UP: f32 = 30.0;    // world units above ship
const CHASE_BACK: f32 = 120.0; // world units behind ship (along +z body axis)

/// Scale to apply to the normalized aircraft model (length ≈ 1.0) in world units.
/// At WORLD_HALF=40000 and CHASE_BACK=120, ~14 wu makes the craft a tiny readable speck.
pub const AIRCRAFT_SCALE: f32 = 14.0;

/// Spawn placement: in the Mediterranean just south of Sète (43.40 N, 3.70 E),
/// flying north toward the coast. Geographic point is mapped through the bbox.
const SPAWN_LAT: f32 = 43.28; // a little south of Sète, out at sea
const SPAWN_LON: f32 = 3.70;
const SPAWN_ALT: f32 = 150.0; // world units above sea level — high enough to see vast terrain

fn spawn_position(hf: &Heightfield, lat_min: f32, lat_max: f32, lon_min: f32, lon_max: f32) -> Vec3 {
    let tx = (SPAWN_LON - lon_min) / (lon_max - lon_min);
    let tz = (SPAWN_LAT - lat_min) / (lat_max - lat_min);
    let x = hf.x_min + tx * (hf.x_max - hf.x_min);
    let z = hf.z_min + tz * (hf.z_max - hf.z_min);
    Vec3::new(x, SPAWN_ALT, z)
}

/// Forward = north (+z), pitched slightly down so the coastline reads ahead.
fn spawn_look() -> Vec3 {
    Vec3::new(0.0, -0.12, 1.0).normalize()
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
    // geographic bbox (degrees)
    lat_min: f32,
    lat_max: f32,
    lon_min: f32,
    lon_max: f32,
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

        let pos = spawn_position(&hf, lat_min, lat_max, lon_min, lon_max);
        let look = spawn_look();
        let phys = Physics::new(pos, look);
        let view_proj_mat = compute_view_proj(&phys, 0.0, 0.0, ASPECT_DEFAULT);

        // Generate initial geometry so getters work before first step.
        // look_yaw/look_pitch are 0 at init, so look_offset is identity — cam_fwd = ship fwd.
        let cam_offset = phys.orientation * Vec3::new(0.0, CHASE_UP, CHASE_BACK);
        let cam_pos = phys.position + cam_offset;
        let look_offset = Quat::from_rotation_y(0.0) * Quat::from_rotation_x(0.0);
        let cam_fwd = (phys.orientation * look_offset) * Vec3::NEG_Z;
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
            lat_min,
            lat_max,
            lon_min,
            lon_max,
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
        // Use the freelook-adjusted camera forward (same orientation as compute_view_proj)
        // so the forward-cone cull matches where the camera actually points.
        let look_offset = Quat::from_rotation_y(self.look_yaw) * Quat::from_rotation_x(self.look_pitch);
        let cam_fwd = (self.phys.orientation * look_offset) * Vec3::NEG_Z;
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

    /// Per-vertex strength for fill geometry (one f32 per vertex, parallel to fill_vertices).
    /// Values in [0..1]; multiply fill color alpha by this in the fragment shader.
    /// Ramps to 0 near the far-cull boundary and at each LOD band's outer edge,
    /// eliminating pop-in and diagonal density seams. Water cells have strength = 0.
    pub fn fill_strengths(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.fill_strengths.len() as u32);
        arr.copy_from(&self.geom.fill_strengths);
        arr
    }

    /// Per-vertex normalized elevation for fill geometry (one f32 per vertex, parallel to
    /// fill_vertices). Values in [0..1] = elev_world / elev_world_max (clamped).
    /// 0 = sea level, 1 = highest peak in dataset.
    pub fn fill_elevations(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.fill_elevations.len() as u32);
        arr.copy_from(&self.geom.fill_elevations);
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

    /// Per-vertex strength for line geometry (one f32 per vertex, parallel to line_vertices).
    /// Values in [0..1]; multiply line color alpha by this in the fragment shader.
    /// Ramps to 0 near the far-cull boundary and at each LOD band's outer edge.
    /// Water cells have strength = 0.
    pub fn line_strengths(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.line_strengths.len() as u32);
        arr.copy_from(&self.geom.line_strengths);
        arr
    }

    /// Per-vertex normalized elevation for line geometry (one f32 per vertex, parallel to
    /// line_vertices). Values in [0..1] = elev_world / elev_world_max (clamped).
    /// 0 = sea level, 1 = highest peak in dataset.
    pub fn line_elevations(&self) -> Float32Array {
        let arr = Float32Array::new_with_length(self.geom.line_elevations.len() as u32);
        arr.copy_from(&self.geom.line_elevations);
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

    /// Current speed in km/h.
    ///
    /// Converts wu/s → m/s (dividing by horiz_scale) → km/h (× 3.6).
    pub fn speed_kmh(&self) -> f32 {
        self.phys.speed / self.hf.horiz_scale * 3.6
    }

    /// Altitude above terrain baseline in real meters.
    ///
    /// altitude() returns world units (meters × VE × horiz_scale);
    /// this divides out both factors to recover true meters.
    pub fn altitude_m(&self) -> f32 {
        self.altitude() / (VE * self.hf.horiz_scale)
    }

    /// Ship geographic position `[lat, lon]` in decimal degrees.
    ///
    /// Computed by inverse-mapping `phys.position` through the stored bbox:
    /// - `lon = lon_min + (pos.x - hf.x_min) / (hf.x_max - hf.x_min) * (lon_max - lon_min)`
    /// - `lat = lat_min + (pos.z - hf.z_min) / (hf.z_max - hf.z_min) * (lat_max - lat_min)`
    pub fn lat_lon(&self) -> Float32Array {
        let pos = self.phys.position;
        let lon = self.lon_min
            + (pos.x - self.hf.x_min) / (self.hf.x_max - self.hf.x_min)
                * (self.lon_max - self.lon_min);
        let lat = self.lat_min
            + (pos.z - self.hf.z_min) / (self.hf.z_max - self.hf.z_min)
                * (self.lat_max - self.lat_min);
        let arr = Float32Array::new_with_length(2);
        arr.copy_from(&[lat, lon]);
        arr
    }
}
