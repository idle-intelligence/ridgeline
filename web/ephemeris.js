/**
 * ephemeris.js — lightweight Keplerian ephemeris for ridgeline explore mode.
 *
 * Accuracy: a few degrees is sufficient. What is guaranteed correct:
 *   (a) relative geometry between bodies at any instant,
 *   (b) motion over accelerated time (sweeps real orbital configuration),
 *   (c) which side of the horizon a body is on,
 *   (d) plausible periods (derived from the elements, not hardcoded).
 *
 * Accepted simplification: no per-body ascending-node longitude alignment and no
 * sidereal-angle rotation of the observer body's terrain grid. This means the
 * azimuth of a sky marker may be off by a constant ~0–360° rotation relative to
 * the terrain's longitude grid, but altitude (elevation above horizon) and
 * relative motion between bodies are correct. The offset is FIXED for any given
 * session and changes only slowly between sessions (Earth's sidereal angle drifts
 * ~1° per day). A follow-up could add GMST rotation to remove the offset entirely.
 *
 * Pure ES module — no DOM. Importable in Node for tests.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Julian date of the J2000.0 epoch (2000-Jan-1 12:00 TT). */
const J2000 = 2451545.0;

/** Degrees → radians. */
const D2R = Math.PI / 180;

// ── Keplerian elements table ─────────────────────────────────────────────────
// Source: JPL/Standish "Keplerian Elements for Approximate Positions of the
// Major Planets" (https://ssd.jpl.nasa.gov/planets/approx_pos.html), Table 1
// (1800–2050 AD range, J2000 epoch). Each entry:
//   a0  [AU]         — semi-major axis at J2000
//   da  [AU/cy]      — rate per Julian century
//   e0  [1]          — eccentricity at J2000
//   de  [1/cy]       — rate
//   I0  [deg]        — inclination at J2000
//   dI  [deg/cy]     — rate
//   L0  [deg]        — mean longitude at J2000
//   dL  [deg/cy]     — rate (= n × 36525)
//   ω0  [deg]        — longitude of perihelion (ϖ = Ω + ω) at J2000
//   dω  [deg/cy]     — rate
//   Ω0  [deg]        — longitude of ascending node at J2000
//   dΩ  [deg/cy]     — rate
//
// Jupiter and Saturn are included for future markers (cheap to compute).

const ELEMENTS = {
  mercury: { a0:0.38709927, da: 0.00000037, e0:0.20563593, de: 0.00001906,
             I0:7.00497902,   dI:-0.00594749, L0:252.25032350, dL:149472.67411175,
             w0:77.45779628,  dw: 0.16047689, O0: 48.33076593, dO:-0.12534081 },
  venus:   { a0:0.72333566, da: 0.00000390, e0:0.00677672, de:-0.00004107,
             I0:3.39467605,   dI:-0.00078890, L0:181.97909950, dL: 58517.81538729,
             w0:131.60246718, dw: 0.00268329, O0: 76.67984255, dO:-0.27769418 },
  earth:   { a0:1.00000261, da: 0.00000562, e0:0.01671123, de:-0.00004392,
             I0:-0.00001531,  dI:-0.01294668, L0:100.46457166, dL: 35999.37244981,
             w0:102.93768193, dw: 0.32327364, O0:  0.0,        dO: 0.0 },
  mars:    { a0:1.52371034, da: 0.00001847, e0:0.09339410, de: 0.00007882,
             I0:1.84969142,   dI:-0.00813131, L0:-4.55343205,  dL: 19140.30268499,
             w0:-23.94362959, dw: 0.44441088, O0: 49.55953891, dO:-0.29257343 },
  jupiter: { a0:5.20288700, da:-0.00011607, e0:0.04838624, de:-0.00013253,
             I0:1.30439695,   dI:-0.00183714, L0:34.39644051,  dL:  3034.74612775,
             w0:14.72847983,  dw: 0.21252668, O0:100.47390909, dO: 0.20469106 },
  saturn:  { a0:9.53667594, da:-0.00125060, e0:0.05386179, de:-0.00050991,
             I0:2.48599187,   dI: 0.00193609, L0:49.95424423,  dL:  1222.49362201,
             w0:92.59887831,  dw:-0.41897216, O0:113.66242448, dO:-0.28867794 },
  // Pluto: Standish (1992) / JPL approximate elements Table 2 (1800–2050 range, J2000 epoch).
  // a few degrees accuracy is sufficient for marker placement.
  pluto:   { a0:39.48211675, da:-0.00031596, e0:0.24882730, de: 0.00005170,
             I0:17.14001206,  dI: 0.00004818, L0:238.92903833, dL:  145.20780515,
             w0:224.06891629, dw:-0.04062942, O0:110.30393684, dO:-0.01183482 },
  // Ceres: approximate elements from USNO/MPC orbital data (a, e, I, period).
  // Mean longitude L0 at J2000 is approximate — the phase is plausible but not fitted.
  ceres:   { a0:2.76750591,  da: 0.0,        e0:0.07850400, de: 0.0,
             I0:10.59406704,  dI: 0.0,        L0:291.40,      dL: 360 * 36525 / 1682,
             w0:73.59759364,  dw: 0.0,        O0: 80.32942800, dO: 0.0 },
  // Vesta: approximate elements from USNO/MPC orbital data (a, e, I, period).
  // Mean longitude L0 at J2000 is approximate — the phase is plausible but not fitted.
  vesta:   { a0:2.36126423,  da: 0.0,        e0:0.08874128, de: 0.0,
             I0: 7.14187571,  dI: 0.0,        L0:103.85,      dL: 360 * 36525 / 1325,
             w0:151.19853039, dw: 0.0,        O0:103.81050905, dO: 0.0 },
};

