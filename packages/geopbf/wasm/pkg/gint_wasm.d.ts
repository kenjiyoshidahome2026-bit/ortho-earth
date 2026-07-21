/* tslint:disable */
/* eslint-disable */

/**
 * JS の unPackGint が返す 7 バッファをそのまま保持する。
 * coordinate_stream : L2 アークバッファ（Morton 昇順ソート済み、TERMINAL_BIT なし）
 * arc_meta_stream   : アークメタ [offset, len, _, _, xmin, ymin, xmax, ymax] × arc 数
 * point_buffer      : L1 ポイントバッファ（Morton 昇順ソート済み、TERMINAL_BIT 付き）
 * point_meta_stream : point_meta_stream[i] = point_buffer[i] の feature ID
 * polygon_stream    : [featId, nRings, nArcs, arcIdx, ...] フラット表現
 * polyline_stream   : [featId, nLines, nArcs, arcIdx, ...] フラット表現
 * poly_comp_bbox    : polygon_stream のコンポーネントレコードと 1:1 の bbox（xMin,yMin,xMax,yMax）
 */
export class GintConverter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * ポイント地物の近傍探索（JS: findPoint と等価）
     * mix/miy/error はモートン整数空間（SCALE_E 適用済み）
     */
    identify_point(mix: number, miy: number, error: number): number;
    /**
     * ポリゴン地物の内側判定（JS: findPolygon と等価）
     * レイキャスティング法（偶奇規則）。error パラメータ不要。
     * TODO: JS側(findPolygon)は smallest-wins（全走査で最後のヒット=最小地物）に変更済み。
     * 本コンバータは未配線のまま JS 側の連携コード(buildConverter)も撤去済み(2026-07-17)。
     * 再配線する場合はこの first-wins を JS と同じ後勝ちに揃えること。
     */
    identify_polygon(mix: number, miy: number): number;
    /**
     * ポリライン地物の近傍探索（JS: findMortonNear と等価）
     */
    identify_polyline(mix: number, miy: number, error: number): number;
    /**
     * 6 バッファからコンバーターを構築する。
     * arc_buffer_u32 / point_buffer_u32 は BigUint64Array を Uint32Array として渡す
     * （各 u64 を lo32, hi32 のペアとしてエンコード、リトルエンディアン）。
     */
    constructor(arc_buffer_u32: Uint32Array, arc_meta_stream: Uint32Array, point_buffer_u32: Uint32Array, point_meta_stream: Uint32Array, polygon_stream: Int32Array, polyline_stream: Int32Array, poly_comp_bbox: Uint32Array);
    /**
     * ビューポート bbox を更新する。drawing() のたびに呼ぶ。
     */
    set_view_bbox(x_min: number, y_min: number, x_max: number, y_max: number): void;
}

export function L1toL2_wasm(ptr: number, length: number): void;

export class LineTopology {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    arc_buffer_len(): number;
    arc_buffer_ptr(): number;
    arc_meta_len(): number;
    arc_meta_ptr(): number;
    count(): number;
    line_stream_len(): number;
    line_stream_ptr(): number;
}

export class PolyTopology {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    arc_buffer_len(): number;
    arc_buffer_ptr(): number;
    arc_meta_len(): number;
    arc_meta_ptr(): number;
    count(): number;
    neighbor_stream_len(): number;
    neighbor_stream_ptr(): number;
    poly_stream_len(): number;
    poly_stream_ptr(): number;
}

export function XYtoL1_wasm(ptr: number, vertex_count: number): void;

export function alloc_wasm_memory(size: number): number;

export function build_polygons_wasm(xy: Uint32Array, rings: Uint32Array, comps: Uint32Array): PolyTopology;

export function build_polylines_wasm(coords: BigUint64Array, lines: Uint32Array, fids: Uint32Array, n_poly: number, vertex_offset: number): LineTopology;

export function detect_intersections_wasm(arc_buf_ptr: number, arc_buf_len: number, arc_meta_ptr: number, arc_count: number, snap_dist_sq: number, grid_unit: number, out_ptr: number, out_max: number): number;

export function free_wasm_memory(ptr: number, size: number): void;

export function init_panic_hook(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly L1toL2_wasm: (a: number, b: number) => void;
    readonly XYtoL1_wasm: (a: number, b: number) => void;
    readonly __wbg_gintconverter_free: (a: number, b: number) => void;
    readonly __wbg_linetopology_free: (a: number, b: number) => void;
    readonly __wbg_polytopology_free: (a: number, b: number) => void;
    readonly alloc_wasm_memory: (a: number) => number;
    readonly build_polygons_wasm: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly build_polylines_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly detect_intersections_wasm: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => number;
    readonly free_wasm_memory: (a: number, b: number) => void;
    readonly gintconverter_identify_point: (a: number, b: number, c: number, d: number) => number;
    readonly gintconverter_identify_polygon: (a: number, b: number, c: number) => number;
    readonly gintconverter_identify_polyline: (a: number, b: number, c: number, d: number) => number;
    readonly gintconverter_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => number;
    readonly gintconverter_set_view_bbox: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly init_panic_hook: () => void;
    readonly linetopology_arc_buffer_len: (a: number) => number;
    readonly linetopology_arc_buffer_ptr: (a: number) => number;
    readonly linetopology_arc_meta_len: (a: number) => number;
    readonly linetopology_arc_meta_ptr: (a: number) => number;
    readonly linetopology_count: (a: number) => number;
    readonly linetopology_line_stream_len: (a: number) => number;
    readonly linetopology_line_stream_ptr: (a: number) => number;
    readonly polytopology_count: (a: number) => number;
    readonly polytopology_neighbor_stream_len: (a: number) => number;
    readonly polytopology_neighbor_stream_ptr: (a: number) => number;
    readonly polytopology_arc_buffer_len: (a: number) => number;
    readonly polytopology_arc_meta_len: (a: number) => number;
    readonly polytopology_poly_stream_len: (a: number) => number;
    readonly polytopology_arc_buffer_ptr: (a: number) => number;
    readonly polytopology_arc_meta_ptr: (a: number) => number;
    readonly polytopology_poly_stream_ptr: (a: number) => number;
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
