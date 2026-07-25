# ridgeline

3D explorer of the solar system's solid worlds — each rendered as a globe of stacked Joy
Division "Unknown Pleasures" latitude rings. Real elevation data; orbit a body, dive to the
surface, jump between bodies, or pull out to the SYSTEM view (a true-ephemeris orrery).
Exploration only. Drops into trucs.ai as a static Cloudflare Pages demo — **no bundlers, all
relative paths, no server assumptions.**

## Layout
- `data/` — DONE. Global ETOPO bake (`data/bake/bake_earth.py`) → binary heightfield + meta.
  The `data/*.bin` blobs are NOT in git — they live in the HF dataset
  `idle-intelligence/ridgeline-terrain` (fetch with `hf download`, or re-bake).
- `core/` — Rust → WASM crate. `wasm-pack build --target web`. Spherical world mapping,
  heightfield ownership, per-frame cull/LOD. Heavy math here; JS thin.
- `web/` — vanilla JS + WebGPU shell. `index.html` + `explore.js` (the explorer), `about.html`,
  `renderer-webgpu.js` (ridgeline geometry generated in WGSL), `system-view.js`, `ephemeris.js`.

## Data contract (read dims from `data/meta.json` at runtime — NEVER hardcode)
- `heightfield.bin` — raw little-endian `int16` meters, no header, row-major `row*width + col`.
  Row 0 = north (lat_max) → south; col 0 = west (lon_min) → east.
- `water_mask.bin` — `uint8` 0/1, same dims/order (1 = flat water).
- `meta.json` — bbox, width, height, elev_min, elev_max, dtype/order fields.
- Current data is GLOBAL: 8192×4096, bbox lat -90..90 / lon -180..180, ETOPO 2022, ocean
  clamped to 0 (sea level). Rebake: `cd data/bake && .venv/bin/python bake_earth.py`.

## Render approach (spherical globe)
- 3D orbit camera around a globe centered at the origin. Core owns the
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
Drag = orbit · right-drag / two-finger = pitch + turn · wheel / pinch = altitude ·
click a sky marker to jump to that body · time buttons scale the clock. Uncluttered UI.

## Done bar
Spawn in space over a recognizable world, orbit and dive to the surface, jump between
bodies, and pull all the way out to a SYSTEM view that is astronomically honest.

## Run locally
Serve from the REPO ROOT (not `web/`) so the app's `../data/*` fetches resolve:
`python3 -m http.server 8080` then open `http://localhost:8080/web/`.
(Port 8080 — `:8000` is another project. Fetches wasm + `../data/*.bin` + meta at runtime.)
WebGPU is required — Chrome/Edge 113+ or Safari 18+.

## Conventions
- Commit early and often: small, atomic, one logical change each.