/**
 * Axial obliquity relative to the ecliptic plane, in degrees.
 * Used by bodySkyDirection() to rotate the ecliptic direction into the
 * observer body's render frame (+Y = spin axis).
 *
 * mercury: IAU 2009 (0.034°, effectively 0)
 * venus:   retrograde → 180° - 2.64° ≈ 177.36°; we use IAU 2009 = 177.4°
 * earth:   23.44° (mean, J2000)
 * moon:    1.54° (mean inclination to ecliptic)
 * mars:    25.19° (IAU 2009)
 * sun:     7.25° (inclination of solar equator to ecliptic)
 */
export const OBLIQUITY = {
  mercury:   0.03,
  venus:   177.4,
  earth:    23.44,
  moon:      1.54,
  mars:     25.19,
  sun:       7.25,
  ceres:     4.0,
  vesta:    27.0,
  enceladus: 27.0,   // approximately co-planar with Saturn's equator
  pluto:   119.6,
  charon:  119.6,
};

// ── Time ─────────────────────────────────────────────────────────────────────

/**
 * Convert Unix timestamp (milliseconds) to Julian Date.
 * @param {number} ms — Date.now() or similar
 * @returns {number} Julian date
 */
export function toJD(ms) {
  return ms / 86400000.0 + 2440587.5;
}

// ── Kepler solver ─────────────────────────────────────────────────────────────

