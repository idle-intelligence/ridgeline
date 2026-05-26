// Arcade flight physics (planet scale): atmosphere fly-by-nose ↔ space Newtonian.
//
// State: orientation (Quat), position (Vec3), velocity (Vec3), throttle (0..1).
//
// The model DECOUPLES speed from altitude. Two regimes, blended smoothly by air density:
//
//   * ATMOSPHERE (density high) — FLY-BY-NOSE. Throttle maps to a TARGET speed; the speed
//     eases toward it under bounded acceleration. The velocity DIRECTION is steered toward
//     where the nose points (orientation*-Z) at TURN_RATE. So the craft goes where it
//     points: a LEVEL nose ⇒ horizontal velocity ⇒ altitude held no matter the speed
//     (accelerating no longer climbs/dives). Pitch up climbs, pitch down dives. Below
//     STALL_SPEED the nose-following weakens and gravity sink dominates → you fall.
//     With no pitch/roll input the nose AUTO-LEVELS onto the local horizon (hands-off level).
//
//   * SPACE (density →0) — NEWTONIAN. velocity += gravity·dt + nose·thrust_accel·dt.
//     No fly-by-nose steering — you coast; orientation aims thrust, not velocity. Free
//     6DOF (auto-level disabled). Enables orbit and (capped) escape.
//
//   * BLEND by air density: full fly-by-nose at the surface, fully Newtonian in deep space.
//
//   * Gravity: inverse-square pull toward the origin, g = G_SURFACE·(R_WORLD/r)². Gentle in
//     atmosphere (mostly countered by flight; bites on dive/stall), dominant in space.
//
//   * HARD SPEED CAP: |velocity| (and the target speed) is clamped to V_CAP every step in
//     BOTH regimes, so thrust in vacuum can never run velocity away (the old billion-km/h bug).
//
//   * Floor: cannot sink below the sea-level sphere (R_WORLD); inward radial velocity is
//     zeroed there. No terrain collision (flying through peaks is out of scope).
//
// All tunables are named, documented constants — planet-derived where sensible so another
// planet (different R_WORLD / atmosphere) can override them.

use glam::{Mat3, Mat4, Quat, Vec3};

use crate::heightfield::R_WORLD;

// ── Rotation rates (rad/s) ───────────────────────────────────────────────────────
const PITCH_RATE: f32 = 1.6;
const YAW_RATE: f32 = 1.6;
const ROLL_RATE: f32 = 2.5;

// ── Speed tiers (wu/s). Planet circumference ≈ 2π·R_WORLD ≈ 37700 wu, so a lap at
//    CRUISE_MAX takes ~47 s, at FTL_MAX ~4.7 s — a pleasant pace, never a fraction of a
//    second. All are well under V_CAP so the HUD km/h stays bounded (tens of millions max).
/// Hands-off / zero-throttle floor speed (the engine never fully stops in atmosphere).
const IDLE_SPEED: f32 = 120.0;
/// Full-throttle terminal speed in atmosphere (no afterburner).
const CRUISE_MAX: f32 = 800.0;
/// Afterburner (Space) terminal/target speed — fast lap, still finite.
const FTL_MAX: f32 = 8000.0;
/// ABSOLUTE hard cap on |velocity| and on the target speed, enforced EVERY step in both
/// regimes. Nothing can ever exceed this — the anti-runaway guarantee. ≈ 38 million km/h at
/// planet scale (M_PER_WU·3.6·V_CAP), bounded, never billions.
const V_CAP: f32 = 10_000.0;

/// Bounded acceleration easing the current speed toward its target (wu/s²). Gives a smooth
/// spool-up/down rather than an instant snap.
const SPEED_ACCEL: f32 = 1200.0;

// ── Atmosphere ─────────────────────────────────────────────────────────────────
/// Top of the atmosphere as an ALTITUDE above the sea-level sphere (wu) = R_WORLD·FRAC.
/// 0.25·6000 = 1500 wu, comfortably above the exaggerated terrain peaks (~850 wu).
const ATMOSPHERE_FRAC: f32 = 0.25;
pub const ATMOSPHERE_TOP: f32 = R_WORLD * ATMOSPHERE_FRAC;

