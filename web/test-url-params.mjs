// Headless test for URL query-param spawn config (the phone start-config deliverable).
// Run: node web/test-url-params.mjs
//
// Verifies:
//   - ?lat=&lon=&alt=&ve= positions the craft at the requested location/altitude and
//     forces the requested vertical exaggeration (HUD / lat_lon() reflect it).
//   - ?ve= alone (no spawn params) keeps the default spawn but changes terrain relief.

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
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
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
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

async function loadPage(browser, baseUrl, query) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
  await page.goto(baseUrl + query, { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.getElementById('overlay').style.display === 'none',
    { timeout: 10000 },
  );
  await page.waitForTimeout(300);
  return { page, logs };
}

// Sum of |line vertex radius - R_WORLD| as a proxy for rendered relief magnitude.
async function reliefMagnitude(page) {
  return page.evaluate(() => {
    const eng = window._eng;
    if (window._renderer) window._renderer.draw(eng);
    const v = eng.line_vertices();
    const R = 6000;
    let sum = 0, n = 0;
    for (let i = 0; i < v.length; i += 3) {
      const r = Math.hypot(v[i], v[i + 1], v[i + 2]);
      sum += Math.abs(r - R);
      n++;
    }
    return n ? sum / n : 0;
  });
}

async function run() {
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/web/index.html`;
  const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-angle=default'] });

  // ── 1. Everest-area URL: ?lat=28&lon=86&alt=60&ve=8 ──────────────────────────
  {
    const { page, logs } = await loadPage(browser, baseUrl, '?lat=28&lon=86&alt=60&ve=8');
    const r = await page.evaluate(() => {
      const eng = window._eng;
      const ll = eng.lat_lon();
      return { lat: ll[0], lon: ll[1], altM: eng.altitude_m(), hud: document.getElementById('hud').textContent.trim() };
    });
    console.log(`URL-EVEREST: lat=${r.lat.toFixed(2)} lon=${r.lon.toFixed(2)} alt=${r.altM.toFixed(0)} m | HUD "${r.hud}"`);
    // Sub-camera lat/lon is the chase cam (slightly behind/above spawn) → allow a small offset.
    if (Math.abs(r.lat - 28) > 1.5 || Math.abs(r.lon - 86) > 1.5) {
      fail(`location not ~28N 86E: lat=${r.lat} lon=${r.lon}`, browser, server, logs);
    }
    // alt=60 km → expect ~60000 m (chase cam adds a little; allow ±5 km).
    if (Math.abs(r.altM - 60000) > 5000) {
      fail(`altitude not ~60 km: ${r.altM} m`, browser, server, logs);
    }
    await page.screenshot({ path: join(__dir, 'test-url-everest.png') });
    console.log('PASS: ?lat=28&lon=86&alt=60&ve=8 places craft ~28N 86E at ~60 km');
    await page.close();
  }

  // ── 2. ?ve=8 alone changes relief vs default (no spawn params) ───────────────
  {
    const def = await loadPage(browser, baseUrl, '');
    const defRelief = await reliefMagnitude(def.page);
    const defLL = await def.page.evaluate(() => { const l = window._eng.lat_lon(); return [l[0], l[1]]; });
    await def.page.close();

    const veo = await loadPage(browser, baseUrl, '?ve=8');
    const veoRelief = await reliefMagnitude(veo.page);
    const veoLL = await veo.page.evaluate(() => { const l = window._eng.lat_lon(); return [l[0], l[1]]; });
    await veo.page.close();

    console.log(`VE-ONLY: default relief=${defRelief.toFixed(3)} (at ${defLL[0].toFixed(1)},${defLL[1].toFixed(1)}) ` +
      `vs ?ve=8 relief=${veoRelief.toFixed(3)} (at ${veoLL[0].toFixed(1)},${veoLL[1].toFixed(1)})`);
    // Default spawn at ~250 wu uses ve_for_altitude ≈ 1; forced ve=8 must be markedly more relief
    // at the SAME default location.
    if (!(veoRelief > defRelief * 1.5)) {
      fail(`?ve=8 did not increase relief: default=${defRelief} ve8=${veoRelief}`, browser, server);
    }
    console.log('PASS: ?ve=8 alone increases terrain relief at the default spawn');
  }

  await browser.close();
  server.close();
  console.log('All checks passed.');
}

run().catch(e => { console.error(e); process.exit(1); });
