import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Body } from './body.js';
import { WORLD_RADIUS } from './constants.js';
import { vec3ToLatLon } from './mathutil.js';

const TRIG = 1e-4;
const approx = (a, b, eps = TRIG) => Math.abs(a - b) <= eps;

function makeSpec(over = {}) {
  return {
    id: 'earth',
    name: 'EARTH',
    metaUrl: '../data/earth_meta.json',
    dataUrl: '../data/earth_heightfield.bin',
    radiusM: 6371000,
    rotationPeriodSec: 86164,
    color: [1, 1, 1],
    veFactor: 1.0,
    view: { lat: 10, lon: -20, altitude: 5000, tilt: 0.1, heading: 0.2 },
    modes: [
      [100, 'GROUND'],
      [1000, 'LOW'],
      [10000, 'HIGH'],
      [Infinity, 'ORBIT'],
    ],
    ...over,
  };
}

test('view.gpos is a length-3 array of finite, unit-magnitude numbers (regression guard)', () => {
  const b = new Body(makeSpec());
  const g = b.view.gpos;
  assert.ok(Array.isArray(g), 'gpos is an array');
  assert.equal(g.length, 3);
  for (const x of g) assert.ok(Number.isFinite(x), `component ${x} finite`);
  assert.ok(approx(Math.hypot(...g), 1), `magnitude ${Math.hypot(...g)}`);
});

test('view.gpos round-trips to the spec lat/lon', () => {
  for (const view of [
    { lat: 10, lon: -20 }, { lat: 0, lon: 0 },
    { lat: -45, lon: 170 }, { lat: 51.5, lon: -0.1 },
  ]) {
    const b = new Body(makeSpec({ view: { ...view, altitude: 1, tilt: 0, heading: 0 } }));
    const [la, lo] = vec3ToLatLon(b.view.gpos);
    assert.ok(approx(la, view.lat), `lat ${view.lat} -> ${la}`);
    const dLon = Math.abs(((lo - view.lon + 540) % 360) - 180);
    assert.ok(approx(dLon, 0), `lon ${view.lon} -> ${lo}`);
  }
});

test('view carries through altitude/tilt/heading and seeds planetRot=0', () => {
  const b = new Body(makeSpec());
  assert.equal(b.view.altitude, 5000);
  assert.equal(b.view.tilt, 0.1);
  assert.equal(b.view.heading, 0.2);
  assert.equal(b.view.planetRot, 0);
});

test('mPerWu = radiusM / WORLD_RADIUS', () => {
  const b = new Body(makeSpec({ radiusM: 6371000 }));
  assert.ok(approx(b.mPerWu, 6371000 / WORLD_RADIUS, 1e-9));
  assert.equal(WORLD_RADIUS, 6000);
});

test('rotDegPerSec = 360 / rotationPeriodSec', () => {
  const b = new Body(makeSpec({ rotationPeriodSec: 86164 }));
  assert.ok(approx(b.rotDegPerSec, 360 / 86164, 1e-12));
});

test('hasOcean defaults true and is false when spec sets it', () => {
  assert.equal(new Body(makeSpec()).hasOcean, true);
  assert.equal(new Body(makeSpec({ hasOcean: false })).hasOcean, false);
});

test('modeFor returns the right band, including boundaries and catch-all', () => {
  const b = new Body(makeSpec());
  // strictly-less-than each ceil
  assert.equal(b.modeFor(0), 'GROUND');
  assert.equal(b.modeFor(99.9), 'GROUND');
  // at the boundary 100 -> not < 100, falls to next band
  assert.equal(b.modeFor(100), 'LOW');
  assert.equal(b.modeFor(999.9), 'LOW');
  assert.equal(b.modeFor(1000), 'HIGH');
  assert.equal(b.modeFor(9999), 'HIGH');
  assert.equal(b.modeFor(10000), 'ORBIT');
  // far above the last finite ceil -> catch-all
  assert.equal(b.modeFor(1e9), 'ORBIT');
});

test('modeFor catch-all works when last ceil is finite', () => {
  const b = new Body(makeSpec({ modes: [[100, 'LOW'], [1000, 'HIGH']] }));
  assert.equal(b.modeFor(50), 'LOW');
  assert.equal(b.modeFor(500), 'HIGH');
  assert.equal(b.modeFor(50000), 'HIGH'); // beyond all ceils -> last label
});

test('identity/visual fields copied through', () => {
  const b = new Body(makeSpec());
  assert.equal(b.id, 'earth');
  assert.equal(b.name, 'EARTH');
  assert.equal(b.metaUrl, '../data/earth_meta.json');
  assert.equal(b.dataUrl, '../data/earth_heightfield.bin');
  assert.equal(b.orbit, null);
  assert.equal(b.veFactor, 1.0);
});
