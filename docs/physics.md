# Ridgeline flight physics

## Overview

Arcade flight that **decouples speed from altitude** and runs two regimes blended by air
density:

- **Atmosphere — fly-by-nose.** Throttle sets a *target speed*; the craft flies where its
  nose points. A level nose holds altitude no matter the speed, so you can accelerate while
  holding a cruise. Pitch up climbs, pitch down dives. Below a stall speed the wings give up
  and gravity sinks you.
- **Space — Newtonian.** Air density → 0, so you coast inertially: `velocity += gravity·dt +
  nose·thrust·dt`. Orientation aims thrust, not the velocity direction. Enables orbit and a
  (capped) escape.

A **hard speed cap** (`V_CAP`) clamps `|velocity|` every step in both regimes, so thrust in
vacuum can never run away (this kills the old "billion km/h" bug).

## State

| Variable | Type | Description |
|---|---|---|
| `orientation` | `Quat` | Body-to-world rotation |
| `position` | `Vec3` | World-space position |
| `velocity` | `Vec3` | World-space velocity (wu/s) |
| `throttle` | `f32 ∈ [0, 1]` | Engine throttle (gas pedal) |
| `speed` | `f32 ≥ 0` | `|velocity|`, cached for the HUD |

## Speed model (throttle → target, hard cap)

```
throttle += thrust_axis * THROTTLE_RATE * dt        (clamped 0..1; hands-off holds)
top       = ftl ? FTL_MAX : CRUISE_MAX
v_target  = lerp(IDLE_SPEED, top, throttle)  capped to V_CAP
```

Current speed eases toward `v_target` under bounded acceleration `SPEED_ACCEL`, and
`|velocity| ≤ V_CAP` is enforced every step.

| Constant | Value | Notes |
|---|---|---|
| `IDLE_SPEED` | 120 wu/s | hands-off / zero-throttle floor speed |
| `CRUISE_MAX` | 800 wu/s | full-throttle atmosphere terminal (lap ≈ 47 s) |
| `FTL_MAX` | 8000 wu/s | afterburner (Space) terminal (lap ≈ 4.7 s) |
| `V_CAP` | 10000 wu/s | ABSOLUTE hard cap (≈ 38 M km/h at planet scale) |
| `SPEED_ACCEL` | 1200 wu/s² | spool-up/down rate toward `v_target` |

Planet circumference ≈ `2π·R_WORLD ≈ 37700 wu`, so the tiers give pleasant lap times rather
than a fraction of a second.

## Atmosphere regime (fly-by-nose)

1. Ease scalar speed toward `v_target`.
2. Steer the unit velocity direction toward the nose (`orientation*-Z`) at `TURN_RATE` — the
   craft goes where it points.
3. **Altitude hold**: with no pitch input the direction's radial (climb/sink) component is
   driven to **0** at `ALT_HOLD_RATE` (true horizontal, holds altitude as the planet curves);
   with pitch input it's driven to match the nose's radial component (climb/dive).
4. **Stall**: authority `= stall³` where `stall` ramps 0→1 from `0.5·STALL_SPEED` to
   `STALL_SPEED`. As speed bleeds off, fly-by-nose authority collapses and the gravity sink
   term `g·(1 − authority)·dt` takes over → you fall. So you must keep speed up to stay up.
5. **Hands-off auto-level**: with no pitch/roll input the *nose* also rotates toward the local
   horizon (`AUTO_LEVEL_RATE`) so the visible attitude stays level.

| Constant | Value | Notes |
|---|---|---|
| `TURN_RATE` | 3.0 s⁻¹ | velocity-direction → nose steering |
| `ALT_HOLD_RATE` | 80 s⁻¹ | radial-component → commanded (core decoupling) |
| `AUTO_LEVEL_RATE` | 2.5 s⁻¹ | hands-off nose leveling |
| `STALL_SPEED` | 180 wu/s | below this fly-by-nose fades; idle (120) stalls |

## Space regime (Newtonian)

```
velocity += -radial * g * dt                 (inverse-square gravity)
velocity +=  nose   * thrust_accel * dt       (thrust along the nose, bounded)
```

No direction steering — you coast; orientation only aims thrust. Free 6DOF (auto-level off).

## Blend & gravity

- `density(r)` is a smoothstep 1→0 from sea level to `ATMOSPHERE_TOP = R_WORLD·0.25 = 1500
  wu`, 0 in space. The final velocity is `lerp(space_vel, atmo_vel, density)` — full
  fly-by-nose at the surface, fully Newtonian in deep space.
- Gravity: `g = G_SURFACE·(R_WORLD/r)²`, `G_SURFACE = 60 wu/s²`. Gentle in atmosphere (mostly
  countered by flight; bites on dive/stall), dominant in space.

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
Roll: `A/D`. Afterburner: `Space` (held). Mouse drives freelook only (view-only).

## Scenario tests (`cargo test --lib`)

`a` accelerate holds altitude (band ≈ 16 wu over 20 s, speed → cruise cap) · `b` speed never
exceeds `V_CAP` (Shift+Space 60 s in space) · `c` pitch climbs/descends, level holds · `d`
stall sinks · `e` space coasts ~straight · `f` escape stays capped · `g` hands-off cruise
holds altitude + speed · `h` stable at dt = 0.05.
