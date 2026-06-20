import { WebGPURenderer } from './renderer-webgpu.js';

const R_WORLD = 6000.0;
const FOV_Y = Math.PI / 4;
const Z_NEAR = 1.0;
const Z_FAR = 200_000.0;
const M_PER_WU = 6371000 / 6000;
const EARTH_ROT_DEG_PER_SEC = 360 / 86400;

function veForAlt(alt) {
  const t = Math.max(0, Math.min(1, (alt - 100) / (5000 - 100)));
  return 2.75 + (14.0 - 2.75) * t * t * (3 - 2 * t);
}

function spherePt(latDeg, lonDeg, r) {
  const phi = latDeg * Math.PI / 180, lam = lonDeg * Math.PI / 180;
  return [r * Math.cos(phi) * Math.cos(lam), r * Math.sin(phi), -r * Math.cos(phi) * Math.sin(lam)];
}

function vec3ToLatLon(v) {
  const lat = Math.asin(Math.max(-1, Math.min(1, v[1]))) * 180 / Math.PI;
  const lon = Math.atan2(-v[2], v[0]) * 180 / Math.PI;
  return [lat, lon];
}

function normalize(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function scale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }

function mat4LookAt(eye, center, up) {
  let f = normalize(sub(center, eye));
  let r = normalize(cross(f, up));
  let u = cross(r, f);
  return new Float32Array([
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -dot(r, eye), -dot(u, eye), dot(f, eye), 1,
  ]);
}

function mat4Perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return new Float32Array([
    f/aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far+near)*nf, -1,
    0, 0, 2*far*near*nf, 0,
  ]);
}

function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++)
    o[j*4+i] += a[k*4+i] * b[j*4+k];
  return o;
}

function raySphere(origin, dir, radius) {
  const b = 2 * dot(origin, dir);
  const c = dot(origin, origin) - radius * radius;
  const disc = b*b - 4*c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / 2;
  return t > 0.001 ? add(origin, scale(dir, t)) : null;
}

function pixelRay(px, py, cw, ch, aspect, _camPos, camFwd, camUp) {
  const tanH = Math.tan(FOV_Y / 2);
  const ndcX = (px / cw) * 2 - 1, ndcY = 1 - (py / ch) * 2;
  const right = normalize(cross(camFwd, camUp));
  const d = normalize(add(add(camFwd, scale(right, ndcX * aspect * tanH)), scale(camUp, ndcY * tanH)));
  return d;
}

function rodrigues(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
}

let planetRot = 0;
let lat = 20.0, lon = 15.0, altitude = 8000.0, azimuth = 0.0;
let timeSpeed = 1;

let dragActive = false;
let dragHitPt = null;
let dragLatLon = null;
let prevX = 0, prevY = 0;
let lastPinchDist = 0;

function computeCamera(lat, lon, alt, azimuth, aspect) {
  const effectiveLon = lon - planetRot;
  const pos = spherePt(lat, effectiveLon, R_WORLD + alt);
  const radial = normalize(pos);

  let north = [0, 1, 0];
  const proj = sub(north, scale(radial, dot(north, radial)));
  const northLen = Math.hypot(...proj);
  const northDir = northLen < 0.01 ? normalize(cross(radial, [1, 0, 0])) : normalize(proj);

  const east = normalize(cross(northDir, radial));
  const up = add(scale(northDir, Math.cos(azimuth)), scale(east, Math.sin(azimuth)));
  const fwd = scale(radial, -1);
  const right = normalize(cross(fwd, up));

  const view = mat4LookAt(pos, [0, 0, 0], up);
  const proj4 = mat4Perspective(FOV_Y, aspect, Z_NEAR, Z_FAR);
  const mvp = mat4Mul(proj4, view);
  const ve = veForAlt(alt);

  return { pos, fwd, up, right, mvp, ve };
}

function makeProxy(cam) {
  return {
    view_proj:      () => cam.mvp,
    camera_position: () => new Float32Array(cam.pos),
    cam_forward:    () => new Float32Array(cam.fwd),
    current_ve:     () => cam.ve,
    model_matrix:   () => null,
  };
}

function hudText(alt, lat, lon) {
  const altKm = Math.round(alt * M_PER_WU / 1000);
  const ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
  const normLon = ((lon % 360) + 360) % 360;
  const dispLon = normLon > 180 ? normLon - 360 : normLon;
  const mode = alt < 50 ? 'SURFACE' : alt < 1500 ? 'ATMO' : alt < 12000 ? 'ORBIT' : 'DEEP SPACE';
  const speed = timeSpeed < 1 ? timeSpeed + '×' : timeSpeed >= 1000 ? (timeSpeed / 1000).toFixed(0) + 'k×' : timeSpeed + '×';
  return `${Math.abs(lat).toFixed(2)}°${ns}  ${Math.abs(dispLon).toFixed(2)}°${ew}\nALT ${altKm.toLocaleString()} km  ${mode}\nTIME ${speed}`;
}

