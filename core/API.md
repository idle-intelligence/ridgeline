# ridgeline core ↔ web contract (AUTHORITATIVE — v1)

This is the frozen seam between the Rust/WASM `core/` and the JS/WebGL2 `web/`.
Both sides build against THIS document. If you need to change it, change it here first.

## Build & module
- `core/` builds with `wasm-pack build --target web --out-dir ../web/pkg --out-name ridgeline_core`.
- Web imports: `import init, { Engine } from "./pkg/ridgeline_core.js";`
- `web/pkg/` is gitignore'd (build artifact). Core agent does NOT commit it.

## Coordinate system (core owns world-space mapping)
- World axes: **x = longitude (west→east), z = latitude, y = elevation (up).**
- Core maps the heightfield grid into a centered world box (WORLD_HALF=40000 wu) and applies
  vertical exaggeration VE=6 so terrain reads dramatically. horiz_scale ≈ 0.0726 wu/m →
  Mont Blanc (4672 m) renders ~2036 wu, coastal hills are clearly visible.
- North (lat_max, row 0) maps to one z extreme consistently; camera spawns positioned to SEE
  the terrain (elevated, above the field, looking across it) with a satisfying horizon.

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

## Camera (third-person chase)
The camera is positioned behind and above the ship in ship-local space:
`cam_pos = ship_pos + ship_orientation * (0, CHASE_UP=30, CHASE_BACK=120)`.
View direction = ship orientation + freelook offset (`set_look`). Flight physics
(`phys.position`, `phys.orientation`) are the **ship** transform; the camera
offset is view-only.

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

## Geometry getters (regenerated each `step`, back-to-front / painter order)
Core culls + LODs visible rows and emits drawable strips, **farthest first** so the painter's
algorithm yields the layered ridge occlusion.

- `eng.fill_vertices()` → `Float32Array`, packed `[x,y,z, x,y,z, ...]`. Triangle-strip layout
  per visible row: alternating baseline vertex / profile vertex along the latitude line.
- `eng.fill_draws()` → `Uint32Array`, flat pairs `[start0,count0, start1,count1, ...]` in
  back-to-front order. JS issues `gl.drawArrays(gl.TRIANGLE_STRIP, start, count)` per pair.
- `eng.fill_strengths()` → `Float32Array`, one f32 per vertex, parallel to `fill_vertices()`.
  Values in [0..1]. Multiply fill color alpha by this in the fragment shader.
  Ramps to 0 near the far-cull boundary (eliminates far speckle pop-in). No band-boundary
  fade — the index-anchored stride scheme makes band transitions stable without it.
  Sea vertices (elevation ≤ ~0 m, clamped to 0 in the bake) have strength = 0 (blank ocean).
  Flat land (plains, valleys, lagoons) renders normally — only elevation determines sea.
  Requires alpha blending enabled.
- `eng.fill_elevations()` → `Float32Array`, one f32 per vertex, parallel to `fill_vertices()`.
  Values in [0..1] = elev_world / elev_world_max (clamped). 0 = sea level, 1 = highest peak.
  Use to drive elevation→brightness in the fragment shader.
- `eng.line_vertices()` → `Float32Array`, packed `[x,y,z, ...]`. The bright ridge polyline
  (top profile only) per visible row.
- `eng.line_draws()` → `Uint32Array`, flat pairs `[start,count, ...]`, back-to-front. JS issues
  `gl.drawArrays(gl.LINE_STRIP, start, count)` per pair.
- `eng.line_strengths()` → `Float32Array`, one f32 per vertex, parallel to `line_vertices()`.
  Same fade semantics as `fill_strengths()`. Sea vertices have strength = 0. Apply to ridge line alpha.
- `eng.line_elevations()` → `Float32Array`, one f32 per vertex, parallel to `line_vertices()`.
  Values in [0..1] = elev_world / elev_world_max (clamped). Same semantics as `fill_elevations()`.

Indices in `fill_draws`/`line_draws` are VERTEX indices into the respective vertex array
(not byte offsets). Returned typed arrays are copies; valid until the next `step`.

**Alpha blending contract**: enable `gl.BLEND` with `gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)`.
Back-to-front painter's order (guaranteed by core) is required for correct compositing.

## Debug getters (optional, for HUD)
- `eng.altitude()` → f32 (world units above local baseline; raw, includes VE and horiz_scale)
- `eng.altitude_m()` → f32 (real meters above local baseline) = `altitude() / (VE × horiz_scale)`
- `eng.speed()` → f32 (world units/sec)
- `eng.speed_kmh()` → f32 (km/h) = `speed() / horiz_scale × 3.6` where `horiz_scale` (wu/m)
  is stored on the `Heightfield` (computed from the bbox; ≈ 0.0726 wu/m for the France grid →
  ≈ 13.8 m/wu). Use this for the HUD; `speed()` is kept for internal/debug use.
- `eng.lat_lon()` → `Float32Array` length 2 `[lat, lon]` — ship geographic position in decimal
  degrees. Computed by inverse-mapping `phys.position` through the stored bbox bounds:
  `lon = lon_min + (pos.x - hf.x_min) / (hf.x_max - hf.x_min) * (lon_max - lon_min)`,
  `lat = lat_min + (pos.z - hf.z_min) / (hf.z_max - hf.z_min) * (lat_max - lat_min)`.

## Rendering contract (web side)
- Enable depth test; draw all fill strips back-to-front, then the ridge lines (LEQUAL or a
  small depth bias so lines read on top of their own fill). Background-colored fills + bright
  lines give the Joy Division layering. Restrained palette, no neon.
- No bundlers, all relative paths, no server assumptions. Fetch `../data/*.bin` + `../data/meta.json`
  and `./pkg/*` at runtime.
</content>
