# Performance approaches for line-heavy web 3D — ridgeline

Research report (task #45). Informs the next perf implementation task (#46).
Date: 2026-05-27.

## TL;DR — top 3 cheapest wins to get near-surface back to ~60 fps

1. **Decouple FILL stride from LINE stride (coarse occluder fill).** The per-ring
   `emit_fill_strip` currently reuses the *same* dense column/row stations as the
   lines (~275k of the ~400k verts/frame). Fills only need to *depth-occlude* far
   terrain — they are drawn flat (`elev=0`) at the dark fill color and are never
   seen in detail. Generating them at 2–4× coarser row stride and 2–4× coarser
   column stride cuts fill verts ~4–16× with zero visible change. This is the single
   biggest CPU-gen win and touches one function. **Expected: gen time roughly halved
   (fills are the majority of verts).**

2. **Zero-copy WASM→JS via `Float32Array::view` over `memory.buffer`** instead of
   returning owned arrays that get copied across the boundary, plus `bufferSubData`
   into pre-sized persistent VBOs instead of re-`bufferData` (reallocating) every
   frame. Removes the per-frame copy of ~400k×(3+1+1) floats and the buffer
   reallocation. **Expected: a few ms/frame + less GC churn.**

3. **Batch the ~752 `LINE_STRIP` draws into 1–2 draws** using indexed draw with
   **primitive restart** (WebGL2 fixed index `0xFFFFFFFF`, always enabled). One
   `gl.drawElements(LINE_STRIP, …, UNSIGNED_INT)` with restart indices between
   strips replaces all 752 calls. Same for fills. **Expected: removes ~750 draw-call
   dispatches/frame — large win on the JS/driver side.**

Together these three are all WebGL2, require no new render path, and attack the three
named costs (CPU gen, transfer, draw calls) directly. WebGPU/compute (below) is the
deeper play but should stay a flagged prototype.

---

## Context: where the ~77–80 ms goes

Per frame `geometry::generate` (CPU/WASM) rebuilds the visible set:
- **LINE channel**: each visible latitude (sub-)ring is swept in longitude →
  LINE_STRIP runs (~140k verts, 752 draws).
- **FILL channel**: at low/mid altitude the dark dome is *suppressed*; instead
  `emit_fill_strip` fills between every consecutive rendered ring with a
  TRIANGLE_STRIP **on the same dense stations as the lines** (~275k verts).

So fills dominate vertex count yet carry no detail (flat, dark, occlusion-only).
Then `renderer.js` does `bufferData(DYNAMIC_DRAW)` (full realloc) of 6 arrays and
loops `drawArrays` per strip. The bottleneck is explicitly CPU gen; transfer and
draw-call count are secondary but cheap to fix alongside.

---

## 1. Cutting the CPU generation cost (the real bottleneck)

### 1a. Coarser FILL stride than LINE stride (highest impact)
The code comment for `emit_fill_strip` says it "reuses the exact same row/sub-row
stations and column strides as the lines so fills and lines align exactly." That
alignment was chosen to avoid z-fighting/tearing, but it forces the occluder to be
as dense as the bright lines. The occluder does not need to *match* the lines — it
only needs to sit *behind or at* them in depth and be visually flat. Concretely:

- Use `stride * 2` (or `*4`) for the fill column sweep, and skip sub-rings entirely
  for fills (use only the raw data rows / coarsest bracketing rings). A coarse dark
  surface a hair below the bright rings still occludes the far side identically.
- Push the fill *slightly inward* in radius (like the `OCCLUDER_R = R*0.999` trick
  already used for the dome) so a coarser fill mesh can never poke through the finer
  lines and cause tearing — this removes the reason the strides were coupled.
- Result: fill verts drop from ~275k toward ~30–70k. Since fills are the majority of
  the per-frame verts, this is the dominant saving.

### 1b. Tune sub-ring interpolation density
`subring_factor_for_distance` injects 6/4/2 extra rings in the near bands. Six
interpolated rings per data-row gap is a lot of *line* geometry near the camera.
Lowering near factor 6→4 (or 6→3) is a direct linear cut to near-band line verts;
A/B it for quality. The fills should not be subdivided at all (see 1a).

### 1c. Cache / reuse geometry across slowly-changing frames
The visible set is index-anchored (power-of-two strides, fixed sub-ring fractions),
so it only changes at discrete band boundaries — meaning frame-to-frame the *emitted
index set* is usually identical and only the camera matrix (a uniform) changes. Two
levels of reuse:
- **Skip regeneration when the band/longitude-window signature is unchanged.** Hash
  the inputs that actually change the emitted set: camera lat/lon band, altitude
  band, and the discretized sight direction. If unchanged since last frame, reuse the
  existing VBOs and only update `u_mvp`. Camera *rotation in place* and small drifts
  within a band then cost ~0 gen. This alone can take many frames to near-free.
- **Cache per-ring vertex runs** keyed by `(row, frac, col_stride)` and rebuild only
  rings whose band changed. More bookkeeping; do 1a/1c-signature first.

### 1d. Generate less, period
- The horizon/sight windowing already bounds longitude. Verify the 40° pad isn't
  over-emitting; it is generous by design but every padded column is a CPU vertex.
- `point_strength`/`in_sight` are evaluated per emitted vertex with a `normalize` and
  a sqrt each — fine, but if 1a/1c don't get there, hoist the per-ring constant work
  out of the column loop (lat sin/cos already are; the strength `cut` is too).

---

## 2. Reducing the WASM→JS transfer

Today `renderer.js` calls `eng.fill_vertices()` etc. (six arrays) then
`bufferData(…, DYNAMIC_DRAW)` six times — both a copy and a full reallocation.

### 2a. Zero-copy views into WASM linear memory
`js_sys::Float32Array::view` / `view_mut_raw` returns a typed-array **view into the
WASM `memory.buffer` without copying**
([js-sys docs](https://docs.rs/js-sys/latest/js_sys/struct.Float32Array.html),
[wasm-bindgen #1643](https://github.com/wasm-bindgen/wasm-bindgen/issues/1643)).
Expose `(ptr, len)` for each buffer and build the views in JS:
`new Float32Array(wasm.memory.buffer, ptr, len)`. Pass that straight to
`bufferSubData`. No boundary copy.

**Critical caveat** (well-documented): a view is invalidated whenever WASM memory
grows/reallocates — any Rust allocation after the view is taken can detach it
([wasm-bindgen guide](https://rustwasm.github.io/docs/wasm-bindgen/print.html),
[#1206](https://github.com/rustwasm/wasm-bindgen/issues/1206)). Mitigations: keep the
geometry `Vec`s in persistent fields on the engine (don't realloc each frame — reuse
capacity with `.clear()`), take the views *after* generation and *before* any further
alloc, and re-create the views if `wasm.memory.buffer` identity changed (compare with
`===`). Practically: do generation, then immediately read+upload, recreating views
only when the buffer object changes.

### 2b. Persistent buffers + `bufferSubData`, not `bufferData`
Allocate the VBOs once at a max size with `bufferData(null, size, DYNAMIC_DRAW)`,
then per frame `bufferSubData(0, view.subarray(0, used))`. Avoids reallocating GPU
storage every frame (orphaning/realloc is a known stall source). WebGL2 has no true
persistent-mapped buffers (that's a GL4/WebGPU feature), so `bufferSubData` into a
pre-sized buffer is the WebGL2-correct analog.

### 2c. Update only changed regions
Pairs with caching (1c): if only some bands changed, `bufferSubData` just those byte
ranges. Worth it only after 1c exists.

---

## 3. Reducing draw calls in WebGL2

### 3a. Primitive restart (recommended) — collapse 752 line draws → 1
WebGL2 behaves as if `PRIMITIVE_RESTART_FIXED_INDEX` is **always enabled**; the fixed
restart index is the max value of the index type (`0xFFFFFFFF` for `UNSIGNED_INT`)
([SPD blog](https://blog.spacepatroldelta.com/a?ID=00950-d878555f-a97a-4e32-9f40-fd9a449cb4fe),
[MDN drawElements](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawElements)).
Build one index buffer that lists each strip's vertices followed by a `0xFFFFFFFF`
separator, then a **single** `gl.drawElements(gl.LINE_STRIP, totalIndices,
gl.UNSIGNED_INT, 0)` draws all 752 strips disconnected. Same pattern for the fill
TRIANGLE_STRIPs. The core already emits `*_draws` as `(start,count)` pairs — trivially
convertible to a restart-delimited index array (emit it in Rust to keep it cheap).
This is the most portable batching technique (no extension needed).

### 3b. `WEBGL_multi_draw` — alternative, extension-gated
`WEBGL_multi_draw` adds `multiDrawArraysWEBGL(mode, firsts, …, counts, …, n)` —
exactly the `(start,count)` arrays the core already produces — issued as one call,
"reduces binding costs in the renderer and speeds up GPU thread time"
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_multi_draw),
[Khronos spec](https://registry.khronos.org/webgl/extensions/WEBGL_multi_draw/)).
Pros: zero data restructuring — feed `fill_draws`/`line_draws` directly. Cons: it's
an extension (check `getExtension`; broadly but not universally available), and it's
draw-array based so no index reuse. Good as a fast first step / fallback; primitive
restart (3a) is the no-extension baseline.

### 3c. Degenerate vertices (legacy alternative)
Joining strips with duplicated/zero-area vertices works without restart but only
naturally for TRIANGLE_STRIP (degenerate triangles); for LINE_STRIP it draws stray
connecting segments, so primitive restart is strictly better here. Mentioned only for
completeness.

### 3d. Merge fill + line passes — low priority
They use different fragment shaders and different primitive types, so they can't merge
into one draw cleanly. The win is in *reducing strips within each pass* (3a), not
merging the two passes. Keep them separate.

---

## 4. GPU-side geometry generation (deeper changes)

Goal: stop the CPU generating ~400k verts/frame at all. Three options, increasing
ambition.

### 4a. Vertex pulling from a heightfield texture (WebGL2, no compute)
Upload the heightfield once as a texture. Render rings *attribute-less*: a draw of N
vertices where the vertex shader uses `gl_VertexID` to compute `(lat, lon)`, samples
the height texture (`textureLod` in the vertex stage), and places the sphere point —
the same `sphere_point_scaled` math, on the GPU
([WebGL2 vertex pulling](https://webgl2fundamentals.org/webgl/lessons/webgl-pulling-vertices.html),
[WebGL2 heightmap](https://webgl2fundamentals.org/webgl/lessons/webgl-qna-drawing-a-heightmap.html)).
The CPU then only issues draws + a few uniforms (camera, ve, stride/band params); it
generates **no vertices and uploads nothing per frame**. Strength/horizon fade and
elevation→brightness all move into the shaders (cheap there). This is the biggest
structural win that stays in WebGL2.
- Trade-off: the *culling/windowing* logic (which rings, which longitude arc, sub-ring
  interpolation) must be reframed as draw parameters / discarded vertices rather than
  CPU branches. Doable: pick the ring/stride set CPU-side (tiny — it's just band math,
  not per-vertex) and let the shader pull+place+cull (collapse culled verts to a
  degenerate position or use restart). Pairs naturally with 3a.

### 4b. Transform feedback (WebGL2)
Run a vertex-only pass that writes generated sphere points to a buffer via transform
feedback, then draw from that buffer
([luma.gl transform feedback](https://tsherif.github.io/luma.gl/docs/developer-guide/transform-feedback.html)).
Mostly redundant with 4a for our case — 4a already does the generation inline in the
draw, avoiding the extra pass. Use transform feedback only if you need the generated
verts *reused* across multiple passes (we don't, really). Lower priority than 4a.

### 4c. WebGPU compute shader generation (deepest)
Move generation into a WebGPU compute pass: thousands of threads each compute one
ring vertex from the heightfield in GPU memory, write to a storage buffer, then render
it — CPU does nothing per frame but dispatch. As of late 2025 WebGPU ships by default
in Chrome, Firefox, Safari, Edge (~70% global support early 2026); compute-heavy and
procedural-generation workloads see the largest gains (commonly cited 2–3×, up to
order-of-magnitude for pure compute)
([MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API),
[webgpu.com critical mass](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/),
[WebGPU 2026 guide](https://explainx.ai/blog/webgpu-complete-guide-2026)).
- Trade-offs vs WebGL2: a whole second render path (the plan already wants this behind
  a flag, tasks #8–#10); WGSL rewrite of shaders; need a WebGL2 fallback for the
  remaining ~30% of clients. Highest ceiling, highest cost. For *our* workload, 4a
  (vertex pulling in WebGL2) captures most of the "CPU stops generating verts" benefit
  without the second-path cost, so 4a should precede 4c.

---

## 5. Line rendering quality + perf

Current lines are 1px `LINE_STRIP` (WebGL line width is clamped to 1 on most
implementations). If thicker/AA ridge lines are ever wanted, the standard technique is
**instanced quad/capsule expansion**: one instanced quad per segment, expanded to
width in the vertex shader using current+next position (the source buffer bound twice
at +1 offset), AA capsule in the fragment shader, one `drawArraysInstanced`
([shone.dev thick lines](https://shone.dev/thicklines/),
[WebGL2 instancing](https://webgl2fundamentals.org/webgl/lessons/webgl-instanced-drawing.html)).
This *also* naturally batches (one instanced draw per ring set) and reduces uploaded
data. **Not needed for current quality** (the look is deliberately fine 1px lines), so
this is optional — flag it only if the art direction wants thickness/glow. If pursued,
it would *replace* both the line batching (3a) and partly the upload work.

---

## 6. Prioritized recommendation for ridgeline

### Quick wins — WebGL2, do first (target: ~60 fps near surface, no quality loss)
| # | Change | Where | Expected impact |
|---|--------|-------|-----------------|
| Q1 | **Coarse FILL stride/no-fill-subrings** (decouple occluder density from lines; nudge fill radius inward to avoid tearing) | `geometry.rs` `emit_fill_strip` + caller | **Largest** — fills are the majority of ~400k verts; ~4–16× fewer fill verts → gen time roughly halved |
| Q2 | **Zero-copy `Float32Array::view` + persistent VBOs w/ `bufferSubData`** (reuse `Vec` capacity via `.clear()`, recreate views on buffer-identity change) | core export + `renderer.js` | Removes per-frame boundary copy + GPU realloc; few ms + less GC |
| Q3 | **Primitive-restart batching** of 752 line draws → 1 (and fills → 1); emit restart-delimited `UNSIGNED_INT` index array in Rust | `geometry.rs` + `renderer.js` | Removes ~750 draw dispatches/frame |
| Q4 | **Lower near sub-ring factor** 6→4/3 + audit 40° longitude pad | `geometry.rs` | Linear cut to near-band line verts; quality A/B |
| Q5 | **Band-signature frame cache** (skip regen when emitted index set unchanged; only update `u_mvp`) | core | Many frames → near-free gen during in-band motion/rotation |

The **2–3 cheapest that most likely hit 60 fps without quality loss: Q1 + Q3 + Q2.**
Q1 attacks the dominant vertex source, Q3 removes the draw-call wall, Q2 removes the
transfer/realloc cost — all three are surgical and quality-neutral. Add Q5 if in-band
camera motion still spikes.

### Deeper changes — prototype behind a flag (plan tasks #8–#10)
| # | Change | Expected impact | Cost |
|---|--------|-----------------|------|
| D1 | **Vertex pulling from height texture (WebGL2)**: CPU stops generating/uploading verts; shader pulls+places+culls via `gl_VertexID` | Removes the entire per-frame gen+upload; biggest structural win in WebGL2 | Medium — reframe culling as draw params; pairs with Q3 |
| D2 | **WebGPU compute generation** | Highest ceiling (2–3×+); CPU only dispatches | High — second render path + WGSL + WebGL2 fallback |
| D3 | **Instanced thick/AA lines** | Only if art wants thickness; also batches | Medium; optional |

Recommended sequence: **Q1 → Q3 → Q2 → (measure) → Q4/Q5 → D1 (flagged) → D2 (flagged).**
Do D1 before D2 — it captures most of the "CPU stops generating verts" benefit while
staying in the shipping WebGL2 path.

---

## Sources
- [WebGL2 primitive restart (fixed index) — Space Patrol Delta](https://blog.spacepatroldelta.com/a?ID=00950-d878555f-a97a-4e32-9f40-fd9a449cb4fe)
- [MDN — WebGLRenderingContext.drawElements()](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/drawElements)
- [MDN — WEBGL_multi_draw](https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_multi_draw)
- [Khronos — WEBGL_multi_draw extension spec](https://registry.khronos.org/webgl/extensions/WEBGL_multi_draw/)
- [js-sys — Float32Array (zero-copy `view`)](https://docs.rs/js-sys/latest/js_sys/struct.Float32Array.html)
- [The wasm-bindgen Guide (memory/view caveats)](https://rustwasm.github.io/docs/wasm-bindgen/print.html)
- [wasm-bindgen #1643 — `view_mut_raw`](https://github.com/wasm-bindgen/wasm-bindgen/issues/1643)
- [wasm-bindgen #1206 — coercing Rust memory into JS](https://github.com/rustwasm/wasm-bindgen/issues/1206)
- [WebGL2 Fundamentals — Pulling Vertices](https://webgl2fundamentals.org/webgl/lessons/webgl-pulling-vertices.html)
- [WebGL2 Fundamentals — Drawing a heightmap](https://webgl2fundamentals.org/webgl/lessons/webgl-qna-drawing-a-heightmap.html)
- [luma.gl — Transform Feedback (WebGL2)](https://tsherif.github.io/luma.gl/docs/developer-guide/transform-feedback.html)
- [MDN — WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
- [webgpu.com — WebGPU hits critical mass (all major browsers)](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/)
- [explainx.ai — WebGPU complete guide 2026](https://explainx.ai/blog/webgpu-complete-guide-2026)
- [shone.dev — WebGL thick lines (instanced quads)](https://shone.dev/thicklines/)
- [WebGL2 Fundamentals — Instanced Drawing](https://webgl2fundamentals.org/webgl/lessons/webgl-instanced-drawing.html)
