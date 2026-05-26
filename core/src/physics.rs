// Throttle + momentum flight physics (planet scale) with ARCADE gravity + atmosphere.
//
// State: orientation (Quat), position (Vec3), throttle (0..1), velocity (Vec3).
// Throttle is a gas pedal — thrust input raises/lowers it over time (THROTTLE_RATE).
// Engine thrust pushes velocity along the craft's nose; on top of that we apply an
// ARCADE (not realistic) gravity + atmosphere model:
//
//   * Gravity: constant pull toward the planet CENTER (origin), inverse-square with
//     distance so it's strong near the surface and escapable far out.
//   * Atmosphere: air density ramps 1→0 from sea level to ATMOSPHERE_TOP, then space.
//   * Drag: within the atmosphere velocity is damped ∝ air density. In space ≈ none
//     (you coast inertially).
//   * Lift: an arcade outward push ∝ density · forward-speed, tuned so that flying
//     level at cruise throttle lift ≈ gravity → altitude holds. Pitch down → sink,
//     pitch up → climb. No lift in space.
//   * Floor: the craft cannot sink below the sea-level sphere (R_WORLD).
//
// Planet scale: R_world = 6000 wu, m_per_wu ≈ 1062 m/wu (Earth radius / R_world).
// Terminal speeds (in vacuum, gravity aside):
//   Cruise (full throttle):  ~1000 wu/s
//   FTL    (Space):          ~9000 wu/s → circumnavigate in a few seconds
//
// Rotation rates (rad/s):
//   PITCH_RATE = 1.6, YAW_RATE = 1.6, ROLL_RATE = 2.5

use glam::{Mat3, Mat4, Quat, Vec3};

use crate::heightfield::R_WORLD;

const MAX_THRUST: f32 = 2200.0;  // wu/s² at full throttle
const THROTTLE_RATE: f32 = 2.5;  // s⁻¹  — lag to reach target throttle
const IDLE_THROTTLE: f32 = 0.1;  // minimum throttle when no thrust input

const BOOST_SCALE: f32 = 3.0;    // terminal ~3000 wu/s
const FTL_SCALE: f32 = 9.0;      // terminal ~9000 wu/s — circumnavigate in a few s

const PITCH_RATE: f32 = 1.6;
const YAW_RATE: f32 = 1.6;
const ROLL_RATE: f32 = 2.5;

// ── ARCADE gravity + atmosphere model (all PLANET-DERIVED) ──────────────────────
// These are functions of the planet (R_WORLD here). Another planet with a different
// radius / atmosphere would scale them; they are deliberately small named constants
// so a future planet config can override them.

/// Surface gravitational acceleration in wu/s² (arcade, by feel). At the sea-level
/// sphere the inward pull is G_SURFACE; it falls off inverse-square with distance.
/// Tuned so cruise lift can balance it and so Shift+Space can escape it.
const G_SURFACE: f32 = 90.0;

/// Top of the atmosphere as an ALTITUDE above the sea-level sphere, in wu.
/// = R_WORLD * ATMOSPHERE_FRAC. Exaggerated terrain peaks reach ~850 wu, so the
/// atmosphere must extend well above that. 0.25 * 6000 = 1500 wu, comfortably above peaks.
const ATMOSPHERE_FRAC: f32 = 0.25;
pub const ATMOSPHERE_TOP: f32 = R_WORLD * ATMOSPHERE_FRAC;

/// Drag coefficient (s⁻¹ at sea-level density). In atmosphere velocity is damped
/// multiplicatively ∝ density; with no throttle you bleed speed, and thrust balances
/// it at a cruise terminal. Full-throttle terminal at sea level ≈ MAX_THRUST/DRAG_K
/// = 2200/2.2 ≈ 1000 wu/s. In space (density 0) drag vanishes → inertial coast.
const DRAG_K: f32 = 2.2;

