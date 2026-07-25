// WebGPU renderer for ridgeline — the ONLY renderer. There is no fallback: explore.js hard-errors
// when `navigator.gpu` is undefined. Interface: `resize(w,h)`, `draw(eng, ...)`.
//
// THE WIN: per-frame ridgeline geometry generation used to run on the CPU (70–200 ms in the
// traces, 83–98% of the frame, unbounded at low altitude). It is now a WGSL compute pass, so the
// CPU per-frame cost collapses and detail stays rich at all altitudes.
//
// ARCHITECTURE (compute → indirect draw):
//   0. Heightfield uploaded ONCE as a RAW int16 storage buffer (`heightfield_i16_ptr/_len`,
//      ~151 MB for 12288×6144 vs ~302 MB f32 — under maxStorageBufferBindingSize with the limit
//      bumped at device request). WGSL unpacks the i16 from i32 words and multiplies by
//      `vert_scale()` to get world units.
//   1. Per frame JS computes the cheap RING SCHEDULE (O(rows), microseconds — the LOD
//      outer loop incl. lod_boost + sub-ring factor).
//   2. A compute pass emits both channels: ring LINEs and near-regime FILL strips. One invocation
//      per descriptor sweeps its visible longitude window, does the sphere/cull math,
//      atomic-compacts surviving verts + restart-delimited indices, and writes
//      drawIndexedIndirect args.
//   3. Render passes: starfield (fullscreen), gated dark occluder DOME + compute-generated
//      per-ring FILL strips (depth), then the bright LINE strips with the elevation→brightness
//      + strength shading.

import {
  PALETTE, WORLD_RADIUS, EARTH_RADIUS_M, VERT_EXAGGERATION,
  HORIZON_MARGIN, FADE_BAND, SIGHT_HALF_ANGLE, POLE_GUARD_LAT, OCCLUDER_FOV_GATE,
} from './constants.js';

const R_WORLD = WORLD_RADIUS;
const FILL_COARSEN = 3;          // per-ring fill coarsen vs lines

// ── The FLOOR field ──────────────────────────────────────────────────────────
// ONE smooth surface per body, precomputed on tier load (see computeOccluderField), shared by
// BOTH dark surfaces: the occluder mesh reads it as a per-vertex attribute, the fill strips
// sample it bilinearly in the compute pass. They can no longer disagree, and neither traces
// the waves. Grid = the occluder mesh's own vertex grid.
const OCC_STACKS = 64;
const OCC_SLICES = 128;
const FLOOR_ROWS = OCC_STACKS + 1;
const FLOOR_COLS = OCC_SLICES + 1;
// The field rides a UNIFORM binding, not a storage one: Metal caps a shader stage at 10
// storage buffers and the compute pass already uses all 10. Packed 4 floats per vec4 —
// 2097 vec4s = 33 KB, comfortably inside the 64 KB uniform binding size.
const FLOOR_LEN = FLOOR_ROWS * FLOOR_COLS;
const FLOOR_VEC4S = Math.ceil(FLOOR_LEN / 4);
// Clearance (world units, R_WORLD = 6000) of both dark surfaces below the smoothed ridge-foot
// envelope. THE knob for "how far under the ridges the dark body sits": raise it if the body
// still reaches into the bumps, lower it if the ridge feet float.
const FLOOR_CLEARANCE_WU = 8.0;

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

// The compute stage declares this many storage buffers. WebGPU guarantees only 8 per stage,
// so this is a hard ceiling, not a target — see bindings.test.js.
const COMPUTE_STORAGE_BUFFERS = 8;

// Counters and the two drawIndexedIndirect arg blocks live in ONE storage buffer — WebGPU
// guarantees only 8 storage buffers per shader stage, and the compute pass needs every slot.
// u32 offsets: 0..3 counters, 4..8 line args, 9..13 fill args (byte offsets stay 4-aligned,
// which is all drawIndexedIndirect requires).
const INDIRECT_LINE_U32 = 4;
const INDIRECT_FILL_U32 = 9;
const COUNTER_BUF_U32 = 14;

// Line positions (x,y,z) and attributes (strength,elev) share ONE buffer for the same reason:
// positions from f32 index 0, attributes from ATTR_BASE_F32. Both regions are also bound as
// vertex buffers — setVertexBuffer takes the byte offset.
const ATTR_BASE_F32 = MAX_VERTS * 3;

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
// line verts: x,y,z from 0, then strength,elev from ${ATTR_BASE_F32}u (one buffer, two regions)
@group(0) @binding(3) var<storage, read_write> out_line : array<f32>;
@group(0) @binding(4) var<storage, read_write> out_idx : array<u32>;   // line indices
// counters + indirect share ONE buffer: [0]=lvert [1]=lidx [2]=fvert [3]=fidx, then the two
// indexed-indirect arg blocks at ${INDIRECT_LINE_U32}u (line) and ${INDIRECT_FILL_U32}u (fill).
@group(0) @binding(5) var<storage, read_write> counters : array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> fills : array<FillRow>;
@group(0) @binding(7) var<storage, read_write> fout_pos : array<f32>;  // fill x,y,z
@group(0) @binding(8) var<storage, read_write> fout_idx : array<u32>;  // fill indices (tri-strip, restart)
@group(0) @binding(9) var<uniform> floor_field : array<vec4<f32>, ${FLOOR_VEC4S}>; // FLOOR_ROWS×FLOOR_COLS, raw i16 units

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

