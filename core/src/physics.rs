// Throttle + momentum flight physics (planet scale).
//
// State: orientation (Quat), position (Vec3), throttle (0..1), speed (wu/s).
// Throttle is a gas pedal — thrust input raises/lowers it over time (THROTTLE_RATE).
// Engine thrust drives speed forward; linear drag opposes it.
//
// Planet scale: R_world = 6000 wu, m_per_wu ≈ 1062 m/wu (Earth radius / R_world).
// Terminal speeds:
//   Cruise (full throttle):  ~300 wu/s  ≈ 1.15M km/h  (orbital sightseeing pace)
//   Boost  (Shift):          ~900 wu/s
//   FTL    (Space):          ~4500 wu/s → circumnavigate fast
//
// Rotation rates (rad/s):
//   PITCH_RATE = 1.6, YAW_RATE = 1.6, ROLL_RATE = 2.5

use glam::{Mat3, Mat4, Quat, Vec3};

const MAX_THRUST: f32 = 600.0;   // wu/s² at full throttle
const DRAG: f32 = 2.0;           // s⁻¹  — terminal cruise = MAX_THRUST/DRAG = 300
const THROTTLE_RATE: f32 = 2.0;  // s⁻¹  — lag to reach target throttle
const IDLE_THROTTLE: f32 = 0.1;  // minimum throttle when no thrust input

const BOOST_SCALE: f32 = 3.0;    // terminal ~900 wu/s
const FTL_SCALE: f32 = 15.0;     // terminal ~4500 wu/s

const PITCH_RATE: f32 = 1.6;
const YAW_RATE: f32 = 1.6;
const ROLL_RATE: f32 = 2.5;

pub struct Physics {
    pub orientation: Quat,
    pub position: Vec3,
    pub throttle: f32,
    pub speed: f32,
}

impl Physics {
    pub fn new(spawn_pos: Vec3, spawn_look: Vec3) -> Self {
        let fwd = spawn_look.normalize();
        let view = Mat4::look_to_rh(Vec3::ZERO, fwd, Vec3::Y);
        let rot3 = Mat3::from_mat4(view).transpose();
        let orientation = Quat::from_mat3(&rot3).normalize();
        Self {
            orientation,
            position: spawn_pos,
            throttle: IDLE_THROTTLE,
            speed: IDLE_THROTTLE * MAX_THRUST / DRAG,
        }
    }

    /// Integrate one physics step.
    /// thrust: -1..1 throttle command (+1 = accelerate, -1 = cut).
    /// pitch/yaw/roll: desired rotation rates (rad/s), clamped internally.
    /// boost: 0..1 (Shift held = 1).
    /// ftl: Space-hold very-fast mode.
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        dt: f32,
        thrust: f32,
        pitch: f32,
        yaw: f32,
        roll: f32,
        boost: f32,
        ftl: bool,
    ) {
        // --- Rotations ---
        let p = pitch.clamp(-PITCH_RATE, PITCH_RATE);
        let y = yaw.clamp(-YAW_RATE, YAW_RATE);
        let r = roll.clamp(-ROLL_RATE, ROLL_RATE);

        let dq_pitch = Quat::from_axis_angle(Vec3::X, p * dt);
        let dq_yaw   = Quat::from_axis_angle(Vec3::Y, y * dt);
        let dq_roll  = Quat::from_axis_angle(Vec3::NEG_Z, r * dt);
        self.orientation = (self.orientation * dq_yaw * dq_pitch * dq_roll).normalize();

        // --- Throttle ---
        // When no thrust input (thrust == 0), ease to idle; otherwise follow thrust axis.
        let throttle_target = if thrust > 0.0 {
            thrust
        } else if thrust < 0.0 {
            // braking: ease throttle toward 0
            (self.throttle + thrust * dt * THROTTLE_RATE * 3.0).max(0.0)
        } else {
            IDLE_THROTTLE
        };
        self.throttle += (throttle_target - self.throttle) * (THROTTLE_RATE * dt);
        self.throttle = self.throttle.clamp(0.0, 1.0);

        // --- Speed dynamics ---
        let thrust_scale = if ftl {
            FTL_SCALE
        } else {
            1.0 + boost * (BOOST_SCALE - 1.0)
        };
        let thrust_force = self.throttle * MAX_THRUST * thrust_scale;
        let drag_force   = DRAG * self.speed;
        self.speed = (self.speed + (thrust_force - drag_force) * dt).max(0.0);

        // --- Position: velocity always along body forward (-Z) ---
        let body_vel = Vec3::new(0.0, 0.0, -self.speed);
        self.position += (self.orientation * body_vel) * dt;
    }
}
