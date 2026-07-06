// WebGPU renderer for ridgeline — DEFAULT renderer when WebGPU is available (main.js selects
// it automatically; WebGL2 `Renderer` is the fallback). Same interface as the WebGL2 renderer:
// `resize(w,h)`, `uploadAircraft(json, scale)`, `draw(eng, wasmMemory)`.
//
// THE WIN: the CPU per-frame geometry generation (`generate_into`, 70–200 ms in the traces,
// 83–98% of the frame, unbounded at low altitude) is REPLACED by a WGSL compute pass. main.js
// drives the engine with `step_physics_only(dt)` (physics + camera only, microseconds) when this
// renderer is active, so the CPU `step` cost collapses and detail is rich at all altitudes.
//
// ARCHITECTURE (compute → indirect draw):
//   0. Heightfield uploaded ONCE as a RAW int16 storage buffer (`heightfield_i16_ptr/_len`,
//      ~151 MB for 12288×6144 vs ~302 MB f32 — under maxStorageBufferBindingSize with the limit
//      bumped at device request). WGSL unpacks the i16 from i32 words and multiplies by
//      `vert_scale()` to get world units, matching `Heightfield::sample`.
//   1. Per frame JS computes the cheap RING SCHEDULE (O(rows), microseconds — ports geometry.rs's
//      outer loop incl. lod_boost + sub-ring factor).
//   2. A compute pass ports `emit_ring` (LINE channel) AND `emit_fill_strip` (near-regime FILL
//      channel) to WGSL: one invocation per descriptor sweeps its visible longitude window, ports
//      the sphere/cull math exactly, atomic-compacts surviving verts + restart-delimited indices,
//      and writes drawIndexedIndirect args.
//   3. Render passes: starfield (fullscreen, ported from WebGL2), gated dark occluder DOME +
//      compute-generated per-ring FILL strips (depth), then the bright LINE strips with the WebGL2
//      elevation→brightness + strength shading, then the aircraft wireframe (model_matrix). All
//      channels match the WebGL2 renderer.

import { PALETTE } from './renderer.js';
import { WORLD_RADIUS } from './constants.js';

const R_WORLD = WORLD_RADIUS;
const VERT_EXAGGERATION = 8.0;

// LOD/cull constants — MUST match core/src/geometry.rs.
const HORIZON_MARGIN = 0.04;
const FADE_BAND = 0.12;
const SIGHT_HALF_ANGLE = 1.483;
const OCCLUDER_FOV_GATE = 0.55; // dome gate (disc regime) — matches geometry.rs
const OCCLUDER_R = R_WORLD * 0.985; // dome radius — matches geometry.rs
const FILL_COARSEN = 3;          // per-ring fill coarsen vs lines — matches geometry.rs
const FILL_R_INSET = 0.999;      // fill pushed inward — matches geometry.rs

function stridesForDistance(d) {
  if (d < 1200.0) return [2, 4];   // near→horizon: uniform "second level", no visible bands
  if (d < 2500.0) return [4, 8];   // low orbit
  if (d < 4500.0) return [8, 16];  // mid orbit
  if (d < 7500.0) return [16, 24]; // high orbit
  return [16, 16];                  // deep space
}
function subringFactorForDistance(d) {
  if (d < 600.0) return 2;
  return 1;
}
function lodBoostForAltitude(alt) {
  return alt < 12000.0 ? 1 : 2;
}
// Uniform stride for explore mode — one stride for all rings, chosen by altitude alone.
// Bypasses distance-based LOD to eliminate visible density bands when viewing large areas.
function exploreStridesForAlt(alt) {
  if (alt < 100)   return [1, 2];
  if (alt < 300)   return [2, 4];
  if (alt < 700)   return [3, 6];
  if (alt < 1500)  return [4, 8];
  if (alt < 3000)  return [6, 12];
  if (alt < 6000)  return [8, 16];
  if (alt < 10000) return [12, 24];
  return [16, 16];
}

// Max GPU buffers. Each ring RESERVES an upper-bound (col_budget) vertex/index block up front
// (so concurrent rings never interleave their strips), which over-reserves vs the verts actually
// emitted — at low altitude (stride 1, many near rings) the reserved high-water mark runs ~3× the
// real emitted count, so these are sized well above the ~600k actual-vert budget to never drop a
// ring. ~24 MB pos + ~24 MB idx — negligible against the 151 MB heightfield.
const MAX_VERTS = 2_000_000;
const MAX_INDICES = 4_500_000;
// Fill budget sized for explore-mode dense fills (fc=1): at low altitude the finest
// stride × the widest visible band roughly doubles fill verts vs flight; undersizing
// drops strips → holes you see the starfield through. Generous headroom (~36/52 MB).
const MAX_FILL_VERTS = 3_000_000;
const MAX_FILL_INDICES = 6_500_000;
const MAX_RINGS = 24_000;   // line sub-ring descriptors per frame
const MAX_FILL_ROWS = 8_000; // fill strip descriptors per frame

const RESTART = 0xffffffff;

// ── WGSL: compute pass (ports emit_ring [LINE] + emit_fill_strip [FILL]) ──────
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
  elev_max    : f32,        // world-unit max elevation (for elev_norm)
  ring_count  : u32,
  fill_count  : u32,
  vert_scale  : f32,        // world units per meter (int16 -> wu)
  lon_pad     : f32,        // degrees of longitude-window padding beyond the geometric horizon
};

