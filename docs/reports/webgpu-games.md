# WebGPU for ridgeline — support, compute-driven geometry, migration, prototype

Research report (task #8). Informs the prototype task (#10).
Date: 2026-05-27.

## TL;DR

- **WebGPU is shippable in mid-2026** across all major *desktop* browsers (Chrome/Edge,
  Firefox, Safari) and on the two mobile targets that matter for a phone tester: **Chrome
  on Android 12+** (recent GPUs) and **Safari on iOS/iPadOS 26**. Global coverage is
  ~70%+ and climbing. Mobile is still fragmented (Firefox Android lags, older iOS has
  nothing) → **a WebGL2 fallback is mandatory**, feature-detected via `navigator.gpu`.
- **Yes — a WebGPU compute pass generating the ridge geometry directly from the
  heightfield is the right structural fix** for the ~24 ms/frame CPU-gen bottleneck. It
  is exactly the workload (per-vertex procedural generation + culling) where WebGPU shows
  its largest wins, and the **compute → indirect-draw** pattern lets the CPU stop
  generating *and* uploading verts entirely — it only dispatches and sets uniforms. This
  is the deeper play the perf report (#45) called "D2" and ranked highest-ceiling.
- It does **not** replace the working WebGL2 path. Recommended next step: a **parallel
  WebGPU renderer behind `?webgpu=1`** (and auto-enabled when `navigator.gpu` exists and
  a flag is set), rendering the *same* globe via compute-generated geometry, measured
  head-to-head against the WebGL2 path. Clear go/no-go criteria below.

---

## 1. Browser support (mid-2026)

WebGPU "hit critical mass" in late 2025 — it now ships **by default in Chrome, Edge,
Firefox, and Safari**
([web.dev](https://web.dev/blog/webgpu-supported-major-browsers),
[webgpu.com](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/),
[VideoCardz](https://videocardz.com/newz/webgpu-is-now-supported-by-all-major-browsers)).

| Target | Status (mid-2026) | Notes |
|---|---|---|
| **Chrome / Edge (desktop)** | Shipped & stable since Chrome 113 (Apr 2023) | D3D12 on Windows, Metal on macOS, Vulkan on Linux/ChromeOS. Most mature impl. |
| **Firefox (desktop)** | Shipped: Win (FF 141, Jul 2025), Apple-Silicon macOS (FF 145), broadened in FF 147 (Jan 2026) | Newest desktop impl; treat as "supported but youngest". |
| **Safari (desktop)** | Shipped in Safari 26.0 on macOS Tahoe 26 | Solid; requires the current OS. |
| **Chrome on Android** | Shipped since Chrome 121 | **Requires Android 12+ and Qualcomm/ARM GPUs.** Older/odd GPUs fall back. |
| **Safari iOS / iPadOS** | Shipped in **iOS/iPadOS 26** | Solid on the latest OS; anything older than iOS 26 has **no** WebGPU. |
| **Firefox on Android** | **Not yet** (still behind a flag / in progress, expected 2026) | Treat as unsupported on mobile. |

**Coverage / what fraction of users:** global support crossed ~70% in late 2025 and
keeps rising as Safari 26 / Firefox roll out
([byteiota](https://byteiota.com/webgpu-2026-70-browser-support-15x-performance-gains/),
[caniuse: webgpu](https://caniuse.com/webgpu),
[MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)). For a
hobby/portfolio game that's plenty — but the long tail (older phones, Firefox Android,
iOS < 26, locked-down corporate machines) is real.

**Phone testing reality (the user tests on a phone):** WebGPU will work *if* the phone is
a recent Android on Chrome **or** an iPhone/iPad on iOS 26+. If the test phone is an older
iPhone (< iOS 26) or uses Firefox Android, it falls back to WebGL2. So the prototype must
be reachable on *both* paths on the same device for an apples-to-apples comparison.

**Verdict:** WebGPU is viable to adopt now as the *primary* path with **WebGL2 as a
runtime fallback** — never WebGPU-only. Feature-detect with `if (navigator.gpu)` then
`await navigator.gpu.requestAdapter()` (adapter can still be `null` even when `navigator.gpu`
exists — e.g. blocklisted GPU — so check both).

---

## 2. Compute-driven geometry — the key win

**The question:** can a WebGPU compute shader generate the visible ridge geometry on the
GPU each frame, directly from the heightfield, doing the sphere mapping, LOD/stride
selection, sub-ring interpolation, and strength/sight culling, writing vertex/index
buffers that the render pass consumes — so the CPU stops generating verts?

**Answer: yes, and this is the canonical GPU-driven-rendering pattern.** The textbook flow
([WebGPU Fundamentals: indirect/vertex buffers](https://webgpufundamentals.org/webgpu/lessons/webgpu-vertex-buffers.html),
[Toji.dev: indirect draws](https://toji.dev/webgpu-best-practices/indirect-draws.html),
[teachme.sh: compute-to-render](https://www.teachme.sh/webgpu/compute-to-render),
[PlayCanvas: indirect drawing](https://developer.playcanvas.com/user-manual/graphics/advanced-rendering/indirect-drawing/)):

1. **Upload the heightfield once** as a GPU resource — either a storage buffer of int16
   (8192×4096 ≈ 64 M samples ≈ 128 MB as i16, or 256 MB if widened to i32/f32 for easy
   indexing) or, better, an **R16 texture** sampled in the compute shader (hardware
   addressing + filtering for the sub-ring/column interpolation you do today in
   `sample_row_frac`). This is a one-time cost, not per-frame.
2. **Per frame, dispatch one (or a few) compute pass(es).** Each invocation maps to one
   candidate ring vertex (workgroup over a (ring, column) grid). It does exactly what
   `emit_ring` / `sphere_point_scaled` / `point_strength` / `in_sight` do today, in WGSL:
   compute lat/lon → sample height → place sphere point → compute strength → cull. The
   per-distance stride/sub-ring selection (`strides_for_distance`,
   `subring_factor_for_distance`) becomes a small CPU-side band computation feeding the
   dispatch, or is done in-shader from camera uniforms.
3. **Write surviving verts into a storage buffer** flagged `STORAGE | VERTEX`, append-style
   via an atomic counter; write the index list (`STORAGE | INDEX`) the same way, using the
   same primitive-restart delimiting the Rust core already produces.
4. **Write the draw arguments** (vertex/index count, instance count) into an
   **indirect-draw args buffer** (`STORAGE | INDIRECT`). The render pass then calls
   `drawIndexedIndirect(argsBuffer)` — **the CPU never learns or uploads the count.**
   The data stays on the GPU end-to-end.

**Why this kills the ~24 ms:** that time is CPU sphere-math + per-vertex strength/sight
tests + sub-ring interpolation over ~400k verts, then a WASM→JS copy and VBO upload.
Compute does the identical math across thousands of GPU lanes in parallel, and the
indirect-draw pattern removes the readback/upload entirely. Reported WebGPU gains on this
exact class of workload (per-element procedural generation + culling staying on-GPU) are
large: particle/procedural systems moving from ~30 ms CPU to <2 ms, and 15k→200k objects
at locked 60 fps with CPU near zero
([fsjs.dev](https://fsjs.dev/webgpu-vs-webgl-performance-comparison/),
[threejsroadmap: galaxy compute](https://threejsroadmap.com/blog/galaxy-simulation-webgpu-compute-shaders),
[sitepoint](https://www.sitepoint.com/webgpu-vs-webgl-inference-benchmarks/)). Our 24 ms of
CPU gen should collapse toward ~single-digit-ms or less of GPU compute, and crucially come
**off the main-thread critical path**.

**Important caveat — compare against the cheaper WebGL2 alternative first.** The perf
report's **D1 (vertex pulling from a height texture, staying in WebGL2)** captures most of
the "CPU stops generating verts" benefit *without a second render path*: an attribute-less
draw where the vertex shader uses `gl_VertexID` to compute lat/lon, samples the height
texture in the vertex stage, and places the point. The structural win (no per-frame CPU
gen/upload) is the same; only the *culling/windowing* must be reframed as draw params. The
unique thing WebGPU buys over D1 is **GPU-side compaction + indirect draw** (only emit
surviving verts, count decided on GPU) and true general compute (workgroup shared memory, atomics)
— valuable if the culling/compaction itself is expensive, less so if D1's "place-and-fade
every candidate vertex" is good enough. So: D1 is the cheaper experiment, D2 (this) is the
higher ceiling. Doing a WebGPU spike anyway is justified because the project explicitly
wants a WebGPU path on the roadmap (tasks #8–#10) and because the compute model is the
clean long-term home for this geometry.

---

## 3. Perf vs WebGL2, and line rendering

**General perf:** for our line-heavy, per-frame-regenerated workload the win is almost
entirely on the **CPU/compute side**, not raster. WebGL2 is fine at *rasterizing* thin
lines; our problem is generating them. WebGPU's advantage is the compute model (direct
buffer access, shared memory, atomics) replacing WebGL's fragment-shader/transform-feedback
hacks, plus lower per-draw CPU overhead and indirect draw
([Three.js roadmap: WebGL vs WebGPU](https://threejsroadmap.com/blog/webgl-vs-webgpu-explained),
[volumeshader.dev](https://www.volumeshader.dev/en/blog/webgl-vs-webgpu)). Raw raster of the
same triangles/lines is roughly comparable; the structural CPU savings are the point.

**Line rendering in WebGPU — read this carefully.** WebGPU's `line-list`/`line-strip`
primitives exist but **rasterize at 1px only — there is no line-width control** (same
limitation as WebGL, by design across backends)
([gpuweb #1546](https://github.com/gpuweb/gpuweb/issues/1546)). For ridgeline this is
*fine today* — the art is deliberately fine 1px lines, so the compute pass can emit a
`line-strip` index buffer with primitive restart and the render pass draws it directly,
mirroring the current look. **If** thicker/AA/glowing ridge lines are ever wanted, the
standard WebGPU technique is **instanced quad/triangle-strip expansion**: one instance per
segment, expanded to width in the vertex shader, AA + caps/joins in the fragment shader
([rreusser/webgpu-instanced-lines](https://github.com/rreusser/webgpu-instanced-lines),
[m-schuetz/webgpu_wireframe_thicklines](https://github.com/m-schuetz/webgpu_wireframe_thicklines),
[Unlimited3D: wide lines drama](https://unlimited3d.wordpress.com/2025/10/27/the-drama-of-wide-lines-in-3d-graphics/)).
That pairs naturally with the compute pass (compute emits per-segment instance data). Not
needed for the prototype — keep 1px `line-strip` to match the current aesthetic.

---

## 4. Migration path from the WebGL2 renderer

This is an *additive parallel path*, not a rewrite. What changes:

**JS / renderer (`web/renderer.js` → a sibling `renderer-webgpu.js`):**
- **Init (async):** `navigator.gpu.requestAdapter()` → `adapter.requestDevice()` →
  `canvas.getContext('webgpu')` → `context.configure({ device, format })`. All async, so
  the engine bootstrap gains an `await`.
- **Pipelines instead of programs:** create a **compute pipeline** (geometry gen) and one
  or two **render pipelines** (lines, fills, stars, aircraft), each from a WGSL module. No
  `useProgram`; you set pipeline + bind groups per pass.
- **Bind groups / uniform buffers replace `gl.uniform*`:** camera matrix, `ve`, band/stride
  params, palette go into a uniform buffer; the heightfield texture/storage buffer and the
  generated vertex/index/indirect buffers go into bind groups.
- **WGSL ports** of the existing GLSL: the line/fill elevation→brightness fragment shaders
  and the starfield ray-reconstruction shader translate near-1:1 to WGSL (different syntax,
  same math). The vertex shaders become trivial (positions come from the compute-generated
  buffer).
- **Command encoder per frame:** encode compute pass (dispatch) → render pass
  (`drawIndexedIndirect`) → submit. No `bufferData`/`bufferSubData` of geometry at all.

**Rust / WASM core — role shrinks (this is the elegant part):**
- The core stops emitting `line_verts`/`fill_verts`/strengths/elevations/indices per frame.
- It instead provides: the **heightfield** (once, as bytes for the texture/buffer — it
  already owns the int16 grid) and a compact **per-frame params struct** (camera pos/fwd,
  `ve`, horizon dot, the chosen LOD band table). The sphere-mapping / strength / sight /
  sub-ring math moves into WGSL (it's a direct port of `geometry.rs`).
- The CPU-side **band/stride decision** (`strides_for_distance`,
  `subring_factor_for_distance`, the occluder gate) is tiny and can stay in Rust, feeding
  the dispatch — or also move to a small compute prepass. Keep it in Rust first; it's not
  the bottleneck.
- The existing WebGL2-facing exports stay, so the WebGL2 path is untouched.

**Keeping WebGL2 as a runtime fallback:**
- At startup: `const useWebGPU = !!navigator.gpu && new URLSearchParams(location.search).get('webgpu') === '1';`
  then `const adapter = useWebGPU && await navigator.gpu.requestAdapter();` — if either is
  falsy, construct the existing `Renderer` (WebGL2). Wrap both behind a common
  `draw(eng, …)` interface so the game loop doesn't branch.
- This means both renderers coexist; the WebGPU one is opt-in until proven, then can be
  flipped to default-on-when-supported with WebGL2 fallback.

---

## 5. Concrete recommendation for ridgeline's prototype (next task)

**Smallest valuable spike that proves the compute-geometry win without touching the working
WebGL2 path:**

**Scope — a parallel WebGPU renderer behind `?webgpu=1`:**
1. Add `web/renderer-webgpu.js` implementing the same `draw()` interface as `Renderer`,
   selected at startup by `navigator.gpu` + the `?webgpu=1` flag (fallback to WebGL2
   otherwise). No changes to `renderer.js` or the WebGL2-facing core exports.
2. Upload the heightfield **once** as an R16 (or i32 storage) GPU resource.
3. One **compute pass** that generates the **LINE channel only** (skip fills/occluder/
   aircraft in v1 — lines are the visible signature and the dominant cost driver after the
   fill cut). Port `emit_ring`'s math to WGSL: lat/lon → height sample → `sphere_point_scaled`
   → `point_strength` → `in_sight`. Use an atomic append counter to compact survivors into a
   `STORAGE|VERTEX` vert buffer + `STORAGE|INDEX` index buffer (primitive-restart delimited),
   and write `drawIndexedIndirect` args.
4. One **render pass**: `drawIndexedIndirect` of a 1px `line-strip` with a WGSL port of the
   line fragment shader (elevation→brightness). Reuse the existing camera matrix from the core.
5. Keep stars/aircraft either off or as a quick WGSL port — they're trivial and not the point.

**What to measure (same machine *and* the test phone, both paths):**
- **CPU main-thread time/frame** for geometry (the ~24 ms today) → expect near-zero on WebGPU.
- **GPU compute time/frame** (timestamp queries if available) — the new cost; must be small.
- **End-to-end frame time / fps** near surface (the 24 ms regime) and from afar.
- **Visual parity**: side-by-side screenshots, same camera — lines must match the WebGL2 look.
- **Fallback correctness**: confirm WebGL2 path still runs unchanged without the flag, and on
  a non-WebGPU device.

**Go / no-go criteria:**
- **GO** if: near-surface CPU geometry time drops to ≲ a few ms (gen effectively off the
  critical path), end-to-end fps near surface clears 60 (vs ~32 today), lines are visually
  on par, and it runs on the test phone (Chrome Android / iOS 26 Safari). Then plan the full
  port (fills/occluder/stars/aircraft, thick-line option) with WebGL2 retained as fallback.
- **NO-GO / defer** if: compute time + pipeline overhead don't net out faster than the
  cheaper **D1 vertex-pulling-in-WebGL2** alternative, OR the test phone can't run WebGPU
  (then D1 is the better universal win), OR visual parity / index-compaction proves fiddly.
  In that case, implement D1 in the shipping WebGL2 path first and revisit WebGPU later.

**Sequence note:** the perf report recommends **D1 (WebGL2 vertex pulling) before D2 (this
WebGPU spike)** because D1 captures most of the structural benefit inside the path that runs
everywhere. A reasonable compromise: do the D1 measurement first (cheap, universal), then run
this WebGPU spike to see if the compute+indirect ceiling beats it enough to justify the second
path. Both are flagged prototypes; `main` stays flyable on WebGL2 throughout.

---

## Sources
- [web.dev — WebGPU now supported in major browsers](https://web.dev/blog/webgpu-supported-major-browsers)
- [webgpu.com — WebGPU hits critical mass (all major browsers)](https://www.webgpu.com/news/webgpu-hits-critical-mass-all-major-browsers/)
- [VideoCardz — WebGPU supported by all major browsers](https://videocardz.com/newz/webgpu-is-now-supported-by-all-major-browsers)
- [caniuse — WebGPU support table](https://caniuse.com/webgpu)
- [byteiota — WebGPU 2026: 70% browser support](https://byteiota.com/webgpu-2026-70-browser-support-15x-performance-gains/)
- [MDN — WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API)
- [gpuweb wiki — Implementation Status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
- [W3C — WebGPU spec](https://www.w3.org/TR/webgpu/)
- [Chrome for Developers — WebGPU overview](https://developer.chrome.com/docs/web-platform/webgpu/overview)
- [WebGPU Fundamentals — vertex buffers](https://webgpufundamentals.org/webgpu/lessons/webgpu-vertex-buffers.html)
- [Toji.dev — WebGPU indirect draw best practices](https://toji.dev/webgpu-best-practices/indirect-draws.html)
- [teachme.sh — Compute to Render (WebGPU)](https://www.teachme.sh/webgpu/compute-to-render)
- [PlayCanvas — Indirect Drawing](https://developer.playcanvas.com/user-manual/graphics/advanced-rendering/indirect-drawing/)
- [Three.js Roadmap — Galaxy simulation with WebGPU compute](https://threejsroadmap.com/blog/galaxy-simulation-webgpu-compute-shaders)
- [fsjs.dev — WebGPU vs WebGL performance comparison](https://fsjs.dev/webgpu-vs-webgl-performance-comparison/)
- [SitePoint — WebGPU vs WebGL inference benchmarks](https://www.sitepoint.com/webgpu-vs-webgl-inference-benchmarks/)
- [Three.js Roadmap — WebGL vs WebGPU explained](https://threejsroadmap.com/blog/webgl-vs-webgpu-explained)
- [volumeshader.dev — WebGL vs WebGPU 2026](https://www.volumeshader.dev/en/blog/webgl-vs-webgpu)
- [gpuweb #1546 — line-list width support](https://github.com/gpuweb/gpuweb/issues/1546)
- [rreusser/webgpu-instanced-lines](https://github.com/rreusser/webgpu-instanced-lines)
- [m-schuetz/webgpu_wireframe_thicklines](https://github.com/m-schuetz/webgpu_wireframe_thicklines)
- [Unlimited3D — The drama of wide lines in 3D graphics](https://unlimited3d.wordpress.com/2025/10/27/the-drama-of-wide-lines-in-3d-graphics/)
</content>
</invoke>
