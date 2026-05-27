# Flight physics research: arcade feel, flight modes, orbit, AGL terrain-following

Research report for ridgeline (Earth-globe arcade flight; `R_WORLD = 6000` wu, gravity toward
center, atmosphere band, hard `V_CAP`). Addresses player feedback: controls feel non-physical;
atmo is too fast and not draggy; wants slower atmo; wants distinct **ATMO / ORBIT /
INTERPLANETARY** modes with separate speed ranges; wants altitude held **above the ground (AGL)**
via look-ahead terrain following.

Current model reference: `core/src/physics.rs`, `docs/physics.md`. Today the model has two
regimes (fly-by-nose atmosphere ↔ Newtonian space) blended by `air_density`, plus a capture-zone
assist. Constants of interest: `IDLE_SPEED=60`, `CRUISE_MAX=800`, `FTL_MAX=8000`, `V_CAP=10000`
wu/s; `ATMOSPHERE_TOP=1500`, `CAPTURE_ALT=60000` wu; `G_SURFACE=60` wu/s².

---

## 1. Arcade atmospheric flight feel

The consensus across game-dev sources is: **do not simulate real aerodynamics**. Use a few
forces with tunable coefficients, and lean heavily on *drag* and a *throttle→target-speed lag* to
produce a grounded feel. The four canonical forces are gravity, lift, thrust, drag; you can fake
lift entirely and just steer velocity toward the nose (which ridgeline already does).

**What makes "draggy / dense" vs "floaty":**

- **High drag is the single biggest lever.** brihernandez's widely-referenced `ArcadeJetFlightExample`
  uses a deliberately *high* linear drag (`drag = 5` on a mass-100 rigidbody) specifically "to
  prevent realistic slipping" and give "tight, predictable arcade handling rather than floaty
  physics." High drag = speed bleeds fast when you cut throttle, you must *work* to hold speed,
  and you cannot coast forever. This is exactly the "dense" feeling the player wants.
- **Throttle is a target, not a force.** Both brihernandez and the O'Reilly *Physics for Game
  Developers* aircraft chapter use a "target throttle vs actual throttle that eases toward it at a
  configurable rate." Ridgeline already does this (`v_target` + `SPEED_ACCEL`). To feel draggier,
  make the *deceleration* when you cut throttle obviously faster than the acceleration, and make
  acceleration toward the top of the band slow (so high speed is hard-won).
- **Quadratic drag for the "must work to go fast" curve.** A simple `drag_accel = k · v²`
  (opposing velocity) makes terminal speed emerge naturally where thrust = drag, and makes the top
  of the speed band asymptotic — the last 20% of speed costs disproportionately more thrust. This
  is the cheapest way to make "hard to climb out / hard to go fast" feel physical rather than a
  hard numeric clamp. GameDev.net's flight threads recommend the parabolic drag polar
  `CD = CD0 + k·CL²` for the same reason.

**Coordinated banking turns (roll → turn):** This is the #1 thing that reads as "a plane" rather
than "a spaceship." brihernandez couples them automatically: *when the craft banks, a yaw rate is
applied in the bank direction proportional to the bank angle* — computed from the Y component of
the body's right-vector (right wing high ⇒ yaw right). The pilot rolls; the turn happens; no
explicit rudder needed. Real coordinated turns also need a slight pitch-up to hold altitude in the
bank, but ridgeline's altitude-hold already handles that.
- Concrete: `yaw_rate += BANK_TURN_GAIN · sin(bank_angle) · (v / v_ref)`. The `v/v_ref` term makes
  turns tighter at speed and sluggish when slow, which reads as physical.

**Throttle→speed feel:** keep the slow `THROTTLE_RATE` (granular, holdable) but widen the
*perceived* range by lowering the atmo floor and ceiling (see §5). The "grounded" feeling comes
from: (a) speed visibly bleeding when you stop thrusting, (b) the top of the band being asymptotic
(quadratic drag), (c) turns and climbs costing speed (induced drag — bleed a little speed
proportional to turn rate and climb rate).

