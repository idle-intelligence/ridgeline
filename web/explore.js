import { WebGPURenderer } from './renderer-webgpu.js';

const R_WORLD = 6000.0;
const FOV_Y = Math.PI / 4;    // 45° — matches core
const Z_NEAR = 1.0;
const Z_FAR = 200_000.0;
const EARTH_ROT_DEG_PER_SEC = 360 / 86400;       // sidereal-ish day
const MOON_ROT_DEG_PER_SEC = 360 / (27.32 * 86400); // tidally locked = orbital period
const SYS_DEG_PER_SEC = 360 / (27.32 * 86400);   // orbital angle driving the sky marker

// ── Bodies ───────────────────────────────────────────────────────────────────
// Each body is one explorable globe. The renderer renders the ACTIVE body centered
// at the origin; the OTHER body is shown as a clickable marker in the sky.
const BODIES = {
  earth: {
    name: 'EARTH', other: 'moon', color: '#6aa3ff',
    rotDegPerSec: EARTH_ROT_DEG_PER_SEC,
    veFactor: 1.0,
    mPerWu: 6371000 / R_WORLD,
    modes: [[50,'SURFACE'],[1500,'ATMO'],[12000,'ORBIT'],[Infinity,'DEEP SPACE']],
  },
  moon: {
    name: 'MOON', other: 'earth', color: '#cfd2d8',
    rotDegPerSec: MOON_ROT_DEG_PER_SEC,
    veFactor: 1.0,            // same exaggeration treatment as Earth (tune for taste)
    mPerWu: 1737400 / R_WORLD,
    modes: [[50,'SURFACE'],[1500,'LOW'],[12000,'ORBIT'],[Infinity,'DEEP SPACE']],
  },
};

// ── Active camera state (mirrors the current body; saved/restored on jump) ─────
let current = 'earth';
let gpos = spherePtUnit(20.0, 15.0); // planet-fixed unit vector under the satellite
let altitude = 600.0;
let tilt = Math.PI / 4;
let heading = Math.PI / 2;
let planetRot = 0.0;
let timeSpeed = 1000;
let systemClock = 0.0;       // orbital angle (deg) for the sky marker

// Per-body saved state so jumping back restores your view.
const camStore = {
  earth: { gpos: spherePtUnit(20.0, 15.0), altitude: 600, tilt: Math.PI/4, heading: Math.PI/2, planetRot: 0 },
  moon:  { gpos: spherePtUnit(0.0, 0.0),   altitude: 500, tilt: Math.PI/4, heading: Math.PI/2, planetRot: 0 },
};

// ── Input state ───────────────────────────────────────────────────────────────
let dragActive = false, dragTurn = false;
let dragHitPt = null, dragStartWorld = null;
let prevX = 0, prevY = 0;
let rightDragActive = false, rdStartX = 0, rdStartY = 0, rdStartTilt = 0, rdStartHeading = 0;
let lastPinchDist = 0;

// ── Math helpers ─────────────────────────────────────────────────────────────
const normalize = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const add = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
const scale = (a, s) => [a[0]*s, a[1]*s, a[2]*s];

function mat4LookAt(eye, center, up) {
  let f = normalize(sub(center, eye));
  let r = normalize(cross(f, up));
  let u = cross(r, f);
  return new Float32Array([
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -dot(r,eye), -dot(u,eye), dot(f,eye), 1,
  ]);
}
function mat4Perspective(fovY, aspect, near, far) {
  const f = 1/Math.tan(fovY/2), nf = 1/(near-far);
  return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
}
function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let i=0;i<4;i++) for (let j=0;j<4;j++) for (let k=0;k<4;k++) o[j*4+i]+=a[k*4+i]*b[j*4+k];
  return o;
}