/// Reference cruise speed (wu/s): the forward speed at which arcade lift reaches full
/// strength (fully cancels gravity). ≈ full-throttle sea-level terminal MAX_THRUST/DRAG_K.
const LIFT_REF_SPEED: f32 = 1000.0;

/// Max arcade-lift fraction of gravity. At full strength, lift cancels `LIFT_AUTHORITY ×
/// gravity` so level flight holds (slight <1 leaves a gentle sink so stalls feel real).
const LIFT_AUTHORITY: f32 = 1.0;

/// Radial-velocity damping rate (s⁻¹ at full strength). Implements arcade altitude-hold:
/// the wings resist vertical (radial) motion in the atmosphere so a level heading cruises
/// flat. Strong enough to hold level, weak enough that nose-up/down thrust overrides it.
const RADIAL_DAMP: f32 = 40.0;

/// Tiny epsilon above the sea-level sphere for the anti-fall-through floor (wu).
const FLOOR_EPS: f32 = 0.5;

/// Air density 1.0 at sea level → 0.0 at ATMOSPHERE_TOP (smoothstep on altitude),
/// 0 in space. `r` is distance from planet center in wu.
pub fn air_density(r: f32) -> f32 {
    let alt = r - R_WORLD;
    if alt <= 0.0 {
        return 1.0;
    }
    if alt >= ATMOSPHERE_TOP {
        return 0.0;
    }
    let t = alt / ATMOSPHERE_TOP; // 0..1
    // smoothstep(1 → 0): density high near surface, eases to 0 at the top.
    let s = t * t * (3.0 - 2.0 * t); // smoothstep 0→1
    1.0 - s
}

pub struct Physics {
    pub orientation: Quat,
    pub position: Vec3,
    pub throttle: f32,
    pub velocity: Vec3,
    /// Scalar speed (wu/s) = |velocity|, cached for the HUD.
    pub speed: f32,
}

impl Physics {
    pub fn new(spawn_pos: Vec3, spawn_look: Vec3) -> Self {
        let fwd = spawn_look.normalize();
        let view = Mat4::look_to_rh(Vec3::ZERO, fwd, Vec3::Y);
        let rot3 = Mat3::from_mat4(view).transpose();
        let orientation = Quat::from_mat3(&rot3).normalize();
        let speed = IDLE_THROTTLE * MAX_THRUST / DRAG_K;
        Self {
            orientation,
            position: spawn_pos,
            throttle: IDLE_THROTTLE,
            velocity: fwd * speed,
            speed,
        }
    }

    /// Integrate one physics step.
    /// thrust: -1..1 throttle command (+1 = accelerate, -1 = cut).
    /// pitch/yaw/roll: desired rotation rates (rad/s), clamped internally.
    /// boost: 0..1 (Shift held = 1).
    /// ftl: Space-hold afterburner.
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
        let dq_yaw = Quat::from_axis_angle(Vec3::Y, y * dt);
        let dq_roll = Quat::from_axis_angle(Vec3::NEG_Z, r * dt);
        self.orientation = (self.orientation * dq_yaw * dq_pitch * dq_roll).normalize();

        // --- Throttle ---
        let throttle_target = if thrust > 0.0 {
            thrust
        } else if thrust < 0.0 {
            (self.throttle + thrust * dt * THROTTLE_RATE * 3.0).max(0.0)
        } else {
            IDLE_THROTTLE
        };
        self.throttle += (throttle_target - self.throttle) * (THROTTLE_RATE * dt);
        self.throttle = self.throttle.clamp(0.0, 1.0);

        // --- Environment ---
        let r_dist = self.position.length().max(1e-3);
        let radial_out = self.position / r_dist; // unit vector away from center
        let density = air_density(r_dist);

        // Gravity: inverse-square inward pull. g = G_SURFACE * (R_WORLD / r)^2.
        let g = G_SURFACE * (R_WORLD / r_dist).powi(2);
        let gravity_accel = -radial_out * g;