/** Solve E − e·sin(E) = M via Newton–Raphson (≤ 6 iterations). E and M in radians. */
function solveKepler(M, e) {
  let E = M + e * Math.sin(M); // good first guess
  for (let i = 0; i < 6; i++) {
    const dE = (M - E + e * Math.sin(E)) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

/** Normalize an angle (degrees) to [−180, 180). */
function normDeg(deg) {
  let d = deg % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// ── Heliocentric ecliptic position ──────────────────────────────────────────

/**
 * Heliocentric ecliptic J2000 position of a solar-system body.
 *
 * @param {string} bodyId — 'mercury' | 'venus' | 'earth' | 'mars' | 'jupiter' | 'saturn'
 * @param {number} jd — Julian date
 * @returns {[number,number,number]} [x, y, z] in AU, heliocentric ecliptic J2000
 */
export function helioEcl(bodyId, jd) {
  const el = ELEMENTS[bodyId];
  if (!el) throw new Error(`Unknown body: ${bodyId}`);

  const T = (jd - J2000) / 36525.0; // Julian centuries from J2000

  // Evaluate mean elements at epoch T.
  const a = el.a0 + el.da * T;
  const e = el.e0 + el.de * T;
  const I = (el.I0 + el.dI * T) * D2R;
  const L = (el.L0 + el.dL * T) * D2R;
  const w = (el.w0 + el.dw * T) * D2R; // longitude of perihelion ϖ
  const O = (el.O0 + el.dO * T) * D2R; // longitude of ascending node Ω

  // Argument of perihelion ω = ϖ − Ω.
  const om = w - O;

  // Mean anomaly M = L − ϖ, normalized to (−π, π).
  const M = normDeg((L - w) / D2R) * D2R;

  // Eccentric anomaly E.
  const E = solveKepler(M, e);

  // Perifocal coordinates (heliocentric, in orbital plane).
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

  // Rotate from perifocal into heliocentric ecliptic J2000.
  // R_z(−Ω) · R_x(−I) · R_z(−ω)
  const cosO = Math.cos(O), sinO = Math.sin(O);
  const cosI = Math.cos(I), sinI = Math.sin(I);
  const cosom = Math.cos(om), sinom = Math.sin(om);

  const x = (cosO * cosom - sinO * sinom * cosI) * xp + (-cosO * sinom - sinO * cosom * cosI) * yp;
  const y = (sinO * cosom + cosO * sinom * cosI) * xp + (-sinO * sinom + cosO * cosom * cosI) * yp;
  const z = (sinom * sinI) * xp + (cosom * sinI) * yp;

  return [x, y, z];
}

// ── Moon geocentric ecliptic position ────────────────────────────────────────

/**
 * Geocentric ecliptic J2000 position of the Moon.
 * Truncated Meeus-style series (Chapter 47 of "Astronomical Algorithms", 2nd ed.).
 * Accuracy: ~0.5° in longitude, ~0.2° in latitude, ~0.5% in distance — plenty
 * for marker placement.
 *
 * @param {number} jd — Julian date
 * @returns {[number,number,number]} [x, y, z] in AU, geocentric ecliptic J2000
 */
export function moonGeoEcl(jd) {
  const T = (jd - J2000) / 36525.0;

  // Fundamental arguments (degrees, then converted to radians for trig).
  // Mean longitude of the Moon.
  const Lm = (218.3164477 + 481267.88123421 * T) * D2R;
  // Mean elongation of the Moon.
  const D  = (297.8501921 + 445267.1114034  * T) * D2R;
  // Sun's mean anomaly.
  const Ms = (357.5291092 +  35999.0502909  * T) * D2R;
  // Moon's mean anomaly.
  const Mm = (134.9633964 + 477198.8675055  * T) * D2R;
  // Moon's argument of latitude.
  const F  = (93.2720950  + 483202.0175233  * T) * D2R;

  // Longitude perturbations (arcseconds → degrees after sum).
  // Leading terms only; accuracy goal ~0.5°.
  const dL = (
    6288774 * Math.sin(Mm) +
    1274027 * Math.sin(2*D - Mm) +
     658314 * Math.sin(2*D) +
     213618 * Math.sin(2*Mm) +
    -185116 * Math.sin(Ms) +
    -114332 * Math.sin(2*F) +
      58793 * Math.sin(2*D - 2*Mm) +
      57066 * Math.sin(2*D - Ms - Mm) +
      53322 * Math.sin(2*D + Mm) +
      45758 * Math.sin(2*D - Ms)
  ) / 1000000.0; // arcseconds → degrees

  // Latitude perturbations.
  const dB = (
    5128122 * Math.sin(F) +
     280602 * Math.sin(Mm + F) +
     277693 * Math.sin(Mm - F) +
     173237 * Math.sin(2*D - F) +
      55413 * Math.sin(2*D + F - Mm) +
      46271 * Math.sin(2*D + F + Mm) +  // sign fixed vs some tables — Meeus Table 47B row 6
      32573 * Math.sin(2*D + F)
  ) / 1000000.0;

  // Distance (km). Mean is 385000.56 km.
  const dR = (
   -20905355 * Math.cos(Mm) +
    -3699111 * Math.cos(2*D - Mm) +
    -2955968 * Math.cos(2*D) +
     -569925 * Math.cos(2*Mm) +
      48888 * Math.cos(Ms) +
      -3149 * Math.cos(2*F) +
      246158 * Math.cos(2*D - 2*Mm) +
     -152138 * Math.cos(2*D - Ms - Mm) +
     -170733 * Math.cos(2*D + Mm)
  );
  const dist_km = 385000.56 + dR / 1000.0; // km

  // Ecliptic longitude (λ) and latitude (β) in radians.
  const lambda = Lm + dL * D2R;
  const beta   = dB * D2R;
  const dist_AU = dist_km / 149597870.7; // km → AU

  // Convert spherical ecliptic → Cartesian ecliptic.
  return [
    dist_AU * Math.cos(beta) * Math.cos(lambda),
    dist_AU * Math.cos(beta) * Math.sin(lambda),
    dist_AU * Math.sin(beta),
  ];
}

// ── Direction helpers ─────────────────────────────────────────────────────────

/**
 * Satellite mini-orbit table.  Each entry defines a body that orbits a parent
 * planet with a circular orbit in the ecliptic plane (an approximation — the
 * real inclination is small for Charon and Enceladus, and the true orbital
 * plane/phase differ from this simplified model).
 *
 * Key properties:
 *   parent     — heliocentric body the satellite orbits
 *   radiusAU   — orbit radius in AU
 *   periodDays — sidereal orbital period in days
 *   phase0     — arbitrary phase offset (radians) so bodies start at distinct
 *                positions; chosen to avoid degenerate zero-vector at J2000
 *
 * Why this instead of ALIASES: the old alias approach returned the SAME
 * heliocentric position for satellite and parent, so eclDirection('charon','pluto')
 * normalized a zero vector → NaN.  The satellite table adds a non-zero circular
 * offset so every direction is well-defined.
 *
 * From any OTHER body the offset (≤ 2×10⁻⁶ AU for Charon, ≤ 2×10⁻⁶ AU for
 * Enceladus) is invisible — directions toward the satellite and parent agree to
 * > 0.999 dot product, matching the old alias behavior from Earth.
 *
 * Charon:    19,600 km / 149,597,870.7 km·AU⁻¹ ≈ 1.31×10⁻⁴ AU, P = 6.38723 d
 * Enceladus: 238,000 km / 149,597,870.7 km·AU⁻¹ ≈ 1.59×10⁻³ AU, P = 1.370218 d
 */
const SATELLITES = {
  charon:    { parent: 'pluto',  radiusAU: 19600   / 149597870.7, periodDays: 6.38723,   phase0: 0.0 },
  enceladus: { parent: 'saturn', radiusAU: 238000  / 149597870.7, periodDays: 1.370218,  phase0: 1.0 },
};

/** Heliocentric ecliptic J2000 position of a body (handles 'sun', 'moon', and satellites). */
export function helioPos(id, jd) {
  if (id === 'sun')  return [0, 0, 0];
  if (id === 'moon') return add3(helioEcl('earth', jd), moonGeoEcl(jd));

  const sat = SATELLITES[id];
  if (sat) {
    // Parent heliocentric position + circular offset in the ecliptic plane.
    const parentPos = helioPos(sat.parent, jd);
    const angle = 2 * Math.PI * (jd - J2000) / sat.periodDays + sat.phase0;
    return [
      parentPos[0] + sat.radiusAU * Math.cos(angle),
      parentPos[1] + sat.radiusAU * Math.sin(angle),
      parentPos[2], // orbit in the ecliptic plane (z offset = 0)
    ];
  }

  return helioEcl(id, jd);
}

/**
 * Sidereal orbital period of a body, in days, DERIVED from the same elements the
 * position solver uses (P = 360° / dL × 36525). Deriving rather than tabulating is
 * what guarantees that sampling helioEcl over one period traces a CLOSED ellipse —
 * a hardcoded period that disagrees with dL leaves the path an open arc.
 *
 * @param {string} id — body id
 * @returns {number|null} period in days, or null if the body has no modelled orbit
 */
export function orbitPeriodDays(id) {
  if (id === 'sun') return null;
  if (id === 'moon') return 27.321661;
  const sat = SATELLITES[id];
  if (sat) return sat.periodDays;
  const el = ELEMENTS[id];
  if (!el || !el.dL) return null;
  return Math.abs(360 * 36525 / el.dL);
}

function add3(a, b)  { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function sub3(a, b)  { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/l, v[1]/l, v[2]/l];
}

/**
 * Unit vector from `fromId` toward `toId` in heliocentric ecliptic J2000.
 *
 * Special ids:
 *   'sun'  — the heliocentric origin [0,0,0]
 *   'moon' — Earth's geocentric moon (earth helio + moon geo offset)
 *
 * @param {string} fromId — observer body id
 * @param {string} toId   — target body id
 * @param {number} jd     — Julian date
 * @returns {[number,number,number]} unit vector
 */
export function eclDirection(fromId, toId, jd) {
  const from = helioPos(fromId, jd);
  const to   = helioPos(toId,   jd);
  return norm3(sub3(to, from));
}

// ── Frame rotation ───────────────────────────────────────────────────────────

/**
 * Rotate the ecliptic direction into the observer body's render frame.
 *
 * Ridgeline's render frame has +Y = observer's spin axis. The ecliptic plane
 * uses +Z as the ecliptic north. The two frames are related by a single rotation
 * about the ecliptic +X axis by the body's obliquity ε:
 *
 *   R_x(ε): [x, y, z]_ecl → [x, y·cos(ε)−z·sin(ε), y·sin(ε)+z·cos(ε)]_render
 *
 * Because the ecliptic +X axis points toward the vernal equinox and the ridgeline
 * render frame has no particular longitude alignment (no sidereal-angle rotation),
 * the azimuth of the resulting direction may differ from the true sky azimuth by a
 * constant offset proportional to the observer's current sidereal angle. Altitude
 * (dot product with the equatorial plane) and relative motion between bodies are
 * correct. See module-level documentation for details.
 *
 * @param {string} fromId      — observer body id (for OBLIQUITY lookup if obliquityDeg omitted)
 * @param {string} toId        — target body id
 * @param {number} jd          — Julian date
 * @param {number} obliquityDeg — axial tilt of the observer body (degrees vs ecliptic)
 * @returns {[number,number,number]} unit vector in the observer's render frame
 */
export function bodySkyDirection(fromId, toId, jd, obliquityDeg) {
  const [ex, ey, ez] = eclDirection(fromId, toId, jd);
  const eps = obliquityDeg * D2R;
  const cosE = Math.cos(eps), sinE = Math.sin(eps);
  // R_x(ε) maps ecliptic +Z (ecliptic north) to the observer spin axis (+Y in render frame).
  // Result: render [x, y_render, z_render]
  return [ex, ey * cosE - ez * sinE, ey * sinE + ez * cosE];
}
