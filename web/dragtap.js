/**
 * dragtap.js — press/drag/tap discrimination shared by mouse and touch.
 *
 * A press that moves more than `slop` px, or is held longer than `holdMs`, is a
 * drag and never counts as a tap. Anything shorter and stiller is a tap.
 * Pure state machine over (x, y, t) — no DOM, so both input paths and the tests
 * drive the exact same logic.
 */

export const DRAG_SLOP = 5;   // px
export const CLICK_MS  = 450;

export function createDragTap({ slop = DRAG_SLOP, holdMs = CLICK_MS, now = () => performance.now() } = {}) {
  let down = false, dragging = false, touch = false;
  let downX = 0, downY = 0, downT = 0, x = 0, y = 0;

  return {
    get isDown()    { return down; },
    get isDragging(){ return dragging; },
    get isTouch()   { return touch; },
    get x()         { return x; },
    get y()         { return y; },

    /** Begin a press. */
    press(px, py, isTouch = false) {
      down = true; dragging = false; touch = isTouch;
      downX = x = px; downY = y = py; downT = now();
    },

    /**
     * Continue a press. Returns null when no press is active, otherwise
     * { dragging, dx, dy } with the delta since the previous move.
     */
    move(px, py) {
      if (!down) { x = px; y = py; return null; }
      if (!dragging && Math.hypot(px - downX, py - downY) > slop) dragging = true;
      const dx = px - x, dy = py - y;
      x = px; y = py;
      return { dragging, dx, dy };
    },

    /**
     * End a press. Returns { tap, x, y } — `tap` is true only for a press that
     * never became a drag and was released within `holdMs`.
     */
    release(px, py) {
      if (!down) return { tap: false, x, y };
      if (px != null) x = px;
      if (py != null) y = py;
      const tap = !dragging && (now() - downT) <= holdMs;
      down = false; dragging = false;
      return { tap, x, y };
    },

    /** Abandon the press without producing a tap (second finger, touchcancel). */
    cancel() { down = false; dragging = false; },
  };
}
