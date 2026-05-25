// Input handler: keyboard (AZERTY + QWERTY + arrows) + pointer-lock mouse-look.
// Produces the 8 args for eng.set_input() per API.md:
//   thrust, strafe, lift, pitch, yaw, roll, boost, ftl

// Mouse-look accumulates deltas each frame and resets them; core integrates rates.
const MOUSE_SENSITIVITY = 0.0015; // radians per pixel
const KEY_TURN_RATE = 1.2;        // radians/sec for key-based look

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
  sample() {
    const k = this.keys;

    // thrust: Z (AZERTY fwd) or ArrowUp = +1, S or ArrowDown = -1
    const thrust = (k.has('KeyZ') || k.has('ArrowUp')   ? 1 : 0)
                 - (k.has('KeyS') || k.has('ArrowDown')  ? 1 : 0);

    // strafe: Q (AZERTY left) or ArrowLeft = -1, D or ArrowRight = +1
    const strafe = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0)
                 - (k.has('KeyQ') || k.has('ArrowLeft')  ? 1 : 0);

    // lift: no dedicated key in v1 spec; R/F as convenience (not in spec, leave at 0)
    const lift = (k.has('KeyR') ? 1 : 0) - (k.has('KeyF') ? 1 : 0);

    // pitch from mouse Y + keyboard fallback (I=pitch up, K=pitch down)
    const mousePitch = this._dY * MOUSE_SENSITIVITY;
    const keyPitch   = (k.has('KeyI') ? -KEY_TURN_RATE : 0)
                     + (k.has('KeyK') ?  KEY_TURN_RATE : 0);
    const pitch = mousePitch + keyPitch;

    // yaw from mouse X + keyboard fallback
    const mouseYaw = this._dX * MOUSE_SENSITIVITY;
    const keyYaw   = (k.has('KeyJ') ? -KEY_TURN_RATE : 0)
                   + (k.has('KeyL') ?  KEY_TURN_RATE : 0);
    const yaw = mouseYaw + keyYaw;

    // roll: A = left roll, E = right roll  (per API.md)
    const roll = (k.has('KeyE') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);

    // boost: Shift
    const boost = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 1.0 : 0.0;

    // ftl: Space held
    const ftl = k.has('Space');

    // reset accumulated mouse deltas
    this._dX = 0;
    this._dY = 0;

    return [thrust, strafe, lift, pitch, yaw, roll, boost, ftl];
  }
}
