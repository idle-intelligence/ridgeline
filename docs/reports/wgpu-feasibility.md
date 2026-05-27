# wgpu (Rust→WASM) as ridgeline's renderer — feasibility vs JS+WebGPU

Research report (informs prototype task #49). Builds on `docs/reports/webgpu-games.md`
(task #8) and `docs/reports/perf-line-3d.md` (task #45).
Date: 2026-05-27.

## TL;DR

- **wgpu is a real, mature option** for putting the renderer inside the Rust core. Latest
  release `wgpu 29.0.3` (2026-05-02). Canvas surface creation, async device init, and the
  compute→render flow all work in wasm today.
- **But the headline "one Rust renderer that auto-falls-back from WebGPU to WebGL2" is NOT
  how wgpu works on the web.** wgpu picks the web backend **at compile time** via the
  `webgl` feature flag — *only one backend per build*. Supporting both means **two separate
  wasm bundles** plus JS that conditionally loads one. So wgpu does *not* give us a free
  dual-backend renderer; it gives us a choice of one backend per binary, with the same
  feature-detect-and-pick-bundle logic we'd write anyway.
- **The WebGL2-via-wgpu fallback also can't run the compute pass** — WebGL2 has no compute,
  so the wgpu WebGL2 build would still need CPU-generated geometry (or a WGSL→GLSL
  vertex-pulling path that wgpu's experimental WebGL2 backend may not cleanly support). The
  GPU-geometry win is WebGPU-only either way — same as the JS approach.
- **Cost is high**: wgpu+naga add multiple MB to the wasm binary; the renderer rewrite is
  big-bang (WGSL pipelines, bind groups, surface/device lifecycle) and would absorb the
  WebGL2 path's responsibilities into Rust.
- **Recommendation: spike path (A) — JS + raw WebGPU parallel renderer behind `?webgpu=1`**,
  exactly as `webgpu-games.md` recommends. It is lower risk, keeps the working WebGL2 path
  in pure JS untouched, requires no wasm-size hit, and tests the *one thing that actually
  matters* (does the compute-geometry win materialize). wgpu (path B) is the more elegant
  long-term home but should only be considered *after* the compute win is proven, and even
  then its compile-time-backend constraint makes it a weaker fit than it first appears.

---

## 1. What wgpu would unify (and what it wouldn't)

The appeal: move the renderer **into** the Rust core so geometry generation, the WGSL
compute pass, and the render pass all live in one language next to `geometry.rs` /
`heightfield.rs` / `physics.rs`. JS shrinks to canvas + RAF loop + input.

**Genuine pros:**
- **One language, shared types.** The sphere math (`sphere_point_scaled`, `point_strength`,
  `in_sight`, `strides_for_distance`) that today lives in `geometry.rs` could be shared with
  the GPU-side dispatch logic directly, no JS re-derivation. The heightfield (the int16 grid
  the core already owns) is uploaded to the GPU from Rust without a WASM→JS bounce.
- **Compute + render co-located** in Rust, so the "core owns the visible-set decision"
  invariant is preserved end-to-end rather than split across the WASM/JS boundary.
- **No zero-copy-view fragility.** The current design exposes `*_ptr`/`*_len` into WASM
  linear memory and reconstructs `Float32Array` views in JS (see `lib.rs` lines 371–393),
  which must be recreated whenever `wasm.memory.buffer` detaches. With wgpu owning the
  buffers, that boundary disappears for the geometry path.

**Cons / what it does NOT unify:**
- **It does not unify the two browser backends.** See §2 — WebGPU vs WebGL2 is a
  compile-time choice in wgpu, so "one renderer, two backends" is a myth for web builds.
- It pulls a large dependency + the whole render lifecycle into the core, which is currently
  a deliberately *thin* WASM module (physics + geometry only; rendering is JS). That thin
  split is a feature: the WebGL2 renderer in `renderer.js` is plain, debuggable JS.
- WGSL shader authoring, bind-group layouts, and surface/device management are now *Rust's*
  problem, compiled to wasm — slower iteration and harder in-browser debugging than editing
  a `.js`/GLSL file and reloading.

---

## 2. wgpu's web backends — the compile-time constraint is the crux

wgpu targets both **WebGPU** (browser's native API) and **WebGL2** (the `gl` backend) from
one Rust codebase — but **only one per compiled binary**, selected at build time:

> "Currently wgpu supports two backends on the web: webgl and webgpu, and only one of them
> can be used in a single build. The choice between WebGL vs. WebGPU is currently decided at
> compile-time, although there are plans to allow picking an adapter at run-time later."
> — [wgpu wiki: Running on the Web](https://github.com/gfx-rs/wgpu/wiki/Running-on-the-Web-with-WebGPU-and-WebGL),
> [discussion #3119](https://github.com/gfx-rs/wgpu/discussions/3119)

To omit WebGL and use WebGPU you drop the `webgl` feature; to support both you must **ship
two wasm bundles and conditionally load one** ([same wiki](https://github.com/gfx-rs/wgpu/wiki/Running-on-the-Web-with-WebGPU-and-WebGL)).
Runtime backend selection is a tracked-but-unscheduled wish, not a current capability
([issue #1617](https://github.com/gfx-rs/wgpu/issues/1617)). This is the single most
important finding: **the "automatic WebGL2 fallback from one Rust renderer" premise does not
hold.** We'd still implement the `navigator.gpu`-detect-and-choose logic in JS — the same
logic the JS approach uses — except now choosing between two *multi-MB wasm downloads*.

**Backend maturity, mid-2026:**
- **WebGPU backend:** Solid. wgpu *is* a reference WebGPU implementation; on wasm with
  `webgl` omitted it forwards to the browser's WebGPU. Browser WebGPU itself shipped
  Chrome 113, Chrome-Android 121, Firefox 141 (Jul 2025), Safari 26 (Jun 2025) — matching
  the coverage `webgpu-games.md` already documented.
- **WebGL2 backend (`gl`):** the wiki itself calls running on the web "work-in-progress" and
  the WebGL2 backend **"experimental and missing many features"**
  ([wiki](https://github.com/gfx-rs/wgpu/wiki/Running-on-the-Web-with-WebGPU-and-WebGL)),
  with intermittent real-world fallback bugs ([issue #6166](https://github.com/gfx-rs/wgpu/issues/6166)).
  Our *current* hand-written `renderer.js` WebGL2 path is more battle-tested for our exact
  use than wgpu's experimental `gl` backend would be.

**Compute is WebGPU-only — so the geometry win is too.** WebGL2 has no compute pipeline; the
wgpu `gl` backend cannot run the WGSL compute pass ([sokol-gfx compute notes](https://floooh.github.io/2025/03/03/sokol-gfx-compute-update.html),
[WebGPU storage-buffers](https://webgpufundamentals.org/webgpu/lessons/webgpu-storage-buffers.html)).
So a wgpu-WebGL2 build would have to **either** keep CPU geometry generation (the ~24 ms
bottleneck we're trying to kill, now inside Rust again) **or** implement the D1
vertex-pulling-from-height-texture approach in the `gl` backend — and WGSL→GLSL through
naga on the experimental backend is exactly where "missing many features" bites. Net: the
fallback story under wgpu is no better than under JS, and the experimental backend makes it
*riskier*. The compute win lands only on the WebGPU path in **both** approaches.

---

## 3. Cost / complexity of the wgpu path

- **Binary size.** wgpu + naga (the shader translator) add **several MB** to the wasm
  binary; naga's WGSL parse/validate functions alone are a large chunk, and a known
  reference point is teams fighting to get under a **10 MB** wasm
  ([discussion #2278](https://github.com/gfx-rs/wgpu/discussions/2278)). wgpu also can't be
  `no_std`. The current core (wasm-bindgen + glam + js-sys, `opt-level="s"`, LTO — see
  `core/Cargo.toml`) is tiny by comparison; this is a large regression for a browser game,
  *doubled* if we ship two bundles. `wasm-pack 0.12 --opt-level=z` and `twiggy` help at the
  margin ([rustwasm code-size book](https://rustwasm.github.io/book/reference/code-size.html))
  but won't erase a multi-MB renderer dependency.
- **Build pipeline.** Still `wasm-pack build --target web`, plus the `webgl`/no-`webgl`
  feature split → **two build invocations / two `pkg/` outputs** if both backends are
  wanted.
- **Surface creation.** No winit needed for a fixed canvas: build a `wgpu::Instance`, take
  the `HtmlCanvasElement` from `web-sys`, and `instance.create_surface(SurfaceTarget::Canvas(canvas))`
  ([SurfaceTarget docs](https://docs.rs/wgpu/latest/wasm32-unknown-unknown/wgpu/enum.SurfaceTarget.html),
  [discussion #2893](https://github.com/gfx-rs/wgpu/discussions/2893)). raw-window-handle is
  avoidable on web. This part is clean.
- **Async device init in wasm.** `request_adapter`/`request_device` are async; on wasm you
  drive them via `wasm_bindgen_futures::spawn_local`, exposing a single async startup fn
  ([wgpu docs](https://docs.rs/wgpu/latest/wgpu/), [techbytes 2026 guide](https://techbytes.app/posts/build-browser-games-wasm-webgpu-rust-2026/)).
  This restructures the core's constructor (today `Engine::new` is synchronous in `lib.rs`)
  into an async bootstrap — a real but bounded change. Watch the documented quirk that
  `spawn_local` can misbehave *after* a `request_device` call
  ([issue #2306](https://github.com/gfx-rs/wgpu/issues/2306)).
- **Debugging.** Shaders + pipeline state now live in Rust→wasm; iteration is recompile-wasm,
  and errors surface as wasm panics / naga validation messages rather than editable JS. Worse
  inner loop than the current JS renderer.
- **Invasiveness.** Very high vs the current thin-WASM/JS-renderer split: the renderer's
  entire responsibility migrates into the core, and the clean `renderer.draw(eng, wasmMemory)`
  seam in `main.js` (line 207) would be replaced by the core owning the canvas and frame.

---

## 4. Migration shape

A wgpu ridgeline is effectively a **big-bang renderer rewrite**, not an incremental edit:
- The core would gain a render module owning the surface, device, queue, pipelines, bind
  groups, and per-frame command encoding; `geometry.rs`'s CPU emit path would be replaced (on
  the WebGPU build) by a WGSL compute pass; `renderer.js` would be retired for that build.
- It is *somewhat* incremental only in that you can keep the existing JS WebGL2 renderer
  running unchanged while building the wgpu WebGPU build alongside (selected by the same
  flag/feature-detect). But within the wgpu build there's no "port one channel at a time and
  keep the rest in JS" — the canvas/device/frame loop is all-or-nothing once the core owns
  the surface.
- **Risk to the working WebGL2 path:** if we let wgpu's experimental `gl` backend *replace*
  `renderer.js`, that's a direct regression risk to the one path that works everywhere. The
  safe stance keeps the JS WebGL2 renderer as the fallback and uses wgpu only for a WebGPU
  build — at which point wgpu is doing *exactly* what raw JS+WebGPU would do, but with a
  multi-MB binary and a Rust shader toolchain. That weakens wgpu's case considerably.

---

## 5. Recommendation for the prototype (task #49)

**Spike path (A): JS + raw WebGPU parallel renderer behind `?webgpu=1`.** Clear GO.

**Reasoning:**
1. **The spike's job is to validate the compute-geometry win, not the language.** That win is
   WebGPU-only in *both* approaches (§2). Path A tests it with the least machinery.
2. **wgpu's core selling point (one renderer, auto WebGL2 fallback) is false on web** —
   it's compile-time, two bundles (§2). So path B's elegance is largely illusory; you still
   write the JS feature-detect, and you still can't compute on WebGL2.
3. **Path A keeps `main` flyable with zero risk.** The proven JS WebGL2 `renderer.js` stays
   byte-for-byte untouched; the WebGPU renderer is a sibling selected by `navigator.gpu` +
   `?webgpu=1`, behind the existing `renderer.draw(eng, wasmMemory)` seam (`main.js:207`).
   No wasm-size hit, no async-constructor surgery in the core, fast JS iteration on WGSL.
4. **Path B is a multi-MB, big-bang, harder-to-debug rewrite** (§3–4) whose only real wins
   (shared sphere math, no zero-copy-view dance) are nice-to-haves, not the perf goal.

**Smallest valuable spike (mirrors `webgpu-games.md` §5):**
- Add `web/renderer-webgpu.js` implementing the same `draw()` interface as `Renderer`,
  selected at startup by `navigator.gpu` + `?webgpu=1` (else WebGL2). No edits to
  `renderer.js` or the WebGL2-facing core exports.
- Upload the heightfield **once** as an R16 / i32 storage GPU resource (core already owns the
  int16 grid; expose its bytes).
- **One compute pass** generating the **LINE channel only** — port `emit_ring`'s math to WGSL
  (lat/lon → height sample → `sphere_point_scaled` → `point_strength` → `in_sight`), compact
  survivors into `STORAGE|VERTEX` + `STORAGE|INDEX` (primitive-restart delimited) via an
  atomic counter, write `drawIndexedIndirect` args.
- **One render pass:** `drawIndexedIndirect` of a 1px `line-strip`, WGSL port of the
  elevation→brightness line fragment shader; reuse the core's existing camera matrix.
- Fills/occluder/stars/aircraft off or trivially ported — not the point.

**Go / no-go criteria:**
- **GO** if near-surface CPU geometry time drops to ≲ a few ms (gen off the critical path),
  near-surface fps clears 60 (vs ~32 today), lines match the WebGL2 look, and it runs on the
  test phone (Chrome-Android / iOS 26 Safari). Then plan the full WebGPU port (other channels,
  optional thick lines), **WebGL2 JS path retained as the universal fallback.**
- **NO-GO / defer** if compute + pipeline overhead don't net out faster than the cheaper
  **D1 vertex-pulling-in-WebGL2** alternative, or the test phone can't run WebGPU, or
  index-compaction/visual-parity proves fiddly — then do D1 in the shipping WebGL2 JS path
  first and revisit.

**When would wgpu (path B) ever win?** Only if, *after* path A proves the compute win, we
decide we want the whole renderer in Rust for maintainability and are willing to (a) eat the
multi-MB binary, (b) ship a WebGPU-only wgpu build with the **JS** WebGL2 renderer as
fallback (not wgpu's experimental `gl` backend), and (c) accept the slower shader iteration.
That's a deliberate, post-prototype architecture decision — not the right shape for spike #49.

**`main` stays flyable throughout** — the prototype is additive and flag-gated; the working
WebGL2 renderer is never replaced until a WebGPU path is proven on desktop *and* the test phone.

---

## Sources
- [wgpu wiki — Running on the Web with WebGPU and WebGL](https://github.com/gfx-rs/wgpu/wiki/Running-on-the-Web-with-WebGPU-and-WebGL)
- [gfx-rs/wgpu repo](https://github.com/gfx-rs/wgpu)
- [wgpu 29.0.3 — docs.rs (latest, 2026-05-02)](https://docs.rs/crate/wgpu/latest)
- [wgpu API docs](https://docs.rs/wgpu/latest/wgpu/)
- [wgpu discussion #3119 — webgpu adapter not found when `webgl` enabled (compile-time backend)](https://github.com/gfx-rs/wgpu/discussions/3119)
- [wgpu issue #1617 — WebGL2 backend (runtime selection tracking)](https://github.com/gfx-rs/wgpu/issues/1617)
- [wgpu issue #6166 — webgl fallback fails in some browsers](https://github.com/gfx-rs/wgpu/issues/6166)
- [iced discourse — compiling wgpu without the webgl flag for wasm](https://discourse.iced.rs/t/allowing-users-to-compile-wgpu-without-the-webgl-flag-in-wasm-builds/59)
- [wgpu discussion #2278 — 10MB wasm file size (naga contribution)](https://github.com/gfx-rs/wgpu/discussions/2278)
- [Rust and WebAssembly — Shrinking .wasm Size](https://rustwasm.github.io/book/reference/code-size.html)
- [wgpu SurfaceTarget docs (Canvas surface on wasm)](https://docs.rs/wgpu/latest/wasm32-unknown-unknown/wgpu/enum.SurfaceTarget.html)
- [wgpu discussion #2893 — init wgpu with HTMLCanvas](https://github.com/gfx-rs/wgpu/discussions/2893)
- [wgpu issue #2306 — spawn_local after request_device on wasm32](https://github.com/gfx-rs/wgpu/issues/2306)
- [techbytes — Build Browser Games with WASM, WebGPU, and Rust (2026)](https://techbytes.app/posts/build-browser-games-wasm-webgpu-rust-2026/)
- [sokol-gfx compute shader update (no compute on WebGL2)](https://floooh.github.io/2025/03/03/sokol-gfx-compute-update.html)
- [WebGPU Fundamentals — Storage Buffers](https://webgpufundamentals.org/webgpu/lessons/webgpu-storage-buffers.html)
- [Learn Wgpu — The Surface](https://sotrh.github.io/learn-wgpu/beginner/tutorial2-surface/)
</content>
</invoke>
