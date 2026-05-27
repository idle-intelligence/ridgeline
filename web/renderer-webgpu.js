// WebGPU renderer for ridgeline (PROTOTYPE, flag-gated behind ?webgpu=1).
//
// Same interface as the WebGL2 `Renderer`: `resize(w,h)`, `uploadAircraft(json, scale)`,
// `draw(eng, wasmMemory)`. Selected by main.js ONLY when ?webgpu=1 AND a WebGPU adapter is
// available; on ANY init/runtime failure main.js falls back to the WebGL2 Renderer.
//
// ARCHITECTURE (compute → indirect draw), LINE channel only:
//   1. Heightfield (f32 world-unit elevations, row-major) uploaded ONCE as a storage buffer
//      (read from WASM linear memory via Engine.heightfield_ptr/_len).
//   2. Per frame, JS computes the cheap RING SCHEDULE (which sub-rings to render + per-ring
//      column stride) — an O(rows) loop, microseconds, NOT the bottleneck. The bottleneck
//      (per-vertex sphere mapping + horizon/sight cull over thousands of columns per ring)
//      moves to a WGSL COMPUTE shader: one invocation per ring sweeps its visible longitude
//      window, ports emit_ring's math exactly, and atomically compacts surviving vertices +
//      restart-delimited line-strip indices into STORAGE|VERTEX / STORAGE|INDEX buffers, and
//      writes drawIndexedIndirect args. The CPU generates NO line vertices.
//   3. Render pass: drawIndexedIndirect of a 1px line-strip, WGSL port of the WebGL2
//      elevation→brightness + strength-alpha line shading so it visually matches.
//
// FILL/occluder channel is DEFERRED (prototype = LINE only, per the spike scope). To still
// hide the far hemisphere we draw a single dark solid sphere mesh (uniform-tessellated) into
// the depth buffer before the lines — an approximation of the WebGL2 dark occluder. This is
// noted as an approximation; it is geometry-cheap and only writes depth + the dark fill color.
//
// Stars/aircraft: aircraft is ported (simple wireframe); stars are approximated by the clear
// color (deferred — not the point of the spike).

import { PALETTE } from './renderer.js';

const R_WORLD = 6000.0;
const VERT_EXAGGERATION = 8.0;

// LOD schedule constants — MUST match core/src/geometry.rs.
const HORIZON_MARGIN = 0.04;
const FADE_BAND = 0.12;
const SIGHT_HALF_ANGLE = 1.483;
const OCCLUDER_FOV_GATE = 0.55;

function stridesForDistance(d) {
  if (d < 150.0) return [1, 2];
  if (d < 400.0) return [2, 4];
  if (d < 900.0) return [4, 8];
  if (d < 1800.0) return [8, 16];
  if (d < 4000.0) return [16, 32];
  return [16, 16];
}
function subringFactorForDistance(d) {
  if (d < 150.0) return 4;
  if (d < 400.0) return 3;
  if (d < 900.0) return 2;
  return 1;
}

// Max GPU buffers. Sized generously for the worst case the budget test tolerates (~600k verts).
const MAX_VERTS = 700_000;
const MAX_INDICES = 1_600_000; // verts + restart delimiters (worst-case ~2× verts)
const MAX_RINGS = 20_000;    // sub-ring descriptors per frame

const RESTART = 0xffffffff;