/// Rate (s⁻¹) at which the velocity DIRECTION is slerped toward the nose in atmosphere
/// (fly-by-nose authority). Higher = tighter, more arcade turning.
const TURN_RATE: f32 = 3.0;

/// Hands-off auto-level rate (s⁻¹): with no pitch/roll input the nose rotates toward the
/// local horizon so level cruise holds altitude over the curved planet. Atmosphere only.
const AUTO_LEVEL_RATE: f32 = 2.5;

/// Altitude-hold rate (s⁻¹): how fast the velocity DIRECTION's radial (climb/sink) component
/// is driven onto its commanded value (0 when level, nose-matched when pitched). Strong so a
/// level cruise truly pins to constant altitude as the planet curves — the core decoupling.
const ALT_HOLD_RATE: f32 = 80.0;

/// Below this forward speed (wu/s) fly-by-nose authority fades out (stall): the craft can no
/// longer hold its nose-commanded heading and gravity sink takes over → you lose altitude.
const STALL_SPEED: f32 = 180.0;

// ── Gravity ──────────────────────────────────────────────────────────────────────
/// Surface gravitational acceleration (wu/s², arcade by feel). Falls off inverse-square:
/// g = G_SURFACE·(R_WORLD/r)². Gentle enough that level cruise holds, strong enough that a
/// stall/dive sinks and that escape needs afterburner.
const G_SURFACE: f32 = 60.0;

/// Tiny epsilon above the sea-level sphere for the anti-fall-through floor (wu).
const FLOOR_EPS: f32 = 0.5;

