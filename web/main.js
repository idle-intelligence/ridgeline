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

async function buildEngine(meta, hfBytes) {
  if (USE_MOCK) {
    const { makeMockEngine } = await import('./mock-engine.js');
    const { bbox } = meta;
    return {
      eng: makeMockEngine(
        meta.width, meta.height,
        hfBytes,
        meta.elev_min, meta.elev_max,
        bbox.lat_min, bbox.lat_max, bbox.lon_min, bbox.lon_max,
      ),
      wasmMemory: null,
    };
  }

  // Real wasm path — production
  let initWasm, Engine;
  try {
    ({ default: initWasm, Engine } = await import('./pkg/ridgeline_core.js'));
  } catch (e) {
    fatal('Could not load WASM module.', 'Make sure web/pkg/ has been built: wasm-pack build --target web');
  }
  let wasm;
  try {
    wasm = await initWasm();
  } catch (e) {
    fatal('WASM init failed.', e.message);
  }
  const { bbox } = meta;
  const eng = new Engine(
    meta.width, meta.height,
    hfBytes,
    meta.elev_min, meta.elev_max,
    bbox.lat_min, bbox.lat_max, bbox.lon_min, bbox.lon_max,
  );
  // wasm.memory backs the zero-copy geometry views used by the renderer.
  return { eng, wasmMemory: wasm.memory };
}

// --- URL params ---

// Meters of real surface per world unit (mirrors core heightfield::M_PER_WU).
const M_PER_WU = 6371000 / 6000; // ≈ 1061.8

// Defaults mirror the core's default spawn (lower in-atmosphere cruise over the Med).
const DEFAULT_SPAWN = { lat: 38.0, lon: 8.0, altWu: 250.0, heading: 0.0 };

// Safe altitude band (world units above the sea-level sphere): above the surface,
// below escaping to deep space. ~0.5 wu (≈0.5 km) up to ~12000 wu (≈12740 km).
// Low floor allows skimming/sea-level URL spawns (e.g. ?alt=1); the engine's own
// hard floor at R_WORLD+0.5 still prevents going inside the planet.
const ALT_WU_MIN = 0.5;
const ALT_WU_MAX = 12000.0;

// AGL terrain-following clearance clamp, in VE-EXAGGERATED METERS (the same vertical scale the
// terrain is drawn in), mirrors core TARGET_AGL_MIN/MAX. The core scales meters → wu per-frame
// with the live render `ve`, so the held clearance skims just above the visible exaggerated ridges.
const AGL_M_MIN = 80.0;
const AGL_M_MAX = 60000.0;

