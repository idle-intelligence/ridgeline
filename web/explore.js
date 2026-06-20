import { WebGPURenderer } from './renderer-webgpu.js';

const R_WORLD = 6000.0;
const FOV_Y = Math.PI / 4;    // 45° — matches core
const Z_NEAR = 1.0;
const Z_FAR = 200_000.0;
const M_PER_WU = 6371000 / 6000;
const EARTH_ROT_DEG_PER_SEC = 360 / 86400;

// ── Camera state ─────────────────────────────────────────────────────────────
let lat = 20.0;           // degrees — satellite ground-track latitude
let lon = 15.0;           // degrees — satellite ground-track longitude (pre-rotation)
let altitude = 300.0;     // world units above sea level (~320 km)
let tilt = Math.PI / 4;   // radians off nadir: 0=top-down, π/2=horizon, craft feel ≈ π/4
let heading = Math.PI / 2; // radians: 0=north, π/2=east (terrain approaches from front as planet rotates)
let planetRot = 0.0;      // degrees planet has rotated since start
let timeSpeed = 1000;     // × real time — terrain visibly scrolls at 1000×

// ── Input state ───────────────────────────────────────────────────────────────
let dragActive = false, dragHitPt = null, dragLatLon = null;
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
function vec3ToLatLon(v) {
  return [Math.asin(Math.max(-1,Math.min(1,v[1])))*180/Math.PI, Math.atan2(-v[2],v[0])*180/Math.PI];
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

function veForAlt(alt) {
  const t = Math.max(0, Math.min(1, (alt-100)/(5000-100)));
  return 2.75 + (14.0-2.75)*t*t*(3-2*t);
}

// ── Camera ────────────────────────────────────────────────────────────────────
// Build view+proj from an arbitrary world-space position and tilt/heading.
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
  const view = mat4LookAt(pos, add(pos, scale(lookDir, 10000)), up);
  const proj = mat4Perspective(FOV_Y, aspect, Z_NEAR, Z_FAR);
  return { lookDir, up, mvp: mat4Mul(proj, view) };
}

// Satellite camera: positioned at (lat, lon, altitude), looking tiltR radians
// off nadir toward headR direction. As planetRot grows, terrain scrolls under.
// starMvp uses the inertially-fixed position (no planetRot) so stars don't rotate.
function computeCamera(latD, lonD, alt, tiltR, headR, aspect) {
  const pos = spherePt(latD, lonD - planetRot, R_WORLD + alt); // planet rotates under camera
  const { lookDir, up, mvp } = _buildCamMvp(pos, tiltR, headR, aspect);

  // Star camera: same altitude/tilt/heading but at the inertially-fixed longitude
  // so the starfield stays locked to world space as the planet rotates beneath us.
  const fixedPos = spherePt(latD, lonD, R_WORLD + alt);
  const { mvp: starMvp } = _buildCamMvp(fixedPos, tiltR, headR, aspect);

  return { pos, fwd: lookDir, up, mvp, starMvp, ve: veForAlt(alt) };
}

function makeProxy(cam) {
  return {
    view_proj:       () => cam.mvp,
    camera_position: () => new Float32Array(cam.pos),
    cam_forward:     () => new Float32Array(cam.fwd),
    current_ve:      () => cam.ve,
    model_matrix:    () => null,
    star_view_proj:  () => cam.starMvp,  // inertially-fixed: stars don't rotate with planet
  };
}

