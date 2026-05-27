# ridgeline core ↔ web contract (AUTHORITATIVE — v1)

This is the frozen seam between the Rust/WASM `core/` and the JS/WebGL2 `web/`.
Both sides build against THIS document. If you need to change it, change it here first.

## Build & module
- `core/` builds with `wasm-pack build --target web --out-dir ../web/pkg --out-name ridgeline_core`.
- Web imports: `import init, { Engine } from "./pkg/ridgeline_core.js";`
- `web/pkg/` is gitignore'd (build artifact). Core agent does NOT commit it.

## Coordinate system — SPHERE model (core owns world-space mapping)
The world is a **globe of stacked latitude rings** centered at the origin. Each heightfield
cell (row → latitude φ, col → longitude λ, elev_m) maps to a 3D point on a sphere:

- `R_WORLD` = planet radius = **6000.0** world units.
- `VERT_EXAGGERATION` = **8.0** (the BASE multiple of true scale at which heightfield
  elevations are stored). `VERT_SCALE = (R_WORLD / EARTH_RADIUS_M) * VERT_EXAGGERATION`. At
  1× (realistic) Everest (8849 m) ≈ 8.3 wu — a tiny bump. (The old dramatic look was ≈ 117.)
- **Altitude-coupled vertical exaggeration (rendered relief only).** The terrain ring radii
  are scaled per-frame by `VE(altitude)` so the planet is dramatic from space and relaxes
  toward realistic on approach (engineering apparent-size constancy: apparent height ∝
  rendered_height/distance ∝ VE/altitude ≈ const through the ramp):
  `VE(alt) = clamp(VE_K · altitude_wu, VE_NEAR, VE_FAR)` with **VE_NEAR = 1.0**,
  **VE_FAR = 8.0**, **VE_K = 0.0007**, `altitude_wu = max(|cam_pos| − R_WORLD, 0)`. The ramp
  leaves the near clamp at ~1429 wu and saturates at the 8× cap by ~11429 wu. Low cruise
  (~500 wu) renders ~1× (realistic), mid altitudes ramp through ~2–6×, space caps at 8×.
  Measured: alt 472 wu → VE 1.00, alt 4972 wu → VE 3.48, alt 11972 wu → VE 8.00.
  This is a single smooth global radial multiplier per frame, so nothing swims (lat/lon grid
  indices and distance-based LOD strides are unchanged). Only the rendered TERRAIN relief
  scales; the OCCLUDER sphere stays at R_WORLD, and camera/physics/floor and all HUD/altitude/
  speed/lat-lon plus the normalized elevation→brightness stay on the real (fixed) scale.
- `h_wu = elev_m * VERT_SCALE`, `r = R_WORLD + VE/VERT_EXAGGERATION · h_wu` (terrain;
  occluder uses `r = OCCLUDER_R`).
- Cartesian (north pole = **+Y**): `x = r·cosφ·cosλ`, `y = r·sinφ`, `z = -r·cosφ·sinλ`
  (longitude handedness flipped so EAST renders to the RIGHT with north up),
  φ in [-90,90]°, λ in [-180,180]°. row 0 = +90° N (lat_max), col 0 = -180° W (lon_min).
- Each grid ROW (constant latitude) is a parallel ring around the globe; sweeping λ traces
  the ring with elevation bumps. Land bulges out, ocean (h=0) is a smooth circle at R_WORLD.
- Horizontal planet scale: `M_PER_WU = EARTH_RADIUS_M / R_WORLD = 6371000 / 6000 ≈ 1061.8` m/wu.

## Construction
```
await init();                       // wasm-pack default init
const eng = new Engine(             // #[wasm_bindgen(constructor)] → JS `new`, not Engine.new
  width, height,                    // u32, from meta.json
  heightfieldBytes,                 // Uint8Array, raw int16 LE, len = width*height*2
  waterMaskBytes,                   // Uint8Array, u8 0/1, len = width*height
  elev_min, elev_max,               // f32 (meters)
  lat_min, lat_max, lon_min, lon_max// f32 (degrees, from meta.bbox)
);
```

