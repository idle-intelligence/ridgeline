import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeMinElevPerVertex, computeOccluderField } from './renderer-webgpu.js';

const STACKS = 64, SLICES = 128;

// The whole point of the occluder is that it can never poke above the ridge lines: at every
// mesh vertex the envelope must be at or below the per-cell terrain MINIMUM it was built from.
function assertBelowMin(hf, w, h, label) {
  const { minElev } = computeMinElevPerVertex(hf, w, h, STACKS, SLICES);
  const env = computeOccluderField(hf, w, h, STACKS, SLICES);
  let worst = -Infinity, gapMin = Infinity, gapSum = 0;
  for (let i = 0; i < env.length; i++) {
    const over = env[i] - minElev[i];
    if (over > worst) worst = over;
    const gap = minElev[i] - env[i];
    if (gap < gapMin) gapMin = gap;
    gapSum += gap;
  }
  assert.ok(worst <= 0, `${label}: occluder rises ${worst} above the terrain minimum`);
  return { gapMin, gapMean: gapSum / env.length };
}

function randomTerrain(w, h, amplitude, seed) {
  const hf = new Int16Array(w * h);
  let s = seed;
  for (let i = 0; i < hf.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    hf[i] = Math.round((s / 4294967296 - 0.5) * 2 * amplitude);
  }
  return hf;
}

test('envelope stays at or below the per-cell terrain minimum (white noise)', () => {
  const { gapMin } = assertBelowMin(randomTerrain(360, 180, 20000, 12345), 360, 180, 'noise');
  assert.ok(gapMin >= 0);
});

test('envelope stays at or below the per-cell terrain minimum (isolated spikes)', () => {
  const w = 360, h = 180;
  const hf = new Int16Array(w * h); // flat plain…
  for (let i = 0; i < 200; i++) hf[(i * 977) % hf.length] = -30000; // …with lone deep pits
  assertBelowMin(hf, w, h, 'spikes');
});

// The `smooth` variant (the Sun) is near-spherical but must still clear every ridge foot,
// and must sit far closer than the global minimum a plain sphere would be pinned to.
test('smooth occluder is near-spherical, below the minimum, and above the global minimum', () => {
  const w = 360, h = 180;
  // Large-scale structure (what the reach has to average away) plus fine noise.
  const hf = new Int16Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const lat = (90 - r / (h - 1) * 180) * Math.PI / 180;
      const lon = (-180 + c / (w - 1) * 360) * Math.PI / 180;
      hf[r * w + c] = Math.round(15000 * Math.sin(3 * lon) * Math.cos(2 * lat));
    }
  }
  const { minElev } = computeMinElevPerVertex(hf, w, h, STACKS, SLICES);
  const rough = computeOccluderField(hf, w, h, STACKS, SLICES, false);
  const env = computeOccluderField(hf, w, h, STACKS, SLICES, true);
  const spread = (a) => { let lo = Infinity, hi = -Infinity; for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; } return hi - lo; };
  let globalMin = Infinity, sum = 0;
  for (let i = 0; i < env.length; i++) {
    assert.ok(env[i] <= minElev[i], `smooth field rises ${env[i] - minElev[i]} above the terrain minimum`);
    if (minElev[i] < globalMin) globalMin = minElev[i];
    sum += env[i];
  }
  assert.ok(spread(env) < 0.5 * spread(rough), `smooth field varies ${spread(env)} vs ${spread(rough)} — not flatter`);
  assert.ok(sum / env.length > globalMin, 'smooth field should sit above the global minimum a plain sphere needs');
});

// Real bakes, when the blobs are present (they live in the HF dataset, not in git).
const BODIES = [
  ['earth', 'meta.json', 'heightfield_d16.bin'],
  ['moon', 'moon_meta.json', 'moon_heightfield_d16.bin'],
  ['mars', 'mars_meta.json', 'mars_heightfield_d16.bin'],
  ['venus', 'venus_meta.json', 'venus_heightfield_d16.bin'],
  ['mercury', 'mercury_meta.json', 'mercury_heightfield_d16.bin'],
  ['ceres', 'ceres_meta.json', 'ceres_heightfield_d16.bin'],
  ['vesta', 'vesta_meta.json', 'vesta_heightfield_d16.bin'],
  ['enceladus', 'enceladus_meta.json', 'enceladus_heightfield_d16.bin'],
  ['pluto', 'pluto_meta.json', 'pluto_heightfield_d16.bin'],
  ['charon', 'charon_meta.json', 'charon_heightfield_d16.bin'],
  ['sun', 'sun_meta.json', 'sun_heightfield_d16.bin'],
];

test('every baked body: envelope never rises above the terrain minimum', (t) => {
  const dir = new URL('../data/', import.meta.url);
  for (const [id, metaFile, binFile] of BODIES) {
    const binPath = new URL(binFile, dir);
    const metaPath = new URL(metaFile, dir);
    if (!fs.existsSync(binPath) || !fs.existsSync(metaPath)) {
      t.diagnostic(`${id}: heightfield not present — skipped`);
      continue;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const w = Math.floor(meta.width / 16), h = Math.floor(meta.height / 16);
    const buf = fs.readFileSync(binPath);
    const hf = new Int16Array(buf.buffer, buf.byteOffset, w * h);
    const { gapMin, gapMean } = assertBelowMin(hf, w, h, id);
    t.diagnostic(`${id}: gap below terrain min — worst ${gapMin.toFixed(0)}, mean ${gapMean.toFixed(0)} raw units`);
  }
});