function spherePt(latDeg, lonDeg, r) {
  const phi = latDeg*Math.PI/180, lam = lonDeg*Math.PI/180;
  return [r*Math.cos(phi)*Math.cos(lam), r*Math.sin(phi), -r*Math.cos(phi)*Math.sin(lam)];
}
function spherePtUnit(latDeg, lonDeg) { return spherePt(latDeg, lonDeg, 1); }
function vec3ToLatLon(v) {
  return [Math.asin(Math.max(-1,Math.min(1,v[1])))*180/Math.PI, Math.atan2(-v[2],v[0])*180/Math.PI];
}
function rotateY(v, deg) {
  const t = deg*Math.PI/180, c = Math.cos(t), s = Math.sin(t);
  return [v[0]*c + v[2]*s, v[1], -v[0]*s + v[2]*c];
}
function rodrigues(v, axis, angle) {
  const c=Math.cos(angle), s=Math.sin(angle);
  return add(add(scale(v,c), scale(cross(axis,v),s)), scale(axis, dot(axis,v)*(1-c)));
}
function raySphere(origin, dir, radius) {
  const b = 2*dot(origin,dir), c = dot(origin,origin)-radius*radius;
  const disc = b*b-4*c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / 2;
  return t > 0.001 ? add(origin, scale(dir, t)) : null;
}
function pixelRay(px, py, cw, ch, aspect, camFwd, camUp) {
  const tanH = Math.tan(FOV_Y/2), ndcX=(px/cw)*2-1, ndcY=1-(py/ch)*2;
  const right = normalize(cross(camFwd, camUp));
  return normalize(add(add(camFwd, scale(right, ndcX*aspect*tanH)), scale(camUp, ndcY*tanH)));
}
// Project a world point through a column-major mvp → screen px, or null if off-screen/behind.
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

// ── Camera ────────────────────────────────────────────────────────────────────
function _buildCamMvp(pos, tiltR, headR, aspect) {
  const radial = normalize(pos);
  const northRaw = [0, 1, 0];
  const northProj = sub(northRaw, scale(radial, dot(northRaw, radial)));
  const northLen = Math.hypot(...northProj);
  const northDir = northLen < 0.01 ? normalize(cross(radial, [1,0,0])) : normalize(northProj);
  const eastDir = normalize(cross(northDir, radial));
  const headFwd = add(scale(northDir, Math.cos(headR)), scale(eastDir, Math.sin(headR)));
  const safeTilt = Math.max(0.05, Math.min(Math.PI * 0.45, tiltR));
  const nadir = scale(radial, -1);
  const lookDir = normalize(add(scale(nadir, Math.cos(safeTilt)), scale(headFwd, Math.sin(safeTilt))));
  const upRaw = sub(radial, scale(lookDir, dot(radial, lookDir)));
  const up = Math.hypot(...upRaw) < 0.001 ? scale(headFwd,-1) : normalize(upRaw);
  const right = normalize(cross(lookDir, up));
  const view = mat4LookAt(pos, add(pos, scale(lookDir, 10000)), up);
  const proj = mat4Perspective(FOV_Y, aspect, Z_NEAR, Z_FAR);
  return { lookDir, up, right, mvp: mat4Mul(proj, view) };
}

function computeCamera(g, alt, tiltR, headR, aspect, veFactor) {
  const worldDir = rotateY(g, -planetRot);
  const pos = scale(worldDir, R_WORLD + alt);
  const { lookDir, up, right, mvp } = _buildCamMvp(pos, tiltR, headR, aspect);
  const fixedPos = scale(g, R_WORLD + alt);
  const { mvp: starMvp } = _buildCamMvp(fixedPos, tiltR, headR, aspect);
  return { pos, fwd: lookDir, up, right, mvp, starMvp, ve: veForAlt(alt) * veFactor, altWu: alt };
}

function makeProxy(cam) {
  return {
    view_proj:       () => cam.mvp,
    camera_position: () => new Float32Array(cam.pos),
    cam_forward:     () => new Float32Array(cam.fwd),
    current_ve:      () => cam.ve,
    model_matrix:    () => null,
    star_view_proj:  () => cam.starMvp,
    explore_alt:     () => cam.altWu,
  };
}

