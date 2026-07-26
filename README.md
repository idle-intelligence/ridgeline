# ridgeline

3D explorer of the solar system's solid worlds, each drawn as a globe of stacked Joy Division
"Unknown Pleasures" latitude rings from real elevation data.

[**Try the demo →**](https://idle-intelligence.github.io/ridgeline/web/)

[About](https://idle-intelligence.github.io/ridgeline/web/about.html)

![Earth in orbit view: the globe drawn as stacked latitude ridgelines, Africa and the Indian subcontinent picked out in relief](https://huggingface.co/datasets/idle-intelligence/ridgeline-terrain/resolve/main/preview.png)

Eleven bodies: Earth, Moon, Mars, Venus, Mercury, Ceres, Vesta, Enceladus, Pluto, Charon, and the
Sun (a magnetogram, not elevation). Orbit a body, dive to the surface, jump between bodies, or pull
out to a SYSTEM view of the whole orrery. Static site: no bundler, no server, all relative paths.

## Requirements

WebGPU, so a WebGPU-capable browser is required. Chrome and Edge have shipped it since 113; Safari
and desktop Firefox are recent enough at time of writing. Firefox on Android exposes no
`navigator.gpu`, so the page says so and stops. There is no fallback renderer.

## Run locally

You need a WebGPU browser, a [Rust toolchain](https://rustup.rs) with
[wasm-pack](https://github.com/drager/wasm-pack), and Python 3 to serve.

```
# web/pkg/ is gitignored, so the WASM core must be built before the app will load
wasm-pack build core --target web --out-dir ../web/pkg
python3 -m http.server 8080
```

Then open http://localhost:8080/web/, which is identical to the published demo, terrain included. No
terrain download is needed: tiers stream from the Hugging Face dataset and the browser caches
each one after first fetch.

Full-resolution terrain is only fetched once the camera descends, so a first visit costs
about 10 MB rather than the 150 MB+ a body's full tier would.

### Running against local terrain

For offline work, or to test a re-bake before uploading it:

```
hf download idle-intelligence/ridgeline-terrain --repo-type dataset --include "*.bin" --local-dir data
```

Then open http://localhost:8080/web/?data=local. Serve from the **repo root** (not `web/`) so the
app's `../data/*` fetches resolve.

`--include "*_d16.bin"` is only ~4 MB and paints every body, but it is a 16× decimation and that is
all you will ever see: the app refines to `_d4` (64 MB) and full resolution (1.1 GB) as you descend,
and any tier missing from disk 404s and leaves that world flat. The Sun degrades worst at `_d16`:
it is a signed magnetogram, so area-mean downsampling cancels opposite polarities and washes it out.

## Controls

Drag to orbit · right-drag / two-finger to pitch + turn · wheel / pinch to change altitude · click
a sky marker to jump to that body · zoom all the way out to see the system · time buttons speed
up the clock.

## How it works

- Each body is a globe of stacked constant-latitude rings. Every ring is an elevation profile
  sweeping longitude, so land bulges out as bright ridges and ocean sits as a faint smooth sphere.
- A dark occluder sphere hides the far hemisphere via the depth test; the visible limb fades out;
  altitude-based LOD keeps the whole globe cheap from orbit yet detailed up close.
- Vertical relief is exaggerated (tuned per body) so mountains read on a globe.

## Ephemeris

Body positions come from the JPL/Standish "Keplerian Elements for Approximate Positions of the
Major Planets" (1800–2050, J2000 epoch), solved per frame, so the SYSTEM view shows the planets
where they actually are, and each body's spin and orbital period are derived from the same elements
rather than hardcoded. Distances and body sizes are compressed for legibility.

## Stack

- **Rust → WASM** core (`core/`): a thin heightfield holder. It decodes and owns the int16 elevation
  buffer and exposes it, its dimensions, and its vertical scale to JS.
- **Vanilla JS + WGSL** shell (`web/`): all of the actual work: spherical world mapping, per-frame
  cull/LOD, ridgeline geometry in a WebGPU compute pass, camera, ephemeris, render loop, input.
- **Python** offline bakes (`data/bake/`): published government DEMs → compact binary heightfields
  and meta.

## Layout

```
data/        meta.json per body + bake pipelines; *.bin heightfields fetched from HF (gitignored)
data/bake/   Python pipelines: one bake_<body>.py per body, plus make_pyramid.py
core/        Rust/WASM crate
web/         JS shell: index.html (the explorer), about.html, renderer, static assets
```

## Re-baking the terrain

Each body has its own script in `data/bake/` (`bake_earth.py`, `bake_moon.py`, `bake_mars.py`,
`bake_venus.py`, `bake_mercury.py`, `bake_sun.py`, `bake_ceres.py`, `bake_vesta.py`,
`bake_enceladus.py`, `bake_pluto.py`, `bake_charon.py`). Each downloads its upstream DEM into
`data/bake/cache/` (gitignored, large) and writes `data/<body>_heightfield.bin` +
`data/<body>_meta.json`.

```
cd data/bake
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python bake_earth.py      # ...and any other bodies you want
.venv/bin/python make_pyramid.py    # REQUIRED: builds the _d4 / _d16 tiers
```

`make_pyramid.py` is not optional: the app fetches the `_d16` tier **first** for every body, so a
bake without it produces an app that never paints. Re-upload the mips along with the full-res file
after a re-bake, or the change will be invisible at altitude.

## Deploying

The published demo is the `gh-pages` branch: the contents of `web/` plus the built `web/pkg/`,
served at `/web/`. Terrain is never deployed; the page streams it from the HF dataset.

## Branches

`main` is the explorer. The `flight` branch keeps an earlier flight-arcade build (fly a craft over
the Earth globe), parked but working. Nothing on `flight` feeds into `main`.

`docs/` is a research log from along the way (WebGPU feasibility, perf traces, flight physics). It
is dated and describes the earlier architecture in places. A record, not maintained documentation.

## Data & license

Elevation data comes from NASA / USGS / NOAA / DLR / ESA sources, public domain or freely
redistributable. Every source and its terms are listed in
[`data/ATTRIBUTION.md`](data/ATTRIBUTION.md). Code is MIT, see [`LICENSE`](LICENSE). The large
`data/*.bin` blobs live in a
[Hugging Face dataset](https://huggingface.co/datasets/idle-intelligence/ridgeline-terrain), not in
this repo; the app caches them in-browser via the Cache API after first download.
