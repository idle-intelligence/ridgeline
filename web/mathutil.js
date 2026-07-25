// Pure vector / matrix / sphere math shared by the camera code. No DOM, no WebGPU —
// importable in plain Node for unit testing. All vectors are plain 3-element arrays;
// matrices are column-major Float32Array(16) (WebGPU/WGSL convention).

export const normalize = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
export const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const sub = (a, b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
export const add = (a, b) => [a[0]+b[0], a[1]+b[1], a[2]+b[2]];
export const scale = (a, s) => [a[0]*s, a[1]*s, a[2]*s];

export function mat4LookAt(eye, center, up) {
  const f = normalize(sub(center, eye));
  const r = normalize(cross(f, up));
  const u = cross(r, f);
  return new Float32Array([
    r[0], u[0], -f[0], 0,
    r[1], u[1], -f[1], 0,
    r[2], u[2], -f[2], 0,
    -dot(r, eye), -dot(u, eye), dot(f, eye), 1,
  ]);
}
export function mat4Perspective(fovY, aspect, near, far) {
  const f = 1/Math.tan(fovY/2), nf = 1/(near-far);
  return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
}
export function mat4Mul(a, b) {
  const o = new Float32Array(16);
  for (let i=0;i<4;i++) for (let j=0;j<4;j++) for (let k=0;k<4;k++) o[j*4+i]+=a[k*4+i]*b[j*4+k];
  return o;
}

// Unit (or radius-r) point on the sphere for a lat/lon. +Y = north pole, col 0 = west:
// matches the renderer's sphere mapping (x east, z = -sin(lon)).
export function spherePt(latDeg, lonDeg, r = 1) {
  const phi = latDeg*Math.PI/180, lam = lonDeg*Math.PI/180;
  return [r*Math.cos(phi)*Math.cos(lam), r*Math.sin(phi), -r*Math.cos(phi)*Math.sin(lam)];
}
// Inverse of spherePt (direction → [latDeg, lonDeg]).
export function vec3ToLatLon(v) {
  return [Math.asin(Math.max(-1,Math.min(1,v[1])))*180/Math.PI, Math.atan2(-v[2],v[0])*180/Math.PI];
}

// Rotate v about the +Y (polar) axis by deg, matching the longitude convention
// (spherePt(lat, lon+deg) === rotateY(spherePt(lat, lon), deg)).
export function rotateY(v, deg) {
  const t = deg*Math.PI/180, c = Math.cos(t), s = Math.sin(t);
  return [v[0]*c + v[2]*s, v[1], -v[0]*s + v[2]*c];
}
// Rotate v about an (assumed unit) axis by angle (radians) — Rodrigues' formula.
export function rodrigues(v, axis, angle) {
  const c=Math.cos(angle), s=Math.sin(angle);
  return add(add(scale(v,c), scale(cross(axis,v),s)), scale(axis, dot(axis,v)*(1-c)));
}

// Nearest intersection of ray (origin + t·dir, dir unit) with a sphere of given radius
// centered at the origin, or null if it misses / is behind.
export function raySphere(origin, dir, radius) {
  const b = 2*dot(origin,dir), c = dot(origin,origin)-radius*radius;
  const disc = b*b-4*c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / 2;
  return t > 0.001 ? add(origin, scale(dir, t)) : null;
}

// Clamp an orbit-position unit vector to |lat| ≤ POLE_LIMIT. The camera heading basis is
// geographic-north-relative (singular at the poles), so crossing a pole flips the view.
// Clamping just shy keeps drag motion continuous; longitude is preserved. (gpos.y = sin lat.)
export const POLE_LIMIT_Y = Math.sin(88 * Math.PI / 180);
export function clampPolar(g) {
  if (Math.abs(g[1]) <= POLE_LIMIT_Y) return g;
  const horiz = Math.hypot(g[0], g[2]) || 1e-6;
  const s = Math.sqrt(1 - POLE_LIMIT_Y * POLE_LIMIT_Y) / horiz;
  return [g[0] * s, Math.sign(g[1]) * POLE_LIMIT_Y, g[2] * s];
}