// LINE ring descriptor: fractional data-row r0+frac, latitude, column stride.
struct Ring { r0 : u32, frac : f32, lat : f32, stride : u32 };
// FILL strip descriptor: two bracketing RAW data rows (a, b) + the column stride.
struct FillRow { ra : u32, rb : u32, lat_a : f32, lat_b : f32, stride : u32, _pad0 : u32, _pad1 : u32, _pad2 : u32 };

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> heightfield : array<i32>; // packed i16 pairs
@group(0) @binding(2) var<storage, read> rings : array<Ring>;
@group(0) @binding(3) var<storage, read_write> out_pos : array<f32>;   // line x,y,z
@group(0) @binding(4) var<storage, read_write> out_attr : array<f32>;  // line strength,elev
@group(0) @binding(5) var<storage, read_write> out_idx : array<u32>;   // line indices
@group(0) @binding(6) var<storage, read_write> counters : array<atomic<u32>>; // [0]=lvert [1]=lidx [2]=fvert [3]=fidx
@group(0) @binding(7) var<storage, read_write> indirect : array<u32>;  // 2 indexed-indirect args (line, fill)
@group(0) @binding(8) var<storage, read> fills : array<FillRow>;
@group(0) @binding(9) var<storage, read_write> fout_pos : array<f32>;  // fill x,y,z
@group(0) @binding(10) var<storage, read_write> fout_idx : array<u32>; // fill indices (tri-strip, restart)

const PI : f32 = 3.14159265359;
fn deg2rad(d: f32) -> f32 { return d * (PI / 180.0); }

// Unpack the int16 elevation at grid index i from the i32-packed buffer, -> world units.
fn sample_idx(i: u32) -> f32 {
  let word = heightfield[i >> 1u];
  var h : i32;
  if ((i & 1u) == 0u) {
    h = (word << 16) >> 16;   // low i16 (sign-extended)
  } else {
    h = word >> 16;           // high i16 (arithmetic shift keeps sign)
  }
  return f32(h) * cam.vert_scale;
}

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
  let a = sample_idx(r0 * cam.width + c);
  if (frac <= 0.0 || r0 + 1u >= cam.height) { return a; }
  let b = sample_idx((r0 + 1u) * cam.width + c);
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

// One invocation per LINE ring. Ports emit_ring run-splitting exactly.
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
  let window_half = vh + cam.lon_pad;
  // From far away (whole hemisphere visible) emit FULL rings — the longitude window's
  // edge would otherwise clip terrain along a camera-following meridian. Cheap here: the
  // stride is coarse at altitude.
  let full = (window_half >= 180.0) || (lon_span < 360.0 - 1e-3) || (cam.horizon_dot < 0.45);
  let cam_lon = atan2(-cam.cam_pos.z, cam.cam_pos.x) * (180.0 / PI);

  // Always sweep a window CENTERED on the sub-camera column and wrap with modulo, so the
  // visible arc never straddles the ±180° data seam (which would split the strip into two
  // fragmented runs — the deep-space "meridian" artifact). full just widens the window
  // to the whole ring.
  let stepi : i32 = i32(stride);
  let to_col_center = ((cam_lon - cam.lon_min) / lon_span) * f32(cam.width - 1u);
  let c_center = i32(round(to_col_center));
  var half_cols : i32;
  if (full) {
    half_cols = i32(cam.width / 2u) + stepi;
  } else {
    half_cols = i32(ceil((window_half / lon_span) * f32(cam.width - 1u)));
    if (half_cols < 1) { half_cols = 1; }
  }
  let raw_lo = c_center - half_cols;
  var c0 = (raw_lo / stepi) * stepi;
  if (raw_lo < 0 && (raw_lo % stepi) != 0) { c0 = c0 - stepi; }
  let c1 = c_center + half_cols;

  let col_budget : u32 = u32((c1 - c0) / stepi) + 2u;
  let idx_budget : u32 = col_budget * 2u + 1u;
  let vbase = atomicAdd(&counters[0], col_budget);
  let ibase = atomicAdd(&counters[1], idx_budget);
  if (vbase + col_budget > ${MAX_VERTS}u || ibase + idx_budget > ${MAX_INDICES}u) { return; }

  var vcur : u32 = vbase;
  var icur : u32 = ibase;
  var prev_vis : bool = false;
  out_idx[icur] = ${RESTART}u; icur = icur + 1u;

  var k : i32 = c0;
  loop {
    if (k > c1) { break; }
    var m = k % i32(cam.width);
    if (m < 0) { m = m + i32(cam.width); }
    let c : u32 = u32(m);

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
      if (!prev_vis) { out_idx[icur] = ${RESTART}u; icur = icur + 1u; }
      out_idx[icur] = vcur; icur = icur + 1u;
      vcur = vcur + 1u;
      prev_vis = true;
    } else {
      prev_vis = false;
    }
    k = k + stepi;
  }

  loop {
    if (icur >= ibase + idx_budget) { break; }
    out_idx[icur] = ${RESTART}u; icur = icur + 1u;
  }
}

