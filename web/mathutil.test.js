import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, cross, dot, sub, add, scale,
  spherePt, vec3ToLatLon, rotateY, rodrigues, raySphere,
  clampPolar, POLE_LIMIT_Y,
} from './mathutil.js';

const EPS = 1e-6;       // exact-ish arithmetic
const TRIG = 1e-4;      // where trig accumulates

const approx = (a, b, eps = EPS) => Math.abs(a - b) <= eps;
function approxVec(actual, expected, eps = EPS, msg = '') {
  assert.equal(actual.length, expected.length, `${msg} length`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(approx(actual[i], expected[i], eps),
      `${msg} [${i}] expected ${expected[i]}, got ${actual[i]}`);
  }
}
const mag = v => Math.hypot(...v);

test('normalize: produces unit length', () => {
  const u = normalize([3, 4, 0]);
  assert.ok(approx(mag(u), 1));
  approxVec(u, [0.6, 0.8, 0]);
});

test('normalize: zero vector does not NaN', () => {
  const u = normalize([0, 0, 0]);
  for (const x of u) assert.ok(Number.isFinite(x), `component ${x} finite`);
  approxVec(u, [0, 0, 0]);
});

test('cross: known case x cross y = z', () => {
  approxVec(cross([1, 0, 0], [0, 1, 0]), [0, 0, 1]);
});

test('cross: result is orthogonal to both inputs', () => {
  const a = [1, 2, 3], b = [-4, 5, 6];
  const c = cross(a, b);
  assert.ok(approx(dot(c, a), 0));
  assert.ok(approx(dot(c, b), 0));
});

test('dot/add/sub/scale basics', () => {
  assert.ok(approx(dot([1, 2, 3], [4, 5, 6]), 32));
  approxVec(add([1, 2, 3], [4, 5, 6]), [5, 7, 9]);
  approxVec(sub([4, 5, 6], [1, 2, 3]), [3, 3, 3]);
  approxVec(scale([1, -2, 3], 2), [2, -4, 6]);
});

test('spherePt: equator/prime-meridian and pole', () => {
  approxVec(spherePt(0, 0), [1, 0, 0]);
  approxVec(spherePt(90, 0), [0, 1, 0]);
  approxVec(spherePt(-90, 123), [0, -1, 0]);
});

test('spherePt: radius scaling', () => {
  const p = spherePt(30, 40, 5);
  assert.ok(approx(mag(p), 5, TRIG));
});

test('spherePt <-> vec3ToLatLon round-trip', () => {
  const cases = [
    [0, 0], [45, 90], [-30, -120], [12.5, 179.5], [-12.5, -179.5],
    [0, 180], [0, -180], [60, 0], [-60, 45], [80, -170],
  ];
  for (const [lat, lon] of cases) {
    const [la, lo] = vec3ToLatLon(spherePt(lat, lon));
    assert.ok(approx(la, lat, TRIG), `lat ${lat} -> ${la}`);
    // longitude is periodic: +180 and -180 are the same point
    const dLon = Math.abs(((lo - lon + 540) % 360) - 180);
    assert.ok(approx(dLon, 0, TRIG), `lon ${lon} -> ${lo}`);
  }
});

test('rotateY invariant: rotateY(spherePt(lat,lon), d) == spherePt(lat, lon+d)', () => {
  const cases = [[20, 10, 35], [-45, 170, 25], [0, 0, 180], [60, -90, -45]];
  for (const [lat, lon, d] of cases) {
    approxVec(rotateY(spherePt(lat, lon), d), spherePt(lat, lon + d), TRIG,
      `lat=${lat} lon=${lon} d=${d}`);
  }
});

test('rotateY(v,0)==v and rotateY(v,360)~=v', () => {
  const v = [0.3, 0.6, -0.7];
  approxVec(rotateY(v, 0), v);
  approxVec(rotateY(v, 360), v, TRIG);
});

test('rodrigues(v, axis, 0) == v', () => {
  const v = [1, 2, 3], axis = normalize([0, 0, 1]);
  approxVec(rodrigues(v, axis, 0), v, TRIG);
});

test('rodrigues: 90deg about +Z maps x->y', () => {
  const axis = [0, 0, 1];
  approxVec(rodrigues([1, 0, 0], axis, Math.PI / 2), [0, 1, 0], TRIG);
});

test('raySphere: ray from outside through center hits at radius', () => {
  const R = 10;
  const origin = [0, 0, 30];
  const dir = normalize([0, 0, -1]); // toward origin/center
  const hit = raySphere(origin, dir, R);
  assert.ok(hit, 'expected a hit');
  assert.ok(approx(mag(hit), R, TRIG));
  approxVec(hit, [0, 0, R], TRIG); // near side
});

test('raySphere: miss returns null', () => {
  const hit = raySphere([0, 100, 30], normalize([0, 0, -1]), 10);
  assert.equal(hit, null);
});

test('raySphere: ray pointing away returns null', () => {
  const hit = raySphere([0, 0, 30], normalize([0, 0, 1]), 10);
  assert.equal(hit, null);
});

test('clampPolar: vector within +-88deg is unchanged', () => {
  const g = spherePt(80, 25); // 80 < 88
  approxVec(clampPolar(g), g);
});

test('clampPolar: near-pole vector clamped to |lat|~=88, lon preserved, stays unit', () => {
  const lon = 47;
  const g = spherePt(89.9, lon);
  const c = clampPolar(g);
  assert.ok(approx(mag(c), 1, TRIG), 'unit length');
  const [la, lo] = vec3ToLatLon(c);
  assert.ok(approx(Math.abs(la), 88, TRIG), `|lat| ${la}`);
  const dLon = Math.abs(((lo - lon + 540) % 360) - 180);
  assert.ok(approx(dLon, 0, TRIG), `lon preserved ${lo}`);
  assert.ok(approx(c[1], POLE_LIMIT_Y, TRIG), 'y == POLE_LIMIT_Y');
});

test('clampPolar: southern pole keeps sign', () => {
  const c = clampPolar(spherePt(-89.5, -10));
  assert.ok(c[1] < 0);
  assert.ok(approx(c[1], -POLE_LIMIT_Y, TRIG));
});
