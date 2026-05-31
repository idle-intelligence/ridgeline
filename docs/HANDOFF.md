# ridgeline — handoff doc

A complete pick-up reference for another agent (or future-you) taking over the
project. Read this first, then `CLAUDE.md`, then the recent commits.

Last updated: 2026-05-31 at commit `6359423` (main), **96 atomic commits** of history.

---

## TL;DR

**ridgeline** is a 3D flight game over the *whole Earth*, rendered as a globe of
stacked Joy Division "Unknown Pleasures" latitude rings (real ETOPO 2022 elevation,
12288×6144 / ~3.3 km/cell). You fly a small manta-style craft through three flight
modes — **ATMO / ORBIT / INTERPLANETARY** — with proper gravity, atmosphere, drag,
banking turns, terrain-following autopilot, capture-back-from-space assist,
afterburner-to-orbit ascent, freelook, and a context-aware HUD that tells you
whose gravity well you're in.

Rendering is **WebGPU by default** (compute-driven geometry → `eng.step()` ~0 ms,
no CPU bottleneck), with **WebGL2 as automatic fallback**. Both paths visually
match. `main` is always flyable.

Run: `python3 -m http.server 8080` from the repo root, open
`http://localhost:8080/web/`. URL params: `?lat=&lon=&alt=km&heading=°&ve=mult&agl=m&webgpu=0`.

---

## Architecture

