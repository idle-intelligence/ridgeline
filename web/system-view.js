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
 * Orbit paths: for each body, sample helioEcl(id, jd + k*period/N) for N=96
 * samples over one orbital period, apply same compression → real elliptical,
 * inclined paths in scene space. Cached; recomputed when jd drifts by >1 day.
 *
 * Camera: perspective, default ~25° above ecliptic plane. Sun placed off-centre
 * by offsetting the camera target. Drag = orbit (azimuth + elevation). Wheel =
 * dolly within scene (NOT alt — caller drives fade via altitude). The canvas
 * is pointer-events:none when hidden; caller enables it via show().
 *
 * API:
 *   createSystemView({ registry, helioPos, helioEcl, getJd, onEnterBody })
 *   → { canvas, setActive, show, hide, draw(jd), onWheel, onPointerDown,
 *        onPointerMove, onPointerUp, hitTest(x,y) }
 */

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

// ── Orbit period table (days) ────────────────────────────────────────────────
// Used to trace orbit paths. Source: ELEMENTS.a0^1.5 × 365.25 (Kepler 3rd law),
// or well-known periods for moons/dwarfs.
const ORBIT_PERIOD_DAYS = {
  mercury:   88,
  venus:    225,
  earth:    365.25,
  mars:     687,
  ceres:   1682,
  vesta:   1325,
  jupiter: 4333,
  saturn: 10759,
  pluto:  90560,
  moon:      27.32,
  charon:     6.387,
  enceladus:  1.370,
};

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

// ── 3D perspective projection ─────────────────────────────────────────────────
// Camera defined by: eye position, target, up vector.
// We orbit the camera around a target (near the barycentre, offset from Sun for
// off-centre framing). Azimuth (yaw around ecliptic Z), elevation (pitch above plane).