        // --- Engine thrust along the craft's nose (-Z) ---
        let thrust_scale = if ftl {
            FTL_SCALE
        } else {
            1.0 + boost * (BOOST_SCALE - 1.0)
        };
        let nose = self.orientation * Vec3::NEG_Z;
        let thrust_accel = nose * (self.throttle * MAX_THRUST * thrust_scale);

        // --- Arcade lift: an outward push that, at full strength, CANCELS gravity so
        // level flight holds altitude. Strength scales with air density and forward speed
        // (saturating at LIFT_REF_SPEED) — slow/stalled or high in thin air → weak lift →
        // you sink. Because lift only counters gravity (it never exceeds it), the craft
        // climbs/descends according to where its NOSE (thrust) points: nose up climbs,
        // nose down descends. ---
        let fwd_speed = self.velocity.dot(nose);
        let speed_frac = (fwd_speed.max(0.0) / LIFT_REF_SPEED).clamp(0.0, 1.0);
        let lift_frac = LIFT_AUTHORITY * density * speed_frac;
        let lift_accel = radial_out * (g * lift_frac);

        // --- Integrate velocity: thrust + lift + gravity. ---
        let accel = thrust_accel + gravity_accel + lift_accel;
        self.velocity += accel * dt;

        // --- Altitude-hold: in the atmosphere the wings steer the velocity's RADIAL
        // (vertical) component toward what the NOSE commands. A level nose (nose·radial≈0)
        // commands ~0 radial velocity → holds altitude despite being above orbital speed
        // and despite the curving planet. A raised/lowered nose commands a climb/descent
        // matching the nose, so pitch directly flies you up/down. Strength ∝ density ·
        // speed-fraction; in space (density 0) it's a no-op → free ballistic flight. ---
        let radial_vel = self.velocity.dot(radial_out);
        let commanded_radial = fwd_speed * nose.dot(radial_out);
        let hold = (RADIAL_DAMP * density * speed_frac * dt).clamp(0.0, 1.0);
        self.velocity -= radial_out * ((radial_vel - commanded_radial) * hold);

        // --- Atmospheric drag: multiplicative damping ∝ density (clamped). Full-throttle
        // thrust balances it at the cruise terminal. In space (density 0) it's a no-op →
        // pure inertial coast. ---
        let damp = (1.0 - DRAG_K * density * dt).clamp(0.0, 1.0);
        self.velocity *= damp;

        // --- Integrate position ---
        self.position += self.velocity * dt;

        // --- Anti-fall-through floor: cannot sink below the sea-level sphere. ---
        let floor = R_WORLD + FLOOR_EPS;
        let new_r = self.position.length();
        if new_r < floor {
            let out = if new_r > 1e-3 {
                self.position / new_r
            } else {
                radial_out
            };
            self.position = out * floor;
            // Zero out any remaining inward radial velocity (let it slide tangentially).
            let inward = self.velocity.dot(out);
            if inward < 0.0 {
                self.velocity -= out * inward;
            }
        }

        self.speed = self.velocity.length();
    }
}

#[cfg(test)]
mod scenarios {
    use super::*;

    // Build a craft at altitude `alt` flying tangentially (level) eastward with a given speed.
    fn level_craft(alt: f32, speed: f32) -> Physics {
        let pos = Vec3::new(R_WORLD + alt, 0.0, 0.0); // on +X axis, radial = +X
        // tangential (level) direction at +X pole: +Z or -Z; pick -Z (east-ish).
        let look = Vec3::new(0.0, 0.0, -1.0);
        let mut p = Physics::new(pos, look);
        p.velocity = look * speed;
        p.speed = speed;
        p.throttle = 1.0;
        p
    }

    fn alt(p: &Physics) -> f32 {
        p.position.length() - R_WORLD
    }

    fn run(p: &mut Physics, secs: f32, thrust: f32, pitch: f32, ftl: bool) {
        let dt = 1.0 / 60.0;
        let n = (secs / dt) as usize;
        for _ in 0..n {
            p.step(dt, thrust, pitch, 0.0, 0.0, 0.0, ftl);
        }
    }