/// Air density 1.0 at sea level → 0.0 at ATMOSPHERE_TOP (smoothstep on altitude), 0 in
/// space. `r` is distance from planet center in wu. This is the blend weight between the
/// fly-by-nose (atmosphere) and Newtonian (space) regimes.
pub fn air_density(r: f32) -> f32 {
    let alt = r - R_WORLD;
    if alt <= 0.0 {
        return 1.0;
    }
    if alt >= ATMOSPHERE_TOP {
        return 0.0;
    }
    let t = alt / ATMOSPHERE_TOP; // 0..1
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
        let speed = IDLE_SPEED;
        Self {
            orientation,
            position: spawn_pos,
            throttle: 0.0,
            velocity: fwd * speed,
            speed,
        }
    }

    /// Integrate one physics step.
    /// thrust: -1..1 throttle command (+1 = up, -1 = down, 0 = hold).
    /// pitch/yaw/roll: desired rotation rates (rad/s), clamped internally.
    /// boost: 0..1 (unused by the speed model; afterburner is `ftl`).
    /// ftl: Space-hold afterburner (raises the target speed and thrust to the FTL tier).
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        dt: f32,
        thrust: f32,
        pitch: f32,
        yaw: f32,
        roll: f32,
        _boost: f32,
        ftl: bool,
    ) {
        // Guard against a non-positive or non-finite dt (e.g. a zero/negative rAF delta on
        // the first frame), which would otherwise make `clamp(-a*dt, a*dt)` panic with
        // min > max. A bad dt is simply a no-op step.
        if dt <= 0.0 || dt.is_nan() {
            return;
        }

        // --- Rotations (body frame) ---
        let p = pitch.clamp(-PITCH_RATE, PITCH_RATE);
        let y = yaw.clamp(-YAW_RATE, YAW_RATE);
        let r = roll.clamp(-ROLL_RATE, ROLL_RATE);
        let dq_pitch = Quat::from_axis_angle(Vec3::X, p * dt);
        let dq_yaw = Quat::from_axis_angle(Vec3::Y, y * dt);
        let dq_roll = Quat::from_axis_angle(Vec3::NEG_Z, r * dt);
        self.orientation = (self.orientation * dq_yaw * dq_pitch * dq_roll).normalize();

        // --- Environment ---
        let r_dist = self.position.length().max(1e-3);
        let radial_out = self.position / r_dist; // unit, away from center
        let density = air_density(r_dist); // 1 = full atmosphere, 0 = space
        let g = G_SURFACE * (R_WORLD / r_dist).powi(2);
        let nose = self.orientation * Vec3::NEG_Z;

        // --- Hands-off auto-level (atmosphere only): with no pitch/roll input, rotate the
        // nose toward the LOCAL HORIZONTAL (velocity projected onto the tangent plane) so
        // level cruise holds altitude as the planet curves beneath. Disabled in space (free
        // 6DOF) and bypassed when the pilot is actively pitching/rolling. ---
        if density > 0.0 && pitch.abs() < 1e-3 && roll.abs() < 1e-3 {
            let mut horiz = self.velocity - radial_out * self.velocity.dot(radial_out);
            if horiz.length_squared() < 1e-6 {
                horiz = nose - radial_out * nose.dot(radial_out);
            }
            let horiz = horiz.normalize_or_zero();
            if horiz != Vec3::ZERO {
                let frac = (AUTO_LEVEL_RATE * density * dt).clamp(0.0, 1.0);
                let new_nose = nose.lerp(horiz, frac).normalize_or_zero();
                if new_nose != Vec3::ZERO {
                    let relevel = Quat::from_rotation_arc(nose, new_nose);
                    self.orientation = (relevel * self.orientation).normalize();
                }
            }
        }
        let nose = self.orientation * Vec3::NEG_Z; // refresh after auto-level

        // --- Throttle (gas pedal) ---
        let throttle_rate = 1.5; // s⁻¹
        self.throttle = (self.throttle + thrust * throttle_rate * dt).clamp(0.0, 1.0);

        // --- Target speed from throttle (hard-capped). Afterburner raises target+cap. ---
        let top = if ftl { FTL_MAX } else { CRUISE_MAX };
        let v_target = (IDLE_SPEED + (top - IDLE_SPEED) * self.throttle).min(V_CAP);

        // ===== ATMOSPHERE term: fly-by-nose =====
        // Ease scalar speed toward v_target, steer the unit velocity toward the nose, then
        // rebuild velocity = dir * speed. Stall: below STALL_SPEED the nose authority fades,
        // so the craft can't hold its heading and gravity sink dominates.
        let atmo_vel = {
            let cur = self.velocity.length();
            let dv = (v_target - cur).clamp(-SPEED_ACCEL * dt, SPEED_ACCEL * dt);
            let speed = (cur + dv).clamp(0.0, V_CAP);

            let dir_cur = if cur > 1e-3 {
                self.velocity / cur
            } else {
                nose
            };
            // Stall factor: 1 (full authority) at/above STALL_SPEED, fading to 0 as speed
            // drops to half STALL_SPEED — below that the wings can't hold the craft up.
            let stall = ((speed - 0.5 * STALL_SPEED) / (0.5 * STALL_SPEED)).clamp(0.0, 1.0);
            let turn = (TURN_RATE * stall * dt).clamp(0.0, 1.0);
            let mut dir = dir_cur.lerp(nose, turn).normalize_or(dir_cur);
            // Altitude-hold: with no pitch input, drive the direction's RADIAL (climb/sink)
            // component toward what the (auto-leveled) NOSE commands — a level nose commands
            // ~0 radial → holds altitude as the planet curves beneath; a pitched nose commands
            // a matching climb/dive. Decouples altitude from speed and kills the slow drift.
            let commanded_radial = if pitch.abs() < 1e-3 {
                0.0 // true horizontal: hold altitude exactly as the planet curves
            } else {
                nose.dot(radial_out) // pitched: climb/dive to match the nose
            };
            let cur_radial = dir.dot(radial_out);
            // Authority collapses sharply (stall³) as speed bleeds off, so a stall clearly
            // releases the altitude hold and lets gravity sink the craft, while cruise stays
            // firmly pinned.
            let auth = stall * stall * stall;
            let hold = (ALT_HOLD_RATE * auth * dt).clamp(0.0, 1.0);
            dir = (dir - radial_out * ((cur_radial - commanded_radial) * hold))
                .normalize_or(dir);
            let mut v = dir * speed;
            // Gravity sink: gravity always pulls inward; fly-by-nose mostly cancels it when
            // flying level (the steered direction has ~0 radial component), but a stall lets
            // it through (1 - auth), and a nose-down heading naturally dives via `dir`.
            v += -radial_out * (g * (1.0 - auth) * dt);
            v
        };

        // ===== SPACE term: Newtonian =====
        // velocity += gravity·dt + nose·thrust_accel·dt; capped. No direction steering.
        let space_vel = {
            let thrust_accel = (v_target - self.velocity.length()).max(0.0) / dt.max(1e-4);
            let thrust_accel = thrust_accel.min(SPEED_ACCEL * 4.0); // bounded thrust authority
            let mut v = self.velocity;
            v += -radial_out * (g * dt); // inverse-square gravity
            v += nose * (thrust_accel * dt); // thrust along the nose
            v
        };

        // --- Blend the two regimes by air density (smoothstep already applied in density) ---
        self.velocity = space_vel.lerp(atmo_vel, density);

        // --- HARD CAP: clamp |velocity| ≤ V_CAP, ALWAYS (both regimes). Anti-runaway. ---
        let spd = self.velocity.length();
        if spd > V_CAP {
            self.velocity *= V_CAP / spd;
        }

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
            let inward = self.velocity.dot(out);
            if inward < 0.0 {
                self.velocity -= out * inward; // zero inward radial velocity; slide tangent
            }
        }

        self.speed = self.velocity.length();
    }
}

