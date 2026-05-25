# ridgeline core ↔ web contract (AUTHORITATIVE — v1)

This is the frozen seam between the Rust/WASM `core/` and the JS/WebGL2 `web/`.
Both sides build against THIS document. If you need to change it, change it here first.

## Build & module
- `core/` builds with `wasm-pack build --target web --out-dir ../web/pkg --out-name ridgeline_core`.
- Web imports: `import init, { Engine } from "./pkg/ridgeline_core.js";`
- `web/pkg/` is gitignore'd (build artifact). Core agent does NOT commit it.

## Coordinate system (core owns world-space mapping)
- World axes: **x = longitude (west→east), z = latitude, y = elevation (up).**
- Core maps the heightfield grid into a centered world box and applies a vertical
  exaggeration so terrain reads dramatically. Exact constants are core's choice; document them.
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
eng.set_input(
  thrust,   // f32 -1..1  forward/back  (Z/S, ↑/↓)
  strafe,   // f32 -1..1  left/right    (Q/D)
  lift,     // f32 -1..1  down/up vertical
  pitch,    // f32 rate, mouse-Y + keys (radians/sec scale; core clamps)
  yaw,      // f32 rate, mouse-X + keys
  roll,     // f32 rate  (A/E)
  boost,    // f32 0..1   Shift = accelerate
  ftl       // bool       Space-hold = very-fast / FTL
);
eng.step(dt); // f32 seconds — advances quaternion physics + regenerates visible geometry
```
Mouse-look: JS converts pointer-lock deltas into pitch/yaw values; core integrates them.

## Viewport
- `eng.set_aspect(aspect)` — `aspect` = canvas width/height (f32). Call once after construction and on
  every resize. Core bakes a 45° vertical-FOV perspective; without this it defaults to 16:9 and
  non-16:9 canvases stretch. (Added during integration — projection math stays in core.)

## Camera getters (valid after `step`)
- `eng.view_proj()` → `Float32Array` length 16, **column-major**, ready for
  `gl.uniformMatrix4fv(loc, false, arr)`. (Combined projection * view.)
- `eng.camera_position()` → `Float32Array` length 3 `[x,y,z]`.

## Geometry getters (regenerated each `step`, back-to-front / painter order)
Core culls + LODs visible rows and emits drawable strips, **farthest first** so the painter's
algorithm yields the layered ridge occlusion.

- `eng.fill_vertices()` → `Float32Array`, packed `[x,y,z, x,y,z, ...]`. Triangle-strip layout
  per visible row: alternating baseline vertex / profile vertex along the latitude line.
- `eng.fill_draws()` → `Uint32Array`, flat pairs `[start0,count0, start1,count1, ...]` in
  back-to-front order. JS issues `gl.drawArrays(gl.TRIANGLE_STRIP, start, count)` per pair.
- `eng.line_vertices()` → `Float32Array`, packed `[x,y,z, ...]`. The bright ridge polyline
  (top profile only) per visible row.
- `eng.line_draws()` → `Uint32Array`, flat pairs `[start,count, ...]`, back-to-front. JS issues
  `gl.drawArrays(gl.LINE_STRIP, start, count)` per pair.

Indices in `fill_draws`/`line_draws` are VERTEX indices into the respective vertex array
(not byte offsets). Returned typed arrays are copies; valid until the next `step`.

## Debug getters (optional, for HUD)
- `eng.altitude()` → f32 (meters above local baseline)
- `eng.speed()` → f32 (world units/sec)

## Rendering contract (web side)
- Enable depth test; draw all fill strips back-to-front, then the ridge lines (LEQUAL or a
  small depth bias so lines read on top of their own fill). Background-colored fills + bright
  lines give the Joy Division layering. Restrained palette, no neon.
- No bundlers, all relative paths, no server assumptions. Fetch `../data/*.bin` + `../data/meta.json`
  and `./pkg/*` at runtime.
</content>