    // Simulate a pilot holding the nose on the LOCAL horizon (tangent to the sphere),
    // optionally with an extra steady pitch offset (rad above/below level). Re-levels each
    // frame, like a player keeping the craft level as it circles the globe.
    fn run_leveled(p: &mut Physics, secs: f32, thrust: f32, pitch_offset: f32, ftl: bool) {
        let dt = 1.0 / 60.0;
        let n = (secs / dt) as usize;
        for _ in 0..n {
            // Re-orient: nose = tangential (velocity projected onto the local tangent plane),
            // pitched by pitch_offset toward/away from the planet.
            let radial = p.position.normalize();
            let mut fwd = p.velocity - radial * p.velocity.dot(radial);
            if fwd.length_squared() < 1e-6 {
                fwd = (p.orientation * Vec3::NEG_Z) - radial * (p.orientation * Vec3::NEG_Z).dot(radial);
            }
            fwd = fwd.normalize();
            // pitch up = tilt nose outward (+radial)
            let nose = (fwd * pitch_offset.cos() + radial * pitch_offset.sin()).normalize();
            let view = Mat4::look_to_rh(Vec3::ZERO, nose, radial);
            let rot3 = Mat3::from_mat4(view).transpose();
            p.orientation = Quat::from_mat3(&rot3).normalize();
            p.step(dt, thrust, 0.0, 0.0, 0.0, 0.0, ftl);
        }
    }

    #[test]
    fn a_cruise_holds_altitude() {
        // Cruise speed ≈ MAX_THRUST/DRAG ≈ 1000 wu/s, full throttle, level, in atmosphere.
        let mut p = level_craft(400.0, 1000.0);
        let a0 = alt(&p);
        let mut amin = a0;
        let mut amax = a0;
        for s in 0..20 {
            run_leveled(&mut p, 1.0, 1.0, 0.0, false);
            let a = alt(&p);
            amin = amin.min(a);
            amax = amax.max(a);
            if s % 5 == 0 {
                println!("[cruise] t={}s alt={:.0} speed={:.0}", s + 1, a, p.speed);
            }
        }
        println!("[cruise] start={:.0} min={:.0} max={:.0}", a0, amin, amax);
        // Altitude should stay in a sensible band — not crash, not fly off.
        assert!(amin > 50.0, "cruise sank too far: {amin}");
        assert!(amax < ATMOSPHERE_TOP, "cruise flew off: {amax}");
        assert!(p.speed.is_finite());
    }

    #[test]
    fn b_throttle_off_sinks() {
        let mut p = level_craft(400.0, 1000.0);
        let s0 = p.speed;
        let a0 = alt(&p);
        for s in 0..15 {
            run_leveled(&mut p, 1.0, -1.0, 0.0, false);
            if s % 5 == 0 {
                println!("[coast] t={}s alt={:.0} speed={:.0}", s + 1, alt(&p), p.speed);
            }
        }
        println!("[coast] alt {:.0}->{:.0} speed {:.0}->{:.0}", a0, alt(&p), s0, p.speed);
        assert!(p.speed < s0, "throttle-off should slow down");
        assert!(alt(&p) < a0, "throttle-off should descend");
    }

    #[test]
    fn c_pitch_climbs_and_descends() {
        // Nose UP (pitch +) should climb; nose DOWN (pitch -) should descend, relative
        // to level cruise. Using engine forward.
        let mut up = level_craft(400.0, 1000.0);
        let mut down = level_craft(400.0, 1000.0);
        let mut level = level_craft(400.0, 1000.0);
        run_leveled(&mut up, 5.0, 1.0, 0.4, false);
        run_leveled(&mut down, 5.0, 1.0, -0.4, false);
        run_leveled(&mut level, 5.0, 1.0, 0.0, false);
        println!("[pitch] up={:.0} level={:.0} down={:.0}", alt(&up), alt(&level), alt(&down));
        assert!(alt(&up) > alt(&level), "nose up should climb above level");
        assert!(alt(&down) < alt(&level), "nose down should descend below level");
    }

