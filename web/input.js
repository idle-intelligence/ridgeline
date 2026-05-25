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

const MOUSE_SENSITIVITY = 0.003; // radians per pixel
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

    // Yaw: KeyQ = left, KeyE = right (inverted relative to old build)
    const yaw = ((k.has('KeyQ')) ? -RUDDER_RATE : 0)
              + ((k.has('KeyE')) ?  RUDDER_RATE : 0);

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
      lookDX:  dX * MOUSE_SENSITIVITY,   // positive = look right
      lookDY: -dY * MOUSE_SENSITIVITY,   // positive = look up (inverted Y)
    };
  }
}