// ── WGSL: compute pass (ports emit_ring) ─────────────────────────────────────
const COMPUTE_WGSL = /* wgsl */`
struct Camera {
  cam_pos     : vec3<f32>,
  horizon_dot : f32,
  cam_dir     : vec3<f32>,
  cos_half    : f32,
  cam_fwd     : vec3<f32>,
  ve_ratio    : f32,        // ve / VERT_EXAGGERATION
  lat_min     : f32,
  lat_max     : f32,
  lon_min     : f32,
  lon_max     : f32,
  width       : u32,
  height      : u32,
  elev_max    : f32,
  ring_count  : u32,
};

// One ring descriptor: fractional data-row r0+frac, its latitude, and the column stride.
struct Ring {
  r0     : u32,
  frac   : f32,
  lat    : f32,
  stride : u32,
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> heightfield : array<f32>;
@group(0) @binding(2) var<storage, read> rings : array<Ring>;
@group(0) @binding(3) var<storage, read_write> out_pos : array<f32>;       // x,y,z per vert
@group(0) @binding(4) var<storage, read_write> out_attr : array<f32>;      // strength,elev per vert
@group(0) @binding(5) var<storage, read_write> out_idx : array<u32>;
@group(0) @binding(6) var<storage, read_write> counters : array<atomic<u32>>; // [0]=vert, [1]=idx
@group(0) @binding(7) var<storage, read_write> indirect : array<u32>;      // drawIndexedIndirect args

const PI : f32 = 3.14159265359;

fn deg2rad(d: f32) -> f32 { return d * (PI / 180.0); }

fn sphere_point_scaled(lat_deg: f32, lon_deg: f32, h_wu: f32) -> vec3<f32> {
  let phi = deg2rad(lat_deg);
  let lam = deg2rad(lon_deg);
  let r = ${R_WORLD} + h_wu * cam.ve_ratio;
  let sp = sin(phi); let cp = cos(phi);
  let sl = sin(lam); let cl = cos(lam);
  return vec3<f32>(r * cp * cl, r * sp, -r * cp * sl);
}

fn col_lon(c: u32) -> f32 {
  let t = f32(c) / f32(cam.width - 1u);
  return cam.lon_min + t * (cam.lon_max - cam.lon_min);
}

fn sample_row_frac(r0: u32, frac: f32, c: u32) -> f32 {
  let a = heightfield[r0 * cam.width + c];
  if (frac <= 0.0 || r0 + 1u >= cam.height) { return a; }
  let b = heightfield[(r0 + 1u) * cam.width + c];
  return a + (b - a) * frac;
}

fn elev_norm(r0: u32, frac: f32, c: u32) -> f32 {
  if (cam.elev_max <= 0.0) { return 0.0; }
  return clamp(sample_row_frac(r0, frac, c) / cam.elev_max, 0.0, 1.0);
}

fn point_strength(p: vec3<f32>) -> f32 {
  let n = normalize(p);
  let d = dot(n, cam.cam_dir);
  let cut = cam.horizon_dot - ${HORIZON_MARGIN};
  if (d <= cut) { return 0.0; }
  return clamp((d - cut) / ${FADE_BAND}, 0.0, 1.0);
}

fn in_sight(p: vec3<f32>) -> bool {
  let v = p - cam.cam_pos;
  let len = length(v);
  if (len < 1e-3) { return true; }
  return dot(v / len, cam.cam_fwd) >= cam.cos_half;
}

// visible_lon_half_deg port: half-width (deg) of the visible longitude arc, or -1 if none.
fn visible_lon_half_deg(lat_deg: f32) -> f32 {
  let cut = cam.horizon_dot - ${HORIZON_MARGIN};
  let phi = deg2rad(lat_deg);
  let sp = sin(phi); let cp = cos(phi);
  let amp = cp * sqrt(cam.cam_dir.x * cam.cam_dir.x + cam.cam_dir.z * cam.cam_dir.z);
  let base = sp * cam.cam_dir.y;
  if (amp < 1e-6) {
    if (base > cut) { return 180.0; }
    return -1.0;
  }
  let rhs = (cut - base) / amp;
  if (rhs >= 1.0) { return -1.0; }
  if (rhs <= -1.0) { return 180.0; }
  return acos(rhs) * (180.0 / PI);
}

// One invocation per ring. Sweeps its visible longitude window in order, compacting
// surviving vertices into a contiguous range and emitting line-strip indices (restart-
// delimited at run breaks). Matches emit_ring run-splitting exactly.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let ri = gid.x;
  if (ri >= cam.ring_count) { return; }
  let ring = rings[ri];
  let lat = ring.lat;
  let stride = ring.stride;
  let last_col = cam.width - 1u;

  let vh = visible_lon_half_deg(lat);
  if (vh < 0.0) { return; }

  let lon_span = cam.lon_max - cam.lon_min;
  let window_half = vh + 40.0;
  // full-sweep when the whole ring is visible OR the grid is not a full 360° wrap.
  let full = (window_half >= 180.0) || (lon_span < 360.0 - 1e-3);

  let cam_lon = atan2(-cam.cam_pos.z, cam.cam_pos.x) * (180.0 / PI);

  // Column iteration parameters (ports emit_ring's windowed/full sweep).
  var c0 : i32;
  var c1 : i32;
  let stepi : i32 = i32(stride);
  if (full) {
    c0 = 0;
    c1 = i32(last_col);
  } else {
    let to_col_center = ((cam_lon - cam.lon_min) / lon_span) * f32(cam.width - 1u);
    let c_center = i32(round(to_col_center));
    var half_cols = i32(ceil((window_half / lon_span) * f32(cam.width - 1u)));
    if (half_cols < 1) { half_cols = 1; }
    let raw_lo = c_center - half_cols;
    c0 = (raw_lo / stepi) * stepi; // snap down (emulate div_euclid for negatives)
    if (raw_lo < 0 && (raw_lo % stepi) != 0) { c0 = c0 - stepi; }
    c1 = c_center + half_cols;
  }

  // Upper bound on this ring's visited columns (cheap integer math). One vertex + one index
  // slot per visited column, plus a leading restart.
  var col_budget : u32;
  if (full) {
    col_budget = (last_col / stride) + 2u;
  } else {
    col_budget = u32((c1 - c0) / stepi) + 2u;
  }

  // Reserve CONTIGUOUS per-ring vertex + index blocks so concurrent rings never interleave
  // their line-strip indices (which would connect vertices across rings). Each ring writes
  // sequentially into its own range; culled columns and trailing slack are RESTART, which
  // line-strip topology skips. One shared indexed indirect draw renders all rings.
  // Indices: worst case is one restart per visited column (alternating vis/cull) plus the
  // leading restart → reserve 2*col_budget + 1.
  let idx_budget : u32 = col_budget * 2u + 1u;
  let vbase = atomicAdd(&counters[0], col_budget);
  let ibase = atomicAdd(&counters[1], idx_budget);
  if (vbase + col_budget > ${MAX_VERTS}u || ibase + idx_budget > ${MAX_INDICES}u) { return; }

  var vcur : u32 = vbase;
  var icur : u32 = ibase;
  var prev_vis : bool = false;
  // Lead with a RESTART so this ring's strip is disjoint from the previous ring's block.
  out_idx[icur] = ${RESTART}u; icur = icur + 1u;

  var k : i32 = c0;
  loop {
    if (full) {
      if (k > i32(last_col)) { break; }
    } else {
      if (k > c1) { break; }
    }
    var c : u32;
    if (full) {
      c = u32(min(k, i32(last_col)));
    } else {
      var m = k % i32(cam.width); // wrap longitude (rem_euclid)
      if (m < 0) { m = m + i32(cam.width); }
      c = u32(m);
    }

    let lon = col_lon(c);
    let h = sample_row_frac(ring.r0, ring.frac, c);
    let p = sphere_point_scaled(lat, lon, h);
    let s = point_strength(p);
    let vis = (s > 0.0) && in_sight(p);

    if (vis && vcur < vbase + col_budget) {
      out_pos[vcur * 3u + 0u] = p.x;
      out_pos[vcur * 3u + 1u] = p.y;
      out_pos[vcur * 3u + 2u] = p.z;
      out_attr[vcur * 2u + 0u] = s;
      out_attr[vcur * 2u + 1u] = elev_norm(ring.r0, ring.frac, c);
      // Break the strip at a cull gap by inserting a RESTART before resuming.
      if (!prev_vis) { out_idx[icur] = ${RESTART}u; icur = icur + 1u; }
      out_idx[icur] = vcur; icur = icur + 1u;
      vcur = vcur + 1u;
      prev_vis = true;
    } else {
      prev_vis = false;
    }

    if (full && c == last_col) { break; }
    k = k + stepi;
  }

  // Pad the rest of this ring's reserved index block with RESTART so the global buffer is
  // dense up to the finalize high-water mark (these are empty no-op segments for line-strip).
  loop {
    if (icur >= ibase + idx_budget) { break; }
    out_idx[icur] = ${RESTART}u; icur = icur + 1u;
  }
}

// Finalize: write drawIndexedIndirect args from the index counter. Run as a 1-thread dispatch.
@compute @workgroup_size(1)
fn finalize() {
  let idx_count = min(atomicLoad(&counters[1]), ${MAX_INDICES}u);
  indirect[0] = idx_count; // indexCount
  indirect[1] = 1u;        // instanceCount
  indirect[2] = 0u;        // firstIndex
  indirect[3] = 0u;        // baseVertex
  indirect[4] = 0u;        // firstInstance
}
`;

