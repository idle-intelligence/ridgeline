import { WebGPURenderer } from './renderer-webgpu.js';
import { WORLD_RADIUS, VERT_EXAGGERATION } from './constants.js';
import { Body } from './body.js';
import { dataUrl, cachedFetch } from './terrain-cache.js';
import {
  normalize, cross, dot, sub, add, scale,
  mat4LookAt, mat4Perspective, mat4Mul,
  vec3ToLatLon, rotateY, rodrigues, raySphere, clampPolar,
} from './mathutil.js';
import { toJD, bodySkyDirection, OBLIQUITY, helioPos, helioEcl } from './ephemeris.js';
import { createSystemView } from './system-view.js';
import { createDragTap } from './dragtap.js';

const R_WORLD = WORLD_RADIUS;
const FOV_Y = Math.PI / 4;    // 45° — must match the FOV_Y in renderer-webgpu.js
// Camera pitch off nadir: TILT_MIN (~3°) = straight down at the planet, π/2 = horizon, higher =
// looking up into the sky. How far above the horizon you may crane is capped PER altitude mode:
// on the SURFACE you can look up to space; in ATMO you stop at the horizon; ORBIT a bit past it.
// The floor is TILT_MIN in every mode (always free to look straight down).
const TILT_MIN = 0.05;
const DEG = Math.PI / 180;
const SURFACE_TILT = 80 * DEG;             // resting pitch on arriving at the surface (ground + sky)
const TILT_MAX_BY_MODE = { SURFACE: 110 * DEG, ATMO: Math.PI / 2, LOW: Math.PI / 2, ORBIT: 1.75 };
// A body can sit anywhere up to the zenith, and the per-mode ceilings (100–110°) stop the
// camera ~10° above the horizon — so a marker high overhead could never be faced, and the
// hop's hold beat framed empty sky. The hop is allowed up to this instead, then eased back
// into the mode's range on arrival. Kept short of 180°: at exactly π the up-vector is
// degenerate (_buildCamMvp falls back, but the roll it picks is arbitrary).
const TILT_HOP_MAX = 175 * DEG;
const tiltMaxFor = m => TILT_MAX_BY_MODE[m] ?? 1.75; // DEEP SPACE etc. → ~100°
const clampTilt = (t, m) => Math.max(TILT_MIN, Math.min(tiltMaxFor(m), t));
const ALT_START = 12010;   // world units — lowest DEEP SPACE (just past the 12000 orbit ceiling); largest framed globe
const TILT_START = TILT_MIN; // deep-space resting pitch — top-down, globe centered

// Continuous resting pitch as a function of altitude, derived from the active body's mode
// ceilings. Interpolation happens in log-altitude space with per-segment smoothstep so the
// derivative is 0 at each anchor (no kinks). Anchors:
//   alt ≤ surfCeil          → SURFACE_TILT (80°)
//   alt = atmoCeil (1500)   → 60°
//   alt = orbitCeil (12000) → 30°
//   alt ≥ 2×orbitCeil       → TILT_MIN (top-down)
// Below first anchor → clamped to SURFACE_TILT; above last → clamped to TILT_MIN.
function tiltRestForAlt(altWu, body) {
  const modes = body.modes;
  const surfCeil   = modes[0][0];
  const atmoCeil   = modes[1][0];
  const orbitCeil  = modes[2][0];
  const deepCeil   = orbitCeil * 2;

  const anchors = [
    [surfCeil,  SURFACE_TILT],
    [atmoCeil,  60 * DEG],
    [orbitCeil, 30 * DEG],
    [deepCeil,  TILT_MIN],
  ];

  if (altWu <= anchors[0][0]) return anchors[0][1];
  if (altWu >= anchors[anchors.length - 1][0]) return TILT_MIN;

  for (let i = 0; i < anchors.length - 1; i++) {
    const [a0, t0] = anchors[i];
    const [a1, t1] = anchors[i + 1];
    if (altWu <= a1) {
      // Smoothstep in log-altitude space: derivative → 0 at each anchor.
      const u = (Math.log(altWu) - Math.log(a0)) / (Math.log(a1) - Math.log(a0));
      const s = u * u * (3 - 2 * u); // smoothstep
      return t0 + s * (t1 - t0);
    }
  }
  return TILT_MIN;
}
const Z_NEAR = 1.0;
const Z_FAR = 200_000.0;
const DAY_SEC = 86400;

// ── System (orrery) view thresholds ──────────────────────────────────────────
// Transition is driven by ALTITUDE (wu) alone — no separate mode toggle.
// sysT = smoothstep((alt - SYS_FADE_START) / (SYS_FADE_END - SYS_FADE_START))
// sysT=0 → at the globe; sysT=1 → whole system framed.
//
// This is a ZOOM OUT, not a cross-fade. Both canvases stay fully opaque: the globe
// genuinely shrinks (real perspective — SYS_FADE_END is far enough out that it ends
// up dot-sized, ~1% of screen height) while the orrery camera pulls back from right
// beside the body to the distance that frames the outermost orbit. The globe canvas
// only fades over the last sliver of the pull-back, where it and the orrery's dot for
// the same body are the same handful of pixels in the same place.
//
// Reversibility: wheel-out increases altitude → we keep pulling back.
//   Wheel-in decreases altitude → the camera flies back in and the globe grows again.
// Altitude (world units) below which the full-resolution tier is worth its download.
// Matches the second band ceiling: ATMO / LOW / CORONA.
const FULL_RES_ALT      = 1500;
const SYS_FADE_START    = 120_000;   // wu — globe ~12% of screen height; orrery starts pulling back
const SYS_FADE_END      = 1_500_000; // wu — globe ~1% of screen height (dot-sized); system framed
const ALT_CAP_SYSTEM    = SYS_FADE_END; // fully zoomed out = the end of the wheel's travel
const SYS_HANDOFF_START = 0.9;       // sysT at which the (now dot-sized) globe hands off to the orrery dot

// System mode state (module-level so frame loop + handlers can share it).
const SYS_INPUT_T = 0.35; // sysT past which pointer input drives the orrery, not the globe
// sysT past which the globe's own sky markers stop being drawn and the orrery's labels take
// over. Below it the sky markers are the view and their directions are real; above it only
// the orrery's log-compressed dots exist.
const MARKER_FADE_T = 0.15;
let sysT = 0.0;          // 0 = globe, 1 = system; computed from altitude each frame
// Entering a body from the orrery: glide its altitude down from system range so the
// arrival is the zoom-out played backwards, not a cut. Cancelled by any wheel input.
let altGlide = null;     // { body, dest } | null
let systemView = null;   // set after main() creates it

let wasmMem = null; // set in main(); backs the per-body heightfield sampling below
let groundElevM = 0; // terrain elevation (m) under the camera this frame — for the HUD GND readout

// Per-body refinement indicator: label shown in HUD while finer tier is downloading.
// e.g. { earth: 'd4', moon: null }
const lodLabel = {};
// 0..1 fraction of the tier currently downloading, for the HUD indicator.
const lodProgress = {};

// ── Tiered heightfield loading ────────────────────────────────────────────────
// Tier factors: 16 = coarse (d16), 4 = medium (d4), 1 = full resolution.
// Tier dims: meta.width/factor × meta.height/factor (integer division, exact by bake design).
// URL for a tier: stem + (f===1 ? '.bin' : `_d${f}.bin`)
function tierUrl(b, f) {
  const q = b.cacheBust ? `?${b.cacheBust}` : ''; // per-body re-bake bust (Cache API keys include the query)
  return dataUrl((f === 1 ? `${b.hfStem}.bin` : `${b.hfStem}_d${f}.bin`) + q);
}
function tierDims(meta, f) {
  return { w: Math.floor(meta.width / f), h: Math.floor(meta.height / f) };
}

// Build a WASM Engine + renderer handle for a given buffer + dims, then atomically
// upgrade the body's tier state. Destroys the previous engine/handle (GPU mem + WASM).
// Only upgrades if `f` is finer than the body's current tier. If `isActive` is true,
// also calls renderer.useBody so rendering switches to the new tier.
// This function is synchronous after the await (all GPU writes are synchronous).
function _applyTier(b, f, buf, meta, Engine, renderer, isActive) {
  if (f >= b.tier && b.tier !== 0) return; // already at this tier or finer — skip
  const { w, h } = tierDims(meta, f);
  const { bbox } = meta;
  const newEngine = new Engine(w, h, new Uint8Array(buf),
    meta.elev_max, bbox.lat_min, bbox.lat_max, bbox.lon_min, bbox.lon_max);
  const newHandle = renderer.addBody(newEngine, wasmMem, b.smoothOccluder);
  // Occluder depth uses RAW int16 units (the shader's bulge units) — for scaled bodies
  // (Vesta: 2 m/unit) elev_min is real metres and would over-deepen the dome.
  newHandle.elevMinWu = (meta.elev_i16_min ?? meta.elev_min) * newHandle.vertScale;
  newHandle.hasOcean = b.hasOcean;
  if (b.tint) newHandle.tint = b.tint; // per-body line/fill tint (e.g. the Sun's warm glow)

  // Destroy previous resources before overwriting.
  const oldHandle = b.handle;
  const oldEngine = b.engine;

  b.engine = newEngine;
  b.handle = newHandle;
  b.tier = f;
  b.gridW = w;
  b.gridH = h;
  b.hfPtr = newEngine.heightfield_i16_ptr();

  if (isActive) renderer.useBody(newHandle);

  // Clean up previous tier: GPU buffer + WASM memory.
  if (oldHandle) renderer.destroyBody(oldHandle);
  if (oldEngine) try { oldEngine.free(); } catch (_) {}
}

// Build the loading bar progress tracker. Returns an updateProgress() function
// that tracks bytes across multiple concurrent downloads.
function _makeProgress(loadfill, loadpct) {
  const got = {}, tot = {};
  const update = () => {
    const r = Object.values(got).reduce((a, v) => a + v, 0);
    const t = Object.values(tot).reduce((a, v) => a + v, 0);
    if (loadfill) loadfill.style.width = (t > 0 ? Math.min(100, r / t * 100) : 0) + '%';
    if (loadpct) loadpct.textContent = `loading terrain… ${(r/1e6).toFixed(0)} / ${(t/1e6).toFixed(0)} MB`;
  };
  const track = (key, loaded, total) => { got[key] = loaded; tot[key] = total; update(); };
  return track;
}

