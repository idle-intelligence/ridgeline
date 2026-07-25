// Project-wide constants shared between the renderer and the camera/body code.

// Render-space radius of every body's sea-level (reference) sphere, in world units.
// Bodies of different real sizes are all drawn at this radius; their true radius only
// affects the HUD km scale and vertical-exaggeration feel (see Body.mPerWu).
export const WORLD_RADIUS = 6000.0;

// Palette — restrained, not neon.
// Sky: very deep blue-black. Fill: slightly lighter, warm-tinted dark grey-blue.
// Ridge line: cool off-white, slightly warm.
export const PALETTE = {
  sky:      [0.04, 0.04, 0.08, 1.0],      // near-black deep blue
  fill:     [0.07, 0.07, 0.12, 1.0],      // dark blue-grey fill body
  line:     [0.88, 0.86, 0.82, 1.0],      // warm off-white ridge line
  aircraft: [0.97, 0.96, 0.93, 1.0],      // near-pure warm white — ship reads distinct
};