// ── HUD ───────────────────────────────────────────────────────────────────────
const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];
function hudText(alt, g, tiltR, headR) {
  const b = BODIES[current];
  const [latD, lonD] = vec3ToLatLon(g);
  const altKm = Math.round(alt * b.mPerWu / 1000);
  const ns = latD >= 0 ? 'N' : 'S', ew = lonD >= 0 ? 'E' : 'W';
  const normLon = ((lonD%360)+360)%360;
  const dispLon = normLon > 180 ? normLon-360 : normLon;
  let mode = b.modes[b.modes.length-1][1];
  for (const [ceil, label] of b.modes) { if (alt < ceil) { mode = label; break; } }
  const spd = timeSpeed === 0 ? '⏸' : timeSpeed < 1 ? timeSpeed+'×' : timeSpeed >= 1000 ? (timeSpeed/1000).toFixed(0)+'k×' : timeSpeed+'×';
  const headDeg = ((headR*180/Math.PI)%360+360)%360;
  const compassIdx = Math.round(headDeg/45) % 8;
  const tiltDeg = Math.round(tiltR*180/Math.PI);
  return `${b.name}  ${Math.abs(latD).toFixed(2)}°${ns}  ${Math.abs(dispLon).toFixed(2)}°${ew}`
    + `\nALT ${altKm.toLocaleString()} km  ${mode}`
    + `\nTILT ${tiltDeg}°  HDG ${COMPASS[compassIdx]}`
    + `\nTIME ${spd}`;
}

