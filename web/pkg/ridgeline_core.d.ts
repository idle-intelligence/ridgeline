/* tslint:disable */
/* eslint-disable */

export class Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Max terrain elevation (world units).
     */
    elev_world_max(): number;
    grid_height(): number;
    grid_width(): number;
    heightfield_i16_len(): number;
    /**
     * Pointer/len of the RAW int16 elevation grid (meters, row-major, row 0 = north) directly
     * in WASM memory. `_len` is the ELEMENT count (i16 count = width*height); the byte length
     * is `2 * len`. ptr is a byte offset into `wasm.memory.buffer`.
     */
    heightfield_i16_ptr(): number;
    constructor(width: number, height: number, hf_bytes: Uint8Array, elev_max: number, lat_min: number, lat_max: number, lon_min: number, lon_max: number);
    /**
     * VERT_SCALE (world units per meter of elevation) so callers can convert the raw int16
     * meters to world units exactly as the heightfield does internally (`m * VERT_SCALE`).
     */
    vert_scale(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly engine_elev_world_max: (a: number) => number;
    readonly engine_grid_height: (a: number) => number;
    readonly engine_grid_width: (a: number) => number;
    readonly engine_heightfield_i16_len: (a: number) => number;
    readonly engine_heightfield_i16_ptr: (a: number) => number;
    readonly engine_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly engine_vert_scale: (a: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