// One invocation per FILL strip (between two raw data rows). Ports emit_fill_strip:
// a TRIANGLE_STRIP alternating lat_a/lat_b vertices along longitude, run-split at the limb,
// pushed inward by FILL_R_INSET. Dark depth occluder for the near/mid regime (elev=0 implicitly).
@compute @workgroup_size(64)
fn fillmain(@builtin(global_invocation_id) gid : vec3<u32>) {
  let fi = gid.x;
  if (fi >= cam.fill_count) { return; }
  let fr = fills[fi];
  let last_col = cam.width - 1u;
  let stride = fr.stride;
  let stepi : i32 = i32(stride);

  let ha = visible_lon_half_deg(fr.lat_a);
  let hb = visible_lon_half_deg(fr.lat_b);
  if (ha < 0.0 && hb < 0.0) { return; }
  var vh = ha;
  if (hb > vh) { vh = hb; }

  let lon_span = cam.lon_max - cam.lon_min;
  let window_half = vh + cam.lon_pad;
  // From far away (whole hemisphere visible) emit FULL rings — the longitude window's
  // edge would otherwise clip terrain along a camera-following meridian. Cheap here: the
  // stride is coarse at altitude.
  let full = (window_half >= 180.0) || (lon_span < 360.0 - 1e-3) || (cam.horizon_dot < 0.45);
  let cam_lon = atan2(-cam.cam_pos.z, cam.cam_pos.x) * (180.0 / PI);

  // Centered + wrapped window (see emit_ring): never split the arc at the ±180° seam.
  let to_col_center = ((cam_lon - cam.lon_min) / lon_span) * f32(cam.width - 1u);
  let c_center = i32(round(to_col_center));
  var half_cols : i32;
  if (full) {
    half_cols = i32(cam.width / 2u) + stepi;
  } else {
    half_cols = i32(ceil((window_half / lon_span) * f32(cam.width - 1u)));
    if (half_cols < 1) { half_cols = 1; }
  }
  let raw_lo = c_center - half_cols;
  var c0 = (raw_lo / stepi) * stepi;
  if (raw_lo < 0 && (raw_lo % stepi) != 0) { c0 = c0 - stepi; }
  let c1 = c_center + half_cols;

  // Each visited column emits 2 verts (a,b) + up to 2 indices, plus restarts.
  let col_budget : u32 = u32((c1 - c0) / stepi) + 2u;
  let vert_budget : u32 = col_budget * 2u;
  let idx_budget : u32 = col_budget * 2u + 2u;

  let vbase = atomicAdd(&counters[2], vert_budget);
  let ibase = atomicAdd(&counters[3], idx_budget);
  if (vbase + vert_budget > ${MAX_FILL_VERTS}u || ibase + idx_budget > ${MAX_FILL_INDICES}u) { return; }

  var vcur : u32 = vbase;
  var icur : u32 = ibase;
  var prev_vis : bool = false;
  fout_idx[icur] = ${RESTART}u; icur = icur + 1u;

  var k : i32 = c0;
  loop {
    if (k > c1) { break; }
    var m = k % i32(cam.width);
    if (m < 0) { m = m + i32(cam.width); }
    let c : u32 = u32(m);

    let lon = col_lon(c);
    let ha_wu = sample_row_frac(fr.ra, 0.0, c);
    let hb_wu = sample_row_frac(fr.rb, 0.0, c);
    let pa = sphere_point_scaled(fr.lat_a, lon, ha_wu) * ${FILL_R_INSET};
    let pb = sphere_point_scaled(fr.lat_b, lon, hb_wu) * ${FILL_R_INSET};
    let sa = point_strength(pa);
    let sb = point_strength(pb);
    let vis = (sa > 0.0 && in_sight(pa)) || (sb > 0.0 && in_sight(pb));

    if (vis && vcur + 2u <= vbase + vert_budget) {
      fout_pos[vcur * 3u + 0u] = pa.x;
      fout_pos[vcur * 3u + 1u] = pa.y;
      fout_pos[vcur * 3u + 2u] = pa.z;
      fout_pos[(vcur + 1u) * 3u + 0u] = pb.x;
      fout_pos[(vcur + 1u) * 3u + 1u] = pb.y;
      fout_pos[(vcur + 1u) * 3u + 2u] = pb.z;
      if (!prev_vis) { fout_idx[icur] = ${RESTART}u; icur = icur + 1u; }
      fout_idx[icur] = vcur; icur = icur + 1u;
      fout_idx[icur] = vcur + 1u; icur = icur + 1u;
      vcur = vcur + 2u;
      prev_vis = true;
    } else {
      prev_vis = false;
    }

    k = k + stepi;
  }

  loop {
    if (icur >= ibase + idx_budget) { break; }
    fout_idx[icur] = ${RESTART}u; icur = icur + 1u;
  }
}

// Finalize: write the two drawIndexedIndirect arg blocks from the index counters.
@compute @workgroup_size(1)
fn finalize() {
  let lidx = min(atomicLoad(&counters[1]), ${MAX_INDICES}u);
  indirect[0] = lidx; indirect[1] = 1u; indirect[2] = 0u; indirect[3] = 0u; indirect[4] = 0u;
  let fidx = min(atomicLoad(&counters[3]), ${MAX_FILL_INDICES}u);
  indirect[5] = fidx; indirect[6] = 1u; indirect[7] = 0u; indirect[8] = 0u; indirect[9] = 0u;
}
`;

// ── WGSL: LINE render (ports LINE_FRAG_SRC exactly) ──────────────────────────
const RENDER_WGSL = /* wgsl */`
struct VP { mvp : mat4x4<f32>, line_color : vec4<f32>, flags : vec4<f32> };
@group(0) @binding(0) var<uniform> u : VP;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) strength : f32, @location(1) elev : f32 };
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
  // flags.x = ocean shading (1 = Earth: dim low elevations as ocean; 0 = airless body: all land).
  let isLand = max(step(0.0008, ev), 1.0 - u.flags.x);
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

// ── WGSL: FILL render (flat dark depth occluder, elev=0 → FILL_FRAG_SRC at elev 0) ──
const FILL_WGSL = /* wgsl */`
struct U { mvp : mat4x4<f32>, color : vec4<f32> };
@group(0) @binding(0) var<uniform> u : U;
@vertex
fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.mvp * vec4<f32>(p, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> {
  // Matches FILL_FRAG_SRC at v_elev=0, v_strength=1: bright=1.0, warmR=0 → base fill color, opaque.
  return vec4<f32>(u.color.rgb, 1.0);
}
`;

// ── WGSL: dark occluder DOME (gated to the disc regime, matches geometry.rs) ──
const OCCLUDER_WGSL = /* wgsl */`
struct U { mvp : mat4x4<f32>, color : vec4<f32> };
@group(0) @binding(0) var<uniform> u : U;
@vertex
fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.mvp * vec4<f32>(p, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> { return vec4<f32>(u.color.rgb, 1.0); }
`;

