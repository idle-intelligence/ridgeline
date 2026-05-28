# Ridgeline flight physics

## Overview

Arcade flight that **decouples speed from altitude** and runs **three named modes**, derived
from altitude and **crossfaded by smoothstep** so transitions are seamless (only the HUD label
flips at a boundary; the physics is continuous — no discrete switch, no NaN):

- **ATMO** (`alt 0 .. ATMOSPHERE_TOP = 1500` wu) — slow + dense/draggy **fly-by-nose**.
  Throttle sets a *target speed* (`IDLE_SPEED 30 .. CRUISE_MAX 400`); **quadratic drag**
  (∝ density·v²) makes the top speed asymptotic and bleeds speed to idle in ~2–3 s when you cut
  throttle (the "dense, hard to leave" feel). The craft flies where its nose points; a level
  nose holds altitude, pitch climbs/dives, below `STALL_SPEED` the wings give up. Hands-off the
  nose auto-levels. Hands-off, **AGL terrain-following** holds a small clearance above the
  terrain DIRECTLY BELOW (hugs the contour, dips into valleys) while still climbing to clear
  upcoming walls (see "AGL terrain-following" below); manual pitch overrides it.
- **ORBIT** (`alt ~ATMOSPHERE_TOP .. ORBIT_TOP = 12000` wu) — faster, thin air (low drag),
  speed envelope `ORBIT_IDLE 1000 .. ORBIT_CAP 3000`. A **gentle critically-damped altitude
  hold** (`ORBIT_HOLD_RATE`, crossfaded down from the stiff ATMO hold) curves the velocity to
  follow the sphere → **near-circular hold**, easy to raise/lower with pitch. The hold fades out
  toward `ORBIT_TOP` so pointing out + accelerating climbs **freely** to INTERPLANETARY (never a
  prison).
- **INTERPLANETARY** (`alt > ORBIT_TOP`) — free **Newtonian** inertia + inverse-square gravity,
  up to the hard `V_CAP`. You coast: `velocity += gravity·dt + nose·thrust·dt`; orientation aims
  thrust, not the velocity direction. The **capture-zone assist** (below) eases a returning ship
  back down (INTERPLANETARY → ORBIT re-entry).

**Per-mode speed caps are crossfaded** by altitude via `eff_cap(r)`: `CRUISE_MAX (400)` →
`ORBIT_CAP (3000)` → `V_CAP (10000)`, ratio ≈ **1 : 7.5 : 25**, blended by smoothstep across the
band boundaries (no jump). A **hard speed cap** (`V_CAP`) clamps `|velocity|` every step in all
modes, so thrust in vacuum can never run away (kills the old "billion km/h" bug).

**Rotational inertia (attitude):** the attitude has rotational MASS. The pitch/yaw/roll input
commands set a *target* body-frame angular velocity; the *actual* angular velocity (`ang_vel`)
eases toward it with a **first-order lag** (`ang_vel += (target − ang_vel)·(1 − e^(−dt/τ))`), and
the orientation is integrated from the EASED rate. So starting a turn RAMPS UP and releasing it
RAMPS DOWN (coasts to a stop) instead of snapping — the craft feels weighty but responsive, and
attitude change LAGS the raw stick. The time constant `τ = ATTITUDE_TAU + ATTITUDE_TAU_FAST_EXTRA
· clamp(speed/ORBIT_CAP, 0, 1)` grows a touch with speed, so the very fast ORBIT craft SETTLES
(no "bouncing on instant input") while ATMO stays nimble. The same gentle lag applies to the A/E
rudder (yaw) — consistent, not sluggish. The `exp` form is exact at any `dt` (stable at the
`dt = 0.05` cap). See "Rotational inertia" below for the tunable knobs.

**Coordinated banking:** in ATMO/ORBIT a roll-induced bank angle couples into yaw
(`yaw += BANK_GAIN · sin(bank) · clamp(speed/CRUISE_MAX,0,1) · fly_w`), so rolling banks you into
a turn (reads as "a plane," no rudder needed). Faded out in free space.

## State

