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

use glam::Vec3;

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

/// Meters of real surface per world unit (so the globe maps to Earth's true size).
/// m_per_wu = EARTH_RADIUS_M / R_WORLD ≈ 1061.8 m/wu.
pub const M_PER_WU: f32 = EARTH_RADIUS_M / R_WORLD;

// ── Altitude-coupled vertical exaggeration ───────────────────────────────────
// The RENDERED relief scales with camera altitude so the planet is dramatic from
// space (draws you in) and relaxes toward realistic as you descend. The aim is
// apparent-size constancy: apparent height ∝ rendered_height/distance ∝ VE/altitude,
// so a linear-in-altitude VE keeps the on-screen relief roughly constant through the
// transition band, then clamps at both ends.
//
//   VE(alt) = clamp(VE_K * altitude_wu, VE_NEAR, VE_FAR)
//
// Only the terrain ring radii use VE; the occluder sphere, camera, physics, floor,
// and all HUD/brightness math stay on the real (fixed) scale.

/// Vertical exaggeration near the surface — realistic, gentle relief.
pub const VE_NEAR: f32 = 1.0;

/// Vertical exaggeration far out in space — dramatic relief that draws the eye in.
pub const VE_FAR: f32 = 8.0;

/// Slope of the VE ramp (exaggeration per world unit of altitude). With VE_NEAR=1
/// the ramp leaves the near clamp at altitude = VE_NEAR/VE_K ≈ 1429 wu and reaches the
/// VE_FAR=8 cap at altitude = VE_FAR/VE_K ≈ 11429 wu. So low cruise (alt ~500 wu) sits
/// at the realistic floor, mid altitudes (a few thousand wu) ramp through ~2–6×, and
/// from space (>~11k wu) it saturates at the dramatic 8× cap.
pub const VE_K: f32 = 0.0007;

/// Vertical exaggeration for a given camera altitude (world units above the sea-level
/// sphere). Linear ramp clamped to [VE_NEAR, VE_FAR].
#[inline]
pub fn ve_for_altitude(altitude_wu: f32) -> f32 {
    let alt = altitude_wu.max(0.0);
    (VE_K * alt).clamp(VE_NEAR, VE_FAR)
}


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
        // Longitude handedness flipped (z = −r·cosφ·sinλ) so that with north up, EAST
        // renders to the RIGHT — matching how a map/globe reads. lat_lon() inverts this
        // with lon = atan2(−z, x) to keep the HUD reporting true longitude.
        Vec3::new(r * cos_phi * cos_lam, r * sin_phi, -r * cos_phi * sin_lam)
    }

    /// Like `sphere_point`, but the elevation `h_wu` (stored at the fixed `VERT_SCALE` /
    /// `VERT_EXAGGERATION`) is RESCALED by `ve` so terrain relief follows the altitude-coupled
    /// vertical exaggeration. `ve_ratio = ve / VERT_EXAGGERATION` converts the stored height to
    /// the dynamic one: `h_dyn = h_wu * ve_ratio`. The base radius R_WORLD is unchanged.
    #[inline]
    pub fn sphere_point_scaled(lat_deg: f32, lon_deg: f32, h_wu: f32, ve: f32) -> Vec3 {
        let ve_ratio = ve / VERT_EXAGGERATION;
        Self::sphere_point(lat_deg, lon_deg, h_wu * ve_ratio)
    }
}
