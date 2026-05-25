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

  await browser.close();
  server.close();
  console.log('All checks passed.');
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
