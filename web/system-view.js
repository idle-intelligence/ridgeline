/**
 * system-view.js — 3D heliocentric system view for ridgeline explore mode.
 *
 * Renders a genuine 3D solar system scene: true ephemeris positions with real
 * inclinations, perspective camera orbiting the scene, real elliptical orbit
 * paths, bodies as labeled dots.
 *
 * Compression formula (ALL bodies, single formula):
 *   displayRadius = log10(1 + au) / log10(1 + 40)
 *   0 at Sun (origin), 1.0 at 40 AU ≈ Pluto distance.
 *   displayPos3D = normalize(helioEcl) * displayRadius * PLOT_R
 *   Direction (ecliptic longitude + latitude/inclination) is PRESERVED exactly —
 *   only the radial distance is compressed. Pluto's 17° tilt, etc., are real.
 *
 * Orbit paths: for each body, sample helioEcl(id, jd + k*period/N) for N samples
 * over exactly one orbital period, apply the same compression → real elliptical,
 * inclined paths in scene space. The period comes from ephemeris.orbitPeriodDays()
 * — DERIVED from the same elements the position solver uses, so the sample set
 * closes on itself. Cached; recomputed when jd drifts by > 1 day.
 *
 * Camera: perspective, looking down on the ecliptic from a high inclination.
 * The transition from the globe is a continuous ZOOM OUT, not a cross-fade: the
 * caller passes sysT (0 = at the body, 1 = whole system framed) and the camera
 * dollies back exponentially from right beside the active body to the distance
 * that fits the outermost orbit, while the look-at target slides from the body
 * toward the Sun — ending on a deliberately off-centre composition biased toward
 * the body you left. Drag = orbit (azimuth + elevation), click = enter a body.
 *
 * API:
 *   createSystemView({ registry, helioPos, helioEcl, onEnterBody })
 *   → { canvas, setActive, show, hide, draw(jd, sysT), onPointerDown(x,y,touch),
 *        onPointerMove(x,y,touch), onPointerUp(x,y), onPointerCancel,
 *        hitTest(x,y,touch) }
 */

import { orbitPeriodDays } from './ephemeris.js';
import { createDragTap } from './dragtap.js';

// ── Log-radial compression ────────────────────────────────────────────────────
// Single formula, all bodies. 40 AU upper bound covers Pluto's orbit.
const COMPRESS_DENOM = Math.log10(1 + 40); // ≈ 1.619

/**
 * Map true heliocentric AU distance to display-radius fraction [0, 1].
 * displayRadius = log10(1+au) / log10(1+40)
 */
function compressAU(au) {
  if (au <= 0) return 0;
  return Math.log10(1 + au) / COMPRESS_DENOM;
}

// PLOT_R: scene outer radius in scene units. All compressed positions live within this sphere.
// 1.0 = unit scene; all display code multiplies by this to get scene coords.
const PLOT_R = 1.0;

// ── Stable starfield ─────────────────────────────────────────────────────────
const STAR_COUNT = 360;
const _stars = (() => {
  const arr = [];
  let s = 0xdeadbeef;
  const rng = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
  for (let i = 0; i < STAR_COUNT; i++) {
    arr.push({ nx: rng(), ny: rng(), r: 0.4 + rng() * 0.8, a: 0.12 + rng() * 0.4 });
  }
  return arr;
})();

// ── Per-body display metadata ─────────────────────────────────────────────────
const BODY_META = {
  sun:       { dotR: 10 },
  mercury:   { dotR: 3.5 },
  venus:     { dotR: 4.5 },
  earth:     { dotR: 4.5 },
  moon:      { dotR: 2.5 },
  mars:      { dotR: 4 },
  ceres:     { dotR: 3 },
  vesta:     { dotR: 3 },
  enceladus: { dotR: 2.5 },
  pluto:     { dotR: 3.5 },
  charon:    { dotR: 2.5 },
};

// Moon small 3D offsets (scene units) so they don't perfectly coincide with parent.
const MOON_SCENE_OFFSETS = {
  moon:      [0.012, 0.006, 0],
  charon:    [-0.010, 0.006, 0],
  enceladus: [0.010, 0.004, 0],
};

// Moons orbit too close to their parent to be visible at solar-system scale, so we
// draw the PARENT's heliocentric orbit under them instead of a mini-orbit.
const MOON_PARENT = { moon: 'earth', charon: 'pluto', enceladus: 'saturn' };