// ── HUD ───────────────────────────────────────────────────────────────────────
const COMPASS = ['N','NE','E','SE','S','SW','W','NW'];
function hudText(alt, latD, lonD, tiltR, headR) {
  const altKm = Math.round(alt * M_PER_WU / 1000);
  const ns = latD >= 0 ? 'N' : 'S', ew = lonD >= 0 ? 'E' : 'W';
  const normLon = ((lonD%360)+360)%360;
  const dispLon = normLon > 180 ? normLon-360 : normLon;
  const mode = alt < 50 ? 'SURFACE' : alt < 1500 ? 'ATMO' : alt < 12000 ? 'ORBIT' : 'DEEP SPACE';
  const spd = timeSpeed === 0 ? '⏸' : timeSpeed < 1 ? timeSpeed+'×' : timeSpeed >= 1000 ? (timeSpeed/1000).toFixed(0)+'k×' : timeSpeed+'×';
  const headDeg = ((headR*180/Math.PI)%360+360)%360;
  const compassIdx = Math.round(headDeg/45) % 8;
  const tiltDeg = Math.round(tiltR*180/Math.PI);
  return `${Math.abs(latD).toFixed(2)}°${ns}  ${Math.abs(dispLon).toFixed(2)}°${ew}`
    + `\nALT ${altKm.toLocaleString()} km  ${mode}`
    + `\nTILT ${tiltDeg}°  HDG ${COMPASS[compassIdx]}`
    + `\nTIME ${spd}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const canvas = document.getElementById('c');
  const showErr = () => { document.getElementById('nowgpu').style.display='block'; };

  if (!navigator.gpu) { showErr(); return; }

  let meta, hfBuf;
  try {
    [meta, hfBuf] = await Promise.all([
      fetch('../data/meta.json').then(r => r.json()),
      fetch('../data/heightfield.bin').then(r => r.arrayBuffer()),
    ]);
  } catch (e) { showErr(); return; }

  // Init WASM (needed for heightfield upload to GPU via existing create() path)
  let eng, wasmMemory;
  try {
    const { default: initWasm, Engine } = await import('./pkg/ridgeline_core.js');
    const wasm = await initWasm();
    wasmMemory = wasm.memory;
    const { bbox } = meta;
    eng = new Engine(
      meta.width, meta.height,
      new Uint8Array(hfBuf),
      meta.elev_min, meta.elev_max,
      bbox.lat_min, bbox.lat_max, bbox.lon_min, bbox.lon_max,
    );
    hfBuf = null; // GC raw bytes; WASM retains its int16 copy
  } catch (e) { console.error('[explore] WASM:', e); showErr(); return; }

  let renderer;
  try {
    renderer = await WebGPURenderer.create(canvas, eng, wasmMemory);
  } catch (e) { console.error('[explore] WebGPU:', e); showErr(); return; }

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

  const getAspect = () => canvas.width / canvas.height;
  const getCam = () => computeCamera(lat, lon, altitude, tilt, heading, getAspect());

  // ── Mouse controls ────────────────────────────────────────────────────────
  // Left drag  = orbit (trackball lat/lon)
  // Right drag = tilt (vertical) + heading (horizontal)
  // Scroll     = altitude (up=zoom in, down=zoom out)
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('mousedown', e => {
    if (e.button === 2) {
      rightDragActive = true;
      rdStartX = e.clientX; rdStartY = e.clientY;
      rdStartTilt = tilt; rdStartHeading = heading;
      return;
    }
    const cam = getCam();
    const ray = pixelRay(e.clientX, e.clientY, canvas.width, canvas.height, getAspect(), cam.fwd, cam.up);
    const hit = raySphere(cam.pos, ray, R_WORLD);
    dragActive = true;
    dragHitPt = hit ? normalize(hit) : null;
    dragLatLon = [lat, lon];
    prevX = e.clientX; prevY = e.clientY;
  });

  window.addEventListener('mousemove', e => {
    if (rightDragActive) {
      tilt    = Math.max(0.02, Math.min(Math.PI*0.45, rdStartTilt    + (e.clientY-rdStartY)*0.005));
      heading = rdStartHeading + (e.clientX-rdStartX)*0.005;
      return;
    }
    if (!dragActive) return;
    const cam = getCam();
    const cw = canvas.width, ch = canvas.height;
    const ray = pixelRay(e.clientX, e.clientY, cw, ch, getAspect(), cam.fwd, cam.up);
    const hit = raySphere(cam.pos, ray, R_WORLD);
    if (hit && dragHitPt) {
      const newDir = normalize(hit);
      const sinA = Math.min(1, Math.hypot(...cross(newDir, dragHitPt)));
      const cosA = dot(newDir, dragHitPt);
      if (Math.abs(sinA) > 0.0001) {
        const axis = normalize(cross(newDir, dragHitPt));
        const angle = Math.atan2(sinA, cosA);
        const startDir = normalize(spherePt(dragLatLon[0], dragLatLon[1]-planetRot, 1));
        const rotated = rodrigues(startDir, axis, angle);
        [lat, lon] = vec3ToLatLon(rotated);
        lon += planetRot;
      }
    } else {
      const sens = (FOV_Y*180/Math.PI) / canvas.height;
      lat = Math.max(-85, Math.min(85, lat+(e.clientY-prevY)*sens));
      lon -= (e.clientX-prevX)*sens / Math.max(0.05, Math.cos(lat*Math.PI/180));
    }
    prevX = e.clientX; prevY = e.clientY;
  });

  window.addEventListener('mouseup', e => {
    if (e.button === 2) rightDragActive = false;
    else dragActive = false;
  });

  // scroll UP (deltaY < 0) = zoom in = lower altitude
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    altitude = Math.max(2, Math.min(100_000, altitude * Math.pow(0.85, -e.deltaY / 100)));
  }, { passive: false });

  // ── Touch controls ────────────────────────────────────────────────────────
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const cam = getCam();
      const ray = pixelRay(t.clientX, t.clientY, canvas.width, canvas.height, getAspect(), cam.fwd, cam.up);
      const hit = raySphere(cam.pos, ray, R_WORLD);
      dragActive = true;
      dragHitPt = hit ? normalize(hit) : null;
      dragLatLon = [lat, lon];
      prevX = t.clientX; prevY = t.clientY;
    } else if (e.touches.length === 2) {
      dragActive = false;
      lastPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1 && dragActive) {
      const t = e.touches[0];
      const cam = getCam();
      const ray = pixelRay(t.clientX, t.clientY, canvas.width, canvas.height, getAspect(), cam.fwd, cam.up);
      const hit = raySphere(cam.pos, ray, R_WORLD);
      if (hit && dragHitPt) {
        const newDir = normalize(hit);
        const sinA = Math.min(1, Math.hypot(...cross(newDir, dragHitPt)));
        const cosA = dot(newDir, dragHitPt);
        if (Math.abs(sinA) > 0.0001) {
          const axis = normalize(cross(newDir, dragHitPt));
          const angle = Math.atan2(sinA, cosA);
          const startDir = normalize(spherePt(dragLatLon[0], dragLatLon[1]-planetRot, 1));
          const rotated = rodrigues(startDir, axis, angle);
          [lat, lon] = vec3ToLatLon(rotated);
          lon += planetRot;
        }
      } else {
        const sens = (FOV_Y*180/Math.PI) / canvas.height;
        lat = Math.max(-85, Math.min(85, lat+(t.clientY-prevY)*sens));
        lon -= (t.clientX-prevX)*sens / Math.max(0.05, Math.cos(lat*Math.PI/180));
      }
      prevX = t.clientX; prevY = t.clientY;
    } else if (e.touches.length === 2) {
      const newDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      if (lastPinchDist > 0) {
        // pinch fingers together (newDist < lastPinchDist) = zoom in = lower altitude
        altitude = Math.max(2, Math.min(100_000, altitude * newDist / lastPinchDist));
      }
      lastPinchDist = newDist;
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
    planetRot = (planetRot + timeSpeed * dt * EARTH_ROT_DEG_PER_SEC) % 360;
    const cam = computeCamera(lat, lon, altitude, tilt, heading, getAspect());
    renderer.draw(makeProxy(cam), null);
    document.getElementById('info').textContent = hudText(altitude, lat, lon, tilt, heading);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch(e => { console.error('[explore]', e); document.getElementById('nowgpu').style.display='block'; });
