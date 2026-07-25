import { WORLD_RADIUS } from './constants.js';

// Unit vector on the sphere for a lat/lon (matches the renderer's sphere mapping:
// +Y = north pole, col 0 = west). Used to seed the pole-safe gpos orbit state.
function unitFromLatLon(latDeg, lonDeg) {
  const phi = latDeg * Math.PI / 180, lam = lonDeg * Math.PI / 180;
  return [Math.cos(phi) * Math.cos(lam), Math.sin(phi), -Math.cos(phi) * Math.sin(lam)];
}

// A celestial body the explorer can visit: where its elevation data lives, its physical
// scale and rotation, how it's styled, and its HUD altitude bands. One Body owns
// everything body-specific so adding a planet is "write one descriptor + bake one
// heightfield" — no renderer changes.
//
// Render tuning that depends on the CAMERA MODE (LOD strides, occluder gate, fill
// density, longitude padding) deliberately lives in the renderer, not here — it's the
// same for every body in a given mode. Per-body GPU resources (heightfield buffer +
// compute bind group) are attached to `handle` once the renderer registers the body.
export class Body {
  constructor(spec) {
    // Identity & data source
    this.id = spec.id;                 // 'earth' | 'moon' | …
    this.name = spec.name;             // HUD label, e.g. 'EARTH'
    this.metaUrl = spec.metaUrl;       // ../data/<body>_meta.json
    this.dataUrl = spec.dataUrl;       // ../data/<body>_heightfield.bin (full-res)
    this.hfStem = spec.hfStem;         // bare file name stem, e.g. 'heightfield', 'moon_heightfield'

    // Physical
    this.radiusM = spec.radiusM;                 // true mean radius (for km scale)
    this.rotationPeriodSec = spec.rotationPeriodSec; // sidereal rotation period
    this.orbit = spec.orbit ?? null;   // { aroundId, periodSec, inclinationDeg } | null

    // Visual
    this.veFactor = spec.veFactor ?? 1.0; // multiplies vertical exaggeration
    this.color = spec.color;              // accent colour (sky marker / arrow)
    this.hasOcean = spec.hasOcean ?? true; // false → render all terrain as land (airless body)
    this.tint = spec.tint ?? null;         // optional [r,g,b] line/fill tint (>1 = emissive boost)
    // Altitude-based resting-pitch morph — off everywhere by default: zooming should keep
    // the angle you set rather than swinging the camera under you. A body can still opt in
    // with an explicit `autoTilt: true` in its spec.
    this.autoTilt = spec.autoTilt ?? false;
    this.trueShape = spec.trueShape ?? false; // true → pin ve to fixedVe (true-proportion rendering)
    this.smoothOccluder = spec.smoothOccluder ?? false; // true → occluder is a plain sphere, not a terrain envelope

    // HUD altitude bands: ascending [[ceilWu, label], …]; last is the catch-all.
    this.modes = spec.modes;

    // Live camera state for this body (preserved while you're visiting another).
    // gpos is the orbit position as a planet-fixed unit vector (pole-singularity-free);
    // it's seeded from the human-readable lat/lon in the spec.
    this._spawn = spec.view; // { lat, lon, altitude, tilt, heading } — canonical entry framing
    this.view = {};
    this.resetView();

    // Runtime, filled in during load/registration:
    this.meta = null;     // parsed <body>_meta.json
    this.engine = null;   // WASM Engine holding this body's heightfield (current tier)
    this.handle = null;   // renderer body handle (GPU buffer + bind group + dims, current tier)

    // Tier state: 0 = nothing loaded, 16 = d16 loaded, 4 = d4 loaded, 1 = full loaded.
    this.tier = 0;
    // Current grid dims (change with each tier upgrade; meta.width/height always = full dims).
    this.gridW = 0;
    this.gridH = 0;
    // WASM memory offset for sampleElevM (current tier's int16 data).
    this.hfPtr = null;
  }

  // Restore the canonical entry framing (called on spawn and every time you jump here — we
  // deliberately DON'T remember where you left off, so each visit starts the same way).
  resetView() {
    const v = this._spawn;
    this.view.gpos = unitFromLatLon(v.lat, v.lon);
    this.view.altitude = v.altitude;
    this.view.tilt = v.tilt;
    this.view.heading = v.heading;
    this.view.planetRot = 0;
    this._autoTilt = false; // re-armed on mode change; disabled by user pitch drag
    this._prevMode = undefined;
    this._fixedVe = undefined; // re-derived on first frame after meta+handle are available
  }

  // Real metres per world unit — drives the HUD km readout for this body.
  get mPerWu() { return this.radiusM / WORLD_RADIUS; }

  // Rotation rate in degrees/second of real time (scaled by the sim time multiplier).
  get rotDegPerSec() { return 360 / this.rotationPeriodSec; }

  // HUD mode label for a given altitude (world units above the reference sphere).
  modeFor(altWu) {
    for (const [ceil, label] of this.modes) if (altWu < ceil) return label;
    return this.modes[this.modes.length - 1][1];
  }
}
