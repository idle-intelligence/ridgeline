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
  nose auto-levels. (AGL terrain-following is the NEXT task; for now the level alt-hold drives
  the radial command to 0 — a clean seam.)
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

## ATMO + ORBIT regime (fly-by-nose)

The same fly-by-nose term serves both ATMO and ORBIT; per-mode behavior crossfades by
`orbit_w = orbit_blend(r)` (0 in ATMO, 1 in the heart of ORBIT, 0 above `ORBIT_TOP`).

1. Ease scalar speed toward `v_target`, then subtract **quadratic drag** `DRAG_K·density·v²`
   (ATMO only; fades with density). The drag makes the top speed asymptotic and bleeds speed to
   idle in ~2–3 s when throttle is cut.
2. Steer the unit velocity direction toward the nose (`orientation*-Z`) at `TURN_RATE` — the
   craft goes where it points.
3. **Altitude hold**: with no pitch input the direction's radial (climb/sink) component is
   driven to **0** at a rate that crossfades from the stiff `ALT_HOLD_RATE` (ATMO: pinned level)
   to the gentle `ORBIT_HOLD_RATE` (ORBIT: loose near-circular hold, easy to raise/lower); with
   pitch input it's driven to match the nose's radial component (climb/dive). The hold fades out
   toward `ORBIT_TOP`, handing off to free Newtonian flight (easy escape). (AGL terrain-following
   — the NEXT task — will replace the level command's `0` with a terrain-tracked value; a clean
   seam, only that value changes.)
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
Roll: `A/D`. Afterburner: `Space` (held). Mouse drives freelook only (view-only).

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
banking (a roll induces a heading change — coordinated turn).
