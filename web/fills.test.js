import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebGPURenderer } from './renderer-webgpu.js';

const R_WORLD = 6000;

// Build the fill-strip schedule the way draw() does, without a GPU device.
function fillBands({ gridW, gridH, altWu, camLat = 0 }) {
  const r = Object.create(WebGPURenderer.prototype);
  r.gridW = gridW; r.gridH = gridH;
  r.latMin = -90; r.latMax = 90; r.lonMin = -180; r.lonMax = 180;
  r.canvas = { width: 1440, height: 800 };
  r._ringScratch = new ArrayBuffer(24_000 * 16);
  r._fillRowScratch = new ArrayBuffer(8_000 * 32);
  r._exploreLodAlt = altWu;
  r._lonPad = 14.0;
  const camR = R_WORLD + altWu;
  const phi = camLat * Math.PI / 180;
  const { fillCount } = r._buildSchedule([camR * Math.cos(phi), camR * Math.sin(phi), 0]);
  const dv = new DataView(r._fillRowScratch);
  const bands = [];
  for (let i = 0; i < fillCount; i++) bands.push([dv.getUint32(i * 32, true), dv.getUint32(i * 32 + 4, true)]);
  return bands;
}

// The dark surface must be CONTINUOUS — any latitude with no strip over it is sky showing
// through the body. The bands must tile row 0 to row gridH−1 with no gap and no overlap.
const CASES = [
  ['enceladus, 2 km', { gridW: 7680, gridH: 3840, altWu: 47.6 }],
  ['enceladus, 2 km, near the pole', { gridW: 7680, gridH: 3840, altWu: 47.6, camLat: 85 }],
  ['earth full, lowest', { gridW: 12288, gridH: 6144, altWu: 20 }],
  ['earth full, mid', { gridW: 12288, gridH: 6144, altWu: 1400 }],
  ['vesta full', { gridW: 11520, gridH: 5760, altWu: 47.6 }],
  ['sun', { gridW: 2880, gridH: 1440, altWu: 47.6 }],
  ['moon, grazing', { gridW: 7680, gridH: 3840, altWu: 5 }],
];

for (const [name, cfg] of CASES) {
  test(`fill bands tile every latitude (${name})`, () => {
    const bands = fillBands(cfg);
    assert.ok(bands.length > 0, 'no fill bands emitted');
    assert.equal(bands[0][0], 0, 'first band does not start at the north pole row');
    for (let i = 1; i < bands.length; i++) {
      assert.equal(bands[i][0], bands[i - 1][1], `rows ${bands[i - 1][1]}..${bands[i][0]} have no strip over them`);
    }
    assert.equal(bands[bands.length - 1][1], cfg.gridH - 1, 'last band does not reach the south pole row');
  });
}