| Variable | Type | Description |
|---|---|---|
| `orientation` | `Quat` | Body-to-world rotation |
| `position` | `Vec3` | World-space position |
| `velocity` | `Vec3` | World-space velocity (wu/s) |
| `throttle` | `f32 ∈ [0, 1]` | Engine throttle (gas pedal) |
| `speed` | `f32 ≥ 0` | `|velocity|`, cached for the HUD |
| `ang_vel` | `Vec3` | ACTUAL body-frame angular velocity `(pitch, yaw, roll)` rad/s — eased toward the input command (rotational inertia) |

## Speed model (throttle → target, hard cap)

```
throttle += thrust_axis * THROTTLE_RATE * dt        (clamped 0..1; hands-off holds)
top       = ftl ? FTL_MAX : CRUISE_MAX
v_target  = lerp(IDLE_SPEED, top, throttle)  capped to V_CAP
```

Current speed eases toward `v_target` under bounded acceleration `SPEED_ACCEL`, and
`|velocity| ≤ V_CAP` is enforced every step. `THROTTLE_RATE` is deliberately **slow** (a full
0→1 sweep takes ≈ 3.3 s) so taps give FINE adjustment — the pilot can settle at many distinct
intermediate cruise speeds across `IDLE_SPEED..CRUISE_MAX` instead of snapping min↔max. The HUD
shows the current throttle as `THR nn%` (`Engine::throttle()` → f32 0..1).

| Constant | Value | Notes |
|---|---|---|
| `IDLE_SPEED` | 30 wu/s | ATMO hands-off / zero-throttle floor — the slowest cruise; held at low alt |
| `CRUISE_MAX` | 400 wu/s | ATMO full-throttle terminal (asymptotic under quadratic drag) |
| `ORBIT_IDLE` | 1000 wu/s | ORBIT-band zero-throttle speed (thin air) |
| `ORBIT_CAP` | 3000 wu/s | ORBIT full-throttle ceiling |
| `FTL_MAX` | 8000 wu/s | afterburner (INTERPLANETARY) terminal |
| `V_CAP` | 10000 wu/s | ABSOLUTE hard cap (≈ 38 M km/h at planet scale) |
| `DRAG_K` | 0.0085 /wu | quadratic ATMO drag `a = DRAG_K·density·v²` (asymptotic top, ~1.6 s bleed) |
| `ATMOSPHERE_TOP` | 1500 wu | ATMO/ORBIT boundary (`R_WORLD·0.25`) |
| `ORBIT_TOP` | 12000 wu | ORBIT/INTERPLANETARY boundary (`R_WORLD·2`) |
| `ORBIT_HOLD_RATE` | 30 s⁻¹ | gentle ORBIT altitude hold (vs stiff `ALT_HOLD_RATE = 80`) |
| `BANK_GAIN` | 0.9 | roll→yaw coordinated-turn gain |
| `SPEED_ACCEL` | 1200 wu/s² | spool-up/down rate toward `v_target` |
| `THROTTLE_RATE` | 0.3 s⁻¹ | throttle ramp (slow → granular, holdable settings) |

The target speed crossfades per mode: `idle = lerp(IDLE_SPEED, ORBIT_IDLE, orbit_w)`,
`top = lerp(CRUISE_MAX, ORBIT_CAP, orbit_w)` (afterburner raises `top` toward `FTL_MAX`), then
`v_target = lerp(idle, top, throttle)` clamped to `eff_cap(r)`.

Planet circumference ≈ `2π·R_WORLD ≈ 37700 wu`, so the tiers give pleasant lap times rather
than a fraction of a second.

## Rotational inertia (attitude feel)

The attitude is NOT applied instantly. Per step, the (clamped, bank-coupled) pitch/yaw/roll input
is a **target** body-frame angular velocity `target_rate`; the persisted **actual** rate `ang_vel`
eases toward it with an exact first-order lag, and the orientation integrates from the eased rate:

