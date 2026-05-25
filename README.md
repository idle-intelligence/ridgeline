# ridgeline

Fly over the whole Earth, rendered as a globe of stacked Joy Division "Unknown Pleasures"
ridgelines. A `game + dataviz` experiment. Started from the RidgeShirts elevation work.

## Concept
- A 3D flight game over the **entire planet**, not a flat slice.
- The Earth is drawn as a globe of stacked constant-latitude rings — each ring is an
  elevation profile sweeping longitude, so continents bulge out as bright glowing landmasses
  and oceans sit as a faint smooth sphere. That stacked-ridge layering IS the Joy Division look,
  wrapped around a planet.
- A dark occluder sphere hides the far hemisphere (depth test), the visible-hemisphere limb
  fades out, and altitude-based LOD keeps the whole globe cheap from orbit yet detailed up close.
- Real **global ETOPO elevation** (8192×4096). Recognizable continents: Africa, Europe, the
  Mediterranean, the Americas, the Himalaya, etc. Ocean is clamped to sea level.
- Spawn is out in space over Africa/Europe with a faint starfield behind the planet.
- Fly, orbit, and dive toward the surface. Exploration only — no weapons.

## Stack
- **Rust → WASM** core (`core/`): spherical world mapping, flight physics, per-frame
  cull/LOD + ridgeline geometry generation. `wasm-pack build --target web`.
- **Vanilla JS + WebGL2** shell (`web/`): canvas, game loop, input, renderer (occluder sphere,
  bright latitude rings, starfield, chase craft). No bundlers, static assets only.
- **Python** offline data bake (`data/bake/`): ETOPO 2022 → compact binary heightfield + meta.

Designed to drop into trucs.ai as a static demo page (à la swarm/hive).

## Controls
ZS = pitch · QD = roll · AE = yaw · Shift = throttle up · Ctrl = throttle down ·
Space-hold = afterburner · mouse = freelook.

## Layout
```
data/        Global ETOPO bake → heightfield.bin + water_mask.bin + meta.json (Git LFS)
data/bake/   Python pipeline (bake_earth.py): ETOPO 2022 → downsampled global heightfield
core/        Rust/WASM crate
web/         JS + WebGL2 shell, index.html, static assets
```

## Run locally
Serve from the REPO ROOT (not `web/`) so the app's `../data/*` fetches resolve:
```
python3 -m http.server 8080
```
then open `http://localhost:8080/web/`.

The big elevation binaries (`data/*.bin`) are stored via **Git LFS** — make sure LFS is
installed and the files are pulled before serving.
