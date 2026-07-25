// Spherical world model — a globe of stacked latitude rings.
//
// Each heightfield cell (row → latitude φ, col → longitude λ, elev_m) maps to a 3D
// point on a sphere centered at the origin:
//
//   R_world = planet radius in world units = 6000.0
//   h_wu    = elev_m * VERT_SCALE      (vertical exaggeration)
//   r       = R_world + h_wu
//   x = r·cosφ·cosλ,  y = r·sinφ,  z = -r·cosφ·sinλ   (north pole = +Y)
//
// φ in [-90,90]°, λ in [-180,180]°. row 0 = +90° north, col 0 = -180° west.
//
// VERT_SCALE = (R_world / EARTH_RADIUS_M) * VERT_EXAGGERATION. At VERT_EXAGGERATION = 1.0
//   (realistic) Everest (8849 m) ≈ 8.3 wu — a tiny bump on the 6000-wu globe.
//
// Each ROW (constant latitude) is a parallel ring around the globe; as λ sweeps it
// traces the ring with elevation bumps. Land bulges out, ocean (h=0) is a smooth
// circle at R_world.

/// Planet radius in world units.
pub const R_WORLD: f32 = 6000.0;

/// Earth radius in meters — for HUD horizontal scale (meters per world unit).
pub const EARTH_RADIUS_M: f32 = 6_371_000.0;

/// Vertical exaggeration as a MULTIPLE of true (1:1) scale. THE one knob to tune.
///   1.0  = realistic — relief is to scale with the globe (Everest ≈ 8.3 wu, a tiny bump).
///   ~117 = the old dramatic look (when VERT_SCALE was hardcoded to 0.11).
pub const VERT_EXAGGERATION: f32 = 8.0;

/// World units per meter of elevation.
/// True (1:1) scale is `R_WORLD / EARTH_RADIUS_M ≈ 0.0009418` wu/m; VERT_SCALE is that
/// scaled by VERT_EXAGGERATION. At 1× Everest (8849 m) ≈ 8.3 wu.
pub const VERT_SCALE: f32 = (R_WORLD / EARTH_RADIUS_M) * VERT_EXAGGERATION;

pub struct Heightfield {
    pub width: u32,
    pub height: u32,
    // elevation in RAW METERS (int16), row 0 = north, row-major. Converted to world units on
    // sample via `* VERT_SCALE` — stored as i16 (≈half the memory of an f32 world-unit copy).
    pub elev: Vec<i16>,
    // world-unit elevation range (max drives elev_norm)
    pub elev_world_max: f32,
    // geographic bbox (degrees) — write-only for now (no reader survives in this crate; kept
    // for the data contract / future consumers).
    #[allow(dead_code)]
    pub lat_min: f32,
    #[allow(dead_code)]
    pub lat_max: f32,
    #[allow(dead_code)]
    pub lon_min: f32,
    #[allow(dead_code)]
    pub lon_max: f32,
}

impl Heightfield {
    /// Parse raw int16 LE heightfield (raw meters, kept as i16).
    /// elev_max in meters; lat/lon in degrees.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        width: u32,
        height: u32,
        hf_bytes: &[u8],
        elev_max: f32,
        lat_min: f32,
        lat_max: f32,
        lon_min: f32,
        lon_max: f32,
    ) -> Self {
        let n = (width * height) as usize;

        let elev_world_max = elev_max * VERT_SCALE;

        let mut elev = Vec::with_capacity(n);
        for i in 0..n {
            let lo = hf_bytes[i * 2] as i16;
            let hi = hf_bytes[i * 2 + 1] as i16;
            elev.push(lo | (hi << 8)); // little-endian i16, raw meters
        }

        Self {
            width,
            height,
            elev,
            elev_world_max,
            lat_min,
            lat_max,
            lon_min,
            lon_max,
        }
    }
}
