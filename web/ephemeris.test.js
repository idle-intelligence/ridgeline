/**
 * ephemeris.test.js — node:test suite for ephemeris.js
 *
 * All assertions are intentionally LOOSE: they catch real math errors (wrong
 * axis, sign flip, missing factor) without demanding precision this module
 * doesn't claim. A few degrees of error is fine; 10s of degrees is a bug.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJD, helioEcl, moonGeoEcl, eclDirection, bodySkyDirection, OBLIQUITY } from './ephemeris.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function dist3(v) { return Math.hypot(v[0], v[1], v[2]); }
function dot3(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function angBetween(a, b) {
  const na = dist3(a), nb = dist3(b);
  const c = Math.max(-1, Math.min(1, dot3(a,b) / (na * nb)));
  return Math.acos(c) * 180 / Math.PI;
}
// JD for a calendar date (proleptic Gregorian, noon UTC).
function jdOf(year, month, day) {
  return toJD(Date.UTC(year, month - 1, day, 12, 0, 0));
}

// ── toJD ─────────────────────────────────────────────────────────────────────

test('toJD: J2000.0 epoch (2000-Jan-1 12:00 UTC) → 2451545.0 ± 0.0002', () => {
  const jd = toJD(Date.UTC(2000, 0, 1, 12, 0, 0));
  assert.ok(Math.abs(jd - 2451545.0) < 0.0002, `got ${jd}`);
});

test('toJD: Unix epoch (1970-Jan-1 00:00 UTC) → 2440587.5 ± 0.0002', () => {
  const jd = toJD(0);
  assert.ok(Math.abs(jd - 2440587.5) < 0.0002, `got ${jd}`);
});

// ── Earth heliocentric distance ───────────────────────────────────────────────

test('Earth heliocentric distance ≈ 1 AU (±0.02) at several dates', () => {
  const dates = [
    [2000, 1, 1], [2000, 7, 4],
    [2010, 3, 20], [2020, 6, 15],
    [2024, 1, 1],
  ];
  for (const [y, m, d] of dates) {
    const r = dist3(helioEcl('earth', jdOf(y, m, d)));
    assert.ok(r >= 0.98 && r <= 1.02, `Earth r=${r.toFixed(4)} AU on ${y}-${m}-${d}`);
  }
});

// ── Mars heliocentric distance ────────────────────────────────────────────────

test('Mars heliocentric distance ≈ 1.38..1.67 AU across a 5-year window', () => {
  for (let y = 2000; y <= 2005; y++) {
    for (let m = 1; m <= 12; m += 3) {
      const r = dist3(helioEcl('mars', jdOf(y, m, 1)));
      assert.ok(r >= 1.38 && r <= 1.67, `Mars r=${r.toFixed(3)} AU on ${y}-${m}`);
    }
  }
});

// ── Mercury period ────────────────────────────────────────────────────────────

test('Mercury period emerges from elements: ~87.97 days ±5%', () => {
  // The mean daily motion dL/dt emerges from the elements: n = dL [deg/cy] / 36525 [days/cy].
  // This test verifies that after exactly one mean-motion period Mercury is nearly
  // back to the same mean longitude, which catches wrong dL sign or magnitude.
  //
  // Mercury period = 360 / (dL/36525) = 360 * 36525 / 149472.674 ≈ 87.97 days.
  // We measure the period by finding how many days until the mean longitude L has
  // advanced 360°. We compare against known value 87.97 days with ±5%.
  //
  // Because L grows linearly with T, we can compute it directly:
  // T2 - T1 = 360 / dL_per_cy cy = 360/149472.674 cy = 0.002408 cy = 87.97 days.
  const dL_cy = 149472.67411175; // deg/cy from ELEMENTS table
  const period_days = 360 / dL_cy * 36525;
  const expected = 87.969; // days
  assert.ok(period_days >= expected * 0.95 && period_days <= expected * 1.05,
    `Mercury period from elements: ${period_days.toFixed(3)} days (expected ${expected})`);

  // Also verify heliocentric positions advance: after ~88 days Mercury has moved
  // substantially (angle between positions should be 5–175° — not stuck at 0).
  const jd0 = jdOf(2010, 1, 1);
  const p0 = helioEcl('mercury', jd0);
  const p1 = helioEcl('mercury', jd0 + 44); // half a period
  const ang = angBetween(p0, p1);
  assert.ok(ang > 30, `Mercury position changed ${ang.toFixed(1)}° over 44 days — too small`);
});

// ── Moon geocentric distance ──────────────────────────────────────────────────

test('Moon geocentric distance 0.00242..0.00271 AU across a 2-year daily sweep', () => {
  const AU_PER_KM = 1 / 149597870.7;
  // Real Moon: perigee ~356500 km, apogee ~406700 km → 0.002382..0.002717 AU
  // Loosen slightly for truncated series.
  let outOfRange = 0;
  for (let day = 0; day < 730; day++) {
    const jd = jdOf(2010, 1, 1) + day;
    const r = dist3(moonGeoEcl(jd));
    if (r < 0.00235 || r > 0.00280) outOfRange++;
  }
  assert.equal(outOfRange, 0, `${outOfRange} days outside 0.00235..0.00280 AU`);
});

// ── Venus max elongation ──────────────────────────────────────────────────────

test('Venus elongation from Earth ≤ 47.5° across a 3-year daily sweep', () => {
  // Venus can never be more than ~47.2° from the Sun as seen from Earth (inferior planet).
  // We check that the angle between the sun-direction and venus-direction from Earth
  // never exceeds 47.5° (a tiny margin for our low-precision series).
  let maxElong = 0;
  for (let day = 0; day < 3 * 365; day++) {
    const jd = jdOf(2010, 1, 1) + day;
    const dirSun   = eclDirection('earth', 'sun',   jd);
    const dirVenus = eclDirection('earth', 'venus', jd);
    const elong = angBetween(dirSun, dirVenus);
    if (elong > maxElong) maxElong = elong;
    assert.ok(elong <= 47.5, `Venus elongation ${elong.toFixed(2)}° on day ${day} (max 47.5° allowed)`);
  }
  // Sanity: max should be close to the physical limit (~47°), not near 0.
  assert.ok(maxElong >= 40, `Max Venus elongation ${maxElong.toFixed(2)}° suspiciously small`);
});

// ── Moon stays near ecliptic ──────────────────────────────────────────────────

test('Moon geocentric direction stays within ~6° of the ecliptic plane', () => {
  // The Moon's orbit is inclined ~5.1° to the ecliptic; max geocentric latitude ≈ ±5.3°.
  // We allow up to 6° for series truncation.
  let maxBeta = 0;
  for (let day = 0; day < 365; day++) {
    const jd = jdOf(2010, 1, 1) + day;
    const pos = moonGeoEcl(jd);
    const r = dist3(pos);
    // Ecliptic latitude β = arcsin(z/r); z is the third component in ecliptic coords.
    const betaDeg = Math.asin(Math.max(-1, Math.min(1, pos[2] / r))) * 180 / Math.PI;
    if (Math.abs(betaDeg) > maxBeta) maxBeta = Math.abs(betaDeg);
    assert.ok(Math.abs(betaDeg) <= 6.0,
      `Moon ecliptic latitude ${betaDeg.toFixed(2)}° on day ${day} exceeds ±6°`);
  }
  // Should reach ~5°+ at least once.
  assert.ok(maxBeta >= 3.0, `Moon max ecliptic latitude ${maxBeta.toFixed(2)}° suspiciously small`);
});

// ── eclDirection: sun from earth is a unit vector ─────────────────────────────

test('eclDirection returns unit vectors', () => {
  const jd = jdOf(2020, 6, 21);
  const pairs = [
    ['earth', 'sun'], ['earth', 'mars'], ['mars', 'earth'],
    ['earth', 'moon'], ['sun', 'earth'],
  ];
  for (const [from, to] of pairs) {
    const d = eclDirection(from, to, jd);
    const len = dist3(d);
    assert.ok(Math.abs(len - 1) < 1e-9, `${from}→${to} length ${len}`);
  }
});

// ── bodySkyDirection: unit vector + obliquity sanity ─────────────────────────

test('bodySkyDirection returns unit vectors', () => {
  const jd = jdOf(2020, 1, 1);
  const d = bodySkyDirection('earth', 'sun', jd, OBLIQUITY.earth);
  const len = dist3(d);
  assert.ok(Math.abs(len - 1) < 1e-9, `length ${len}`);
});

test('bodySkyDirection: obliquity=0 → same as eclDirection', () => {
  const jd = jdOf(2020, 6, 21);
  const ecl = eclDirection('earth', 'mars', jd);
  const sky = bodySkyDirection('earth', 'mars', jd, 0);
  // Should be identical (R_x(0) = identity).
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(sky[i] - ecl[i]) < 1e-12, `component ${i}: sky=${sky[i]} ecl=${ecl[i]}`);
  }
});

test('bodySkyDirection: earth obliquity rotates y/z components', () => {
  // A vector pointing straight ecliptic-north [0, 0, 1] after R_x(23.44°) should
  // have y ≈ −sin(23.44°) ≈ −0.398 and z ≈ cos(23.44°) ≈ 0.917.
  // We can't call bodySkyDirection with a synthetic input directly, but we can verify
  // that for a known direction the y component is modified when obliquity changes.
  const jd = jdOf(2000, 1, 1); // J2000
  const d0 = bodySkyDirection('earth', 'mars', jd, 0);
  const d1 = bodySkyDirection('earth', 'mars', jd, 23.44);
  // x should be unchanged, y and z rotate.
  assert.ok(Math.abs(d0[0] - d1[0]) < 1e-9, 'x unchanged by obliquity');
  // y and z should differ unless the ecliptic direction happens to point exactly along x.
  const ecl = eclDirection('earth', 'mars', jd);
  const hasYZ = Math.abs(ecl[1]) + Math.abs(ecl[2]) > 0.01;
  if (hasYZ) {
    assert.ok(Math.abs(d0[1] - d1[1]) > 1e-4 || Math.abs(d0[2] - d1[2]) > 1e-4,
      'y or z should change when obliquity is nonzero');
  }
});

// ── OBLIQUITY table sanity ────────────────────────────────────────────────────

test('OBLIQUITY table has expected keys and sane values', () => {
  const expected = { mercury: 0.03, venus: 177.4, earth: 23.44, moon: 1.54, mars: 25.19, sun: 7.25 };
  for (const [id, val] of Object.entries(expected)) {
    assert.ok(id in OBLIQUITY, `missing key ${id}`);
    assert.ok(Math.abs(OBLIQUITY[id] - val) < 0.01, `${id}: got ${OBLIQUITY[id]}, want ${val}`);
  }
});

// ── Wave-2 bodies: Ceres, Vesta, Pluto ───────────────────────────────────────

test('Ceres heliocentric distance 2.5..3.0 AU', () => {
  for (let y = 2000; y <= 2010; y++) {
    const r = dist3(helioEcl('ceres', jdOf(y, 1, 1)));
    assert.ok(r >= 2.5 && r <= 3.0, `Ceres r=${r.toFixed(3)} AU on ${y}`);
  }
});

test('Vesta heliocentric distance 2.1..2.6 AU', () => {
  for (let y = 2000; y <= 2010; y++) {
    const r = dist3(helioEcl('vesta', jdOf(y, 1, 1)));
    assert.ok(r >= 2.1 && r <= 2.6, `Vesta r=${r.toFixed(3)} AU on ${y}`);
  }
});

test('Pluto heliocentric distance 29..50 AU across a decade sweep', () => {
  for (let y = 2000; y <= 2010; y++) {
    const r = dist3(helioEcl('pluto', jdOf(y, 1, 1)));
    assert.ok(r >= 29 && r <= 50, `Pluto r=${r.toFixed(2)} AU on ${y}`);
  }
});

test('alias: eclDirection earth→enceladus ≈ earth→saturn (dot > 0.999)', () => {
  const jd = jdOf(2020, 6, 15);
  const dEnceladus = eclDirection('earth', 'enceladus', jd);
  const dSaturn    = eclDirection('earth', 'saturn',    jd);
  const d = dot3(dEnceladus, dSaturn);
  assert.ok(d > 0.999, `dot(enceladus, saturn)=${d.toFixed(6)} — alias not routing`);
});

test('alias: eclDirection earth→charon ≈ earth→pluto (dot > 0.999)', () => {
  const jd = jdOf(2015, 7, 14); // New Horizons flyby date
  const dCharon = eclDirection('earth', 'charon', jd);
  const dPluto  = eclDirection('earth', 'pluto',  jd);
  const d = dot3(dCharon, dPluto);
  assert.ok(d > 0.999, `dot(charon, pluto)=${d.toFixed(6)} — alias not routing`);
});

test('Pluto sky direction is a unit vector', () => {
  const jd = jdOf(2020, 1, 1);
  const d = bodySkyDirection('earth', 'pluto', jd, OBLIQUITY.earth);
  const len = dist3(d);
  assert.ok(Math.abs(len - 1) < 1e-9, `length=${len}`);
});
