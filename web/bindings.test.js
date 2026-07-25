import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('./renderer-webgpu.js', import.meta.url), 'utf8');

// Metal caps a shader stage at 10 storage buffers, and the renderer asks the adapter for
// exactly that. Adding an 11th does not throw — the bind group layout goes invalid, the
// compute pipeline never runs, and the globe renders as a featureless disc with no
// ridgelines at all. Count them here so the next binding lands as a test failure instead.
const MAX_STORAGE_PER_STAGE = 10;

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
  const guards = SRC.match(/limMaxStorage < (\d+)/g) || [];
  assert.ok(guards.length > 0, 'no maxStorageBuffersPerShaderStage guard found');
  for (const g of guards) {
    assert.equal(Number(g.match(/(\d+)$/)[1]), MAX_STORAGE_PER_STAGE);
  }
});
