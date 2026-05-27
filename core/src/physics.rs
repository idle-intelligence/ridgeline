// Arcade flight physics (planet scale): THREE crossfaded modes — ATMO / ORBIT / INTERPLANETARY.
//
// State: orientation (Quat), position (Vec3), velocity (Vec3), throttle (0..1).
//
// The model DECOUPLES speed from altitude. Three named modes, derived from altitude and
// crossfaded by smoothstep blends so transitions are SEAMLESS (no discrete switch — only the
// HUD label flips at a boundary; the physics is continuous):
//
//   * ATMO (alt 0..ATMOSPHERE_TOP) — slow + DENSE/DRAGGY, FLY-BY-NOSE. Throttle maps to a
//     TARGET speed (IDLE_SPEED..CRUISE_MAX); QUADRATIC DRAG (∝ density·v²) opposes velocity so
//     the top speed is asymptotic and cutting throttle bleeds speed in ~2–3 s ("hard to leave"
//     feel). The velocity DIRECTION is steered toward the nose at TURN_RATE; a LEVEL nose holds
//     altitude no matter the speed, pitch climbs/dives, below STALL_SPEED the wings give up.
//     Hands-off the nose AUTO-LEVELS onto the local horizon. (AGL terrain-following is the NEXT
//     task — for now the level altitude-hold drives the radial command to 0, a clean seam.)
//
//   * ORBIT (alt ~ATMOSPHERE_TOP..ORBIT_TOP) — faster, thin air (low drag), speed envelope
//     ~ORBIT_IDLE..ORBIT_CAP. A critically-damped RADIAL SPRING gently holds the craft toward
//     its current altitude (near-circular hold) — easy to raise/lower with pitch, and the spring
//     FADES OUT toward ORBIT_TOP so pointing out + accelerating climbs freely to INTERPLANETARY
//     (never a prison). Still fly-by-nose steered (thin-air authority).
//
//   * INTERPLANETARY (alt > ORBIT_TOP) — free NEWTONIAN inertia + inverse-square gravity, up to
//     the hard V_CAP. No fly-by-nose steering — you coast; orientation aims thrust. The existing
//     CAPTURE-ZONE assist eases a returning ship back down (INTERPLANETARY → ORBIT re-entry).
//
//   * PER-MODE SPEED CAPS are crossfaded by smoothstep across the band boundaries: ATMO_CAP →
//     ORBIT_CAP → V_CAP (ratio ≈ 1 : 7.5 : 25). The effective cap blends continuously, no jump.
//
//   * BANKING TURNS: roll couples into yaw (yaw_rate += BANK_GAIN·sin(bank)·(speed/CRUISE_MAX))
//     in ATMO/ORBIT, so rolling banks you into a coordinated turn — reads as "a plane."
//
//   * Gravity: inverse-square pull toward the origin, g = G_SURFACE·(R_WORLD/r)². Gentle in
//     atmosphere (mostly countered by flight; bites on dive/stall), dominant in space.
//
//   * HARD SPEED CAP: |velocity| is clamped to V_CAP every step, so thrust in vacuum can never
//     run velocity away (the old billion-km/h bug).
//
//   * Floor: cannot sink below the sea-level sphere (R_WORLD); inward radial velocity is
//     zeroed there. No terrain collision (flying through peaks is out of scope).
//
// All tunables are named, documented constants — planet-derived where sensible so another
// planet (different R_WORLD / atmosphere) can override them.

use glam::{Mat3, Mat4, Quat, Vec3};

use crate::heightfield::R_WORLD;

/// smoothstep 0→1 over [edge0, edge1] (clamped). Shared transition curve.
fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// ── Rotation rates (rad/s) ───────────────────────────────────────────────────────
const PITCH_RATE: f32 = 1.6;
const YAW_RATE: f32 = 1.6;
const ROLL_RATE: f32 = 2.5;

// ── Speed tiers (wu/s). Planet circumference ≈ 2π·R_WORLD ≈ 37700 wu. Per-mode caps are
//    crossfaded by altitude (ATMO_CAP → ORBIT_CAP → V_CAP, ratio ≈ 1 : 7.5 : 25).
/// Hands-off / zero-throttle floor speed in ATMO (the engine never fully stops in atmosphere).
/// Comfortably ABOVE STALL_SPEED so a zero-throttle LEVEL cruise holds altitude — slow flight
/// never sinks; only a forced crawl below STALL_SPEED does. Slower than before (denser atmo).
const IDLE_SPEED: f32 = 30.0;
/// Full-throttle terminal speed in ATMO (the asymptotic top of the dense band).
const CRUISE_MAX: f32 = 400.0;
/// ORBIT-band idle (zero-throttle) speed — thin air, much faster than ATMO.
const ORBIT_IDLE: f32 = 1000.0;
/// ORBIT-band full-throttle ceiling.
const ORBIT_CAP: f32 = 3000.0;
/// Afterburner (INTERPLANETARY) terminal/target speed — fast lap, still finite.
const FTL_MAX: f32 = 8000.0;
/// ABSOLUTE hard cap on |velocity| and on the target speed, enforced EVERY step in all
/// modes. Nothing can ever exceed this — the anti-runaway guarantee. ≈ 38 million km/h at
/// planet scale (M_PER_WU·3.6·V_CAP), bounded, never billions.
const V_CAP: f32 = 10_000.0;

/// Bounded acceleration easing the current speed toward its target (wu/s²). Gives a smooth
/// spool-up/down rather than an instant snap.
const SPEED_ACCEL: f32 = 1200.0;

/// Throttle ramp rate (s⁻¹): how fast holding Shift/Ctrl moves the throttle 0..1. DELIBERATELY
/// slow so a tap nudges the cruise speed a little and the pilot can hold any intermediate
/// setting (granular regulation), rather than snapping between idle and full.
const THROTTLE_RATE: f32 = 0.3;

// ── Atmosphere ─────────────────────────────────────────────────────────────────
/// Top of the atmosphere as an ALTITUDE above the sea-level sphere (wu) = R_WORLD·FRAC.
/// 0.25·6000 = 1500 wu, comfortably above the exaggerated terrain peaks (~850 wu). The
/// ATMO/ORBIT boundary.
const ATMOSPHERE_FRAC: f32 = 0.25;
pub const ATMOSPHERE_TOP: f32 = R_WORLD * ATMOSPHERE_FRAC;

/// Top of the ORBIT band as an ALTITUDE above the sea-level sphere (wu) = R_WORLD·2 = 12000.
/// The ORBIT/INTERPLANETARY boundary: above this the radial spring has fully faded and you are
/// in free Newtonian flight.
pub const ORBIT_TOP: f32 = R_WORLD * 2.0;

/// Quadratic atmospheric drag coefficient (1/wu): a_drag = DRAG_K · density · speed² opposing
/// velocity. Tuned so full-throttle ATMO tops out asymptotically near CRUISE_MAX and cutting
/// throttle bleeds speed to idle in ~2–3 s — the "dense, hard to leave" feel.
const DRAG_K: f32 = 0.0085;

/// ORBIT-band altitude-hold rate (s⁻¹): a GENTLE version of ALT_HOLD_RATE that curves the
/// velocity to follow the sphere (near-circular hold) without the dense-atmosphere stiffness, so
/// the orbit holds loosely yet is easy to raise/lower with pitch. Crossfades from ALT_HOLD_RATE
/// (ATMO) to this by orbit_w. Much smaller than ALT_HOLD_RATE = forgiving, no bob.
const ORBIT_HOLD_RATE: f32 = 30.0;

/// Coordinated-banking gain: rolling to a bank angle induces a yaw rate
/// yaw += BANK_GAIN · sin(bank) · clamp(speed/CRUISE_MAX, 0, 1) in ATMO/ORBIT, so a roll banks
/// the craft into a turn (reads as "a plane"). Subtle.
const BANK_GAIN: f32 = 0.9;

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

// ── AGL terrain-following (ATMO) ──────────────────────────────────────────────────
/// Target clearance ABOVE GROUND the AGL controller holds in ATMO, in **VE-EXAGGERATED METERS**
/// — the SAME vertical scale the terrain is DRAWN in.
///
/// SCALE FIX: the terrain is rendered VERTICALLY EXAGGERATED — its radius is
/// `R_WORLD + elev_m · VERT_SCALE · (ve/VERT_EXAGGERATION)`, so a 4808 m alp rises ~12.5 wu at
/// near-surface `ve`. The OLD AGL stored a clearance in un-exaggerated wu (`agl_wu = m/M_PER_WU`),
/// so "500 m" was 0.47 wu — far below the visible ridges. We now express the clearance in the
/// terrain's OWN exaggerated vertical scale and convert per-frame with the LIVE `ve`:
///   `agl_wu = clearance_m · VERT_SCALE · (ve/VERT_EXAGGERATION)`  (= `clearance_m · ve / M_PER_WU`)
/// so the held clearance sits the same exaggerated distance above the relief the player SEES.
/// At near-surface `ve = VE_NEAR = 2.75`, 500 exaggerated-m ≈ 1.3 wu — skimming just over the
/// visible ridges. The conversion factor is computed in `lib.rs` from the live render `ve` (the
/// `ve_for_altitude` ramp or the exaggeration override) and passed to `step` as `agl_scale`.
///
/// The "ground" reference is the terrain AS RENDERED (same `ve`), so the held clearance matches
/// what the player SEES. Contour-hugging: the baseline target is the clearance above the terrain
/// DIRECTLY BELOW (descends into valleys with the floor), with the look-ahead used only for
/// collision avoidance (raising the target to clear an upcoming wall).
/// DEFAULT clearance (VE-exaggerated meters) the AGL controller holds in ATMO. A pleasant skim
/// just above the visible ridges. Runtime-tunable per craft via `Physics::target_agl` /
/// `Engine::set_target_agl` (the `?agl=<meters>` URL param), interpreted in this same scaled space.
pub const DEFAULT_TARGET_AGL: f32 = 500.0;
/// Clamp on the runtime-settable target AGL (VE-exaggerated meters). MIN is low enough to skim
/// tightly (so small scaled clearances are reachable), MAX caps it well within the ATMO band.
pub const TARGET_AGL_MIN: f32 = 80.0;
pub const TARGET_AGL_MAX: f32 = 60_000.0;

