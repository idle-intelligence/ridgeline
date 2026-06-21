// Project-wide constants shared between the renderer and the camera/body code.

// Render-space radius of every body's sea-level (reference) sphere, in world units.
// Bodies of different real sizes are all drawn at this radius; their true radius only
// affects the HUD km scale and vertical-exaggeration feel (see Body.mPerWu).
export const WORLD_RADIUS = 6000.0;