// ── WGSL: render pass (line-strip, ports LINE_FRAG_SRC) ──────────────────────
const RENDER_WGSL = /* wgsl */`
struct VP { mvp : mat4x4<f32>, line_color : vec4<f32> };
@group(0) @binding(0) var<uniform> u : VP;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) strength : f32,
  @location(1) elev : f32,
};

@vertex
fn vs(@location(0) a_pos: vec3<f32>, @location(1) a_attr: vec2<f32>) -> VSOut {
  var o : VSOut;
  o.pos = u.mvp * vec4<f32>(a_pos, 1.0);
  o.strength = a_attr.x;
  o.elev = a_attr.y;
  return o;
}

@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let ev = clamp(i.elev, 0.0, 1.0);
  let isLand = step(0.0008, ev);
  let e = pow(ev, 0.35);
  let landBright = mix(0.85, 1.45, e);
  let oceanBright = 0.12;
  let bright = mix(oceanBright, landBright, isLand);
  let alphaMul = mix(0.45, 1.0, isLand);
  let warmR = mix(0.0, 0.07, e) * isLand;
  let warmG = mix(0.0, 0.025, e) * isLand;
  let col = clamp(u.line_color.rgb * bright + vec3<f32>(warmR, warmG, 0.0), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(col, u.line_color.a * i.strength * alphaMul);
}
`;

