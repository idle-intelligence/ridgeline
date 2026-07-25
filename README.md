# ridgeline

A 3D explorer of the solar system's solid worlds, each rendered as a globe of stacked Joy Division
"Unknown Pleasures" latitude rings. Real elevation data; spawn out in deep space, recognise the
continents (or Olympus Mons, or Mare Imbrium) on the glowing globe, then orbit, dive, and skim the
surface — or pull all the way out to a SYSTEM view of the whole orrery.

A `game + dataviz` experiment — a thing I built, not a polished product. Static site: no bundler,
no server, all relative paths.

There is also a `flight` branch: a parked but working flight-sim build over the Earth globe. That
was the project's earlier incarnation, dropped once the explorer became the whole point. `main` is
the explorer; nothing on `flight` feeds into it.

## Requirements
A **WebGPU** compute renderer, so a WebGPU-capable browser is required
(Chrome/Edge 113+, Safari 18+; Firefox Android has no WebGPU yet).

## Run locally
You need:
- a **WebGPU-capable browser** (see Requirements above)
- a **Rust toolchain** ([rustup](https://rustup.rs)) and
  [**wasm-pack**](https://rustwasm.github.io/wasm-pack/installer/) — `web/pkg/` is a build
  artifact and is not committed, so the WASM core must be built before the app will load
- **Python 3** — only if you want to serve with `http.server` or re-bake the terrain yourself

```
# 1. Fetch the binary heightfields (hosted as a Hugging Face dataset) — ~1.2 GB for everything
hf download idle-intelligence/ridgeline-terrain --repo-type dataset --include "*.bin" --local-dir data

# 2. Build the WASM core (outputs to web/pkg/)
wasm-pack build core --target web --out-dir ../web/pkg
```
You don't need all 1.2 GB to run it. The app streams coarse-to-fine and only fetches what you
visit: the `_d16` tiers for all eleven bodies are ~4 MB total and are what paints the first frame,
with `_d4` and full resolution pulled in the background as you get closer. Fetching just
`--include "*_d16.bin"` is enough to fly around everything.

(No `hf` CLI? Grab the files by URL from
https://huggingface.co/datasets/idle-intelligence/ridgeline-terrain into `data/` —
or re-bake them yourself with the scripts in `data/bake/`.)

Serve from the **repo root** (not `web/`) so the app's `../data/*` fetches resolve:
```
python3 -m http.server 8080
```
Then open http://localhost:8080/web/

## Controls
Drag to orbit · right-drag / two-finger to pitch + turn · wheel / pinch to change altitude ·
click a sky marker to jump to that body · time buttons speed up the clock.

## How it works
- Each body is a globe of stacked constant-latitude rings — every ring is an elevation profile
  sweeping longitude, so land bulges out as bright glowing ridges and ocean sits as a faint
  smooth sphere. That stacked-ridge layering is the Joy Division look, wrapped around a planet.
- A dark occluder sphere hides the far hemisphere via the depth test; the visible limb fades out;
  altitude-based LOD keeps the whole globe cheap from orbit yet detailed up close.
- Vertical relief is exaggerated (tuned per body) so mountains read on a globe.

## Ephemeris
Body positions come from the JPL/Standish "Keplerian Elements for Approximate Positions of the
Major Planets" (1800–2050, J2000 epoch), solved per frame — so the SYSTEM view shows the planets
where they actually are, and each body's spin and orbital period are derived from the same
elements rather than hardcoded. Distances and body sizes are compressed for legibility.

## Stack
- **Rust → WASM** core (`core/`): a thin heightfield holder — it decodes and owns the int16
  elevation buffer and exposes it (plus its dimensions and vertical scale) to JS.
  `wasm-pack build --target web`.
- **Vanilla JS + WGSL** shell (`web/`): all of the actual work — spherical world mapping,
  per-frame cull/LOD, ridgeline geometry generation in a WebGPU compute pass, camera, ephemeris,
  render loop, input. No bundler, static assets only.
- **Python** offline bakes (`data/bake/`): published government DEMs → compact binary
  heightfields + meta.

## Layout
```
data/        meta.json per body + bake pipelines; *.bin heightfields fetched from HF (gitignored)
data/bake/   Python pipelines: one bake_<body>.py per body, plus make_pyramid.py
core/        Rust/WASM crate
web/         JS shell — index.html (the explorer), about.html, renderer, static assets
```

## Re-baking the terrain
Each body has its own script in `data/bake/` (`bake_earth.py`, `bake_moon.py`, `bake_mars.py`,
`bake_venus.py`, `bake_mercury.py`, `bake_sun.py`, `bake_ceres.py`, `bake_vesta.py`,
`bake_enceladus.py`, `bake_pluto.py`, `bake_charon.py`). Each one downloads its upstream DEM into
`data/bake/cache/` (gitignored, and large) and writes
`data/<body>_heightfield.bin` + `data/<body>_meta.json`.

```
cd data/bake
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python bake_earth.py      # ...and any other bodies you want
.venv/bin/python make_pyramid.py    # REQUIRED — builds the _d4 / _d16 tiers
```
`make_pyramid.py` is not optional: the app fetches the `_d16` tier **first** for every body, so a
bake without it produces an app that never paints.

## Data & license
Elevation data comes from NASA / USGS / NOAA / DLR / ESA sources, public domain or freely
redistributable — every source and its terms are listed in
[`data/ATTRIBUTION.md`](data/ATTRIBUTION.md). Code is MIT — see [`LICENSE`](LICENSE).
The large `data/*.bin` blobs live in a
[Hugging Face dataset](https://huggingface.co/datasets/idle-intelligence/ridgeline-terrain)
(not in this repo); the app caches them in-browser via the Cache API after first download.