| Layer | Where | What |
|---|---|---|
| Data | `data/heightfield.bin` (144 MB int16 LE, **Git LFS**), `data/meta.json`, `data/aircraft.json` | Global ETOPO 2022, 12288×6144, lat 90→-90 row-major, lon -180→+180, sea clamped to 0. Aircraft = procedural manta wireframe. Baked offline: `data/bake/bake_earth.py` (uses cached ETOPO NetCDF; pure data, doesn't re-download). |
| Core | `core/` (Rust → wasm-bindgen) | Heightfield, physics, geometry generation. `wasm-pack build --target web --out-dir ../web/pkg --out-name ridgeline_core`. |
| Web shell | `web/` (vanilla JS + WebGL2 *and* WebGPU, no bundler) | Two renderers (auto-select), game loop, input (kbd + mouse + touch). |
| Docs | `docs/` | This handoff, `physics.md`, `overnight-plan.md`, four reports under `docs/reports/`. |

### Coordinate system & scale
- World axes: **x=lon east, y=up (+Y = north pole), z=lon south** (right-handed; longitude handedness was un-mirrored in commit `3f9eb09`).
- `R_WORLD = 6000 wu`. `M_PER_WU = EARTH_RADIUS_M / R_WORLD ≈ 1061.8` m/wu (horizontal real scale).
- Vertical: **altitude-coupled exaggeration**. `VE = ve_for_altitude(alt_wu)` ramps `VE_NEAR=2.75` near surface → `VE_FAR=14` in space (Ponzo / size-constancy trick the user explicitly designed). A `set_exaggeration_override(ve)` setter + `?ve=` URL param bypass it.
- Heightfield is stored **int16 in WASM** (151 MB, halved from 302 MB f32). `sample()` returns `i16·VERT_SCALE` on read.

### Flight modes (crossfaded by altitude, see `core/src/physics.rs`)
| Mode | Band (wu above sea) | Speed envelope (wu/s) | Hard cap | Behaviour |
|---|---|---|---|---|
| **ATMO** | 0 .. 1500 (`ATMOSPHERE_TOP`) | IDLE 30 .. CRUISE 400 | 400 | fly-by-nose; quadratic drag (bleeds in ~1.6 s); AGL terrain-following; auto-level; banking. |
| **ORBIT** | 1500 .. 12000 (`ORBIT_TOP = 2·R_WORLD`) | ~1000 .. 3000 | 3000 | gentle altitude hold; thin air; easy escape; banking. |
| **INTERPLANETARY** | > 12000 | up to `V_CAP = 10000` | 10000 | Newtonian inertia + inverse-square gravity (escape/orbit/coast); CAPTURE assist eases re-entry. |

- All three crossfade smoothly; the same hard `V_CAP=10000` clamps `|velocity|`.
- **Afterburner ascent-assist**: hold `Space` with no manual pitch/roll → auto gravity-turn climb (60°→5° as altitude grows), ATMO→ORBIT in ~2.2 s today (player wants this *less steep / longer* — see open items), continued hold → escape ~5.5 s. Manual pitch/roll overrides; releasing settles into the current mode.
- **Capture / planetary-mode**: above ATMOSPHERE_TOP, returning from deep space crosses `CAPTURE_ALT=10·R_WORLD` → fly-by-nose steering ramps in + speed cap bleeds to `APPROACH_SPEED=2000` so you can't overshoot. Not a prison: afterburner out still escapes.
- **Rotational inertia** on attitude: input sets a target angular velocity that eases in (τ≈0.22 s ATMO → ~0.40 s at orbit speeds). Controls feel weighty, not instant.

### Rendering — two paths, identical look
- **WebGPU (default when `navigator.gpu` + adapter)**: `web/renderer-webgpu.js`. Heightfield uploaded **once** as int16 GPU storage buffer (151 MB). Each frame: a cheap CPU O(rows) ring-schedule → WGSL **compute** pass ports `emit_ring` (sphere mapping, distance-based LOD, sub-ring interpolation, strength/sight/horizon culling, atomic compaction) → writes `drawIndexedIndirect` args → one render pass per channel. **CPU `eng.step()` cost: ~0.003 ms** (just physics + camera). All channels (lines + fill occluder + starfield + manta aircraft) ported with visual parity.
- **WebGL2 (automatic fallback, or `?webgpu=0`)**: `web/renderer.js`. The Rust core generates geometry per frame into `Vec`s with `.clear()` retention; JS gets zero-copy typed-array views over WASM memory and uploads via persistent VBOs + `bufferSubData`; single `drawElements` per channel via primitive-restart. Still works but CPU-bound (eng.step() = the workload; was the cause of the player's rAF violations before WebGPU).
- Geometry layout: **fill** = dark occluder (sphere dome from afar, per-ring terrain-following strips near; the `OCCLUDER_R = R_WORLD·0.985` + gate prevent depth-fighting that flattened orbit earlier). **Lines** = bright latitude rings with elevation-brightness (ocean dim / land glow, with a warm tint at peaks), strength/limb-fade alpha. **Starfield** = full-screen hash-based world-space stars (parallax correctly).
- LOD: per-camera-distance stride bands (powers of two, index-anchored → no swimming); a global `lod_boost` by quantized altitude (1 in ATMO+ORBIT, 2 in INTERPLANETARY); sub-ring interpolation 6/4/2 near surface, off above 1500 wu. Horizon + sight-cone culling.
- Camera: chase cam (`CHASE_UP/BACK` ship-local), freelook (`set_look` accumulates yaw/pitch offset). **Orbital framing**: smoothstep over 750→1500 wu blends from ATMO forward-chase to "look down the gravity axis at the planet" (~17° off-nadir tilt). The geometry sight-cull follows the real camera direction (freelook-aware), no flicker.

### HUD (`web/main.js`)
`<n> km/h · THR <n>% · <DIST> · <lat> <lon> · <MODE>` where `<DIST>` is mode-aware:
- ATMO → `GND <n> wu` (height above ground in world units)
- ORBIT → `PLANET <n> km` (above planet surface)
- INTERPLANETARY → `EARTH <n> Mm` (placeholder until a sun exists; becomes `SUN <n> AU` then)

### Controls
- **Z/S** pitch · **Q/D** roll · **A/E** yaw (rudder) · **Shift/Ctrl** throttle up/down · **Space** afterburner (hold = ascent-to-orbit / escape with throttle) · **Mouse** freelook (view only) · **Touch drag** = freelook on phone (no flight controls on touch yet).

---

## Recent work (the 96 commits, grouped)

### Foundation
- Rust/WASM core + WebGL2 shell + procedural manta aircraft (early)
- France-only smoke test → **global ETOPO 8192×4096** bake → **12288×6144 re-bake** (final)
- Sphere model: lat/lon/elev → globe; un-mirrored longitude handedness (`3f9eb09`)

### Rendering quality + perf (chronological)
- Stable index-anchored LOD (kill swimming `9eaba1c`); altitude-driven view distance + curvature
- VE bump + smaller craft; later **altitude-coupled VE** (Ponzo)
- Per-ring filled occlusion → fixed see-through, with dome gating to disc regime to prevent torn wedges at altitude/poles
- WebGL2 perf pass: **draw-call batching (752→1) + zero-copy WASM→JS + persistent VBOs** (`4edc846`)
- Sub-ring interpolation 6/4/2 for dense near-surface detail
- Hard per-frame **geometry budget** by altitude (`178587c`) — bounded cost above 1500 wu
- **WebGPU prototype** (`f61c599`, then `6359423`): compute-driven geometry, now default
- Trace-driven analysis throughout (`docs/reports/trace-20260528.md`, `docs/reports/trace-20260529.md`)

### Physics arc
- Three-mode crossfaded **ATMO/ORBIT/INTERPLANETARY** + per-mode caps + banking (`0ebc016`)
- **AGL terrain-following** (hugs valleys, climbs *before* peaks, glides down after) (`f0416ab`, `9ab688f`)
- VE-consistent AGL clearance (skim the *scaled* ridges) (`1dfdbf9`)
- Capture / planetary-mode assist for forgiving re-entry from deep space (`8d982d8`)
- **Afterburner ascent-assist** — one-button gravity-turn climb to orbit / escape (`0c7d0ed`)
- **Rotational inertia** on attitude (weighty controls, no orbit bounce) (`07936f3`)

### UX / framing
- URL params for spawn (`lat/lon/alt/heading/ve/agl/webgpu`)
- Context-aware **distance HUD** (`GND wu / PLANET km / EARTH Mm`) (`657d668`)
- Look-down **orbital camera** framing + much richer orbital detail + occluder depth fix (`598adc2`)

### Data + mobile
- Global re-bake to 12288×6144 (`23eb84d`)
- **int16 heightfield** in WASM + dropped unused water mask → 582 MB → 294 MB on mobile (`cdfd4f9`)

### Research / reports (all in `docs/reports/`)
- `perf-line-3d.md` — line-heavy web 3D perf approaches
- `flight-physics.md` — arcade flight, modes, AGL terrain-following algorithm
- `webgpu-games.md` — WebGPU for games, support, compute geometry, prototype scope
- `wgpu-feasibility.md` — wgpu/WASM vs JS+raw WebGPU (verdict: Path A = JS + raw WebGPU)
- `trace-20260528.md`, `trace-20260529.md` — Chrome perf traces (CPU gen was the wall)

---

## Current state (`main`, `6359423`)

- **Flyable everywhere.** WebGL2 fallback works; WebGPU is default and dramatically faster.
- **CPU `step` ~0.003 ms on WebGPU** (was up to 200 ms on WebGL2 over dense low terrain). No more rAF violations on the GPU path.
- **39 lib tests pass** (`cargo test --lib`), `cargo clippy --lib` clean.
- **Visual parity** between renderers at low/orbit/far (verified via Playwright headless capture).
- **Memory** 294 MB WASM (int16 heightfield), 144 MB heightfield download via LFS.

---

## How to run / test

```sh
cd /Users/tc/Code/ridgeline
python3 -m http.server 8080      # serve from repo root (data/*.bin is sibling)
open http://localhost:8080/web/  # WebGPU auto-default
```

URL params (all optional):
- `?lat=<deg>&lon=<deg>` — spawn location
- `?alt=<km>` — spawn altitude above sea
- `?heading=<deg>` — 0=north, 90=east
- `?ve=<mult>` — override altitude-coupled VE with a fixed multiplier
- `?agl=<m>` — AGL hold target in *VE-scaled* meters (default 500 = skims just above visible ridges)
- `?webgpu=0` — force the WebGL2 fallback (default = WebGPU when available)

Headless: `node web/test-headless.mjs` (uses Playwright in `web/node_modules`; ends "All checks passed"). Rust: `cargo test --lib` from `core/`. Rebuild WASM: `cd core && wasm-pack build --target web --out-dir ../web/pkg --out-name ridgeline_core`.

Tunnel (Cloudflare quick tunnel, was running for phone testing): the previous one was `https://solo-pushed-suggesting-fiscal.trycloudflare.com`. If still alive, that hits `:8080`; otherwise restart with `cloudflared tunnel --url http://localhost:8080 --no-autoupdate`.

---

## Open items (queued tasks)

1. **Liftoff curve is too steep / too fast** — user feedback: afterburner ascent should be **less steep and take longer**. Currently ATMO→ORBIT in ~2.2 s with a 60°→5° climb angle (in `core/src/physics.rs`, see `ASCENT_PITCH_RATE`, the lerp ends 55/60°→3/5°). Make the initial angle gentler (~30–40°) and slow the pitch-up ease, target ATMO→ORBIT in ~5–8 s, keep the escape-on-sustained-hold behaviour. (Task #62.)

2. **Orbital framing — the vessel isn't visible** — the look-down camera puts the planet under you but the *craft* should be **in frame** (the player can't see it). Adjust the off-nadir tilt (`OFF_NADIR = 0.30`, ~17°) and/or chase distance so the craft sits visible in the upper part of the frame instead of being off-screen. (Task #63.)

3. **User's uncommitted `web/renderer-webgpu.js` tweaks** (present identically in *both* worktrees): finer LOD entry into orbit (2000/4000/7000 wu bands with strides 6/12, 8/16, 16/24) and "always draw occluder dome" so the orbit→atmo mode-switch doesn't pop. Look clean — land them when you/the dashboard agent confirms. (Task #64.)

4. **Atlas / terrain collision** — undecided. Currently you fly *through* terrain at low altitude (floor only at sea-level sphere). Could add soft pull-up or hard collision.

5. **HUD Earth-centric** — `km/h` + `lat/lon` assume Earth. When other planets exist, swap to planet-agnostic units (see memory `earth-centric-hud-note`).

6. **Higher-res re-bake** — 16384×8192 (~2.5 km, +384 MB) or native 21600×10800 (~1.85 km, +670 MB) were offered before, fallback to 12288 was taken because CPU gen couldn't afford it. With WebGPU compute geometry, higher-res becomes affordable; only the GPU buffer + LFS size cost remains. Decision pending.

7. **Phone touch controls for flight** (look-only works today; flight is keyboard-only). Would need an on-screen joystick / throttle.

8. **WebGL2 fallback's low-altitude perf** — still CPU-bound on the fallback path (the WebGPU default fixes it for Chrome users). A `set_target_agl`-style low-altitude geometry cap could improve the fallback, but tradeoffs with near detail.

---

## User's pending work / worktree state

- Branch `worktree-buzzing-leaping-glacier` at `.claude/worktrees/buzzing-leaping-glacier/` (same commit as main: `6359423`) — the dashboard worktree.
- Uncommitted in both worktrees, **identical diff**: `web/renderer-webgpu.js` (16 lines: finer LOD bands + always-draw occluder dome). Treat as user-authored; commit when greenlit (don't `git add -A` it through unrelated changes).
- `.claude/` (worktree metadata) just added to `.gitignore`.

---

## Working conventions (the credo — please follow)

These came from `~/.claude/CLAUDE.md` and were enforced through every agent:

- **Atomic commits, one logical change each, on `main`.** Descriptive messages (the existing history is the template). Never `git add -A` from a sub-agent — stage only the files you touched. The user values being able to `git revert <hash>` any single change.
- **No `convergence/` directory or `/convergence` skill.** A subagent once auto-scaffolded a convergence harness when given a planning-shaped task — explicitly forbid it in every implementation prompt (`do NOT create plans/queues/surveys or any convergence/ directory, do NOT invoke any "convergence" skill`).
- **Sub-agents for code work, lead keeps context.** Read the relevant files, write a focused prompt, launch background general-purpose (or the `chrome-trace-analyzer` for traces). Tell each agent which files are theirs (scope) when running in parallel to avoid file collisions.
- **Verify before committing.** `cargo clippy` clean, `cargo test --lib` pass, `node web/test-headless.mjs` ends "All checks passed", `wasm-pack build` succeeds, and (for visual changes) a screenshot read with `Read`.
- **`main` stays flyable** at every commit. Risky multi-step rewrites go behind a flag (e.g. `?webgpu=1` was the pattern until WebGPU was proven, then it became default).
- **Don't commit** `web/pkg`, `web/*.png`, scratch test scripts, the `.claude/` worktree dir, or anything in `data/bake/cache/`. Big binaries go via Git LFS (`data/*.bin`).
- **No browser automation against the user's personal browser.** Use Playwright's bundled headless Chromium.
- **`refs/` and `/Users/tc/Code/RidgeShirts`** are read-only references; never modify.

---

## Reports & memory

Reports (committed) in `docs/reports/`:
- `perf-line-3d.md`, `flight-physics.md`, `webgpu-games.md`, `wgpu-feasibility.md`
- `trace-20260528.md`, `trace-20260529.md`

Global Memory pointers (`~/.claude/projects/-Users-tc-Code-ridgeline/memory/`):
- `earth-centric-hud-note.md` — HUD units are Earth-specific; revisit on multi-planet.

---

## Quick map for the next agent

- "Where does flight feel get tuned?" → `core/src/physics.rs` (constants: `ATTITUDE_TAU`, `ASCENT_PITCH_RATE`, climb-angle lerp, `DRAG_K`, `BANK_GAIN`, `AGL_K`, `TARGET_AGL`, mode caps).
- "Where does the look get tuned?" → `web/renderer.js` (WebGL2 shaders, palette), `web/renderer-webgpu.js` (WGSL), `core/src/heightfield.rs` (`VE_NEAR`, `VE_FAR`, `ve_for_altitude`).
- "Where's the orbital camera framing?" → `core/src/lib.rs` `cam_look_basis` + `orbit_frame_weight`; `OFF_NADIR` is the off-axis tilt to adjust to "see the vessel."
- "Where's the geometry generator?" → `core/src/geometry.rs` (CPU path, used by WebGL2 fallback) **and** `web/renderer-webgpu.js`'s WGSL compute (must keep them in sync visually).
- "Where do URL params plug in?" → `web/main.js` `applyUrlParams`.
- "Where to run tests?" → `cargo test --lib` from `core/`, `node web/test-headless.mjs` from repo root.