/// Look-ahead time (s): the forward ground-track window scales with speed,
/// `LOOKAHEAD = clamp(speed·LOOKAHEAD_TIME, LOOKAHEAD_MIN, LOOKAHEAD_MAX)`. Faster ⇒ look
/// farther ⇒ react earlier (direct port of ArduPilot's ground-speed scaling). Now used ONLY for
/// COLLISION AVOIDANCE (raising the target to clear an upcoming wall), not as the hold reference.
const LOOKAHEAD_TIME: f32 = 3.0;
/// Minimum / maximum look-ahead distance (wu) so the window is sane at a crawl and bounded at
/// speed. MIN keeps a useful horizon when slow; MAX caps how far peaks can pre-trigger a climb.
const LOOKAHEAD_MIN: f32 = 30.0;
const LOOKAHEAD_MAX: f32 = 600.0;
/// Number of samples along the forward ground track (plus the one directly below). Each ahead
/// sample is checked as a COLLISION THREAT (raise the target if we can't out-climb it in time).
const AGL_SAMPLES: usize = 8;
/// Extra clearance (wu) demanded above an upcoming terrain sample that would otherwise be hit —
/// the collision-avoidance safety margin (cleared with a cushion, not scraped).
const AGL_SAFETY_MARGIN: f32 = 30.0;

/// AGL controller gain (s⁻¹). The fly-by-nose altitude-hold has near-full authority each step
/// (it snaps the velocity's radial component onto the command in one frame), so the AGL command
/// is effectively a VELOCITY command, not an acceleration. A first-order proportional velocity
/// command `climb = AGL_K·err` (err = desired_r − |pos|) is therefore INHERENTLY critically
/// damped: it eases toward the target with a ~1/AGL_K time constant and CANNOT overshoot or bob
/// (no oscillation), which is exactly what an explicit `−C·radial_v` damping term would add on a
/// pure acceleration command but would DESTABILISE on a one-frame velocity command. The rate
/// clamp below caps how fast it climbs/sinks. (Equivalent to the report's critically-damped
/// radial controller for our full-authority hold: C is folded into the first-order response.)
const AGL_K: f32 = 4.0;
/// Climb / sink rate clamp (wu/s) on the AGL command — bounds the controller so it can't violate
/// the speed/feel budget and keeps the response gentle. Asymmetric: climbs harder than it sinks
/// so it clears rising terrain crisply but glides down gently after a crest.
const AGL_MAX_CLIMB: f32 = 200.0;
const AGL_MAX_SINK: f32 = 50.0;

/// Below this forward speed (wu/s) fly-by-nose authority fades out (stall): the craft can no
/// longer hold its nose-commanded heading and gravity sink takes over → you lose altitude.
/// Set comfortably BELOW IDLE_SPEED (the slowest hands-off cruise) so normal slow flight holds
/// altitude; only a genuine crawl (well under idle) stalls and sinks. ≈ 32 km/h at planet scale.
const STALL_SPEED: f32 = 18.0;

// ── Gravity ──────────────────────────────────────────────────────────────────────
/// Surface gravitational acceleration (wu/s², arcade by feel). Falls off inverse-square:
/// g = G_SURFACE·(R_WORLD/r)². Gentle enough that level cruise holds, strong enough that a
/// stall/dive sinks and that escape needs afterburner.
const G_SURFACE: f32 = 60.0;

/// Tiny epsilon above the sea-level sphere for the anti-fall-through floor (wu).
const FLOOR_EPS: f32 = 0.5;

// ── Capture zone / planetary-mode assist ─────────────────────────────────────────
/// Top of the CAPTURE ZONE as an ALTITUDE above the sea-level sphere (wu) = R_WORLD·FRAC.
/// GENEROUS (10× the planet radius ≈ 60,000 wu ≈ 60,000 km) so returning from deep space is
/// forgiving: anywhere below this the onboard AI starts easing the craft into a controlled
/// approach — pointing roughly at the planet reliably gets you captured, no pixel-perfect aim.
const CAPTURE_FRAC: f32 = 10.0;
pub const CAPTURE_ALT: f32 = R_WORLD * CAPTURE_FRAC;

/// Managed approach speed (wu/s) the effective cap bleeds down to as assist → 1 (i.e. as you
/// descend through the capture zone). Brisk but controllable (well under V_CAP) so you
/// DECELERATE smoothly on approach instead of screaming past the planet.
const APPROACH_SPEED: f32 = 2000.0;

/// CAPTURE / planetary-mode assist factor in [0,1] from altitude above the sea-level sphere:
///   * deep space (alt > CAPTURE_ALT)            → 0  : fully Newtonian/free (coast, orbit, escape).
///   * capture zone (ATMOSPHERE_TOP..CAPTURE_ALT) → smoothstep 1→0 as you climb : assist ramps in.
///   * atmosphere (alt < ATMOSPHERE_TOP)         → 1  : full fly-by-nose cruise.
///
/// At the atmosphere boundary assist == 1, matching the atmospheric regime, so the handoff to
/// the density-blended fly-by-nose cruise is seamless (no discontinuity).
pub fn assist(r: f32) -> f32 {
    let alt = r - R_WORLD;
    if alt <= ATMOSPHERE_TOP {
        return 1.0;
    }
    if alt >= CAPTURE_ALT {
        return 0.0;
    }
    let t = (alt - ATMOSPHERE_TOP) / (CAPTURE_ALT - ATMOSPHERE_TOP); // 0..1 up the zone
    let s = t * t * (3.0 - 2.0 * t); // smoothstep 0→1
    1.0 - s // 1 at the atmosphere boundary, 0 at CAPTURE_ALT
}

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

/// ORBIT weight ∈ [0,1] from altitude: 0 below ATMOSPHERE_TOP (you are in ATMO) and above
/// ORBIT_TOP (you are in INTERPLANETARY), peaking at 1 across the middle of the ORBIT band.
/// Drives the radial-spring strength (active in ORBIT, faded out at both ends so ATMO and
/// INTERPLANETARY are unaffected and escape is free). Uses two smoothsteps that overlap to a
/// continuous hump.
pub fn orbit_blend(r: f32) -> f32 {
    let alt = r - R_WORLD;
    // Ramp in over the lower quarter of the band, ramp out over the upper quarter.
    let lo = ATMOSPHERE_TOP;
    let hi = ORBIT_TOP;
    let span = hi - lo;
    let rise = smoothstep(lo, lo + span * 0.25, alt);
    let fall = 1.0 - smoothstep(hi - span * 0.25, hi, alt);
    rise * fall
}

/// Effective speed cap (wu/s) for the current altitude `r`, crossfaded smoothly across the band
/// boundaries: ATMO (CRUISE_MAX) → ORBIT (ORBIT_CAP) → INTERPLANETARY (V_CAP). Smoothstep blends
/// so there is no discontinuity. The afterburner (`ftl`) raises the ATMO/ORBIT floor toward the
/// INTERPLANETARY tier so pushing out is always possible.
pub fn eff_cap(r: f32) -> f32 {
    let alt = r - R_WORLD;
    // ATMO → ORBIT across the ATMOSPHERE_TOP boundary.
    let to_orbit = smoothstep(ATMOSPHERE_TOP * 0.5, ATMOSPHERE_TOP, alt);
    let atmo_orbit = CRUISE_MAX + (ORBIT_CAP - CRUISE_MAX) * to_orbit;
    // ORBIT → INTERPLANETARY across the ORBIT_TOP boundary.
    let to_inter = smoothstep(ORBIT_TOP * 0.75, ORBIT_TOP, alt);
    atmo_orbit + (V_CAP - atmo_orbit) * to_inter
}

