// Input handler: keyboard (AZERTY + QWERTY + arrows) + pointer-lock mouse-look.
// Produces the 8 args for eng.set_input() per API.md:
//   thrust, strafe(0), lift(0), pitch, yaw, roll, boost, ftl

// Mouse-look accumulates deltas each frame and resets them; core integrates rates.
const MOUSE_SENSITIVITY = 0.006; // radians per pixel
const KEY_TURN_RATE = 1.2;       // radians/sec for roll
const RUDDER_RATE = 0.35;        // radians/sec for slow key yaw (Q/E)

export class InputHandler {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this._dX = 0;  // accumulated mouse delta this frame
    this._dY = 0;
    this._locked = false;

    window.addEventListener('keydown', e => {
      this.keys.add(e.code);
      // request pointer lock on first action key
      if (!this._locked && !['Escape'].includes(e.code)) {
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

    // Click on canvas also requests pointer lock
    canvas.addEventListener('click', () => {
      if (!this._locked) canvas.requestPointerLock();
    });
  }

  // Returns the 8-arg tuple; call this once per frame before eng.set_input().
  // Keyboard mapping (event.code = physical key position, layout-independent):
  //   KeyW / ArrowUp    → thrust +1  (Z on AZERTY, W on QWERTY)
  //   KeyS / ArrowDown  → thrust -1
  //   KeyA / ArrowLeft  → roll left  (Q on AZERTY, A on QWERTY)
  //   KeyD / ArrowRight → roll right
  //   KeyQ / KeyE       → slow yaw left / right (rudder)
  //   Mouse X           → yaw, Mouse Y → pitch
  //   ShiftLeft/Right   → boost, Space → FTL
  sample() {
    const k = this.keys;

    // Throttle: W/S + arrow up/down mirrors
    const thrust = (k.has('KeyW') || k.has('ArrowUp')    ? 1 : 0)
                 - (k.has('KeyS') || k.has('ArrowDown')   ? 1 : 0);

    // pitch: mouse Y (negated — mouse up = nose up / look up, original feel)
    // pre-9516005 behavior: mouse-up pitches nose down; restore that by negating dY.
    const mousePitch = -this._dY * MOUSE_SENSITIVITY;
    const pitch = mousePitch;

    // yaw: mouse X (negated — mouse right = turn right)
    const mouseYaw = -this._dX * MOUSE_SENSITIVITY;
    // rudder: KeyQ = yaw left, KeyE = yaw right (slow rate)
    const rudder = (k.has('KeyE') ? RUDDER_RATE : 0) - (k.has('KeyQ') ? RUDDER_RATE : 0);
    const yaw = mouseYaw + rudder;

    // roll: KeyA/ArrowLeft = roll left, KeyD/ArrowRight = roll right
    const roll = (k.has('KeyD') || k.has('ArrowRight') ? KEY_TURN_RATE : 0)
               - (k.has('KeyA') || k.has('ArrowLeft')  ? KEY_TURN_RATE : 0);

    // boost: Shift
    const boost = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 1.0 : 0.0;

    // ftl: Space held
    const ftl = k.has('Space');

    // reset accumulated mouse deltas
    this._dX = 0;
    this._dY = 0;

    return [thrust, 0, 0, pitch, yaw, roll, boost, ftl];
  }
}
