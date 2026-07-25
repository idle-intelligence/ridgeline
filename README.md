# ridgeline

A 3D explorer of the solar system's solid worlds, each rendered as a globe of stacked Joy Division
"Unknown Pleasures" latitude rings. Real elevation data; spawn out in deep space, recognise the
continents (or Olympus Mons, or Mare Imbrium) on the glowing globe, then orbit, dive, and skim the
surface — or pull all the way out to a SYSTEM view of the whole orrery.

A `game + dataviz` experiment — a thing I built, not a polished product. Static site: no bundler,
no server, all relative paths.

## Requirements
A **WebGPU** compute renderer, so a WebGPU-capable browser is required
(Chrome/Edge 113+, Safari 18+; Firefox Android has no WebGPU yet).

## Run locally
Prerequisites:
```
# 1. Fetch the ~400 MB binary heightfields (hosted as a Hugging Face dataset)
hf download idle-intelligence/ridgeline-terrain --repo-type dataset --include "*.bin" --local-dir data

# 2. Build the WASM core (outputs to web/pkg/)
wasm-pack build core --target web --out-dir ../web/pkg
```
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

## Heads up
Sky markers and the bodies' motion are **illustrative** — they show that other worlds exist and
roughly how fast each one spins/orbits, but they are **not a real ephemeris**: the planets are not
in their true positions relative to each other.

## Stack
- **Rust → WASM** core (`core/`): spherical world mapping, heightfield ownership, per-frame
  cull/LOD. `wasm-pack build --target web`.
- **Vanilla JS** shell (`web/`): WebGPU compute renderer (ridgeline geometry generated in WGSL),
  render loop, input. No bundler, static assets only.
- **Python** offline bakes (`data/bake/`): public-domain government DEMs → compact binary
  heightfields + meta.

## Layout
```
data/        meta.json per body + bake pipelines; *.bin heightfields fetched from HF (gitignored)
data/bake/   Python pipelines: bake_earth.py / bake_moon.py / bake_mars.py
core/        Rust/WASM crate
web/         JS shell — index.html (the explorer), about.html, renderer, static assets
```

## Data & license
Elevation data is public-domain government work (NASA / USGS / NOAA) — see
[`data/ATTRIBUTION.md`](data/ATTRIBUTION.md). Code is MIT — see [`LICENSE`](LICENSE).
The large `data/*.bin` blobs live in a
[Hugging Face dataset](https://huggingface.co/datasets/idle-intelligence/ridgeline-terrain)
(not in this repo); the app caches them in-browser via the Cache API after first download.