#[cfg(test)]
mod scenarios {
    use super::*;

    fn alt(p: &Physics) -> f32 {
        p.position.length() - R_WORLD
    }

    // A craft at altitude `alt` flying level (tangentially) at `speed`, oriented level.
    fn level_craft(alt: f32, speed: f32, throttle: f32) -> Physics {
        let pos = Vec3::new(R_WORLD + alt, 0.0, 0.0); // radial = +X
        let up = pos.normalize();
        let fwd = Vec3::NEG_Z; // tangent at +X
        let view = Mat4::look_to_rh(Vec3::ZERO, fwd, up);
        let rot3 = Mat3::from_mat4(view).transpose();
        let mut p = Physics::new(pos, fwd);
        p.orientation = Quat::from_mat3(&rot3).normalize();
        p.velocity = fwd * speed;
        p.speed = speed;
        p.throttle = throttle;
        p
    }

    // Spawn state matching lib.rs set_spawn (level cruise).
    fn spawn_cruise() -> Physics {
        let pos = crate::heightfield::Heightfield::sphere_point(38.0, 8.0, 250.0);
        let up = pos.normalize();
        let mut fwd = Vec3::Y - up * Vec3::Y.dot(up);
        fwd = fwd.normalize();
        let view = Mat4::look_to_rh(Vec3::ZERO, fwd, up);
        let rot3 = Mat3::from_mat4(view).transpose();
        let mut p = Physics::new(pos, fwd);
        p.orientation = Quat::from_mat3(&rot3).normalize();
        // Seed at the hands-off equilibrium: throttle 0 → target IDLE..CRUISE; pick a throttle
        // whose v_target matches a sensible cruise speed and seed that speed.
        let throttle = 0.5_f32;
        let v = IDLE_SPEED + (CRUISE_MAX - IDLE_SPEED) * throttle;
        p.velocity = fwd * v;
        p.speed = v;
        p.throttle = throttle;
        p
    }

    fn run(p: &mut Physics, secs: f32, thrust: f32, pitch: f32, ftl: bool) {
        let dt = 1.0 / 60.0;
        for _ in 0..((secs / dt) as usize) {
            p.step(dt, thrust, pitch, 0.0, 0.0, 0.0, ftl);
        }
    }

