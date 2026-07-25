import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('./renderer-webgpu.js', import.meta.url), 'utf8');

// WebGPU guarantees only 8 storage buffers per shader stage — Firefox ships exactly 8, Chrome
// is more generous at 10. Going over does not throw: the bind group layout goes invalid, the
// compute pipeline never runs, and the globe renders as a featureless disc with no ridgelines
// at all. Count them here so the next binding lands as a test failure instead.
const MAX_STORAGE_PER_STAGE = 8;

test('the compute stage stays inside the storage-buffer ceiling', () => {
  const start = SRC.indexOf('const COMPUTE_WGSL');
  const end = SRC.indexOf('const RENDER_WGSL');
  assert.ok(start >= 0 && end > start, 'could not locate COMPUTE_WGSL');
  const wgsl = SRC.slice(start, end);
  const storage = wgsl.match(/@group\(0\) @binding\(\d+\) var<storage/g) || [];
  assert.ok(
    storage.length <= MAX_STORAGE_PER_STAGE,
    `compute pass declares ${storage.length} storage buffers, ceiling is ${MAX_STORAGE_PER_STAGE}`,
  );
});

test('the adapter guard asks for as many storage buffers as the shader declares', () => {
  const decl = SRC.match(/const COMPUTE_STORAGE_BUFFERS = (\d+);/);
  assert.ok(decl, 'no COMPUTE_STORAGE_BUFFERS declaration found');
  assert.equal(Number(decl[1]), MAX_STORAGE_PER_STAGE);
  const guards = SRC.match(/limMaxStorage < COMPUTE_STORAGE_BUFFERS/g) || [];
  assert.equal(guards.length, 2, 'both adapter guards must use COMPUTE_STORAGE_BUFFERS');
  assert.ok(!/limMaxStorage < \d/.test(SRC), 'a guard still hardcodes a storage-buffer count');
});

test('no adapter-limit error promises a WebGL2 fallback', () => {
  assert.ok(!/fall back to WebGL2/.test(SRC), 'error text still promises a renderer that was deleted');
});