## Spawn + setters (call after construction, before the first `step`)
```
eng.set_spawn(lat_deg, lon_deg, alt_wu, heading_deg);
// lat_deg, lon_deg : f32 degrees — geographic spawn point.
// alt_wu           : f32 world units above the sea-level sphere (alt_m = alt_wu * M_PER_WU).
// heading_deg      : f32 degrees compass — 0 = north, 90 = east.
// Places the craft cruising LEVEL at (lat,lon,alt), nose tangent on the heading, with the
// same seeded cruise velocity + throttle + altitude-hold as the default spawn. Resets
// freelook (look_yaw/look_pitch = 0) and regenerates geometry so the first frame is correct.
// new() calls this with the default spawn: lat 38°N, lon 8°E, CRUISE_ALT = 250 wu, heading north.

eng.set_exaggeration_override(ve);   // force a FIXED terrain vertical exaggeration.
eng.clear_exaggeration_override();   // back to the altitude-coupled ve_for_altitude ramp.
// When an override is set, the per-frame terrain relief uses this constant `ve` INSTEAD of
// VE(altitude), so the player can hold a constant relief at any altitude. When unset, the
// altitude-coupled behavior is unchanged. Only terrain relief is affected (occluder/camera/
// physics/HUD scales are untouched), same as the altitude-coupled path.

eng.set_target_agl(agl_m);           // ATMO terrain-following clearance, in VE-EXAGGERATED METERS.
// Clearance the AGL hold maintains above the terrain DIRECTLY BELOW, expressed in the SAME
// vertical scale the terrain is DRAWN in (VE-exaggerated meters — NOT un-exaggerated meters / wu).
// The core converts it to wu per-frame with the live render `ve`:
// agl_wu = agl_m · VERT_SCALE · ve/VERT_EXAGGERATION (= agl_m · ve / M_PER_WU), so the held
// clearance is exaggerated like the ground and skims just above the visible ridges (500 exag-m ≈
// 1.3 wu at near-surface ve). Contour hug; the craft still climbs to clear upcoming walls. Clamped
// to [TARGET_AGL_MIN = 80, TARGET_AGL_MAX = 60000] exag-m. Default = DEFAULT_TARGET_AGL = 500
// exag-m. Preserved across set_spawn respawns. The web ?agl=<meters> URL param passes straight
// through (no M_PER_WU conversion). Manual pitch still overrides.
```

## Per-frame input (call before `step`)
```
eng.set_look(d_yaw, d_pitch);
// d_yaw:   f32 radians, positive = look right. Accumulated; clamped ±120°.
// d_pitch: f32 radians, positive = look up.   Accumulated; clamped ±80°.
// Call with pointer-lock mouse deltas converted to radians each frame.
// Affects view matrix only — flight physics use flight_orientation unchanged.

eng.set_input(
  thrust,   // f32 -1..1  throttle up/down  (ShiftLeft/Right = +1, CtrlLeft/Right = -1)
  strafe,   // f32 -1..1  unused (pass 0)
  lift,     // f32 -1..1  unused (pass 0)
  pitch,    // f32 rad/s  KeyW = nose up, KeyS = nose down
  yaw,      // f32 rad/s  KeyQ = left, KeyE = right (rudder)
  roll,     // f32 rad/s  KeyA = left, KeyD = right
  boost,    // f32        unused (pass 0); throttle controlled by thrust axis
  ftl       // bool       Space-hold = afterburner
);
eng.step(dt); // f32 seconds — advances quaternion physics + regenerates visible geometry
```
Mouse drives freelook only (`set_look`); flight controls are keyboard-only.

## Viewport
- `eng.set_aspect(aspect)` — `aspect` = canvas width/height (f32). Call once after construction and on
  every resize. Core bakes a 45° vertical-FOV perspective; without this it defaults to 16:9 and
  non-16:9 canvases stretch. (Added during integration — projection math stays in core.)

## Camera (third-person chase, free 3D around the globe)
The camera is positioned behind and above the ship in ship-local space:
`cam_pos = ship_pos + ship_orientation * (0, CHASE_UP=6, CHASE_BACK=28)`.
View direction = ship orientation + freelook offset (`set_look`). Flight physics
(`phys.position`, `phys.orientation`) are the **ship** transform; the camera
offset is view-only.

**Spawn**: ship cruising LEVEL inside the atmosphere at `CRUISE_ALT = 250` wu over the
western/central Mediterranean (38°N, 8°E), heading NORTH toward Europe. (Configurable at
runtime via `set_spawn` — see "Spawn + setters" above; the web layer maps URL query params
`?lat=&lon=&alt=&heading=&ve=&agl=` onto it.) The orientation is built from a radial basis
(up = radial, forward = north tangent), and the craft is seeded with a forward velocity
(`CRUISE_SPEED = 450` wu/s) and a cruise throttle (`CRUISE_THROTTLE = 0.527`) whose target
speed equals `CRUISE_SPEED`. With no thrust input the throttle holds, so from frame 1 the
craft holds altitude and speed — no free-fall, no climb-out. Pitch down dives; pitch up +
Shift+Space climbs to space.