pub struct Physics {
    pub orientation: Quat,
    pub position: Vec3,
    pub throttle: f32,
    pub velocity: Vec3,
    /// Scalar speed (wu/s) = |velocity|, cached for the HUD.
    pub speed: f32,
    /// Target clearance above the terrain DIRECTLY BELOW that the ATMO AGL controller holds, in
    /// VE-EXAGGERATED METERS (the same vertical scale the terrain is drawn in). Converted to wu
    /// per-frame in `step` via the live `agl_scale = VERT_SCALE·ve/VERT_EXAGGERATION`.
    /// Runtime-tunable (the `?agl=` URL param); defaults to `DEFAULT_TARGET_AGL`.
    pub target_agl: f32,
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
            target_agl: DEFAULT_TARGET_AGL,
        }
    }

    /// Integrate one physics step.
    /// thrust: -1..1 throttle command (+1 = up, -1 = down, 0 = hold).
    /// pitch/yaw/roll: desired rotation rates (rad/s), clamped internally.
    /// boost: 0..1 (unused by the speed model; afterburner is `ftl`).
    /// ftl: Space-hold afterburner (raises the target speed and thrust to the FTL tier).
    /// agl_scale: wu per VE-exaggerated meter of AGL clearance =
    ///   `VERT_SCALE · ve / VERT_EXAGGERATION` (= `ve / M_PER_WU`), using the SAME `ve` the
    ///   renderer draws terrain with this frame. `target_agl` (scaled meters) is multiplied by
    ///   this to get the wu clearance, so it is exaggerated by the same `ve` as the ground. Only
    ///   used when `terrain` is present; bare-model tests pass anything (e.g. 1.0).
    /// terrain: optional terrain-radius sampler `(lat°, lon°) → radius_wu` (the planet center
    ///   distance of the terrain AS RENDERED, vertical-exaggeration baked in by the caller).
    ///   When present, ATMO altitude-hold becomes AGL terrain-following (look-ahead max-window,
    ///   critically-damped); fades to the ORBIT altitude-hold across the boundary. When None
    ///   (e.g. unit tests of the bare model), ATMO holds level (commanded radial 0) as before.
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
        agl_scale: f32,
        terrain: Option<&dyn Fn(f32, f32) -> f32>,
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

        // --- Environment (compute early; banking needs density/orbit weights) ---
        let r_dist = self.position.length().max(1e-3);
        let radial_out = self.position / r_dist; // unit, away from center
        let density = air_density(r_dist); // 1 = full atmosphere, 0 = space
        let orbit_w = orbit_blend(r_dist); // 1 = mid ORBIT band, 0 in ATMO / INTERPLANETARY
        let assist = assist(r_dist); // 1 = atmosphere, ramps 0 in capture zone, 0 deep space
        let g = G_SURFACE * (R_WORLD / r_dist).powi(2);

        // --- Coordinated banking (ATMO/ORBIT): a roll-induced bank angle yaws the craft into
        // the turn, so rolling banks you around (plane feel). Bank angle = how far the craft's
        // local UP has tilted off the local radial; sign from the right-wing's radial component.
        // Gated by air/orbit presence (no banking in free space) and by speed (sluggish slow).
        let fly_w = density.max(orbit_w);
        let bank_yaw = if fly_w > 1e-3 {
            let right_body = self.orientation * Vec3::X;
            let bank_sin = -right_body.dot(radial_out); // right wing dipped → bank, sign = turn dir
            let spd_frac = (self.speed / CRUISE_MAX).clamp(0.0, 1.0);
            BANK_GAIN * bank_sin * spd_frac * fly_w
        } else {
            0.0
        };
        let y = (y + bank_yaw).clamp(-YAW_RATE, YAW_RATE);

        let dq_pitch = Quat::from_axis_angle(Vec3::X, p * dt);
        let dq_yaw = Quat::from_axis_angle(Vec3::Y, y * dt);
        let dq_roll = Quat::from_axis_angle(Vec3::NEG_Z, r * dt);
        self.orientation = (self.orientation * dq_yaw * dq_pitch * dq_roll).normalize();

        let nose = self.orientation * Vec3::NEG_Z;

        // --- Hands-off auto-level (atmosphere only): with no pitch/roll input, rotate the
        // nose toward the LOCAL HORIZONTAL (velocity projected onto the tangent plane) so
        // level cruise holds altitude as the planet curves beneath. Disabled in space (free
        // 6DOF) and bypassed when the pilot is actively pitching/rolling. ---
        if fly_w > 0.0 && pitch.abs() < 1e-3 && roll.abs() < 1e-3 {
            let mut horiz = self.velocity - radial_out * self.velocity.dot(radial_out);
            if horiz.length_squared() < 1e-6 {
                horiz = nose - radial_out * nose.dot(radial_out);
            }
            let horiz = horiz.normalize_or_zero();
            if horiz != Vec3::ZERO {
                let frac = (AUTO_LEVEL_RATE * fly_w * dt).clamp(0.0, 1.0);
                let new_nose = nose.lerp(horiz, frac).normalize_or_zero();
                if new_nose != Vec3::ZERO {
                    let relevel = Quat::from_rotation_arc(nose, new_nose);
                    self.orientation = (relevel * self.orientation).normalize();
                }
            }
        }
        let nose = self.orientation * Vec3::NEG_Z; // refresh after auto-level

        // --- Throttle (gas pedal) ---
        // Slow ramp so taps give FINE adjustment instead of snapping min↔max: a full 0→1 sweep
        // takes ≈ 1/THROTTLE_RATE ≈ 3.3 s, so the pilot can settle at many distinct intermediate
        // cruising speeds. With no thrust input the throttle holds (hands-off cruise).
        self.throttle = (self.throttle + thrust * THROTTLE_RATE * dt).clamp(0.0, 1.0);

        // --- Target speed from throttle, crossfaded per mode and hard-capped to the effective
        //     per-mode cap. ATMO band IDLE_SPEED..CRUISE_MAX, ORBIT band ORBIT_IDLE..ORBIT_CAP,
        //     afterburner raises the top toward FTL_MAX. The idle floor + the ceiling both
        //     crossfade by orbit_w so the envelope shifts smoothly across the ATMO→ORBIT seam;
        //     finally v_target is clamped to eff_cap(r) (the smoothstep cap across all bands). ---
        self.throttle = (self.throttle + thrust * THROTTLE_RATE * dt).clamp(0.0, 1.0);
        let idle = IDLE_SPEED + (ORBIT_IDLE - IDLE_SPEED) * orbit_w;
        let band_top = CRUISE_MAX + (ORBIT_CAP - CRUISE_MAX) * orbit_w;
        let top = if ftl { FTL_MAX.max(band_top) } else { band_top };
        let cap = eff_cap(r_dist).max(if ftl { FTL_MAX } else { 0.0 }).min(V_CAP);
        let v_target = (idle + (top - idle) * self.throttle).min(cap);

        // ===== FLY-BY-NOSE term (ATMO + ORBIT) =====
        // Ease scalar speed toward v_target, steer the unit velocity toward the nose, then
        // rebuild velocity = dir * speed. ATMO adds QUADRATIC DRAG (∝ density·v²) so the top
        // speed is asymptotic and cutting throttle bleeds speed in ~2–3 s. Stall: below
        // STALL_SPEED the nose authority fades and gravity sink dominates. Altitude handling
        // crossfades from a STRICT level hold (ATMO) to a loose critically-damped RADIAL SPRING
        // toward the current altitude (ORBIT: near-circular hold, easy to raise/lower with pitch).
        let fly_vel = {
            let cur = self.velocity.length();
            // Quadratic atmospheric drag (ATMO only; fades with density). Bounded so it can't
            // overshoot below zero in a step.
            let drag = (DRAG_K * density * cur * cur).min(cur / dt.max(1e-4));
            let dv = (v_target - cur).clamp(-SPEED_ACCEL * dt, SPEED_ACCEL * dt) - drag * dt;
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
            // (AGL terrain-following will later replace this 0 with a terrain-tracked command —
            // a clean seam: only the `commanded_radial` value changes.)
            let commanded_radial = if pitch.abs() >= 1e-3 {
                // MANUAL OVERRIDE: the pilot is pitching → climb/dive to match the nose;
                // terrain-follow yields. Auto re-engages the instant pitch is released.
                nose.dot(radial_out)
            } else if let Some(terr) = terrain {
                // AGL TERRAIN-FOLLOWING (ATMO). The hold reference is the terrain DIRECTLY BELOW
                // plus the clearance (`target_agl`), so the craft HUGS THE CONTOUR — it descends
                // into valleys instead of staying at an upcoming peak's height. The look-ahead is
                // now COLLISION AVOIDANCE only: for each forward sample, the craft can climb at
                // AGL_MAX_CLIMB and will reach the sample in `t = d/speed`, so to clear it it must
                // already be at radius ≥ `terrain_ahead + safety − AGL_MAX_CLIMB·t` NOW. We take
                // the MAX of the ground-below baseline and every sample's required-now radius, so
                // rolling/valley terrain leaves the target at ground-below (descend with it) while
                // a steep wall at speed RAISES the target in time to pull up. Crossfades to the
                // ORBIT level-hold (0) by orbit_w (no discontinuity at the ATMO/ORBIT boundary).
                let ground = self.velocity - radial_out * self.velocity.dot(radial_out);
                let track = if ground.length_squared() > 1e-6 {
                    ground.normalize()
                } else {
                    let nh = nose - radial_out * nose.dot(radial_out);
                    nh.normalize_or_zero()
                };
                let lookahead =
                    (speed * LOOKAHEAD_TIME).clamp(LOOKAHEAD_MIN, LOOKAHEAD_MAX);
                // Baseline: hug the terrain directly below + the held clearance. The clearance is
                // stored in VE-exaggerated meters; convert to wu with `agl_scale` (the SAME `ve`
                // the terrain is drawn with this frame) so it is exaggerated like the ground.
                let agl_wu = self.target_agl * agl_scale;
                let (lat0, lon0) = crate::heightfield::Heightfield::lat_lon_of(self.position);
                let terrain_below = terr(lat0, lon0);
                let mut desired_r = terrain_below + agl_wu;
                // Collision avoidance: only RAISE the target where an upcoming sample can't be
                // out-climbed in the time it takes to reach it.
                if track != Vec3::ZERO {
                    for i in 1..=AGL_SAMPLES {
                        let d = lookahead * (i as f32 / AGL_SAMPLES as f32);
                        let probe = self.position + track * d;
                        let (lat, lon) =
                            crate::heightfield::Heightfield::lat_lon_of(probe);
                        let terrain_ahead = terr(lat, lon);
                        let t = d / speed.max(1.0); // time to reach this sample
                        let need_now =
                            terrain_ahead + AGL_SAFETY_MARGIN - AGL_MAX_CLIMB * t;
                        desired_r = desired_r.max(need_now);
                    }
                }
                let err = desired_r - r_dist;
                let climb = (AGL_K * err).clamp(-AGL_MAX_SINK, AGL_MAX_CLIMB);
                // Convert the climb RATE (wu/s) to a radial direction fraction, then fade out by
                // orbit_w so the ORBIT band falls back to the level (0) hold.
                let cmd = climb / speed.max(1.0);
                cmd.clamp(-1.0, 1.0) * (1.0 - orbit_w)
            } else {
                0.0 // no terrain sampler: hold altitude level as the planet curves
            };
            let cur_radial = dir.dot(radial_out);
            // Authority collapses sharply (stall³) as speed bleeds off, so a stall clearly
            // releases the altitude hold and lets gravity sink the craft, while cruise stays
            // firmly pinned. In ORBIT the STRICT hold relaxes toward a GENTLE, critically-damped
            // radial hold (ORBIT_HOLD_RATE) so the craft keeps a near-circular path — the
            // velocity is curved to follow the sphere — but is easy to raise/lower with pitch and
            // not pinned like the dense atmosphere. The hold rate crossfades ATMO→ORBIT by orbit_w.
            let auth = stall * stall * stall;
            let hold_rate = ALT_HOLD_RATE + (ORBIT_HOLD_RATE - ALT_HOLD_RATE) * orbit_w;
            let hold = (hold_rate * auth * dt).clamp(0.0, 1.0);
            dir = (dir - radial_out * ((cur_radial - commanded_radial) * hold))
                .normalize_or(dir);
            let mut v = dir * speed;
            // Gravity sink: gravity always pulls inward; fly-by-nose mostly cancels it when
            // flying level (the steered direction has ~0 radial component), but a stall lets
            // it through (1 - auth), and a nose-down heading naturally dives via `dir`.
            v += -radial_out * (g * (1.0 - auth) * dt);
            v
        };

        // ===== SPACE term: Newtonian, with CAPTURE-ZONE assist =====
        // Deep space (assist == 0): pure inertia — velocity += gravity·dt + nose·thrust·dt,
        // no direction steering (coast/orbit/escape unchanged). In the capture zone the
        // onboard AI eases the craft into a controlled approach, ramping in by `assist`:
        //   1. fly-by-nose STEERING ramps in (slerp velocity dir → nose at TURN_RATE·assist),
        //      so pointing the nose at the planet (or down) actually brings you in — and
        //      pointing OUTWARD + afterburner still lets you climb back out (assist, not prison).
        //   2. the effective speed CAP bleeds from V_CAP down to APPROACH_SPEED, so you
        //      DECELERATE smoothly toward the planet instead of overshooting.
        // At assist == 1 (atmosphere boundary) this matches the atmospheric regime, so the
        // density blend below hands off with no discontinuity.
        let space_vel = {
            let mut v = self.velocity;
            v += -radial_out * (g * dt); // inverse-square gravity
            let cur = v.length();
            // Thrust along the nose toward v_target (bounded), as before.
            let thrust_accel =
                ((v_target - cur).max(0.0) / dt.max(1e-4)).min(SPEED_ACCEL * 4.0);
            v += nose * (thrust_accel * dt); // thrust along the nose

            // --- Capture-zone assist (ramps in by `assist`) ---
            if assist > 0.0 {
                // 1. Steer the velocity DIRECTION toward the nose at TURN_RATE·assist.
                let spd = v.length();
                if spd > 1e-3 {
                    let dir = v / spd;
                    let turn = (TURN_RATE * assist * dt).clamp(0.0, 1.0);
                    let new_dir = dir.lerp(nose, turn).normalize_or(dir);
                    v = new_dir * spd;
                }
                // 2. Bleed the effective speed cap down to APPROACH_SPEED, easing (don't snap)
                //    the current speed toward it under bounded acceleration. Only ever slows
                //    the craft (cap ≤ V_CAP), so afterburner can still climb back out.
                let approach_cap = V_CAP + (APPROACH_SPEED - V_CAP) * assist;
                let spd = v.length();
                if spd > approach_cap {
                    let dv = (spd - approach_cap).min(SPEED_ACCEL * dt);
                    v *= (spd - dv) / spd;
                }
            }
            v
        };

        // --- Blend fly-by-nose (ATMO+ORBIT) against free Newtonian (INTERPLANETARY) by the
        //     combined air/orbit weight. fly_w = 1 inside the atmosphere and the heart of the
        //     orbit band, smoothstepping to 0 above ORBIT_TOP → free space. The eff_cap blend +
        //     the orbit_w-gated spring inside fly_vel make every quantity cross the boundaries
        //     continuously (no discrete switch). ---
        self.velocity = space_vel.lerp(fly_vel, fly_w);

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

    /// Current flight mode by altitude (3 primary modes; the capture-zone assist is a
    /// sub-state folded into INTERPLANETARY re-entry, not a separate label):
    ///   0 = ATMO           (dense fly-by-nose cruise, alt < ATMOSPHERE_TOP),
    ///   1 = ORBIT          (thin air, near-circular hold, ATMOSPHERE_TOP ≤ alt < ORBIT_TOP),
    ///   2 = INTERPLANETARY (free Newtonian + capture assist, alt ≥ ORBIT_TOP).
    pub fn flight_mode(&self) -> u8 {
        let alt = self.position.length() - R_WORLD;
        if alt < ATMOSPHERE_TOP {
            0
        } else if alt < ORBIT_TOP {
            1
        } else {
            2
        }
    }
}