// The FLOOR: elevation (world units) of the shared smooth envelope at (lat, lon), bilinear
// over the FLOOR_ROWS×FLOOR_COLS grid, minus the clearance. This is the SAME field the
// occluder mesh displaces by, so the two dark surfaces coincide instead of disagreeing.
//
// It is a pure function of (lat, lon): consecutive fill bands evaluate it identically at
// their shared latitude, so their edges meet exactly — no crack for the sky to show
// through. (The old per-band column minimum gave each band its own edge radius; those
// mismatched edges were the black slits.) 4 loads/vertex, no dependence on band height.
fn floor_at(i: u32) -> f32 { return floor_field[i >> 2u][i & 3u]; }
fn floor_h_wu(lat_deg: f32, lon_deg: f32) -> f32 {
  let fi = clamp((lat_deg + 90.0) / 180.0 * ${FLOOR_ROWS - 1}.0, 0.0, ${FLOOR_ROWS - 1}.0);
  let fj = clamp((lon_deg + 180.0) / 360.0 * ${FLOOR_COLS - 1}.0, 0.0, ${FLOOR_COLS - 1}.0);
  let i0 = min(u32(fi), ${FLOOR_ROWS - 2}u);
  let j0 = min(u32(fj), ${FLOOR_COLS - 2}u);
  let ti = fi - f32(i0);
  let tj = fj - f32(j0);
  let base0 = i0 * ${FLOOR_COLS}u + j0;
  let base1 = base0 + ${FLOOR_COLS}u;
  let top = mix(floor_at(base0), floor_at(base0 + 1u), tj);
  let bot = mix(floor_at(base1), floor_at(base1 + 1u), tj);
  return mix(top, bot, ti) * cam.vert_scale - ${FLOOR_CLEARANCE_WU.toFixed(3)} / cam.ve_ratio;
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

  // Polar-cap guard. Near |lat| = 90 the ring's circumference collapses toward a point, so
  // any longitude variation in the row turns into a radial sawtooth crown instead of a cap
  // (Vesta's unconstrained north-polar DTM rows were the offender). Once the row's radial
  // amplitude reaches the ring's own radius the ring is no longer a ring, so draw it at the
  // row mean and let the cap converge. Bounded scan (≤512 samples), polar rings only.
  var pole_h : f32 = 0.0;
  var pole_flat : bool = false;
  if (abs(lat) >= ${POLE_GUARD_LAT}) {
    var scan = max(cam.width / 512u, stride);
    var sum : f32 = 0.0;
    var hmin : f32 = 1e30;
    var hmax : f32 = -1e30;
    var n : f32 = 0.0;
    var sc : u32 = 0u;
    loop {
      if (sc >= cam.width) { break; }
      let hs = sample_row_frac(ring.r0, ring.frac, sc);
      sum = sum + hs;
      hmin = min(hmin, hs);
      hmax = max(hmax, hs);
      n = n + 1.0;
      sc = sc + scan;
    }
    if (0.5 * (hmax - hmin) * cam.ve_ratio >= ${R_WORLD} * cos(deg2rad(lat))) {
      pole_flat = true;
      pole_h = sum / n;
    }
  }

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
    var h = sample_row_frac(ring.r0, ring.frac, c);
    if (pole_flat) { h = pole_h; }
    let p = sphere_point_scaled(lat, lon, h);
    let s = point_strength(p);
    let vis = (s > 0.0) && in_sight(p);

    if (vis && vcur < vbase + col_budget) {
      out_line[vcur * 3u + 0u] = p.x;
      out_line[vcur * 3u + 1u] = p.y;
      out_line[vcur * 3u + 2u] = p.z;
      out_line[${ATTR_BASE_F32}u + vcur * 2u + 0u] = s;
      out_line[${ATTR_BASE_F32}u + vcur * 2u + 1u] = elev_norm(ring.r0, ring.frac, c);
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
    // Both edges ride the shared floor field, evaluated at their own latitude — provably
    // at or below the terrain minimum (so the strip only seals, never pokes) and identical
    // to the neighbouring band's edge (so the shell is watertight).
    let pa = sphere_point_scaled(fr.lat_a, lon, floor_h_wu(fr.lat_a, lon));
    let pb = sphere_point_scaled(fr.lat_b, lon, floor_h_wu(fr.lat_b, lon));
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
  let l = ${INDIRECT_LINE_U32}u;
  let lidx = min(atomicLoad(&counters[1]), ${MAX_INDICES}u);
  atomicStore(&counters[l], lidx); atomicStore(&counters[l + 1u], 1u);
  atomicStore(&counters[l + 2u], 0u); atomicStore(&counters[l + 3u], 0u); atomicStore(&counters[l + 4u], 0u);
  let f = ${INDIRECT_FILL_U32}u;
  let fidx = min(atomicLoad(&counters[3]), ${MAX_FILL_INDICES}u);
  atomicStore(&counters[f], fidx); atomicStore(&counters[f + 1u], 1u);
  atomicStore(&counters[f + 2u], 0u); atomicStore(&counters[f + 3u], 0u); atomicStore(&counters[f + 4u], 0u);
}
`;

// ── WGSL: LINE render (ports LINE_FRAG_SRC exactly) ──────────────────────────
const RENDER_WGSL = /* wgsl */`
// flags.x = ocean shading (1 = Earth: dim low elevations as ocean; 0 = airless body: all land).
// flags.yzw = per-body tint (vec3, components >1 allowed for emissive boost). Default [1,1,1].
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
  // "Ocean" (faint) = elevation EXACTLY at reference level 0: Earth's bake clamps sea
  // there, and Pluto/Charon park their unimaged fill there. Real terrain BELOW zero
  // (Charon's -14 km basins, Dead Sea) must stay bright — a signed test dithered
  // land/faint across every zero crossing and speckled the disc at distance.
  let isLand = max(step(0.0008, abs(ev)), 1.0 - u.flags.x);
  let e = pow(ev, 0.35);
  let landBright = mix(0.85, 1.45, e);
  let oceanBright = 0.12;
  let bright = mix(oceanBright, landBright, isLand);
  let alphaMul = mix(0.45, 1.0, isLand);
  let warmR = mix(0.0, 0.07, e) * isLand;
  let warmG = mix(0.0, 0.025, e) * isLand;
  let tint = u.flags.yzw; // per-body tint; [1,1,1] = identity
  let col = tint * clamp(u.line_color.rgb * bright + vec3<f32>(warmR, warmG, 0.0), vec3<f32>(0.0), vec3<f32>(1.0));
  return vec4<f32>(col, u.line_color.a * i.strength * alphaMul);
}
`;

// ── WGSL: FILL render (flat dark depth occluder, elev=0 → FILL_FRAG_SRC at elev 0) ──
const FILL_WGSL = /* wgsl */`
// tint = per-body tint vec3 (components >1 allowed). Default [1,1,1] = identity.
struct U { mvp : mat4x4<f32>, color : vec4<f32>, tint : vec4<f32> };
@group(0) @binding(0) var<uniform> u : U;
@vertex
fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.mvp * vec4<f32>(p, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> {
  // Matches FILL_FRAG_SRC at v_elev=0, v_strength=1: bright=1.0, warmR=0 → base fill color, opaque.
  return vec4<f32>(u.tint.rgb * u.color.rgb, 1.0);
}
`;

// ── WGSL: displaced occluder mesh — per-vertex minElevRaw attribute ──────────
// Vertex layout: @location(0) vec2<f32> latLon (degrees), @location(1) f32 minElevRaw (int16 units).
// Uniform: mvp, color, vertScale (wu per int16 unit), ve8 (ve / VERT_EXAGGERATION), margin.
// Radius = R_WORLD + minElevRaw * vertScale * ve8 − margin.
// minElevRaw is the smooth occluder ENVELOPE (see computeOccluderField): a heavily averaged
// surface that is provably at or below the terrain minimum, so the shell can never poke
// through the ridges while still reading as one broad body rather than a trace of the waves.
const OCCLUDER_WGSL = /* wgsl */`
struct U { mvp : mat4x4<f32>, color : vec4<f32>, vertScale : f32, ve8 : f32, margin : f32, _pad : f32, tint : vec4<f32> };
@group(0) @binding(0) var<uniform> u : U;
const PI : f32 = 3.14159265359;
@vertex
fn vs(@location(0) latLon: vec2<f32>, @location(1) minElevRaw: f32) -> @builtin(position) vec4<f32> {
  let phi = latLon.x * (PI / 180.0);
  let lam = latLon.y * (PI / 180.0);
  let r = ${R_WORLD} + minElevRaw * u.vertScale * u.ve8 - u.margin;
  let cp = cos(phi); let sp = sin(phi);
  let p = vec3<f32>(r * cp * cos(lam), r * sp, -r * cp * sin(lam));
  return u.mvp * vec4<f32>(p, 1.0);
}
@fragment
fn fs() -> @location(0) vec4<f32> { return vec4<f32>(u.tint.rgb * u.color.rgb, 1.0); }
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

// Invert a column-major 4x4 (for the starfield world-ray reconstruction). Returns Float32Array(16) or null.
// In-place variant: writes into `out` (Float32Array(16)), returns true on success.
function mat4InvertInto(m, out) {
  const a00=m[0],a01=m[1],a02=m[2],a03=m[3], a10=m[4],a11=m[5],a12=m[6],a13=m[7];
  const a20=m[8],a21=m[9],a22=m[10],a23=m[11], a30=m[12],a31=m[13],a32=m[14],a33=m[15];
  const b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10, b03=a01*a12-a02*a11;
  const b04=a01*a13-a03*a11, b05=a02*a13-a03*a12, b06=a20*a31-a21*a30, b07=a20*a32-a22*a30;
  const b08=a20*a33-a23*a30, b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
  let det = b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
  if (!det) return false;
  det = 1.0 / det;
  out[0]=(a11*b11-a12*b10+a13*b09)*det; out[1]=(a02*b10-a01*b11-a03*b09)*det;
  out[2]=(a31*b05-a32*b04+a33*b03)*det; out[3]=(a22*b04-a21*b05-a23*b03)*det;
  out[4]=(a12*b08-a10*b11-a13*b07)*det; out[5]=(a00*b11-a02*b08+a03*b07)*det;
  out[6]=(a32*b02-a30*b05-a33*b01)*det; out[7]=(a20*b05-a22*b02+a23*b01)*det;
  out[8]=(a10*b10-a11*b08+a13*b06)*det; out[9]=(a01*b08-a00*b10-a03*b06)*det;
  out[10]=(a30*b04-a31*b02+a33*b00)*det; out[11]=(a21*b02-a20*b04-a23*b00)*det;
  out[12]=(a11*b07-a10*b09-a12*b06)*det; out[13]=(a00*b09-a01*b07+a02*b06)*det;
  out[14]=(a31*b01-a30*b03-a32*b00)*det; out[15]=(a20*b03-a21*b01+a22*b00)*det;
  return true;
}

// Displaced occluder mesh base: generates (lat, lon) per vertex and triangle indices.
// Per-vertex minElevRaw is computed in _makeBody from the body's heightfield (CPU, one-off).
// STACKS×SLICES covers the full sphere; rowLen = slices+1, vertCount = (stacks+1)×rowLen.
function buildOccluderMeshBase() {
  const stacks = OCC_STACKS, slices = OCC_SLICES;
  const latLon = []; // vec2<f32> per vertex: [lat_deg, lon_deg]
  const idx = [];
  for (let i = 0; i <= stacks; i++) {
    const lat = -90 + 180 * (i / stacks); // −90 (south pole) → +90 (north)
    for (let j = 0; j <= slices; j++) {
      const lon = -180 + 360 * (j / slices);
      latLon.push(lat, lon);
    }
  }
  const rowLen = slices + 1;
  for (let i = 0; i < stacks; i++) {
    for (let j = 0; j < slices; j++) {
      const a = i * rowLen + j, b = a + rowLen;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { latLon: new Float32Array(latLon), idx: new Uint32Array(idx) };
}

// Compute per-vertex minElevRaw over the Voronoi cell ±half a mesh cell in lat/lon.
// hf is Int16Array (row-major, row 0 = north = +90°), gridW×gridH.
// Each occluder mesh vertex covers lat±halfCellLat × lon±halfCellLon degrees.
// We sample ALL heightfield cells whose centre falls within that region and take the MIN.
// A generous region (err larger) ensures concave corners can never poke above the mesh.
export function computeMinElevPerVertex(hf, gridW, gridH, stacks, slices) {
  const vertCount = (stacks + 1) * (slices + 1);
  const minElev = new Float32Array(vertCount);
  // Cell sizes for the occluder mesh in degrees
  const cellLat = 180 / stacks;   // degrees per mesh row
  const cellLon = 360 / slices;   // degrees per mesh column
  const halfCellLat = cellLat * 0.6; // slightly larger than half — err on safe side
  const halfCellLon = cellLon * 0.6;
  // Precompute row/col → heightfield index mapping
  const latPerRow  = 180 / (gridH - 1); // degrees per data row
  const lonPerCol  = 360 / (gridW - 1); // degrees per data col
  for (let i = 0; i <= stacks; i++) {
    const latCenter = -90 + 180 * (i / stacks);
    const latLo = latCenter - halfCellLat, latHi = latCenter + halfCellLat;
    // heightfield row 0 = +90 (north), row (gridH-1) = -90 (south)
    const rLo = Math.floor((90 - latHi) / latPerRow);
    const rHi  = Math.ceil((90 - latLo) / latPerRow);
    const rMin = Math.max(0, rLo), rMax = Math.min(gridH - 1, rHi);
    for (let j = 0; j < slices; j++) {
      const lonCenter = -180 + 360 * (j / slices);
      const lonLo = lonCenter - halfCellLon, lonHi = lonCenter + halfCellLon;
      // Longitude WRAPS: the ±180° vertices see the columns on both sides of the seam.
      // Clipping there instead would leave the two seam vertices with a half-window
      // (a higher, less safe minimum) while the envelope filter below wraps.
      const cLo = Math.floor((lonLo + 180) / lonPerCol);
      const cHi  = Math.ceil((lonHi + 180) / lonPerCol);
      let mn = 32767;
      const wraps = cLo < 0 || cHi > gridW - 1;
      for (let r = rMin; r <= rMax; r++) {
        const rowBase = r * gridW;
        if (wraps) {
          for (let c = cLo; c <= cHi; c++) {
            const v = hf[rowBase + (((c % gridW) + gridW) % gridW)];
            if (v < mn) mn = v;
          }
        } else {
          for (let c = cLo; c <= cHi; c++) {
            const v = hf[rowBase + c];
            if (v < mn) mn = v;
          }
        }
      }
      minElev[i * (slices + 1) + j] = mn === 32767 ? 0 : mn;
    }
    // Column `slices` (+180°) is the SAME meridian as column 0 (−180°) — give it the
    // identical value rather than a second, differently-rounded window, so the wrapping
    // envelope filter below can never end up above it.
    minElev[i * (slices + 1) + slices] = minElev[i * (slices + 1)];
  }
  return { minElev };
}

// ── Occluder envelope ────────────────────────────────────────────────────────
// The per-cell MIN field above is a safe lower bound, but it traces every ridge: the
// dark shell then reads as a faceted, piecewise copy of the terrain rising into the gaps
// between the bright rings. We want a broad, heavily averaged envelope that is still
// provably below the terrain everywhere.
//
// ERODE (min-filter) by the blur's total reach, THEN blur with that same reach.
// Every value averaged at vertex v is a minimum taken over a window that contains v, so the
// average is ≤ min(v): the no-poke-through guarantee survives the smoothing exactly, with no
// global overshoot correction and no per-wave detail left. Both filters are separable
// rectangles in mesh-index space, which keeps the containment symmetric.
// Reach = RADIUS × PASSES mesh cells = 11.3° at 64 stacks: still ~16× the ring spacing, so the
// shell is broad and waveless, but a third of the drop of the 17° reach it replaces. The reach
// IS the dominant term in how far the dark body sits below the ridge feet — a smooth surface
// under every local minimum in an 11° window is necessarily below the ridge feet by about the
// relief within that window. Widen it for a smoother/lower shell, tighten it for a closer one.
const OCC_BLUR_RADIUS = 1;  // mesh cells per box pass
const OCC_BLUR_PASSES = 4;  // 4 boxes ≈ gaussian

// Separable filter over the occluder grid: rows = stacks+1 (lat, clamped at the poles),
// cols = slices+1 where the last column duplicates the first (lon, wraps with period cols-1).
function occFilter(src, rows, cols, radius, reduce) {
  const P = cols - 1;
  const tmp = new Float32Array(src.length);
  for (let i = 0; i < rows; i++) {
    const base = i * cols;
    for (let j = 0; j < P; j++) {
      let acc = reduce.init;
      for (let k = -radius; k <= radius; k++) acc = reduce.step(acc, src[base + (((j + k) % P) + P) % P]);
      tmp[base + j] = reduce.done(acc, radius);
    }
    tmp[base + P] = tmp[base];
  }
  const out = new Float32Array(src.length);
  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < rows; i++) {
      let acc = reduce.init;
      for (let k = -radius; k <= radius; k++) {
        const r = Math.max(0, Math.min(rows - 1, i + k));
        acc = reduce.step(acc, tmp[r * cols + j]);
      }
      out[i * cols + j] = reduce.done(acc, radius);
    }
  }
  return out;
}
const OCC_MIN_REDUCE = { init: Infinity, step: (a, v) => (v < a ? v : a), done: (a) => a };
const OCC_AVG_REDUCE = { init: 0, step: (a, v) => a + v, done: (a, r) => a / (2 * r + 1) };

// Build the shared floor field (raw int16 units) for a body's heightfield.
// `smooth` widens the reach by OCC_SMOOTH_MULT — for bodies whose "elevation" is not relief
// (the Sun's magnetogram), where a shell that follows the data is meaningless. The result is
// near-spherical but still tracks the data, so it sits far closer than a sphere pinned to the
// global minimum, which the field's extremes drag hopelessly deep.
const OCC_SMOOTH_MULT = 2;
export function computeOccluderField(hf, gridW, gridH, stacks, slices, smooth = false) {
  const { minElev } = computeMinElevPerVertex(hf, gridW, gridH, stacks, slices);
  const rows = stacks + 1, cols = slices + 1;
  const blurRadius = OCC_BLUR_RADIUS * (smooth ? OCC_SMOOTH_MULT : 1);
  let field = occFilter(minElev, rows, cols, blurRadius * OCC_BLUR_PASSES, OCC_MIN_REDUCE);
  for (let p = 0; p < OCC_BLUR_PASSES; p++) field = occFilter(field, rows, cols, blurRadius, OCC_AVG_REDUCE);
  // The two pole rows are slices+1 COINCIDENT vertices; per-column values would give them
  // slices+1 different radii, i.e. self-intersecting slivers that z-fight the ridge lines.
  // Share one minimum across each pole row so those triangles collapse to zero area.
  for (const i of [0, stacks]) {
    const base = i * cols;
    let mn = field[base];
    for (let j = 1; j <= slices; j++) mn = Math.min(mn, field[base + j]);
    field.fill(mn, base, base + cols);
  }
  return field;
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
    if (limMaxStorage < COMPUTE_STORAGE_BUFFERS) {
      throw new Error(
        `this device's WebGPU limits are too low: maxStorageBuffersPerShaderStage ` +
        `${limMaxStorage} < ${COMPUTE_STORAGE_BUFFERS}`);
    }
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: limMaxBinding,
        maxBufferSize: limMaxBuffer,
        maxStorageBuffersPerShaderStage: limMaxStorage,
      },
    });
    this.adapterLimits = { maxStorageBufferBindingSize: limMaxBinding, maxBufferSize: limMaxBuffer };

    // Synthesise an eng-like object from meta + raw buffer so _init can proceed normally.
    const VERT_SCALE = (R_WORLD / EARTH_RADIUS_M) * VERT_EXAGGERATION;
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
    // bind the whole grid, fail clearly — there is no second renderer to fall back to.
    const hfBytes = eng.heightfield_i16_len() * 2;
    const limMaxBinding = adapter.limits.maxStorageBufferBindingSize;
    const limMaxBuffer = adapter.limits.maxBufferSize;
    if (hfBytes > limMaxBinding || hfBytes > limMaxBuffer) {
      throw new Error(
        `heightfield ${(hfBytes/1e6).toFixed(0)}MB exceeds adapter limits ` +
        `(maxStorageBufferBindingSize ${(limMaxBinding/1e6).toFixed(0)}MB, ` +
        `maxBufferSize ${(limMaxBuffer/1e6).toFixed(0)}MB)`);
    }
    // The compute pass uses COMPUTE_STORAGE_BUFFERS storage buffers in one stage, which is
    // exactly the per-stage minimum WebGPU guarantees.
    const limMaxStorage = adapter.limits.maxStorageBuffersPerShaderStage;
    if (limMaxStorage < COMPUTE_STORAGE_BUFFERS) {
      throw new Error(
        `this device's WebGPU limits are too low: maxStorageBuffersPerShaderStage ` +
        `${limMaxStorage} < ${COMPUTE_STORAGE_BUFFERS}`);
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
    this.lineVertBuf = device.createBuffer({ size: (ATTR_BASE_F32 + MAX_VERTS * 2) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX });
    this.idxBuf = device.createBuffer({ size: MAX_INDICES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX });
    this.fillPosBuf = device.createBuffer({ size: MAX_FILL_VERTS * 3 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX });
    this.fillIdxBuf = device.createBuffer({ size: MAX_FILL_INDICES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDEX });
    this.counterBuf = device.createBuffer({
      size: COUNTER_BUF_U32 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.ringBuf = device.createBuffer({ size: MAX_RINGS * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.fillRowBuf = device.createBuffer({ size: MAX_FILL_ROWS * 8 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.camBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // ── Compute pipelines (explicit shared layout: all 10 bindings to all 3 entry points) ──
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
        { binding: 6, visibility: GPUShaderStage.COMPUTE, ...st('read-only-storage') },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, ...st('storage') },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, ...st('storage') },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, ...st('uniform') },
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
    this.fillVP = device.createBuffer({ size: 16 * 4 + 4 * 4 + 4 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.fillPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: fillMod, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      fragment: { module: fillMod, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-strip', stripIndexFormat: 'uint32', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    this.fillBind = device.createBindGroup({ layout: this.fillPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.fillVP } }] });

    // ── Displaced occluder mesh (shared geometry, per-body minElev buffer) ──
    // occLatLonBuf: shared (lat,lon) vertex positions (static, same for every body).
    // Per-body minElev f32 buffer is built in _makeBody and attached as VBO slot 1.
    const occMod = device.createShaderModule({ code: OCCLUDER_WGSL });
    const occBase = buildOccluderMeshBase();
    this.occCount = occBase.idx.length;
    this.occLatLonBuf = device.createBuffer({ size: occBase.latLon.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.occLatLonBuf, 0, occBase.latLon);
    this.occIBO = device.createBuffer({ size: occBase.idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.occIBO, 0, occBase.idx);
    // Uniform: mvp(16f) + color(4f) + vertScale/ve8/margin/pad(4f) + tint(4f) = 28 floats
    this.occVP = device.createBuffer({ size: 28 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this._occUScratch = new Float32Array(28);
    this.occPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: occMod, entryPoint: 'vs',
        buffers: [
          { arrayStride: 8,  attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }, // latLon
          { arrayStride: 4,  attributes: [{ shaderLocation: 1, offset: 0, format: 'float32'   }] }, // minElevRaw
        ],
      },
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

    this._camScratch = new ArrayBuffer(96);
    this._ringScratch = new ArrayBuffer(MAX_RINGS * 16);
    this._fillRowScratch = new ArrayBuffer(MAX_FILL_ROWS * 32);
    this._zeroCounters = new Uint32Array(4); // preallocated zero array — reused each frame for counter reset
    // Preallocated uniform scratch arrays — avoids per-frame GC pressure from small typed arrays.
    this._lineUScratch = new Float32Array(24); // mvp(16)+color(4)+flags(4) — written every frame
    this._fillUScratch = new Float32Array(24); // mvp(16)+color(4)+tint(4) — written when fills active
    // _occUScratch (28 floats: mvp+color+vertScale+ve8+margin+pad+tint) already created above with the occluder pipeline
    this._invVPScratch = new Float32Array(16); // star invVP — written every frame
    this._lastCpuGenMs = 0;
    this.resize(canvas.width, canvas.height);
  }

  // w/h are DEVICE pixels (must match the swapchain, i.e. canvas.width/height).
  // cssH is the canvas height in CSS px — the ring-density cap below is a
  // perceptual threshold and stays anchored to CSS px so ring counts (and cost)
  // do not scale with devicePixelRatio.
  resize(w, h, cssH = h) {
    if (w === 0 || h === 0) return;
    this.cssHeight = cssH;
    // Mobile browsers fire resize repeatedly during address-bar collapse and
    // orientation change; without this each one orphaned a full-canvas depth texture.
    this.depthTex?.destroy();
    this.depthTex = this.device.createTexture({
      size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  // Build the per-frame LINE ring + FILL strip schedules (CHEAP — O(rows), ports the old core's
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
    // Fills are near/mid-altitude only — the displaced occluder mesh handles high-altitude
    // occlusion for all bodies (including deep-relief bodies like Vesta). No deepRelief override.
    const emitFills = discHalfAngle >= fillGate;
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

    // ── Screen-space ring density cap (moiré fix) ────────────────────────────
    // At deep space the projected globe may be only ~330 px tall while the grid has ~360+
    // latitude rows — sub-pixel ring spacing aliases into moiré speckle across the disc.
    // Cap ring density so there are at least MIN_PX_PER_RING screen pixels between rings.
    //
    // Formula (FOV_Y = Math.PI/4 matches the app's 45° vertical FOV):
    //   halfAngle   = asin(R_WORLD / camDist)          — angular radius of the globe
    //   discHeightPx = tan(halfAngle) / tan(FOV_Y/2) × canvasHeight
    //   maxRingsOnScreen = discHeightPx / MIN_PX_PER_RING
    //   minRowStepScreen = ceil(H / max(8, maxRingsOnScreen))
    //
    // Note: the renderer has the mvp but not the FOV directly, so FOV_Y is hardcoded
    // here to match explore.js's Math.PI/4.  If the FOV ever changes, update this constant.
    const FOV_Y = Math.PI / 4;
    const MIN_PX_PER_RING = 2.0;
    const canvasH = this.cssHeight || 800;
    const discHeightPx = (Math.tan(discHalfAngle) / Math.tan(FOV_Y / 2)) * canvasH;
    const maxRingsOnScreen = discHeightPx / MIN_PX_PER_RING;
    const minRowStepScreen = Math.ceil(H / Math.max(8, maxRingsOnScreen));

    // LINE rings (with sub-ring interpolation).
    // Pre-clamp row step so total worst-case vertex/index reservations stay inside the GPU
    // buffer budgets. Near the poles lon_pad→180° forces every ring to sweep the full 360°
    // (half_cols = gridW/2 + colStride), so each ring reserves ~gridW/colStride+4 verts and
    // 2× that many indices. Without this clamp the GPU atomic counter overflows and a random
    // ~1/16 of rings survives → chaotic criss-cross at low polar altitude. Mirrors the
    // identical fill-strip pre-clamp below (same pattern, same rationale).
    // Use this._lonPad (already set for this frame) to size the per-ring budget accurately:
    // if lon_pad < 180 the rings don't go full-width, so the budget is smaller and the clamp
    // is proportionally looser (no-op below ~|lat| 70°). Near-camera rings have vh ≈ 90°,
    // so window_half ≈ lon_pad + 90° — used as the budget estimate half-window.
    const minColStride = exploreStrides ? exploreStrides[1] : 1; // worst-case colStride in flight mode
    const lonPadNow = this._lonPad ?? 70.0;
    const windowHalfBudget = Math.min(180.0, lonPadNow + 90.0); // conservative estimate
    const wcHalfCols = Math.ceil((windowHalfBudget / 360.0) * this.gridW) + minColStride;
    const wcVertsPerRing = Math.floor(wcHalfCols * 2 / minColStride) + 4;
    const wcIdxPerRing = wcVertsPerRing * 2 + 1;
    const maxRingsByVerts = Math.max(1, Math.floor(MAX_VERTS / wcVertsPerRing));
    const maxRingsByIdx   = Math.max(1, Math.floor(MAX_INDICES / wcIdxPerRing));
    const maxAffordableRings = Math.min(maxRingsByVerts, maxRingsByIdx);
    // Estimate how many rows the schedule will visit (H / effective_rowStep, roughly).
    // We need ceil(H / maxAffordableRings) as the minimum rowStep to stay in budget.
    const minLineRowStep = Math.max(Math.ceil(H / maxAffordableRings), minRowStepScreen);

    const rdv = new DataView(this._ringScratch);
    let n = 0;
    // Strides are calibrated on Earth's full grid (6144 rows). Smaller grids (the Sun's
    // 1440, or a coarse tier mid-refinement) would render proportionally sparser with the
    // same absolute step — scale steps by grid density so visual density stays constant.
    const gridScale = Math.min(1, H / 6144);
    const dstride = (v) => Math.max(1, Math.round(v * gridScale));
    let row = 0;
    while (row < H) {
      const lat = rowLatFrac(row, 0);
      const nearest = nearestOf(lat);
      const [rowStep, colStride] = exploreStrides || stridesForDistance(nearest);
      const rs = Math.max(minLineRowStep, dstride(rowStep) * boost);
      const cs = dstride(colStride) * boost;
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
      // Each fill strip claims a worst-case GPU block of ~gridW*2 verts in the WGSL
      // atomicAdd guard. At full resolution + low altitude the naive step-1 schedule
      // claims gridH * gridW * 2 verts (e.g. Earth full: 33.6 M) >> MAX_FILL_VERTS (3 M),
      // so the guard silently DROPS ~91% of strips → the planet body goes transparent
      // and the starfield bleeds through. Pre-clamp the row step so the total worst-case
      // stays inside the budget; at coarse tiers this computes 1 (no change).
      const wcVertPerStrip = (this.gridW + 4) * 2;
      const maxStrips = Math.max(1, Math.floor(MAX_FILL_VERTS / wcVertPerStrip));
      const minFillRowStep = Math.max(Math.ceil(H / maxStrips), minRowStepScreen);
      while (frow < H) {
        const lat = this.latMax - (frow / (H - 1)) * (this.latMax - this.latMin);
        const nearest = nearestOf(lat);
        const [rowStep, colStride] = exploreStrides || stridesForDistance(nearest);
        const fc = exploreStrides ? 1 : FILL_COARSEN; // dense fills seal cleanly (no gaps/flicker)
        const fillRowStep = Math.max(minFillRowStep, Math.max(1, dstride(rowStep) * boost * fc));
        const fillColStride = Math.max(1, dstride(colStride) * boost * fc);
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
      // The stepped walk stops at the last multiple of fillRowStep below H, so unless the
      // step divides the grid exactly there is a tail band down to the south pole with no
      // strip over it — a hole, whenever the pole is in frame. Close it.
      if (prev && prev[0] < H - 1 && fn < MAX_FILL_ROWS) {
        const o = fn * 32;
        fdv.setUint32(o, prev[0], true);
        fdv.setUint32(o + 4, H - 1, true);
        fdv.setFloat32(o + 8, prev[1], true);
        fdv.setFloat32(o + 12, this.latMin, true);
        fdv.setUint32(o + 16, prev[2], true);
        fn++;
      }
    }

    this._lastRingCount = n;
    this._lastFillCount = fn;
    return { ringCount: n, fillCount: fn, discHalfAngle, emitFills };
  }

  // Build a renderable BODY (planet/moon): upload its int16 heightfield to a GPU storage
  // buffer and create the compute bind group referencing it. Also computes the occluder
  // envelope for the displaced occluder mesh (one-off O(grid) CPU pass). Returns a body handle.
  _makeBody(eng, wasmMemory, smoothOccluder) {
    const device = this.device;
    const hfPtr = eng.heightfield_i16_ptr();
    const hfLen = eng.heightfield_i16_len();
    const hfBytes = hfLen * 2;
    const wordCount = Math.ceil(hfLen / 2); // round up so an odd hfLen keeps its trailing i16
    const hfBuf = device.createBuffer({ size: wordCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(hfBuf, 0, new Uint8Array(wasmMemory.buffer, hfPtr, hfBytes));

    // The shared FLOOR field (CPU, one-off per tier load): per-cell minimum, eroded and
    // blurred into a smooth envelope. Consumed twice — as the occluder mesh's per-vertex
    // displacement (VERTEX) and as the fill strips' floor in the compute pass (STORAGE).
    const gridW = eng.grid_width(), gridH = eng.grid_height();
    const hf = new Int16Array(wasmMemory.buffer, hfPtr, hfLen);
    const minElevF32 = computeOccluderField(hf, gridW, gridH, OCC_STACKS, OCC_SLICES, !!smoothOccluder);
    const minElevBuf = device.createBuffer({
      size: FLOOR_VEC4S * 16,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(minElevBuf, 0, minElevF32);

    const computeBind = device.createBindGroup({
      layout: this._computeBGL,
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: { buffer: hfBuf } },
        { binding: 2, resource: { buffer: this.ringBuf } },
        { binding: 3, resource: { buffer: this.lineVertBuf } },
        { binding: 4, resource: { buffer: this.idxBuf } },
        { binding: 5, resource: { buffer: this.counterBuf } },
        { binding: 6, resource: { buffer: this.fillRowBuf } },
        { binding: 7, resource: { buffer: this.fillPosBuf } },
        { binding: 8, resource: { buffer: this.fillIdxBuf } },
        { binding: 9, resource: { buffer: minElevBuf } },
      ],
    });

    console.log(`[webgpu] body uploaded: ${(hfBytes/1e6).toFixed(0)}MB int16 (${gridW}x${gridH})`);
    return {
      hfBuf, minElevBuf, computeBind,
      gridW, gridH,
      elevMax: eng.elev_world_max(), vertScale: eng.vert_scale(),
      latMin: -90, latMax: 90, lonMin: -180, lonMax: 180,
      tint: [1, 1, 1], // per-body tint multiplier; [1,1,1] = identity (explore.js: handle.tint = [r,g,b])
    };
  }

  // Register an additional body (e.g. the Moon) for later swapping. Returns its handle.
  addBody(eng, wasmMemory, smoothOccluder) { return this._makeBody(eng, wasmMemory, smoothOccluder); }

  // Destroy a body handle, freeing its GPU buffers. Do NOT call on the currently
  // active body (switch to another first). Safe to call on any non-active handle.
  destroyBody(b) {
    if (!b) return;
    try { b.hfBuf.destroy(); } catch (_) {}
    try { b.minElevBuf.destroy(); } catch (_) {}
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
    this._activeMinElevBuf = b.minElevBuf; // per-body minElev buffer for the displaced occluder
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

  draw(eng) {
    const device = this.device;
    // Explore mode: uniform LOD override — bypass distance-based stride tables.
    this._exploreLodAlt = eng.explore_alt ? eng.explore_alt() : null;
    // Explore uses a tight longitude pad (camera doesn't move fast, so the geometric
    // window is accurate); flight keeps the wide pad for high-speed camera lag.
    // Near the poles longitude lines converge: a fixed-degree window centered on the
    // sub-camera longitude misses terrain on the poleward side when |lat| > ~80°
    // (e.g. from 86°N looking north, the far terrain sits at the antipodal longitude
    // ≈ cam_lon+180°). Ramp lon_pad → 180° above |lat| 70–85° so the WGSL `full`
    // gate triggers (window_half ≥ 180). Polar rings are few so the perf cost is nil.
    this._lonPad = this._exploreLodAlt !== null ? 14.0 : 70.0;
    const mvp = eng.view_proj();
    const camPosArr = eng.camera_position();
    const camPos = [camPosArr[0], camPosArr[1], camPosArr[2]];
    {
      const camLen = Math.hypot(camPos[0], camPos[1], camPos[2]);
      const absLat = Math.abs(Math.asin(Math.max(-1, Math.min(1, camPos[1] / camLen)))) * 180 / Math.PI;
      if (absLat > 70) {
        const basePad = this._lonPad;
        const t = Math.min(1, (absLat - 70) / 15); // 0 at 70°, 1 at 85°
        this._lonPad = basePad + t * (180 - basePad);
      }
    }
    const fwdArr = eng.cam_forward();
    this._camFwd = [fwdArr[0], fwdArr[1], fwdArr[2]];
    const ve = eng.current_ve();
    this._lastVe = ve;

    // CPU work = the cheap ring + fill schedules ONLY (heavy vertex gen is on the GPU).
    const t0 = performance.now();
    const { ringCount, fillCount, emitFills } = this._buildSchedule(camPos);
    this._lastCpuGenMs = performance.now() - t0;

    this._writeCamera(camPos, ve, ringCount, fillCount);
    device.queue.writeBuffer(this.camBuf, 0, this._camScratch);
    device.queue.writeBuffer(this.ringBuf, 0, this._ringScratch, 0, ringCount * 16);
    if (fillCount > 0) device.queue.writeBuffer(this.fillRowBuf, 0, this._fillRowScratch, 0, fillCount * 32);
    device.queue.writeBuffer(this.counterBuf, 0, this._zeroCounters);

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
    if (mat4InvertInto(starMvp, this._invVPScratch)) {
      device.queue.writeBuffer(this.starU, 0, this._invVPScratch);
      rp.setPipeline(this.starPipe);
      rp.setBindGroup(0, this.starBind);
      rp.draw(3);
    }

    // per-body line/fill tint — read from the CURRENT handle every frame (declared before
    // the occluder block: occluder, fill and line uniforms all consume it).
    const tint = this.activeBody?.tint ?? [1, 1, 1];

    // Displaced occluder mesh — always drawn (at ALL altitudes, for every body). It is the
    // CLOSED backstop: the fill strips draw the same floor field more finely on top of it,
    // so wherever a fill strip is culled or coarsened the shell is still solid underneath.
    // Vertex shader computes per-vertex radius = R_WORLD + minElevRaw*vertScale*(ve/8) − clearance.
    if (this._activeMinElevBuf) {
      const u = this._occUScratch;
      u.set(mvp, 0);
      u.set(PALETTE.fill, 16);
      u[20] = this.vertScale;
      u[21] = ve / VERT_EXAGGERATION;
      u[22] = FLOOR_CLEARANCE_WU;
      u[23] = 0.0; // pad
      u[24] = tint[0]; u[25] = tint[1]; u[26] = tint[2]; u[27] = 1.0;
      device.queue.writeBuffer(this.occVP, 0, u);
      rp.setPipeline(this.occPipe);
      rp.setBindGroup(0, this.occBind);
      rp.setVertexBuffer(0, this.occLatLonBuf);
      rp.setVertexBuffer(1, this._activeMinElevBuf);
      rp.setIndexBuffer(this.occIBO, 'uint32');
      rp.drawIndexed(this.occCount);
    }

    // per-ring FILL strips (near/mid regime) — terrain-following dark depth occluder
    if (emitFills && fillCount > 0) {
      this._fillUScratch.set(mvp, 0); this._fillUScratch.set(PALETTE.fill, 16);
      this._fillUScratch[20] = tint[0]; this._fillUScratch[21] = tint[1]; this._fillUScratch[22] = tint[2]; this._fillUScratch[23] = 1.0;
      device.queue.writeBuffer(this.fillVP, 0, this._fillUScratch);
      rp.setPipeline(this.fillPipe);
      rp.setBindGroup(0, this.fillBind);
      rp.setVertexBuffer(0, this.fillPosBuf);
      rp.setIndexBuffer(this.fillIdxBuf, 'uint32');
      rp.drawIndexedIndirect(this.counterBuf, INDIRECT_FILL_U32 * 4); // fill args block
    }

    // lines (drawIndexedIndirect from compute output)
    this._lineUScratch.set(mvp, 0); this._lineUScratch.set(PALETTE.line, 16);
    this._lineUScratch[20] = this.hasOcean === false ? 0 : 1; // flags.x: ocean shading on unless the body opts out
    this._lineUScratch[21] = tint[0]; this._lineUScratch[22] = tint[1]; this._lineUScratch[23] = tint[2]; // flags.yzw: per-body tint
    device.queue.writeBuffer(this.lineVP, 0, this._lineUScratch);
    rp.setPipeline(this.linePipe);
    rp.setBindGroup(0, this.lineBind);
    rp.setVertexBuffer(0, this.lineVertBuf);
    rp.setVertexBuffer(1, this.lineVertBuf, ATTR_BASE_F32 * 4);
    rp.setIndexBuffer(this.idxBuf, 'uint32');
    rp.drawIndexedIndirect(this.counterBuf, INDIRECT_LINE_U32 * 4); // line args block

    rp.end();
    device.queue.submit([enc.finish()]);
  }

  cpuGenMs() { return this._lastCpuGenMs; }

  async debugReadback() {
    const dev = this.device;
    const rb = dev.createBuffer({ size: 64, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.counterBuf, 0, rb, 0, COUNTER_BUF_U32 * 4);
    dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const u = new Uint32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    return {
      lineVerts: u[0], lineIdx: u[1], fillVerts: u[2], fillIdx: u[3],
      lineIndirect: [...u.slice(INDIRECT_LINE_U32, INDIRECT_LINE_U32 + 5)],
      fillIndirect: [...u.slice(INDIRECT_FILL_U32, INDIRECT_FILL_U32 + 5)],
    };
  }
}
