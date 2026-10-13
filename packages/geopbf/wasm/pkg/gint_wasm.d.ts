/* tslint:disable */
/* eslint-disable */

export class GintBufOut {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    len(): number;
    ptr(): number;
}

export function L1toL2_wasm(ptr: number, length: number): void;

export function alloc_wasm_memory(size: number): number;

export function detect_intersections_wasm(arc_buf_ptr: number, arc_buf_len: number, arc_meta_ptr: number, arc_count: number, snap_dist_sq: number, grid_unit: number, out_ptr: number, out_max: number): number;

export function free_wasm_memory(ptr: number, size: number): void;

export function init_panic_hook(): void;

export function topology_full_wasm(buf: Uint8Array, dir: Uint32Array, e: number, format_version: number): GintBufOut;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly L1toL2_wasm: (a: number, b: number) => void;
    readonly __wbg_gintbufout_free: (a: number, b: number) => void;
    readonly alloc_wasm_memory: (a: number) => number;
    readonly detect_intersections_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly free_wasm_memory: (a: number, b: number) => void;
    readonly gintbufout_len: (a: number) => number;
    readonly gintbufout_ptr: (a: number) => number;
    readonly init_panic_hook: () => void;
    readonly topology_full_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
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
