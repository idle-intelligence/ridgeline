import test from 'node:test';
import assert from 'node:assert/strict';
import { rollForAspect, unrollDrag } from './system-view.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('rollForAspect: exactly 0 at and above square', () => {
  assert.equal(rollForAspect(1), 0);
  assert.equal(rollForAspect(1440 / 900), 0);
  assert.equal(rollForAspect(4), 0);
});

test('rollForAspect: full quarter turn at and below the portrait threshold', () => {
  close(rollForAspect(0.55), Math.PI / 2);
  close(rollForAspect(412 / 915), Math.PI / 2);
  close(rollForAspect(0.2), Math.PI / 2);
});

test('rollForAspect: monotonic and partial in between', () => {
  const near = rollForAspect(0.8);
  assert.ok(near > 0 && near < Math.PI / 2);
  let prev = Infinity;
  for (let a = 0.5; a <= 1.001; a += 0.025) {
    const r = rollForAspect(a);
    assert.ok(r <= prev + 1e-12, `roll increased at aspect ${a}`);
    prev = r;
  }
});

test('unrollDrag: identity when the camera is not rolled', () => {
  assert.deepEqual(unrollDrag(13, -7, 0), { dx: 13, dy: -7 });
});

test('unrollDrag: a quarter turn swaps the axes', () => {
  const r = Math.PI / 2;
  // Drag right → drives elevation, not azimuth.
  const right = unrollDrag(10, 0, r);
  close(right.dx, 0);
  close(right.dy, -10);
  // Drag down → drives azimuth, not elevation.
  const down = unrollDrag(0, 10, r);
  close(down.dx, 10);
  close(down.dy, 0);
});

test('unrollDrag: preserves magnitude at every roll', () => {
  for (const roll of [0.1, 0.7, Math.PI / 4, 1.4, Math.PI / 2]) {
    const d = unrollDrag(3, -4, roll);
    close(Math.hypot(d.dx, d.dy), 5, 1e-12);
  }
});

test('unrollDrag: rotation is continuous through the roll sweep', () => {
  let prev = unrollDrag(10, 0, 0);
  for (let a = 1; a >= 0.5; a -= 0.025) {
    const d = unrollDrag(10, 0, rollForAspect(a));
    assert.ok(Math.hypot(d.dx - prev.dx, d.dy - prev.dy) < 1.5,
      `drag mapping jumped at aspect ${a}`);
    prev = d;
  }
});

test('unrollDrag: the screen-horizontal drag keeps one rotational sense', () => {
  // Whatever the roll, dragging right must never reverse the world-space sense of
  // the rotation it drives — the component along the rolled right axis stays +10.
  for (const roll of [0, 0.3, 0.9, Math.PI / 2]) {
    const d = unrollDrag(10, 0, roll);
    const c = Math.cos(roll), s = Math.sin(roll);
    close(d.dx * c - d.dy * s, 10, 1e-12);
  }
});
