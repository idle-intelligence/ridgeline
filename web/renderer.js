// WebGL2 renderer for ridgeline Joy Division strips.
// Receives geometry from the Engine (or mock) and draws fill strips + ridge lines.
//
// Per-vertex strength fading:
//   Core emits a parallel Float32Array (fill_strengths / line_strengths) with one f32
//   per vertex in [0..1]. The vertex shader passes it to the fragment shader, which
//   multiplies the color alpha by strength. Alpha blending (SRC_ALPHA, ONE_MINUS_SRC_ALPHA)
//   dissolves far terrain and band-edge seams into the background gracefully.
//   Painter's back-to-front order (guaranteed by core) is required for correct blending.

const VERT_SRC = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
in vec3 a_pos;
in float a_strength;
in float a_elev;
out float v_strength;
out float v_elev;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  v_strength = a_strength;
  v_elev = a_elev;
}
`;

// Elevation → brightness constants.
// Low land is dim (matches dark palette), peaks are bright near-white.
// A whisper of warmth at very high elevations (slight amber tint at elev≈1).
const FILL_FRAG_SRC = `#version 300 es
precision mediump float;
uniform vec4 u_color;
in float v_strength;
in float v_elev;
out vec4 out_color;
void main() {
  // Brightness ramp: low land 1.0x (base fill), peaks up to 1.6x.
  float bright = mix(1.0, 1.6, v_elev);
  // Subtle warmth at high elev: tiny lift to R channel only.
  float warmR = mix(0.0, 0.04, v_elev);
  vec3 col = clamp(u_color.rgb * bright + vec3(warmR, 0.0, 0.0), 0.0, 1.0);
  out_color = vec4(col, u_color.a * v_strength);
}
`;

const LINE_FRAG_SRC = `#version 300 es
precision mediump float;
uniform vec4 u_color;
in float v_strength;
in float v_elev;
out vec4 out_color;
void main() {
  // Ocean (v_elev==0) is VERY faint — just enough to suggest the sphere.
  // Any land jumps to a bright floor, then gamma-lifts so low coastal land still reads,
  // peaks glow near-white. Continent SHAPES emerge as bright landmasses on a dim globe.
  float ev = clamp(v_elev, 0.0, 1.0);
  float isLand = step(0.0008, ev);                 // ocean is exactly 0
  float e = pow(ev, 0.35);                          // gamma-lift low land
  float landBright = mix(0.85, 1.45, e);            // land: bright floor → glowing peaks
  float oceanBright = 0.12;                         // ocean: near-background
  float bright = mix(oceanBright, landBright, isLand);
  // Also fade ocean alpha down so it reads as a dim ghost of the sphere.
  float alphaMul = mix(0.45, 1.0, isLand);
  // Whisper of warmth at peaks: slight amber nudge (land only).
  float warmR = mix(0.0, 0.07, e) * isLand;
  float warmG = mix(0.0, 0.025, e) * isLand;
  vec3 col = clamp(u_color.rgb * bright + vec3(warmR, warmG, 0.0), 0.0, 1.0);
  out_color = vec4(col, u_color.a * v_strength * alphaMul);
}
`;

// Starfield: a full-screen background. A fullscreen triangle is emitted directly in clip
// space at the far plane (z=w → depth 1.0). The fragment shader reconstructs the world-space
// view ray (via the inverse view-projection) so stars are fixed in WORLD space — they parallax
// correctly as the camera orbits, reading as a real sky. A 3D hash over a quantized direction
// grid scatters dim, slightly-varied white/grey points on the near-black background.
// Drawn FIRST with depth-write OFF; the globe/terrain (depth < 1) always draws over it.
const STAR_VERT_SRC = `#version 300 es
precision highp float;
out vec2 v_ndc;
void main() {
  // Oversized triangle covering the screen; positions chosen so the clip-space xy = ndc.
  vec2 p = vec2((gl_VertexID == 2) ? 3.0 : -1.0, (gl_VertexID == 1) ? 3.0 : -1.0);
  v_ndc = p;
  gl_Position = vec4(p, 1.0, 1.0); // z=w=1 → depth 1.0 (far plane)
}
`;

const STAR_FRAG_SRC = `#version 300 es
precision highp float;
uniform mat4 u_invVP;   // inverse(view_proj)
in vec2 v_ndc;
out vec4 out_color;

