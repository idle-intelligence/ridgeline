// ridgeline — main bootstrap.
// Toggle USE_MOCK to false once web/pkg/ is built by the core agent.
const USE_MOCK = false;

import { Renderer } from './renderer.js';
import { InputHandler } from './input.js';

const canvas  = document.getElementById('c');
const overlay = document.getElementById('overlay');
const hud     = document.getElementById('hud');

function fatal(msg, hint = '') {
  overlay.innerHTML = `<p class="err">${msg}</p>${hint ? `<p class="hint">${hint}</p>` : ''}`;
  overlay.style.display = 'flex';
  throw new Error(msg);
}

// --- asset loading ---

async function fetchBinary(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return r.json();
}

// --- engine factory ---

async function buildEngine(meta, hfBytes, wmBytes) {
  if (USE_MOCK) {
    const { makeMockEngine } = await import('./mock-engine.js');
    const { bbox } = meta;
    return makeMockEngine(
      meta.width, meta.height,
      hfBytes, wmBytes,
      meta.elev_min, meta.elev_max,
      bbox.lat_min, bbox.lat_max, bbox.lon_min, bbox.lon_max,
    );
  }

  // Real wasm path — production
  let initWasm, Engine;
  try {
    ({ default: initWasm, Engine } = await import('./pkg/ridgeline_core.js'));
  } catch (e) {
    fatal('Could not load WASM module.', 'Make sure web/pkg/ has been built: wasm-pack build --target web');
  }
  try {
    await initWasm();
  } catch (e) {
    fatal('WASM init failed.', e.message);
  }
  const { bbox } = meta;
  return new Engine(
    meta.width, meta.height,
    hfBytes, wmBytes,
    meta.elev_min, meta.elev_max,
    bbox.lat_min, bbox.lat_max, bbox.lon_min, bbox.lon_max,
  );
}

// --- URL params ---

// Meters of real surface per world unit (mirrors core heightfield::M_PER_WU).
const M_PER_WU = 6371000 / 6000; // ≈ 1061.8

// Defaults mirror the core's default spawn (lower in-atmosphere cruise over the Med).
const DEFAULT_SPAWN = { lat: 38.0, lon: 8.0, altWu: 250.0, heading: 0.0 };

// Safe altitude band (world units above the sea-level sphere): above the surface,
// below escaping to deep space. ~10 wu (≈10.6 km) up to ~12000 wu (≈12740 km).
const ALT_WU_MIN = 10.0;
const ALT_WU_MAX = 12000.0;

function num(params, key) {
  if (!params.has(key)) return null;
  const v = parseFloat(params.get(key));
  return Number.isFinite(v) ? v : null;
}

function wrapLon(lon) {
  // Wrap to [-180, 180).
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function applyUrlParams(eng) {
  const params = new URLSearchParams(location.search);

  const lat = num(params, 'lat');
  const lon = num(params, 'lon');
  const altKm = num(params, 'alt');
  const heading = num(params, 'heading');
  const ve = num(params, 've');

  if (ve !== null) {
    eng.set_exaggeration_override(ve);
  }

  // If none of the spawn params are present, keep the engine's default spawn.
  if (lat === null && lon === null && altKm === null && heading === null) {
    return;
  }

  const spawnLat = lat === null ? DEFAULT_SPAWN.lat : Math.max(-89, Math.min(89, lat));
  const spawnLon = lon === null ? DEFAULT_SPAWN.lon : wrapLon(lon);
  const altWu = altKm === null
    ? DEFAULT_SPAWN.altWu
    : Math.max(ALT_WU_MIN, Math.min(ALT_WU_MAX, (altKm * 1000) / M_PER_WU));
  const spawnHeading = heading === null ? DEFAULT_SPAWN.heading : heading;

  eng.set_spawn(spawnLat, spawnLon, altWu, spawnHeading);
}

// --- main ---

async function main() {
  let renderer, eng;

  // Resize canvas to fill window
  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    if (renderer) renderer.resize(canvas.width, canvas.height);
    if (eng) eng.set_aspect(canvas.width / canvas.height);
  }
  window.addEventListener('resize', resize);

  try {
    renderer = new Renderer(canvas);
  } catch (e) {
    fatal(e.message, 'WebGL2 requires a modern browser (Chrome 56+, Edge 79+, Firefox 51+).');
  }

  resize();

  overlay.innerHTML = '<p>Loading terrain…</p>';
  overlay.style.display = 'flex';

  let meta, hfBytes, wmBytes, aircraftJson;
  try {
    [meta, hfBytes, wmBytes, aircraftJson] = await Promise.all([
      fetchJson('../data/meta.json'),
      fetchBinary('../data/heightfield.bin'),
      fetchBinary('../data/water_mask.bin'),
      fetchJson('../data/aircraft.json'),
    ]);
  } catch (e) {
    fatal('Failed to load terrain data.', e.message);
  }

  try {
    eng = await buildEngine(meta, hfBytes, wmBytes);
  } catch (e) {
    // fatal() already called inside buildEngine for wasm errors; re-throw others
    fatal('Engine init failed.', e.message);
  }
  eng.set_aspect(canvas.width / canvas.height);

  // --- URL query params (phone-friendly start config) ---
  // ?lat=&lon=&alt=&heading=&ve=
  //   lat, lon     — degrees (spawn location)
  //   alt          — KILOMETERS above sea level (converted to world units below)
  //   heading      — degrees, 0 = north, 90 = east (optional, default north)
  //   ve           — fixed vertical-exaggeration override (optional)
  // Missing pieces fall back to the engine's default spawn.
  applyUrlParams(eng);

  // Upload aircraft wireframe geometry (static, uploaded once).
  const aircraftScale = eng.aircraft_scale();
  renderer.uploadAircraft(aircraftJson, aircraftScale);

  overlay.style.display = 'none';

  // Expose engine + renderer for headless testing (no-op in production)
  window._eng = eng;
  window._renderer = renderer;

  const input_state = new InputHandler(canvas);

  let prev = performance.now();

  function frame(now) {
    const dt = Math.min((now - prev) / 1000, 0.05); // cap at 50ms
    prev = now;

    const { input, lookDX, lookDY } = input_state.sample();
    const [thrust, strafe, lift, pitch, yaw, roll, boost, ftl] = input;
    eng.set_look(lookDX, lookDY);
    eng.set_input(thrust, strafe, lift, pitch, yaw, roll, boost, ftl);
    eng.step(dt);

    renderer.draw(eng);

    // HUD
    const kmh = Math.round(eng.speed_kmh());
    const alt = Math.round(eng.altitude_m());
    const ll = eng.lat_lon();
    const latVal = ll[0], lonVal = ll[1];
    const latStr = `${Math.abs(latVal).toFixed(1)}°${latVal >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lonVal).toFixed(1)}°${lonVal >= 0 ? 'E' : 'W'}`;
    hud.textContent = `${kmh} km/h   ALT ${alt}m   ${latStr} ${lonStr}`;

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(e => {
  // uncaught — show if overlay not already set
  if (overlay.style.display !== 'flex') {
    overlay.innerHTML = `<p class="err">Unexpected error.</p><p class="hint">${e.message}</p>`;
    overlay.style.display = 'flex';
  }
});
