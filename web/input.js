// Input handler: keyboard (AZERTY + QWERTY + arrows) + pointer-lock freelook.
//
// Keyboard flies the plane (set_input); mouse drives camera freelook (set_look).
//
// Control mapping (event.code = physical position, layout-independent):
//   KeyW / ArrowUp    → pitch nose DOWN
//   KeyS / ArrowDown  → pitch nose UP
//   KeyA / ArrowLeft  → roll left
//   KeyD / ArrowRight → roll right
//   KeyQ              → yaw left  (rudder)
//   KeyE              → yaw right (rudder)
//   ShiftLeft/Right   → throttle up
//   CtrlLeft/Right    → throttle down
//   Space (held)      → afterburner
//   Mouse X/Y         → freelook yaw/pitch (set_look, view-only)
//   Touch (1 finger)  → freelook yaw/pitch (set_look, view-only)

const MOUSE_SENSITIVITY = 0.003; // radians per pixel
const TOUCH_SENSITIVITY = 2.2;   // touch px scaled into mouse-px units (comfortable swipe = useful pan)
const KEY_PITCH_RATE = 1.6;      // rad/s
const KEY_ROLL_RATE  = 2.5;      // rad/s
const RUDDER_RATE    = 0.5;      // rad/s for yaw keys

export class InputHandler {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this._dX = 0;
    this._dY = 0;
    this._locked = false;
    this._touchId = null; // identifier of the active look touch
    this._touchX = 0;
    this._touchY = 0;

    window.addEventListener('keydown', e => {
      this.keys.add(e.code);
      // Prevent browser from hijacking Ctrl and Shift
      if (e.code.startsWith('Control') || e.code.startsWith('Shift')) {
        e.preventDefault();
      }
      if (!this._locked && e.code !== 'Escape') {
        canvas.requestPointerLock();
      }
    });
    window.addEventListener('keyup', e => this.keys.delete(e.code));

    document.addEventListener('pointerlockchange', () => {
      this._locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', e => {
      if (!this._locked) return;
      this._dX += e.movementX;
      this._dY += e.movementY;
    });

    canvas.addEventListener('click', () => {
      if (!this._locked) canvas.requestPointerLock();
    });

    // --- Touch freelook (single finger drag = camera look, view-only) ---
    // Feeds the SAME _dX/_dY accumulators the mouse uses, scaled into
    // mouse-pixel units so set_look() sees one consistent convention.
    // Drag finger right → look right; drag finger down → look down.
    canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      if (this._touchId === null && e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        this._touchId = t.identifier;
        this._touchX = t.clientX;
        this._touchY = t.clientY;
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (this._touchId === null) return;
      for (const t of e.changedTouches) {
        if (t.identifier !== this._touchId) continue;
        const dx = t.clientX - this._touchX;
        const dy = t.clientY - this._touchY;
        this._touchX = t.clientX;
        this._touchY = t.clientY;
        // Mouse uses lookDX = -dX*sens (positive = look right). Negate dx so
        // dragging right looks right; leave dy so dragging down looks down.
        this._dX += -dx * TOUCH_SENSITIVITY;
        this._dY +=  dy * TOUCH_SENSITIVITY;
      }
    }, { passive: false });

    const endTouch = e => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this._touchId) {
          this._touchId = null;
          break;
        }
      }
    };
    canvas.addEventListener('touchend', endTouch, { passive: false });
    canvas.addEventListener('touchcancel', endTouch, { passive: false });
  }

  // Returns [thrust, 0, 0, pitch, yaw, roll, 0, afterburner] for eng.set_input().
  // Call once per frame before eng.set_input().
  sample() {
    const k = this.keys;

    // Throttle: Shift = up, Ctrl = down
    const thrust = ((k.has('ShiftLeft') || k.has('ShiftRight'))   ? 1 : 0)
                 - ((k.has('ControlLeft') || k.has('ControlRight')) ? 1 : 0);

    // Pitch: KeyW = nose DOWN, KeyS = nose UP; arrows mirror
    const pitch = ((k.has('KeyS') || k.has('ArrowDown')) ?  KEY_PITCH_RATE : 0)
                - ((k.has('KeyW') || k.has('ArrowUp'))   ?  KEY_PITCH_RATE : 0);

    // Yaw: KeyQ = left, KeyE = right
    const yaw = ((k.has('KeyQ')) ?  RUDDER_RATE : 0)
              + ((k.has('KeyE')) ? -RUDDER_RATE : 0);

    // Roll: KeyA/ArrowLeft = left, KeyD/ArrowRight = right
    const roll = ((k.has('KeyD') || k.has('ArrowRight')) ? KEY_ROLL_RATE : 0)
               - ((k.has('KeyA') || k.has('ArrowLeft'))  ? KEY_ROLL_RATE : 0);

    // Afterburner: Space held
    const afterburner = k.has('Space');

    // Consume mouse deltas — returned separately for set_look
    const dX = this._dX;
    const dY = this._dY;
    this._dX = 0;
    this._dY = 0;

    return {
      input: [thrust, 0, 0, pitch, yaw, roll, 0, afterburner],
      lookDX: -dX * MOUSE_SENSITIVITY,   // positive = look right
      lookDY: -dY * MOUSE_SENSITIVITY,   // positive = look up (inverted Y)
    };
  }
}