```
spd_frac = clamp(speed / ORBIT_CAP, 0, 1)
τ        = ATTITUDE_TAU + ATTITUDE_TAU_FAST_EXTRA · spd_frac     (time constant, s)
blend    = 1 − exp(−dt / τ)
ang_vel += (target_rate − ang_vel) · blend
orientation = orientation · yaw(ang_vel.y·dt) · pitch(ang_vel.x·dt) · roll(ang_vel.z·dt)
```

A step input reaches ~63 % of the commanded rate in `τ` and ~95 % in `3τ`, so a turn **ramps up**
when the stick goes over and **ramps down** (coasts) when it's released — the craft has rotational
mass. The time constant **grows with speed** so the very fast ORBIT craft SETTLES rather than
darting on instant input (kills the "bounces around" feel), while ATMO stays responsive. The A/E
rudder (yaw) gets the SAME gentle lag — weighty, not sluggish.

The engage gates that read the RAW input (afterburner ascent-assist, hands-off auto-level,
manual-pitch altitude-hold override) are **unchanged** — they still key off the raw command, so
releasing the stick re-engages auto-level immediately while the residual `ang_vel` coasts the
nose to a smooth stop. The `exp` form is exact at any `dt` (no overshoot; stable at the
`dt = 0.05` cap).

This is a **feel feature** — `ATTITUDE_TAU` is the single knob (lower = snappier, higher =
heavier); `ATTITUDE_TAU_FAST_EXTRA` adds the extra orbit-speed damping.

| Constant | Value | Notes |
|---|---|---|
| `ATTITUDE_TAU` | 0.22 s | attitude lag time constant at ATMO speeds ("weighty but responsive") |
| `ATTITUDE_TAU_FAST_EXTRA` | 0.18 s | extra τ blended in by `speed/ORBIT_CAP` (orbit damping → settles, no bounce) |

## ATMO + ORBIT regime (fly-by-nose)

The same fly-by-nose term serves both ATMO and ORBIT; per-mode behavior crossfades by
`orbit_w = orbit_blend(r)` (0 in ATMO, 1 in the heart of ORBIT, 0 above `ORBIT_TOP`).

1. Ease scalar speed toward `v_target`, then subtract **quadratic drag** `DRAG_K·density·v²`
   (ATMO only; fades with density). The drag makes the top speed asymptotic and bleeds speed to
   idle in ~2–3 s when throttle is cut.
2. Steer the unit velocity direction toward the nose (`orientation*-Z`) at `TURN_RATE` — the
   craft goes where it points.
3. **Altitude hold**: with no pitch input the direction's radial (climb/sink) component is
   driven to a **commanded radial** at a rate that crossfades from the stiff `ALT_HOLD_RATE`
   (ATMO: pinned) to the gentle `ORBIT_HOLD_RATE` (ORBIT: loose near-circular hold, easy to
   raise/lower); with pitch input it's driven to match the nose's radial component (climb/dive).
   The commanded radial is **AGL terrain-following** in ATMO (see below), crossfading by
   `orbit_w` to `0` (level) in the ORBIT band. The hold fades out toward `ORBIT_TOP`, handing off
   to free Newtonian flight (easy escape).
4. **Stall**: authority `= stall³` where `stall` ramps 0→1 from `0.5·STALL_SPEED` to
   `STALL_SPEED`. As speed bleeds off, fly-by-nose authority collapses and the gravity sink
   term `g·(1 − authority)·dt` takes over → you fall. So you must keep speed up to stay up.
5. **Hands-off auto-level**: with no pitch/roll input the *nose* also rotates toward the local
   horizon (`AUTO_LEVEL_RATE`) so the visible attitude stays level.

| Constant | Value | Notes |
|---|---|---|
| `TURN_RATE` | 3.0 s⁻¹ | velocity-direction → nose steering |
| `ALT_HOLD_RATE` | 80 s⁻¹ | ATMO radial-component → commanded (stiff level pin) |
| `ORBIT_HOLD_RATE` | 30 s⁻¹ | ORBIT gentle near-circular hold (crossfaded from `ALT_HOLD_RATE` by `orbit_w`) |
| `DRAG_K` | 0.0085 /wu | quadratic ATMO drag (asymptotic top, ~1.6 s bleed) |
| `BANK_GAIN` | 0.9 | roll→yaw coordinated-turn coupling (ATMO/ORBIT) |
| `AUTO_LEVEL_RATE` | 2.5 s⁻¹ | hands-off nose leveling |
| `STALL_SPEED` | 18 wu/s | below this fly-by-nose fades; set BELOW `IDLE_SPEED` (30) so the slowest cruise HOLDS altitude — only a genuine crawl stalls |