// ── 3D perspective projection ─────────────────────────────────────────────────
// Camera defined by: eye position, target, up vector.
// We orbit the camera around a target. Azimuth (yaw around ecliptic Z), elevation
// (pitch above the ecliptic plane).

function makePerspCamera(azimuth, elevation, dolly, targetX, targetY, targetZ, roll = 0) {
  // Camera eye orbits around the target:
  //   1. Start at distance `dolly` along +Y in orbit space.
  //   2. Tilt by elevation (rotation around X).
  //   3. Spin by azimuth (rotation around Z).
  // Then translate by target offset.
  const cosA = Math.cos(azimuth), sinA = Math.sin(azimuth);
  const cosE = Math.cos(elevation), sinE = Math.sin(elevation);

  // Eye position in scene space (ecliptic: X toward vernal equinox, Y=90°lon, Z=ecliptic north)
  // Orbit around ecliptic Z (azimuth), then tilt above plane (elevation).
  // Base eye at [0, dolly, 0] → elevate → azimuth-rotate:
  // After elevation (rotate around X by elevation): [0, dolly*cosE, dolly*sinE]
  // After azimuth (rotate around Z by azimuth):
  const eyeX0 =  -sinA * dolly * cosE;
  const eyeY0 =   cosA * dolly * cosE;
  const eyeZ0 =          dolly * sinE;
  const eyeX = eyeX0 + targetX;
  const eyeY = eyeY0 + targetY;
  const eyeZ = eyeZ0 + targetZ;

  // forward = target - eye (normalized)
  let fx = targetX - eyeX, fy = targetY - eyeY, fz = targetZ - eyeZ;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;

  // up vector: ecliptic north (+Z in ecliptic space) projected perpendicular to forward.
  let ux = 0, uy = 0, uz = 1;
  const uDotF = ux*fx + uy*fy + uz*fz;
  ux -= uDotF*fx; uy -= uDotF*fy; uz -= uDotF*fz;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;

  // right = forward × up
  let rx = fy*uz - fz*uy;
  let ry = fz*ux - fx*uz;
  let rz = fx*uy - fy*ux;

  // Roll spins (right, up) about forward. Rolling the basis — rather than rotating
  // the projected image — keeps labels, hit rectangles and the off-centre anchor
  // consistent for free, since everything downstream is derived from these axes.
  if (roll !== 0) {
    const c = Math.cos(roll), s = Math.sin(roll);
    const nrx = rx*c + ux*s, nry = ry*c + uy*s, nrz = rz*c + uz*s;
    const nux = ux*c - rx*s, nuy = uy*c - ry*s, nuz = uz*c - rz*s;
    rx = nrx; ry = nry; rz = nrz;
    ux = nux; uy = nuy; uz = nuz;
  }

  return {
    eye: [eyeX, eyeY, eyeZ],
    fwd: [fx, fy, fz],
    up:  [ux, uy, uz],
    right: [rx, ry, rz],
    // Scene [x,y,z] → view space [right, up, depth]. Depth ≤ 0 means behind the camera.
    view(x, y, z) {
      const dx = x - eyeX, dy = y - eyeY, dz = z - eyeZ;
      return [
        dx*rx + dy*ry + dz*rz,
        dx*ux + dy*uy + dz*uz,
        dx*fx + dy*fy + dz*fz,
      ];
    },
  };
}

// ── JD → calendar string ─────────────────────────────────────────────────────
function jdToDateStr(jd) {
  const ms = (jd - 2440587.5) * 86400000;
  const d = new Date(ms);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}

const clamp01 = t => Math.max(0, Math.min(1, t));
const smoothstep = t => t * t * (3 - 2 * t);

// ── Orbit path cache ──────────────────────────────────────────────────────────
const PATH_CACHE = new Map();
const PATH_RECOMPUTE_INTERVAL = 1.0; // days
const PATH_N = 192;                  // samples per orbit (time-uniform → sparser near perihelion)

// ── Camera framing constants ──────────────────────────────────────────────────
const FOV_Y = 45 * Math.PI / 180;
const CAM_ELEVATION = 62 * Math.PI / 180;  // high, looking down on the ecliptic — but not flat
const CAM_COMPOSE_ANGLE = 135 * Math.PI / 180; // active body sits down-right of frame centre
const COMPOSE_BIAS = 0.42;  // how far the look-at slides from the scene's centre toward the body you left