    // (a) Accelerate holds altitude: ramp throttle to max for 20 s → altitude in a TIGHT band.
    #[test]
    fn a_accelerate_holds_altitude() {
        let mut p = level_craft(400.0, 400.0, 0.5);
        let a0 = alt(&p);
        let (mut amin, mut amax) = (a0, a0);
        for s in 0..20 {
            run(&mut p, 1.0, 1.0, 0.0, false); // throttle UP, no pitch
            let a = alt(&p);
            amin = amin.min(a);
            amax = amax.max(a);
            if s % 5 == 0 {
                println!("[accel] t={}s alt={:.0} speed={:.0}", s + 1, a, p.speed);
            }
        }
        println!("[accel] alt start={:.0} min={:.0} max={:.0} | final speed={:.0}", a0, amin, amax, p.speed);
        assert!((amin - a0).abs() < 80.0 && (amax - a0).abs() < 80.0, "altitude bobbed: {amin}..{amax} (start {a0})");
        assert!(p.speed > CRUISE_MAX * 0.9, "did not reach cruise cap: {}", p.speed);
        assert!(p.speed <= V_CAP);
    }

    // (b) Speed never exceeds cap: throttle + afterburner in space for 60 s.
    #[test]
    fn b_speed_capped_in_space() {
        let pos = Vec3::new(R_WORLD + R_WORLD * 5.0, 0.0, 0.0);
        let mut p = Physics::new(pos, Vec3::NEG_Z);
        p.throttle = 1.0;
        let mut vmax = 0.0_f32;
        let dt = 1.0 / 60.0;
        for i in 0..(60.0 / dt) as usize {
            p.step(dt, 1.0, 0.0, 0.0, 0.0, 0.0, true); // Shift+Space
            vmax = vmax.max(p.speed);
            assert!(p.speed <= V_CAP + 1e-2, "EXCEEDED V_CAP: {} at step {i}", p.speed);
            assert!(p.velocity.length() <= V_CAP + 1e-2);
        }
        println!("[cap] max speed over 60s = {:.1} (V_CAP={:.0})", vmax, V_CAP);
        assert!(vmax.is_finite());
    }

    // (c) Pitch: nose up climbs, nose down descends, level holds.
    #[test]
    fn c_pitch_climbs_descends() {
        let mut up = level_craft(400.0, 600.0, 0.7);
        let mut down = level_craft(400.0, 600.0, 0.7);
        let mut level = level_craft(400.0, 600.0, 0.7);
        run(&mut up, 4.0, 0.0, 0.5, false);
        run(&mut down, 4.0, 0.0, -0.5, false);
        run(&mut level, 4.0, 0.0, 0.0, false);
        println!("[pitch] up={:.0} level={:.0} down={:.0}", alt(&up), alt(&level), alt(&down));
        assert!(alt(&up) > alt(&level) + 30.0, "nose up didn't climb");
        assert!(alt(&down) < alt(&level) - 30.0, "nose down didn't descend");
        assert!((alt(&level) - 400.0).abs() < 60.0, "level didn't hold: {}", alt(&level));
    }

    // (d) Stall: throttle 0 in atmosphere → slows below stall and sinks.
    #[test]
    fn d_stall_sinks() {
        let mut p = level_craft(400.0, 600.0, 0.6);
        let a0 = alt(&p);
        for s in 0..20 {
            run(&mut p, 1.0, -1.0, 0.0, false); // throttle DOWN
            if s % 5 == 0 {
                println!("[stall] t={}s alt={:.0} speed={:.0}", s + 1, alt(&p), p.speed);
            }
        }
        println!("[stall] alt {:.0}->{:.0} speed ->{:.0} (STALL_SPEED={:.0})", a0, alt(&p), p.speed, STALL_SPEED);
        assert!(p.speed <= IDLE_SPEED + 1.0, "didn't slow to idle: {}", p.speed);
        assert!(alt(&p) < a0 - 30.0, "stall didn't sink: {} (start {a0})", alt(&p));
    }