## AGL terrain-following (ATMO)

Hands-off in ATMO, the altitude-hold's commanded radial is set by an **above-ground-level (AGL)
terrain-following** controller — the craft holds a small clearance above the terrain **directly
below** (it HUGS THE CONTOUR: it descends into valleys with the floor, not stuck at the upcoming
peak's height), while still climbing in time to clear an upcoming steep wall (collision
avoidance).

Per step (only when the pilot is NOT pitching; manual pitch overrides and terrain-follow yields,
re-engaging the instant pitch is released):

1. **Ground track**: project velocity onto the local tangent plane → the forward ground track.
2. **Hold reference = ground below.** Sample the terrain radius DIRECTLY BELOW (`terrain_below`)
   and set the baseline `desired_r = terrain_below + target_agl · agl_scale`, where `agl_scale`
   converts the clearance from VE-exaggerated meters to wu with the live render `ve` (see
   "VE-CONSISTENT clearance" below). So over a valley the target drops with the valley floor
   (contour hug), instead of staying at the peak ahead.
3. **Look-ahead = collision avoidance only.** Sample `AGL_SAMPLES = 8` terrain radii evenly along
   the track out to `LOOKAHEAD = clamp(speed·LOOKAHEAD_TIME, LOOKAHEAD_MIN, LOOKAHEAD_MAX)`. For
   each ahead sample at distance `d`, the time to reach it is `t = d/speed`; climbing at most
   `AGL_MAX_CLIMB` the craft must ALREADY be at radius ≥ `terrain_ahead + AGL_SAFETY_MARGIN −
   AGL_MAX_CLIMB·t` now to clear it. The target is `desired_r = max(ground-below baseline,
   max_i(required-now_i))`. So rolling/valley terrain (low ahead samples) leaves the target at
   ground-below (you descend with it), while a steep wall at speed RAISES the target early enough
   to pull up — replacing the old peak-max-window (which kept you at peak height over valleys).
   The window scales with speed (faster ⇒ react earlier).
4. **Critically-damped radial controller**: `err = desired_r − |pos|`,
   `climb = clamp(AGL_K · err, −AGL_MAX_SINK, AGL_MAX_CLIMB)`. Because
   the fly-by-nose altitude-hold has near-full authority each step (it snaps the velocity's radial
   component onto the command in one frame), the AGL command is effectively a **velocity** command,
   so a first-order proportional command (`AGL_K · err`) is **inherently critically damped** — it
   eases toward the target with a ~`1/AGL_K` time constant and **cannot overshoot or bob** (no
   oscillation). An explicit `−C·radial_v` damping term — correct for a pure *acceleration*
   command — would instead *destabilise* this one-frame velocity command, so it's folded into the
   first-order response. The rate clamp is asymmetric (climbs harder than it sinks) so it clears
   rising terrain crisply and glides down gently after a crest.
5. **Feed the seam**: `commanded_radial = clamp(climb/max(speed,1), −1, 1) · (1 − orbit_w)`. The
   `(1 − orbit_w)` crossfade fades terrain-follow out across the ATMO/ORBIT boundary into the
   ORBIT level near-circular hold — no discontinuity.

**VE-CONSISTENT clearance (the key fix).** The terrain is drawn VERTICALLY EXAGGERATED — its
radius is `R_WORLD + elev_m · VERT_SCALE · (ve/VERT_EXAGGERATION)`, so a 4808 m alp rises ~12.5 wu
at near-surface `ve`. The clearance is therefore expressed in the **terrain's OWN exaggerated
vertical scale** (VE-exaggerated meters) and converted to wu **per-frame** with the LIVE render
`ve`:

