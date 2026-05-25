// WebGL2 renderer for ridgeline Joy Division strips.
// Receives geometry from the Engine (or mock) and draws fill strips + ridge lines.

const VERT_SRC = `#version 300 es
precision highp float;
uniform mat4 u_mvp;
in vec3 a_pos;
void main() {
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}
`;

// Fill shader: background-tinted color for the triangle-strip bodies.
// A very slight depth offset is baked into the fill vertices by core; JS just draws them.
const FILL_FRAG_SRC = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 out_color;
void main() {
  out_color = u_color;
}
`;

const LINE_FRAG_SRC = `#version 300 es
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

    this.fillProg = linkProgram(gl, VERT_SRC, FILL_FRAG_SRC);
    this.lineProg = linkProgram(gl, VERT_SRC, LINE_FRAG_SRC);

    // cache uniform/attrib locations
    this.fillMvp   = gl.getUniformLocation(this.fillProg, 'u_mvp');
    this.fillColor = gl.getUniformLocation(this.fillProg, 'u_color');
    this.fillPos   = gl.getAttribLocation(this.fillProg,  'a_pos');

    this.lineMvp   = gl.getUniformLocation(this.lineProg, 'u_mvp');
    this.lineColor = gl.getUniformLocation(this.lineProg, 'u_color');
    this.linePos   = gl.getAttribLocation(this.lineProg,  'a_pos');

    // VAOs + VBOs for fill geometry
    this.fillVAO = gl.createVertexArray();
    this.fillVBO = gl.createBuffer();
    gl.bindVertexArray(this.fillVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillVBO);
    gl.enableVertexAttribArray(this.fillPos);
    gl.vertexAttribPointer(this.fillPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // VAOs + VBOs for line geometry
    this.lineVAO = gl.createVertexArray();
    this.lineVBO = gl.createBuffer();
    gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
    gl.enableVertexAttribArray(this.linePos);
    gl.vertexAttribPointer(this.linePos, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // VAO + VBO for aircraft wireframe (static geometry, uploaded once)
    this.aircraftVAO       = gl.createVertexArray();
    this.aircraftVBO       = gl.createBuffer();
    this.aircraftIBO       = gl.createBuffer(); // index buffer for gl.LINES
    this.aircraftLineCount = 0; // number of indices
    gl.bindVertexArray(this.aircraftVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.aircraftVBO);
    gl.enableVertexAttribArray(this.linePos); // reuse same attrib layout
    gl.vertexAttribPointer(this.linePos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.aircraftIBO);
    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
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

    // --- fill pass ---
    const fillVerts = eng.fill_vertices();
    const fillDraws = eng.fill_draws();

    gl.useProgram(this.fillProg);
    gl.uniformMatrix4fv(this.fillMvp, false, mvp);
    gl.uniform4fv(this.fillColor, PALETTE.fill);

    gl.bindVertexArray(this.fillVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fillVBO);
    gl.bufferData(gl.ARRAY_BUFFER, fillVerts, gl.DYNAMIC_DRAW);

    for (let i = 0; i < fillDraws.length; i += 2) {
      gl.drawArrays(gl.TRIANGLE_STRIP, fillDraws[i], fillDraws[i + 1]);
    }

    // --- line pass (LEQUAL so lines win over their own fill at same depth) ---
    const lineVerts = eng.line_vertices();
    const lineDraws = eng.line_draws();

    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(this.lineMvp, false, mvp);
    gl.uniform4fv(this.lineColor, PALETTE.line);

    gl.bindVertexArray(this.lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, lineVerts, gl.DYNAMIC_DRAW);

    for (let i = 0; i < lineDraws.length; i += 2) {
      gl.drawArrays(gl.LINE_STRIP, lineDraws[i], lineDraws[i + 1]);
    }

    // --- aircraft pass ---
    if (this.aircraftLineCount > 0) {
      const modelMat  = eng.model_matrix();          // Float32Array(16), col-major
      const aircraftMvp = mat4Mul(mvp, modelMat);    // view_proj * model_matrix

      gl.useProgram(this.lineProg);
      gl.uniformMatrix4fv(this.lineMvp, false, aircraftMvp);
      gl.uniform4fv(this.lineColor, PALETTE.aircraft);

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
