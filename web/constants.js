// Project-wide constants shared between the renderer and the camera/body code.

// Render-space radius of every body's sea-level (reference) sphere, in world units.
// Bodies of different real sizes are all drawn at this radius; their true radius only
// affects the HUD km scale and vertical-exaggeration feel (see Body.mPerWu).
export const WORLD_RADIUS = 6000.0;

// Real Earth radius, meters — used to derive VERT_SCALE from R_WORLD.
export const EARTH_RADIUS_M = 6_371_000.0;

// Vertical exaggeration applied to elevation when mapping to world units.
export const VERT_EXAGGERATION = 8.0;

// LOD/cull constants — consumed by the WebGPU geometry compute pass in renderer-webgpu.js.
export const HORIZON_MARGIN = 0.04;
export const FADE_BAND = 0.12;
export const SIGHT_HALF_ANGLE = 1.483;
export const POLE_GUARD_LAT = 88.0;     // polar-cap convergence guard
export const OCCLUDER_FOV_GATE = 0.55; // dome gate (disc regime)

// Palette — restrained, not neon.
// Sky: very deep blue-black. Fill: slightly lighter, warm-tinted dark grey-blue.
// Ridge line: cool off-white, slightly warm.
export const PALETTE = {
  sky:      [0.04, 0.04, 0.08, 1.0],      // near-black deep blue
  fill:     [0.07, 0.07, 0.12, 1.0],      // dark blue-grey fill body
  line:     [0.88, 0.86, 0.82, 1.0],      // warm off-white ridge line
};