```
agl_scale = VERT_SCALE · ve / VERT_EXAGGERATION      (= ve / M_PER_WU)   [wu per exaggerated meter]
agl_wu    = target_agl_m · agl_scale                  → desired_r = terrain_below + agl_wu
```

So the held clearance is exaggerated by the SAME `ve` as the ground and skims just above the
*visible* ridges. At near-surface `ve = VE_NEAR = 2.75`, 500 exaggerated-m ≈ **1.3 wu** of
clearance — hugging the relief rather than the old 0.47 wu (un-exaggerated 500 m) that sat far
below the ridges. `agl_scale` is computed in `lib.rs::step` from the live render `ve` (the
`ve_for_altitude` ramp or the exaggeration override) and passed into `Physics::step`.

**Terrain AS RENDERED.** The terrain radius (`Heightfield::terrain_radius_at(lat,lon, ve)` =
`R_WORLD + terrain_elev · ve/VERT_EXAGGERATION`) uses the same `ve` the renderer draws, so both
the ground reference AND the clearance use the same exaggeration — fully consistent with what the
player SEES.

**Tunable clearance.** The default is `DEFAULT_TARGET_AGL = 500` exaggerated-m — a pleasant skim
just above the visible ridges. Runtime-tunable per craft via `Physics::target_agl` /
`Engine::set_target_agl(agl_m)` (now in exaggerated meters, NOT wu), clamped to
`[TARGET_AGL_MIN = 80, TARGET_AGL_MAX = 60000]` exaggerated-m. The web layer exposes it as the
**`?agl=<meters>` URL param**, passed straight through (no `M_PER_WU` conversion — the per-frame
`ve` scaling happens in `step`), just clamped. No param → the default. `set_spawn` preserves a
runtime-set value across respawns.

**HUD-AGL**: `Engine::agl_m()` = `(|pos| − terrain_radius_below) / agl_scale` (clamped ≥ 0, same
`ve`) — the clearance in the SAME VE-exaggerated meters, so over flat ground at the default it
reads ≈ 500 (not ~10000). Shown in the web HUD as `AGL nnnm` in ATMO alongside `ALT`. Over ocean
(terrain 0) the *wu* heights of AGL and ALT coincide, but they report in different scales (AGL in
exaggerated meters, ALT in un-exaggerated meters).

| Constant | Value | Notes |
|---|---|---|
| `DEFAULT_TARGET_AGL` | 500 exag-m | default clearance above the terrain DIRECTLY BELOW, in VE-exaggerated meters (contour hug); runtime-tunable |
| `TARGET_AGL_MIN` / `MAX` | 80 / 60000 exag-m | clamp on the runtime-settable target AGL (`set_target_agl` / `?agl=`) |
| `LOOKAHEAD_TIME` | 3 s | forward window = `clamp(speed·time, min, max)` (collision avoidance) |
| `LOOKAHEAD_MIN` / `MAX` | 30 / 600 wu | look-ahead distance clamp |
| `AGL_SAMPLES` | 8 | collision-avoidance samples along the forward track |
| `AGL_SAFETY_MARGIN` | 30 wu | extra clearance demanded above an upcoming wall |
| `AGL_K` | 4.0 s⁻¹ | first-order velocity-command gain (inherently critically damped) |
| `AGL_MAX_CLIMB` / `SINK` | 200 / 50 wu/s | asymmetric climb/sink rate clamp (climb-fast, glide-gentle) |

## Afterburner ascent-assist (one-button climb to orbit / escape)

Holding the afterburner (`ftl` = Space) with **no manual attitude input** engages a hands-off
**gravity-turn climb**: a one-button arc from ATMO up to ORBIT, and — held longer — on to escape.

**Engage / disengage.** The assist is engaged when `ftl` is held AND BOTH `|pitch|` and `|roll|`
input commands are within `ASSIST_INPUT_DEADZONE`. Any real pitch/roll **disengages** it (the
afterburner then just raises the speed cap → normal manual flight); it **re-engages** the instant
steering stops while `ftl` is still held.