// ── Portrait composition ──────────────────────────────────────────────────────
// Seen from above the orrery is a wide flat ellipse. On a portrait phone the fit
// solver still fits it, but tiny, because the disc's long axis fights the screen's
// short axis. Roll the camera so the system's long axis follows the screen's long
// axis. Driven continuously by the aspect ratio rather than snapped at a threshold,
// so a desktop window dragged narrow gets the same benefit and a near-square
// viewport does not flip jarringly. The fit solver runs on the SAME rolled axes,
// so the fit-everything guarantee holds at every aspect.
const ROLL_MAX = Math.PI / 2;
const ROLL_ASPECT_FULL = 0.55; // at or below this aspect the roll is complete
export function rollForAspect(aspect) {
  if (aspect >= 1) return 0;
  return ROLL_MAX * smoothstep(clamp01((1 - aspect) / (1 - ROLL_ASPECT_FULL)));
}

/**
 * Express a screen-space drag delta in the ROLLED camera basis, so a horizontal
 * swipe always rotates the system the way the user sees it. The camera's right/up
 * are (R·cos+U·sin, U·cos−R·sin); a drag (dx, −dy) read against those axes is
 * (dx·cos+dy·sin, −(dy·cos−dx·sin)) against the unrolled pair the azimuth /
 * elevation gains are calibrated for. Identity at roll 0.
 */
export function unrollDrag(dx, dy, roll) {
  if (roll === 0) return { dx, dy };
  const c = Math.cos(roll), s = Math.sin(roll);
  return { dx: dx*c + dy*s, dy: dy*c - dx*s };
}
const FIT_MARGIN = 1.14;    // slack around the outermost orbit
const DOLLY_NEAR = 0.045;   // scene units — camera sits right beside the body at sysT = 0

// ── createSystemView ──────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array}    opts.registry    — Body objects (id, name, color)
 * @param {function} opts.helioPos    — helioPos(id, jd) → [x,y,z] AU heliocentric ecliptic
 * @param {function} opts.helioEcl   — helioEcl(id, jd) → [x,y,z] AU (planets only, for orbit paths)
 * @param {function} opts.onEnterBody — (bodyId: string) → void
 */