// cheap 3D hash → [0,1)
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  // Reconstruct a world-space ray direction for this pixel through the inverse VP.
  vec4 nearH = u_invVP * vec4(v_ndc, -1.0, 1.0);
  vec4 farH  = u_invVP * vec4(v_ndc,  1.0, 1.0);
  vec3 dir = normalize(farH.xyz / farH.w - nearH.xyz / nearH.w);

  // Quantize the direction into a grid of cells; one candidate star per cell.
  const float CELLS = 220.0;       // angular density of the star grid
  vec3 cell = floor(dir * CELLS);
  float h = hash13(cell);

  // Only a small fraction of cells contain a star (keeps it restrained / sparse).
  float star = step(0.982, h);

  // Per-star pseudo-random brightness, biased dim. Sub-cell position lets us make a
  // tight point rather than filling the whole cell.
  float hb = hash13(cell + 7.0);
  vec3 sub = vec3(hash13(cell + 1.0), hash13(cell + 2.0), hash13(cell + 3.0)) - 0.5;
  vec3 starDir = normalize((cell + 0.5 + sub) / CELLS);
  float d = distance(dir, starDir) * CELLS;
  float point = smoothstep(0.6, 0.0, d);   // tight round-ish point

  float bright = (0.30 + 0.55 * hb) * point * star;   // dim, varied
  // Very slight cool/warm tint variation, kept near-grey (no color noise).
  float tint = hash13(cell + 5.0);
  vec3 col = mix(vec3(0.78, 0.82, 0.90), vec3(0.92, 0.90, 0.84), tint) * bright;
  out_color = vec4(col, 1.0);
}
`;

// Aircraft uses a fixed-alpha shader (no per-vertex strength needed).
const AIRCRAFT_VERT_SRC = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
in vec3 a_pos;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}
`;

const AIRCRAFT_FRAG_SRC = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 out_color;
void main() {
  out_color = u_color;
}
`;

// Palette — restrained, not neon.
// Sky: very deep blue-black. Fill: slightly lighter, warm-tinted dark grey-blue.
// Ridge line: cool off-white, slightly warm.
export const PALETTE = {
  sky:      [0.04, 0.04, 0.08, 1.0],      // near-black deep blue
  fill:     [0.07, 0.07, 0.12, 1.0],      // dark blue-grey fill body
  line:     [0.88, 0.86, 0.82, 1.0],      // warm off-white ridge line
  aircraft: [0.97, 0.96, 0.93, 1.0],      // near-pure warm white — ship reads distinct
};

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const err = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader compile error: ${err}`);
  }
  return s;
}

function linkProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const err = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error: ${err}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 not available in this browser.');
    this.gl = gl;

    this.starProg     = linkProgram(gl, STAR_VERT_SRC, STAR_FRAG_SRC);
    this.starInvVP    = gl.getUniformLocation(this.starProg, 'u_invVP');
    this.starVAO      = gl.createVertexArray(); // attribute-less (gl_VertexID)

    this.fillProg     = linkProgram(gl, VERT_SRC, FILL_FRAG_SRC);
    this.lineProg     = linkProgram(gl, VERT_SRC, LINE_FRAG_SRC);
    this.aircraftProg = linkProgram(gl, AIRCRAFT_VERT_SRC, AIRCRAFT_FRAG_SRC);

    // cache uniform/attrib locations — terrain programs
    this.fillMvp      = gl.getUniformLocation(this.fillProg, 'u_mvp');
    this.fillColor    = gl.getUniformLocation(this.fillProg, 'u_color');
    this.fillPos      = gl.getAttribLocation(this.fillProg,  'a_pos');
    this.fillStrength = gl.getAttribLocation(this.fillProg,  'a_strength');
    this.fillElev     = gl.getAttribLocation(this.fillProg,  'a_elev');

    this.lineMvp      = gl.getUniformLocation(this.lineProg, 'u_mvp');
    this.lineColor    = gl.getUniformLocation(this.lineProg, 'u_color');
    this.linePos      = gl.getAttribLocation(this.lineProg,  'a_pos');
    this.lineStrength = gl.getAttribLocation(this.lineProg,  'a_strength');
    this.lineElev     = gl.getAttribLocation(this.lineProg,  'a_elev');

    // aircraft program
    this.aircraftMvp   = gl.getUniformLocation(this.aircraftProg, 'u_mvp');
    this.aircraftColor = gl.getUniformLocation(this.aircraftProg, 'u_color');
    this.aircraftPos   = gl.getAttribLocation(this.aircraftProg,  'a_pos');

    // VAOs + VBOs for fill geometry: pos VBO + strength VBO + elev VBO (all separate)
    this.fillVAO      = gl.createVertexArray();
    this.fillVBO      = gl.createBuffer();
    this.fillStrVBO   = gl.createBuffer();
    this.fillElevVBO  = gl.createBuffer();
    gl.bindVertexArray(this.fillVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillVBO);
    gl.enableVertexAttribArray(this.fillPos);
    gl.vertexAttribPointer(this.fillPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillStrVBO);
    gl.enableVertexAttribArray(this.fillStrength);
    gl.vertexAttribPointer(this.fillStrength, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillElevVBO);
    gl.enableVertexAttribArray(this.fillElev);
    gl.vertexAttribPointer(this.fillElev, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // VAOs + VBOs for line geometry
    this.lineVAO      = gl.createVertexArray();
    this.lineVBO      = gl.createBuffer();
    this.lineStrVBO   = gl.createBuffer();
    this.lineElevVBO  = gl.createBuffer();
    gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
    gl.enableVertexAttribArray(this.linePos);
    gl.vertexAttribPointer(this.linePos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineStrVBO);
    gl.enableVertexAttribArray(this.lineStrength);
    gl.vertexAttribPointer(this.lineStrength, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineElevVBO);
    gl.enableVertexAttribArray(this.lineElev);
    gl.vertexAttribPointer(this.lineElev, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // VAO + VBO for aircraft wireframe (static geometry, uploaded once)
    this.aircraftVAO       = gl.createVertexArray();
    this.aircraftVBO       = gl.createBuffer();
    this.aircraftIBO       = gl.createBuffer();
    this.aircraftLineCount = 0;
    gl.bindVertexArray(this.aircraftVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aircraftVBO);
    gl.enableVertexAttribArray(this.aircraftPos);
    gl.vertexAttribPointer(this.aircraftPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.aircraftIBO);
    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // Alpha blending for per-vertex strength fade.
    // Painter's back-to-front order (guaranteed by core) ensures correct compositing.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(w, h) {
    this.gl.viewport(0, 0, w, h);
  }

  // Upload the aircraft wireframe once. aircraftJson: {positions, lines}, scale: world units.
  uploadAircraft(aircraftJson, scale) {
    const gl = this.gl;
    const pos = aircraftJson.positions;
    const segs = aircraftJson.lines;

    // Flatten positions, applying scale
    const verts = new Float32Array(pos.length * 3);
    for (let i = 0; i < pos.length; i++) {
      verts[i * 3]     = pos[i][0] * scale;
      verts[i * 3 + 1] = pos[i][1] * scale;
      verts[i * 3 + 2] = pos[i][2] * scale;
    }

    // Flatten line segments into index pairs
    const indices = new Uint32Array(segs.length * 2);
    for (let i = 0; i < segs.length; i++) {
      indices[i * 2]     = segs[i][0];
      indices[i * 2 + 1] = segs[i][1];
    }
    this.aircraftLineCount = indices.length;

    gl.bindVertexArray(this.aircraftVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aircraftVBO);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.aircraftIBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  draw(eng) {
    const gl = this.gl;
    const [sr, sg, sb, sa] = PALETTE.sky;
    gl.clearColor(sr, sg, sb, sa);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const mvp = eng.view_proj();

    // --- starfield pass (drawn first, depth-write OFF; globe draws over it) ---
    const invVP = mat4Invert(mvp);
    if (invVP) {
      gl.useProgram(this.starProg);
      gl.uniformMatrix4fv(this.starInvVP, false, invVP);
      gl.depthMask(false);
      gl.bindVertexArray(this.starVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthMask(true);
    }

    // --- fill pass ---
    const fillVerts      = eng.fill_vertices();
    const fillDraws      = eng.fill_draws();
    const fillStrengths  = eng.fill_strengths();
    const fillElevations = eng.fill_elevations();

    gl.useProgram(this.fillProg);
    gl.uniformMatrix4fv(this.fillMvp, false, mvp);
    gl.uniform4fv(this.fillColor, PALETTE.fill);

    gl.bindVertexArray(this.fillVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillVBO);
    gl.bufferData(gl.ARRAY_BUFFER, fillVerts, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillStrVBO);
    gl.bufferData(gl.ARRAY_BUFFER, fillStrengths, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillElevVBO);
    gl.bufferData(gl.ARRAY_BUFFER, fillElevations, gl.DYNAMIC_DRAW);

    for (let i = 0; i < fillDraws.length; i += 2) {
      gl.drawArrays(gl.TRIANGLE_STRIP, fillDraws[i], fillDraws[i + 1]);
    }

    // --- line pass (LEQUAL so lines win over their own fill at same depth) ---
    const lineVerts      = eng.line_vertices();
    const lineDraws      = eng.line_draws();
    const lineStrengths  = eng.line_strengths();
    const lineElevations = eng.line_elevations();

    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.lineMvp, false, mvp);
    gl.uniform4fv(this.lineColor, PALETTE.line);

    gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, lineVerts, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineStrVBO);
    gl.bufferData(gl.ARRAY_BUFFER, lineStrengths, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineElevVBO);
    gl.bufferData(gl.ARRAY_BUFFER, lineElevations, gl.DYNAMIC_DRAW);

    for (let i = 0; i < lineDraws.length; i += 2) {
      gl.drawArrays(gl.LINE_STRIP, lineDraws[i], lineDraws[i + 1]);
    }

    // --- aircraft pass ---
    if (this.aircraftLineCount > 0) {
      const modelMat    = eng.model_matrix();
      const aircraftMvp = mat4Mul(mvp, modelMat);

      gl.useProgram(this.aircraftProg);
      gl.uniformMatrix4fv(this.aircraftMvp, false, aircraftMvp);
      gl.uniform4fv(this.aircraftColor, PALETTE.aircraft);

      gl.bindVertexArray(this.aircraftVAO);
      gl.drawElements(gl.LINES, this.aircraftLineCount, gl.UNSIGNED_INT, 0);
    }

    gl.bindVertexArray(null);
  }
}

// Multiply two column-major 4x4 matrices (Float32Array(16) each). Returns new Float32Array(16).
function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let v = 0;
      for (let k = 0; k < 4; k++) {
        v += a[k * 4 + row] * b[col * 4 + k];
      }
      out[col * 4 + row] = v;
    }
  }
  return out;
}

// Invert a column-major 4x4 matrix. Returns Float32Array(16) or null if singular.
function mat4Invert(m) {
  const inv = new Float32Array(16);
  const a00 = m[0],  a01 = m[1],  a02 = m[2],  a03 = m[3];
  const a10 = m[4],  a11 = m[5],  a12 = m[6],  a13 = m[7];
  const a20 = m[8],  a21 = m[9],  a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1.0 / det;

  inv[0]  = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  inv[1]  = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  inv[2]  = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  inv[3]  = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  inv[4]  = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  inv[5]  = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  inv[6]  = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  inv[7]  = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  inv[8]  = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  inv[9]  = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return inv;
}
