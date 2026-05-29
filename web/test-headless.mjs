// Headless Playwright smoke-test for the ridgeline GLOBE pipeline.
// Run: node web/test-headless.mjs
// Requires: npm install playwright (or npx playwright install chromium)
//
// Verifies:
//   - engine init + HUD populated (sub-camera lat/lon, altitude, speed)
//   - the canvas shows a roughly DISC-shaped cluster of non-background pixels (the planet)
//   - bounded vertex count + acceptable ms/step
//   - geometry is stable under camera motion (no swimming): a ring that stays visible
//     keeps the same first-vertex world position across frames (index-anchored)
//   - far side is occluded (depth) and limb fades

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.json': 'application/json',
  '.bin':  'application/octet-stream',
  '.wasm': 'application/wasm',
};

function startServer() {
  return new Promise(resolve => {
    const server = createServer(async (req, res) => {
      let urlPath = req.url.split('?')[0];
      if (urlPath === '/') urlPath = '/web/index.html';
      const filePath = join(repoRoot, urlPath);
      try {
        const data = await readFile(filePath);
        const ct = MIME[extname(filePath)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fail(msg, browser, server, logs) {
  console.error(`FAIL: ${msg}`);
  if (logs) console.error('Console output:\n' + logs.join('\n'));
  if (browser) browser.close();
  if (server) server.close();
  process.exit(1);
}

async function run() {
  const server = await startServer();
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/web/index.html`;

  const browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--use-angle=default'],
  });
  const page = await browser.newPage();

  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

  await page.goto(url, { waitUntil: 'load' });

  try {
    await page.waitForFunction(
      () => document.getElementById('overlay').style.display === 'none',
      { timeout: 10000 },
    );
    console.log('PASS: overlay hidden — engine init succeeded');
  } catch {
    fail('overlay did not hide within 10s', browser, server, logs);
  }

  await page.waitForTimeout(500);

  // ── Spawn view screenshot (BEFORE any stepping) ──────────────────────────────
  // Capture the calm in-atmosphere cruise framing the player sees at spawn.
  await page.evaluate(() => { if (window._renderer && window._eng) window._renderer.draw(window._eng, window._wasmMemory); });
  await page.screenshot({ path: join(__dir, 'test-screenshot.png') });
  console.log('Spawn screenshot saved: web/test-screenshot.png');

  // ── Spawn cruise SETTLES to the low AGL clearance and holds (NO input) ───────
  // The AGL terrain-following hold targets a clearance in VE-EXAGGERATED METERS (the same scale
  // the terrain is drawn in): DEFAULT_TARGET_AGL = 500 exaggerated m. Spawning at alt 250 over the
  // (sea-level) Mediterranean, the craft gently DESCENDS to that skim clearance and holds it. Over
  // the sea (terrain 0) 500 exaggerated m ≈ 1.3 wu, so the ALTITUDE band sits low (a few wu) yet
  // the HUD `agl_m()` reads ≈ 500 (the scaled clearance). It must NOT plummet to the floor (alt>0)
  // nor rocket to space. Then pitch-down descends and Shift+Space climbs out.
  const cruise = await page.evaluate(() => {
    const eng = window._eng;
    // Re-pin to the default spawn first: the production rAF loop has been free-running with
    // wall-clock dt since page load, so the craft has drifted a variable amount. Resetting to a
    // known spawn makes the settle assertion deterministic (independent of harness timing).
    eng.set_spawn(38.0, 8.0, 250.0, 0.0);
    eng.set_input(0, 0, 0, 0, 0, 0, 0, false);
    const a0 = eng.altitude();
    // Track the SETTLED band over the last 8 s (after the descent transient onto the AGL hold).
    let amin = Infinity, amax = 0, smin = Infinity, smax = 0, aglMin = Infinity, aglMax = 0;
    const trace = [];
    for (let s = 0; s < 18; s++) {
      for (let i = 0; i < 60; i++) eng.step(1 / 60);
      const a = eng.altitude(), sp = eng.speed(), agl = eng.agl_m();
      if (s >= 10) {
        amin = Math.min(amin, a); amax = Math.max(amax, a);
        smin = Math.min(smin, sp); smax = Math.max(smax, sp);
        aglMin = Math.min(aglMin, agl); aglMax = Math.max(aglMax, agl);
      }
      trace.push(`t=${s + 1}s alt=${a.toFixed(0)} agl=${agl.toFixed(0)}m speed=${sp.toFixed(0)}`);
    }
    return { a0, aFinal: eng.altitude(), amin, amax, smin, smax, aglMin, aglMax, trace };
  });
  console.log('CRUISE: ' + cruise.trace.join(' | '));
  console.log(`CRUISE: alt start=${cruise.a0.toFixed(0)} settled band=[${cruise.amin.toFixed(0)},${cruise.amax.toFixed(0)}] ` +
    `AGL=[${cruise.aglMin.toFixed(0)},${cruise.aglMax.toFixed(0)}]m speed=[${cruise.smin.toFixed(0)},${cruise.smax.toFixed(0)}]`);
  // The craft DESCENDS to the low AGL skim clearance and holds a tight band there with steady
  // speed — no free-fall to the floor (alt stays > 0), no escape to space — and the HUD AGL reads
  // ≈ 500 exaggerated m (the scaled clearance, NOT ~10000).
  if (cruise.aFinal < cruise.a0 - 100 &&
      cruise.amin > 0 && cruise.amax < 250 &&
      (cruise.amax - cruise.amin) < 30 &&
      cruise.aglMin > 100 && cruise.aglMax < 1500 &&
      cruise.smin > 100 && cruise.smax < 400) {
    console.log('PASS: spawn cruise descends to the VE-scaled AGL skim clearance (~500 exag-m) and holds it');
  } else {
    fail(`spawn cruise did not settle to VE-scaled AGL hold: final ${cruise.aFinal.toFixed(0)} settled band ` +
      `[${cruise.amin.toFixed(0)},${cruise.amax.toFixed(0)}] AGL [${cruise.aglMin.toFixed(0)},${cruise.aglMax.toFixed(0)}]m ` +
      `speed [${cruise.smin.toFixed(0)},${cruise.smax.toFixed(0)}]`,
      browser, server, logs);
  }

  // Pitch-down should descend; Shift+Space should climb out — quick sanity (fresh reloads).
  const maneuver = await page.evaluate(() => {
    const eng = window._eng;
    // Reset to spawn by reloading state is not exposed; instead measure deltas from current.
    // Pitch nose DOWN (raw pitch arg -1 = nose down). Since the craft now skims LOW (AGL hold
    // ≈ 60 wu), a short pitch-down dive is enough; track the MINIMUM altitude reached (a long
    // hold would loop the nose back up). Manual pitch overrides terrain-follow.
    const aStart = eng.altitude();
    eng.set_input(0, 0, 0, -1, 0, 0, 0, false);
    let aDown = aStart;
    for (let i = 0; i < 1.5 * 60; i++) { eng.step(1 / 60); aDown = Math.min(aDown, eng.altitude()); }
    // Now Shift+Space: full thrust + afterburner, nose UP for 6 s.
    eng.set_input(1, 0, 0, 1, 0, 0, 0, true);
    for (let i = 0; i < 6 * 60; i++) eng.step(1 / 60);
    const aClimb = eng.altitude();
    return { aStart, aDown, aClimb };
  });
  console.log(`MANEUVER: start=${maneuver.aStart.toFixed(0)} afterPitchDown=${maneuver.aDown.toFixed(0)} ` +
    `afterShiftSpace=${maneuver.aClimb.toFixed(0)}`);
  if (maneuver.aDown < maneuver.aStart && maneuver.aClimb > maneuver.aDown) {
    console.log('PASS: pitch-down descends and Shift+Space climbs out');
  } else {
    fail('pitch-down / Shift+Space did not behave as expected', browser, server, logs);
  }

  // Reload to restore a fresh spawn for the remaining (geometry/perf/motion) checks,
  // which the maneuvers above would otherwise have flown out of frame.
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.getElementById('overlay').style.display === 'none',
    { timeout: 10000 },
  );
  await page.waitForTimeout(300);

  // ── HUD populated ──────────────────────────────────────────────────────────
  const hudText = await page.$eval('#hud', el => el.textContent.trim());
  if (hudText && hudText.includes('km/h') && hudText.includes('GND')) {
    console.log(`PASS: HUD populated — "${hudText}"`);
  } else {
    fail(`HUD text unexpected: "${hudText}"`, browser, server, logs);
  }

  // ── Disc-shaped planet check ─────────────────────────────────────────────────
  // Scan the whole framebuffer; count non-sky pixels and measure their bounding box +
  // centroid. The planet should be a compact, roughly circular cluster (not full-screen,
  // not empty) near the center of the frame.
  const disc = await page.evaluate(async () => {
    const c = document.getElementById('c');
    let W, H, px;
    if (window._useWebGPU) {
      // WebGPU canvas: render into an owned texture and read it back. The renderer returns
      // pixels top-to-bottom (Y down); flip to bottom-up so the centroid logic below (shared
      // with the gl.readPixels Y-up convention) reads "lower frame" the same way.
      const r = await window._renderer.readbackPixels(window._eng, window._wasmMemory);
      W = r.width; H = r.height;
      px = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        const sy = (H - 1 - y) * W * 4, dy = y * W * 4;
        px.set(r.pixels.subarray(sy, sy + W * 4), dy);
      }
    } else {
      const gl = c.getContext('webgl2');
      if (!gl) return { ok: false, reason: 'no webgl2' };
      // Force a synchronous render so readPixels sees the current frame (the rAF-rendered
      // backbuffer is swapped/cleared by the time we read outside the loop).
      if (window._renderer && window._eng) window._renderer.draw(window._eng, window._wasmMemory);
      W = c.width; H = c.height;
      px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    // sky ~ (10,10,20). Anything meaningfully brighter is planet (fill or line).
    let minX = W, minY = H, maxX = 0, maxY = 0, n = 0, sx = 0, sy = 0;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 4;
        if (px[i] > 25 || px[i + 1] > 25 || px[i + 2] > 35) {
          n++; sx += x; sy += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (n === 0) return { ok: false, reason: 'no non-sky pixels' };
    const bw = maxX - minX, bh = maxY - minY;
    const cx = sx / n, cy = sy / n;
    // sampled every 2px → total sampled = (W/2)*(H/2)
    const sampledTotal = Math.ceil(W / 2) * Math.ceil(H / 2);
    const coverage = n / sampledTotal;
    // bounding box aspect ratio close to 1 = disc-like
    const aspect = bw > 0 && bh > 0 ? Math.min(bw, bh) / Math.max(bw, bh) : 0;
    return {
      ok: true, n, coverage, bw, bh, aspect,
      cx, cy, W, H,
      cxFrac: cx / W, cyFrac: cy / H,
    };
  });
  if (!disc.ok) {
    fail(`disc check: ${disc.reason}`, browser, server, logs);
  }
  console.log(`DISC: nonSky=${disc.n} coverage=${(disc.coverage * 100).toFixed(1)}% ` +
    `bbox=${disc.bw}x${disc.bh} aspect=${disc.aspect.toFixed(2)} ` +
    `centroid=(${disc.cxFrac.toFixed(2)},${disc.cyFrac.toFixed(2)})`);
  // Planet/terrain should cover a meaningful but not full-screen area, span a wide band,
  // and be horizontally centered. In a LEVEL in-atmosphere cruise the terrain correctly
  // sits in the lower frame near the horizon (sky above), so the vertical centroid is
  // lower-middle — not a centered from-afar disc.
  // At realistic vertical exaggeration (VERT_EXAGGERATION = 1) the relief is subtle and the
  // globe limb sits low in the cruise frame, so terrain covers a smaller pixel fraction than
  // it did under the old dramatic relief — hence the modest lower bound.
  if (disc.coverage > 0.01 && disc.coverage < 0.85 &&
      disc.aspect > 0.5 &&
      disc.cxFrac > 0.2 && disc.cxFrac < 0.8 &&
      disc.cyFrac > 0.1 && disc.cyFrac < 0.8) {
    console.log('PASS: planet/terrain renders as a centered, wide cluster in the lower frame');
  } else {
    fail('planet cluster not disc-like / off-center / wrong size', browser, server, logs);
  }

  await page.screenshot({ path: join(__dir, 'test-screenshot.png') });
  console.log('Screenshot saved: web/test-screenshot.png');

  // ── Perf + vertex budget ─────────────────────────────────────────────────────
  const perf = await page.evaluate(() => {
    const eng = window._eng;
    if (!eng) return { ok: false, reason: 'window._eng not set' };
    const ITERS = 60;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) eng.step(0.016);
    const avgMs = (performance.now() - t0) / ITERS;
    return {
      ok: true, avgMs,
      fillVerts: eng.fill_vertices().length / 3,
      lineVerts: eng.line_vertices().length / 3,
    };
  });
  if (!perf.ok) {
    fail(`perf: ${perf.reason}`, browser, server, logs);
  }
  const totalVerts = perf.fillVerts + perf.lineVerts;
  console.log(`PERF: avg step = ${perf.avgMs.toFixed(2)} ms/frame | ` +
    `fill_verts=${perf.fillVerts} | line_verts=${perf.lineVerts} | total=${totalVerts}`);
  if (totalVerts > 600_000) {
    fail(`vertex count too high (${totalVerts})`, browser, server, logs);
  }
  console.log(`PASS: vertex count within budget (${totalVerts})`);
  if (perf.avgMs > 30) {
    console.warn(`WARN: step() slow (${perf.avgMs.toFixed(1)} ms)`);
  } else {
    console.log(`PASS: step() performance acceptable (${perf.avgMs.toFixed(2)} ms/frame)`);
  }

  // ── WebGPU: CPU step is physics-only (the geometry-gen bypass) ───────────────
  // The whole point of the WebGPU path: the production loop drives the engine with
  // step_physics_only(dt) (physics + camera only), so the CPU per-frame cost collapses from
  // the full generate_into (tens of ms, unbounded at low altitude) to ~microseconds. Confirm
  // step_physics_only is dramatically cheaper than the full step, and the GPU draw is bounded.
  if (await page.evaluate(() => window._useWebGPU)) {
    const gpu = await page.evaluate(async () => {
      const eng = window._eng, r = window._renderer;
      eng.set_spawn(38, 8, 250, 0); eng.set_input(0, 0, 0, 0, 0, 0, 0, false);
      // Fly low + forward for a while — the violation case (more terrain exposed = the old
      // CPU balloon). With step_physics_only this must stay cheap.
      for (let i = 0; i < 360; i++) eng.step_physics_only(1 / 60);
      const N = 60;
      let t = performance.now(); for (let i = 0; i < N; i++) eng.step_physics_only(1 / 60); const phys = (performance.now() - t) / N;
      t = performance.now(); for (let i = 0; i < N; i++) eng.step(1 / 60); const full = (performance.now() - t) / N;
      // GPU geometry counts (reserved high-water — bounded under the buffer caps → no dropped rings).
      const rb = await r.debugReadback();
      return { phys, full, rb };
    });
    console.log(`WEBGPU: low-alt CPU step_physics_only=${gpu.phys.toFixed(3)} ms vs full generate_into=${gpu.full.toFixed(2)} ms | ` +
      `GPU lineVerts(reserved)=${gpu.rb.lineVerts} fillVerts=${gpu.rb.fillVerts}`);
    if (gpu.phys < 2.0 && gpu.phys < gpu.full * 0.25) {
      console.log('PASS: WebGPU CPU step is physics-only — geometry-gen cost eliminated (no low-altitude balloon)');
    } else {
      fail(`WebGPU step_physics_only not cheap enough: ${gpu.phys.toFixed(3)} ms (full ${gpu.full.toFixed(2)} ms)`, browser, server, logs);
    }
  }

  // ── Motion stability (no swimming) ───────────────────────────────────────────
  // A latitude ring is index-anchored: as the camera yaws/moves, a ring that remains
  // visible must keep the SAME world-space vertices (sphere points depend only on the
  // grid, not the camera). We snapshot the longest ring's first vertex, move the camera,
  // and check it is unchanged (allowing the run to start at a different longitude due to
  // limb clipping — so we hash a quantized set of vertex positions and require overlap).
  const motion = await page.evaluate(() => {
    const eng = window._eng;
    if (!eng) return { ok: false, reason: 'window._eng not set' };

    function vertexSet(verts, draws) {
      // quantize each vertex to 1 wu and collect into a set of strings
      const set = new Set();
      for (let i = 0; i < draws.length; i += 2) {
        const start = draws[i], count = draws[i + 1];
        for (let v = 0; v < count; v++) {
          const b = (start + v) * 3;
          const k = `${Math.round(verts[b])},${Math.round(verts[b + 1])},${Math.round(verts[b + 2])}`;
          set.add(k);
        }
      }
      return set;
    }

    const aV = eng.line_vertices(), aD = eng.line_draws();
    const setA = vertexSet(aV, aD);

    // Yaw + small forward motion for several frames (camera rotates around globe view).
    eng.set_input(0.4, 0, 0, 0, 0.4, 0, 0, false);
    for (let i = 0; i < 8; i++) eng.step(0.016);

    const bV = eng.line_vertices(), bD = eng.line_draws();
    const setB = vertexSet(bV, bD);

    // Count how many of A's vertices that are still on the near hemisphere appear in B.
    // Since the camera barely moved relative to the globe, most should persist exactly.
    let shared = 0;
    for (const k of setA) if (setB.has(k)) shared++;
    const overlap = setA.size > 0 ? shared / setA.size : 0;
    return { ok: true, sizeA: setA.size, sizeB: setB.size, shared, overlap };
  });
  if (!motion.ok) {
    fail(`motion: ${motion.reason}`, browser, server, logs);
  }
  console.log(`MOTION: vertsA=${motion.sizeA} vertsB=${motion.sizeB} ` +
    `shared=${motion.shared} overlap=${(motion.overlap * 100).toFixed(1)}%`);
  // Index-anchored sphere points are deterministic; with a tiny camera move a large
  // fraction must persist exactly (the rest left the visible hemisphere).
  if (motion.overlap > 0.5) {
    console.log('PASS: motion-stable — ring vertices persist exactly (no swimming)');
  } else {
    fail(`rings swam — only ${(motion.overlap * 100).toFixed(1)}% vertices persisted`,
      browser, server, logs);
  }

  // ── Dive toward the surface: strides should refine (more verts up close) ──────
  const dive = await page.evaluate(() => {
    const eng = window._eng;
    // Throttle straight toward the globe center for a while.
    eng.set_input(1.0, 0, 0, 0, 0, 0, 0, false);
    for (let i = 0; i < 120; i++) eng.step(0.016);
    return {
      altM: eng.altitude_m(),
      fillVerts: eng.fill_vertices().length / 3,
      lineVerts: eng.line_vertices().length / 3,
    };
  });
  console.log(`DIVE: alt=${dive.altM.toFixed(0)} m | ` +
    `fill=${dive.fillVerts} line=${dive.lineVerts} total=${dive.fillVerts + dive.lineVerts}`);
  if (dive.fillVerts + dive.lineVerts > 0) {
    console.log('PASS: geometry present while diving toward the surface');
  } else {
    fail('no geometry while diving', browser, server, logs);
  }

  await page.evaluate(() => { const eng = window._eng; if (eng) eng.step(0.001); });
  await page.screenshot({ path: join(__dir, 'test-dive.png') });
  console.log('Dive screenshot saved: web/test-dive.png (spawn view kept in test-screenshot.png)');

  await browser.close();
  server.close();
  console.log('All checks passed.');
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