// ── WGSL: starfield (ports STAR_VERT_SRC / STAR_FRAG_SRC) ────────────────────
const STAR_WGSL = /* wgsl */`
struct U { invVP : mat4x4<f32> };
@group(0) @binding(0) var<uniform> u : U;
struct VSOut { @builtin(position) pos : vec4<f32>, @location(0) ndc : vec2<f32> };
@vertex
fn vs(@builtin(vertex_index) vid : u32) -> VSOut {
  var o : VSOut;
  let x = select(-1.0, 3.0, vid == 2u);
  let y = select(-1.0, 3.0, vid == 1u);
  o.pos = vec4<f32>(x, y, 1.0, 1.0); // far plane (depth 1.0)
  o.ndc = vec2<f32>(x, y);
  return o;
}
fn hash13(p0: vec3<f32>) -> f32 {
  var p = fract(p0 * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
@fragment
fn fs(i: VSOut) -> @location(0) vec4<f32> {
  let nearH = u.invVP * vec4<f32>(i.ndc, -1.0, 1.0);
  let farH  = u.invVP * vec4<f32>(i.ndc,  1.0, 1.0);
  let dir = normalize(farH.xyz / farH.w - nearH.xyz / nearH.w);
  let CELLS = 220.0;
  let cell = floor(dir * CELLS);
  let h = hash13(cell);
  let star = step(0.982, h);
  let hb = hash13(cell + 7.0);
  let sub = vec3<f32>(hash13(cell + 1.0), hash13(cell + 2.0), hash13(cell + 3.0)) - 0.5;
  let starDir = normalize((cell + 0.5 + sub) / CELLS);
  let d = distance(dir, starDir) * CELLS;
  let point = smoothstep(0.6, 0.0, d);
  let bright = (0.30 + 0.55 * hb) * point * star;
  let tint = hash13(cell + 5.0);
  let col = mix(vec3<f32>(0.78, 0.82, 0.90), vec3<f32>(0.92, 0.90, 0.84), tint) * bright;
  return vec4<f32>(col, 1.0);
}
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

// Invert a column-major 4x4 (for the starfield world-ray reconstruction). Returns Float32Array(16) or null.
function mat4Invert(m) {
  const inv = new Float32Array(16);
  const a00=m[0],a01=m[1],a02=m[2],a03=m[3], a10=m[4],a11=m[5],a12=m[6],a13=m[7];
  const a20=m[8],a21=m[9],a22=m[10],a23=m[11], a30=m[12],a31=m[13],a32=m[14],a33=m[15];
  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10, b03=a01*a12-a02*a11;
  const b04=a01*a13-a03*a11, b05=a02*a13-a03*a12, b06=a20*a31-a21*a30, b07=a20*a32-a22*a30;
  const b08=a20*a33-a23*a30, b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
  let det = b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
  if (!det) return null;
  det = 1.0 / det;
  inv[0]=(a11*b11-a12*b10+a13*b09)*det; inv[1]=(a02*b10-a01*b11-a03*b09)*det;
  inv[2]=(a31*b05-a32*b04+a33*b03)*det; inv[3]=(a22*b04-a21*b05-a23*b03)*det;
  inv[4]=(a12*b08-a10*b11-a13*b07)*det; inv[5]=(a00*b11-a02*b08+a03*b07)*det;
  inv[6]=(a32*b02-a30*b05-a33*b01)*det; inv[7]=(a20*b05-a22*b02+a23*b01)*det;
  inv[8]=(a10*b10-a11*b08+a13*b06)*det; inv[9]=(a01*b08-a00*b10-a03*b06)*det;
  inv[10]=(a30*b04-a31*b02+a33*b00)*det; inv[11]=(a21*b02-a20*b04-a23*b00)*det;
  inv[12]=(a11*b07-a10*b09-a12*b06)*det; inv[13]=(a00*b09-a01*b07+a02*b06)*det;
  inv[14]=(a31*b01-a30*b03-a32*b00)*det; inv[15]=(a20*b03-a21*b01+a22*b00)*det;
  return inv;
}

// Dark occluder DOME (positions only) at OCCLUDER_R — matches geometry.rs's gated dome.
function buildOccluderSphere(stacks, slices) {
  const r = OCCLUDER_R;
  const verts = [];
  const idx = [];
  for (let i = 0; i <= stacks; i++) {
    const phi = Math.PI * (i / stacks) - Math.PI / 2;
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
  constructor(canvas) {
    if (canvas) this.canvas = canvas;
  }

  // Standalone init for explore mode: no WASM engine. meta = parsed meta.json,
  // hfArrayBuffer = raw ArrayBuffer of the int16 heightfield.bin, wasmMemory ignored.
  async init(meta, hfArrayBuffer, _wasmMemory) {
    if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const hfBytes = meta.width * meta.height * 2;
    const limMaxBinding = adapter.limits.maxStorageBufferBindingSize;
    const limMaxBuffer = adapter.limits.maxBufferSize;
    if (hfBytes > limMaxBinding || hfBytes > limMaxBuffer) {
      throw new Error(`heightfield ${(hfBytes/1e6).toFixed(0)}MB exceeds adapter limits`);
    }
    const limMaxStorage = adapter.limits.maxStorageBuffersPerShaderStage;
    if (limMaxStorage < 10) throw new Error(`maxStorageBuffersPerShaderStage ${limMaxStorage} < 10`);
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: limMaxBinding,
        maxBufferSize: limMaxBuffer,
        maxStorageBuffersPerShaderStage: limMaxStorage,
      },
    });
    this.adapterLimits = { maxStorageBufferBindingSize: limMaxBinding, maxBufferSize: limMaxBuffer };

    // Synthesise an eng-like object from meta + raw buffer so _init can proceed normally.
    const VERT_SCALE = (6000.0 / 6371000.0) * 8.0;
    const fakeEng = {
      heightfield_i16_ptr: () => 0,
      heightfield_i16_len: () => meta.width * meta.height,
      grid_width: () => meta.width,
      grid_height: () => meta.height,
      elev_world_max: () => meta.elev_max * VERT_SCALE,
      vert_scale: () => VERT_SCALE,
    };
    // We need a fake wasmMemory whose .buffer is the hfArrayBuffer but offset-zero.
    // Trick: supply a wrapper — _init does new Uint8Array(wasmMemory.buffer, hfPtr, hfBytes).
    // hfPtr = 0, so this just wraps the raw buffer directly.
    const fakeWasmMemory = { buffer: hfArrayBuffer };
    await this._init(this.canvas, device, fakeEng, fakeWasmMemory);
  }

  static async create(canvas, eng, wasmMemory) {
    if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');

    // The int16 heightfield needs a large storage-buffer binding (~151 MB for 12288×6144).
    // Request the adapter's max where it exceeds the 128 MB default. If the adapter can't
    // bind the whole grid, fail clearly so main.js falls back to WebGL2.
    const hfBytes = eng.heightfield_i16_len() * 2;
    const limMaxBinding = adapter.limits.maxStorageBufferBindingSize;
    const limMaxBuffer = adapter.limits.maxBufferSize;
    if (hfBytes > limMaxBinding || hfBytes > limMaxBuffer) {
      throw new Error(
        `heightfield ${(hfBytes/1e6).toFixed(0)}MB exceeds adapter limits ` +
        `(maxStorageBufferBindingSize ${(limMaxBinding/1e6).toFixed(0)}MB, ` +
        `maxBufferSize ${(limMaxBuffer/1e6).toFixed(0)}MB) — fall back to WebGL2`);
    }
    // The compute pass uses 10 storage buffers in one stage; the default per-stage limit is 8.
    // Request the adapter's max (it must support ≥ 10 for this renderer; else fail → WebGL2).
    const limMaxStorage = adapter.limits.maxStorageBuffersPerShaderStage;
    if (limMaxStorage < 10) {
      throw new Error(`maxStorageBuffersPerShaderStage ${limMaxStorage} < 10 — fall back to WebGL2`);
    }
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: limMaxBinding,
        maxBufferSize: limMaxBuffer,
        maxStorageBuffersPerShaderStage: limMaxStorage,
      },
    });
    const r = new WebGPURenderer();
    r.adapterLimits = { maxStorageBufferBindingSize: limMaxBinding, maxBufferSize: limMaxBuffer };
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

    // Heightfield upload + per-body compute bind group are built below via _makeBody
    // (after the shared output buffers + compute layout exist), so additional bodies
    // (e.g. the Moon in explore mode) can be registered and swapped at runtime.

    // ── GPU geometry buffers (LINE + FILL channels) ──
    this.posBuf = device.createBuffer({ size: MAX_VERTS * 3 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX });
    this.attrBuf = device.createBuffer({ size: MAX_VERTS * 2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX });
    this.idxBuf = device.createBuffer({ size: MAX_INDICES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX });
    this.fillPosBuf = device.createBuffer({ size: MAX_FILL_VERTS * 3 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX });
    this.fillIdxBuf = device.createBuffer({ size: MAX_FILL_INDICES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX });
    this.counterBuf = device.createBuffer({ size: 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.indirectBuf = device.createBuffer({ size: 10 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.ringBuf = device.createBuffer({ size: MAX_RINGS * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.fillRowBuf = device.createBuffer({ size: MAX_FILL_ROWS * 8 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.camBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // ── Compute pipelines (explicit shared layout: all 11 bindings to all 3 entry points) ──
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
        { binding: 8, visibility: GPUShaderStage.COMPUTE, ...st('read-only-storage') },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, ...st('storage') },
        { binding: 10, visibility: GPUShaderStage.COMPUTE, ...st('storage') },
      ],
    });
    const computeLayout = device.createPipelineLayout({ bindGroupLayouts: [computeBGL] });
    this.computePipe = device.createComputePipeline({ layout: computeLayout, compute: { module: computeMod, entryPoint: 'main' } });
    this.fillComputePipe = device.createComputePipeline({ layout: computeLayout, compute: { module: computeMod, entryPoint: 'fillmain' } });
    this.finalizePipe = device.createComputePipeline({ layout: computeLayout, compute: { module: computeMod, entryPoint: 'finalize' } });

    // Build the initial body (heightfield buffer + compute bind group) and make it active.
    this._computeBGL = computeBGL;
    this.activeBody = this._makeBody(eng, wasmMemory);
    this.useBody(this.activeBody);

    // ── LINE render pipeline ──
    const renderMod = device.createShaderModule({ code: RENDER_WGSL });
    this.lineVP = device.createBuffer({ size: 16 * 4 + 4 * 4 + 4 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
    this.lineBind = device.createBindGroup({ layout: this.linePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.lineVP } }] });

    // ── FILL render pipeline (compute-generated terrain-following strips, near regime) ──
    const fillMod = device.createShaderModule({ code: FILL_WGSL });
    this.fillVP = device.createBuffer({ size: 16 * 4 + 4 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.fillPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: fillMod, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module: fillMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-strip', stripIndexFormat: 'uint32', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    this.fillBind = device.createBindGroup({ layout: this.fillPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.fillVP } }] });

    // ── Occluder DOME (gated to the disc regime) ──
    const occMod = device.createShaderModule({ code: OCCLUDER_WGSL });
    const occ = buildOccluderSphere(64, 128);
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

    // ── Starfield (fullscreen, depth-write off) ──
    const starMod = device.createShaderModule({ code: STAR_WGSL });
    this.starU = device.createBuffer({ size: 16 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.starPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: starMod, entryPoint: 'vs' },
      fragment: { module: starMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    });
    this.starBind = device.createBindGroup({ layout: this.starPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.starU } }] });

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
    this._fillRowScratch = new ArrayBuffer(MAX_FILL_ROWS * 32);
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

  // Build the per-frame LINE ring + FILL strip schedules (CHEAP — O(rows), ports geometry.rs's
  // outer loops incl. lod_boost + sub-ring factor + the near-regime fill gate). Returns
  // { ringCount, fillCount, discHalfAngle, emitFills }.
  _buildSchedule(camPos) {
    const camLen = Math.max(Math.hypot(camPos[0], camPos[1], camPos[2]), R_WORLD + 1.0);
    const camLon = Math.atan2(-camPos[2], camPos[0]) * 180 / Math.PI;
    const alt = Math.max(camLen - R_WORLD, 0);
    // In explore mode use a uniform stride for all rings (no distance-based variation, no boost).
    const exploreStrides = this._exploreLodAlt !== null ? exploreStridesForAlt(this._exploreLodAlt) : null;
    const boost = exploreStrides ? 1 : lodBoostForAltitude(alt);
    const subringCap = (exploreStrides || alt >= 1500.0) ? 1 : Infinity;
    const horizonDot = Math.max(-1, Math.min(1, R_WORLD / camLen));
    const discHalfAngle = Math.asin(Math.max(0, Math.min(1, horizonDot)));
    // Explore mode keeps the clean occluder dome down to a closer altitude (higher gate),
    // so coarse mid-distance fill strips — which gap/flicker on the Moon — only appear once
    // the camera is close enough that fills tessellate densely.
    const fillGate = exploreStrides ? 0.80 : OCCLUDER_FOV_GATE;
    const emitFills = discHalfAngle >= fillGate; // near/mid regime — matches geometry.rs
    const H = this.gridH;
    const rowLatFrac = (r0, frac) => {
      const t = (r0 + frac) / (H - 1);
      return this.latMax - t * (this.latMax - this.latMin);
    };
    const nearestOf = (lat) => {
      const phi = lat * Math.PI / 180, lam = camLon * Math.PI / 180;
      const px = R_WORLD * Math.cos(phi) * Math.cos(lam);
      const py = R_WORLD * Math.sin(phi);
      const pz = -R_WORLD * Math.cos(phi) * Math.sin(lam);
      return Math.hypot(px - camPos[0], py - camPos[1], pz - camPos[2]);
    };

    // LINE rings (with sub-ring interpolation).
    const rdv = new DataView(this._ringScratch);
    let n = 0;
    let row = 0;
    while (row < H) {
      const lat = rowLatFrac(row, 0);
      const nearest = nearestOf(lat);
      const [rowStep, colStride] = exploreStrides || stridesForDistance(nearest);
      const rs = rowStep * boost, cs = colStride * boost;
      let factor = exploreStrides ? 1 : subringFactorForDistance(nearest);
      factor = Math.max(1, Math.min(factor, subringCap === Infinity ? factor : Math.max(1, subringCap)));
      const subCount = Math.max(factor, 1);
      for (let sub = 0; sub < subCount; sub++) {
        let fGlobal = row + sub * rs / subCount;
        fGlobal = Math.min(fGlobal, H - 1);
        const r0 = Math.floor(fGlobal);
        const frac = fGlobal - r0;
        const slat = rowLatFrac(r0, frac);
        if (n < MAX_RINGS) {
          const o = n * 16;
          rdv.setUint32(o, r0, true);
          rdv.setFloat32(o + 4, frac, true);
          rdv.setFloat32(o + 8, slat, true);
          rdv.setUint32(o + 12, cs, true);
          n++;
        }
      }
      row += rs;
    }

    // FILL strips between consecutive coarsened raw rows (only in the near/mid regime).
    let fn = 0;
    if (emitFills) {
      const fdv = new DataView(this._fillRowScratch);
      let frow = 0;
      let prev = null; // [row, lat, colStride]
      while (frow < H) {
        const lat = this.latMax - (frow / (H - 1)) * (this.latMax - this.latMin);
        const nearest = nearestOf(lat);
        const [rowStep, colStride] = exploreStrides || stridesForDistance(nearest);
        const fc = exploreStrides ? 1 : FILL_COARSEN; // dense fills seal cleanly (no gaps/flicker)
        const fillRowStep = Math.max(1, rowStep * boost * fc);
        const fillColStride = Math.max(1, colStride * boost * fc);
        if (prev) {
          const stride = Math.max(prev[2], fillColStride);
          if (fn < MAX_FILL_ROWS) {
            const o = fn * 32;
            fdv.setUint32(o, prev[0], true);       // ra
            fdv.setUint32(o + 4, frow, true);      // rb
            fdv.setFloat32(o + 8, prev[1], true);  // lat_a
            fdv.setFloat32(o + 12, lat, true);     // lat_b
            fdv.setUint32(o + 16, stride, true);   // stride
            fn++;
          }
        }
        prev = [frow, lat, fillColStride];
        frow += fillRowStep;
      }
    }

    this._lastRingCount = n;
    this._lastFillCount = fn;
    return { ringCount: n, fillCount: fn, discHalfAngle, emitFills };
  }

  // Build a renderable BODY (planet/moon): upload its int16 heightfield to a GPU storage
  // buffer and create the compute bind group referencing it. Shared output/geometry buffers
  // are reused across bodies; only the heightfield + dims differ. Returns a body handle.
  _makeBody(eng, wasmMemory) {
    const device = this.device;
    const hfPtr = eng.heightfield_i16_ptr();
    const hfLen = eng.heightfield_i16_len();
    const hfBytes = hfLen * 2;
    const wordCount = Math.ceil(hfLen / 2); // round up so an odd hfLen keeps its trailing i16
    const hfBuf = device.createBuffer({ size: wordCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(hfBuf, 0, new Uint8Array(wasmMemory.buffer, hfPtr, hfBytes));
    const computeBind = device.createBindGroup({
      layout: this._computeBGL,
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: { buffer: hfBuf } },
        { binding: 2, resource: { buffer: this.ringBuf } },
        { binding: 3, resource: { buffer: this.posBuf } },
        { binding: 4, resource: { buffer: this.attrBuf } },
        { binding: 5, resource: { buffer: this.idxBuf } },
        { binding: 6, resource: { buffer: this.counterBuf } },
        { binding: 7, resource: { buffer: this.indirectBuf } },
        { binding: 8, resource: { buffer: this.fillRowBuf } },
        { binding: 9, resource: { buffer: this.fillPosBuf } },
        { binding: 10, resource: { buffer: this.fillIdxBuf } },
      ],
    });
    console.log(`[webgpu] body uploaded: ${(hfBytes/1e6).toFixed(0)}MB int16 (${eng.grid_width()}x${eng.grid_height()})`);
    return {
      hfBuf, computeBind,
      gridW: eng.grid_width(), gridH: eng.grid_height(),
      elevMax: eng.elev_world_max(), vertScale: eng.vert_scale(),
      latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
    };
  }

  // Register an additional body (e.g. the Moon) for later swapping. Returns its handle.
  addBody(eng, wasmMemory) { return this._makeBody(eng, wasmMemory); }

  // Destroy a body handle, freeing its GPU heightfield buffer. Do NOT call on the currently
  // active body (switch to another first). Safe to call on any non-active handle.
  destroyBody(b) {
    if (!b) return;
    try { b.hfBuf.destroy(); } catch (_) {}
  }

  // Make a previously-built body handle the active one for subsequent draws.
  useBody(b) {
    this.activeBody = b;
    this.computeBind = b.computeBind;
    this.gridW = b.gridW; this.gridH = b.gridH;
    this.elevMax = b.elevMax; this.vertScale = b.vertScale;
    this.elevMinWu = b.elevMinWu || 0; // ≤ 0; lowers the occluder dome for basin worlds
    this.hasOcean = b.hasOcean !== false; // airless bodies (Moon) render all terrain as land
    this.latMin = b.latMin; this.latMax = b.latMax;
    this.lonMin = b.lonMin; this.lonMax = b.lonMax;
  }

  _writeCamera(camPos, ve, ringCount, fillCount) {
    const camLen = Math.max(Math.hypot(camPos[0], camPos[1], camPos[2]), R_WORLD + 1.0);
    const camDir = [camPos[0] / camLen, camPos[1] / camLen, camPos[2] / camLen];
    const horizonDot = Math.max(-1, Math.min(1, R_WORLD / camLen));
    const cosHalf = Math.cos(SIGHT_HALF_ANGLE);
    const fwd = this._camFwd;
    const dv = new DataView(this._camScratch);
    dv.setFloat32(0, camPos[0], true); dv.setFloat32(4, camPos[1], true); dv.setFloat32(8, camPos[2], true);
    dv.setFloat32(12, horizonDot, true);
    dv.setFloat32(16, camDir[0], true); dv.setFloat32(20, camDir[1], true); dv.setFloat32(24, camDir[2], true);
    dv.setFloat32(28, cosHalf, true);
    dv.setFloat32(32, fwd[0], true); dv.setFloat32(36, fwd[1], true); dv.setFloat32(40, fwd[2], true);
    dv.setFloat32(44, ve / VERT_EXAGGERATION, true);
    dv.setFloat32(48, this.latMin, true); dv.setFloat32(52, this.latMax, true);
    dv.setFloat32(56, this.lonMin, true); dv.setFloat32(60, this.lonMax, true);
    dv.setUint32(64, this.gridW, true); dv.setUint32(68, this.gridH, true);
    dv.setFloat32(72, this.elevMax, true); dv.setUint32(76, ringCount, true);
    dv.setUint32(80, fillCount, true); dv.setFloat32(84, this.vertScale, true);
    dv.setFloat32(88, this._lonPad ?? 70.0, true);
  }

  draw(eng, wasmMemory) {
    const device = this.device;
    // Explore mode: uniform LOD override — bypass distance-based stride tables.
    this._exploreLodAlt = eng.explore_alt ? eng.explore_alt() : null;
    // Explore uses a tight longitude pad (camera doesn't move fast, so the geometric
    // window is accurate); flight keeps the wide pad for high-speed camera lag.
    this._lonPad = this._exploreLodAlt !== null ? 14.0 : 70.0;
    const mvp = eng.view_proj();
    const camPosArr = eng.camera_position();
    const camPos = [camPosArr[0], camPosArr[1], camPosArr[2]];
    const fwdArr = eng.cam_forward();
    this._camFwd = [fwdArr[0], fwdArr[1], fwdArr[2]];
    const ve = eng.current_ve();

    // CPU work = the cheap ring + fill schedules ONLY (heavy vertex gen is on the GPU).
    const t0 = performance.now();
    const { ringCount, fillCount, emitFills } = this._buildSchedule(camPos);
    this._lastCpuGenMs = performance.now() - t0;

    this._writeCamera(camPos, ve, ringCount, fillCount);
    device.queue.writeBuffer(this.camBuf, 0, this._camScratch);
    device.queue.writeBuffer(this.ringBuf, 0, this._ringScratch, 0, ringCount * 16);
    if (fillCount > 0) device.queue.writeBuffer(this.fillRowBuf, 0, this._fillRowScratch, 0, fillCount * 32);
    device.queue.writeBuffer(this.counterBuf, 0, new Uint32Array([0, 0, 0, 0]));

    // ── Compute: LINE + FILL geometry + indices ──
    {
      const cenc = device.createCommandEncoder();
      const cp = cenc.beginComputePass();
      cp.setPipeline(this.computePipe);
      cp.setBindGroup(0, this.computeBind);
      cp.dispatchWorkgroups(Math.max(1, Math.ceil(ringCount / 64)));
      if (fillCount > 0) {
        cp.setPipeline(this.fillComputePipe);
        cp.setBindGroup(0, this.computeBind);
        cp.dispatchWorkgroups(Math.ceil(fillCount / 64));
      }
      cp.setPipeline(this.finalizePipe);
      cp.setBindGroup(0, this.computeBind);
      cp.dispatchWorkgroups(1);
      cp.end();
      device.queue.submit([cenc.finish()]);
    }

    const enc = device.createCommandEncoder();
    // _offscreenView lets a headless test render into an owned texture (the canvas swapchain
    // texture is unreliable under headless WebGPU). Production uses the canvas current texture.
    const view = this._offscreenView || this.ctx.getCurrentTexture().createView();
    const dview = this.depthTex.createView();
    const [sr, sg, sb] = PALETTE.sky;
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: sr, g: sg, b: sb, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: dview, depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });

    // starfield (drawn first, depth-write OFF; globe draws over it)
    // Use star_view_proj if provided (explore mode: inertially-fixed MVP so stars don't rotate
    // with the planet); otherwise fall back to the main MVP.
    const starMvp = eng.star_view_proj ? eng.star_view_proj() : mvp;
    const invVP = mat4Invert(starMvp);
    if (invVP) {
      device.queue.writeBuffer(this.starU, 0, invVP);
      rp.setPipeline(this.starPipe);
      rp.setBindGroup(0, this.starBind);
      rp.draw(3);
    }

    // occluder DOME — only in the disc/from-afar regime; at low altitude the dome's near
    // surface becomes visible from outside and creates a dark band across the terrain.
    if (!emitFills) {
      const occU = new Float32Array(20);
      occU.set(mvp, 0); occU.set(PALETTE.fill, 16);
      device.queue.writeBuffer(this.occVP, 0, occU);
      rp.setPipeline(this.occPipe);
      rp.setBindGroup(0, this.occBind);
      rp.setVertexBuffer(0, this.occVBO);
      rp.setIndexBuffer(this.occIBO, 'uint32');
      rp.drawIndexed(this.occCount);
    }

    // per-ring FILL strips (near/mid regime) — terrain-following dark depth occluder
    if (emitFills && fillCount > 0) {
      const fillU = new Float32Array(20);
      fillU.set(mvp, 0); fillU.set(PALETTE.fill, 16);
      device.queue.writeBuffer(this.fillVP, 0, fillU);
      rp.setPipeline(this.fillPipe);
      rp.setBindGroup(0, this.fillBind);
      rp.setVertexBuffer(0, this.fillPosBuf);
      rp.setIndexBuffer(this.fillIdxBuf, 'uint32');
      rp.drawIndexedIndirect(this.indirectBuf, 5 * 4); // fill args block
    }

    // lines (drawIndexedIndirect from compute output)
    const lineU = new Float32Array(24);
    lineU.set(mvp, 0); lineU.set(PALETTE.line, 16);
    lineU[20] = this.hasOcean === false ? 0 : 1; // ocean shading on unless the body opts out
    device.queue.writeBuffer(this.lineVP, 0, lineU);
    rp.setPipeline(this.linePipe);
    rp.setBindGroup(0, this.lineBind);
    rp.setVertexBuffer(0, this.posBuf);
    rp.setVertexBuffer(1, this.attrBuf);
    rp.setIndexBuffer(this.idxBuf, 'uint32');
    rp.drawIndexedIndirect(this.indirectBuf, 0); // line args block

    // aircraft
    const _acModel = eng.model_matrix ? eng.model_matrix() : null;
    if (this.acCount > 0 && _acModel) {
      const model = _acModel;
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

  cpuGenMs() { return this._lastCpuGenMs; }

  // Render the current frame into an OWNED RGBA texture and read it back (for headless tests,
  // where the canvas swapchain texture is not reliably readable). Returns
  // { width, height, pixels: Uint8Array(RGBA) }. Pixels are row-major top-to-bottom (Y down).
  async readbackPixels(eng, wasmMemory) {
    const device = this.device;
    const w = this.canvas.width, h = this.canvas.height;
    const tex = device.createTexture({
      size: [w, h], format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this._offscreenView = tex.createView();
    this.draw(eng, wasmMemory);
    this._offscreenView = null;

    const bytesPerRow = Math.ceil((w * 4) / 256) * 256; // 256-byte row alignment
    const rb = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: rb, bytesPerRow }, [w, h, 1]);
    device.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(rb.getMappedRange());
    const pixels = new Uint8Array(w * h * 4);
    const bgra = this.format.startsWith('bgra');
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = y * bytesPerRow + x * 4;
        const d = (y * w + x) * 4;
        if (bgra) { pixels[d] = src[s + 2]; pixels[d + 1] = src[s + 1]; pixels[d + 2] = src[s]; pixels[d + 3] = src[s + 3]; }
        else { pixels[d] = src[s]; pixels[d + 1] = src[s + 1]; pixels[d + 2] = src[s + 2]; pixels[d + 3] = src[s + 3]; }
      }
    }
    rb.unmap();
    return { width: w, height: h, pixels };
  }

  async debugReadback() {
    const dev = this.device;
    const rb = dev.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.counterBuf, 0, rb, 0, 16);
    enc.copyBufferToBuffer(this.indirectBuf, 0, rb, 16, 40);
    dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    return {
      lineVerts: u[0], lineIdx: u[1], fillVerts: u[2], fillIdx: u[3],
      lineIndirect: [u[4], u[5], u[6], u[7], u[8]],
      fillIndirect: [u[9], u[10], u[11], u[12], u[13]],
    };
  }
}