**Flight model** (see `docs/physics.md`): speed is **decoupled from altitude**, with **three
modes crossfaded by altitude** (seamless, no discrete switch). Throttle sets a *target speed*
(hard-capped at `V_CAP = 10000` wu/s, so the HUD km/h is always bounded). **ATMO** (`alt < 1500`):
slow + dense fly-by-nose with **quadratic drag** (`IDLE 30 .. CRUISE_MAX 400`; cut throttle →
speed bleeds in ~2–3 s). Hands-off, **AGL terrain-following** holds the craft a small clearance in
VE-exaggerated meters (default `DEFAULT_TARGET_AGL = 500` exag-m ≈ 1.3 wu near the surface, tunable
via `set_target_agl` / `?agl=`; converted to wu per-frame with the live render `ve` so it skims
just above the visible exaggerated ridges) above the terrain DIRECTLY BELOW AS RENDERED — it HUGS
THE CONTOUR (descends into valleys with the floor) and uses
the speed-scaled forward look-ahead only for COLLISION AVOIDANCE (raising the target in time to
clear an upcoming wall), tracked by a critically-damped radial controller. Manual pitch overrides;
auto re-engages hands-off. **ORBIT** (`1500 .. ORBIT_TOP = 12000`): thin air, faster
(`1000 .. 3000`), a gentle critically-damped hold keeps a **near-circular** path that's easy to
raise/lower with pitch and easy to escape (point out + accelerate). **INTERPLANETARY**
(`> 12000`): free Newtonian (coasts; gravity + nose-thrust) up to `V_CAP`. Per-mode caps
crossfade ≈ 1 : 7.5 : 25. **Coordinated banking** couples roll into yaw in ATMO/ORBIT (rolling
banks you into a turn). On re-entry a **CAPTURE ZONE** (`ATMOSPHERE_TOP` < alt < `CAPTURE_ALT =
R_WORLD·10 = 60000` wu) assist ramps in (point at the planet → the AI brings you in; the cap
bleeds toward `APPROACH_SPEED = 2000` wu/s) so returning decelerates smoothly — yet pointing
outward + afterburner still re-escapes (assist, not prison). The chase craft is a small
foreground silhouette against the terrain and curved horizon ahead.

Projection near/far are at space scale: `Z_NEAR=1`, `Z_FAR=200000` (globe radius 6000,
camera out to tens of thousands of wu).

## Camera getters (valid after `step`)
- `eng.view_proj()` → `Float32Array` length 16, **column-major**, ready for
  `gl.uniformMatrix4fv(loc, false, arr)`. (Combined projection * view, using chase-cam position.)
- `eng.camera_position()` → `Float32Array` length 3 `[x,y,z]` — the chase-cam world position.

## Aircraft model getters
- `eng.model_matrix()` → `Float32Array` length 16, **column-major**.
  = `translate(ship_pos) * rotate(ship_orientation)`. No scale baked in.
  Pass as the model matrix; multiply `view_proj * model_matrix` in JS to get MVP.
- `eng.aircraft_scale()` → `f32` = 14.0. Scale to apply to the normalized aircraft
  mesh (nose-to-tail ≈ 1 wu) to reach world units. Web applies this when uploading
  vertex positions from `aircraft.json`.