**Gravity-turn auto-pitch.** While engaged, the nose eases toward a CLIMB attitude above the local
horizon — `climb_angle = lerp(ASCENT_CLIMB_STEEP_DEG, ASCENT_CLIMB_SHALLOW_DEG, t)` where
`t = smoothstep(ATMOSPHERE_TOP·0.5, ATMOSPHERE_TOP + 0.3·(ORBIT_TOP−ATMOSPHERE_TOP), alt)`. So it's
STEEP (60°) near the surface and has SHALLOWED to near-horizontal (5°) by ~30 % into the orbit band.
The nose eases toward this target at `ASCENT_PITCH_RATE` (gentle, a few seconds) so the trajectory
is a smooth curved ARC, not a kink. The altitude-hold's commanded radial follows the (climbing)
nose — exactly the manual-pitch path — so the velocity actually arcs upward, and the afterburner
(FTL cap) builds speed during the climb. The hands-off auto-level is suppressed while engaged.

**Level into orbit.** Because the climb has shallowed to near-horizontal by the lower part of the
orbit band, the gentle ORBIT altitude-hold (`ORBIT_HOLD_RATE`) catches the craft and it **settles**
into orbit rather than shooting straight past. From an ATMO cruise, holding `ftl` crosses into the
ORBIT band in **~2–3 s** and stabilizes there; easing `ftl` then holds the orbit.

**Escape on sustained hold.** Keep holding `ftl` (with throttle up) and speed keeps building (FTL
cap) and the shallow climb keeps gaining altitude → past `ORBIT_TOP` into INTERPLANETARY in **~5–6
s** (escape the gravity well). So a **tap ≈ orbit, a long hold ≈ escape**. Above `ORBIT_TOP` the
fly-by-nose term has faded and the Newtonian space term carries the climb (thrust along the nose).

**Release.** Dropping `ftl` ends the assist; the craft settles into the current mode (ORBIT holds
altitude near-circular, etc.) — it does not fall back to the ground.

| Constant | Value | Notes |
|---|---|---|
| `ASSIST_INPUT_DEADZONE` | 1e-3 rad/s | engage only when both |pitch| and |roll| are under this |
| `ASCENT_CLIMB_STEEP_DEG` | 60° | climb angle above horizon near the surface (steep pull-up) |
| `ASCENT_CLIMB_SHALLOW_DEG` | 5° | climb angle entering ORBIT (near-level → orbit hold catches it) |
| `ASCENT_PITCH_RATE` | 1.2 s⁻¹ | rate the nose eases toward the climb attitude (smooth arc) |

This is a **feel feature** — the angles, ease rate, and shallowing band are tunable knobs.

## Space regime (Newtonian)

```
velocity += -radial * g * dt                 (inverse-square gravity)
velocity +=  nose   * thrust_accel * dt       (thrust along the nose, bounded)
```

No direction steering — you coast; orientation only aims thrust. Free 6DOF (auto-level off).

## Capture zone (planetary-mode assist)

Deep space is huge and the planet is a tiny target, so an unassisted return means screaming
past it. A **capture zone** makes coming back forgiving. An `assist ∈ [0,1]` factor is derived
from altitude above the sea-level sphere:

- **Deep space** (`alt > CAPTURE_ALT`) → `assist = 0`: fully Newtonian/free — coast, orbit, escape (unchanged).
- **Capture zone** (`ATMOSPHERE_TOP < alt < CAPTURE_ALT`) → `assist` smoothsteps `0→1` as you descend.
- **Atmosphere** (`alt < ATMOSPHERE_TOP`) → `assist = 1`: full fly-by-nose cruise (unchanged).

In the **space term**, the assist ramps two behaviors in by `assist` (so the higher you are,
the weaker — pure inertia at the top, full cruise at the bottom):

1. **Fly-by-nose steering ramps in.** The velocity DIRECTION is slerped toward the nose at
   `TURN_RATE · assist`. Pointing the nose at the planet (or down) actually brings you in — the
   AI follows the pilot's intent. Pointing the nose OUTWARD + afterburner still lets you climb
   back out and re-escape, so it's an assist, not a prison.