export function createSystemView({ registry, helioPos, helioEcl, onEnterBody, host }) {
  // Render into the host container (defaults to the page body).
  const _host = host || document.body;
  // ── Canvas setup ─────────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.id = 'sys';
  canvas.style.cssText = 'position:absolute;inset:0;display:none;opacity:0;z-index:8;'
    + 'width:100%;height:100%;pointer-events:none;';
  _host.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // Backing store in DEVICE px (capped at 2), with a matching context transform so
  // the whole draw path below — dot radii, fonts, label rects, hit targets — stays
  // in CSS px and lines up with the clientX/clientY the pointer handlers receive.
  const DPR_MAX = 2;
  let cssW = canvas.clientWidth || window.innerWidth;
  let cssH = canvas.clientHeight || window.innerHeight;
  function resize() {
    cssW = canvas.clientWidth || window.innerWidth;
    cssH = canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(DPR_MAX, window.devicePixelRatio || 1);
    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ── Camera state ─────────────────────────────────────────────────────────────
  // The base azimuth/elevation are re-composed from the active body every time we
  // leave the globe (sysT ≈ 0); dragging accumulates a delta on top.
  let baseAzimuth = 0;
  let azimuthUser = 0;
  let elevation   = CAM_ELEVATION;
  // The roll the last drawn frame used. Drag deltas are read against it so the
  // gesture matches the frame the user is actually looking at — one source, no
  // second copy of the aspect → roll curve.
  let camRoll     = 0;

  // ── Active body tracking ──────────────────────────────────────────────────────
  let activeId = 'earth';
  function setActive(id) { activeId = id; }

  // ── Show / hide ──────────────────────────────────────────────────────────────
  function show() {
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'auto';
  }
  function hide() {
    canvas.style.display = 'none';
    canvas.style.opacity = '0';
    canvas.style.pointerEvents = 'none';
  }

  // ── Hit testing ──────────────────────────────────────────────────────────────
  // Both the dot AND its text label are hit-testable — the dots alone are far too
  // small to aim at. Rectangles are recorded during draw().
  const hitTargets = new Map(); // id → { px, py, dotR, x1, y1, x2, y2 }
  const LABEL_PAD = 7;
  // A fingertip needs ~44 CSS px. The label rect is 10 px tall and the dots are a
  // few px across, so touch pads both out to that — the drawn appearance is
  // untouched, only the invisible hit region grows.
  const TOUCH_PAD   = 17;
  const TOUCH_DOT_R = 22;
  let hoverId = null;

  function hitTest(px, py, touch = false) {
    const pad = touch ? TOUCH_PAD : LABEL_PAD;
    const minDotR = touch ? TOUCH_DOT_R : 14;
    let bestId = null, bestScore = Infinity;
    for (const [id, t] of hitTargets) {
      const inLabel = px >= t.x1 - pad && px <= t.x2 + pad
                   && py >= t.y1 - pad && py <= t.y2 + pad;
      const dDot = Math.hypot(px - t.px, py - t.py);
      const dotHit = dDot <= Math.max(minDotR, t.dotR + 9);
      if (!inLabel && !dotHit) continue;
      // Enlarged touch targets overlap, so rank by the nearest centre rather than
      // by list order. The mouse keeps its exact previous ranking (label wins flat).
      let score;
      if (!touch) score = inLabel ? 0 : dDot;
      else if (!inLabel) score = dDot;
      else score = Math.min(dDot, Math.hypot(px - (t.x1 + t.x2) / 2, py - (t.y1 + t.y2) / 2));
      if (score < bestScore) { bestScore = score; bestId = id; }
    }
    return bestId;
  }

  // ── Pointer: drag-vs-tap discrimination ───────────────────────────────────────
  // Mouse and touch run the same state machine (dragtap.js): a press that moves
  // more than DRAG_SLOP px, or is held longer than CLICK_MS, is a camera rotate and
  // never enters a body. Anything shorter and stiller is a tap.
  const gesture = createDragTap();

  function onPointerDown(x, y, touch = false) {
    gesture.press(x, y, touch);
    if (touch) hoverId = null;
  }
  function onPointerMove(x, y, touch = false) {
    const m = gesture.move(x, y);
    if (!m) { if (!touch) hoverId = hitTest(x, y); return; }
    if (m.dragging) {
      const d = unrollDrag(m.dx, m.dy, camRoll);
      azimuthUser += d.dx * 0.007;
      elevation = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05,
                    elevation - d.dy * 0.005));
      hoverId = null;
    }
  }
  function onPointerUp(x, y) {
    const touch = gesture.isTouch;
    const r = gesture.release(x, y);
    if (touch) hoverId = null;   // no hover on touch — never leave a ring stuck on
    if (!r.tap) return;
    const hit = hitTest(r.x, r.y, touch);
    if (hit) onEnterBody(hit);
  }
  function onPointerCancel() {
    gesture.cancel();
    hoverId = null;
  }

  // ── Orbit path building ───────────────────────────────────────────────────────
  function buildOrbitPath(bodyId, jd) {
    const period = orbitPeriodDays(bodyId);
    if (!period) return null;
    try { helioEcl(bodyId, jd); } catch (_) { return null; }

    const points = [];
    let maxR = 0;
    for (let k = 0; k < PATH_N; k++) {
      const t = jd + (k / PATH_N) * period;
      const [x, y, z] = helioEcl(bodyId, t);
      const rAU = Math.hypot(x, y, z);
      if (rAU < 1e-12) { points.push([0, 0, 0]); continue; }
      const dr = compressAU(rAU) * PLOT_R;
      points.push([(x/rAU)*dr, (y/rAU)*dr, (z/rAU)*dr]);
      if (dr > maxR) maxR = dr;
    }
    return points.length >= 3 ? { points, maxR } : null;
  }

  function getOrbitPath(bodyId, jd) {
    const cached = PATH_CACHE.get(bodyId);
    if (cached && Math.abs(jd - cached.jdBase) < PATH_RECOMPUTE_INTERVAL) return cached.path;
    const path = buildOrbitPath(bodyId, jd);
    PATH_CACHE.set(bodyId, { jdBase: jd, path });
    return path;
  }

  // Ids whose heliocentric orbit we trace: every registry body except the Sun, with
  // satellites replaced by their parent (a moon's own orbit is sub-pixel here).
  const PATH_IDS = (() => {
    const seen = new Map();
    for (const b of registry) {
      if (b.id === 'sun') continue;
      const id = MOON_PARENT[b.id] ?? b.id;
      if (!seen.has(id)) seen.set(id, b.color ?? '#888');
    }
    return [...seen];
  })();

  // ── Scene → pixel ─────────────────────────────────────────────────────────────
  const NEAR_EPS = 1e-5;

  function makeProjector(W, H) {
    const tanY = Math.tan(FOV_Y / 2);
    const tanX = tanY * (W / H);
    return (v) => [
      ((v[0] / (v[2] * tanX)) * 0.5 + 0.5) * W,
      (1 - ((v[1] / (v[2] * tanY)) * 0.5 + 0.5)) * H,
    ];
  }

  // ── Draw ──────────────────────────────────────────────────────────────────────
  /**
   * @param {number} jd   — Julian date
   * @param {number} sysT — 0 = at the active body (globe fills the screen), 1 = whole system framed
   */
  function draw(jd, sysT = 1) {
    const W = cssW, H = cssH;
    const aspect = W / H;
    const tanY = Math.tan(FOV_Y / 2);
    const tanX = tanY * aspect;
    ctx.clearRect(0, 0, W, H);

    // ── 1. Body scene positions + scene extent ────────────────────────────────
    const bodyScenePos = new Map();
    let sceneMaxR = 0;
    for (const b of registry) {
      let auPos;
      try { auPos = helioPos(b.id, jd); } catch (_) { continue; }
      const rAU = Math.hypot(auPos[0], auPos[1], auPos[2]);
      let sx = 0, sy = 0, sz = 0;
      if (rAU >= 1e-12) {
        const dr = compressAU(rAU) * PLOT_R;
        sx = (auPos[0] / rAU) * dr;
        sy = (auPos[1] / rAU) * dr;
        sz = (auPos[2] / rAU) * dr;
      }
      const off = MOON_SCENE_OFFSETS[b.id];
      if (off) { sx += off[0]; sy += off[1]; sz += off[2]; }
      bodyScenePos.set(b.id, [sx, sy, sz]);
      sceneMaxR = Math.max(sceneMaxR, Math.hypot(sx, sy, sz));
    }

    const paths = [];
    for (const [id, color] of PATH_IDS) {
      const p = getOrbitPath(id, jd);
      if (!p) continue;
      paths.push({ color, points: p.points });
      sceneMaxR = Math.max(sceneMaxR, p.maxR);
    }

    // ── 2. Camera: continuous zoom-out from the active body ───────────────────
    // Recompose the framing whenever we're back at the globe, so each departure
    // starts from a clean, deliberate composition.
    const actPos = bodyScenePos.get(activeId) ?? [0, 0, 0];
    if (sysT < 0.02) {
      baseAzimuth = Math.atan2(actPos[1], actPos[0]) - CAM_COMPOSE_ANGLE;
      azimuthUser = 0;
      elevation = CAM_ELEVATION;
    }
    const azimuth = baseAzimuth + azimuthUser;

    // Settled framing, solved against the ACTUAL scene points rather than a bounding
    // sphere — the orrery is a near-flat disc seen at a steep angle, and a sphere fit
    // leaves it swimming in empty frame.
    //   Pass 1: screen-space (right, up) bounds of every orbit sample and body.
    //   Target: the centre of those bounds, then pushed COMPOSE_BIAS of the way toward
    //           the body we left — so the frame is full AND the composition is off-centre,
    //           deliberately weighted to where you came from instead of to the Sun.
    //   Pass 2: the distance D at which every point still clears the frame. A point at
    //           camera-axis coords (a, b, c) relative to the target is held when
    //           |a| ≤ (D + c)·tanX and |b| ≤ (D + c)·tanY.
    const roll = camRoll = rollForAspect(aspect);
    const axes = makePerspCamera(azimuth, elevation, 1, 0, 0, 0, roll);
    const { right: axR, up: axU, fwd: axF } = axes;
    const projA = p => p[0]*axR[0] + p[1]*axR[1] + p[2]*axR[2];
    const projB = p => p[0]*axU[0] + p[1]*axU[1] + p[2]*axU[2];
    const projC = p => p[0]*axF[0] + p[1]*axF[1] + p[2]*axF[2];

    let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    const bound = (p) => {
      const a = projA(p), b = projB(p);
      if (a < aMin) aMin = a; if (a > aMax) aMax = a;
      if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    };
    for (const path of paths) for (const p of path.points) bound(p);
    for (const s of bodyScenePos.values()) bound(s);

    const aT = (aMin + aMax) / 2 + (projA(actPos) - (aMin + aMax) / 2) * COMPOSE_BIAS;
    const bT = (bMin + bMax) / 2 + (projB(actPos) - (bMin + bMax) / 2) * COMPOSE_BIAS;
    const fitTarget = [
      aT * axR[0] + bT * axU[0],
      aT * axR[1] + bT * axU[1],
      aT * axR[2] + bT * axU[2],
    ];
    const cT = projC(fitTarget);

    let fitDolly = 0;
    const widen = (p) => {
      const a = projA(p) - aT, b = projB(p) - bT, c = projC(p) - cT;
      const need = Math.max(Math.abs(a) / tanX, Math.abs(b) / tanY) - c;
      if (need > fitDolly) fitDolly = need;
    };
    for (const path of paths) for (const p of path.points) widen(p);
    for (const s of bodyScenePos.values()) widen(s);
    fitDolly = Math.max(sceneMaxR * 0.5, fitDolly * FIT_MARGIN);

    // Dolly interpolates in LOG space: distance grows exponentially with sysT, which is
    // what a real pull-back looks like — the scene rushes away faster and faster. A mild
    // ease-in on top biases the acceleration further toward the end. The target slides
    // late so the body stays centred while it is still the thing you're looking at.
    const zoom = sysT * 0.75 + sysT * sysT * 0.25;
    const dolly = DOLLY_NEAR * Math.pow(fitDolly / DOLLY_NEAR, zoom);
    const tLate = smoothstep(clamp01((sysT - 0.45) / 0.55));
    const tx = actPos[0] + (fitTarget[0] - actPos[0]) * tLate;
    const ty = actPos[1] + (fitTarget[1] - actPos[1]) * tLate;
    const tz = actPos[2] + (fitTarget[2] - actPos[2]) * tLate;

    const cam = makePerspCamera(azimuth, elevation, dolly, tx, ty, tz, roll);
    const toPixel = makeProjector(W, H);

    // ── 3. Starfield ──────────────────────────────────────────────────────────
    // Fades in only at the very end of the pull-back — until then the globe canvas
    // underneath is still supplying the stars.
    const starA = smoothstep(clamp01((sysT - 0.75) / 0.25));
    if (starA > 0.01) {
      for (const st of _stars) {
        ctx.beginPath();
        ctx.arc(st.nx * W, st.ny * H, st.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${st.a * starA})`;
        ctx.fill();
      }
    }

    // ── 4. Orbit paths ────────────────────────────────────────────────────────
    // Walked as a CLOSED loop (k wraps to 0) with near-plane clipping per segment,
    // so a path is never left open and never sprays a chord across the frame when
    // part of it passes behind the camera.
    for (const path of paths) {
      const pts = path.points;
      const n = pts.length;
      ctx.beginPath();
      let prevV = cam.view(pts[n-1][0], pts[n-1][1], pts[n-1][2]);
      let open = false;
      for (let k = 0; k < n; k++) {
        const v = cam.view(pts[k][0], pts[k][1], pts[k][2]);
        const aIn = prevV[2] > NEAR_EPS, bIn = v[2] > NEAR_EPS;
        if (aIn && bIn) {
          if (!open) { const p = toPixel(prevV); ctx.moveTo(p[0], p[1]); open = true; }
          const p = toPixel(v); ctx.lineTo(p[0], p[1]);
        } else if (aIn !== bIn) {
          const t = (NEAR_EPS - prevV[2]) / (v[2] - prevV[2]);
          const cut = [prevV[0] + (v[0]-prevV[0])*t, prevV[1] + (v[1]-prevV[1])*t, NEAR_EPS];
          if (aIn) {
            if (!open) { const p = toPixel(prevV); ctx.moveTo(p[0], p[1]); open = true; }
            const p = toPixel(cut); ctx.lineTo(p[0], p[1]);
            open = false;
          } else {
            const p = toPixel(cut); ctx.moveTo(p[0], p[1]); open = true;
            const q = toPixel(v); ctx.lineTo(q[0], q[1]);
          }
        } else {
          open = false;
        }
        prevV = v;
      }
      ctx.strokeStyle = `${path.color}28`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }

    // ── 5. Project bodies ─────────────────────────────────────────────────────
    const bodyPositions = new Map();
    for (const [id, s] of bodyScenePos) {
      const v = cam.view(s[0], s[1], s[2]);
      if (v[2] <= NEAR_EPS) continue;
      bodyPositions.set(id, toPixel(v));
    }

    // The globe canvas is still drawing the active body underneath until the very end
    // of the pull-back; suppress its dot so there is only ever one of it on screen.
    const globeStillUp = sysT < 0.9;

    // Dots + labels ramp in just after the pull-back starts, as the globe's own DOM
    // markers are being retired — two sets of labels at once would just be clutter.
    const uiA = smoothstep(clamp01((sysT - 0.05) / 0.25));
    if (uiA < 0.01) { hitTargets.clear(); return; }
    ctx.globalAlpha = uiA;

    // ── 6. Sun glow (before other bodies so dots overdraw it) ─────────────────
    {
      const sunP = bodyPositions.get('sun');
      if (sunP && !(globeStillUp && activeId === 'sun')) {
        const [px, py] = sunP;
        const grd = ctx.createRadialGradient(px, py, 0, px, py, 28);
        grd.addColorStop(0,   'rgba(255,207,106,0.9)');
        grd.addColorStop(0.35,'rgba(255,207,106,0.4)');
        grd.addColorStop(1,   'rgba(255,207,106,0)');
        ctx.beginPath();
        ctx.arc(px, py, 28, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, Math.PI * 2);
        ctx.fillStyle = '#ffcf6a';
        ctx.fill();
      }
    }

    // ── 7. Body dots + labels ─────────────────────────────────────────────────
    const labelInfos = [];
    for (const b of registry) {
      const pos = bodyPositions.get(b.id);
      if (!pos) continue;
      const [px, py] = pos;
      const dotR = (BODY_META[b.id] ?? { dotR: 3.5 }).dotR;
      const color = b.color ?? '#888';
      const hidden = globeStillUp && b.id === activeId;

      if (b.id !== 'sun' && !hidden) {
        ctx.beginPath();
        ctx.arc(px, py, dotR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }

      if (b.id === activeId) {
        ctx.beginPath();
        ctx.arc(px, py, dotR + 5, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.55 * uiA;
        ctx.stroke();
        ctx.globalAlpha = uiA;
      }

      if (b.id === hoverId) {
        ctx.beginPath();
        ctx.arc(px, py, dotR + 8, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.5 * uiA;
        ctx.stroke();
        ctx.globalAlpha = uiA;
      }

      labelInfos.push({ id: b.id, px, py, dotR, color, name: b.name });
    }

    // Labels with simple de-collision. The placed rectangle doubles as the click target.
    hitTargets.clear();
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const placed = [];

    for (const info of labelInfos) {
      const textW = ctx.measureText(info.name).width;
      // Flip to the left of the dot rather than run off the right edge.
      const labelX = info.px + info.dotR + 5 + textW > W - 8
        ? info.px - info.dotR - 5 - textW
        : info.px + info.dotR + 5;
      let labelY = info.py + 4;

      for (const p of placed) {
        const xOverlap = labelX < p.x2 && labelX + textW > p.x1;
        if (xOverlap) {
          const yOverlap = labelY - 10 < p.y2 && labelY > p.y1 - 10;
          if (yOverlap) labelY = p.y2 + 13;
        }
      }
      const rect = { x1: labelX, y1: labelY - 10, x2: labelX + textW, y2: labelY };
      placed.push(rect);
      const hovered = info.id === hoverId;
      if (hovered) {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(rect.x1 - 4, rect.y1 - 3, textW + 8, 16);
      }
      ctx.fillStyle = info.color + (hovered ? 'ff' : 'cc');
      ctx.fillText(info.name, labelX, labelY);
      hitTargets.set(info.id, { px: info.px, py: info.py, dotR: info.dotR, ...rect });
    }

    // ── 8. Active body crosshair ──────────────────────────────────────────────
    const activePt = bodyPositions.get(activeId);
    if (activePt) {
      const [ax, ay] = activePt;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(ax - 14, ay); ctx.lineTo(ax + 14, ay); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax, ay - 14); ctx.lineTo(ax, ay + 14); ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── 9. Caption ────────────────────────────────────────────────────────────
    ctx.textAlign = 'left';
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillText('SYSTEM · log-compressed distances', 16, H - 28);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillText(jdToDateStr(jd), W - 16, H - 28);
    ctx.globalAlpha = 1.0;
  }

  return {
    canvas,
    setActive,
    show,
    hide,
    draw,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    hitTest,
    isHovering: () => hoverId !== null,
  };
}