#[cfg(test)]
mod scenarios {
    use super::*;
    use crate::heightfield::M_PER_WU;

    // Clearance (in WORLD UNITS) the AGL mechanism tests hold. These tests drive `step` with
    // `agl_scale = 1.0`, so `target_agl` is interpreted directly as a wu clearance — isolating the
    // controller mechanism (contour-hug, collision-avoidance, no-bob) from the VE meter→wu
    // conversion, which is exercised separately by the `y_*` VE-consistency tests below.
    const TARGET_AGL: f32 = 60.0;

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
        // AGL mechanism tests drive `step` with agl_scale = 1.0 and interpret target_agl as a wu
        // clearance, so seed the wu test target (not the scaled-meter DEFAULT_TARGET_AGL).
        p.target_agl = TARGET_AGL;
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
            p.step(dt, thrust, pitch, 0.0, 0.0, 0.0, ftl, 1.0, None);
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
            p.step(dt, 1.0, 0.0, 0.0, 0.0, 0.0, true, 1.0, None); // Shift+Space
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

    // (d) Stall: a genuine CRAWL below STALL_SPEED loses fly-by-nose authority and sinks under
    // gravity. (Throttle alone can't reach a stall now — its floor is IDLE_SPEED > STALL_SPEED,
    // so normal slow flight HOLDS; a stall needs a real sub-stall crawl, seeded here.)
    #[test]
    fn d_stall_sinks() {
        // A genuine sub-stall CRAWL loses fly-by-nose authority (auth = stall³ → ~0), so the
        // gravity sink term g·(1−auth) pulls the craft inward (loses altitude) — whereas a craft
        // at/above STALL_SPEED holds. Because SPEED_ACCEL recovers a slow craft past stall within
        // a frame (so a stall is fleeting — this is the design: normal slow flight HOLDS), we
        // disable the throttle/speed easing for the test by clamping the easing window: we hold
        // each craft at a FIXED speed across one step and compare the radial (climb/sink) velocity
        // it picks up. The sub-stall craft must gain inward (negative-radial) velocity.
        let radial = Vec3::X; // level_craft uses radial = +X
        let inward = |p: &Physics| -p.velocity.dot(radial); // >0 means sinking
        let mut stalled = level_craft(400.0, 0.3 * STALL_SPEED, 0.0); // deep crawl, below stall
        let mut flying = level_craft(400.0, IDLE_SPEED, 0.0); // healthy slow cruise, above stall
        // One step each; freeze the throttle-eased speed back so authority reflects the seeded
        // (sub-stall vs healthy) speed, isolating the stall mechanism.
        // Use a SMALL dt so SPEED_ACCEL barely eases the seeded speed within the step — the
        // crawl stays sub-stall (auth<1, sinks) while the healthy cruise holds. (With IDLE_SPEED
        // well above STALL, throttle-0 flight HOLDS by design, so a stall is a genuine crawl.)
        let s_crawl = 0.3 * STALL_SPEED;
        let dt = 1.0 / 600.0;
        stalled.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None);
        flying.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None);
        println!("[stall] seeded crawl={:.1} (<STALL={:.0}) vs cruise={:.0}: inward vel crawl={:.3} cruise={:.3}",
            s_crawl, STALL_SPEED, IDLE_SPEED, inward(&stalled), inward(&flying));
        // The sub-stall crawl gains downward (inward) velocity from the gravity sink; the
        // healthy cruise stays level (no appreciable inward velocity).
        assert!(inward(&stalled) > inward(&flying) + 0.05, "stall didn't sink relative to cruise: crawl {} vs cruise {}", inward(&stalled), inward(&flying));
        assert!(inward(&stalled) > 0.05, "sub-stall crawl didn't gain inward (sinking) velocity: {}", inward(&stalled));
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
            p.step(dt, 1.0, 0.0, 0.0, 0.0, 0.0, true, 1.0, None);
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
                p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None);
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

    // A craft in deep space at altitude `alt`, nose + velocity pointed ROUGHLY toward the
    // planet (origin) — offset by `aim_off` (a tangential fraction) so it isn't a pixel-perfect
    // dead-center dive but a forgiving glancing approach, the realistic player case.
    fn inbound_craft(alt: f32, speed: f32, throttle: f32, aim_off: f32) -> Physics {
        let pos = Vec3::new(R_WORLD + alt, 0.0, 0.0); // radial = +X
        let toward = -pos.normalize(); // toward center
        let tangent = Vec3::NEG_Z; // a tangent at +X
        let look = (toward + tangent * aim_off).normalize();
        let mut p = Physics::new(pos, look);
        p.velocity = look * speed;
        p.speed = speed;
        p.throttle = throttle;
        p
    }

    // (i) Round-trip return: from deep space, nose at the planet + throttle on → assist
    // engages, speed bleeds toward APPROACH_SPEED, descends into the atmosphere and settles
    // into a STABLE cruise altitude (no overshoot/escape, no crash through the floor).
    #[test]
    fn i_round_trip_return() {
        // Roughly-aimed inbound (40% tangential offset) — pointing "at the planet", not dead
        // center — with cruise throttle so once captured it can settle into level flight.
        let mut p = inbound_craft(100_000.0, V_CAP, 0.6, 0.4);
        let dt = 1.0 / 60.0;
        let mut entered_zone = false;
        let mut speed_in_atmo = f32::INFINITY;
        let (mut amin, mut amax) = (f32::INFINITY, 0.0_f32);
        let mut t = 0.0;
        for i in 0..(400.0 / dt) as usize {
            // The pilot keeps the nose pointed roughly AT the planet while still in space /
            // the upper capture zone (re-aim toward center), then hands off to auto-level once
            // inside the atmosphere. This is the documented intent: point at the planet → the
            // AI brings you in. (Modeled by re-seeding orientation toward the origin.)
            if alt(&p) > ATMOSPHERE_TOP {
                let look = -p.position.normalize();
                p.orientation = Physics::new(p.position, look).orientation;
            }
            // No FTL: AI manages the approach. Throttle held (gives a cruise target once down).
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None);
            t += dt;
            let a = alt(&p);
            if a < CAPTURE_ALT && !entered_zone {
                entered_zone = true;
                println!("[round-trip] entered capture zone at t={t:.1}s alt={a:.0} speed={:.0}", p.speed);
            }
            // Once we're well inside the atmosphere, start tracking the settle band.
            if a < ATMOSPHERE_TOP {
                speed_in_atmo = speed_in_atmo.min(p.speed);
            }
            // Track the settled band over the last 100 s of the run.
            if t > 300.0 {
                amin = amin.min(a);
                amax = amax.max(a);
            }
            if i % (30.0 / dt) as usize == 0 {
                println!("[round-trip] t={t:.0}s alt={a:.0} speed={:.0} assist={:.2} mode={}",
                    p.speed, assist(p.position.length()), p.flight_mode());
            }
        }
        println!("[round-trip] FINAL alt={:.0} speed={:.0} | settle band [{:.0},{:.0}] | min speed in atmo {:.0} (APPROACH={:.0})",
            alt(&p), p.speed, amin, amax, speed_in_atmo, APPROACH_SPEED);
        assert!(entered_zone, "never entered capture zone");
        assert!(alt(&p) < ATMOSPHERE_TOP, "did not descend into atmosphere: {}", alt(&p));
        assert!(alt(&p) > 0.0, "crashed through the floor: {}", alt(&p));
        // Settled: altitude band over the last 100 s is bounded near the atmosphere — it does
        // NOT escape back to space (well under CAPTURE_ALT) and does NOT plummet through the
        // floor. A small bob across the atmosphere boundary as it settles is fine.
        assert!(amax < ATMOSPHERE_TOP * 1.5, "escaped toward space: settle band up to {amax}");
        assert!((amax - amin) < 800.0, "altitude not stable: band [{amin},{amax}]");
        assert!(amin > 50.0, "settled too low / scraping the floor: band from {amin}");
        // Speed was bled down on approach (came near APPROACH_SPEED, not screaming at V_CAP).
        assert!(speed_in_atmo < APPROACH_SPEED * 1.2, "speed not bled on approach: {speed_in_atmo}");
    }

    // (j) Decel on entry: crossing CAPTURE_ALT inbound at V_CAP → speed eases down to about
    // APPROACH_SPEED by the time it reaches the atmosphere.
    #[test]
    fn j_decel_on_entry() {
        // Start just above CAPTURE_ALT so we cross it inbound at full speed.
        let mut p = inbound_craft(CAPTURE_ALT + 500.0, V_CAP, 0.0, 0.0);
        let dt = 1.0 / 60.0;
        let mut speed_at_atmo = None;
        for _ in 0..(600.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None);
            if alt(&p) <= ATMOSPHERE_TOP && speed_at_atmo.is_none() {
                speed_at_atmo = Some(p.speed);
                break;
            }
        }
        let s = speed_at_atmo.expect("never reached the atmosphere");
        println!("[decel] crossed CAPTURE_ALT at V_CAP={V_CAP:.0}, reached atmosphere at speed={s:.0} (APPROACH={APPROACH_SPEED:.0})");
        assert!(s < APPROACH_SPEED * 1.3, "speed did not bleed to ~APPROACH_SPEED: {s}");
        assert!(s < V_CAP * 0.5, "barely decelerated: {s}");
    }

    // (k) Not a prison: in the capture zone, nose pointed OUTWARD + afterburner → climbs back
    // out past CAPTURE_ALT (can re-escape).
    #[test]
    fn k_not_a_prison() {
        // Mid capture zone, nose pointed straight OUT, modest inbound speed.
        let alt0 = (ATMOSPHERE_TOP + CAPTURE_ALT) * 0.5;
        let pos = Vec3::new(R_WORLD + alt0, 0.0, 0.0);
        let out = pos.normalize();
        let mut p = Physics::new(pos, out); // nose outward
        p.velocity = out * 500.0; // already drifting out a little
        p.speed = 500.0;
        p.throttle = 1.0;
        let dt = 1.0 / 60.0;
        for _ in 0..(300.0 / dt) as usize {
            p.step(dt, 1.0, 0.0, 0.0, 0.0, 0.0, true, 1.0, None); // afterburner, climb out
        }
        println!("[not-prison] alt {:.0} -> {:.0} (CAPTURE_ALT={:.0}) speed={:.0}",
            alt0, alt(&p), CAPTURE_ALT, p.speed);
        assert!(alt(&p) > CAPTURE_ALT, "could not re-escape the capture zone: {}", alt(&p));
    }

    // (l) flight_mode reports the right mode by altitude: ATMO/ORBIT/INTERPLANETARY.
    #[test]
    fn l_flight_mode() {
        let atmo = level_craft(400.0, 200.0, 0.5);
        let orbit = level_craft((ATMOSPHERE_TOP + ORBIT_TOP) * 0.5, 2000.0, 0.0);
        let inter = level_craft(ORBIT_TOP + 5000.0, 5000.0, 0.0);
        println!("[mode] atmo={} orbit={} inter={}", atmo.flight_mode(), orbit.flight_mode(), inter.flight_mode());
        assert_eq!(atmo.flight_mode(), 0, "ATMO");
        assert_eq!(orbit.flight_mode(), 1, "ORBIT");
        assert_eq!(inter.flight_mode(), 2, "INTERPLANETARY");
    }

    // (m) Slow low-altitude cruise HOLDS altitude: throttle 0 (slowest cruise = IDLE_SPEED),
    // level, at ~500 m (≈0.47 wu) → altitude holds over 20 s (does NOT sink) and the speed
    // settles at the low IDLE target.
    #[test]
    fn m_slow_cruise_holds() {
        let alt500 = 500.0 / M_PER_WU; // ≈ 0.47 wu
        // Seed at the zero-throttle target (IDLE_SPEED) so it's already at the slow cruise.
        let mut p = level_craft(alt500, IDLE_SPEED, 0.0);
        let a0 = alt(&p);
        let (mut amin, mut amax) = (a0, a0);
        let dt = 1.0 / 60.0;
        for s in 0..20 {
            for _ in 0..60 {
                p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None); // throttle 0, level, hands-off
            }
            let a = alt(&p);
            amin = amin.min(a);
            amax = amax.max(a);
            if s % 5 == 0 {
                println!("[slow-cruise] t={}s alt={:.3} (={:.0} m) speed={:.1}", s + 1, a, a * M_PER_WU, p.speed);
            }
        }
        println!("[slow-cruise] alt start={:.3} band [{:.3},{:.3}] (≈{:.0} m) | speed ->{:.1} (IDLE={:.0} STALL={:.0})",
            a0, amin, amax, a0 * M_PER_WU, p.speed, IDLE_SPEED, STALL_SPEED);
        // Altitude HOLDS (does not sink) at this slow cruise.
        assert!(amin > a0 - 0.05, "slow cruise SANK: min {} (start {})", amin, a0);
        assert!((amax - amin) < 0.2, "slow cruise altitude drifted: band [{amin},{amax}]");
        // Speed settled at the low IDLE target (the slowest cruise), comfortably above stall.
        assert!((p.speed - IDLE_SPEED).abs() < 5.0, "speed didn't settle at idle: {}", p.speed);
        assert!(p.speed > STALL_SPEED, "slow cruise is below stall: {}", p.speed);
    }

    // (n) Granularity: several distinct throttle settings → several DISTINCT steady speeds
    // spread across the cruise range (not just min/afterburner).
    #[test]
    fn n_granular_speeds() {
        let throttles = [0.0_f32, 0.25, 0.5, 0.75, 1.0];
        let mut speeds = Vec::new();
        for &t in &throttles {
            let mut p = level_craft(400.0, IDLE_SPEED, t);
            // Hold this throttle setting; let speed ease to its target.
            let dt = 1.0 / 60.0;
            for _ in 0..(8.0 / dt) as usize {
                p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None); // no thrust input → throttle holds
            }
            println!("[granular] throttle={:.2} -> steady speed={:.0}", t, p.speed);
            speeds.push(p.speed);
        }
        // Strictly increasing and well-separated across the band.
        for w in speeds.windows(2) {
            assert!(w[1] > w[0] + 80.0, "settings not distinct enough: {:?}", speeds);
        }
        assert!(speeds[0] < IDLE_SPEED + 5.0, "min setting not at idle: {}", speeds[0]);
        assert!(speeds[speeds.len() - 1] > CRUISE_MAX * 0.9, "max setting not near cruise cap: {}", speeds[speeds.len() - 1]);
    }

    // ===== THREE-MODE system tests =====

    // (o) Per-mode speed caps: at low alt speed can't exceed ~CRUISE_MAX(400); in the orbit
    // band up to ~ORBIT_CAP(3000); interplanetary up to V_CAP. Crossfaded — assert each band's
    // sustained full-throttle speed lands near its cap (and never far past it).
    #[test]
    fn o_per_mode_caps() {
        // ATMO: full throttle at low alt, level, ~20 s. Quadratic drag makes it asymptotic
        // just under CRUISE_MAX.
        let mut atmo = level_craft(400.0, IDLE_SPEED, 1.0);
        run(&mut atmo, 20.0, 1.0, 0.0, false);
        // ORBIT: full throttle mid-orbit-band, level, ~30 s.
        let orbit_alt = (ATMOSPHERE_TOP + ORBIT_TOP) * 0.5;
        let mut orbit = level_craft(orbit_alt, ORBIT_IDLE, 1.0);
        run(&mut orbit, 40.0, 1.0, 0.0, false);
        // INTERPLANETARY: afterburner in deep space, ~30 s.
        let mut inter = level_craft(ORBIT_TOP + R_WORLD * 3.0, 2000.0, 1.0);
        run(&mut inter, 30.0, 1.0, 0.0, true);
        println!("[caps] ATMO={:.0} (CRUISE_MAX={:.0}) ORBIT={:.0} (ORBIT_CAP={:.0}) INTER={:.0} (V_CAP={:.0})",
            atmo.speed, CRUISE_MAX, orbit.speed, ORBIT_CAP, inter.speed, V_CAP);
        assert!(atmo.speed <= CRUISE_MAX * 1.05, "ATMO exceeded cap: {}", atmo.speed);
        assert!(atmo.speed > CRUISE_MAX * 0.85, "ATMO didn't reach near cap: {}", atmo.speed);
        assert!(orbit.speed <= ORBIT_CAP * 1.1, "ORBIT exceeded cap: {}", orbit.speed);
        assert!(orbit.speed > ORBIT_CAP * 0.7, "ORBIT didn't reach near cap: {}", orbit.speed);
        assert!(inter.speed <= V_CAP + 1e-2, "INTER exceeded V_CAP: {}", inter.speed);
        assert!(inter.speed > ORBIT_CAP, "INTER no faster than ORBIT: {}", inter.speed);
        // Ratio sanity: roughly 1 : 7.5 : 25.
        assert!(orbit.speed > atmo.speed * 3.0, "ORBIT/ATMO ratio too small");
        assert!(inter.speed > orbit.speed * 1.5, "INTER/ORBIT ratio too small");
    }

    // (p) ATMO drag feel: full throttle then CUT → quadratic drag bleeds speed to ~idle in a
    // few seconds.
    #[test]
    fn p_atmo_drag_bleed() {
        let mut p = level_craft(400.0, IDLE_SPEED, 1.0);
        run(&mut p, 20.0, 1.0, 0.0, false); // spool up to terminal
        let v0 = p.speed;
        let dt = 1.0 / 60.0;
        let mut t_to_idle = None;
        let mut t = 0.0;
        for _ in 0..(8.0 / dt) as usize {
            p.step(dt, -1.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None); // cut throttle
            t += dt;
            if t_to_idle.is_none() && p.speed < IDLE_SPEED * 1.5 {
                t_to_idle = Some(t);
            }
        }
        let tt = t_to_idle.expect("never bled to near idle");
        println!("[drag] terminal={:.0} -> bled to ~idle in {:.2}s (final {:.0}, IDLE={:.0})", v0, tt, p.speed, IDLE_SPEED);
        assert!(v0 > CRUISE_MAX * 0.85, "didn't reach terminal: {v0}");
        assert!((1.0..=4.0).contains(&tt), "drag bleed time out of 1–4 s window: {tt}s");
    }

    // (q) ORBIT loosely maintains altitude: mid-band, level, NO input → altitude stays ~const
    // over a long coast (the radial spring + gravity-cancel hold near-circular, no bob).
    #[test]
    fn q_orbit_holds_altitude() {
        let alt0 = (ATMOSPHERE_TOP + ORBIT_TOP) * 0.5;
        let mut p = level_craft(alt0, 2000.0, 0.5);
        let a0 = alt(&p);
        let (mut amin, mut amax) = (a0, a0);
        let dt = 1.0 / 60.0;
        for s in 0..40 {
            for _ in 0..60 {
                p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None);
            }
            let a = alt(&p);
            amin = amin.min(a); amax = amax.max(a);
            if s % 10 == 0 {
                println!("[orbit-hold] t={}s alt={:.0} speed={:.0} mode={}", s + 1, a, p.speed, p.flight_mode());
            }
        }
        println!("[orbit-hold] alt start={:.0} band [{:.0},{:.0}] (drift {:.0})", a0, amin, amax, amax - amin);
        assert_eq!(p.flight_mode(), 1, "left ORBIT band");
        assert!((amax - amin) < alt0 * 0.15, "orbit altitude drifted too much: band [{amin},{amax}]");
    }

    // (r) ORBIT easy escape: point OUT + throttle → climbs past ORBIT_TOP into INTERPLANETARY
    // (the spring fades, never a prison).
    #[test]
    fn r_orbit_escape() {
        let alt0 = (ATMOSPHERE_TOP + ORBIT_TOP) * 0.5;
        let pos = Vec3::new(R_WORLD + alt0, 0.0, 0.0);
        let out = pos.normalize();
        let mut p = Physics::new(pos, out); // nose straight out
        p.velocity = out * 1000.0;
        p.speed = 1000.0;
        p.throttle = 1.0;
        let dt = 1.0 / 60.0;
        for _ in 0..(60.0 / dt) as usize {
            p.step(dt, 1.0, 0.0, 0.0, 0.0, 0.0, true, 1.0, None);
        }
        println!("[orbit-escape] alt {:.0} -> {:.0} (ORBIT_TOP={:.0}) speed={:.0} mode={}", alt0, alt(&p), ORBIT_TOP, p.speed, p.flight_mode());
        assert!(alt(&p) > ORBIT_TOP, "could not escape ORBIT band: {}", alt(&p));
    }

    // (s) Smooth transitions: sweep altitude across both boundaries → eff_cap, density,
    // orbit_blend change CONTINUOUSLY (bounded step-to-step deltas, no NaN, monotone-ish cap).
    #[test]
    fn s_smooth_transitions() {
        let mut last_cap = eff_cap(R_WORLD);
        let mut max_dcap = 0.0_f32;
        let n = 4000;
        for i in 0..=n {
            let alt = (i as f32 / n as f32) * (ORBIT_TOP + R_WORLD); // 0 .. ORBIT_TOP+R_WORLD
            let r = R_WORLD + alt;
            let c = eff_cap(r);
            let d = air_density(r);
            let ob = orbit_blend(r);
            assert!(c.is_finite() && d.is_finite() && ob.is_finite(), "NaN at alt {alt}");
            assert!((0.0..=1.0).contains(&d) && (0.0..=1.0).contains(&ob));
            max_dcap = max_dcap.max((c - last_cap).abs());
            last_cap = c;
            if i % 800 == 0 {
                println!("[smooth] alt={:.0} cap={:.0} density={:.2} orbit_blend={:.2}", alt, c, d, ob);
            }
        }
        // The biggest single-sample cap jump over a fine sweep is tiny (continuous, no step).
        println!("[smooth] max cap delta per sample = {:.2} (over {} samples)", max_dcap, n);
        assert!(max_dcap < 50.0, "eff_cap has a discontinuity: max delta {max_dcap}");
        // Caps are ordered across the bands.
        assert!(eff_cap(R_WORLD + 100.0) < eff_cap(R_WORLD + ATMOSPHERE_TOP + 2000.0));
        assert!(eff_cap(R_WORLD + ATMOSPHERE_TOP + 2000.0) < eff_cap(R_WORLD + ORBIT_TOP + 1000.0));
    }

    // (t) Banking: a ROLL input induces a heading (yaw) change in ATMO — rolling banks you
    // into a turn (no rudder needed).
    #[test]
    fn t_banking_turns() {
        let mut p = level_craft(400.0, 300.0, 0.7);
        let fwd0 = p.velocity.normalize();
        let dt = 1.0 / 60.0;
        // Roll for a bit (to establish a bank), then hold the bank with no further roll so the
        // coordinated-turn yaw acts on the heading.
        for _ in 0..(0.6 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 1.0, 0.0, false, 1.0, None); // roll right
        }
        for _ in 0..(2.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, None); // hold (banked) — turn develops
        }
        let fwd1 = p.velocity.normalize();
        let turn = fwd0.dot(fwd1).clamp(-1.0, 1.0).acos().to_degrees();
        println!("[banking] heading turned {:.1}° from a roll (no rudder)", turn);
        assert!(turn > 5.0, "roll did not induce a turn: {turn}°");
    }

    // ===== AGL TERRAIN-FOLLOWING tests =====
    //
    // The synthetic terrain is a function of LONGITUDE (the craft starts at +X = lon 0, heading
    // NEG_Z, which increases lon — its ground track). A terrain sampler closure returns the
    // terrain RADIUS = R_WORLD + elev_wu at a given (lat, lon). We drive the craft hands-off
    // (no pitch) so the AGL controller is fully in charge, and trace |pos| − terrain_below.

    // AGL directly below, in wu, for a terrain radius function.
    fn agl_below(p: &Physics, terr: &dyn Fn(f32, f32) -> f32) -> f32 {
        let (lat, lon) = crate::heightfield::Heightfield::lat_lon_of(p.position);
        p.position.length() - terr(lat, lon)
    }

    fn run_terr(
        p: &mut Physics,
        secs: f32,
        thrust: f32,
        pitch: f32,
        terr: &dyn Fn(f32, f32) -> f32,
    ) {
        let dt = 1.0 / 60.0;
        for _ in 0..((secs / dt) as usize) {
            p.step(dt, thrust, pitch, 0.0, 0.0, 0.0, false, 1.0, Some(terr));
        }
    }

    // (u) FLAT terrain: AGL holds ~TARGET_AGL steady, hands-off, no bob.
    #[test]
    fn u_agl_flat_holds() {
        // Flat sea-level terrain (radius R_WORLD everywhere).
        let terr = |_lat: f32, _lon: f32| R_WORLD;
        // Start at the target AGL so it should just hold.
        let mut p = level_craft(TARGET_AGL, 200.0, 0.5);
        // Settle.
        run_terr(&mut p, 4.0, 0.0, 0.0, &terr);
        let (mut amin, mut amax) = (f32::INFINITY, 0.0_f32);
        let dt = 1.0 / 60.0;
        for s in 0..(20.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, Some(&terr));
            let a = agl_below(&p, &terr);
            amin = amin.min(a);
            amax = amax.max(a);
            if s % 360 == 0 {
                println!("[agl-flat] t={:.0}s AGL={:.1} wu ({:.0} m)", s as f32 * dt, a, a * M_PER_WU);
            }
        }
        println!("[agl-flat] AGL band [{:.2},{:.2}] wu target={:.2} ({:.0} m) drift={:.3} wu",
            amin, amax, TARGET_AGL, TARGET_AGL * M_PER_WU, amax - amin);
        // Holds near target with negligible bob.
        assert!((amin - TARGET_AGL).abs() < 0.15 && (amax - TARGET_AGL).abs() < 0.15,
            "AGL didn't hold target: band [{amin},{amax}] target {TARGET_AGL}");
        assert!((amax - amin) < 0.05, "AGL bobbed on flat terrain: band [{amin},{amax}]");
    }

    // (v) COLLISION AVOIDANCE: facing a steep WALL at speed, the look-ahead RAISES the target in
    // time so the craft climbs and clears the wall (does not crash through / below it), then
    // glides back down to the contour clearance after the crest.
    #[test]
    fn v_agl_wall_collision_avoidance() {
        // A ridge centered at lon = LON_PEAK, half-width LON_HW, peak elevation PEAK_WU.
        const LON_PEAK: f32 = 12.0;
        const LON_HW: f32 = 9.0;
        const PEAK_WU: f32 = 600.0; // tall wall, well above the cruise clearance
        let terr = move |_lat: f32, lon: f32| {
            let t = (1.0 - (lon - LON_PEAK).abs() / LON_HW).max(0.0);
            R_WORLD + PEAK_WU * t
        };
        let mut p = level_craft(TARGET_AGL, 300.0, 0.6);
        let dt = 1.0 / 60.0;
        let mut min_agl_over_ridge = f32::INFINITY;
        let mut alt_at_peak = 0.0_f32;
        let mut alt_after = 0.0_f32;
        let a0 = p.position.length() - R_WORLD;
        let mut last_lon = 0.0_f32;
        for _ in 0..(40.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, Some(&terr));
            let (_lat, lon) = crate::heightfield::Heightfield::lat_lon_of(p.position);
            let alt = p.position.length() - R_WORLD;
            let agl = agl_below(&p, &terr);
            if (lon - LON_PEAK).abs() < LON_HW {
                min_agl_over_ridge = min_agl_over_ridge.min(agl);
            }
            if (lon - LON_PEAK).abs() < 0.3 {
                alt_at_peak = alt;
            }
            if lon > LON_PEAK + LON_HW + 2.0 {
                alt_after = alt;
            }
            if (lon - last_lon).abs() > 1.0 {
                println!("[agl-wall] lon={:.1}° alt={:.1} AGL={:.1} terr_below={:.1}",
                    lon, alt, agl, terr(0.0, lon) - R_WORLD);
                last_lon = lon;
            }
        }
        println!("[agl-wall] min_AGL_over_wall={:.2} alt@peak={:.1} alt_after={:.1} (start {:.1}, peak_terr {:.1})",
            min_agl_over_ridge, alt_at_peak, alt_after, a0, PEAK_WU);
        // Climbed to clear the wall: never plowed substantially into it.
        assert!(min_agl_over_ridge > -PEAK_WU * 0.05,
            "crashed into the wall: min AGL over it = {min_agl_over_ridge} (peak {PEAK_WU})");
        // Climbed essentially the full wall height to clear the crest.
        assert!(alt_at_peak > a0 + PEAK_WU * 0.9, "did not climb to clear the wall: alt@peak={alt_at_peak}");
        // After the crest it descends back toward the contour clearance (not still climbing).
        assert!(alt_after < alt_at_peak - PEAK_WU * 0.4,
            "did not descend after the wall: alt@peak={alt_at_peak} alt_after={alt_after}");
        assert!(alt_after < a0 + 50.0, "did not return to the low contour clearance: alt_after={alt_after}");
    }

    // (v2) VALLEY HUG: over a profile that RISES (hill) then FALLS (valley), the craft descends
    // INTO the valley tracking the floor + clearance — reaching a LOWER altitude over the valley
    // than the old peak-window behavior (which stayed at the hill's height). Asserts the
    // valley-floor clearance settles ≈ TARGET_AGL.
    #[test]
    fn v2_agl_valley_hug() {
        // A broad gentle hill then a return to sea level (the "valley" floor). Half-widths are
        // wide so slopes are shallow enough that collision-avoidance never kicks in — the craft
        // simply hugs the contour up and back down.
        const LON_HILL: f32 = 10.0;
        const LON_HW: f32 = 8.0;
        const HILL_WU: f32 = 200.0;
        let terr = move |_lat: f32, lon: f32| {
            let t = (1.0 - (lon - LON_HILL).abs() / LON_HW).max(0.0);
            R_WORLD + HILL_WU * t
        };
        let mut p = level_craft(TARGET_AGL, 150.0, 0.5);
        let dt = 1.0 / 60.0;
        let mut alt_at_hill = 0.0_f32;
        let mut valley_floor_agl = f32::INFINITY;
        let mut alt_in_valley = f32::INFINITY;
        let mut last_lon = 0.0_f32;
        for _ in 0..(60.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, Some(&terr));
            let (_lat, lon) = crate::heightfield::Heightfield::lat_lon_of(p.position);
            let alt = p.position.length() - R_WORLD;
            let agl = agl_below(&p, &terr);
            if (lon - LON_HILL).abs() < 0.3 {
                alt_at_hill = alt;
            }
            // The valley floor: well PAST the hill (back to sea level).
            if lon > LON_HILL + LON_HW + 4.0 {
                valley_floor_agl = valley_floor_agl.min(agl);
                alt_in_valley = alt_in_valley.min(alt);
            }
            if (lon - last_lon).abs() > 2.0 {
                println!("[agl-valley] lon={:.1}° alt={:.1} AGL={:.1} terr_below={:.1}",
                    lon, alt, agl, terr(0.0, lon) - R_WORLD);
                last_lon = lon;
            }
        }
        println!("[agl-valley] alt@hill={:.1} (hill_terr {:.0}) valley_floor_AGL={:.2} alt_in_valley={:.1} (target {:.2})",
            alt_at_hill, HILL_WU, valley_floor_agl, alt_in_valley, TARGET_AGL);
        // Climbed with the hill...
        assert!(alt_at_hill > TARGET_AGL + HILL_WU * 0.8, "did not hug up the hill: alt@hill={alt_at_hill}");
        // ...then DESCENDED into the valley far below the hill's height (the new contour-hug).
        assert!(alt_in_valley < alt_at_hill - HILL_WU * 0.6,
            "did not descend into the valley (stayed at peak height): valley alt {alt_in_valley} vs hill {alt_at_hill}");
        // Valley-floor clearance settles ≈ TARGET_AGL.
        assert!((valley_floor_agl - TARGET_AGL).abs() < TARGET_AGL * 0.5,
            "valley-floor clearance not ≈ TARGET_AGL: {valley_floor_agl} vs {TARGET_AGL}");
    }

    // (v3) LOW SKIM via set_target_agl: a SMALL clearance over rolling terrain holds a tight
    // band without bobbing.
    #[test]
    fn v3_agl_low_skim() {
        const AMP: f32 = 6.0;
        let terr = |_lat: f32, lon: f32| {
            R_WORLD + AMP * (0.5 + 0.5 * (lon.to_radians() * 3.0).sin())
        };
        const SKIM: f32 = 25.0; // tight low clearance
        let mut p = level_craft(SKIM, 200.0, 0.5);
        p.target_agl = SKIM;
        run_terr(&mut p, 12.0, 0.0, 0.0, &terr); // settle
        let dt = 1.0 / 60.0;
        let (mut amin, mut amax) = (f32::INFINITY, 0.0_f32);
        for s in 0..(25.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, Some(&terr));
            let a = agl_below(&p, &terr);
            amin = amin.min(a);
            amax = amax.max(a);
            if s % 600 == 0 {
                println!("[agl-skim] t={:.0}s AGL={:.1}", s as f32 * dt, a);
            }
        }
        println!("[agl-skim] target={:.0} AGL band [{:.2},{:.2}] span={:.2}", SKIM, amin, amax, amax - amin);
        assert!(amin > 0.0, "skim dropped to/through the ground: min {amin}");
        assert!((amin - SKIM).abs() < SKIM && (amax - SKIM).abs() < SKIM,
            "skim clearance not tight near target: band [{amin},{amax}] target {SKIM}");
        assert!((amax - amin) < SKIM, "skim bobbed: band [{amin},{amax}]");
    }

    // (v4) Combined HILL → VALLEY → WALL trace: prints the AGL + altitude trace, proving the
    // craft descends into the valley yet climbs to clear the wall.
    #[test]
    fn v4_agl_hill_valley_wall_trace() {
        // hill at lon 8 (gentle, 150 wu), valley (sea level) lon ~16-26, steep wall at lon 32.
        let terr = |_lat: f32, lon: f32| {
            let hill = (1.0 - (lon - 8.0).abs() / 6.0).max(0.0) * 150.0;
            let wall = (1.0 - (lon - 32.0).abs() / 4.0).max(0.0) * 500.0;
            R_WORLD + hill.max(wall)
        };
        let mut p = level_craft(TARGET_AGL, 250.0, 0.55);
        let dt = 1.0 / 60.0;
        let mut last_lon = -10.0_f32;
        let mut min_agl_at_wall = f32::INFINITY;
        let mut min_alt_in_valley = f32::INFINITY;
        for _ in 0..(60.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, Some(&terr));
            let (_lat, lon) = crate::heightfield::Heightfield::lat_lon_of(p.position);
            let alt = p.position.length() - R_WORLD;
            let agl = agl_below(&p, &terr);
            if (16.0..26.0).contains(&lon) {
                min_alt_in_valley = min_alt_in_valley.min(alt);
            }
            if (lon - 32.0).abs() < 4.0 {
                min_agl_at_wall = min_agl_at_wall.min(agl);
            }
            if lon - last_lon >= 2.0 {
                println!("[agl-hvw] lon={:.1}° terr={:.0} alt={:.1} AGL={:.1}",
                    lon, terr(0.0, lon) - R_WORLD, alt, agl);
                last_lon = lon;
            }
        }
        println!("[agl-hvw] min_alt_in_valley={:.1} min_AGL_at_wall={:.2}", min_alt_in_valley, min_agl_at_wall);
        // Descended into the valley (low altitude, near TARGET_AGL above sea level).
        assert!(min_alt_in_valley < TARGET_AGL + 60.0,
            "did not descend into the valley: min alt {min_alt_in_valley}");
        // Cleared the wall (did not plow through).
        assert!(min_agl_at_wall > -500.0 * 0.05, "crashed into the wall: min AGL {min_agl_at_wall}");
    }

    // (w) ROLLING terrain: no bob/oscillation (critical damping). Sinusoidal gentle hills →
    // AGL stays in a tight band, no growing ringing.
    #[test]
    fn w_agl_rolling_no_bob() {
        // Gentle rolling hills: elev = AMP·(0.5 + 0.5·sin(lon·k)). Low amplitude, long period
        // (a wavelength of ~12° of arc, ~1250 wu) so the craft can comfortably follow them —
        // the point is to confirm the controller does NOT add a growing bob/ringing.
        const AMP: f32 = 8.0;
        let terr = |_lat: f32, lon: f32| {
            R_WORLD + AMP * (0.5 + 0.5 * (lon.to_radians() * 3.0).sin())
        };
        // Start AT the target so we measure steady tracking, not a big descent transient.
        let mut p = level_craft(TARGET_AGL + AMP * 0.5, 250.0, 0.55);
        run_terr(&mut p, 12.0, 0.0, 0.0, &terr); // settle onto the terrain
        let dt = 1.0 / 60.0;
        let (mut amin, mut amax) = (f32::INFINITY, 0.0_f32);
        for s in 0..(25.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, 1.0, Some(&terr));
            let a = agl_below(&p, &terr);
            amin = amin.min(a);
            amax = amax.max(a);
            if s % 600 == 0 {
                println!("[agl-rolling] t={:.0}s AGL={:.1}", s as f32 * dt, a);
            }
        }
        println!("[agl-rolling] AGL band [{:.2},{:.2}] (target {:.2}) span={:.2} wu",
            amin, amax, TARGET_AGL, amax - amin);
        // Stays above the ground (positive clearance) and within a bounded band — no runaway bob.
        assert!(amin > TARGET_AGL * 0.3, "rolling terrain clearance dropped too low: min {amin}");
        assert!((amax - amin) < TARGET_AGL * 1.5, "AGL bobbed over rolling terrain: band [{amin},{amax}]");
    }

    // (x) MANUAL pitch OVERRIDES terrain-follow, and auto re-engages hands-off.
    #[test]
    fn x_agl_manual_override() {
        let terr = |_lat: f32, _lon: f32| R_WORLD; // flat
        let mut p = level_craft(TARGET_AGL, 300.0, 0.6);
        run_terr(&mut p, 3.0, 0.0, 0.0, &terr); // settle at target AGL
        let agl_settled = agl_below(&p, &terr);
        // Pitch UP: must climb ABOVE the follow altitude (manual wins).
        run_terr(&mut p, 4.0, 0.0, 0.6, &terr);
        let agl_pitched = agl_below(&p, &terr);
        println!("[agl-override] settled AGL={:.2}, after pitch-up AGL={:.2}", agl_settled, agl_pitched);
        assert!(agl_pitched > agl_settled + 5.0, "manual pitch-up did not override terrain-follow: {agl_settled} -> {agl_pitched}");
        // Release pitch (hands-off): terrain-follow re-engages and pulls back DOWN toward target.
        run_terr(&mut p, 30.0, 0.0, 0.0, &terr);
        let agl_reengaged = agl_below(&p, &terr);
        println!("[agl-override] after release AGL={:.2} (target {:.2})", agl_reengaged, TARGET_AGL);
        assert!(agl_reengaged < agl_pitched - 5.0, "terrain-follow did not re-engage after release: {agl_pitched} -> {agl_reengaged}");
        assert!((agl_reengaged - TARGET_AGL).abs() < TARGET_AGL * 0.6, "did not settle back near target: {agl_reengaged} vs {TARGET_AGL}");
    }

    // ===== VE-CONSISTENT AGL tests (target/HUD in VE-exaggerated meters) =====
    //
    // These drive `step` with the REAL conversion `agl_scale = VERT_SCALE·ve/VERT_EXAGGERATION`
    // (= ve/M_PER_WU), and build terrain from real elevations in meters scaled the SAME way the
    // renderer draws them (`elev_m · VERT_SCALE · ve/VERT_EXAGGERATION`). So a clearance set in
    // exaggerated meters skims the same exaggerated distance above the visible ridges.

    use crate::heightfield::{VERT_EXAGGERATION, VERT_SCALE, VE_NEAR};

    // AGL directly below in EXAGGERATED METERS (the wu clearance / agl_scale), the same space the
    // HUD `agl_m()` reports and `target_agl` is set in.
    fn agl_below_m(p: &Physics, terr: &dyn Fn(f32, f32) -> f32, agl_scale: f32) -> f32 {
        let (lat, lon) = crate::heightfield::Heightfield::lat_lon_of(p.position);
        (p.position.length() - terr(lat, lon)) / agl_scale
    }

    // (y1) SKIM THE SCALED RIDGES: with target_agl ≈ 500 exaggerated-m over mountainous terrain
    // (a 4808 m alp), the craft holds a clearance ≈ 500 in scaled meters that is just ABOVE the
    // exaggerated terrain (clearance_wu ≈ 500·VERT_SCALE·ve/VERT_EXAGGERATION ≈ ~1.3 wu at
    // near-surface ve), hugging valleys, no bob.
    #[test]
    fn y1_skim_scaled_ridges() {
        let ve = VE_NEAR;
        let agl_scale = VERT_SCALE * ve / VERT_EXAGGERATION; // wu per exaggerated meter
        let ve_ratio = ve / VERT_EXAGGERATION;
        // Rolling alpine terrain: peaks ~3000 m, valleys ~300 m, rendered VE-exaggerated.
        let terr = move |_lat: f32, lon: f32| {
            let elev_m = 1650.0 + 1350.0 * (lon.to_radians() * 4.0).sin();
            R_WORLD + elev_m * VERT_SCALE * ve_ratio
        };
        let mut p = level_craft(60.0, 200.0, 0.5); // initial alt arbitrary; will settle onto hold
        p.target_agl = DEFAULT_TARGET_AGL; // 500 exaggerated meters
        let dt = 1.0 / 60.0;
        // Settle onto the hold.
        for _ in 0..(15.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, agl_scale, Some(&terr));
        }
        let (mut amin, mut amax) = (f32::INFINITY, 0.0_f32);
        let (mut wu_min, mut wu_max) = (f32::INFINITY, 0.0_f32);
        let mut last_lon = -100.0;
        for _ in 0..(25.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, agl_scale, Some(&terr));
            let (_lat, lon) = crate::heightfield::Heightfield::lat_lon_of(p.position);
            let m = agl_below_m(&p, &terr, agl_scale);
            let wu = m * agl_scale;
            amin = amin.min(m); amax = amax.max(m);
            wu_min = wu_min.min(wu); wu_max = wu_max.max(wu);
            if lon - last_lon >= 3.0 {
                println!("[skim] lon={:.1}° terr_elev_m={:.0} AGL={:.0} scaled-m ({:.2} wu)",
                    lon, (terr(0.0, lon) - R_WORLD) / (VERT_SCALE * ve_ratio), m, wu);
                last_lon = lon;
            }
        }
        println!("[skim] target=500 scaled-m | AGL band [{:.0},{:.0}] scaled-m  [{:.2},{:.2}] wu (agl_scale={:.4} wu/m)",
            amin, amax, wu_min, wu_max, agl_scale);
        // Holds ~500 scaled-m, just above the visible exaggerated ridges, ~1–1.5 wu of clearance.
        assert!(amin > 0.0, "skim dropped through the ground: min {amin} scaled-m");
        assert!((amin - 500.0).abs() < 250.0 && (amax - 500.0).abs() < 250.0,
            "scaled clearance not near 500: band [{amin},{amax}]");
        assert!((0.8..2.5).contains(&wu_max), "clearance not ~1–1.5 wu above terrain: {wu_max} wu");
        assert!((amax - amin) < 300.0, "skim bobbed: band [{amin},{amax}] scaled-m");
    }

    // (y2) HUD CONSISTENCY: over flat ground, the AGL reads ≈ the set target in scaled meters
    // (~500), NOT ~10000 (the old un-exaggerated reading). Checks the conversion both ways.
    #[test]
    fn y2_hud_consistency_flat() {
        let ve = VE_NEAR;
        let agl_scale = VERT_SCALE * ve / VERT_EXAGGERATION;
        let terr = |_lat: f32, _lon: f32| R_WORLD; // flat sea level
        let mut p = level_craft(60.0, 200.0, 0.5);
        p.target_agl = 500.0; // 500 exaggerated meters
        let dt = 1.0 / 60.0;
        for _ in 0..(20.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, agl_scale, Some(&terr));
        }
        let m = agl_below_m(&p, &terr, agl_scale);
        let wu = m * agl_scale;
        println!("[hud] target=500 scaled-m | settled AGL={:.1} scaled-m ({:.3} wu); old un-exag reading would be {:.0} m",
            m, wu, wu * M_PER_WU);
        assert!((m - 500.0).abs() < 30.0, "HUD AGL not ≈ target 500 scaled-m: {m}");
        // Sanity: the OLD (un-exaggerated) reading would have been ~10000 m — confirm the new
        // scaled reading is far smaller, i.e. consistent with the exaggerated terrain.
        assert!(wu * M_PER_WU > 1000.0, "un-exag check sanity");
    }

    // (y3) COLLISION AVOIDANCE at ATMO speed in scaled space: a steep alpine WALL (4808 m,
    // VE-exaggerated) — the craft climbs in time to clear it (does not clip through), skimming a
    // low ~500 scaled-m clearance otherwise.
    #[test]
    fn y3_scaled_wall_collision_avoidance() {
        let ve = VE_NEAR;
        let agl_scale = VERT_SCALE * ve / VERT_EXAGGERATION;
        let ve_ratio = ve / VERT_EXAGGERATION;
        const LON_PEAK: f32 = 12.0;
        const LON_HW: f32 = 6.0;
        const PEAK_M: f32 = 4808.0; // Mont Blanc-ish, rendered exaggerated
        let terr = move |_lat: f32, lon: f32| {
            let t = (1.0 - (lon - LON_PEAK).abs() / LON_HW).max(0.0);
            R_WORLD + PEAK_M * t * VERT_SCALE * ve_ratio
        };
        let mut p = level_craft(60.0, 300.0, 0.6); // ATMO speed
        p.target_agl = 500.0;
        let dt = 1.0 / 60.0;
        let mut min_agl_over_ridge_wu = f32::INFINITY;
        let peak_wu = PEAK_M * VERT_SCALE * ve_ratio;
        for _ in 0..(40.0 / dt) as usize {
            p.step(dt, 0.0, 0.0, 0.0, 0.0, 0.0, false, agl_scale, Some(&terr));
            let (lat, lon) = crate::heightfield::Heightfield::lat_lon_of(p.position);
            let agl_wu = p.position.length() - terr(lat, lon);
            if (lon - LON_PEAK).abs() < LON_HW {
                min_agl_over_ridge_wu = min_agl_over_ridge_wu.min(agl_wu);
            }
        }
        println!("[scaled-wall] peak={:.1} wu ({:.0} m exaggerated) | min AGL over wall = {:.2} wu",
            peak_wu, peak_wu * M_PER_WU, min_agl_over_ridge_wu);
        // Cleared the wall — never plowed substantially into it.
        assert!(min_agl_over_ridge_wu > -peak_wu * 0.05,
            "clipped through the scaled wall: min AGL over it = {min_agl_over_ridge_wu} wu (peak {peak_wu})");
    }

    // (h) Stability: dt=0.05 cap, long run → no NaN/blowup.
    #[test]
    fn h_stable_at_dt_cap() {
        let mut p = level_craft(400.0, 600.0, 1.0);
        for _ in 0..2000 {
            p.step(0.05, 1.0, 0.0, 0.0, 0.0, 0.0, true, 1.0, None);
            assert!(p.position.is_finite() && p.velocity.is_finite(), "NaN/blowup");
            assert!(p.speed <= V_CAP + 1e-2);
        }
        println!("[dtcap] alt={:.0} speed={:.0}", alt(&p), p.speed);
    }
}
