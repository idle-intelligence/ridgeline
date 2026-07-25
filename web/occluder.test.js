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

test('smooth occluder is a constant sphere below every sample', () => {
  const w = 360, h = 180;
  const hf = randomTerrain(w, h, 20000, 999);
  const env = computeOccluderField(hf, w, h, STACKS, SLICES, true);
  const r = env[0];
  for (const v of env) assert.equal(v, r);
  for (const v of hf) assert.ok(r <= v, `sphere at ${r} is above a sample at ${v}`);
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
