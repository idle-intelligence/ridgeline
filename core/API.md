# ridgeline core ↔ web contract

`core/` is a thin Rust/WASM heightfield loader. The rest of the explorer (camera, geometry,
rendering, ephemeris) lives in `web/`.

## Build
```
cd core && wasm-pack build --target web --out-dir ../web/pkg
```
Web imports: `import init, { Engine } from "./pkg/ridgeline_core.js";`
`web/pkg/` is gitignore'd (build artifact) — this crate does not commit it.

## Constants (`core/src/heightfield.rs`)
- `R_WORLD: f32 = 6000.0` — planet radius in world units.
- `EARTH_RADIUS_M: f32 = 6_371_000.0` — Earth radius in meters (horizontal scale reference).
- `VERT_EXAGGERATION: f32 = 8.0` — vertical exaggeration as a multiple of true (1:1) scale.
- `VERT_SCALE: f32 = (R_WORLD / EARTH_RADIUS_M) * VERT_EXAGGERATION` — world units per meter
  of elevation. At 1× (realistic) Everest (8849 m) ≈ 8.3 wu.

## Construction
```rust
Engine::new(
    width: u32,
    height: u32,
    hf_bytes: &[u8],  // raw little-endian i16 meters, row-major, row 0 = north
    elev_max: f32,    // meters
    lat_min: f32,
    lat_max: f32,
    lon_min: f32,
    lon_max: f32,
) -> Engine
```
Parses `hf_bytes` into an `i16` elevation grid and stores the bbox. No physics, no geometry —
just the heightfield.

## Getters
- `heightfield_i16_ptr() -> u32` — byte offset into `wasm.memory.buffer` of the raw `i16`
  elevation grid (meters, row-major, row 0 = north).
- `heightfield_i16_len() -> u32` — element count of that grid (`width * height`; byte length
  is `2 * len`).
- `grid_width() -> u32`
- `grid_height() -> u32`
- `vert_scale() -> f32` — `VERT_SCALE`, so callers can convert raw i16 meters to world units
  (`m * vert_scale()`).
- `elev_world_max() -> f32` — max terrain elevation in world units (`elev_max * VERT_SCALE`).
