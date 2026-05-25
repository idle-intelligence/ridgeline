// World-space constants (documented here, referenced by all modules):
//
// Horizontal scale:
//   The heightfield bbox spans ~2 degrees lat × 2 degrees lon for the France Alps smoke-test.
//   We map each degree of longitude to 111_000 m * cos(lat_mid) and each degree of lat to
//   111_000 m. For the smoke-test that is ~156 km EW × 222 km NS, but since the bbox is
//   passed at construction we compute exact scale factors from it dynamically.
//
// Vertical exaggeration: VE = 4.0
//   France full grid spans ~10° lat × ~12° lon (~1100 km × ~925 km). WORLD_HALF=40000.
//   horiz_scale ≈ 0.0726 wu/m → Mont Saint Clair (175 m) renders ~51 wu; Mont Blanc
//   (4672 m) ~1357 wu. VE=4 keeps slopes dramatic without coastal hills becoming walls.
//
// The world box is centered at (0, 0, 0).
//   x: longitude, west = negative, east = positive
//   z: latitude,  south (lat_min, row N-1) = negative, north (lat_max, row 0) = positive
//   y: elevation in world units (meters × VE × horiz_scale). WORLD_HALF=40000 → ±40000
//      box in x/z; craft/camera/cull distances are small vs the 80000 wu world span.

pub const VE: f32 = 6.0;
// Half-width of the world box in world units
pub const WORLD_HALF: f32 = 40_000.0;

pub struct Heightfield {
    pub width: u32,
    pub height: u32,
    // elevation in world-units, row 0 = north (z_max), stored row-major
    pub elev: Vec<f32>,
    // 1 = water
    pub water: Vec<u8>,
    // world-space range of elevation
    pub elev_world_min: f32,
    pub elev_world_max: f32,
    // world-space extents
    pub x_min: f32,  // west
    pub x_max: f32,  // east
    pub z_min: f32,  // south (lat_min)
    pub z_max: f32,  // north (lat_max)
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

        // Horizontal scale: map the bbox to [-WORLD_HALF, +WORLD_HALF] on each axis.
        // We use the larger bbox dimension so the terrain fills the box uniformly.
        let lat_mid_rad = ((lat_min + lat_max) * 0.5).to_radians();
        let meters_per_deg_lat = 111_000.0_f32;
        let meters_per_deg_lon = 111_000.0_f32 * lat_mid_rad.cos();
        let span_ns = (lat_max - lat_min) * meters_per_deg_lat; // meters
        let span_ew = (lon_max - lon_min) * meters_per_deg_lon;
        // scale: world_units per meter
        let horiz_scale = (2.0 * WORLD_HALF) / span_ns.max(span_ew);

        let elev_world_min = elev_min * VE * horiz_scale;
        let elev_world_max = elev_max * VE * horiz_scale;

        // x/z world extents (centered)
        let x_half = span_ew * horiz_scale * 0.5;
        let z_half = span_ns * horiz_scale * 0.5;
        let x_min = -x_half;
        let x_max = x_half;
        let z_min = -z_half; // south
        let z_max = z_half;  // north

        let mut elev = Vec::with_capacity(n);
        for i in 0..n {
            let lo = hf_bytes[i * 2] as i16;
            let hi = hf_bytes[i * 2 + 1] as i16;
            let raw = lo | (hi << 8); // little-endian i16
            let raw = raw as f32;
            // world-space elevation: scale by VE * horiz_scale, baseline at 0
            elev.push(raw * VE * horiz_scale);
        }

        let water = water_bytes[..n].to_vec();

        Self {
            width,
            height,
            elev,
            water,
            elev_world_min,
            elev_world_max,
            x_min,
            x_max,
            z_min,
            z_max,
        }
    }

    /// World-space x for column `col` (0 = west).
    #[inline]
    pub fn col_x(&self, col: u32) -> f32 {
        let t = col as f32 / (self.width - 1) as f32;
        self.x_min + t * (self.x_max - self.x_min)
    }

    /// World-space z for row `row` (0 = north = z_max).
    #[inline]
    pub fn row_z(&self, row: u32) -> f32 {
        let t = row as f32 / (self.height - 1) as f32;
        // row 0 = north (z_max), row H-1 = south (z_min)
        self.z_max - t * (self.z_max - self.z_min)
    }

    /// Elevation sample (world units) at (row, col).
    #[inline]
    pub fn sample(&self, row: u32, col: u32) -> f32 {
        self.elev[(row * self.width + col) as usize]
    }

    /// True if (row, col) is marked as water.
    #[inline]
    pub fn is_water(&self, row: u32, col: u32) -> bool {
        self.water[(row * self.width + col) as usize] != 0
    }

    /// Normalized elevation in [0,1] for (row, col), clamped.
    /// 0 = sea level, 1 = highest peak.
    #[inline]
    pub fn elev_norm(&self, row: u32, col: u32) -> f32 {
        if self.elev_world_max <= 0.0 {
            return 0.0;
        }
        (self.sample(row, col) / self.elev_world_max).clamp(0.0, 1.0)
    }
}