    // (e) Space inertial: high up, no input → coasts ~straight (gravity gently curves).
    #[test]
    fn e_space_coasts() {
        let pos = Vec3::new(R_WORLD + R_WORLD * 4.0, 0.0, 0.0);
        let mut p = Physics::new(pos, Vec3::NEG_Z);
        let speed = 1000.0;
        p.velocity = Vec3::NEG_Z * speed;
        p.speed = speed;
        p.throttle = 0.0;
        let dir0 = p.velocity.normalize();
        run(&mut p, 5.0, 0.0, 0.0, false);
        let dir1 = p.velocity.normalize();
        let turn = dir0.dot(dir1).clamp(-1.0, 1.0).acos().to_degrees();
        println!("[space] speed {:.0}->{:.0} heading turned {:.2}°", speed, p.speed, turn);
        assert!(turn < 8.0, "space coast curved too hard: {turn}°");
    }

    // (f) Escape capped: Shift+Space from low, nose up → climbs to space, speed ≤ V_CAP.
    #[test]
    fn f_escape_capped() {
        let pos = Vec3::new(R_WORLD + 100.0, 0.0, 0.0);
        let look = Vec3::new(1.0, 0.0, 0.0); // straight up
        let mut p = Physics::new(pos, look);
        p.throttle = 1.0;
        let dt = 1.0 / 60.0;
        let mut vmax = 0.0_f32;
        for i in 0..(30.0 / dt) as usize {
            p.step(dt, 1.0, 0.0, 0.0, 0.0, 0.0, true);
            vmax = vmax.max(p.speed);
            assert!(p.speed <= V_CAP + 1e-2, "exceeded cap during escape: {} step {i}", p.speed);
            if i % 360 == 0 {
                println!("[escape] t={:.0}s alt={:.0} speed={:.0}", i as f32 * dt, alt(&p), p.speed);
            }
        }
        println!("[escape] final alt={:.0} (ATM_TOP={:.0}) vmax={:.0}", alt(&p), ATMOSPHERE_TOP, vmax);
        assert!(alt(&p) > ATMOSPHERE_TOP, "failed to escape: {}", alt(&p));
    }

    // (g) Hands-off cruise: spawn, no input ~20 s → altitude AND speed hold steady.
    #[test]
    fn g_hands_off_cruise() {
        let mut p = spawn_cruise();
        let a0 = alt(&p);
        let s0 = p.speed;
        let (mut amin, mut amax) = (a0, a0);
        let (mut smin, mut smax) = (s0, s0);
        let dt = 1.0 / 60.0;
        for s in 0..20 {
            for _ in 0..60 {
                p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false);
            }
            let a = alt(&p);
            amin = amin.min(a); amax = amax.max(a);
            smin = smin.min(p.speed); smax = smax.max(p.speed);
            if s % 5 == 0 {
                println!("[hands-off] t={}s alt={:.0} speed={:.0}", s + 1, a, p.speed);
            }
        }
        println!("[hands-off] alt {:.0} [{:.0},{:.0}] | speed {:.0} [{:.0},{:.0}]", a0, amin, amax, s0, smin, smax);
        assert!((amin - a0).abs() < 80.0 && (amax - a0).abs() < 80.0, "altitude drifted: {amin}..{amax}");
        assert!((smax - smin) < 60.0, "speed drifted: {smin}..{smax}");
    }

    // (h) Stability: dt=0.05 cap, long run → no NaN/blowup.
    #[test]
    fn h_stable_at_dt_cap() {
        let mut p = level_craft(400.0, 600.0, 1.0);
        for _ in 0..2000 {
            p.step(0.05, 1.0, 0.0, 0.0, 0.0, 0.0, true);
            assert!(p.position.is_finite() && p.velocity.is_finite(), "NaN/blowup");
            assert!(p.speed <= V_CAP + 1e-2);
        }
        println!("[dtcap] alt={:.0} speed={:.0}", alt(&p), p.speed);
    }
}
