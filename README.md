# ridgeline

Fly over real terrain rendered as ridgeline graphs (Joy Division "Unknown Pleasures" aesthetic, in 3D).
A `game + dataviz` experiment. Started from the RidgeShirts elevation work.

## Concept
- Free-flight 3D camera over real elevation data.
- Terrain drawn as stacked constant-latitude profile strips, filled back-to-front (painter's algorithm) for the layered ridge look.
- Real SRTM elevation. v1: a slice of France (recognizable Alps / Pyrenees / coastline).
- Exploration only in v1. Combat (lasers / missiles / target-lock) is later.

## Stack
- **Rust → WASM** core (`core/`): heightfield, flight physics, per-frame ridgeline geometry generation. `wasm-pack build --target web`.
- **Vanilla JS + WebGL2** shell (`web/`): canvas, game loop, input, rendering.
- **Python** offline data bake (`data/bake/`): SRTM → compact binary heightfield + meta.

No bundlers. Static assets only — designed to drop into trucs.ai as a demo page (à la swarm/hive).

## Controls (planned)
ZQSD + A/E (AZERTY) and arrows to fly · Shift accelerate · Space-hold FTL · mouse-look.

## Layout
```
data/bake/   Python pipeline: SRTM fetch → downsample → heightfield.bin + meta.json
core/        Rust/WASM crate
web/         JS + WebGL2 shell, index.html, static assets
```
