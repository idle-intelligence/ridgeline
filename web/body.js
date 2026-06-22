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
    this.dataUrl = spec.dataUrl;       // ../data/<body>_heightfield.bin

    // Physical
    this.radiusM = spec.radiusM;                 // true mean radius (for km scale)
    this.rotationPeriodSec = spec.rotationPeriodSec; // sidereal rotation period
    this.orbit = spec.orbit ?? null;   // { aroundId, periodSec, inclinationDeg } | null

    // Visual
    this.veFactor = spec.veFactor ?? 1.0; // multiplies vertical exaggeration
    this.color = spec.color;              // accent colour (sky marker / arrow)

    // HUD altitude bands: ascending [[ceilWu, label], …]; last is the catch-all.
    this.modes = spec.modes;

    // Live camera state for this body (preserved while you're visiting another).
    // gpos is the orbit position as a planet-fixed unit vector (pole-singularity-free);
    // it's seeded from the human-readable lat/lon in the spec.
    const v = spec.view;
    this.view = {
      gpos: unitFromLatLon(v.lat, v.lon),
      altitude: v.altitude, tilt: v.tilt, heading: v.heading, planetRot: 0,
    };

    // Runtime, filled in during load/registration:
    this.meta = null;     // parsed <body>_meta.json
    this.engine = null;   // WASM Engine holding this body's heightfield
    this.handle = null;   // renderer body handle (GPU buffer + bind group + dims)
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