## Geometry getters (regenerated each `step`)
Core emits two channels for the globe: the **dark occluder sphere** (fill) and the **bright
latitude rings** (line). Depth test (not painter's order) resolves occlusion, so draw order
within a channel does not matter; back-to-front is no longer required.

**FILL channel — dark occluder sphere.** A coarse lat/lon tessellation of the visible
hemisphere at radius `R_WORLD * 0.999` (slightly below sea level so it never z-fights the
h=0 ocean rings). Drawn in the dark background fill color, it hides the far side of the globe
via the depth test.
- `eng.fill_vertices()` → `Float32Array`, packed `[x,y,z, ...]`. One TRIANGLE_STRIP per
  occluder latitude band (alternating lat_a / lat_b vertices along longitude).
- `eng.fill_draws()` → `Uint32Array`, flat pairs `[start,count, ...]`. JS issues
  `gl.drawArrays(gl.TRIANGLE_STRIP, start, count)` per pair.
- `eng.fill_strengths()` → `Float32Array`, one f32 per vertex. ~1 in the interior, ramps to 0
  at the limb (so the occluder edge dissolves). Multiply fill alpha by this.
- `eng.fill_elevations()` → `Float32Array`, one f32 per vertex. **All 0** (the occluder is the
  dark sea-level sphere). Present for API parity.

**LINE channel — bright latitude rings.** For each visible ring (grid row), a LINE_STRIP of
3D sphere points sweeping longitude; the strip is split into runs at the horizon limb.
- `eng.line_vertices()` → `Float32Array`, packed `[x,y,z, ...]`.
- `eng.line_draws()` → `Uint32Array`, flat pairs `[start,count, ...]`. JS issues
  `gl.drawArrays(gl.LINE_STRIP, start, count)` per pair.
- `eng.line_strengths()` → `Float32Array`, one f32 per vertex. Ramps 0→1 from the horizon
  limb inward (rings dissolve at the visible-hemisphere edge instead of popping).
- `eng.line_elevations()` → `Float32Array`, one f32 per vertex, in [0..1] =
  elev_world / elev_world_max. 0 = ocean ring (dim), 1 = highest peak (bright land glow).
  Drives elevation→brightness in the fragment shader.

Indices in `fill_draws`/`line_draws` are VERTEX indices into the respective vertex array
(not byte offsets). Returned typed arrays are copies; valid until the next `step`.

**The FILL occluder is generated DECOUPLED from (far COARSER than) the lines.** It is only a
flat dark depth-occluder, so it uses no sub-ring interpolation (raw data rows only), a row
step and column stride each coarsened ×`FILL_COARSEN` (=3) over the line strides, and is
nudged inward to `R * FILL_R_INSET` (=0.999) so the coarse mesh sits a hair below the bright
lines and can never poke through / tear them. This cuts fill verts ~16× vs the lines with no
visible change.

### Zero-copy geometry access + primitive-restart indices (per frame, preferred path)
To avoid copying ~400k floats across the WASM→JS boundary each frame and to collapse the
~750 per-strip draws into ONE indexed draw, the core exposes:

- `(ptr, len)` getters returning a byte offset into WASM linear memory and an ELEMENT count:
  - `fill_verts_ptr()/_len()`, `fill_strengths_ptr()/_len()`, `fill_elevations_ptr()/_len()`,
    `fill_indices_ptr()/_len()`
  - `line_verts_ptr()/_len()`, `line_strengths_ptr()/_len()`, `line_elevations_ptr()/_len()`,
    `line_indices_ptr()/_len()`
  - verts/strengths/elevations are `f32`; indices are `u32`.
- `fill_indices` / `line_indices` are **restart-delimited UNSIGNED_INT index lists**: each
  strip's vertex indices in order, separated by the WebGL2 fixed restart index `0xFFFFFFFF`
  (always enabled). JS draws all strips with a single
  `gl.drawElements(gl.TRIANGLE_STRIP|gl.LINE_STRIP, len, gl.UNSIGNED_INT, 0)`.

JS builds typed-array VIEWS over `wasm.memory.buffer` (no copy):
`new Float32Array(wasm.memory.buffer, ptr, len)` / `new Uint32Array(...)`, then uploads via
`gl.bufferSubData` into pre-sized, reused VBOs (grown only when the used size exceeds
capacity) — never `bufferData` per frame. **CRITICAL:** a view detaches if WASM memory grows;
JS MUST re-fetch `wasm.memory.buffer` (compare identity with `===`) and recreate the views
when it changes. The core reuses its geometry `Vec`s across frames via `.clear()` (capacity
kept), and builds the index lists last (after all vertex pushes) so the views are valid.

The `init()` default export's return value carries `.memory`; `web/main.js` passes it to
`renderer.draw(eng, wasmMemory)`. When `wasmMemory` is null (mock engine), the renderer falls
back to the legacy copying getters (`fill_vertices()` etc.) + per-strip `drawArrays`. Both the
copying getters and the new ptr/len + index getters are present.

**LOD + culling.** Index-anchored, power-of-two strides chosen by camera altitude (distance
to the surface): far → coarse rings/longitude (cheap whole globe), close → fine. Because the
same stride set is applied globe-wide and rows/cols are sampled at index multiples of the
stride, the rendered set changes only at discrete power-of-two boundaries — nothing swims.
**Horizon cull is view-independent**: a surface point P is kept iff
`dot(normalize(P), normalize(cam_pos)) > R_WORLD/|cam_pos| − margin`.

**Alpha blending contract**: enable `gl.BLEND` with `gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)`.
Occlusion is resolved by the DEPTH TEST (the dark occluder sphere hides the far side), so
painter's back-to-front order is no longer required.

## Debug getters (optional, for HUD) — sphere semantics
- `eng.altitude()` → f32 (world units above the sea-level sphere) = `|cam_pos| − R_WORLD`.
- `eng.altitude_m()` → f32 (real meters above sea level) = `altitude() × M_PER_WU`, where
  `M_PER_WU = EARTH_RADIUS_M / R_WORLD ≈ 1061.8` m/wu. Uses the HORIZONTAL planet scale
  (not VERT_SCALE) so altitudes read as plausible orbital/atmospheric heights.
- `eng.agl_m()` → f32 (**VE-EXAGGERATED meters** ABOVE GROUND) =
  `(|pos| − terrain_radius_below) / (VERT_SCALE · ve/VERT_EXAGGERATION)` (= wu clearance × M_PER_WU
  / ve), clamped ≥ 0, using the SAME `ve` the renderer draws this frame (`ve_for_altitude`, or the
  exaggeration override). Reported in the terrain's OWN exaggerated vertical scale, so the ATMO
  terrain-following hold (which targets this) reads ≈ the set clearance — e.g. ~500 over flat
  ground at the default, NOT ~10000. Distinct from `altitude_m` (height above the sea-level sphere,
  un-exaggerated meters); over ocean the *wu* heights coincide but the reported scales differ. The
  web HUD shows `AGL nnnm` in ATMO (alongside `ALT`).
- `eng.speed()` → f32 (world units/sec).
- `eng.speed_kmh()` → f32 (km/h) = `speed() × M_PER_WU × 3.6` (same horizontal planet scale).
- `eng.throttle()` → f32 in `[0, 1]` — current engine throttle (gas pedal). The web HUD shows
  it as `THR nn%` so the pilot can regulate cruise speed. Throttle ramps slowly
  (`THROTTLE_RATE = 0.3 s⁻¹`, a full sweep ≈ 3.3 s) so intermediate cruise settings are easy to
  hold; `v_target = lerp(IDLE_SPEED, top, throttle)`.
- `eng.flight_mode()` → `u8` — current flight mode by altitude: `0 = ATMO` (dense fly-by-nose
  cruise, `alt < ATMOSPHERE_TOP = 1500`), `1 = ORBIT` (thin-air near-circular hold,
  `ATMOSPHERE_TOP ≤ alt < ORBIT_TOP = 12000`), `2 = INTERPLANETARY` (free Newtonian + capture
  assist on re-entry, `alt ≥ ORBIT_TOP`). The web HUD maps these to `· ATMO` / `· ORBIT` /
  `· INTERPLANETARY`. Speed caps crossfade per mode (`CRUISE_MAX 400` → `ORBIT_CAP 3000` →
  `V_CAP 10000`, ratio ≈ 1 : 7.5 : 25). The capture-zone assist is a sub-state folded into
  INTERPLANETARY re-entry, not a separate label.
- `eng.lat_lon()` → `Float32Array` length 2 `[lat, lon]` — the **sub-camera point**: the camera
  position projected onto the globe. `lat = asin(cam.y / |cam|)`, `lon = atan2(-cam.z, cam.x)`,
  both in degrees. Shows what the camera is above.

## WebGPU prototype getters (additive — used ONLY by the flag-gated `?webgpu=1` path)
These are additive read-only getters for the experimental `web/renderer-webgpu.js` compute
prototype, which ports the LINE-channel `emit_ring` geometry to a WGSL compute shader. The
WebGL2 default path does NOT use them; they don't affect the existing contract above.
- `eng.cam_forward()` → `Float32Array` length 3 — the freelook-aware camera forward (world
  space), the SAME direction the geometry frustum/sight cull uses this frame.
- `eng.current_ve()` → `f32` — the vertical exaggeration used to draw terrain this frame
  (override if set, else the altitude-coupled ramp). = `ve / VERT_EXAGGERATION` upstream.
- `eng.elev_world_max()` → `f32` — max terrain elevation (world units) for elevation→brightness
  normalization (matches `line_elevations`).
- `eng.heightfield_ptr()/_len()` → `u32` — pointer/len into WASM memory of the f32 world-unit
  elevation grid (row-major, row 0 = north, len = width*height). Uploaded ONCE to the GPU.
- `eng.grid_width()/grid_height()` → `u32` — heightfield grid dimensions.

## Rendering contract (web side)
- Enable depth test (LEQUAL). Draw the dark occluder-sphere fills (they write depth and hide
  the far hemisphere), then the bright latitude-ring lines on top. Background-colored fills +
  bright elevation-shaded lines give the Joy Division globe. Restrained palette, no neon.
- No bundlers, all relative paths, no server assumptions. Fetch `../data/*.bin` + `../data/meta.json`
  and `./pkg/*` at runtime.
</content>
