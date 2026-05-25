// Quaternion flight physics.
//
// Speed constants (world units / sec):
//   BASE_SPEED   =  60   (~normal cruise, covers terrain in ~8–16 seconds)
//   BOOST_SPEED  = 180   (Shift held)
//   FTL_SPEED    = 900   (Space-hold; streak across the whole field in ~1 s)
//
// Rotation rates (rad/s, before input clamp):
//   PITCH_RATE = 1.6, YAW_RATE = 1.6, ROLL_RATE = 2.5
//
// The input values pitch/yaw/roll are in rad/s (JS converts pointer deltas).
// We clamp them to ±PITCH_RATE etc.

use glam::{Quat, Vec3};

pub const BASE_SPEED: f32 = 60.0;
pub const BOOST_SPEED: f32 = 180.0;
pub const FTL_SPEED: f32 = 900.0;

const PITCH_RATE: f32 = 1.6;
const YAW_RATE: f32 = 1.6;
const ROLL_RATE: f32 = 2.5;

pub struct Physics {
    pub orientation: Quat, // body → world
    pub position: Vec3,
}

impl Physics {
    pub fn new(spawn_pos: Vec3, spawn_look: Vec3) -> Self {
        let fwd = spawn_look.normalize();
        // Build orientation from look direction: right = Y × fwd, up = fwd × right
        let right = Vec3::Y.cross(fwd).normalize();
        let up = fwd.cross(right);
        let orientation = Quat::from_mat3(&glam::Mat3::from_cols(right, up, -fwd)).normalize();
        Self {
            orientation,
            position: spawn_pos,
        }
    }

    /// Integrate one physics step.
    /// thrust/strafe/lift: -1..1 movement axes in body space.
    /// pitch/yaw/roll: desired rotation rates (rad/s), clamped internally.
    /// boost: 0..1, blended speed multiplier.
    /// ftl: very-fast mode.
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        dt: f32,
        thrust: f32,
        strafe: f32,
        lift: f32,
        pitch: f32,
        yaw: f32,
        roll: f32,
        boost: f32,
        ftl: bool,
    ) {
        let p = pitch.clamp(-PITCH_RATE, PITCH_RATE);
        let y = yaw.clamp(-YAW_RATE, YAW_RATE);
        let r = roll.clamp(-ROLL_RATE, ROLL_RATE);

        // Apply rotations in body space: yaw around body Y, pitch around body X, roll around body -Z
        let dq_pitch = Quat::from_axis_angle(Vec3::X, p * dt);
        let dq_yaw = Quat::from_axis_angle(Vec3::Y, y * dt);
        let dq_roll = Quat::from_axis_angle(Vec3::NEG_Z, r * dt);

        self.orientation = (self.orientation * dq_yaw * dq_pitch * dq_roll).normalize();

        let speed = if ftl {
            FTL_SPEED
        } else {
            BASE_SPEED + boost * (BOOST_SPEED - BASE_SPEED)
        };

        // Body-space movement: forward = -Z, right = +X, up = +Y
        let body_move = Vec3::new(strafe, lift, -thrust) * speed;
        self.position += (self.orientation * body_move) * dt;
    }

    /// Current speed for the given boost/ftl state (world units/sec).
    pub fn current_speed(boost: f32, ftl: bool) -> f32 {
        if ftl {
            FTL_SPEED
        } else {
            BASE_SPEED + boost * (BOOST_SPEED - BASE_SPEED)
        }
    }
}