async function main() {
  const canvas = document.getElementById('c');

  if (!navigator.gpu) {
    document.getElementById('nowgpu').style.display = 'block';
    return;
  }

  let meta, hfBuf;
  try {
    [meta, hfBuf] = await Promise.all([
      fetch('../data/meta.json').then(r => r.json()),
      fetch('../data/heightfield.bin').then(r => r.arrayBuffer()),
    ]);
  } catch (e) {
    document.getElementById('nowgpu').style.display = 'block';
    return;
  }

  // Init WASM for heightfield upload (reuse existing Engine class)
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
    hfBuf = null; // allow GC of raw bytes; WASM has its own copy
  } catch (e) {
    document.getElementById('nowgpu').style.display = 'block';
    console.error('[explore] WASM init failed:', e);
    return;
  }

  let renderer;
  try {
    renderer = await WebGPURenderer.create(canvas, eng, wasmMemory);
    renderer.resize(canvas.width, canvas.height);
  } catch (e) {
    document.getElementById('nowgpu').style.display = 'block';
    console.error('[explore] WebGPU init failed:', e);
    return;
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    renderer.resize(canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize);
  resize();

  document.querySelectorAll('.tb').forEach(btn => {
    btn.addEventListener('click', () => {
      timeSpeed = parseFloat(btn.dataset.s);
      document.querySelectorAll('.tb').forEach(b => b.classList.toggle('on', b === btn));
    });
  });

  function getAspect() { return canvas.width / canvas.height; }

  function getCam() { return computeCamera(lat, lon, altitude, azimuth, getAspect()); }

  canvas.addEventListener('mousedown', e => {
    const cam = getCam();
    const ray = pixelRay(e.clientX, e.clientY, canvas.width, canvas.height, getAspect(), cam.pos, cam.fwd, cam.up);
    const hit = raySphere(cam.pos, ray, R_WORLD);
    if (hit) {
      dragHitPt = normalize(hit);
      dragLatLon = [lat, lon];
      dragActive = true;
    } else {
      dragActive = true;
      dragHitPt = null;
      dragLatLon = [lat, lon];
    }
    prevX = e.clientX; prevY = e.clientY;
  });

  canvas.addEventListener('mousemove', e => {
    if (!dragActive) return;
    const cam = getCam();
    const cw = canvas.width, ch = canvas.height;
    const aspect = getAspect();
    const ray = pixelRay(e.clientX, e.clientY, cw, ch, aspect, cam.pos, cam.fwd, cam.up);
    const hit = raySphere(cam.pos, ray, R_WORLD);
    if (hit && dragHitPt) {
      const newDir = normalize(hit);
      const sinA = Math.min(1, Math.hypot(...cross(newDir, dragHitPt)));
      const cosA = dot(newDir, dragHitPt);
      if (Math.abs(sinA) > 0.0001) {
        const axis = normalize(cross(newDir, dragHitPt));
        const angle = Math.atan2(sinA, cosA);
        const startDir = normalize(spherePt(dragLatLon[0], dragLatLon[1] - planetRot, 1));
        const rotated = rodrigues(startDir, axis, angle);
        [lat, lon] = vec3ToLatLon(rotated);
        lon += planetRot;
      }
    } else {
      const sens = (FOV_Y * 180 / Math.PI) / ch;
      lat = Math.max(-85, Math.min(85, lat + (e.clientY - prevY) * sens));
      lon -= (e.clientX - prevX) * sens / Math.max(0.05, Math.cos(lat * Math.PI / 180));
    }
    prevX = e.clientX; prevY = e.clientY;
  });

  window.addEventListener('mouseup', () => { dragActive = false; });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    altitude = Math.max(2, Math.min(100_000, altitude * Math.pow(0.85, e.deltaY / 100)));
  }, { passive: false });

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const cam = getCam();
      const ray = pixelRay(t.clientX, t.clientY, canvas.width, canvas.height, getAspect(), cam.pos, cam.fwd, cam.up);
      const hit = raySphere(cam.pos, ray, R_WORLD);
      dragActive = true;
      dragHitPt = hit ? normalize(hit) : null;
      dragLatLon = [lat, lon];
      prevX = t.clientX; prevY = t.clientY;
    } else if (e.touches.length === 2) {
      dragActive = false;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      lastPinchDist = Math.hypot(dx, dy);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1 && dragActive) {
      const t = e.touches[0];
      const cam = getCam();
      const cw = canvas.width, ch = canvas.height;
      const ray = pixelRay(t.clientX, t.clientY, cw, ch, getAspect(), cam.pos, cam.fwd, cam.up);
      const hit = raySphere(cam.pos, ray, R_WORLD);
      if (hit && dragHitPt) {
        const newDir = normalize(hit);
        const sinA = Math.min(1, Math.hypot(...cross(newDir, dragHitPt)));
        const cosA = dot(newDir, dragHitPt);
        if (Math.abs(sinA) > 0.0001) {
          const axis = normalize(cross(newDir, dragHitPt));
          const angle = Math.atan2(sinA, cosA);
          const startDir = normalize(spherePt(dragLatLon[0], dragLatLon[1] - planetRot, 1));
          const rotated = rodrigues(startDir, axis, angle);
          [lat, lon] = vec3ToLatLon(rotated);
          lon += planetRot;
        }
      } else {
        const sens = (FOV_Y * 180 / Math.PI) / ch;
        lat = Math.max(-85, Math.min(85, lat + (t.clientY - prevY) * sens));
        lon -= (t.clientX - prevX) * sens / Math.max(0.05, Math.cos(lat * Math.PI / 180));
      }
      prevX = t.clientX; prevY = t.clientY;
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const newDist = Math.hypot(dx, dy);
      if (lastPinchDist > 0) {
        altitude = Math.max(2, Math.min(100_000, altitude * lastPinchDist / newDist));
      }
      lastPinchDist = newDist;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    if (e.touches.length < 2) lastPinchDist = 0;
    if (e.touches.length === 0) dragActive = false;
  }, { passive: false });

  let prev = performance.now();

  function frame(now) {
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;

    planetRot = (planetRot + timeSpeed * dt * EARTH_ROT_DEG_PER_SEC) % 360;

    const cam = computeCamera(lat, lon, altitude, azimuth, getAspect());
    renderer.draw(makeProxy(cam), null);
    document.getElementById('info').textContent = hudText(altitude, lat, lon);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(e => {
  console.error('[explore]', e);
  document.getElementById('nowgpu').style.display = 'block';
});