    #[test]
    fn d_space_coasts_straight() {
        // High in space (well above ATMOSPHERE_TOP), no throttle → near-inertial coast.
        let alt0 = R_WORLD * 4.0; // r = 5*R_WORLD, gravity weak
        let pos = Vec3::new(R_WORLD + alt0, 0.0, 0.0);
        let look = Vec3::new(0.0, 0.0, -1.0);
        let mut p = Physics::new(pos, look);
        let speed = 1000.0;
        p.velocity = look * speed;
        p.speed = speed;
        let dir0 = p.velocity.normalize();
        run(&mut p, 5.0, -1.0, 0.0, false);
        let dir1 = p.velocity.normalize();
        let turn = dir0.dot(dir1).clamp(-1.0, 1.0).acos().to_degrees();
        let dspeed = (p.speed - speed).abs();
        println!("[space] speed {:.0}->{:.0} (Δ{:.1}) heading turned {:.2}°", speed, p.speed, dspeed, turn);
        assert!(turn < 5.0, "space coast curved too much: {turn}°");
        // No atmospheric drag in space: speed changes only by weak gravity doing work along
        // the slightly-curved path (a few %), not by drag. Confirm it's small.
        assert!(dspeed < 0.15 * speed, "space coast lost too much speed (drag leak?): {dspeed}");
    }

    #[test]
    fn e_shift_space_escapes() {
        // Low in the atmosphere, point straight UP (+radial), full throttle + afterburner.
        let pos = Vec3::new(R_WORLD + 100.0, 0.0, 0.0);
        let look = Vec3::new(1.0, 0.0, 0.0); // straight up (outward)
        let mut p = Physics::new(pos, look);
        for s in 0..20 {
            run(&mut p, 1.0, 1.0, 0.0, true); // thrust up + ftl (Shift+Space)
            if s % 4 == 0 {
                println!("[escape] t={}s alt={:.0} r={:.0} speed={:.0}", s + 1, alt(&p), p.position.length(), p.speed);
            }
        }
        let a = alt(&p);
        println!("[escape] final alt={:.0} (ATMOSPHERE_TOP={:.0})", a, ATMOSPHERE_TOP);
        assert!(a > ATMOSPHERE_TOP, "Shift+Space failed to escape atmosphere: {a}");
        // and still climbing (outward radial velocity positive)
        let out = p.position.normalize();
        assert!(p.velocity.dot(out) > 0.0, "not still climbing at escape");
    }

    #[test]
    fn f_floor_holds() {
        // Point straight DOWN at the surface, full throttle.
        let pos = Vec3::new(R_WORLD + 200.0, 0.0, 0.0);
        let look = Vec3::new(-1.0, 0.0, 0.0); // straight down (inward)
        let mut p = Physics::new(pos, look);
        let mut min_r = p.position.length();
        for _ in 0..600 {
            p.step(1.0 / 60.0, 1.0, 0.0, 0.0, 0.0, 0.0, true);
            min_r = min_r.min(p.position.length());
        }
        println!("[floor] min r = {:.2} (R_WORLD={:.0})", min_r, R_WORLD);
        assert!(min_r >= R_WORLD, "craft sank below the sea-level sphere: {min_r}");
        assert!(p.position.length().is_finite());
    }

    #[test]
    fn g_stable_at_dt_cap() {
        // Large dt (cap) should not blow up.
        let mut p = level_craft(400.0, 1000.0);
        for _ in 0..300 {
            p.step(0.05, 1.0, 0.0, 0.0, 0.0, 0.0, false);
            assert!(p.position.is_finite() && p.velocity.is_finite());
        }
        println!("[dtcap] alt={:.0} speed={:.0}", alt(&p), p.speed);
    }
}