2. **Speed cap bleeds down.** The effective cap is `lerp(V_CAP, APPROACH_SPEED, assist)`; the
   current speed eases (never snaps) down to it. You DECELERATE smoothly on approach instead of
   overshooting, arriving at the atmosphere boundary near `APPROACH_SPEED`.

At `assist = 1` (the atmosphere boundary) the space term matches the atmospheric regime, so the
density blend hands off to the fly-by-nose cruise with no discontinuity. `APPROACH_SPEED ≤ V_CAP`,
so the hard cap, gravity and the floor are all unchanged.

| Constant | Value | Notes |
|---|---|---|
| `CAPTURE_ALT` | `R_WORLD·10 = 60000` wu | top of the capture zone (≈ 60,000 km — generous) |
| `APPROACH_SPEED` | 2000 wu/s | managed approach speed the cap bleeds to (≤ `V_CAP`) |

**Flight mode** (`flight_mode()` / HUD label): `0 = ATMO` (`alt < ATMOSPHERE_TOP`),
`1 = ORBIT` (`ATMOSPHERE_TOP ≤ alt < ORBIT_TOP`), `2 = INTERPLANETARY` (`alt ≥ ORBIT_TOP`). The
web HUD appends `· ATMO` / `· ORBIT` / `· INTERPLANETARY`. The capture-zone assist is a
sub-state folded into INTERPLANETARY re-entry, not a separate label.

## Blend & gravity

- `density(r)` is a smoothstep 1→0 from sea level to `ATMOSPHERE_TOP = R_WORLD·0.25 = 1500
  wu`, 0 in space. The final velocity is `lerp(space_vel, atmo_vel, density)` — full
  fly-by-nose at the surface, fully Newtonian in deep space.
- Gravity: `g = G_SURFACE·(R_WORLD/r)²`, `G_SURFACE = 60 wu/s²`. Gentle in atmosphere (mostly
  countered by flight; bites on dive/stall), dominant in space.

## Granular speed & slow low-altitude cruise

Speed regulation is **continuous and holdable**: `THROTTLE_RATE = 0.3 s⁻¹` means a tap nudges the
target speed a little rather than snapping it to min/max, so the pilot can settle at any cruise
speed across `IDLE_SPEED (30) .. CRUISE_MAX (400)` in ATMO (the ORBIT band shifts the envelope to
`ORBIT_IDLE .. ORBIT_CAP`). The HUD `THR nn%` readout lets the pilot dial it in.

The slowest hands-off cruise is `IDLE_SPEED = 30 wu/s`, set comfortably ABOVE
`STALL_SPEED = 18 wu/s`. So a zero-throttle, level cruise at low altitude (~500 m ≈ 0.47 wu)
**holds altitude indefinitely** — slow flight no longer sinks. A stall (loss of fly-by-nose
authority → gravity sink) now requires a genuine crawl *below* `STALL_SPEED`, which throttle
alone can't reach (its floor is `IDLE_SPEED`).

## Floor

The craft cannot sink below the sea-level sphere (`R_WORLD + FLOOR_EPS`); inward radial
velocity is zeroed there (it slides tangentially). No terrain collision — flying through
exaggerated peaks is out of scope.

## Robustness

A non-positive or NaN `dt` is a no-op step (guards against a zero/negative rAF delta on the
first frame). All tunables are named, documented constants in `core/src/physics.rs`,
planet-derived where sensible so another planet can override them.

## Inputs (unchanged mapping)

Throttle: `ShiftLeft/Right` (+1) / `CtrlLeft/Right` (−1). Pitch: `W/S`. Yaw (rudder): `Q/E`.
Roll: `A/D`. Afterburner: `Space` (held) — also the **ascent-assist**: hold it with no pitch/roll
input for a hands-off gravity-turn climb to orbit / escape (see "Afterburner ascent-assist" above).
Mouse drives freelook only (view-only).

## Scenario tests (`cargo test --lib`)