// ── Bodies ───────────────────────────────────────────────────────────────────
const EARTH = new Body({
  id: 'earth', name: 'EARTH',
  metaUrl: dataUrl('meta.json'), dataUrl: dataUrl('heightfield.bin'),
  hfStem: 'heightfield',
  radiusM: 6371000, rotationPeriodSec: 86164, // sidereal day (star-relative spin), not the 86400 solar day
  veFactor: 1.0, color: '#6aa3ff',
  modes: [[50, 'SURFACE'], [1500, 'ATMO'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  view: { lat: 20, lon: 15, altitude: ALT_START, tilt: TILT_START, heading: 0 },
  orbit: null,
});
const MOON = new Body({
  id: 'moon', name: 'MOON',
  metaUrl: dataUrl('moon_meta.json'), dataUrl: dataUrl('moon_heightfield.bin'),
  hfStem: 'moon_heightfield',
  radiusM: 1737400, rotationPeriodSec: 27.32 * DAY_SEC,
  veFactor: 1.0, color: '#cfd2d8', hasOcean: false,
  modes: [[50, 'SURFACE'], [1500, 'LOW'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  view: { lat: 0, lon: 0, altitude: ALT_START, tilt: TILT_START, heading: 0 },
  orbit: { aroundId: 'earth', periodSec: 27.32 * DAY_SEC, inclinationDeg: 18 },
});
const MARS = new Body({
  id: 'mars', name: 'MARS',
  metaUrl: dataUrl('mars_meta.json'), dataUrl: dataUrl('mars_heightfield.bin'),
  hfStem: 'mars_heightfield',
  radiusM: 3389500, rotationPeriodSec: 88642, // Mars sidereal day ≈ 24h 37m
  // Mars has the tallest relief in the system (Olympus Mons +21 km); a lower veFactor
  // keeps its rendered bulge (~2% of the globe) in line with Earth/Moon instead of ~4.6%.
  veFactor: 0.45, color: '#e07a4f', hasOcean: false,
  modes: [[50, 'SURFACE'], [1500, 'ATMO'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  view: { lat: -6, lon: -75, altitude: ALT_START, tilt: TILT_START, heading: 0 }, // Valles Marineris / Tharsis
  orbit: { aroundId: 'sun', periodSec: 687 * DAY_SEC, inclinationDeg: 25 },
});
const VENUS = new Body({
  id: 'venus', name: 'VENUS',
  metaUrl: dataUrl('venus_meta.json'), dataUrl: dataUrl('venus_heightfield.bin'),
  hfStem: 'venus_heightfield',
  // Venus spins RETROGRADE with a 243-day sidereal period — the negative period
  // flips rotDegPerSec's sign, which is exactly the backwards spin.
  radiusM: 6051000, rotationPeriodSec: -243.02 * DAY_SEC,
  veFactor: 1.0, color: '#e6c98a', hasOcean: false,
  modes: [[50, 'SURFACE'], [1500, 'ATMO'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  view: { lat: 40, lon: 15, altitude: ALT_START, tilt: TILT_START, heading: 0 }, // Ishtar Terra / Maxwell Montes
  orbit: { aroundId: 'sun', periodSec: 224.7 * DAY_SEC, inclinationDeg: 3.4 },
});
const MERCURY = new Body({
  id: 'mercury', name: 'MERCURY',
  metaUrl: dataUrl('mercury_meta.json'), dataUrl: dataUrl('mercury_heightfield.bin'),
  hfStem: 'mercury_heightfield',
  radiusM: 2439400, rotationPeriodSec: 58.646 * DAY_SEC, // 3:2 spin-orbit resonance
  veFactor: 0.9, color: '#b8a898', hasOcean: false,
  modes: [[50, 'SURFACE'], [1500, 'LOW'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  view: { lat: 30, lon: -170, altitude: ALT_START, tilt: TILT_START, heading: 0 }, // Caloris basin
  orbit: { aroundId: 'sun', periodSec: 88 * DAY_SEC, inclinationDeg: 7 },
});
const CERES = new Body({
  id: 'ceres', name: 'CERES',
  metaUrl: dataUrl('ceres_meta.json'), dataUrl: dataUrl('ceres_heightfield.bin'),
  hfStem: 'ceres_heightfield',
  radiusM: 470000, rotationPeriodSec: 9.074 * 3600,
  // trueShape: true relief ±1.6% of radius (genuinely smooth — icy, relaxed dwarf planet).
  // veFactor ignored under trueShape; kept for reference in case trueShape is toggled off.
  trueShape: true, veFactor: 0.32, color: '#b8b0a0', hasOcean: false,
  modes: [[50, 'SURFACE'], [1500, 'LOW'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  view: { lat: 19.8, lon: -120, altitude: ALT_START, tilt: TILT_START, heading: 0 }, // Occator crater
  orbit: { aroundId: 'sun', periodSec: 1682 * DAY_SEC },
});
// Note: Vesta's meta has elev_scale_m: 2 (int16 values are in 2 m units, range exceeded
// plain int16 meters). Vesta is also highly triaxial (axes ~286/279/223 km), so the sphere
// render is intentionally lumpy — the reference-sphere fit is coarse by design.
// trueShape: true pins ve to fixedVe so rendered radial deviations are true proportions.
// veFactor is unused when trueShape=true (fixedVe is derived from meta+radius in computeCamera).
const VESTA = new Body({
  id: 'vesta', name: 'VESTA',
  metaUrl: dataUrl('vesta_meta.json'), dataUrl: dataUrl('vesta_heightfield.bin'),
  hfStem: 'vesta_heightfield',
  radiusM: 262700, rotationPeriodSec: 5.342 * 3600,
  trueShape: true, color: '#cfc3aa', hasOcean: false,
  cacheBust: 'r2', // data changed: polar rows flattened + periodic lon resample
  modes: [[50, 'SURFACE'], [1500, 'LOW'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  // spawn 30% farther: the true-shape bulge (~+15% radius) needs framing headroom
  view: { lat: 0, lon: -60, altitude: ALT_START * 1.3, tilt: TILT_START, heading: 0 }, // equatorial: spin axis vertical, potato profile visible (old -75° stared into Rheasilvia basin where occluder dominated)
  orbit: { aroundId: 'sun', periodSec: 1325 * DAY_SEC },
});
const ENCELADUS = new Body({
  id: 'enceladus', name: 'ENCELADUS',
  metaUrl: dataUrl('enceladus_meta.json'), dataUrl: dataUrl('enceladus_heightfield.bin'),
  hfStem: 'enceladus_heightfield',
  radiusM: 252100, rotationPeriodSec: 1.370218 * DAY_SEC, // tidally locked to Saturn
  // trueShape: true relief ±1% of radius (very smooth icy shell, cryo-ocean world).
  // veFactor ignored under trueShape; kept for reference in case trueShape is toggled off.
  trueShape: true, veFactor: 3.3, color: '#dfe9ec', hasOcean: false,
  // r3: the +177° seam. The 128-col wrap overlap was discarded as a 'duplicate', but it is a
  // second, slightly different take on the same longitudes, so the join left a ~0.17 km cliff
  // running pole to pole. Cross-faded in the bake now; all three tiers re-uploaded.
  cacheBust: 'r3',
  modes: [[50, 'SURFACE'], [1500, 'LOW'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  // spawn equatorial (stacked-ridge profile); the south-polar tiger stripes are one drag south
  view: { lat: 0, lon: 0, altitude: ALT_START, tilt: TILT_START, heading: 0 }, // south-polar tiger-stripe terrain
  orbit: { aroundId: 'saturn', periodSec: 1.370218 * DAY_SEC },
});
// Note: ~54% of the far side is unimaged (New Horizons July 2015 flyby); that hemisphere fills
// at reference level 0 and renders like ocean. cacheBust r2: data changed (fill 0 not mean).
// Pluto spins RETROGRADE — negative rotationPeriodSec flips rotDegPerSec's sign, matching Venus.
// Pluto stays exaggerated (veFactor 1.4): the New Horizons encounter terrain (Sputnik Planitia,
// al-Idrisi Montes) is the visual showcase — exaggeration makes it legible at orbital altitude.
const PLUTO = new Body({
  id: 'pluto', name: 'PLUTO',
  metaUrl: dataUrl('pluto_meta.json'), dataUrl: dataUrl('pluto_heightfield.bin'),
  hfStem: 'pluto_heightfield',
  radiusM: 1188300, rotationPeriodSec: -6.38723 * DAY_SEC, // retrograde (tidally locked with Charon)
  veFactor: 1.4, color: '#d8c7b8', hasOcean: true, // far side = unimaged, renders like ocean
  cacheBust: 'r2', // data changed: nodata fill is now 0 instead of mean
  modes: [[50, 'SURFACE'], [1500, 'LOW'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  view: { lat: 25, lon: 10, altitude: ALT_START, tilt: TILT_START, heading: 0 }, // Sputnik Planitia
  orbit: { aroundId: 'sun', periodSec: 90560 * DAY_SEC },
});
// Note: ~54% of the far side is unimaged (same New Horizons flyby caveat as Pluto); fills at 0.
// cacheBust r2: data changed (fill 0 not mean).
const CHARON = new Body({
  id: 'charon', name: 'CHARON',
  metaUrl: dataUrl('charon_meta.json'), dataUrl: dataUrl('charon_heightfield.bin'),
  hfStem: 'charon_heightfield',
  radiusM: 606000, rotationPeriodSec: 6.38723 * DAY_SEC, // tidally locked to Pluto
  // trueShape: true relief ±2.3% of radius (most rugged of the small icy bodies here).
  // veFactor ignored under trueShape; kept for reference in case trueShape is toggled off.
  trueShape: true, veFactor: 0.64, color: '#a8a09b', hasOcean: true, // far side = unimaged, renders like ocean
  cacheBust: 'r2', // data changed: nodata fill is now 0 instead of mean
  modes: [[50, 'SURFACE'], [1500, 'LOW'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  view: { lat: 5, lon: 120, altitude: ALT_START, tilt: TILT_START, heading: 0 }, // Serenity Chasma
  orbit: { aroundId: 'pluto', periodSec: 6.38723 * DAY_SEC },
});
const SUN = new Body({
  id: 'sun', name: 'SUN',
  metaUrl: dataUrl('sun_meta.json'), dataUrl: dataUrl('sun_heightfield.bin'),
  hfStem: 'sun_heightfield',
  // The Sun's "terrain" is the SDO/HMI Carrington synoptic MAGNETOGRAM (CR2300):
  // ridges are magnetic field strength (signed-sqrt Gauss mapping — see bake_sun.py),
  // so bipolar active regions render as mountain+trench pairs in the activity belts.
  radiusM: 696000000, rotationPeriodSec: 25.38 * DAY_SEC, // Carrington sidereal rotation
  // Field-values are tiny relative to the huge radius — boost ve so the magnetic
  // ridges read like Earth's mountains do (≈ Earth relief ratio × 32).
  veFactor: 1.5, color: '#ffcf6a', hasOcean: false,
  // The field is not relief: an occluder shaped by it is meaningless. Plain smooth sphere.
  smoothOccluder: true,
  cacheBust: 'r3', // re-bake 3: restored gradation — ±32000 cap (was ±10000); veFactor 2→1.5
  autoTilt: false, // no resting-pitch morphs on the Sun — zooming keeps your angle
  tint: [1.35, 0.82, 0.38], // warm gold — blue cut hard so bright ridges stay amber, not clipped white
  modes: [[50, 'SURFACE'], [1500, 'CORONA'], [12000, 'ORBIT'], [Infinity, 'DEEP SPACE']],
  view: { lat: 15, lon: 0, altitude: ALT_START, tilt: TILT_START, heading: 0 },
  orbit: null, // heliocentric origin — the ephemeris treats 'sun' as [0,0,0]
});
const REGISTRY = [EARTH, MOON, MARS, VENUS, MERCURY, CERES, VESTA, ENCELADUS, PLUTO, CHARON, SUN];

let active = EARTH;
let timeSpeed = 1000;        // × real time
let simTimeSec = 0.0;       // accumulated simulated seconds

// Ephemeris time: real wall-clock epoch captured at startup.
// Each frame: jd = toJD(simEpochMs + simTimeSec * 1000), so at 1000× time speed
// a real second advances the sim by 1000 s, sweeping the true orbital configuration.
const simEpochMs = Date.now();

// Distance of sky markers from the planet centre in world units.
// Must be < Z_FAR (200 000) and >> R_WORLD (6 000) so markers stay in view.
const MARKER_DIST = 120_000;

// Marker-only entries for bodies that are not (yet) explorable planets.
// Format matches the fields that updateBodyMarker and the widget loop actually
// use: id, name, color. (Empty now that the Sun is a full Body — kept as the
// seam for future non-landable markers, e.g. Jupiter.)
const MARKER_ONLY = [];

// ── Input state ───────────────────────────────────────────────────────────────
let dragActive = false, dragTurn = false;
let dragHitPt = null, dragStartWorld = null;
let dragCam = null, dragPlanetRot = 0; // camera FROZEN at mousedown — see beginDrag
let prevX = 0, prevY = 0;
let rightDragActive = false, rdStartX = 0, rdStartY = 0, rdStartTilt = 0, rdStartHeading = 0;
let lastPinchDist = 0;
let twoCX = 0, twoCY = 0; // last two-finger centroid — pan → tilt/heading (like right-drag)

// ── Camera-specific helpers (use the camera constants above) ──────────────────
function pixelRay(px, py, cw, ch, aspect, camFwd, camUp) {
  const tanH = Math.tan(FOV_Y/2), ndcX=(px/cw)*2-1, ndcY=1-(py/ch)*2;
  const right = normalize(cross(camFwd, camUp));
  return normalize(add(add(camFwd, scale(right, ndcX*aspect*tanH)), scale(camUp, ndcY*tanH)));
}
// Project a world point through a column-major mvp → screen px, or null if behind/way off.
function projectToScreen(p, mvp, cw, ch) {
  const x=p[0], y=p[1], z=p[2];
  const cx = mvp[0]*x + mvp[4]*y + mvp[8]*z + mvp[12];
  const cy = mvp[1]*x + mvp[5]*y + mvp[9]*z + mvp[13];
  const cwc = mvp[3]*x + mvp[7]*y + mvp[11]*z + mvp[15];
  if (cwc <= 0) return null;
  const ndcX = cx/cwc, ndcY = cy/cwc;
  if (ndcX < -1.2 || ndcX > 1.2 || ndcY < -1.2 || ndcY > 1.2) return null;
  return [(ndcX*0.5+0.5)*cw, (1-(ndcY*0.5+0.5))*ch];
}

function veForAlt(alt) {
  const t = Math.max(0, Math.min(1, (alt-100)/(5000-100)));
  return 2.75 + (14.0-2.75)*t*t*(3-2*t);
}

// Terrain elevation (meters) directly under a lat/lon, read from the body's int16
// heightfield in WASM memory (nearest sample). row 0 = +90 N, col 0 = -180 W.
// Uses b.gridW/b.gridH — the CURRENT tier's dims — not the full meta dims.
function sampleElevM(b, latDeg, lonDeg) {
  if (!b.hfPtr || !wasmMem || !b.gridW || !b.gridH) return 0;
  const w = b.gridW, h = b.gridH;
  // Fractional grid coordinates + BILINEAR interpolation of the 4 surrounding nodes, so the
  // terrain-follow clearance is a continuous function of position — nearest-node sampling
  // made the camera step/judder cell-to-cell as the sub-point moved.
  const rf = (90 - latDeg) / 180 * (h - 1);
  const cf = ((((lonDeg + 180) % 360) + 360) % 360) / 360 * (w - 1);
  let r0 = Math.floor(rf); const fr = rf - r0;
  r0 = r0 < 0 ? 0 : r0 >= h - 1 ? h - 2 : r0;
  const r1 = r0 + 1;                          // latitude clamps at the poles
  let c0 = Math.floor(cf); const fc = cf - c0;
  c0 = ((c0 % w) + w) % w;
  const c1 = (c0 + 1) % w;                    // longitude wraps
  // Fresh view each call (cheap, O(1)) so a WASM-memory grow can't leave a stale buffer.
  const hf = new Int16Array(wasmMem.buffer, b.hfPtr, w * h);
  const v00 = hf[r0 * w + c0], v01 = hf[r0 * w + c1];
  const v10 = hf[r1 * w + c0], v11 = hf[r1 * w + c1];
  const top = v00 + (v01 - v00) * fc;
  const bot = v10 + (v11 - v10) * fc;
  return top + (bot - top) * fr;
}

// ── Camera ────────────────────────────────────────────────────────────────────
// Depth range scales with altitude. A fixed 1 … 200 000 range clipped the globe away
// entirely above ~194 000 wu, which is well inside the system-view pull-back — the globe
// has to survive out to SYS_FADE_END (1.5 M wu) for the zoom-out to read as continuous.
// Both ends scale together so the near/far ratio (and therefore depth precision) stays put.
function depthRange(altitude, camR) {
  return [Math.max(1, altitude * 0.02), Math.max(Z_FAR, camR * 2.5)];
}

function _buildCamMvp(pos, tiltR, headR, aspect, zNear = Z_NEAR, zFar = Z_FAR) {
  const radial = normalize(pos);
  const northRaw = [0, 1, 0];
  const northProj = sub(northRaw, scale(radial, dot(northRaw, radial)));
  const northLen = Math.hypot(...northProj);
  const northDir = northLen < 0.01 ? normalize(cross(radial, [1,0,0])) : normalize(northProj);
  const eastDir = normalize(cross(northDir, radial));
  const headFwd = add(scale(northDir, Math.cos(headR)), scale(eastDir, Math.sin(headR)));
  const safeTilt = Math.max(TILT_MIN, Math.min(TILT_HOP_MAX, tiltR));
  const nadir = scale(radial, -1);
  const lookDir = normalize(add(scale(nadir, Math.cos(safeTilt)), scale(headFwd, Math.sin(safeTilt))));
  const upRaw = sub(radial, scale(lookDir, dot(radial, lookDir)));
  const up = Math.hypot(...upRaw) < 0.001 ? scale(headFwd,-1) : normalize(upRaw);
  const right = normalize(cross(lookDir, up));
  const view = mat4LookAt(pos, add(pos, scale(lookDir, 10000)), up);
  const proj = mat4Perspective(FOV_Y, aspect, zNear, zFar);
  return { lookDir, up, right, mvp: mat4Mul(proj, view) };
}

// Satellite camera over the active body's view state. As planetRot grows the camera
// follows its geographic point (geostationary) while the rest of the body rotates under
// it; starMvp uses the inertially-fixed direction so the starfield stays world-locked.
function computeCamera(aspect) {
  const { gpos, altitude, tilt, heading, planetRot } = active.view;
  // trueShape bodies pin ve so rendered radial deviations equal true proportions.
  // fixedVe = 8 × elevScale_m × (R_WORLD / radiusM) / vertScale
  // (derivation: bulge_wu = raw × vertScale × (ve/8); true bulge = raw × elevScale_m × R_WORLD/radiusM;
  //  equate → fixedVe = 8 × elevScale_m × (R_WORLD/radiusM) / vertScale)
  // We derive once from meta+handle when both are available and cache on the body object.
  let ve;
  if (active.trueShape) {
    if (active._fixedVe === undefined && active.meta && active.handle) {
      const elevScaleM = active.meta.elev_scale_m ?? 1;
      active._fixedVe = VERT_EXAGGERATION * elevScaleM * (R_WORLD / active.radiusM) / active.handle.vertScale;
    }
    ve = active._fixedVe ?? veForAlt(altitude);
  } else {
    ve = veForAlt(altitude) * active.veFactor;
  }
  // Terrain-follow: at low altitude `altitude` is clearance ABOVE the local ground (AGL),
  // so the camera rides over the rendered relief and never sinks into a peak (e.g. Olympus
  // Mons). The contribution fades out by ~ATMO altitude so orbit/deep-space stay
  // reference-sphere-relative (no globe "breathing"). terrainWu matches the shader's
  // sphere_point_scaled bulge: elev_m · vertScale · (ve / VERT_EXAGGERATION).
  // Sample at the camera's WORLD direction (gpos rotated by -planetRot) — the terrain is
  // painted at fixed world longitudes, so as the body rotates the sub-point is lon-planetRot.
  const worldDir = rotateY(gpos, -planetRot);
  const [latD, lonD] = vec3ToLatLon(worldDir);
  groundElevM = sampleElevM(active, latD, lonD); // real terrain elevation (m) under the camera
  const terrainWu = groundElevM * (active.handle?.vertScale ?? 0) * (ve / VERT_EXAGGERATION);
  // Terrain-follow is a SURFACE-mode-only convenience (keep the camera above peaks when skimming).
  // Fade it out by the surface→atmo boundary so ATMO/ORBIT stay purely reference-sphere-relative.
  const surfCeil = active.modes[0][0];
  const follow = Math.max(0, Math.min(1, (surfCeil - altitude) / (surfCeil * 0.6))); // 1 at ≤40% ceil → 0 at ceil
  // Only ride UP over peaks (max with 0); over basins stay reference-relative so the camera
  // never drops below the reference sphere (which would break the trackball ray-cast).
  // Terrain-follow fades out by the SURFACE ceiling, which assumes relief is small next
  // to the altitude bands. True for Earth; false for the small irregular bodies, where the
  // bulge can exceed the whole SURFACE band (Vesta reaches +18 km on a 262 km radius) and
  // the camera ended up *inside* the ridgelines. Floor the radius so there is always
  // clearance, whatever the follow term is doing. The max() only bites when we would
  // otherwise be underground, so framing everywhere else is untouched.
  const MIN_CLEARANCE_WU = 2;
  const camR = Math.max(
    R_WORLD + Math.max(0, terrainWu) * follow + altitude,
    R_WORLD + Math.max(0, terrainWu) + MIN_CLEARANCE_WU,
  );

  const pos = scale(worldDir, camR);
  const [zNear, zFar] = depthRange(altitude, camR);
  const { lookDir, up, right, mvp } = _buildCamMvp(pos, tilt, heading, aspect, zNear, zFar);
  const fixedPos = scale(gpos, camR);
  const { mvp: starMvp } = _buildCamMvp(fixedPos, tilt, heading, aspect, zNear, zFar);
  return { pos, fwd: lookDir, up, right, mvp, starMvp, ve, altWu: altitude };
}

function makeProxy(cam) {
  return {
    view_proj:       () => cam.mvp,
    camera_position: () => new Float32Array(cam.pos),
    cam_forward:     () => new Float32Array(cam.fwd),
    current_ve:      () => cam.ve,
    star_view_proj:  () => cam.starMvp,  // inertially-fixed: stars don't rotate with the body
    explore_alt:     () => cam.altWu,    // triggers uniform LOD in the renderer
  };
}

// ── HUD ───────────────────────────────────────────────────────────────────────
const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];
// LOD indicator: its own line under TIME, breathing (CSS) so a background fetch reads as
// activity. A 20-dot bar driven by real bytes — an animated placeholder was tried first and
// dropped, since the fetch already reports progress and a real bar says more.
const LOD_BAR_W = 20;
// How long a "complete" line stays up after the fetch finishes.
const LOD_DONE_MS = 2200;
// Tier names on screen. Internally the finest tier is 'full'; shown as d1 so the three read
// as one series with the d16 / d4 mips instead of two naming schemes.
const LOD_WORD = { d4: 'd4', full: 'd1' };
// id -> { word, until } for the lingering completion line.
const lodDone = {};
// The background coarse-tier warm-up, surfaced on the same HUD line: { name, frac } | null.
let preloadStatus = null;
// Set when the warm-up queue drains, so the line signs off instead of just vanishing.
let preloadDoneUntil = 0;
const PRELOAD_DONE_MS = 3500;

const lodBar = frac => {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * LOD_BAR_W);
  return `[${'.'.repeat(n)}${' '.repeat(LOD_BAR_W - n)}]`;
};

function lodText(active, nowMs) {
  const label = lodLabel[active.id];
  if (label) return `Loading ${LOD_WORD[label] ?? label} ${lodBar(lodProgress[active.id] ?? 0)}`;
  const done = lodDone[active.id];
  if (done && nowMs < done.until) return `Loading ${done.word} complete`;
  // Nothing for the body you are on, so report the background warm-up instead. Named,
  // because unlike the active body's tiers it is not obvious what is loading.
  if (preloadStatus) return `Loading ${preloadStatus.name} d16 ${lodBar(preloadStatus.frac)}`;
  if (nowMs < preloadDoneUntil) return 'Loaded all bodies coarse data';
  return '';
}

function hudText() {
  const { gpos, altitude, tilt, heading } = active.view;
  const [latD, lonD] = vec3ToLatLon(gpos);
  const altKm = Math.round(altitude * active.mPerWu / 1000);
  const ns = latD >= 0 ? 'N' : 'S', ew = lonD >= 0 ? 'E' : 'W';
  const normLon = ((lonD%360)+360)%360;
  const dispLon = normLon > 180 ? normLon-360 : normLon;
  const spd = timeSpeed === 0 ? '⏸' : timeSpeed < 1 ? timeSpeed+'×' : timeSpeed >= 1000 ? (timeSpeed/1000).toFixed(0)+'k×' : timeSpeed+'×';
  const headDeg = ((heading*180/Math.PI)%360+360)%360;
  const compassIdx = Math.round(headDeg/45) % 8;
  // Ground elevation under the camera (human-readable metres): +21 km at Olympus Mons, −5 km in a basin.
  // For Vesta (elev_scale_m: 2) the raw int16 values are in 2 m units, so we scale the DISPLAYED
  // value by elev_scale_m to recover real metres. We do NOT scale sampleElevM/terrain-follow —
  // the rendered sphere bulge uses raw int16 as-is, so camera clearance must stay in raw units
  // to match the visuals; only the human-facing km number gets the scale factor.
  const elevScaleM = active.meta?.elev_scale_m ?? 1;
  const gndKm = (groundElevM * elevScaleM) / 1000;
  const gnd = `${gndKm >= 0 ? '+' : '−'}${Math.abs(gndKm).toFixed(1)} km`;
  return `${active.name} · ${active.modeFor(altitude)}`
    + `\n${Math.abs(latD).toFixed(2)}°${ns} ${Math.abs(dispLon).toFixed(2)}°${ew} · GND ${gnd}`
    + `\nALT ${altKm.toLocaleString()} km · TILT ${Math.round(tilt*180/Math.PI)}° · HDG ${COMPASS[compassIdx]}`
    + `\nTIME ${spd}`;
}

// Sky marker world position for a body, computed from real Keplerian ephemeris.
// dir = bodySkyDirection(active body, target body, jd) gives a unit vector in the
// observer's render frame; we scale it to MARKER_DIST (inside Z_FAR).
// The active body is passed in so this can be called for both REGISTRY bodies and
// MARKER_ONLY entries (like the Sun) without any special-casing.
function bodySkyMarkerPos(targetId, jd) {
  const dir = bodySkyDirection(active.id, targetId, jd, OBLIQUITY[active.id] ?? 0);
  return scale(dir, MARKER_DIST);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const canvas = document.getElementById('c');
  // Overlays attach to the canvas's container, so they follow it when it is windowed.
  const host = canvas.parentElement || document.body;
  const showErr = (detail) => {
    document.getElementById('loading').style.display = 'none';
    const el = document.getElementById('nowgpu');
    if (detail) {
      el.innerHTML = 'Explore mode couldn\'t start on this device.<br>'
        + `<span style="opacity:0.6; font-size:12px">${String(detail)}</span>`;
    }
    el.style.display = 'block';
  };

  if (!navigator.gpu) { showErr('This browser exposes no WebGPU (navigator.gpu is undefined).'); return; }

  // Tiered loading: fetch d16 for EARTH only, build engine+renderer, show first frame,
  // then refine d4 → full in background. Other bodies load on demand (jumpTo).
  const loadfill = document.getElementById('loadfill');
  const loadpct = document.getElementById('loadpct');
  const trackProgress = _makeProgress(loadfill, loadpct);

  let renderer;
  let Engine;
  try {
    // Fetch Earth meta (small JSON) + d16 heightfield in parallel.
    const [earthMeta, d16Resp] = await Promise.all([
      fetch(EARTH.metaUrl).then(r => r.json()),
      cachedFetch(tierUrl(EARTH, 16), (loaded, total) => trackProgress('earth_d16', loaded, total)),
    ]);
    EARTH.meta = earthMeta;
    const d16Buf = await d16Resp.arrayBuffer();

    if (loadpct) loadpct.textContent = 'initializing renderer…';

    // Init WASM + renderer with Earth d16 so we can show something immediately.
    const { default: initWasm, Engine: EngineClass } = await import('./pkg/ridgeline_core.js');
    const wasm = await initWasm();
    wasmMem = wasm.memory;
    Engine = EngineClass;

    const { w: d16W, h: d16H } = tierDims(earthMeta, 16);
    const { bbox } = earthMeta;
    const earthD16Engine = new Engine(d16W, d16H, new Uint8Array(d16Buf),
      earthMeta.elev_max, bbox.lat_min, bbox.lat_max, bbox.lon_min, bbox.lon_max);

    renderer = await WebGPURenderer.create(canvas, earthD16Engine, wasmMem);
    const earthD16Handle = renderer.activeBody;
    earthD16Handle.elevMinWu = (earthMeta.elev_i16_min ?? earthMeta.elev_min) * earthD16Handle.vertScale;
    earthD16Handle.hasOcean = EARTH.hasOcean;

    EARTH.engine = earthD16Engine;
    EARTH.handle = earthD16Handle;
    EARTH.tier = 16;
    EARTH.gridW = d16W;
    EARTH.gridH = d16H;
    EARTH.hfPtr = earthD16Engine.heightfield_i16_ptr();
    renderer.useBody(EARTH.handle);

  } catch (e) { console.error('[explore] init:', e); showErr(e.message); return; }

  // ── Background refinement machinery ──────────────────────────────────────────
  // Mobile memory guard: the full-res Earth heightfield is 151 MB on the GPU plus ~151 MB
  // in WASM memory (~308 MB heap observed), for ~271 MB GPU total. On constrained devices
  // (phones with ≤ 4 GB RAM or adapters with small maxBufferSize) we cap refinement at d4
  // (~9 MB GPU HF, ~129 MB GPU total) to prevent tab-kills. The d4 tier still renders
  // recognizable continents and satisfying terrain detail.
  // Heuristic: navigator.deviceMemory < 4 (Chrome/Edge only; undefined → unconstrained)
  // OR adapter.maxBufferSize < 256 MB (proxy for an integrated/mobile GPU limit).
  const _adapterMaxBuf = renderer.adapterLimits?.maxStorageBufferBindingSize ?? Infinity;
  const _deviceMemGb = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : Infinity;
  const _constrainedDevice = _deviceMemGb < 4 || _adapterMaxBuf < 256 * 1024 * 1024;
  if (_constrainedDevice) {
    console.log(`[explore] constrained device (deviceMemory=${_deviceMemGb} GB, adapterMaxBuf=${(_adapterMaxBuf/1e6).toFixed(0)} MB) — capping refinement at d4`);
  }

  // refineBody: fetch d4 then full for a body, upgrading the tier atomically each time.
  // If the body is not active when a tier arrives, we still upgrade its stored state
  // (so it's ready for future jumpTo), but skip renderer.useBody. Non-active bodies
  // are CANCELLED at demotion time (see demoteBody) — we use an abort token per body.
  // Choice: cancel refinement for NON-ACTIVE bodies when jumping away — simpler than
  // finishing a download only to demote it immediately after.
  const refineTokens = new Map(); // b.id → { cancelled: bool }

  async function refineBody(b, tiers) {
    // Issue (or re-issue) a refinement chain for b starting at d4, then full.
    // Cancels any previous in-flight chain for this body.
    // On constrained devices, stop at d4 (skip the 151 MB full-res upgrade).
    const token = { cancelled: false };
    refineTokens.set(b.id, token);

    // Full-res is never fetched eagerly: callers ask for [4] on arrival and the frame
    // loop asks for [1] only once the camera actually descends.
    const chain = tiers ?? (_constrainedDevice ? [4] : [4, 1]);
    for (const f of chain) {
      if (token.cancelled) break;
      if (b.tier !== 0 && f >= b.tier) continue; // already at this resolution or finer

      const label = f === 1 ? 'full' : `d${f}`;
      const isActive = () => active === b;

      // Show refinement indicator in HUD only while this body is active.
      if (isActive()) lodLabel[b.id] = label;

      try {
        const resp = await cachedFetch(tierUrl(b, f),
          isActive()
            ? (loaded, total) => {
                trackProgress(`${b.id}_${label}`, loaded, total);
                lodProgress[b.id] = total > 0 ? loaded / total : 0;
              }
            : null);
        if (token.cancelled) break;

        const buf = await resp.arrayBuffer();
        if (token.cancelled) break;

        _applyTier(b, f, buf, b.meta, Engine, renderer, isActive());
        if (isActive()) {
          // Clear the in-flight label and leave a completion line up briefly, so a fast
          // tier still registers as having happened.
          lodLabel[b.id] = null;
          lodProgress[b.id] = 0;
          lodDone[b.id] = { word: LOD_WORD[label] ?? label, until: performance.now() + LOD_DONE_MS };
        }
        console.log(`[explore] ${b.name} upgraded to tier ${f === 1 ? 'full' : `d${f}`} (${b.gridW}×${b.gridH})`);
      } catch (e) {
        if (!token.cancelled) console.warn(`[explore] tier ${f} failed for ${b.name}:`, e);
        break;
      }
    }

    if (active === b) { lodLabel[b.id] = null; lodProgress[b.id] = 0; }
  }

  // Demote a body from tier 4/1 back to tier 16 to reclaim GPU/WASM memory.
  // The d16 data is always in the Cache API after startup, so this is near-instant.
  async function demoteBody(b) {
    if (b.tier <= 16) return; // already coarse or unloaded
    const token = { cancelled: false };
    refineTokens.set(b.id, token); // cancels any in-flight refinement for this body
    try {
      const resp = await cachedFetch(tierUrl(b, 16), null);
      if (token.cancelled) return; // jumped back while demoting — let new chain handle it
      const buf = await resp.arrayBuffer();
      if (token.cancelled) return;
      _applyTier(b, 16, buf, b.meta, Engine, renderer, false); // never active (we just left it)
      console.log(`[explore] ${b.name} demoted to d16`);
    } catch (e) { console.warn(`[explore] demote failed for ${b.name}:`, e); }
  }

  // Kick off background refinement for active body (Earth) now that d16 is showing.
  // Metas for Moon/Mars are fetched lazily on first jumpTo.
  refineBody(EARTH, [4])
    .catch(e => console.warn('[explore] EARTH refine:', e))
    .finally(() => preloadCoarse());

  // The backing store is sized in DEVICE pixels, the canvas itself stays 100vw/100vh
  // CSS px. Everything that talks to the pointer or to the DOM (rays, marker
  // placement, aspect) uses cssW/cssH; only the renderer sees the device-pixel size.
  // Capped at 2 — an uncapped 2.625 costs ~1.7× the fill rate for no visible gain.
  const DPR_MAX = 2;
  // Size from the canvas's own box so the app can live in a windowed container as well
  // as full-screen; full-screen is the same numbers, since there the canvas IS the viewport.
  let cssW = canvas.clientWidth || window.innerWidth;
  let cssH = canvas.clientHeight || window.innerHeight;
  function resize() {
    cssW = canvas.clientWidth || window.innerWidth;
    cssH = canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(DPR_MAX, window.devicePixelRatio || 1);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    renderer.resize(canvas.width, canvas.height, cssH);
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(canvas);
  resize();

  // Time speed buttons
  document.querySelectorAll('.tb').forEach(btn => {
    btn.addEventListener('click', () => {
      timeSpeed = parseFloat(btn.dataset.s);
      document.querySelectorAll('.tb').forEach(b => b.classList.toggle('on', b === btn));
    });
  });

  // ── Per-body sky markers: on-screen dot (click to jump) or off-screen edge arrow ──
  // ALL_MARKERS = explorable bodies (REGISTRY) + any marker-only entries (MARKER_ONLY,
  // currently empty: the Sun became a full Body when the magnetogram bake landed).
  // updateBodyMarker uses only id/name/color + computed position — safe to mix both kinds.
  const ALL_MARKERS = [...REGISTRY, ...MARKER_ONLY];
  const widgets = new Map();
  for (const b of ALL_MARKERS) {
    const marker = document.createElement('div');
    marker.style.cssText = 'position:absolute; display:none; transform:translate(-50%,-50%); cursor:pointer;'
      + ' font:11px monospace; text-align:center; pointer-events:none; user-select:none; z-index:5;';
    marker.innerHTML = '<div class="dot"></div><div class="lbl"></div>';
    host.appendChild(marker);
    const dot = marker.querySelector('.dot');
    const lbl = marker.querySelector('.lbl');
    dot.style.cssText = 'width:14px; height:14px; border-radius:50%; margin:0 auto 3px;'
      + ` border:1px solid #fff; box-shadow:0 0 8px rgba(255,255,255,0.4); background:${b.color};`;
    lbl.style.color = b.color;
    lbl.textContent = '▸ ' + b.name;

    const arrow = document.createElement('div');
    arrow.style.cssText = 'position:absolute; display:none; transform:translate(-50%,-50%);'
      + ' cursor:pointer; text-align:center; z-index:5; pointer-events:none; user-select:none;'
      + ' text-shadow:0 0 6px rgba(0,0,0,0.9);';
    arrow.innerHTML = '<span class="chev">➤</span><span class="albl"></span>';
    host.appendChild(arrow);
    const chev = arrow.querySelector('.chev');
    const albl = arrow.querySelector('.albl');
    chev.style.cssText = `display:inline-block; font-size:20px; line-height:1; color:${b.color};`;
    albl.style.cssText = `display:block; font:10px monospace; margin-top:2px; color:${b.color};`;

    widgets.set(b.id, { marker, arrow, chev, lbl, albl });
  }

  // ── Sky-marker hit testing ────────────────────────────────────────────────
  // The markers are pure visuals (pointer-events:none). They used to be clickable
  // divs layered over the canvas with no touch listeners of their own, so a touch
  // starting on one never reached the canvas — no preventDefault, no drag-rotate
  // until you lifted and re-touched. Taps are resolved here instead, against the
  // placements recorded by the last frame, so every touch reaches the canvas.
  const MARKER_HIT_R = 22; // CSS px — a 44x44 target around the marker centre
  let markerHits = [];
  function markerAt(x, y) {
    // Enlarged targets overlap (Charon sits on Pluto), so the nearest centre wins
    // rather than DOM order — same rule as the SYSTEM view's hitTest.
    let best = null, bestD = Infinity;
    for (const p of markerHits) {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d <= MARKER_HIT_R && d < bestD) { bestD = d; best = p.b; }
    }
    return best;
  }

  // Warm every body's coarse tier in the background, nearest first.
  //
  // Without this, the first click on an unvisited body dropped a loading splash over the
  // hop: jumpTo had to fetch its meta + d16 before it could show anything. All eleven d16
  // tiers together are ~4 MB, so the whole set costs less than one body's d4 — cheap
  // enough to just have, and it makes every hop instant.
  //
  // Sequential on purpose: these are background fetches and must not compete with the
  // active body's d4/d1 for bandwidth.
  async function preloadCoarse() {
    const jd = toJD(simEpochMs + simTimeSec * 1000);
    const here = helioPos(active.id, jd);
    const dist = b => {
      const p = helioPos(b.id, jd);
      return Math.hypot(p[0] - here[0], p[1] - here[1], p[2] - here[2]);
    };
    const queue = REGISTRY.filter(b => b !== active && b.tier === 0).sort((a, b) => dist(a) - dist(b));
    for (const b of queue) {
      if (b.tier !== 0) continue;               // a jump may have loaded it meanwhile
      try {
        preloadStatus = { name: b.name, frac: 0 };
        if (!b.meta) b.meta = await fetch(b.metaUrl).then(r => r.json());
        const resp = await cachedFetch(tierUrl(b, 16),
          (loaded, total) => { if (preloadStatus) preloadStatus.frac = total > 0 ? loaded / total : 0; });
        const buf = await resp.arrayBuffer();
        if (b.tier !== 0) continue;
        _applyTier(b, 16, buf, b.meta, Engine, renderer, false);
      } catch (e) {
        console.warn(`[explore] preload ${b.name}:`, e);        // one failure must not stop the queue
      }
    }
    preloadStatus = null;
    // Every marker is now on screen and every hop instant — worth saying once.
    if (queue.length) preloadDoneUntil = performance.now() + PRELOAD_DONE_MS;
  }

  // Enter a body from the orrery: shared by the SYSTEM view's own click handling and by
  // the tap fallback, so both take the identical path.
  function enterFromSystem(bodyId) {
    const targetBody = REGISTRY.find(b => b.id === bodyId);
    if (!targetBody) return;
    const arrive = () => arriveAt(targetBody);
    // Re-entering the body you departed from is the natural "go back": jumpTo would
    // no-op on it, so reset the framing here and take the same arrival glide.
    if (targetBody === active) {
      targetBody.resetView();
      dragActive = false; rightDragActive = false;
      arrive();
      return;
    }
    jumpTo(targetBody).then(arrive)
      .catch(e => console.warn('[explore] system onEnterBody:', e));
  }

  // Glide down to a body's canonical framing: the zoom-out played backwards. Shared by
  // the SYSTEM map and by sky-marker hops, which start closer in.
  //
  function arriveAt(b, from = SYS_FADE_END * 0.9) {
    if (active !== b) return;
    const dest = b.view.altitude;            // canonical framing set by resetView()
    b.view.altitude = from;
    altGlide = { body: b, dest };
  }

  // Sky-marker hop, in three acts: turn to face the target, then a single eased move
  // that accelerates away and decelerates into arrival.
  //
  //   TURN     slew heading so the target sits dead ahead. The marker's screen position
  //            from the last frame gives the bearing directly: horizontal offset from
  //            centre, scaled by the horizontal half-FOV.
  //   TRAVEL   swap bodies, then ease altitude from HOP_START down to the canonical
  //            framing on a smootherstep. The old exponential ease was fastest on its
  //            first frame and decayed, which is backwards — it read as a jump cut on a
  //            short trip like Earth to the Moon.
  //
  // HOP_START sits at the system-fade floor, so sysT stays 0 and the hop never routes
  // out through the orrery. Raise it toward SYS_FADE_END for more pull-back.
  const HOP_START     = SYS_FADE_START;
  const HOP_TURN_MS   = 1200;  // the swing round to face the target
  const HOP_HOLD_MS   = 650;   // a beat on the target before departing
  const HOP_FADE_MS   = 260;   // dip to black across the body swap
  const HOP_TRAVEL_MS = 1100;  // the flight in
  // smootherstep: zero velocity AND zero acceleration at both ends, so the departure
  // eases in rather than snapping to full speed.
  const smoother = t => t * t * t * (t * (t * 6 - 15) + 10);
  const easeOut  = t => 1 - (1 - t) ** 3;          // fastest at the start, 0 velocity at the end

  let hop = null;        // { phase, t, fromH, toH, fromT, toT, target, startAlt, dest }
  let tiltRelax = false; // true while tilt is above the mode ceiling and easing back

  // Where to point to look AT a body, inverted from the camera's own construction in
  // _buildCamMvp: lookDir = nadir·cos(tilt) + headFwd·sin(tilt), with headFwd spanning
  // north/east in the tangent plane.
  //
  // This replaces an earlier screen-space version that derived the turn from the marker's
  // pixel offset. That was wrong in principle: tilt is measured off NADIR, so in deep
  // space the camera sits ~3° (straight down at the globe) while the body is near the
  // horizon. A marker 18° off screen-centre is nowhere near 18° off the true direction,
  // so the camera barely pitched and it read as pure yaw.
  function aimAt(b) {
    const jd = toJD(simEpochMs + simTimeSec * 1000);
    const dir = bodySkyDirection(active.id, b.id, jd, OBLIQUITY[active.id] ?? 0);
    const radial = normalize(rotateY(active.view.gpos, -active.view.planetRot));
    const nadir = scale(radial, -1);

    const cosT = Math.max(-1, Math.min(1, dot(dir, nadir)));
    const tilt = Math.acos(cosT);                    // 0 = straight down, π/2 = horizon

    let heading = active.view.heading;
    const tang = sub(dir, scale(nadir, cosT));       // component in the tangent plane
    const len = Math.hypot(...tang);
    if (len > 1e-6) {
      const f = scale(tang, 1 / len);
      const northRaw = [0, 1, 0];
      const northProj = sub(northRaw, scale(radial, dot(northRaw, radial)));
      const northDir = Math.hypot(...northProj) < 0.01
        ? normalize(cross(radial, [1, 0, 0]))
        : normalize(northProj);
      const eastDir = normalize(cross(northDir, radial));
      heading = Math.atan2(dot(f, eastDir), dot(f, northDir));
    }
    return { heading, tilt };
  }

  // Shortest way round: turning 350° the long way is never what you want.
  const shortestTurn = (from, to) => from + ((to - from + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  function hopTo(b) {
    if (b === active || hop) return;
    // The aim-turn is only meaningful while the globe's sky markers are still drawn: those
    // carry true directions. Past MARKER_FADE_T only the orrery's dots remain, and they sit at
    // log-compressed positions with no relation to where the body actually is — turning to
    // face one aimed the camera at empty space. There, take the straight arrival instead.
    if (sysT > MARKER_FADE_T) { enterFromSystem(b.id); return; }
    altGlide = null;                        // the hop drives altitude itself
    const v = active.view;
    const aim = aimAt(b);
    active._autoTilt = false;          // the hop owns pitch for its duration
    hop = {
      phase: 'turn', t: 0, target: b,
      fromH: v.heading, toH: shortestTurn(v.heading, aim.heading),
      fromT: v.tilt,    toT: Math.max(TILT_MIN, Math.min(TILT_HOP_MAX, aim.tilt)),
      startAlt: HOP_START,
    };
  }

  // Advance the hop. Called once per frame with dt in seconds.
  function stepHop(dt) {
    if (!hop) return;
    if (hop.phase === 'turn') {
      hop.t += dt * 1000;
      const k = Math.min(1, hop.t / HOP_TURN_MS);
      const e = smoother(k);
      active.view.heading = hop.fromH + (hop.toH - hop.fromH) * e;
      active.view.tilt    = hop.fromT + (hop.toT - hop.fromT) * e;
      if (k < 1) return;
      // Hold the aim for a beat before departing: the turn has just found the body and
      // it deserves a moment on screen. Still on the departing body here — the swap is
      // deliberately after the hold, so what you pause on is the target in this sky.
      hop.phase = 'hold'; hop.t = 0;
      return;
    }
    if (hop.phase === 'hold') {
      hop.t += dt * 1000;
      if (hop.t < HOP_HOLD_MS) return;
      // The swap is a cut: one frame you are in this body's sky, the next you are far
      // above another. Travelling the gap physically just reinstates the zoom-out. Dip
      // through black across the cut instead — short enough to read as a transition
      // rather than a scene change.
      hop.phase = 'fade'; hop.t = 0;
      return;
    }
    if (hop.phase === 'fade') {
      hop.t += dt * 1000;
      hop.fade = Math.max(0, 1 - hop.t / HOP_FADE_MS);   // 1 -> 0
      if (hop.t < HOP_FADE_MS) return;
      hop.phase = 'loading'; hop.t = 0;
      // Capture the hop this swap belongs to. Testing the module-level `hop` in the
      // callbacks was wrong: cancel mid-flight (wheel nulls it) then start a second hop, and
      // the first jumpTo's resolution would yank the NEW hop from 'turn' straight into
      // 'travel' with no dest set — altitude became NaN and poisoned sysT and the camera.
      const h = hop;
      const target = h.target;
      const p = jumpTo(target);
      // Synchronously, NOT in .then(): jumpTo runs resetView() before any await, so the
      // canonical altitude is already set and `active` may swap within this same frame.
      // Deferring the pull-back by even one frame rendered the new body at full size
      // before the descent began.
      const dest = target.view.altitude;
      h.dest = dest;
      target.view.altitude = h.startAlt;
      const settle = () => {
        if (hop !== h) {
          // Cancelled (wheel/pinch) while the swap was in flight. We parked the target at
          // HOP_START for an arrival that is no longer coming; put it back.
          if (active === target) target.view.altitude = dest;
          return;
        }
        // jumpTo swallows fetch failures and still resolves, so without this check a failed
        // load would fly the body we never left down to the target's framing.
        if (active !== target) { hop = null; return; }
        h.phase = 'travel'; h.t = 0;
      };
      p.then(settle).catch(e => {
        console.warn('[explore] hop:', e);
        if (hop === h) hop = null;
      });
      return;
    }
    if (hop.phase === 'travel') {
      hop.t += dt * 1000;
      const k = Math.min(1, hop.t / HOP_TRAVEL_MS);
      active.view.altitude = hop.startAlt + (hop.dest - hop.startAlt) * easeOut(k);
      hop.fade = Math.min(1, hop.t / HOP_FADE_MS);       // 0 -> 1, back up as we arrive
      if (k >= 1) { active.view.altitude = hop.dest; hop = null; }
    }
  }

  async function jumpTo(b) {
    if (b === active) return;
    const prev = active;

    // Demote the body we're leaving if it holds a fine tier (async, in background).
    if (prev.tier === 4 || prev.tier === 1) {
      demoteBody(prev).catch(e => console.warn('[explore] demote:', e));
    }

    b.resetView(); // always enter at the canonical deep-space framing

    if (b.tier === 0) {
      // Body has nothing loaded yet — show loading splash and fetch d16.
      if (!b.meta) {
        try {
          b.meta = await fetch(b.metaUrl).then(r => r.json());
        } catch (e) { console.error('[explore] meta fetch:', e); return; }
      }
      const trackD16 = _makeProgress(loadfill, loadpct);
      if (loadpct) {
        document.getElementById('loading').style.display = '';
        loadpct.textContent = `loading ${b.name}…`;
      }
      try {
        const resp = await cachedFetch(tierUrl(b, 16),
          (loaded, total) => trackD16(`${b.id}_d16`, loaded, total));
        const buf = await resp.arrayBuffer();
        _applyTier(b, 16, buf, b.meta, Engine, renderer, false);
      } catch (e) {
        console.error('[explore] jumpTo d16:', e);
        document.getElementById('loading').style.display = 'none';
        return;
      }
      document.getElementById('loading').style.display = 'none';
    }

    active = b;
    renderer.useBody(b.handle);
    dragActive = false; rightDragActive = false;

    // Refine in background from whatever tier b currently holds.
    if (b.tier > 1) {
      // Re-arm the full-res request: jumping away demotes the body to d16, so a later
      // descent must be able to ask for it again (served from the Cache API, no refetch).
      b._fullRequested = false;
      refineBody(b, [4]).catch(e => console.warn(`[explore] refine ${b.name}:`, e));
    }
  }

  const getAspect = () => cssW / cssH;
  const getCam = () => computeCamera(getAspect());

  // ── System view ─────────────────────────────────────────────────────────────
  systemView = createSystemView({
    host,
    registry: REGISTRY,
    helioPos,
    helioEcl,
    onEnterBody: enterFromSystem,
  });

  // ── Orbit drag (shared by mouse + touch), singularity-free vector math ──────
  function beginDrag(x, y) {
    // Freeze the camera + planet-rotation for the whole drag. The trackball maps the grabbed
    // surface point to the cursor; re-deriving the camera from the live (just-updated) gpos
    // each move creates a feedback loop that diverges near the poles. Referencing the frozen
    // mousedown state keeps it stable everywhere.
    const cam = getCam();
    dragCam = cam;
    dragPlanetRot = active.view.planetRot;
    const ray = pixelRay(x, y, cssW, cssH, getAspect(), cam.fwd, cam.up);
    const hit = raySphere(cam.pos, ray, R_WORLD);
    dragActive = true;
    dragTurn = !hit;
    dragHitPt = hit ? normalize(hit) : null;
    dragStartWorld = rotateY(active.view.gpos, -dragPlanetRot);
    prevX = x; prevY = y;
  }
  function moveDrag(x, y) {
    if (!dragActive) return;
    const cam = dragCam; // frozen at mousedown (no live-gpos feedback)
    const v = active.view;
    if (!dragTurn) {
      const ray = pixelRay(x, y, cssW, cssH, getAspect(), cam.fwd, cam.up);
      const hit = raySphere(cam.pos, ray, R_WORLD);
      if (hit) {
        const newDir = normalize(hit);
        const cr = cross(newDir, dragHitPt);
        const sinA = Math.min(1, Math.hypot(...cr));
        const cosA = dot(newDir, dragHitPt);
        if (sinA > 1e-4) {
          const axis = normalize(cr);
          v.gpos = clampPolar(rotateY(rodrigues(dragStartWorld, axis, Math.atan2(sinA, cosA)), dragPlanetRot));
        }
        prevX = x; prevY = y;
        return;
      }
      dragTurn = true;
    }
    const k = 0.004;
    let w = rotateY(v.gpos, -v.planetRot);
    w = rodrigues(w, cam.up, -(x - prevX) * k);
    w = rodrigues(w, cam.right, (y - prevY) * k);
    v.gpos = clampPolar(rotateY(w, v.planetRot));
    prevX = x; prevY = y;
  }

  // Drag-vs-tap for the globe view, sharing the SYSTEM view's state machine: a press
  // that moves past DRAG_SLOP or is held past CLICK_MS rotates the globe and never
  // counts as a marker tap.
  const globeGesture = createDragTap();
  function releaseGlobeGesture(x, y) {
    const r = globeGesture.release(x, y);
    if (!r.tap) return;
    const b = markerAt(r.x, r.y);
    if (b) { hopTo(b); return; }
    // Dead band: the globe's markers stop at MARKER_FADE_T, but the orrery does
    // not take pointer input until SYS_INPUT_T (0.35). In between its dots were on screen
    // and inert. Fall through so a tap always hits whatever is actually visible.
    if (sysT > MARKER_FADE_T && sysT <= SYS_INPUT_T) {
      const id = systemView.hitTest(r.x, r.y);
      if (id) enterFromSystem(id);
    }
  }

  // ── Mouse ───────────────────────────────────────────────────────────────────
  // The canvas is not necessarily at the viewport origin, so every pointer coordinate is
  // converted to canvas-local space before it reaches the camera/picking.
  const ptX = p => p.clientX - canvas.getBoundingClientRect().left;
  const ptY = p => p.clientY - canvas.getBoundingClientRect().top;
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('mousedown', e => {
    if (sysT > SYS_INPUT_T) {
      systemView.onPointerDown(ptX(e), ptY(e));
      return;
    }
    if (e.button === 2) {
      rightDragActive = true;
      rdStartX = ptX(e); rdStartY = ptY(e);
      rdStartTilt = active.view.tilt; rdStartHeading = active.view.heading;
      active._autoTilt = false; // user takes over pitch → stop the surface auto-morph
      return;
    }
    globeGesture.press(ptX(e), ptY(e));
    beginDrag(ptX(e), ptY(e));
  });
  window.addEventListener('mousemove', e => {
    if (sysT > SYS_INPUT_T) {
      systemView.onPointerMove(ptX(e), ptY(e));
      canvas.style.cursor = systemView.isHovering() ? 'pointer' : '';
      return;
    }
    canvas.style.cursor = '';
    if (rightDragActive) {
      active.view.tilt    = clampTilt(rdStartTilt - (ptY(e)-rdStartY)*0.005, active.modeFor(active.view.altitude));
      active.view.heading = rdStartHeading + (ptX(e)-rdStartX)*0.005;
      return;
    }
    globeGesture.move(ptX(e), ptY(e));
    moveDrag(ptX(e), ptY(e));
  });
  window.addEventListener('mouseup', e => {
    if (sysT > SYS_INPUT_T) { systemView.onPointerUp(ptX(e), ptY(e)); return; }
    if (e.button === 2) { rightDragActive = false; return; }
    dragActive = false;
    releaseGlobeGesture(ptX(e), ptY(e));
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    altGlide = null; hop = null; // manual zoom takes over
    const v = active.view;
    // Altitude is the single control for the whole zoom-out — it drives sysT, which drives
    // the orrery camera's pull-back. Past SYS_FADE_START the step is bigger so the retreat
    // through 1.5 M wu is FAST (~8 notches) rather than a slow grind.
    const step = v.altitude >= SYS_FADE_START ? 0.72 : 0.85;
    const altCap = v.altitude > SYS_FADE_START * 0.5 ? ALT_CAP_SYSTEM : 100_000;
    v.altitude = Math.max(2, Math.min(altCap, v.altitude * Math.pow(step, -e.deltaY / 100)));
  }, { passive: false });

  // ── Touch ───────────────────────────────────────────────────────────────────
  // Seed pinch/pan state from the first two touches. Used on every transition into
  // or within a multi-touch gesture, so a stale delta is never applied.
  function beginPinch(touches) {
    const t0 = touches[0], t1 = touches[1];
    lastPinchDist = Math.hypot(ptX(t0)-ptX(t1), ptY(t0)-ptY(t1));
    twoCX = (ptX(t0) + ptX(t1)) / 2;
    twoCY = (ptY(t0) + ptY(t1)) / 2;
  }
  function resetGestures() {
    systemView.onPointerCancel();
    globeGesture.cancel();
    lastPinchDist = 0;
    twoCX = twoCY = 0;
    dragActive = false;
    rightDragActive = false;
  }
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 1) {
      // Past the SYSTEM threshold one finger orbits the orrery instead of the globe.
      if (sysT > SYS_INPUT_T) systemView.onPointerDown(ptX(e.touches[0]), ptY(e.touches[0]), true);
      else {
        globeGesture.press(ptX(e.touches[0]), ptY(e.touches[0]), true);
        beginDrag(ptX(e.touches[0]), ptY(e.touches[0]));
      }
    } else if (e.touches.length >= 2) {
      // A second finger landing mid-rotate ends it cleanly — no tap, no jump.
      // >= 2, not === 2: with a third finger down neither branch matched, so
      // lastPinchDist went stale and releasing back to two jumped the altitude.
      systemView.onPointerCancel();
      globeGesture.cancel();
      dragActive = false;
      beginPinch(e.touches);
      active._autoTilt = false; // user takes over pitch → stop the surface auto-morph
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1) {
      if (sysT > SYS_INPUT_T) systemView.onPointerMove(ptX(e.touches[0]), ptY(e.touches[0]), true);
      else if (dragActive) {
        globeGesture.move(ptX(e.touches[0]), ptY(e.touches[0]));
        moveDrag(ptX(e.touches[0]), ptY(e.touches[0]));
      }
    } else if (e.touches.length >= 2) {
      // Two fingers do BOTH: pinch (distance) → zoom; pan (centroid move) → tilt + heading,
      // exactly like the desktop right-drag.
      const t0 = e.touches[0], t1 = e.touches[1];
      const nd = Math.hypot(ptX(t0)-ptX(t1), ptY(t0)-ptY(t1));
      const cx = (ptX(t0) + ptX(t1)) / 2, cy = (ptY(t0) + ptY(t1)) / 2;
      const v = active.view;
      // Maps convention: fingers apart (nd > last) → zoom IN = lower altitude.
      // Same dynamic cap as the wheel handler — past the SYSTEM-view threshold the
      // ceiling opens up to ALT_CAP_SYSTEM so pinch can reach the full SYSTEM view.
      const altCap = v.altitude > SYS_FADE_START * 0.5 ? ALT_CAP_SYSTEM : 100_000;
      if (lastPinchDist > 0) {
        altGlide = null; hop = null; // manual zoom takes over, same as wheel
        v.altitude = Math.max(2, Math.min(altCap, v.altitude * lastPinchDist / nd));
      }
      v.tilt    = clampTilt(v.tilt - (cy - twoCY) * 0.005, active.modeFor(v.altitude));
      v.heading = v.heading + (cx - twoCX) * 0.005;
      lastPinchDist = nd; twoCX = cx; twoCY = cy;
    }
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    const t = e.changedTouches[0];
    if (e.touches.length === 0) {
      if (t) {
        systemView.onPointerUp(ptX(t), ptY(t));
        releaseGlobeGesture(ptX(t), ptY(t));
      }
      lastPinchDist = 0;
      dragActive = false;
      return;
    }
    if (e.touches.length === 1) {
      // Dropping out of a pinch used to leave the surviving finger inert: dragActive
      // was forced false when the second finger landed and was never re-armed.
      // beginDrag re-freezes the camera at the survivor's current position, so the
      // rotation resumes from where the finger is — no jump. Never a tap.
      lastPinchDist = 0;
      if (sysT <= SYS_INPUT_T) beginDrag(ptX(e.touches[0]), ptY(e.touches[0]));
    } else {
      // 3+ fingers back down to 2 — re-seed from the survivors rather than applying
      // a delta against the distance/centroid of a finger that is already gone.
      beginPinch(e.touches);
    }
  }, { passive: false });
  // iOS fires touchcancel for the notification shade, incoming calls and edge swipes.
  // Without this every gesture variable was left stale.
  canvas.addEventListener('touchcancel', resetGestures);

  // ── Render loop ───────────────────────────────────────────────────────────
  let prev = performance.now();
  let loadingDone = false; // hide the loading overlay once the first frame has drawn
  function frame(now) {
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;

    // Fetch the full-res tier only once the camera actually descends (FULL_RES_ALT = the
    // ATMO/LOW/CORONA ceiling). Fires once per body; re-armed on jumpTo.
    if (active.view.altitude < FULL_RES_ALT && active.tier > 1 && !active._fullRequested) {
      active._fullRequested = true;
      refineBody(active, [1]).catch(e => console.warn(`[explore] full-res ${active.name}:`, e));
    }
    active.view.planetRot = (active.view.planetRot + timeSpeed * dt * active.rotDegPerSec) % 360;
    simTimeSec += timeSpeed * dt; // advance the shared simulated clock (each marker uses its own period)

    // Continuous auto-tilt: resting pitch is a smooth function of altitude (tiltRestForAlt),
    // so slow zooming produces slow tilt drift — no sudden lurch at mode boundaries.
    // Auto-tilt re-arms on the first mode change after spawn/jumpTo (so spawn framing holds).
    // It is disabled by user pitch drag (right-drag / two-finger) and re-armed on jumpTo.
    const mode = active.modeFor(active.view.altitude);
    if (active._prevMode !== undefined && mode !== active._prevMode && active.autoTilt) active._autoTilt = true;
    if (active._autoTilt) {
      const target = tiltRestForAlt(active.view.altitude, active);
      active.view.tilt += (target - active.view.tilt) * Math.min(1, dt * 1.4);
    }
    active._prevMode = mode;
    // While a hop owns the camera it may exceed the mode ceiling (see TILT_HOP_MAX). On
    // arrival, ease back into range rather than snapping — tiltRelax holds the relaxed
    // ceiling until the eased value is legal again.
    if (hop) {
      tiltRelax = true;
      active.view.tilt = Math.max(TILT_MIN, Math.min(TILT_HOP_MAX, active.view.tilt));
    } else if (tiltRelax) {
      const ceil = tiltMaxFor(mode);
      if (active.view.tilt > ceil) {
        active.view.tilt += (ceil - active.view.tilt) * Math.min(1, dt * 3.0);
        if (active.view.tilt - ceil < 0.01) { active.view.tilt = ceil; tiltRelax = false; }
      } else { tiltRelax = false; }
      active.view.tilt = Math.max(TILT_MIN, Math.min(TILT_HOP_MAX, active.view.tilt));
    } else {
      active.view.tilt = clampTilt(active.view.tilt, mode);
    }

    stepHop(dt);

    // Altitude glide: exponential ease to a target framing (~1 s). Used both ways — down
    // on arrival, and up when hopping out to system range before a body swap. The
    // completion test is symmetric: the old one-sided `< dest * 1.02` was already true on
    // the first frame of an ascending glide, which would snap instead of travelling.
    if (altGlide) {
      if (altGlide.body !== active) altGlide = null;
      else {
        const v = active.view;
        v.altitude += (altGlide.dest - v.altitude) * Math.min(1, dt * 4.5);
        if (Math.abs(v.altitude - altGlide.dest) <= altGlide.dest * 0.02) {
          v.altitude = altGlide.dest;
          const done = altGlide.onDone;
          altGlide = null;
          if (done) done();
        }
      }
    }

    const jd = toJD(simEpochMs + simTimeSec * 1000);

    // ── System mode transition ─────────────────────────────────────────────
    // sysT is driven continuously by altitude via smoothstep — no easing lag.
    // This makes the zoom directly reversible: wheel-in decreases alt → sysT falls
    // → the orrery camera flies back in and the globe grows again.
    {
      const alt = active.view.altitude;
      const u = Math.max(0, Math.min(1, (alt - SYS_FADE_START) / (SYS_FADE_END - SYS_FADE_START)));
      sysT = u * u * (3 - 2 * u); // smoothstep
    }

    // No cross-fade: both canvases stay opaque through the pull-back. The globe only
    // dips out over the last sliver, where it is already a few pixels wide and the
    // orrery is drawing its dot in the same place.
    const globeOpacity = 1 - Math.max(0, (sysT - SYS_HANDOFF_START) / (1 - SYS_HANDOFF_START));
    canvas.style.opacity = String(globeOpacity * (hop?.fade ?? 1));

    if (systemView) {
      systemView.setActive(active.id);
      if (sysT > 0) {
        // The overlay must stay pointer-events:none — it has NO listeners of its own; all
        // input (drag/wheel/click) is handled by the globe-canvas + window/document
        // listeners, which route to the system view by sysT. If the overlay captured
        // pointers it swallowed those events and the orrery froze (no rotate, no zoom-back).
        canvas.style.display = 'block';
        systemView.canvas.style.display = 'block';
        systemView.canvas.style.pointerEvents = 'none';
        systemView.canvas.style.opacity = '1';
        systemView.draw(jd, sysT);
      } else {
        systemView.hide();
      }
    }

    // ── Globe render (skipped once it has handed off to the orrery dot) ───
    const cam = computeCamera(getAspect());
    if (globeOpacity > 0) {
      renderer.draw(makeProxy(cam));
    }
    if (!loadingDone) { document.getElementById('loading').style.display = 'none'; loadingDone = true; }

    // ── HUD ───────────────────────────────────────────────────────────────
    // Guard: a cached index.html without these spans, served alongside newer JS, threw here
    // every frame and blacked the canvas. Degrade to no HUD rather than no render.
    const hudMainEl = document.getElementById('hudmain');
    const lodEl = document.getElementById('lod');
    const setHud = (main, lod) => {
      if (hudMainEl) hudMainEl.textContent = main;
      if (lodEl) lodEl.textContent = lod;
    };
    if (sysT > SYS_INPUT_T) {
      // System mode HUD: minimal readout.
      const pad = n => String(n).padStart(2,'0');
      const ms = (jd - 2440587.5) * 86400000;
      const dt2 = new Date(ms);
      const dateStr = `${dt2.getUTCFullYear()}-${pad(dt2.getUTCMonth()+1)}-${pad(dt2.getUTCDate())}`;
      const spd = timeSpeed === 0 ? '⏸' : timeSpeed < 1 ? timeSpeed+'×' : timeSpeed >= 1000 ? (timeSpeed/1000).toFixed(0)+'k×' : timeSpeed+'×';
      setHud(`SOLAR SYSTEM\n${dateStr} · ${spd}\nclick a world to visit`, '');
    } else {
      setHud(hudText(), lodText(active, now));
    }

    // ── Markers: hide once the orrery's own labels take over ─────────────
    if (sysT > MARKER_FADE_T) {
      for (const b of ALL_MARKERS) {
        const w = widgets.get(b.id);
        if (w) { w.marker.style.display = 'none'; w.arrow.style.display = 'none'; }
      }
      markerHits = [];
    } else {
      // Process ALL markers each frame — REGISTRY bodies + MARKER_ONLY (e.g. Sun).
      // A body only appears once its coarse tier is in hand (preloadCoarse warms them in
      // the background, nearest first). Showing one earlier meant a click could land on a
      // body with nothing loaded, and the hop would stall behind a loading splash instead
      // of playing. This covers every body including the Sun, which is a full Body with
      // its own tiers — MARKER_ONLY is empty.
      const placements = [];
      for (const b of ALL_MARKERS) {
        if (b instanceof Body && b.tier === 0) {
          const w = widgets.get(b.id);
          if (w) { w.marker.style.display = 'none'; w.arrow.style.display = 'none'; }
          continue;
        }
        const p = updateBodyMarker(cam, b, jd);
        if (p) placements.push(p);
      }
      resolveLabelCollisions(placements);
      // Marker-only entries would have no Body methods and are not jumpable; MARKER_ONLY
      // is empty today, so in practice this keeps everything.
      markerHits = placements.filter(p => p.b instanceof Body);
    }

    requestAnimationFrame(frame);
  }

  // Per-body marker. The active body is always hidden. For others: behind the current
  // body → hide; on-screen & unblocked → dot; in front but off-view → edge arrow.
  // Returns a placement record { b, kind, x, y, labelEl } for visible markers,
  // or null for hidden ones. Dot/arrow widget positions are applied here; label
  // vertical offsets are handled by resolveLabelCollisions after all markers are placed.
  function updateBodyMarker(cam, b, jd) {
    const { marker, arrow, chev, lbl, albl } = widgets.get(b.id);
    if (b === active) { marker.style.display = 'none'; arrow.style.display = 'none'; return null; }
    const cw = cssW, ch = cssH;
    const owp = bodySkyMarkerPos(b.id, jd);
    const d = sub(owp, cam.pos);
    const sf = dot(d, cam.fwd), sx = dot(d, cam.right), sy = dot(d, cam.up);
    // Clamp the occlusion sphere below the camera radius so the camera is always
    // just outside it. At high altitude the 1.05 fudge hides markers a hair past
    // the limb (terrain bulge). At low altitude (cam inside 1.05·R_WORLD) raySphere
    // would always return null (near root goes negative → no positive t) and occlusion
    // silently turns off; capping at 0.999·camR keeps the cam just outside the
    // sphere so below-horizon directions are still properly occluded.
    const camR = Math.hypot(...cam.pos);
    const occR = Math.min(R_WORLD * 1.05, camR * 0.999);
    if (raySphere(cam.pos, normalize(d), occR)) { // behind the current body
      marker.style.display = 'none';
      arrow.style.display = 'none';
      return null;
    }
    const sp = (sf > 0) ? projectToScreen(owp, cam.mvp, cw, ch) : null;
    const onScreen = sp && sp[0] >= 0 && sp[0] <= cw && sp[1] >= 0 && sp[1] <= ch;
    if (onScreen) {
      lbl.textContent = '▸ ' + b.name;
      marker.style.display = 'block';
      marker.style.left = sp[0] + 'px';
      marker.style.top = sp[1] + 'px';
      arrow.style.display = 'none';
      return { b, kind: 'dot', x: sp[0], y: sp[1], labelEl: lbl };
    }
    albl.textContent = b.name;
    marker.style.display = 'none';
    let ax = sx, ay = sy;
    if (sf <= 0) { ax = -ax; ay = -ay; } // mirror when behind the camera
    const ang = Math.atan2(-ay, ax);     // screen y points down
    const dx = Math.cos(ang), dy = Math.sin(ang), m = 64;
    const t = Math.min(
      Math.abs(dx) > 1e-4 ? (cw/2 - m) / Math.abs(dx) : Infinity,
      Math.abs(dy) > 1e-4 ? (ch/2 - m) / Math.abs(dy) : Infinity,
    );
    const arrowX = cw/2 + dx*t, arrowY = ch/2 + dy*t;
    arrow.style.display = 'block';
    arrow.style.left = arrowX + 'px';
    arrow.style.top = arrowY + 'px';
    chev.style.transform = `rotate(${ang*180/Math.PI}deg)`;
    return { b, kind: 'arrow', x: arrowX, y: arrowY, labelEl: albl };
  }

  // De-overlap text labels for markers that share nearly the same screen position.
  // Dot/arrow widget positions are untouched — only the label element's transform is
  // adjusted. Groups placements transitively within 48 px of each other (union-find over
  // ≤ ~11 items), sorts each group deterministically by body name, then stacks labels
  // 13 px apart vertically using CSS transform (no layout thrash).
  function resolveLabelCollisions(placements) {
    // Deliberately NARROW: only near-EXACT coincidences stack (Charon sits on Pluto's
    // direction — literally the same pixels). Slightly-offset neighbours stay put:
    // their labels are naturally readable, and wide clustering smeared labels far
    // from their dots (tried, rejected). No transitive chaining for the same reason.
    const COINCIDE_D = 12; // px — visually "the same spot"
    const STEP_Y = 13;     // px between stacked labels

    const n = placements.length;
    const offset = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = placements[j].x - placements[i].x;
        const dy = placements[j].y - placements[i].y;
        if (dx*dx + dy*dy < COINCIDE_D * COINCIDE_D) {
          // stack the later one below whatever the earlier one already occupies
          offset[j] = Math.max(offset[j], offset[i] + STEP_Y);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      placements[i].labelEl.style.transform = offset[i] ? `translateY(${offset[i]}px)` : '';
    }
  }

  requestAnimationFrame(frame);
}

main().catch(e => {
  console.error('[explore]', e);
  const el = document.getElementById('nowgpu');
  el.innerHTML = 'Explore mode couldn\'t start on this device.<br>'
    + `<span style="opacity:0.6; font-size:12px">${e && e.message ? e.message : e}</span>`;
  el.style.display = 'block';
});
