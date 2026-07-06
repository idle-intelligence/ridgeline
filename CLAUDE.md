# ridgeline

3D flight game over the **whole Earth**, rendered as a globe of stacked Joy Division
"Unknown Pleasures" latitude rings. Real global ETOPO elevation; fly / orbit / dive over
recognizable continents. Exploration only (no weapons). Drops into trucs.ai as a static
Cloudflare Pages demo — **no bundlers, all relative paths, no server assumptions.**

## Layout
- `data/` — DONE. Global ETOPO bake (`data/bake/bake_earth.py`) → binary heightfield + meta.
  The `data/*.bin` blobs are NOT in git — they live in the HF dataset
  `idle-intelligence/ridgeline-terrain` (fetch with `hf download`, or re-bake).
- `core/` — Rust → WASM crate. `wasm-pack build --target web`. Spherical world mapping,
  flight physics, per-frame cull/LOD + ridgeline geometry generation. Heavy math here; JS thin.
- `web/` — vanilla JS + WebGL2 shell. `index.html`, game loop, input, renderer.

## Data contract (read dims from `data/meta.json` at runtime — NEVER hardcode)
- `heightfield.bin` — raw little-endian `int16` meters, no header, row-major `row*width + col`.
  Row 0 = north (lat_max) → south; col 0 = west (lon_min) → east.
- `water_mask.bin` — `uint8` 0/1, same dims/order (1 = flat water).
- `meta.json` — bbox, width, height, elev_min, elev_max, dtype/order fields.
- Current data is GLOBAL: 8192×4096, bbox lat -90..90 / lon -180..180, ETOPO 2022, ocean
  clamped to 0 (sea level). Rebake: `cd data/bake && .venv/bin/python bake_earth.py`.

## Render approach (spherical globe)
- 3D free-flight chase camera orbiting a globe centered at the origin. Core owns the
  world-space mapping: each cell (row=lat φ, col=lon λ, elev) → a point on a sphere of
  radius `R_WORLD + elev*VERT_SCALE`, north pole = +Y. See `core/API.md` for constants.
- Each grid ROW = a constant-latitude RING sweeping longitude → a bright `LINE_STRIP`
  (land bulges out and glows, ocean is a faint smooth circle). A coarse **dark occluder
  sphere** (fill TRIANGLE_STRIPs, just below sea level) hides the far hemisphere via the
  **depth test** — no longer painter's order, no flat N-S strips. The visible-hemisphere
  limb fades via per-vertex strength.
- A subtle static **starfield** (full-screen background, hash-based points, depth-write off)
  draws first, behind the globe.
- Aesthetic: restrained, away from neon-demo look.

## Controls
ZS = pitch · QD = roll · AE = yaw · Shift = throttle up · Ctrl = throttle down ·
Space-hold = afterburner · mouse = freelook. Sense of speed + uncluttered UI.

## Done bar
Spawn in space over Africa/Europe, recognize the continents on the glowing globe, fly /
orbit / dive with a satisfying sense of speed.

## Run locally
Serve from the REPO ROOT (not `web/`) so the app's `../data/*` fetches resolve:
`python3 -m http.server 8080` then open `http://localhost:8080/web/`.
(Port 8080 — `:8000` is another project. Fetches wasm + `../data/*.bin` + meta at runtime.)

## Conventions
- Commit early and often: small, atomic, one logical change each.
