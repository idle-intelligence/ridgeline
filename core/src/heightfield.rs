// Spherical world model — a globe of stacked latitude rings.
//
// Each heightfield cell (row → latitude φ, col → longitude λ, elev_m) maps to a 3D
// point on a sphere centered at the origin:
//
//   R_world = planet radius in world units = 6000.0
//   h_wu    = elev_m * VERT_SCALE      (vertical exaggeration)
//   r       = R_world + h_wu
//   x = r·cosφ·cosλ,  y = r·sinφ,  z = r·cosφ·sinλ   (north pole = +Y)
//
// φ in [-90,90]°, λ in [-180,180]°. row 0 = +90° north, col 0 = -180° west.
//
// VERT_SCALE: max elevation (7712 m) should bulge ~8–12% of R_world (~500–700 wu).
//   VERT_SCALE = 0.08 → Everest-class peak ≈ 617 wu (~10% of R_world).
//
// Each ROW (constant latitude) is a parallel ring around the globe; as λ sweeps it
// traces the ring with elevation bumps. Land bulges out, ocean (h=0) is a smooth
// circle at R_world.

use glam::Vec3;

/// Planet radius in world units.
pub const R_WORLD: f32 = 6000.0;

/// Vertical exaggeration: world units per meter of elevation.
/// 0.11 → Everest-class peak (7712 m) ≈ 848 wu (~14% of R_world) — dramatic relief.
pub const VERT_SCALE: f32 = 0.11;

/// Earth radius in meters — for HUD horizontal scale (meters per world unit).
pub const EARTH_RADIUS_M: f32 = 6_371_000.0;

/// Meters of real surface per world unit (so the globe maps to Earth's true size).
/// m_per_wu = EARTH_RADIUS_M / R_WORLD ≈ 1061.8 m/wu.
pub const M_PER_WU: f32 = EARTH_RADIUS_M / R_WORLD;

pub struct Heightfield {
    pub width: u32,
    pub height: u32,
    // elevation in world units (elev_m * VERT_SCALE), row 0 = north, row-major.
    pub elev: Vec<f32>,
    #[allow(dead_code)]
    pub water: Vec<u8>,
    // world-unit elevation range (max drives elev_norm)
    pub elev_world_max: f32,
    // geographic bbox (degrees)
    pub lat_min: f32,
    pub lat_max: f32,
    pub lon_min: f32,
    pub lon_max: f32,
}

impl Heightfield {
    /// Parse raw int16 LE heightfield + u8 water mask.
    /// elev_min/max in meters; lat/lon in degrees.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        width: u32,
        height: u32,
        hf_bytes: &[u8],
        water_bytes: &[u8],
        elev_min: f32,
        elev_max: f32,
        lat_min: f32,
        lat_max: f32,
        lon_min: f32,
        lon_max: f32,
    ) -> Self {
        let n = (width * height) as usize;

        let _ = elev_min;
        let elev_world_max = elev_max * VERT_SCALE;

        let mut elev = Vec::with_capacity(n);
        for i in 0..n {
            let lo = hf_bytes[i * 2] as i16;
            let hi = hf_bytes[i * 2 + 1] as i16;
            let raw = (lo | (hi << 8)) as f32; // little-endian i16, meters
            elev.push(raw * VERT_SCALE);
        }

        let water = water_bytes[..n].to_vec();

        Self {
            width,
            height,
            elev,
            water,
            elev_world_max,
            lat_min,
            lat_max,
            lon_min,
            lon_max,
        }
    }

    /// Latitude (degrees) for row `row`. row 0 = lat_max (north).
    #[inline]
    pub fn row_lat(&self, row: u32) -> f32 {
        let t = row as f32 / (self.height - 1) as f32;
        self.lat_max - t * (self.lat_max - self.lat_min)
    }

    /// Longitude (degrees) for col `col`. col 0 = lon_min (west).
    #[inline]
    pub fn col_lon(&self, col: u32) -> f32 {
        let t = col as f32 / (self.width - 1) as f32;
        self.lon_min + t * (self.lon_max - self.lon_min)
    }

    /// Elevation sample (world units) at (row, col).
    #[inline]
    pub fn sample(&self, row: u32, col: u32) -> f32 {
        self.elev[(row * self.width + col) as usize]
    }

    /// Normalized elevation in [0,1] for (row, col), clamped. 0 = sea, 1 = highest.
    #[inline]
    pub fn elev_norm(&self, row: u32, col: u32) -> f32 {
        if self.elev_world_max <= 0.0 {
            return 0.0;
        }
        (self.sample(row, col) / self.elev_world_max).clamp(0.0, 1.0)
    }

    /// Map (lat°, lon°, elev_wu) → 3D world point on the sphere.
    #[inline]
    pub fn sphere_point(lat_deg: f32, lon_deg: f32, h_wu: f32) -> Vec3 {
        let phi = lat_deg.to_radians();
        let lam = lon_deg.to_radians();
        let r = R_WORLD + h_wu;
        let (sin_phi, cos_phi) = phi.sin_cos();
        let (sin_lam, cos_lam) = lam.sin_cos();
        Vec3::new(r * cos_phi * cos_lam, r * sin_phi, r * cos_phi * sin_lam)
    }

}
