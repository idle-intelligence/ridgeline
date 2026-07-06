# ridgeline

A 3D flight/explore toy over the **whole Earth** — and the **Moon** and **Mars** — each rendered
as a globe of stacked Joy Division "Unknown Pleasures" latitude rings. Real global elevation data;
spawn out in deep space, recognise the continents (or Olympus Mons, or Mare Imbrium) on the
glowing globe, then orbit, dive, and skim the surface.

A `game + dataviz` experiment — a thing I built, not a polished product. Static site: no bundler,
no server, all relative paths.

## Two modes
- **`web/explore.html`** — orbit-camera explorer: drift around a body, jump between Earth / Moon /
  Mars via the sky markers, morph from a top-down deep-space view down to skimming the surface.
- **`web/index.html`** — free-flight chase-camera game over the globe, with a sense of speed.

## Requirements
Both modes use a **WebGPU** compute renderer by default. Explore mode **requires** WebGPU
(Chrome/Edge 113+, Safari 18+; Firefox Android has no WebGPU yet). The flight game falls back to
WebGL2 automatically where WebGPU is unavailable (`?webgpu=0` forces WebGL2).

## Run locally
Prerequisites:
```
# 1. Pull the ~400 MB binary heightfields (stored in Git LFS)
git lfs install && git lfs pull

# 2. Build the WASM core (outputs to web/pkg/)
wasm-pack build core --target web --out-dir ../web/pkg
```

Serve from the **repo root** (not `web/`) so the app's `../data/*` fetches resolve:
```
python3 -m http.server 8080
```
- Explore: http://localhost:8080/web/explore.html
- Flight:  http://localhost:8080/web/

## Controls
**Explore** — drag to orbit · right-drag / two-finger to pitch + turn · wheel / pinch to change
altitude · click a sky marker (MOON / MARS) to jump there · time buttons speed up rotation.

**Flight** — ZS pitch · QD roll · AE yaw · Shift throttle up · Ctrl throttle down ·
Space-hold afterburner · mouse freelook.

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
- **Rust → WASM** core (`core/`): spherical world mapping, flight physics, per-frame cull/LOD +
  ridgeline geometry generation. `wasm-pack build --target web`.
- **Vanilla JS** shell (`web/`): WebGPU compute renderer + WebGL2 fallback, game loop, input.
  No bundler, static assets only.
- **Python** offline bakes (`data/bake/`): public-domain government DEMs → compact binary
  heightfields + meta.

## Layout
```
data/        Baked heightfields (*.bin) + meta.json per body — Earth, Moon, Mars (Git LFS)
data/bake/   Python pipelines: bake_earth.py / bake_moon.py / bake_mars.py
core/        Rust/WASM crate
web/         JS shell — explore.html, index.html, renderers, static assets
```

## Data & license
Elevation data is public-domain government work (NASA / USGS / NOAA) — see
[`data/ATTRIBUTION.md`](data/ATTRIBUTION.md). Code is MIT — see [`LICENSE`](LICENSE).
The large `data/*.bin` blobs are stored via **Git LFS**; install LFS and pull before serving.