let atmoTargetAgl = 500.0; // exag-meters, matches physics DEFAULT_TARGET_AGL

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
  const aglM = num(params, 'agl');

  if (ve !== null) {
    eng.set_exaggeration_override(ve);
  }

  // ?agl=<meters>: terrain-following clearance above the ground directly below, in VE-exaggerated
  // meters (the SAME vertical scale the terrain is drawn in). Passed straight to the core (which
  // scales it to wu per-frame with the live render `ve`); just clamp to the sane skim band. No
  // param → engine default (DEFAULT_TARGET_AGL = 500 exaggerated m). No M_PER_WU conversion here.
  if (aglM !== null) {
    const aglClamped = Math.max(AGL_M_MIN, Math.min(AGL_M_MAX, aglM));
    eng.set_target_agl(aglClamped);
    atmoTargetAgl = aglClamped; // keep JS in sync
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

  // Renderer selection: the WebGPU compute renderer is the DEFAULT when available (it moves the
  // expensive per-frame geometry generation off the CPU → 60 fps + rich detail at all altitudes).
  // WebGL2 is the automatic fallback. The 'webgpu' canvas context is mutually exclusive with
  // 'webgl2' on the same canvas, so we DEFER renderer construction until after the engine is
  // built (WebGPU needs it to upload the heightfield) whenever WebGPU is a candidate.
  //   ?webgpu=0          → force WebGL2 (skip WebGPU entirely).
  //   otherwise (default)→ try WebGPU; on no-adapter / init failure, fall back to WebGL2.
  const params = new URLSearchParams(location.search);
  const forceWebGL2 = params.get('webgpu') === '0';
  // Only attempt WebGPU when not forced off AND the API is present. We must probe the adapter
  // (requestAdapter) here too — but that's async, so we defer the whole WebGPU attempt below.
  const tryWebGPU = !forceWebGL2 && !!navigator.gpu;
  if (forceWebGL2 || !navigator.gpu) {
    try {
      renderer = new Renderer(canvas);
      console.log(`[renderer] WebGL2 active (${forceWebGL2 ? '?webgpu=0' : 'navigator.gpu unavailable'}).`);
    } catch (e) {
      fatal(e.message, 'WebGL2 requires a modern browser (Chrome 56+, Edge 79+, Firefox 51+).');
    }
  }

  resize();

  overlay.innerHTML = '<p>Loading terrain…</p>';
  overlay.style.display = 'flex';

  let meta, hfBytes, aircraftJson;
  try {
    [meta, hfBytes, aircraftJson] = await Promise.all([
      fetchJson('../data/meta.json'),
      fetchBinary('../data/heightfield.bin'),
      fetchJson('../data/aircraft.json'),
    ]);
  } catch (e) {
    fatal('Failed to load terrain data.', e.message);
  }

  let wasmMemory = null;
  try {
    ({ eng, wasmMemory } = await buildEngine(meta, hfBytes));
  } catch (e) {
    // fatal() already called inside buildEngine for wasm errors; re-throw others
    fatal('Engine init failed.', e.message);
  }
  // The engine has copied the heightfield into WASM (as int16); drop our reference to the raw
  // ~144 MB Uint8Array so it can be GC'd — the WASM int16 copy is the only retained one.
  hfBytes = null;
  eng.set_aspect(canvas.width / canvas.height);

  // --- URL query params (phone-friendly start config) ---
  // ?lat=&lon=&alt=&heading=&ve=&agl=
  //   lat, lon     — degrees (spawn location)
  //   alt          — KILOMETERS above sea level (converted to world units below)
  //   heading      — degrees, 0 = north, 90 = east (optional, default north)
  //   ve           — fixed vertical-exaggeration override (optional)
  //   agl          — METERS of terrain-following clearance above the ground below (optional)
  // Missing pieces fall back to the engine's default spawn.
  applyUrlParams(eng);

  // --- WebGPU renderer (DEFAULT when available) ---
  // Try the WebGPU compute renderer; on ANY init/runtime failure (or no adapter) construct the
  // WebGL2 Renderer here as the automatic fallback, so main stays flyable everywhere.
  let useWebGPU = false;
  if (tryWebGPU) {
    try {
      const { WebGPURenderer } = await import('./renderer-webgpu.js');
      const gpu = await WebGPURenderer.create(canvas, eng, wasmMemory);
      gpu.resize(canvas.width, canvas.height);
      renderer = gpu;
      useWebGPU = true;
      console.log('[webgpu] WebGPU compute renderer active (geometry generated on the GPU; CPU step is physics-only).');
    } catch (e) {
      console.warn('[webgpu] init failed — falling back to WebGL2:', e.message);
    }
    if (!useWebGPU) {
      try {
        renderer = new Renderer(canvas);
        console.log('[renderer] WebGL2 active (WebGPU fallback).');
      } catch (e) {
        fatal(e.message, 'WebGL2 requires a modern browser.');
      }
    }
  }

  // Upload aircraft wireframe geometry (static, uploaded once).
  const aircraftScale = eng.aircraft_scale();
  renderer.uploadAircraft(aircraftJson, aircraftScale);

  overlay.style.display = 'none';

  // Expose engine + renderer for headless testing (no-op in production)
  window._eng = eng;
  window._renderer = renderer;
  window._wasmMemory = wasmMemory;
  window._useWebGPU = useWebGPU;

  const input_state = new InputHandler(canvas);

  let prev = performance.now();

  function frame(now) {
    const dt = Math.min((now - prev) / 1000, 0.05); // cap at 50ms
    prev = now;

    const { input, lookDX, lookDY } = input_state.sample();
    const [thrust, strafe, lift, pitch, yaw, roll, boost, ftl] = input;
    eng.set_look(lookDX, lookDY);
    const modeIdx = eng.flight_mode();
    if (modeIdx === 0 && Math.abs(pitch) > 0.01) {
      atmoTargetAgl = Math.max(AGL_M_MIN, Math.min(AGL_M_MAX, atmoTargetAgl - pitch * 5000.0 * dt));
      eng.set_target_agl(atmoTargetAgl);
    }
    eng.set_input(thrust, strafe, lift, modeIdx === 0 ? 0.0 : pitch, yaw, roll, boost, ftl);
    // WebGPU generates geometry on the GPU, so skip the expensive CPU vertex emission
    // (generate_into): physics + camera only. WebGL2 still needs the CPU geometry.
    if (useWebGPU) eng.step_physics_only(dt);
    else eng.step(dt);

    renderer.draw(eng, wasmMemory);

    // HUD
    const kmh = Math.round(eng.speed_kmh());
    const ll = eng.lat_lon();
    const latVal = ll[0], lonVal = ll[1];
    const latStr = `${Math.abs(latVal).toFixed(1)}°${latVal >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lonVal).toFixed(1)}°${lonVal >= 0 ? 'E' : 'W'}`;
    // modeIdx already declared above
    const mode = ['ATMO', 'ORBIT', 'INTERPLANETARY'][modeIdx] || 'ATMO';
    const thr = Math.round(eng.throttle() * 100);
    // Context-aware "distance to the gravitationally dominant body", chosen by flight mode —
    // the label names whose gravity well the player is in.
    //   ATMO  → distance to GROUND, raw world units (small when skimming): GND <n> wu
    //   ORBIT → distance to the PLANET surface, integer km w/ separators:  PLANET <n> km
    //   INTERPLANETARY → distance from the planet, megameters: EARTH <n> Mm  (placeholder)
    let distStr;
    if (modeIdx === 1) {
      const km = Math.round(eng.altitude_m() / 1000);
      distStr = `PLANET ${km.toLocaleString('en-US')} km`;
    } else if (modeIdx === 2) {
      // TODO: there is no sun body yet. When one exists, this becomes the distance to the SUN
      // as `SUN <n> AU`. Until then, show distance FROM THE PLANET in megameters as a placeholder.
      const mm = eng.altitude_m() / 1e6;
      distStr = `EARTH ${mm.toFixed(1)} Mm`;
    } else {
      const gnd = eng.ground_dist_wu();
      distStr = `GND ${gnd < 10 ? gnd.toFixed(1) : Math.round(gnd)} wu`;
    }
    hud.textContent = `${kmh} km/h · THR ${thr}% · ${distStr} · ${latStr} ${lonStr} · ${mode}`;

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