// Other body's world position (a far point along the orbital direction) — drives the marker.
function otherBodyWorldPos() {
  const a = systemClock * Math.PI / 180;
  const incl = 0.30;
  const dir = normalize([Math.cos(a), incl, -Math.sin(a)]);
  const D = 90000; // far but within Z_FAR
  return current === 'earth' ? scale(dir, D) : scale(dir, -D);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const canvas = document.getElementById('c');
  const showErr = () => { document.getElementById('nowgpu').style.display='block'; };

  if (!navigator.gpu) { showErr(); return; }

  let earthMeta, earthHf, moonMeta, moonHf;
  try {
    [earthMeta, earthHf, moonMeta, moonHf] = await Promise.all([
      fetch('../data/meta.json').then(r => r.json()),
      fetch('../data/heightfield.bin').then(r => r.arrayBuffer()),
      fetch('../data/moon_meta.json').then(r => r.json()),
      fetch('../data/moon_heightfield.bin').then(r => r.arrayBuffer()),
    ]);
  } catch (e) { console.error('[explore] data load:', e); showErr(); return; }

  let renderer;
  try {
    const { default: initWasm, Engine } = await import('./pkg/ridgeline_core.js');
    const wasm = await initWasm();
    const mem = wasm.memory;
    const mkEngine = (meta, hf) => {
      const { bbox } = meta;
      return new Engine(meta.width, meta.height, new Uint8Array(hf),
        meta.elev_min, meta.elev_max, bbox.lat_min, bbox.lat_max, bbox.lon_min, bbox.lon_max);
    };
    const earthEng = mkEngine(earthMeta, earthHf);
    renderer = await WebGPURenderer.create(canvas, earthEng, mem);
    BODIES.earth.handle = renderer.activeBody;

    // The moon Engine reuses the same WASM memory; build its GPU body, then we can free
    // the moon's CPU-side raw buffer (the Engine + GPU buffer retain their own copies).
    const moonEng = mkEngine(moonMeta, moonHf);
    BODIES.moon.handle = renderer.addBody(moonEng, mem);
  } catch (e) { console.error('[explore] init:', e); showErr(); return; }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    renderer.resize(canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize);
  resize();

  // Time speed buttons
  document.querySelectorAll('.tb').forEach(btn => {
    btn.addEventListener('click', () => {
      timeSpeed = parseFloat(btn.dataset.s);
      document.querySelectorAll('.tb').forEach(b => b.classList.toggle('on', b === btn));
    });
  });

  // ── Sky marker for the other body (click to jump) ──────────────────────────
  const marker = document.createElement('div');
  marker.id = 'bodymarker';
  marker.style.cssText =
    'position:fixed; display:none; transform:translate(-50%,-50%); cursor:pointer;'
    + ' font:11px monospace; color:#ccc; text-align:center; pointer-events:auto; z-index:5;';
  marker.innerHTML = '<div class="dot"></div><div class="lbl"></div>';
  document.body.appendChild(marker);
  const markerDot = marker.querySelector('.dot');
  const markerLbl = marker.querySelector('.lbl');
  markerDot.style.cssText = 'width:14px; height:14px; border-radius:50%; margin:0 auto 3px;'
    + ' border:1px solid #fff; box-shadow:0 0 8px rgba(255,255,255,0.4);';
  marker.addEventListener('click', () => jumpTo(BODIES[current].other));

  // Off-screen direction arrow: a chevron pinned to the screen edge pointing toward the
  // other body when it's outside the view (space is vast — this keeps it findable).
  const arrow = document.createElement('div');
  arrow.id = 'bodyarrow';
  arrow.style.cssText = 'position:fixed; display:none; transform:translate(-50%,-50%);'
    + ' cursor:pointer; text-align:center; z-index:5; pointer-events:auto;'
    + ' text-shadow:0 0 6px rgba(0,0,0,0.9);';
  arrow.innerHTML = '<span class="chev">➤</span><span class="albl"></span>';
  document.body.appendChild(arrow);
  const chev = arrow.querySelector('.chev');
  const albl = arrow.querySelector('.albl');
  chev.style.cssText = 'display:inline-block; font-size:20px; line-height:1;';
  albl.style.cssText = 'display:block; font:10px monospace; margin-top:2px;';
  arrow.addEventListener('click', () => jumpTo(BODIES[current].other));

  function jumpTo(name) {
    // Save current body's camera, restore the target's.
    Object.assign(camStore[current], { gpos, altitude, tilt, heading, planetRot });
    current = name;
    const s = camStore[name];
    gpos = s.gpos; altitude = s.altitude; tilt = s.tilt; heading = s.heading; planetRot = s.planetRot;
    renderer.useBody(BODIES[name].handle);
    dragActive = false; rightDragActive = false;
  }

  const getAspect = () => canvas.width / canvas.height;
  const getCam = () => computeCamera(gpos, altitude, tilt, heading, getAspect(), BODIES[current].veFactor);

  // ── Orbit drag (shared by mouse + touch), singularity-free vector math ──────
  function beginDrag(x, y) {
    const cam = getCam();
    const ray = pixelRay(x, y, canvas.width, canvas.height, getAspect(), cam.fwd, cam.up);
    const hit = raySphere(cam.pos, ray, R_WORLD);
    dragActive = true;
    dragTurn = !hit;
    dragHitPt = hit ? normalize(hit) : null;
    dragStartWorld = rotateY(gpos, -planetRot);
    prevX = x; prevY = y;
  }
  function moveDrag(x, y) {
    if (!dragActive) return;
    const cam = getCam();
    if (!dragTurn) {
      const ray = pixelRay(x, y, canvas.width, canvas.height, getAspect(), cam.fwd, cam.up);
      const hit = raySphere(cam.pos, ray, R_WORLD);
      if (hit) {
        const newDir = normalize(hit);
        const cr = cross(newDir, dragHitPt);
        const sinA = Math.min(1, Math.hypot(...cr));
        const cosA = dot(newDir, dragHitPt);
        if (sinA > 1e-4) {
          const axis = normalize(cr);
          const angle = Math.atan2(sinA, cosA);
          gpos = rotateY(rodrigues(dragStartWorld, axis, angle), planetRot);
        }
        prevX = x; prevY = y;
        return;
      }
      dragTurn = true;
    }
    const k = 0.004;
    let w = rotateY(gpos, -planetRot);
    w = rodrigues(w, cam.up, -(x - prevX) * k);
    w = rodrigues(w, cam.right, (y - prevY) * k);
    gpos = rotateY(w, planetRot);
    prevX = x; prevY = y;
  }

  // ── Mouse ───────────────────────────────────────────────────────────────────
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('mousedown', e => {
    if (e.button === 2) {
      rightDragActive = true;
      rdStartX = e.clientX; rdStartY = e.clientY; rdStartTilt = tilt; rdStartHeading = heading;
      return;
    }
    beginDrag(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', e => {
    if (rightDragActive) {
      tilt    = Math.max(0.02, Math.min(Math.PI*0.45, rdStartTilt + (e.clientY-rdStartY)*0.005));
      heading = rdStartHeading + (e.clientX-rdStartX)*0.005;
      return;
    }
    moveDrag(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', e => {
    if (e.button === 2) rightDragActive = false; else dragActive = false;
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    altitude = Math.max(2, Math.min(100_000, altitude * Math.pow(0.85, -e.deltaY / 100)));
  }, { passive: false });

  // ── Touch ───────────────────────────────────────────────────────────────────
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 1) beginDrag(e.touches[0].clientX, e.touches[0].clientY);
    else if (e.touches.length === 2) {
      dragActive = false;
      lastPinchDist = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1 && dragActive) moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    else if (e.touches.length === 2) {
      const nd = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
      if (lastPinchDist > 0) altitude = Math.max(2, Math.min(100_000, altitude * nd / lastPinchDist));
      lastPinchDist = nd;
    }
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    if (e.touches.length < 2) lastPinchDist = 0;
    if (e.touches.length === 0) dragActive = false;
  }, { passive: false });

  // ── Render loop ───────────────────────────────────────────────────────────
  let prev = performance.now();
  function frame(now) {
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;
    planetRot = (planetRot + timeSpeed * dt * BODIES[current].rotDegPerSec) % 360;
    systemClock = (systemClock + timeSpeed * dt * SYS_DEG_PER_SEC) % 360;

    const cam = computeCamera(gpos, altitude, tilt, heading, getAspect(), BODIES[current].veFactor);
    renderer.draw(makeProxy(cam), null);
    document.getElementById('info').textContent = hudText(altitude, gpos, tilt, heading);

    // Other body: on-screen → dot marker (hidden when the planet occludes it);
    // off-screen → edge arrow pointing toward it.
    const ob = BODIES[BODIES[current].other];
    const owp = otherBodyWorldPos();
    const cw = canvas.width, ch = canvas.height;
    const dd = sub(owp, cam.pos);
    const sf = dot(dd, cam.fwd), sx = dot(dd, cam.right), sy = dot(dd, cam.up);
    const occluded = !!raySphere(cam.pos, normalize(dd), R_WORLD);
    const sp = (sf > 0 && !occluded) ? projectToScreen(owp, cam.mvp, cw, ch) : null;
    const onScreen = sp && sp[0] >= 0 && sp[0] <= cw && sp[1] >= 0 && sp[1] <= ch;
    if (onScreen) {
      marker.style.display = 'block';
      marker.style.left = sp[0] + 'px';
      marker.style.top = sp[1] + 'px';
      markerDot.style.background = ob.color;
      markerLbl.textContent = '▸ ' + ob.name;
      markerLbl.style.color = ob.color;
      arrow.style.display = 'none';
    } else {
      marker.style.display = 'none';
      // Direction to the body in screen space (mirror when behind the camera).
      let ax = sx, ay = sy;
      if (sf <= 0) { ax = -ax; ay = -ay; }
      const ang = Math.atan2(-ay, ax); // screen y points down
      const dx = Math.cos(ang), dy = Math.sin(ang), m = 64;
      const t = Math.min(
        Math.abs(dx) > 1e-4 ? (cw/2 - m) / Math.abs(dx) : Infinity,
        Math.abs(dy) > 1e-4 ? (ch/2 - m) / Math.abs(dy) : Infinity,
      );
      arrow.style.display = 'block';
      arrow.style.left = (cw/2 + dx*t) + 'px';
      arrow.style.top = (ch/2 + dy*t) + 'px';
      chev.style.transform = `rotate(${ang*180/Math.PI}deg)`;
      chev.style.color = ob.color;
      albl.textContent = ob.name;
      albl.style.color = ob.color;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch(e => { console.error('[explore]', e); document.getElementById('nowgpu').style.display='block'; });
