/**
 * system-view.js — 2D-canvas orrery overlay for ridgeline explore mode.
 *
 * Renders a top-down-ish solar system view with log-compressed radial distances,
 * ecliptic tilt, orbit rings, body dots, and labels. Fully self-contained.
 *
 * API:
 *   createSystemView({ registry, helioEcl, helioPos, toJD, getJd, onEnterBody })
 *   → { canvas, setActive, show(fromCam), hide(), draw(jd), onWheel, onPointerDown,
 *        onPointerMove, onPointerUp, hitTest(x,y) }
 */

// ── Log-radial compression ────────────────────────────────────────────────────
// compress(a) maps true distance in AU to a display-radius fraction [0,1].
// BASE adds a minimum non-zero display radius for the Sun's nearest body (Mercury),
// so no body is squashed onto the Sun dot itself.
const MAXAU   = 42;         // anything beyond this clips to edge
const BASE    = 0.07;       // Mercury's minimum display fraction
const SPAN    = 1.0 - BASE; // range available for the rest

function compressAU(a) {
  if (a <= 0) return 0;
  return BASE + SPAN * Math.log10(1 + a) / Math.log10(1 + MAXAU);
}

// ── Stable starfield ─────────────────────────────────────────────────────────
// Generated once from a seed; never reallocated per frame.
const STAR_COUNT = 340;
const stars = (() => {
  const arr = [];
  // LCG with a fixed seed — purely aesthetic, doesn't need to be cryptographic.
  let s = 0xdeadbeef;
  const rng = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
  for (let i = 0; i < STAR_COUNT; i++) {
    arr.push({ nx: rng(), ny: rng(), r: 0.5 + rng() * 0.9, a: 0.15 + rng() * 0.45 });
  }
  return arr;
})();

// ── Per-body display metadata ─────────────────────────────────────────────────
// Dot radius in px, moon offset in px (screen-space nudge so labels don't stack).
const BODY_META = {
  sun:       { dotR: 9,  moonOff: [0,   0] },
  mercury:   { dotR: 4,  moonOff: [0,   0] },
  venus:     { dotR: 5,  moonOff: [0,   0] },
  earth:     { dotR: 5,  moonOff: [0,   0] },
  moon:      { dotR: 3,  moonOff: [24,  16] },
  mars:      { dotR: 4.5,moonOff: [0,   0] },
  ceres:     { dotR: 3.5,moonOff: [0,   0] },
  vesta:     { dotR: 3.5,moonOff: [0,   0] },
  enceladus: { dotR: 3,  moonOff: [20,  8] },
  pluto:     { dotR: 4,  moonOff: [0,   0] },
  charon:    { dotR: 3,  moonOff: [-20, 8] },
};

// ── 3D → 2D projection helpers ────────────────────────────────────────────────
// The orrery uses a fixed orthographic camera:
//   - Looking slightly from above the ecliptic plane (tiltable by drag).
//   - The ecliptic X/Y plane projects onto screen X/Y with a Y-squash for depth illusion.
// Camera state: azimuth (rad) around ecliptic +Z, elevation (rad) above the plane.
// We rotate the ecliptic 3D point by azimuth around Z, then elevation around X,
// then drop Z for the 2D projection (orthographic).

function makeOrreryCamera(azimuth, elevation) {
  // Rotation matrix: first rotate by -azimuth around Z (yaw), then tilt by elevation around X (pitch).
  // Applied to ecliptic [x, y, z] → screen [sx, sy, sz].
  const cosA = Math.cos(-azimuth), sinA = Math.sin(-azimuth);
  const cosE = Math.cos(elevation), sinE = Math.sin(elevation);
  return {
    // Transforms ecliptic [x,y,z] → [sx, sy, sz] (camera space, drop sy for screen)
    project: (x, y, z) => {
      // Yaw around Z
      const rx = cosA * x - sinA * y;
      const ry = sinA * x + cosA * y;
      const rz = z;
      // Pitch around X
      const sx = rx;
      const sy = cosE * ry - sinE * rz;
      // const sz = sinE * ry + cosE * rz; // depth — not needed for ortho
      return [sx, sy];
    },
  };
}

