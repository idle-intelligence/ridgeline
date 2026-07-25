import test from 'node:test';
import assert from 'node:assert/strict';
import { createDragTap, DRAG_SLOP, CLICK_MS } from './dragtap.js';

function harness(opts = {}) {
  let t = 0;
  const g = createDragTap({ ...opts, now: () => t });
  return { g, advance: ms => { t += ms; } };
}

test('a short still press is a tap', () => {
  const { g, advance } = harness();
  g.press(100, 100);
  advance(80);
  const r = g.release(102, 101);
  assert.equal(r.tap, true);
  assert.equal(r.x, 102);
  assert.equal(r.y, 101);
});

test('movement beyond the slop makes it a drag, never a tap', () => {
  const { g, advance } = harness();
  g.press(100, 100);
  const m = g.move(100 + DRAG_SLOP + 1, 100);
  assert.equal(m.dragging, true);
  advance(50);
  assert.equal(g.release(100 + DRAG_SLOP + 1, 100).tap, false);
});

test('movement within the slop stays a tap', () => {
  const { g } = harness();
  g.press(100, 100);
  const m = g.move(100 + DRAG_SLOP, 100);
  assert.equal(m.dragging, false);
  assert.equal(g.release(100 + DRAG_SLOP, 100).tap, true);
});

test('a long hold is a drag even without movement', () => {
  const { g, advance } = harness();
  g.press(50, 50);
  advance(CLICK_MS + 1);
  assert.equal(g.release(50, 50).tap, false);
});

test('a hold of exactly CLICK_MS still taps', () => {
  const { g, advance } = harness();
  g.press(50, 50);
  advance(CLICK_MS);
  assert.equal(g.release(50, 50).tap, true);
});

test('move reports the delta since the previous move, not since press', () => {
  const { g } = harness();
  g.press(0, 0);
  assert.deepEqual(g.move(10, 4), { dragging: true, dx: 10, dy: 4 });
  assert.deepEqual(g.move(13, 9), { dragging: true, dx: 3, dy: 5 });
});

test('once dragging, it stays dragging even if the finger returns to origin', () => {
  const { g } = harness();
  g.press(0, 0);
  g.move(40, 0);
  assert.equal(g.move(0, 0).dragging, true);
  assert.equal(g.release(0, 0).tap, false);
});

test('move without a press returns null and produces no delta', () => {
  const { g } = harness();
  assert.equal(g.move(10, 10), null);
  assert.equal(g.isDown, false);
});

test('cancel abandons the press — the later release is not a tap', () => {
  const { g } = harness();
  g.press(10, 10);
  g.cancel();
  assert.equal(g.isDown, false);
  assert.equal(g.release(10, 10).tap, false);
});

test('release without a press is never a tap', () => {
  const { g } = harness();
  assert.equal(g.release(5, 5).tap, false);
});

test('the touch flag rides with the press', () => {
  const { g } = harness();
  g.press(0, 0, true);
  assert.equal(g.isTouch, true);
  g.release(0, 0);
  g.press(0, 0);
  assert.equal(g.isTouch, false);
});

test('release falls back to the last known point when given none', () => {
  const { g } = harness();
  g.press(7, 8);
  const r = g.release(null, null);
  assert.equal(r.tap, true);
  assert.equal(r.x, 7);
  assert.equal(r.y, 8);
});
