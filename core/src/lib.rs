mod heightfield;

use wasm_bindgen::prelude::*;

use heightfield::Heightfield;

#[wasm_bindgen]
pub struct Engine {
    hf: Heightfield,
}

#[wasm_bindgen]
impl Engine {
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(constructor)]
    pub fn new(
        width: u32,
        height: u32,
        hf_bytes: &[u8],
        elev_max: f32,
        lat_min: f32,
        lat_max: f32,
        lon_min: f32,
        lon_max: f32,
    ) -> Engine {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        let hf = Heightfield::new(
            width, height, hf_bytes, elev_max, lat_min, lat_max,
            lon_min, lon_max,
        );

        Engine { hf }
    }

    /// Pointer/len of the RAW int16 elevation grid (meters, row-major, row 0 = north) directly
    /// in WASM memory. `_len` is the ELEMENT count (i16 count = width*height); the byte length
    /// is `2 * len`. ptr is a byte offset into `wasm.memory.buffer`.
    pub fn heightfield_i16_ptr(&self) -> u32 {
        self.hf.elev.as_ptr() as u32
    }
    pub fn heightfield_i16_len(&self) -> u32 {
        self.hf.elev.len() as u32
    }
    /// VERT_SCALE (world units per meter of elevation) so callers can convert the raw int16
    /// meters to world units exactly as the heightfield does internally (`m * VERT_SCALE`).
    pub fn vert_scale(&self) -> f32 {
        heightfield::VERT_SCALE
    }
    pub fn grid_width(&self) -> u32 {
        self.hf.width
    }
    pub fn grid_height(&self) -> u32 {
        self.hf.height
    }
    /// Max terrain elevation (world units).
    pub fn elev_world_max(&self) -> f32 {
        self.hf.elev_world_max
    }
}