// ── JD → calendar string ─────────────────────────────────────────────────────
function jdToDateStr(jd) {
  // Convert JD to a simple UTC date string.
  const ms = (jd - 2440587.5) * 86400000;
  const d = new Date(ms);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}

// ── createSystemView ──────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array}  opts.registry  — Body objects from explore.js (id, name, color)
 * @param {function} opts.helioPos — helioPos(id, jd) → [x,y,z] AU heliocentric ecliptic
 * @param {function} opts.getJd   — () → current Julian date
 * @param {function} opts.onEnterBody — (bodyId: string) → void
 */
export function createSystemView({ registry, helioPos, getJd, onEnterBody }) {
  // ── Canvas setup ────────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.id = 'sys';
  canvas.style.cssText = 'position:fixed;inset:0;display:none;opacity:0;z-index:8;'
    + 'width:100vw;height:100vh;pointer-events:none;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // Resize canvas to match window.
  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  // ── Camera state ─────────────────────────────────────────────────────────────
  let azimuth   = 0.0;          // rad — rotation around ecliptic Z
  let elevation = 22 * Math.PI / 180; // rad — tilt above the ecliptic (~22°)
  let orrZoom   = 1.0;          // scale multiplier (1 = default, increase to zoom in)

  // ── Active body tracking ─────────────────────────────────────────────────────
  let activeId = 'earth';
  function setActive(id) { activeId = id; }

  // ── Show / hide ─────────────────────────────────────────────────────────────
  // show() makes the canvas pointer-interactive; hide() removes it.
  function show() {
    canvas.style.display = 'block';
    canvas.style.pointerEvents = 'auto';
  }
  function hide() {
    canvas.style.display = 'none';
    canvas.style.opacity = '0';
    canvas.style.pointerEvents = 'none';
  }

  // ── Coordinate helpers ───────────────────────────────────────────────────────
  // The Sun is placed at ~35% from left, ~48% from top.
  // plotR = the "full plot radius" in pixels: frac of the smaller dimension.
  function getSunScreen() {
    return [canvas.width * 0.35, canvas.height * 0.48];
  }
  function getPlotR() {
    return Math.min(canvas.width, canvas.height) * 0.44 * orrZoom;
  }

  // Project an ecliptic [x,y,z] AU position to screen [px, py].
  // displayRadius: log-compressed. Angle: preserved from true ecliptic direction.
  function eclToScreen(x, y, z, cam) {
    const rAU = Math.hypot(x, y, z);
    const dispR = compressAU(rAU); // 0..1
    // Normalize the ecliptic direction and apply display radius.
    if (rAU < 1e-10) {
      // Sun at origin
      const [sx, sy] = getSunScreen();
      return [sx, sy];
    }
    const nx = x / rAU, ny = y / rAU, nz = z / rAU;
    const [sx, sy] = cam.project(nx * dispR, ny * dispR, nz * dispR);
    const [sunX, sunY] = getSunScreen();
    const plotR = getPlotR();
    return [sunX + sx * plotR, sunY - sy * plotR];
  }

  // ── Hit testing ─────────────────────────────────────────────────────────────
  // bodyPositions: map of id → [px, py] updated each draw() call.
  const bodyPositions = new Map();

  function hitTest(px, py) {
    let bestId = null, bestDist = 18; // 18px hit radius
    for (const [id, [bx, by]] of bodyPositions) {
      const d = Math.hypot(px - bx, py - by);
      if (d < bestDist) { bestDist = d; bestId = id; }
    }
    return bestId;
  }

  // ── Drag (orrery rotation) ────────────────────────────────────────────────
  let _pointerDown = false, _pointerX = 0, _pointerY = 0;

  function onPointerDown(e) {
    _pointerDown = true;
    _pointerX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    _pointerY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
  }
  function onPointerMove(e) {
    if (!_pointerDown) return;
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    const dx = x - _pointerX, dy = y - _pointerY;
    _pointerX = x; _pointerY = y;
    azimuth   += dx * 0.006;
    elevation  = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05,
                   elevation - dy * 0.004));
  }
  function onPointerUp() { _pointerDown = false; }

  function onWheel(e) {
    // Adjust orrery zoom only (not the altitude — the caller handles exit on deep zoom-in).
    const factor = Math.pow(0.92, e.deltaY / 100);
    orrZoom = Math.max(0.3, Math.min(5.0, orrZoom * factor));
    return orrZoom; // caller may inspect this
  }

  // ── Draw ─────────────────────────────────────────────────────────────────────
  function draw(jd) {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cam = makeOrreryCamera(azimuth, elevation);
    const [sunX, sunY] = getSunScreen();
    const plotR = getPlotR();

    // ── 1. Starfield ─────────────────────────────────────────────────────────
    for (const st of stars) {
      ctx.beginPath();
      ctx.arc(st.nx * W, st.ny * H, st.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${st.a})`;
      ctx.fill();
    }

    // ── 2. Build body screen positions ────────────────────────────────────────
    bodyPositions.clear();
    const bodyScreenPos = new Map(); // id → [px, py] (no moon offsets yet)
    const parentPos = new Map();     // id → [px, py] of parent (for moons)

    // Collect ecliptic positions for all bodies.
    for (const b of registry) {
      let pos;
      try { pos = helioPos(b.id, jd); } catch (_) { continue; }
      const [px, py] = eclToScreen(pos[0], pos[1], pos[2], cam);
      bodyScreenPos.set(b.id, [px, py]);
      parentPos.set(b.id, pos); // raw AU position for finding parent
    }

    // ── 3. Orbit rings ────────────────────────────────────────────────────────
    // Draw a full ring at each body's compressed display radius.
    // Moons share parent's ring (offset negligible at solar-system scale).
    const drawnRings = new Set();
    for (const b of registry) {
      if (b.id === 'sun') continue;
      let pos;
      try { pos = helioPos(b.id, jd); } catch (_) { continue; }
      // For moons, draw ring at parent's distance to avoid separate tiny moon rings.
      const rAU = Math.hypot(...pos);
      const rKey = compressAU(rAU).toFixed(4); // bucket by display radius
      if (drawnRings.has(rKey)) continue;
      drawnRings.add(rKey);

      const dispR = compressAU(rAU);
      // Draw the ring as an ellipse in camera space.
      // Sample 120 points around the unit circle in the ecliptic plane.
      ctx.beginPath();
      const STEPS = 120;
      for (let i = 0; i <= STEPS; i++) {
        const ang = (i / STEPS) * Math.PI * 2;
        const ex = Math.cos(ang) * dispR;
        const ey = Math.sin(ang) * dispR;
        const [sx, sy] = cam.project(ex, ey, 0);
        const screenX = sunX + sx * plotR;
        const screenY = sunY - sy * plotR;
        if (i === 0) ctx.moveTo(screenX, screenY);
        else ctx.lineTo(screenX, screenY);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }

    // ── 4. Body dots + labels ─────────────────────────────────────────────────
    // Compute final screen positions with moon offsets, then draw.
    // Moon offsets are in screen space.
    const MOON_PARENTS = { moon: 'earth', charon: 'pluto', enceladus: 'enceladus' };
    // (enceladus is already placed at Saturn's screen pos — its parent is 'saturn' not in registry)

    for (const b of registry) {
      let [px, py] = bodyScreenPos.get(b.id) ?? [0, 0];
      if (!bodyScreenPos.has(b.id)) continue;

      // Apply moon screen-space offset.
      const meta = BODY_META[b.id] ?? { dotR: 4, moonOff: [0, 0] };
      px += meta.moonOff[0];
      py += meta.moonOff[1];

      bodyPositions.set(b.id, [px, py]);
    }

    // Draw orbit ring for enceladus labelled as Saturn (special case: enceladus = Saturn's moon,
    // its parent is 'saturn' which has no body in registry).
    // (Already drawn above via ring key.)

    // Draw dots in order: moons last so they render on top.
    const drawOrder = registry.filter(b => b.id !== 'sun')
      .sort((a, b) => {
        // Moons/satellites after planets
        const isMoonA = ['moon','charon','enceladus'].includes(a.id);
        const isMoonB = ['moon','charon','enceladus'].includes(b.id);
        return isMoonA - isMoonB;
      });

    // Collect label positions for de-collision.
    const labelInfos = [];

    // Sun first.
    {
      const [px, py] = bodyPositions.get('sun') ?? [sunX, sunY];
      // Soft glow for the Sun.
      const grd = ctx.createRadialGradient(px, py, 0, px, py, 22);
      grd.addColorStop(0,   'rgba(255,207,106,0.85)');
      grd.addColorStop(0.4, 'rgba(255,207,106,0.35)');
      grd.addColorStop(1,   'rgba(255,207,106,0)');
      ctx.beginPath();
      ctx.arc(px, py, 22, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ffcf6a';
      ctx.fill();
      labelInfos.push({ id: 'sun', px, py, dotR: 9, color: '#ffcf6a', name: 'SUN' });
    }

    for (const b of drawOrder) {
      const pos = bodyPositions.get(b.id);
      if (!pos) continue;
      const [px, py] = pos;
      const meta = BODY_META[b.id] ?? { dotR: 4 };
      const dotR = meta.dotR;

      ctx.beginPath();
      ctx.arc(px, py, dotR, 0, Math.PI * 2);
      ctx.fillStyle = b.color ?? '#888';
      ctx.fill();

      // Highlight active body with a ring.
      if (b.id === activeId) {
        ctx.beginPath();
        ctx.arc(px, py, dotR + 4, 0, Math.PI * 2);
        ctx.strokeStyle = b.color ?? '#888';
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.6;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      labelInfos.push({ id: b.id, px, py, dotR, color: b.color ?? '#888', name: b.name });
    }

    // Draw labels with simple de-collision (nudge overlapping labels vertically).
    // Sort by body order for deterministic collision resolution.
    const LABEL_OFFSET_Y = 14; // default label below dot
    const placed = []; // { x, y1, y2 } = bounding boxes of placed labels

    ctx.font = '10px monospace';
    ctx.textAlign = 'left';

    for (const info of labelInfos) {
      const textW = info.name.length * 6 + 2;
      let labelX = info.px + info.dotR + 4;
      let labelY = info.py + 4;

      // Simple vertical nudge to avoid overlapping with nearby labels.
      let nudge = 0;
      for (const p of placed) {
        const overlapX = labelX < p.x2 && labelX + textW > p.x1;
        if (overlapX) {
          const overlapY = labelY - 10 < p.y2 && labelY > p.y1 - 10;
          if (overlapY) { nudge += 13; }
        }
      }
      labelY += nudge;

      placed.push({ x1: labelX, y1: labelY - 10, x2: labelX + textW, y2: labelY });
      ctx.fillStyle = info.color + 'cc'; // slightly dimmed
      ctx.fillText(info.name, labelX, labelY);
    }

    // ── 5. Captions ──────────────────────────────────────────────────────────
    ctx.textAlign = 'left';
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillText('SYSTEM · distances log-compressed', 16, H - 28);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillText(jdToDateStr(jd), W - 16, H - 28);

    // ── 6. Cross-hair on active body ─────────────────────────────────────────
    const activePt = bodyPositions.get(activeId);
    if (activePt) {
      const [ax, ay] = activePt;
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([3, 5]);
      // small cross
      ctx.beginPath(); ctx.moveTo(ax - 12, ay); ctx.lineTo(ax + 12, ay); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax, ay - 12); ctx.lineTo(ax, ay + 12); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  return {
    canvas,
    setActive,
    show,
    hide,
    draw,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    hitTest,
  };
}
