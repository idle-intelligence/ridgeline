// DEV MOCK — delete or toggle USE_MOCK=false in main.js when real wasm is built.
// Matches Engine API exactly per core/API.md so the WebGL2 pipeline can be
// verified visually in headless Chromium without the real wasm present.

export function makeMockEngine(width, height, _hf, _wm, _elevMin, _elevMax, _latMin, _latMax, _lonMin, _lonMax) {
  const worldW = 10.0;
  const worldD = 10.0;

  // camera: start behind terrain (z=+8), elevated, looking toward -z (into the strips).
  // With yaw=0, pitch=0.22: forward in world = (0, sin(pitch), -cos(pitch)) = toward -z, slightly up.
  // Terrain spans world z=-5..+5, x=-5..+5 → all of it at z < +8, in front of camera.
  let camX = 0, camY = 3.5, camZ = 8.0;
  let velX = 0, velY = 0, velZ = 0;
  let yawAngle = 0, pitchAngle = -0.3; // looking toward -z, pitched down into terrain

  let _thrust = 0, _strafe = 0, _lift = 0;
  let _pitchRate = 0, _yawRate = 0;
  let _boost = 0, _ftl = false;

  const NUM_ROWS = Math.min(height, 40);
  const VERTS_PER_ROW = Math.min(width, 64);

  function buildGeometry() {
    const fillVerts = [];
    const fillDraws = [];
    const lineVerts = [];
    const lineDraws = [];

    let fvCount = 0, lvCount = 0;

    for (let row = 0; row < NUM_ROWS; row++) {
      const t = row / (NUM_ROWS - 1);
      const z = -worldD * 0.5 + t * worldD;
      const baseline = -0.5;

      const fStart = fvCount;
      const lStart = lvCount;

      for (let col = 0; col < VERTS_PER_ROW; col++) {
        const u = col / (VERTS_PER_ROW - 1);
        const x = -worldW * 0.5 + u * worldW;
        const profile = 0.3 + 0.6 * Math.sin(u * Math.PI * 3 + row * 0.5)
                            + 0.25 * Math.sin(u * Math.PI * 7 + row * 0.9);
        const y = baseline + profile;

        fillVerts.push(x, baseline, z, x, y, z);
        fvCount += 2;

        lineVerts.push(x, y, z);
        lvCount += 1;
      }

      fillDraws.push(fStart, VERTS_PER_ROW * 2);
      lineDraws.push(lStart, VERTS_PER_ROW);
    }

    // Per-vertex strengths: all 1.0 (mock doesn't fade).
    const fillStr = new Float32Array(fvCount).fill(1.0);
    const lineStr = new Float32Array(lvCount).fill(1.0);

    return {
      fillV: new Float32Array(fillVerts),
      fillD: new Uint32Array(fillDraws),
      fillStr,
      lineV: new Float32Array(lineVerts),
      lineD: new Uint32Array(lineDraws),
      lineStr,
    };
  }

  let geo = buildGeometry();

  // Column-major 4x4 matrix multiply: C = A * B
  function mat4Mul(A, B) {
    const C = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += A[k * 4 + row] * B[col * 4 + k];
        C[col * 4 + row] = s;
      }
    }
    return C;
  }

  // Column-major perspective matrix
  function perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    return new Float32Array([
      f / aspect, 0, 0,  0,
      0,          f, 0,  0,
      0, 0, -(far + near) / (far - near), -1,
      0, 0, -2 * far * near / (far - near), 0,
    ]);
  }

  // Column-major view matrix: Rx(pitch) * Ry(yaw) * T(-pos)
  // In column-major layout, element at column c, row r is index c*4+r.
  function viewMatrix(px, py, pz, yaw, pitch) {
    const sY = Math.sin(yaw),   cY = Math.cos(yaw);
    const sP = Math.sin(pitch), cP = Math.cos(pitch);

    // R = Rx(pitch) * Ry(yaw)
    // Ry: [cY,0,sY,0 / 0,1,0,0 / -sY,0,cY,0 / 0,0,0,1] col-major
    // Rx: [1,0,0,0 / 0,cP,-sP,0 / 0,sP,cP,0 / 0,0,0,1] col-major
    // R = Rx*Ry, col-major:
    //   col0: [cY,  sP*sY, -cP*sY, 0]
    //   col1: [0,   cP,    sP,     0]
    //   col2: [sY, -sP*cY,  cP*cY, 0]
    //   col3: [tx,  ty,    tz,     1]  where [tx,ty,tz] = -R * [px,py,pz]
    // t = -R*p  where R rows are: [cY, sP*sY, -cP*sY], [0, cP, sP], [sY, -sP*cY, cP*cY]
    const tx = -(cY*px + sP*sY*py - cP*sY*pz);
    const ty = -(cP*py + sP*pz);
    const tz = -(sY*px - sP*cY*py + cP*cY*pz);

    return new Float32Array([
      cY,      sP*sY, -cP*sY, 0,   // col 0
      0,       cP,    sP,     0,   // col 1
      sY,     -sP*cY,  cP*cY, 0,  // col 2
      tx,      ty,    tz,     1,   // col 3
    ]);
  }

  return {
    fill_vertices()  { return geo.fillV; },
    fill_draws()     { return geo.fillD; },
    fill_strengths() { return geo.fillStr; },
    line_vertices()  { return geo.lineV; },
    line_draws()     { return geo.lineD; },
    line_strengths() { return geo.lineStr; },
    altitude()      { return camY * 100; },
    speed()         { return Math.sqrt(velX*velX + velZ*velZ) * 100; },
    camera_position() { return new Float32Array([camX, camY, camZ]); },

    view_proj() {
      const proj = perspective(Math.PI / 3, window.innerWidth / window.innerHeight || 16/9, 0.1, 200);
      const view = viewMatrix(camX, camY, camZ, yawAngle, pitchAngle);
      return mat4Mul(proj, view);
    },

    set_input(thrust, strafe, lift, pitch, yaw, _roll, boost, ftl) {
      _thrust = thrust; _strafe = strafe; _lift = lift;
      _pitchRate = pitch; _yawRate = yaw;
      _boost = boost; _ftl = ftl;
    },

    step(dt) {
      const spd = _ftl ? 8 : (1 + _boost * 3);
      yawAngle   += _yawRate   * dt;
      pitchAngle += _pitchRate * dt;
      pitchAngle  = Math.max(-Math.PI / 2.4, Math.min(Math.PI / 2.4, pitchAngle));

      const sY = Math.sin(yawAngle), cY = Math.cos(yawAngle);
      const sP = Math.sin(pitchAngle), cP = Math.cos(pitchAngle);
      // camera forward = negated row2 of R = (-sY, sP*cY, -cP*cY)
      const fwdX = -sY, fwdY = sP * cY, fwdZ = -cP * cY;
      // right = row0 of R = (cY, sP*sY, -cP*sY)
      const rightX = cY, rightY = sP * sY, rightZ = -cP * sY;

      velX = (_thrust * fwdX + _strafe * rightX) * spd;
      velY = (_thrust * fwdY + _lift) * spd;
      velZ = (_thrust * fwdZ + _strafe * rightZ) * spd;

      camX += velX * dt;
      camY += velY * dt;
      camZ += velZ * dt;
    },

    free() {},
  };
}