`a` accelerate holds altitude (band ≈ 16 wu over 20 s, speed → cruise cap) · `b` speed never
exceeds `V_CAP` (Shift+Space 60 s in space) · `c` pitch climbs/descends, level holds · `d`
stall sinks · `e` space coasts ~straight · `f` escape stays capped · `g` hands-off cruise
holds altitude + speed · `h` stable at dt = 0.05 · `i` round-trip return (deep space → capture
zone → descends → settles into a stable cruise, no overshoot/crash) · `j` decel on entry
(crossing `CAPTURE_ALT` at `V_CAP` bleeds to ~`APPROACH_SPEED` by the atmosphere) · `k` not a
prison (nose outward + afterburner re-escapes past `CAPTURE_ALT`) · `l` `flight_mode` reports
ATMO/ORBIT/INTERPLANETARY at the right altitudes · `m` slow low-altitude cruise holds (throttle
0, level, ~500 m → altitude holds over 20 s, speed settles at `IDLE_SPEED`) · `n` granularity
(throttles 0/0.25/0.5/0.75/1.0 → five DISTINCT steady speeds spread across `IDLE..CRUISE_MAX`) ·
`o` per-mode speed caps (ATMO ≈ `CRUISE_MAX`, ORBIT ≈ `ORBIT_CAP`, INTERPLANETARY up to `V_CAP`;
ratio ≈ 1:7.5:25) · `p` ATMO drag bleed (full throttle then cut → ~idle in 1–4 s, quadratic) ·
`q` ORBIT loosely holds altitude (no input → near-circular, < 15 % drift over 40 s) · `r` ORBIT
easy escape (nose out + afterburner → climbs past `ORBIT_TOP`) · `s` smooth transitions (sweep
altitude → `eff_cap`/`density`/`orbit_blend` continuous, bounded per-sample delta, no NaN) · `t`
banking (a roll induces a heading change — coordinated turn) · `ri` rotational inertia (a step
pitch input RAMPS the angular velocity up over several frames, the one-frame attitude change LAGS
the raw input, and releasing the input RAMPS the rate down — no instant start/stop) · `u` AGL flat (hands-off holds
~`DEFAULT_TARGET_AGL` steady over flat terrain, no bob) · `v` AGL wall collision-avoidance (climbs
in time to clear a steep wall, then glides back to the low contour clearance) · `v2` AGL valley hug
(hill→valley: descends INTO the valley tracking the floor + clearance, reaching a LOWER altitude
than peak-window would; valley-floor clearance ≈ `DEFAULT_TARGET_AGL`) · `v3` AGL low skim
(`set_target_agl` to a small clearance → tight band over rolling terrain, no bob) · `v4` AGL
hill→valley→wall trace (descends into the valley yet clears the wall) · `w` AGL rolling (gentle
hills → bounded clearance, no growing bob/ringing — critical damping) · `x` AGL manual override
(pitch-up climbs ABOVE the follow altitude; releasing re-engages terrain-follow back toward
`DEFAULT_TARGET_AGL`) · `y1` AGL skim scaled ridges (`target_agl` 500 exag-m over alpine terrain
→ holds ~500 exag-m ≈ 1.2–1.4 wu just above the visible exaggerated ridges, hugs valleys, no bob) ·
`y2` HUD consistency (over flat ground `agl_m()` reads ≈ the set 500 exag-m, not ~10000) · `y3`
scaled wall collision-avoidance (a 4808 m VE-exaggerated alpine wall is cleared at ATMO speed — no
clip-through) · `z1` ascent arc to orbit (ftl + zero steering → smooth monotonic ATMO→ORBIT arc in
~2–3 s, then easing ftl settles into the orbit band) · `z2` sustained hold escapes (ftl + throttle
held ~15 s → past `ORBIT_TOP` into INTERPLANETARY in ~5–6 s, speed ≤ `V_CAP`) · `z3` manual override
(holding ftl WHILE pitching → assist disengages, the nose follows the manual pitch, not the
auto-climb) · `z4` release settles in orbit (release ftl mid-ascent in the orbit band → settles via
orbit-hold, does not fall to the ground).
