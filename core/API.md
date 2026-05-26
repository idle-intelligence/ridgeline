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
`?lat=&lon=&alt=&heading=&ve=` onto it.) The orientation is built from a radial basis
(up = radial, forward = north tangent), and the craft is seeded with a forward velocity
(`CRUISE_SPEED = 450` wu/s) and a cruise throttle (`CRUISE_THROTTLE = 0.485`) whose target
speed equals `CRUISE_SPEED`. With no thrust input the throttle holds, so from frame 1 the
craft holds altitude and speed — no free-fall, no climb-out. Pitch down dives; pitch up +
Shift+Space climbs to space.

**Flight model** (see `docs/physics.md`): speed is **decoupled from altitude**. Throttle
sets a *target speed* (hard-capped at `V_CAP = 10000` wu/s, so the HUD km/h is always
bounded). In the atmosphere the craft flies **by the nose** — a level nose holds altitude at
any speed, pitch climbs/dives, and dropping below `STALL_SPEED` makes it sink. In space it is
**Newtonian** (coasts; gravity + nose-thrust only). The two blend by air density. The chase craft is a small foreground silhouette against the terrain and
curved horizon ahead (AIRCRAFT_SCALE small vs the 6000 wu planet).

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
- `eng.speed()` → f32 (world units/sec).
- `eng.speed_kmh()` → f32 (km/h) = `speed() × M_PER_WU × 3.6` (same horizontal planet scale).
- `eng.lat_lon()` → `Float32Array` length 2 `[lat, lon]` — the **sub-camera point**: the camera
  position projected onto the globe. `lat = asin(cam.y / |cam|)`, `lon = atan2(-cam.z, cam.x)`,
  both in degrees. Shows what the camera is above.

## Rendering contract (web side)
- Enable depth test (LEQUAL). Draw the dark occluder-sphere fills (they write depth and hide
  the far hemisphere), then the bright latitude-ring lines on top. Background-colored fills +
  bright elevation-shaded lines give the Joy Division globe. Restrained palette, no neon.
- No bundlers, all relative paths, no server assumptions. Fetch `../data/*.bin` + `../data/meta.json`
  and `./pkg/*` at runtime.
</content>