// ── WGSL: dark occluder sphere (approximation of the WebGL2 fill) ────────────
const OCCLUDER_WGSL = /* wgsl */`
struct U { mvp : mat4x4<f32>, color : vec4<f32> };
@group(0) @binding(0) var<uniform> u : U;
@vertex
fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.mvp * vec4<f32>(p, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> { return u.color; }
`;

// ── WGSL: aircraft wireframe ─────────────────────────────────────────────────
const AIRCRAFT_WGSL = /* wgsl */`
struct U { mvp : mat4x4<f32>, color : vec4<f32> };
@group(0) @binding(0) var<uniform> u : U;
@vertex
fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.mvp * vec4<f32>(p, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> { return u.color; }
`;

function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = v;
    }
  return out;
}

// Build a unit-ish UV sphere (positions only) at radius R*0.999 for the dark occluder.
function buildOccluderSphere(stacks, slices) {
  const r = R_WORLD * 0.999;
  const verts = [];
  const idx = [];
  for (let i = 0; i <= stacks; i++) {
    const phi = Math.PI * (i / stacks) - Math.PI / 2; // -90..90
    for (let j = 0; j <= slices; j++) {
      const lam = 2 * Math.PI * (j / slices) - Math.PI;
      const cp = Math.cos(phi), sp = Math.sin(phi);
      verts.push(r * cp * Math.cos(lam), r * sp, -r * cp * Math.sin(lam));
    }
  }
  const rowLen = slices + 1;
  for (let i = 0; i < stacks; i++) {
    for (let j = 0; j < slices; j++) {
      const a = i * rowLen + j, b = a + rowLen;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { verts: new Float32Array(verts), idx: new Uint32Array(idx) };
}

export class WebGPURenderer {
  // Async factory — main.js: `const r = await WebGPURenderer.create(canvas, eng, wasmMemory)`.
  static async create(canvas, eng, wasmMemory) {
    if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const device = await adapter.requestDevice();
    const r = new WebGPURenderer();
    await r._init(canvas, device, eng, wasmMemory);
    return r;
  }

  async _init(canvas, device, eng, wasmMemory) {
    this.canvas = canvas;
    this.device = device;
    device.addEventListener('uncapturederror', (e) => console.error('[webgpu] uncaptured:', e.error.message));
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx = canvas.getContext('webgpu');
    this.ctx.configure({
      device, format: this.format, alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    // ── Heightfield storage buffer (uploaded ONCE) ──
    const hfPtr = eng.heightfield_ptr();
    const hfLen = eng.heightfield_len();
    const hfView = new Float32Array(wasmMemory.buffer, hfPtr, hfLen);
    this.hfBuf = device.createBuffer({
      size: hfLen * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.hfBuf, 0, hfView);
    this.gridW = eng.grid_width();
    this.gridH = eng.grid_height();
    this.latMin = -90; this.latMax = 90; this.lonMin = -180; this.lonMax = 180; // from meta bbox
    this.elevMax = eng.elev_world_max();

    // ── GPU geometry buffers ──
    this.posBuf = device.createBuffer({
      size: MAX_VERTS * 3 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });
    this.attrBuf = device.createBuffer({
      size: MAX_VERTS * 2 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });
    this.idxBuf = device.createBuffer({
      size: MAX_INDICES * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX,
    });
    this.counterBuf = device.createBuffer({
      size: 2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.indirectBuf = device.createBuffer({
      size: 5 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.ringBuf = device.createBuffer({
      size: MAX_RINGS * 4 * 4, // r0(u32),frac(f32),lat(f32),stride(u32)
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.camBuf = device.createBuffer({
      size: 96, // Camera struct, std140-ish padded (see _writeCamera)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // ── Compute pipelines (explicit shared layout so both entry points see all 8 bindings) ──
    const computeMod = device.createShaderModule({ code: COMPUTE_WGSL });
    const st = (t) => ({ buffer: { type: t } });
    const computeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, ...st('uniform') },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, ...st('read-only-storage') },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, ...st('read-only-storage') },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, ...st('storage') },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, ...st('storage') },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, ...st('storage') },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, ...st('storage') },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, ...st('storage') },
      ],
    });
    const computeLayout = device.createPipelineLayout({ bindGroupLayouts: [computeBGL] });
    this.computePipe = device.createComputePipeline({
      layout: computeLayout, compute: { module: computeMod, entryPoint: 'main' },
    });
    this.finalizePipe = device.createComputePipeline({
      layout: computeLayout, compute: { module: computeMod, entryPoint: 'finalize' },
    });
    const computeEntries = [
      { binding: 0, resource: { buffer: this.camBuf } },
      { binding: 1, resource: { buffer: this.hfBuf } },
      { binding: 2, resource: { buffer: this.ringBuf } },
      { binding: 3, resource: { buffer: this.posBuf } },
      { binding: 4, resource: { buffer: this.attrBuf } },
      { binding: 5, resource: { buffer: this.idxBuf } },
      { binding: 6, resource: { buffer: this.counterBuf } },
      { binding: 7, resource: { buffer: this.indirectBuf } },
    ];
    this.computeBind = device.createBindGroup({ layout: computeBGL, entries: computeEntries });
    this.finalizeBind = this.computeBind;

    // ── Render pipeline (lines) ──
    const renderMod = device.createShaderModule({ code: RENDER_WGSL });
    this.lineVP = device.createBuffer({
      size: 16 * 4 + 4 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.linePipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: renderMod, entryPoint: 'vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: {
        module: renderMod, entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'line-strip', stripIndexFormat: 'uint32' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    });
    this.lineBind = device.createBindGroup({
      layout: this.linePipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.lineVP } }],
    });

    // ── Occluder sphere (dark, depth-only-ish, approximates the WebGL2 fill) ──
    const occMod = device.createShaderModule({ code: OCCLUDER_WGSL });
    const occ = buildOccluderSphere(48, 96);
    this.occCount = occ.idx.length;
    this.occVBO = device.createBuffer({ size: occ.verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.occVBO, 0, occ.verts);
    this.occIBO = device.createBuffer({ size: occ.idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.occIBO, 0, occ.idx);
    this.occVP = device.createBuffer({ size: 16 * 4 + 4 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.occPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: occMod, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module: occMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    this.occBind = device.createBindGroup({ layout: this.occPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.occVP } }] });

    // ── Aircraft (wireframe) ──
    const acMod = device.createShaderModule({ code: AIRCRAFT_WGSL });
    this.acVP = device.createBuffer({ size: 16 * 4 + 4 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.acPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: acMod, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module: acMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'line-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    this.acBind = device.createBindGroup({ layout: this.acPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.acVP } }] });
    this.acCount = 0;

    this._camScratch = new ArrayBuffer(96);
    this._ringScratch = new ArrayBuffer(MAX_RINGS * 16);
    this._lastCpuGenMs = 0;
    this.resize(canvas.width, canvas.height);
  }

  resize(w, h) {
    if (w === 0 || h === 0) return;
    this.depthTex = this.device.createTexture({
      size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  uploadAircraft(aircraftJson, scale) {
    const pos = aircraftJson.positions, segs = aircraftJson.lines;
    const verts = new Float32Array(pos.length * 3);
    for (let i = 0; i < pos.length; i++) {
      verts[i * 3] = pos[i][0] * scale; verts[i * 3 + 1] = pos[i][1] * scale; verts[i * 3 + 2] = pos[i][2] * scale;
    }
    const indices = new Uint32Array(segs.length * 2);
    for (let i = 0; i < segs.length; i++) { indices[i * 2] = segs[i][0]; indices[i * 2 + 1] = segs[i][1]; }
    this.acCount = indices.length;
    this.acVBO = this.device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.acVBO, 0, verts);
    this.acIBO = this.device.createBuffer({ size: indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.acIBO, 0, indices);
  }

  // Build the per-frame ring schedule (CHEAP — O(rows), ports geometry.rs's outer loop).
  // Returns the ring count. Fills this._ringScratch.
  _buildRingSchedule(camPos) {
    const camLen = Math.max(Math.hypot(camPos[0], camPos[1], camPos[2]), R_WORLD + 1.0);
    const camLon = Math.atan2(-camPos[2], camPos[0]) * 180 / Math.PI;
    const dv = new DataView(this._ringScratch);
    let n = 0;
    const H = this.gridH;
    const rowLatFrac = (r0, frac) => {
      const t = (r0 + frac) / (H - 1);
      return this.latMax - t * (this.latMax - this.latMin);
    };
    let row = 0;
    while (row < H) {
      // nearest point of this ring to the camera (at the camera's own longitude).
      const lat = rowLatFrac(row, 0);
      const phi = lat * Math.PI / 180, lam = camLon * Math.PI / 180;
      const px = R_WORLD * Math.cos(phi) * Math.cos(lam);
      const py = R_WORLD * Math.sin(phi);
      const pz = -R_WORLD * Math.cos(phi) * Math.sin(lam);
      const nearest = Math.hypot(px - camPos[0], py - camPos[1], pz - camPos[2]);
      const [rowStep, colStride] = stridesForDistance(nearest);
      const factor = subringFactorForDistance(nearest);
      const subCount = Math.max(factor, 1);
      for (let sub = 0; sub < subCount; sub++) {
        let fGlobal = row + sub * rowStep / subCount;
        fGlobal = Math.min(fGlobal, H - 1);
        const r0 = Math.floor(fGlobal);
        const frac = fGlobal - r0;
        const slat = rowLatFrac(r0, frac);
        if (n < MAX_RINGS) {
          const o = n * 16;
          dv.setUint32(o, r0, true);
          dv.setFloat32(o + 4, frac, true);
          dv.setFloat32(o + 8, slat, true);
          dv.setUint32(o + 12, colStride, true);
          n++;
        }
      }
      row += rowStep;
    }
    return n;
  }

  _writeCamera(camPos, ve, ringCount) {
    const camLen = Math.max(Math.hypot(camPos[0], camPos[1], camPos[2]), R_WORLD + 1.0);
    const camDir = [camPos[0] / camLen, camPos[1] / camLen, camPos[2] / camLen];
    const horizonDot = Math.max(-1, Math.min(1, R_WORLD / camLen));
    const cosHalf = Math.cos(SIGHT_HALF_ANGLE);
    const fwd = this._camFwd;
    const dv = new DataView(this._camScratch);
    // vec3 cam_pos + f32 horizon_dot
    dv.setFloat32(0, camPos[0], true); dv.setFloat32(4, camPos[1], true); dv.setFloat32(8, camPos[2], true);
    dv.setFloat32(12, horizonDot, true);
    // vec3 cam_dir + f32 cos_half
    dv.setFloat32(16, camDir[0], true); dv.setFloat32(20, camDir[1], true); dv.setFloat32(24, camDir[2], true);
    dv.setFloat32(28, cosHalf, true);
    // vec3 cam_fwd + f32 ve_ratio
    dv.setFloat32(32, fwd[0], true); dv.setFloat32(36, fwd[1], true); dv.setFloat32(40, fwd[2], true);
    dv.setFloat32(44, ve / VERT_EXAGGERATION, true);
    // lat_min,lat_max,lon_min,lon_max
    dv.setFloat32(48, this.latMin, true); dv.setFloat32(52, this.latMax, true);
    dv.setFloat32(56, this.lonMin, true); dv.setFloat32(60, this.lonMax, true);
    // width,height (u32), elev_max (f32), ring_count (u32)
    dv.setUint32(64, this.gridW, true); dv.setUint32(68, this.gridH, true);
    dv.setFloat32(72, this.elevMax, true); dv.setUint32(76, ringCount, true);
  }

  draw(eng, wasmMemory) {
    const device = this.device;
    const mvp = eng.view_proj();
    const camPosArr = eng.camera_position();
    const camPos = [camPosArr[0], camPosArr[1], camPosArr[2]];
    const fwdArr = eng.cam_forward();
    this._camFwd = [fwdArr[0], fwdArr[1], fwdArr[2]];
    const ve = eng.current_ve();

    // CPU work = the cheap ring schedule ONLY (the heavy vertex gen is on the GPU).
    const t0 = performance.now();
    const ringCount = this._buildRingSchedule(camPos);
    this._lastCpuGenMs = performance.now() - t0;
    this._lastRingCount = ringCount;

    this._writeCamera(camPos, ve, ringCount);
    device.queue.writeBuffer(this.camBuf, 0, this._camScratch);
    device.queue.writeBuffer(this.ringBuf, 0, this._ringScratch, 0, ringCount * 16);
    device.queue.writeBuffer(this.counterBuf, 0, new Uint32Array([0, 0]));

    // ── Compute: generate line geometry + indices (own submit so it always runs) ──
    {
      const cenc = device.createCommandEncoder();
      const cp = cenc.beginComputePass();
      cp.setPipeline(this.computePipe);
      cp.setBindGroup(0, this.computeBind);
      cp.dispatchWorkgroups(Math.ceil(ringCount / 64));
      cp.setPipeline(this.finalizePipe);
      cp.setBindGroup(0, this.finalizeBind);
      cp.dispatchWorkgroups(1);
      cp.end();
      device.queue.submit([cenc.finish()]);
    }

    const enc = device.createCommandEncoder();
    // ── Render ──
    // _offscreenView lets a headless test render into an owned texture (the canvas swapchain
    // texture is unreliable under headless WebGPU). Production uses the canvas current texture.
    const view = this._offscreenView || this.ctx.getCurrentTexture().createView();
    const dview = this.depthTex.createView();
    const [sr, sg, sb] = PALETTE.sky;
    const rp = enc.beginRenderPass({
      colorAttachments: [{
        view, clearValue: { r: sr, g: sg, b: sb, a: 1 }, loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: dview,
        depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store',
      },
    });

    // occluder sphere (dark, writes depth → hides far hemisphere). Approximation of fill.
    const occU = new Float32Array(20);
    occU.set(mvp, 0); occU.set(PALETTE.fill, 16);
    device.queue.writeBuffer(this.occVP, 0, occU);
    rp.setPipeline(this.occPipe);
    rp.setBindGroup(0, this.occBind);
    rp.setVertexBuffer(0, this.occVBO);
    rp.setIndexBuffer(this.occIBO, 'uint32');
    rp.drawIndexed(this.occCount);

    // lines (drawIndexedIndirect from compute output)
    const lineU = new Float32Array(20);
    lineU.set(mvp, 0); lineU.set(PALETTE.line, 16);
    device.queue.writeBuffer(this.lineVP, 0, lineU);
    rp.setPipeline(this.linePipe);
    rp.setBindGroup(0, this.lineBind);
    rp.setVertexBuffer(0, this.posBuf);
    rp.setVertexBuffer(1, this.attrBuf);
    rp.setIndexBuffer(this.idxBuf, 'uint32');
    rp.drawIndexedIndirect(this.indirectBuf, 0);

    // aircraft
    if (this.acCount > 0) {
      const model = eng.model_matrix();
      const acMvp = mat4Mul(mvp, model);
      const acU = new Float32Array(20);
      acU.set(acMvp, 0); acU.set(PALETTE.aircraft, 16);
      device.queue.writeBuffer(this.acVP, 0, acU);
      rp.setPipeline(this.acPipe);
      rp.setBindGroup(0, this.acBind);
      rp.setVertexBuffer(0, this.acVBO);
      rp.setIndexBuffer(this.acIBO, 'uint32');
      rp.drawIndexed(this.acCount);
    }

    rp.end();
    device.queue.submit([enc.finish()]);
  }

  // Diagnostics for the HUD / measurement.
  cpuGenMs() { return this._lastCpuGenMs; }

  // Debug: read back the compute counters + indirect args (async). For the prototype check.
  async debugReadback() {
    const dev = this.device;
    const rb = dev.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.counterBuf, 0, rb, 0, 8);
    enc.copyBufferToBuffer(this.indirectBuf, 0, rb, 8, 20);
    dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    return { vertCount: u[0], idxCount: u[1], indirect: [u[2], u[3], u[4], u[5], u[6]] };
  }
}
