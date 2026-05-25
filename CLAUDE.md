# ridgeline

3D flight game over real SRTM elevation, rendered as stacked Joy Division "Unknown Pleasures"
ridgeline strips. v1 = exploration only (no weapons). Drops into trucs.ai as a static
Cloudflare Pages demo — **no bundlers, all relative paths, no server assumptions.**

## Layout
- `data/` — DONE, committed. Offline Python bake (`data/bake/`) → binary heightfield + meta.
- `core/` — Rust → WASM crate. `wasm-pack build --target web`. Heightfield, flight physics,
  per-frame cull/LOD + ridgeline strip geometry generation. Keep heavy math here; JS stays thin.
- `web/` — vanilla JS + WebGL2 shell. `index.html`, game loop, input, renderer.

## Data contract (read dims from `data/meta.json` at runtime — NEVER hardcode)
- `heightfield.bin` — raw little-endian `int16` meters, no header, row-major `row*width + col`.
  Row 0 = north (lat_max) → south; col 0 = west (lon_min) → east.
- `water_mask.bin` — `uint8` 0/1, same dims/order (1 = flat water).
- `meta.json` — bbox, width, height, elev_min, elev_max, dtype/order fields.
- Current data is a 256² Alps smoke-test (Mont Blanc ~lat 45.833 / lon 6.857).
  Full France: `cd data/bake && .venv/bin/python bake.py`.

## Render approach (decided)
- 3D free-flight camera. World space: x=lon, z=lat, y=elevation.
- Each heightfield row = a constant-latitude profile polyline → a filled triangle-strip from a
  baseline up to the profile, background-colored, drawn **back-to-front (painter's algorithm)**
  so far ridges occlude near sky — that layering IS the ridge look. Plus a bright line on top.
- v1: world-fixed N-S profiles. View-aligned slices = Backlog.
- Aesthetic: restrained, away from neon-demo look. Terrain/water coloring = Backlog.

## Controls (AZERTY-aware)
ZQSD + A/E and arrow equivalents for move/pitch/roll/yaw · Shift = accelerate ·
Space-hold = FTL/very-fast · mouse-look. Prioritize sense of speed + uncluttered UI.

## v1 done bar
Take off, fly over the heightfield, recognize the Alps, with a satisfying sense of speed.

## Run locally
`cd web && python3 -m http.server` then open the printed URL. Fetches wasm + `../data/*.bin` + meta at runtime.

## Conventions
- Commit early and often: small, atomic, one logical change each.
- Do NOT touch `/Users/tc/Code/RidgeShirts` (read-only reference).
</content>
</invoke>