function makePerspCamera(azimuth, elevation, dolly, targetX, targetY, targetZ) {
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
  const rx = fy*uz - fz*uy;
  const ry = fz*ux - fx*uz;
  const rz = fx*uy - fy*ux;

  return {
    eye: [eyeX, eyeY, eyeZ],
    fwd: [fx, fy, fz],
    up:  [ux, uy, uz],
    right: [rx, ry, rz],
    // Project a scene [x,y,z] → NDC [cx,cy,depth] or null if behind camera.
    project(x, y, z, aspect, fovY) {
      const dx = x - eyeX, dy = y - eyeY, dz = z - eyeZ;
      const projX = dx*rx + dy*ry + dz*rz;   // screen right
      const projY = dx*ux + dy*uy + dz*uz;   // screen up
      const projZ = dx*fx + dy*fy + dz*fz;   // into screen (depth)
      if (projZ <= 0.001) return null;
      const tanHalfFov = Math.tan(fovY / 2);
      const ndcX =  projX / (projZ * tanHalfFov * aspect);
      const ndcY =  projY / (projZ * tanHalfFov);
      return [ndcX, ndcY, projZ];
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

// ── Orbit path cache ──────────────────────────────────────────────────────────
const PATH_CACHE = new Map();
const PATH_RECOMPUTE_INTERVAL = 1.0; // days
const PATH_N = 96;                   // samples per orbit

// ── createSystemView ──────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array}    opts.registry    — Body objects (id, name, color)
 * @param {function} opts.helioPos    — helioPos(id, jd) → [x,y,z] AU heliocentric ecliptic
 * @param {function} opts.helioEcl   — helioEcl(id, jd) → [x,y,z] AU (planets only, for orbit paths)
 * @param {function} opts.getJd      — () → current Julian date
 * @param {function} opts.onEnterBody — (bodyId: string) → void
 */
export function createSystemView({ registry, helioPos, helioEcl, getJd, onEnterBody }) {
  // ── Canvas setup ─────────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.id = 'sys';
  canvas.style.cssText = 'position:fixed;inset:0;display:none;opacity:0;z-index:8;'
    + 'width:100vw;height:100vh;pointer-events:none;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  // ── Camera state ─────────────────────────────────────────────────────────────
  // Azimuth around ecliptic Z (yaw), elevation above the plane (pitch).
  // Default: ~25° above ecliptic, slight azimuth for visual interest.
  let azimuth   = -0.4;                      // rad
  let elevation = 25 * Math.PI / 180;        // rad — ~25° above ecliptic
  let dolly     = 1.6;                       // camera distance from target (scene units)

  // Off-centre target: shift camera target in ecliptic X so the Sun appears at ~35%
  // from left. In scene units (PLOT_R=1.0): shift target by +0.20 in X so eye is
  // pushed right relative to the Sun, placing the Sun toward the left.
  const CAM_TARGET_X = 0.20;
  const CAM_TARGET_Y = 0.0;
  const CAM_TARGET_Z = 0.0;

  const FOV_Y = 45 * Math.PI / 180;

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

  // ── NDC → pixel ──────────────────────────────────────────────────────────────
  function ndcToPixel(ndcX, ndcY, W, H) {
    return [
      (ndcX * 0.5 + 0.5) * W,
      (1 - (ndcY * 0.5 + 0.5)) * H,
    ];
  }

  // Project a scene-space [x,y,z] (already compressed) to canvas pixel + depth, or null.
  function projectScene(sx, sy, sz, cam, W, H) {
    const aspect = W / H;
    const r = cam.project(sx, sy, sz, aspect, FOV_Y);
    if (!r) return null;
    const [px, py] = ndcToPixel(r[0], r[1], W, H);
    return [px, py, r[2]]; // z = depth
  }

  // ── Hit testing ──────────────────────────────────────────────────────────────
  const bodyPositions = new Map(); // id → [px, py]

  function hitTest(px, py) {
    let bestId = null, bestDist = 20;
    for (const [id, [bx, by]] of bodyPositions) {
      const d = Math.hypot(px - bx, py - by);
      if (d < bestDist) { bestDist = d; bestId = id; }
    }
    return bestId;
  }

  // ── Drag (camera orbit) ───────────────────────────────────────────────────────
  let _ptrDown = false, _ptrX = 0, _ptrY = 0;

  function onPointerDown(e) {
    _ptrDown = true;
    _ptrX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    _ptrY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
  }
  function onPointerMove(e) {
    if (!_ptrDown) return;
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const y = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
    const dx = x - _ptrX, dy = y - _ptrY;
    _ptrX = x; _ptrY = y;
    azimuth   += dx * 0.007;
    elevation  = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05,
                   elevation - dy * 0.005));
  }
  function onPointerUp() { _ptrDown = false; }

  function onWheel(e) {
    // Dolly camera in/out within the scene. Returns current dolly (caller does NOT use
    // this to control altitude — that's driven by explore.js wheel handler directly).
    const factor = Math.pow(0.92, e.deltaY / 100);
    dolly = Math.max(0.5, Math.min(5.0, dolly * factor));
    return dolly;
  }

  // ── Orbit path building ───────────────────────────────────────────────────────
  // Moons orbit too close to their parent to be visible at solar-system scale; skip.
  const MOON_IDS = new Set(['moon', 'charon', 'enceladus']);

  function buildOrbitPath(bodyId, jd) {
    if (MOON_IDS.has(bodyId)) return null;
    const period = ORBIT_PERIOD_DAYS[bodyId];
    if (!period) return null;

    // Test that helioEcl works for this body (only defined for planets in ELEMENTS).
    try { helioEcl(bodyId, jd); } catch (_) { return null; }

    const points = [];
    for (let k = 0; k < PATH_N; k++) {
      const t = jd + (k / PATH_N) * period;
      try {
        const [x, y, z] = helioEcl(bodyId, t);
        const rAU = Math.hypot(x, y, z);
        if (rAU < 1e-12) { points.push([0, 0, 0]); continue; }
        const dr = compressAU(rAU) * PLOT_R;
        points.push([(x/rAU)*dr, (y/rAU)*dr, (z/rAU)*dr]);
      } catch (_) { break; }
    }
    return points.length >= 3 ? points : null;
  }

  function getOrbitPath(bodyId, jd) {
    const cached = PATH_CACHE.get(bodyId);
    if (cached && Math.abs(jd - cached.jdBase) < PATH_RECOMPUTE_INTERVAL) {
      return cached.points3D;
    }
    const pts = buildOrbitPath(bodyId, jd);
    if (pts) PATH_CACHE.set(bodyId, { jdBase: jd, points3D: pts });
    return pts;
  }

  // ── Draw ──────────────────────────────────────────────────────────────────────
  function draw(jd) {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cam = makePerspCamera(azimuth, elevation, dolly, CAM_TARGET_X, CAM_TARGET_Y, CAM_TARGET_Z);

    // ── 1. Starfield ─────────────────────────────────────────────────────────
    for (const st of _stars) {
      ctx.beginPath();
      ctx.arc(st.nx * W, st.ny * H, st.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${st.a})`;
      ctx.fill();
    }

    // ── 2. Orbit paths ────────────────────────────────────────────────────────
    for (const b of registry) {
      if (b.id === 'sun' || MOON_IDS.has(b.id)) continue;
      const pts = getOrbitPath(b.id, jd);
      if (!pts || pts.length < 3) continue;

      ctx.beginPath();
      let started = false;
      for (let k = 0; k <= pts.length; k++) {
        const [sx, sy, sz] = pts[k % pts.length];
        const p = projectScene(sx, sy, sz, cam, W, H);
        if (!p) { started = false; continue; }
        if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
        else ctx.lineTo(p[0], p[1]);
      }
      // Don't closePath if some points were behind camera (avoids stray lines).
      ctx.strokeStyle = `${b.color}28`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }

    // ── 3. Compute body scene positions ───────────────────────────────────────
    bodyPositions.clear();
    // Map body id → scene [sx, sy, sz] for dot rendering.
    const bodyScenePos = new Map();

    for (const b of registry) {
      let auPos;
      try { auPos = helioPos(b.id, jd); } catch (_) { continue; }

      const rAU = Math.hypot(auPos[0], auPos[1], auPos[2]);
      let sx, sy, sz;
      if (rAU < 1e-12) {
        sx = 0; sy = 0; sz = 0; // Sun at origin
      } else {
        const dr = compressAU(rAU) * PLOT_R;
        sx = (auPos[0] / rAU) * dr;
        sy = (auPos[1] / rAU) * dr;
        sz = (auPos[2] / rAU) * dr;
      }

      // Moon small 3D offset so they don't perfectly coincide with parent.
      const off = MOON_SCENE_OFFSETS[b.id];
      if (off) { sx += off[0]; sy += off[1]; sz += off[2]; }

      bodyScenePos.set(b.id, [sx, sy, sz]);
      const p = projectScene(sx, sy, sz, cam, W, H);
      if (p) bodyPositions.set(b.id, [p[0], p[1]]);
    }

    // ── 4. Sun glow (before other bodies so dots overdraw it) ─────────────────
    {
      const sunP = bodyPositions.get('sun');
      if (sunP) {
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

    // ── 5. Body dots + labels ─────────────────────────────────────────────────
    const labelInfos = [];

    // Sun label entry
    const sunP = bodyPositions.get('sun');
    if (sunP) labelInfos.push({ id:'sun', px:sunP[0], py:sunP[1], dotR:10, color:'#ffcf6a', name:'SUN' });

    for (const b of registry) {
      if (b.id === 'sun') continue;
      const pos = bodyPositions.get(b.id);
      if (!pos) continue;
      const [px, py] = pos;
      const meta = BODY_META[b.id] ?? { dotR: 3.5 };
      const dotR = meta.dotR;
      const color = b.color ?? '#888';

      ctx.beginPath();
      ctx.arc(px, py, dotR, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // Active body ring
      if (b.id === activeId) {
        ctx.beginPath();
        ctx.arc(px, py, dotR + 5, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.55;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      labelInfos.push({ id: b.id, px, py, dotR, color, name: b.name });
    }

    // Labels with simple de-collision
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    const placed = [];

    for (const info of labelInfos) {
      const textW = info.name.length * 6 + 4;
      const labelX = info.px + info.dotR + 5;
      let labelY = info.py + 4;

      for (const p of placed) {
        const xOverlap = labelX < p.x2 && labelX + textW > p.x1;
        if (xOverlap) {
          const yOverlap = labelY - 10 < p.y2 && labelY > p.y1 - 10;
          if (yOverlap) labelY = p.y2 + 13;
        }
      }
      placed.push({ x1: labelX, y1: labelY - 10, x2: labelX + textW, y2: labelY });
      ctx.fillStyle = info.color + 'cc';
      ctx.fillText(info.name, labelX, labelY);
    }

    // ── 6. Active body crosshair ──────────────────────────────────────────────
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

    // ── 7. Caption ────────────────────────────────────────────────────────────
    ctx.textAlign = 'left';
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillText('SYSTEM · log-compressed distances', 16, H - 28);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillText(jdToDateStr(jd), W - 16, H - 28);
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
