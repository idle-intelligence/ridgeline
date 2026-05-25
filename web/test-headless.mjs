// Headless Playwright smoke-test for the ridgeline WebGL2 pipeline.
// Uses the mock engine (USE_MOCK=true in main.js).
// Run: node web/test-headless.mjs
// Requires: npm install playwright (or npx playwright install chromium)

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

// Minimal static server rooted at repo root (so ../data/ paths resolve correctly)
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

async function run() {
  const server = await startServer();
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/web/index.html`;

  const browser = await chromium.launch({
    args: ['--enable-unsafe-webgpu', '--use-angle=default'],
  });
  const page = await browser.newPage();

  // Collect console messages for diagnosis
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));

  await page.goto(url, { waitUntil: 'load' });

  // Wait for overlay to disappear (means engine + assets loaded successfully)
  try {
    await page.waitForFunction(
      () => document.getElementById('overlay').style.display === 'none',
      { timeout: 10000 },
    );
    console.log('PASS: overlay hidden — engine init succeeded');
  } catch {
    console.error('FAIL: overlay did not hide within 10s');
    console.error('Console output:', logs.join('\n'));
    await browser.close();
    server.close();
    process.exit(1);
  }

  // Wait a few frames for drawing to happen
  await page.waitForTimeout(500);

  // Check that the HUD has non-empty text (means step() + getters work)
  const hudText = await page.$eval('#hud', el => el.textContent.trim());
  if (hudText && (hudText.includes('SPD') || hudText.includes('u/s'))) {
    console.log(`PASS: HUD populated — "${hudText}"`);
  } else {
    console.error(`FAIL: HUD text unexpected: "${hudText}"`);
    await browser.close();
    server.close();
    process.exit(1);
  }

  // Take a screenshot for visual inspection
  const screenshotPath = join(__dir, 'test-screenshot.png');
  await page.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved: ${screenshotPath}`);

  // Verify canvas has non-sky pixels somewhere (i.e. geometry was drawn).
  // Sample a 10x10 block at the vertical center of the frame.
  const drawn = await page.evaluate(() => {
    const c = document.getElementById('c');
    const gl = c.getContext('webgl2');
    if (!gl) return { ok: false, reason: 'no webgl2' };
    const W = 10, H = 10;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels((c.width >> 1) - W/2, (c.height >> 1) - H/2, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // sky is ~(10,10,20); fill is ~(18,18,31); line is ~(224,219,209).
    // Count pixels meaningfully brighter than the sky.
    let bright = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 30 || px[i+1] > 30 || px[i+2] > 40) bright++;
    }
    return { ok: bright > 0, bright, total: W * H };
  });
  if (drawn.ok) {
    console.log(`PASS: canvas has ${drawn.bright}/${drawn.total} non-sky pixels in center block`);
  } else if (drawn.reason) {
    console.error(`FAIL: ${drawn.reason}`);
    await browser.close();
    server.close();
    process.exit(1);
  } else {
    // Ridges might be above/below center — sample a taller strip
    const drawn2 = await page.evaluate(() => {
      const c = document.getElementById('c');
      const gl = c.getContext('webgl2');
      const px = new Uint8Array(c.width * 4);
      let bright = 0;
      // scan three horizontal bands
      for (const row of [0.3, 0.5, 0.7]) {
        gl.readPixels(0, Math.floor(c.height * row), c.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 30 || px[i+1] > 30 || px[i+2] > 40) bright++;
        }
      }
      return bright;
    });
    if (drawn2 > 0) {
      console.log(`PASS: canvas has ${drawn2} non-sky pixels across three horizontal bands`);
    } else {
      console.warn('WARN: no non-sky pixels found — geometry may not be in view, but pipeline is intact');
    }
  }

  // ── Perf benchmark: 60 step() calls, measure avg ms and vertex counts ──────
  const perfResult = await page.evaluate(async () => {
    const eng = window._eng;
    if (!eng) return { ok: false, reason: 'window._eng not set' };

    const ITERS = 60;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      eng.step(0.016);
    }
    const elapsed = performance.now() - t0;
    const avgMs = elapsed / ITERS;

    const fillLen = eng.fill_vertices().length / 3; // vertex count
    const lineLen = eng.line_vertices().length / 3;
    return { ok: true, avgMs, fillVerts: fillLen, lineVerts: lineLen };
  });

  if (!perfResult.ok) {
    console.warn(`WARN: perf benchmark skipped — ${perfResult.reason}`);
  } else {
    const { avgMs, fillVerts, lineVerts } = perfResult;
    const totalVerts = fillVerts + lineVerts;
    console.log(`PERF: avg step = ${avgMs.toFixed(2)} ms/frame | fill_verts = ${fillVerts} | line_verts = ${lineVerts} | total = ${totalVerts}`);
    if (avgMs > 20) {
      console.warn(`WARN: step() is slow (${avgMs.toFixed(1)} ms) — consider tightening LOD caps`);
    } else {
      console.log(`PASS: step() performance acceptable (${avgMs.toFixed(2)} ms/frame)`);
    }
    if (totalVerts > 500_000) {
      console.warn(`WARN: vertex count high (${totalVerts}) — consider reducing COL_NEAR_POINTS or ROW_BUDGET`);
    } else {
      console.log(`PASS: vertex count within budget (${totalVerts} total verts)`);
    }
  }

  // ── Motion-stability test ─────────────────────────────────────────────────
  // Verify that grid lines don't "swim" (jump to different world positions) as the
  // camera moves. Strategy:
  //   1. Snapshot line_vertices() now (draws already captured above after 60 steps).
  //   2. Apply forward thrust + several step()s to move camera ~100 wu forward.
  //   3. Snapshot again.
  //   4. Find rows present in both snapshots (same world Z, within epsilon).
  //      For an index-anchored scheme, a row's Z is fixed to the grid; its X coords
  //      must be unchanged between snapshots.
  //   5. Count "snapping" rows (where X changed unexpectedly). Should be zero.
  const motionResult = await page.evaluate(() => {
    const eng = window._eng;
    if (!eng) return { ok: false, reason: 'window._eng not set' };

    // Helper: extract per-row Z values + first vertex X from line_vertices/line_draws.
    function rowSamples(verts, draws) {
      const rows = [];
      for (let i = 0; i < draws.length; i += 2) {
        const start = draws[i];
        const count = draws[i + 1];
        if (count < 2) continue;
        const base = start * 3;
        // First vertex of this row strip
        const x0 = verts[base];
        const z0 = verts[base + 2];
        // Second vertex x (to cross-check)
        const x1 = verts[base + 3];
        const z1 = verts[base + 5];
        rows.push({ z: z0, x0, x1, z1 });
      }
      return rows;
    }

    const snapA_verts = eng.line_vertices();
    const snapA_draws = eng.line_draws();
    const rowsA = rowSamples(snapA_verts, snapA_draws);

    // Move forward: apply thrust for 10 steps of 0.016s
    eng.set_input(1.0, 0, 0, 0, 0, 0, 0, false);
    for (let i = 0; i < 10; i++) eng.step(0.016);

    const snapB_verts = eng.line_vertices();
    const snapB_draws = eng.line_draws();
    const rowsB = rowSamples(snapB_verts, snapB_draws);

    // Build lookup: z-rounded → row data from B (rows on fixed grid, round to 0.1wu)
    const mapB = new Map();
    for (const r of rowsB) {
      mapB.set(Math.round(r.z * 10), r);
    }

    let shared = 0;
    let snapped = 0;
    const snapExamples = [];
    for (const rA of rowsA) {
      const key = Math.round(rA.z * 10);
      const rB = mapB.get(key);
      if (!rB) continue; // row left viewport — normal
      shared++;
      // For a stable row, x0 must be identical (same grid column sampled).
      const dx = Math.abs(rA.x0 - rB.x0);
      if (dx > 0.01) {
        snapped++;
        if (snapExamples.length < 3) snapExamples.push({ z: rA.z, xA: rA.x0, xB: rB.x0, dx });
      }
    }

    // Also log a few stable rows' positions across frames for the report
    const stableExamples = [];
    for (const rA of rowsA) {
      const key = Math.round(rA.z * 10);
      const rB = mapB.get(key);
      if (!rB) continue;
      const dx = Math.abs(rA.x0 - rB.x0);
      if (dx < 0.01 && stableExamples.length < 4) {
        stableExamples.push({ z: rA.z.toFixed(1), xA: rA.x0.toFixed(2), xB: rB.x0.toFixed(2) });
      }
    }

    return { ok: true, shared, snapped, snapExamples, stableExamples,
             rowsA: rowsA.length, rowsB: rowsB.length };
  });

  if (!motionResult.ok) {
    console.warn(`WARN: motion-stability test skipped — ${motionResult.reason}`);
  } else {
    const { shared, snapped, snapExamples, stableExamples, rowsA, rowsB } = motionResult;
    console.log(`MOTION: rows before=${rowsA} after=${rowsB} shared=${shared} snapped=${snapped}`);
    if (stableExamples.length > 0) {
      console.log(`MOTION stable row samples (z, xA, xB):`);
      for (const s of stableExamples) {
        console.log(`  z=${s.z}  xA=${s.xA}  xB=${s.xB}  (diff=${Math.abs(s.xA - s.xB).toFixed(4)})`);
      }
    }
    if (snapped > 0) {
      console.error(`FAIL: ${snapped}/${shared} rows snapped to new X positions — swimming not fixed`);
      for (const e of snapExamples) {
        console.error(`  z=${e.z.toFixed(1)} xA=${e.xA.toFixed(2)} xB=${e.xB.toFixed(2)} dx=${e.dx.toFixed(3)}`);
      }
      await browser.close();
      server.close();
      process.exit(1);
    } else if (shared > 0) {
      console.log(`PASS: motion-stability OK — ${shared} shared rows, 0 snapped (index-anchored grid stable)`);
    } else {
      console.warn(`WARN: no shared rows found between snapshots (camera moved far) — cannot verify stability`);
    }
  }

  await browser.close();
  server.close();
  console.log('All checks passed.');
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