Sources:
- [brihernandez/ArcadeJetFlightExample (GitHub)](https://github.com/brihernandez/ArcadeJetFlightExample)
- [Physics for Game Developers, 2nd ed., Ch.15 "Aircraft" (O'Reilly)](https://www.oreilly.com/library/view/physics-for-game/9781449361037/ch15.html)
- [GameDev.net — Physics of flight: turning](https://gamedev.net/forums/topic/532306-physics-of-flight-turning/4442387/)
- [GameDev.net — Help me with aerodynamics for an arcade game?](https://www.gamedev.net/forums/topic/494911-help-me-with-aerodynamics-for-an-arcade-game/)
- [Sean Duggan — Gliding System (lift/drag coefficients, roll-into-turn)](https://medium.com/@sean.duggan/gliding-system-documenting-it-all-690cf4e32e32)

---

## 2. Flight MODE systems (ATMO / ORBIT / INTERPLANETARY)

Two design philosophies in the genre:

- **KSP**: a *physical threshold* on air pressure. Drag applies only above `0.01 atm`; the
  atmosphere ends at a hard altitude (70 km on Kerbin) where you are "officially in space." Density
  falls exponentially with a scale height (`P ∝ e^(−alt/H)`, H≈5600 m). The mode is *implicit* —
  it emerges from density — but the boundary is a real cutoff.
- **Elite Dangerous**: an *arbitrary set of restrictions layered on Newtonian physics*, explicitly
  "designed to work together to create the atmospheric flight of cinematic sci-fi." Flight-Assist-On
  caps speed and auto-steers velocity toward the nose (exactly ridgeline's fly-by-nose); FA-Off is
  raw Newtonian. The key reusable idea is the **"blue zone"**: an optimal speed band where turn
  rate is maximized; pushing throttle past it *reduces* maneuverability. This is a great way to give
  each mode a distinct *feel* beyond just a different cap.

**Recommendation for ridgeline — keep regimes density/altitude-derived, but expose 3 named
modes** and give each its own speed envelope and handling. Ridgeline already has the machinery:
`air_density(r)` and `assist(r)` are smoothstep functions of altitude. Map the three modes onto
altitude bands and drive the per-mode *speed cap* and *handling* from those same blends so there
are **no jarring switches** (everything crossfades via smoothstep, as today).

Proposed bands (reusing existing boundaries; ratios relative to current `V_CAP=10000`):

| Mode | Altitude band | Speed envelope (wu/s) | Cap ÷ V_CAP | Handling |
|---|---|---|---|---|
| **ATMO** | `0 .. ATMOSPHERE_TOP` (0–1500) | `IDLE 30 .. CRUISE 400` | 0.04 | fly-by-nose, high drag, banking turns, AGL hold |
| **ORBIT** | `ATMOSPHERE_TOP .. ORBIT_TOP` (1500–~12000) | `1000 .. 3000` | 0.30 | low-drag, near-circular hold, easy raise/lower |
| **INTERPLANETARY** | `> ORBIT_TOP` (>12000) | up to `V_CAP 10000` | 1.00 | free Newtonian, full afterburner |

Notes:
- **Slow atmo**: halve today's atmo band — `CRUISE_MAX 800 → ~400`, `IDLE 60 → ~30`. Combined with
  higher drag this makes atmo feel dense and "hard to leave." (Keep `STALL_SPEED` below the new
  `IDLE`.)
- **Hard to leave atmo**: the ATMO→ORBIT gap is the lever. With high quadratic drag in the atmo
  band, full throttle tops out around 400 wu/s; climbing into ORBIT requires pitching up *and*
  pushing through the draggy upper atmosphere where thrust barely beats drag — you have to commit.
  Optionally add a small extra drag bump in the top 25% of the atmosphere (the "thick boundary").
- **Transition handling**: drive `eff_cap`, `drag_k`, and steering authority as
  `lerp` over the same smoothstep weights already used for `air_density`/`assist`. Add a second
  smoothstep `orbit_blend(r)` over `ATMOSPHERE_TOP..ORBIT_TOP` to crossfade ORBIT↔INTERPLANETARY.
  No discrete switch — the HUD label flips at band boundaries but the physics is continuous.
- The existing **capture assist** stays and folds naturally into INTERPLANETARY→ORBIT re-entry
  (it already bleeds the cap toward `APPROACH_SPEED` on the way down). Consider setting
  `APPROACH_SPEED` to the ORBIT cap (~3000) so a returning ship settles into ORBIT speed first,
  then bleeds again entering ATMO.

Rough cap ratios to aim for: **ATMO : ORBIT : INTERPLANETARY ≈ 1 : 7.5 : 25** (400 / 3000 / 10000).

Sources:
- [KSP Wiki — Atmosphere (scale height, 0.01 atm drag threshold)](https://kerbalspaceprogram.fandom.com/wiki/Atmosphere)
- [KSP Wiki — Kerbin (70 km space boundary)](https://kerbalspaceprogram.fandom.com/wiki/Kerbin)
- [Elite Dangerous Wiki — Flight Model (FA-on/off, restrictions on Newtonian)](https://elite-dangerous.fandom.com/wiki/Flight_Model)
- [Frontier Forums — Atmospheric flight transitions / momentum carry-through](https://forums.frontier.co.uk/threads/atmospheric-flight-and-the-current-ships-in-elite.184169/page-3)

---

## 3. ORBIT mode — faked stable orbit

Goal: faster than atmo, *easy to escape*, loosely maintains altitude (near-circular), **without
Keplerian complexity**. Standard arcade trick: don't integrate gravity as a free force in ORBIT —
instead apply a **weak radial spring toward a target orbital radius**, so the craft naturally
holds a near-circular path but the pilot can raise/lower it freely.

Concrete approach (an "altitude-hold lite" in the ORBIT band):

```
r        = |position|
target_r = clamp(r_command, ORBIT_MIN, ORBIT_MAX)   // pilot raises/lowers with pitch or thrust-up
err      = target_r - r
radial_v = velocity · radial_out
// critically-damped spring drives r toward target_r without oscillating:
a_radial = ORBIT_K · err  -  ORBIT_C · radial_v       // ORBIT_C ≈ 2·sqrt(ORBIT_K) for crit. damp
velocity += radial_out · a_radial · dt
```

- **Near-circular hold for free**: with no pitch input, `target_r` tracks current `r` slowly (or is
  pinned), the spring kills any radial drift, and the craft coasts tangentially → a stable circle,
  no Kepler math.
- **Easy raise/lower**: pitch-up (or thrust-up) nudges `target_r` upward; the spring follows. Pitch
  down / thrust-down lowers it. This is the arcade "set your orbit altitude" knob.
- **Easy escape**: gate the spring by `orbit_blend(r)` so it fades out toward `ORBIT_TOP`; above
  that you are in INTERPLANETARY (pure Newtonian) and can leave freely. Pointing the nose out +
  afterburner climbs past `ORBIT_TOP` and the spring releases — never a prison (mirrors the
  existing `k_not_a_prison` test intent).
- **Damping is essential** to avoid the bobbing the player dislikes — use critical damping
  (`C = 2√K`). This is the same fix flight sims use for altitude-hold overshoot (see §4).

This keeps gravity "on" visually (the planet still pulls in INTERPLANETARY and during capture) but
replaces the delicate orbital-mechanics balance with a forgiving spring inside the ORBIT band.

---

## 4. Terrain-following / AGL altitude hold

Real systems (terrain-following radar, ArduPilot) all share one principle: **look ahead along the
ground track, find the highest terrain within a window, and command altitude against that maximum —
not against the terrain directly below.** This makes the aircraft *climb before* a peak.

From the references:
- **ArduPilot** "looks ahead of the current position along the flight path to ensure the aircraft
  climbs soon enough to avoid upcoming terrain." Look-ahead distance = `TERRAIN_LOOKAHEAD` (default
  2000 m, recommended ~1000 m), scaled by climb capability and ground speed. `LOOKAHEAD = 0` =
  track only directly below (causes late climbs / peak strikes).
- **TFR (Falcon/real)**: forward-looking sensor builds a terrain profile ahead; outputs a *pitch
  command* to hold a set clearance altitude; fed to the autopilot/HUD.
- **Known failure mode** (documented by ArduPilot): a naive "match terrain below" controller keeps
  positive pitch right up to a crest, so the craft *overshoots the peak still climbing* and is slow
  to descend into the valley behind. The fix is the look-ahead max-window: the target stops rising
  once the peak is behind the look-ahead window, so you start descending earlier. Also: **smoothing
  flattens sharp peaks** — a single spike can be averaged away, so use a *max* over samples, not a
  *mean*, for the climb side.

**Recommended algorithm for ridgeline** (heightfield is cheap to sample at any lat/lon):

```
// Per step. nose-forward ground track; sample terrain heights ahead, take the MAX.
fwd_h   = horizontal(velocity)              // velocity projected onto local tangent plane
ground  = direction from center to ship     // radial_out
target_agl = TARGET_AGL                      // desired height above ground (e.g. 300 wu)

// Sample N points along the forward ground track out to LOOKAHEAD,
// weighting near samples a touch higher so distant peaks don't over-trigger:
peak_terrain = max over i in 0..N of:
    terrain_radius( latlon_at(position + fwd_h.normalized() * (i/N)*LOOKAHEAD) )

// Also include the terrain directly below so you never descend into a hole you're over:
peak_terrain = max(peak_terrain, terrain_radius(latlon(position)))

desired_r = peak_terrain + target_agl

// Critically-damped vertical controller (NOT a stiff snap → no oscillation):
err        = desired_r - |position|
radial_v   = velocity · radial_out
climb_cmd  = AGL_K * err  -  AGL_C * radial_v       // AGL_C = 2*sqrt(AGL_K)
// clamp to a max climb/descend rate so it can't violate the speed/feel budget:
climb_cmd  = clamp(climb_cmd, -MAX_SINK, MAX_CLIMB)
// apply as a radial velocity component (steer the fly-by-nose direction's radial term):
commanded_radial = climb_cmd / max(speed, 1)        // feeds the existing ALT_HOLD term
```

Then feed `commanded_radial` into the existing atmosphere `commanded_radial` slot (which today is
`0` for level / `nose·radial_out` for pitched). I.e. **AGL hold replaces the "0" level command with
"track terrain + target_agl."** Manual pitch still overrides (pilot intent wins).

Key parameters / tuning to avoid oscillation and peak overshoot:
- **`LOOKAHEAD`**: scale with speed, `LOOKAHEAD = max(LOOKAHEAD_MIN, speed · LOOKAHEAD_TIME)` with
  `LOOKAHEAD_TIME ≈ 2–4 s` of flight ahead. Faster ⇒ look farther ⇒ climb earlier. (Direct port of
  ArduPilot's "ground-speed × climb capability" scaling.)
- **MAX over the window** for the climb side (so a sharp ridge isn't smoothed away), but let the
  *descent* be governed by the damped controller alone — that gives the natural "climb before the
  peak, glide gently down after" behavior and fixes the documented overshoot problem.
- **Critical damping** (`AGL_C = 2√AGL_K`) + a **climb/sink rate clamp** kills the bob the player
  complained about. Start `AGL_K` low (soft following) and raise until it tracks ridges crisply
  without ringing.
- **N ≈ 6–10 samples** along the track is plenty given the heightfield is cheap; weight by distance
  if distant terrain over-triggers early climbs.

**HUD-AGL**: show `AGL = |position| − terrain_radius(latlon(position))` (height above the ground
directly below), distinct from the current sea-level altitude readout. Cheap: one heightfield
sample per frame.

Sources:
- [ArduPilot Plane — Terrain Following (LOOKAHEAD, climb-before-terrain, climb-rate)](https://ardupilot.org/plane/docs/common-terrain-following.html)
- [Wikipedia — Terrain-following radar](https://en.wikipedia.org/wiki/Terrain-following_radar)
- [Falconpedia — Terrain Following Radar (pitch command to hold clearance)](http://falcon4.wikidot.com/avionics:tfr)
- [AGI STK — Terrain Following (AGL never less than specified, forward profile)](https://help.agi.com/stk/Content/aircraft/proc_terrainFollowing.htm)
- [SPH Engineering — Smart AGL terrain-following algorithm](https://www.sphengineering.com/news/inside-the-new-terrain-following-algorithm-in-ugcs-smart-agl)
- [US Patent 4,760,396 — set-clearance-altitude in a TFR system](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/4760396)

---

## 5. Prioritized recommendations — next two implementation tasks

### Task (a): ATMO / ORBIT / INTERPLANETARY modes + per-mode caps + draggier/slower atmo + banking

Priority order:

1. **Slow & thicken ATMO.** Lower the atmo band: `IDLE_SPEED 60→30`, `CRUISE_MAX 800→400`. Add
   quadratic drag in the atmo blend: `a_drag = −DRAG_K · density · speed² · v̂`, tuned so terminal
   speed at full throttle ≈ 400 and cutting throttle bleeds speed in ~2–3 s. This alone delivers
   "slower, draggier, hard to leave." (`STALL_SPEED` stays < new `IDLE`.)
2. **Three named modes from altitude bands.** Add `ORBIT_TOP ≈ 2·R_WORLD` (≈12000 wu) and a second
   smoothstep `orbit_blend(r)` over `ATMOSPHERE_TOP..ORBIT_TOP`. Per-mode effective cap via lerp:
   ATMO 400 → ORBIT 3000 → INTERPLANETARY `V_CAP` 10000. Cap ratios **≈ 1 : 7.5 : 25**. Extend
   `flight_mode()` to return 4 labels (ATMO / ORBIT / INTERPLANETARY / + keep PLANETARY-capture as
   the re-entry sub-state, or fold capture into the ORBIT band). HUD shows the mode name + its cap.
3. **Coordinated banking.** Roll input induces yaw toward the bank:
   `yaw_rate += BANK_TURN_GAIN · sin(bank_angle) · clamp(speed/CRUISE_MAX, 0, 1)`. Makes ATMO read
   as "a plane." Keep auto-level for hands-off.
4. **Make leaving atmo deliberate.** Optional extra drag bump in the top 25% of the atmosphere so
   the climb-out costs commitment; afterburner + sustained pitch-up needed to punch into ORBIT.

### Task (b): AGL terrain-following hold + HUD-AGL

1. **HUD-AGL readout first** (trivial, de-risks sampling): `AGL = r − terrain_radius(latlon)`,
   one sample/frame. Confirms the heightfield-sample path works and is cheap.
2. **Look-ahead AGL hold** per §4: sample N≈8 points along the forward ground track out to
   `LOOKAHEAD = clamp(speed·3s, min, max)`, take the **max** terrain (+ below), set
   `desired_r = peak + TARGET_AGL`, drive it with a **critically-damped** radial controller
   (`AGL_C = 2√AGL_K`) feeding the existing `commanded_radial` slot, with a climb/sink-rate clamp.
   Manual pitch overrides. Active in ATMO (and optionally ORBIT as the orbit-spring's `target_r`).
3. **Tune against ridges**: start soft, raise `AGL_K` until ridge tracking is crisp without ring;
   verify "climbs before peaks, glides down after" and no bob. Reuse the test harness pattern in
   `physics.rs::scenarios` (add a terrain-following scenario over a synthetic ridge).

**Suggested new constants (starting points, all tunable):**

| Constant | Start value | Meaning |
|---|---|---|
| `IDLE_SPEED` | 30 wu/s | slower atmo floor |
| `CRUISE_MAX` | 400 wu/s | slower atmo ceiling |
| `DRAG_K` | tune for ~2–3 s speed bleed | quadratic atmo drag |
| `ORBIT_TOP` | 12000 wu (2·R_WORLD) | ATMO/ORBIT vs INTERPLANETARY split |
| `ORBIT_CAP` | 3000 wu/s | ORBIT speed ceiling |
| `BANK_TURN_GAIN` | ~1.0 (tune) | roll→yaw coupling |
| `TARGET_AGL` | 300 wu | desired height above ground |
| `LOOKAHEAD_TIME` | 3 s | forward window = speed·time |
| `AGL_K` / `AGL_C` | low / `2√AGL_K` | crit-damped AGL controller |
| `MAX_CLIMB` / `MAX_SINK` | tune | rate clamp (anti-oscillation) |

---

## Summary

- **Feel**: high drag + quadratic-drag top-end + throttle-as-target + roll-coupled yaw = "grounded
  plane," not "floaty spaceship."
- **Modes**: derive 3 named modes from altitude/density smoothsteps (KSP-style boundaries, Elite-style
  layered caps); crossfade every quantity so switches are seamless. Cap ratio ≈ 1 : 7.5 : 25.
- **Orbit**: fake it with a critically-damped radial spring to a pilot-commandable `target_r` —
  near-circular hold, easy raise/lower, fades out for easy escape. No Kepler.
- **AGL**: sample terrain ahead, take the **max** over a speed-scaled look-ahead window, hold
  `peak + TARGET_AGL` with a critically-damped + rate-clamped radial controller → climb before
  peaks, glide down after, no bob.
