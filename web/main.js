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

  // Upload aircraft wireframe geometry (static, uploaded once).
  const aircraftScale = eng.aircraft_scale();
  renderer.uploadAircraft(aircraftJson, aircraftScale);

  overlay.style.display = 'none';

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
    const spd = eng.speed().toFixed(0);
    const alt = eng.altitude().toFixed(0);
    hud.textContent = `SPD ${spd}   ALT ${alt}m`;

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
