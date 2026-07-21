/* @ts-self-types="./gint_wasm.d.ts" */

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
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GintConverterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gintconverter_free(ptr, 0);
    }
    /**
     * ポイント地物の近傍探索（JS: findPoint と等価）
     * mix/miy/error はモートン整数空間（SCALE_E 適用済み）
     * @param {number} mix
     * @param {number} miy
     * @param {number} error
     * @returns {number}
     */
    identify_point(mix, miy, error) {
        const ret = wasm.gintconverter_identify_point(this.__wbg_ptr, mix, miy, error);
        return ret;
    }
    /**
     * ポリゴン地物の内側判定（JS: findPolygon と等価）
     * レイキャスティング法（偶奇規則）。error パラメータ不要。
     * TODO: JS側(findPolygon)は smallest-wins（全走査で最後のヒット=最小地物）に変更済み。
     * 本コンバータは未配線のまま JS 側の連携コード(buildConverter)も撤去済み(2026-07-17)。
     * 再配線する場合はこの first-wins を JS と同じ後勝ちに揃えること。
     * @param {number} mix
     * @param {number} miy
     * @returns {number}
     */
    identify_polygon(mix, miy) {
        const ret = wasm.gintconverter_identify_polygon(this.__wbg_ptr, mix, miy);
        return ret;
    }
    /**
     * ポリライン地物の近傍探索（JS: findMortonNear と等価）
     * @param {number} mix
     * @param {number} miy
     * @param {number} error
     * @returns {number}
     */
    identify_polyline(mix, miy, error) {
        const ret = wasm.gintconverter_identify_polyline(this.__wbg_ptr, mix, miy, error);
        return ret;
    }
    /**
     * 6 バッファからコンバーターを構築する。
     * arc_buffer_u32 / point_buffer_u32 は BigUint64Array を Uint32Array として渡す
     * （各 u64 を lo32, hi32 のペアとしてエンコード、リトルエンディアン）。
     * @param {Uint32Array} arc_buffer_u32
     * @param {Uint32Array} arc_meta_stream
     * @param {Uint32Array} point_buffer_u32
     * @param {Uint32Array} point_meta_stream
     * @param {Int32Array} polygon_stream
     * @param {Int32Array} polyline_stream
     * @param {Uint32Array} poly_comp_bbox
     */
    constructor(arc_buffer_u32, arc_meta_stream, point_buffer_u32, point_meta_stream, polygon_stream, polyline_stream, poly_comp_bbox) {
        const ptr0 = passArray32ToWasm0(arc_buffer_u32, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(arc_meta_stream, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(point_buffer_u32, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(point_meta_stream, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(polygon_stream, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray32ToWasm0(polyline_stream, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray32ToWasm0(poly_comp_bbox, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.gintconverter_new(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6);
        this.__wbg_ptr = ret;
        GintConverterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * ビューポート bbox を更新する。drawing() のたびに呼ぶ。
     * @param {number} x_min
     * @param {number} y_min
     * @param {number} x_max
     * @param {number} y_max
     */
    set_view_bbox(x_min, y_min, x_max, y_max) {
        wasm.gintconverter_set_view_bbox(this.__wbg_ptr, x_min, y_min, x_max, y_max);
    }
}
if (Symbol.dispose) GintConverter.prototype[Symbol.dispose] = GintConverter.prototype.free;

/**
 * @param {number} ptr
 * @param {number} length
 */
export function L1toL2_wasm(ptr, length) {
    wasm.L1toL2_wasm(ptr, length);
}

export class LineTopology {
    static __wrap(ptr) {
        const obj = Object.create(LineTopology.prototype);
        obj.__wbg_ptr = ptr;
        LineTopologyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LineTopologyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_linetopology_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    arc_buffer_len() {
        const ret = wasm.linetopology_arc_buffer_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    arc_buffer_ptr() {
        const ret = wasm.linetopology_arc_buffer_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    arc_meta_len() {
        const ret = wasm.linetopology_arc_meta_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    arc_meta_ptr() {
        const ret = wasm.linetopology_arc_meta_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    count() {
        const ret = wasm.linetopology_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    line_stream_len() {
        const ret = wasm.linetopology_line_stream_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    line_stream_ptr() {
        const ret = wasm.linetopology_line_stream_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) LineTopology.prototype[Symbol.dispose] = LineTopology.prototype.free;

export class PolyTopology {
    static __wrap(ptr) {
        const obj = Object.create(PolyTopology.prototype);
        obj.__wbg_ptr = ptr;
        PolyTopologyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PolyTopologyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_polytopology_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    arc_buffer_len() {
        const ret = wasm.polytopology_arc_buffer_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    arc_buffer_ptr() {
        const ret = wasm.polytopology_arc_buffer_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    arc_meta_len() {
        const ret = wasm.polytopology_arc_meta_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    arc_meta_ptr() {
        const ret = wasm.polytopology_arc_meta_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    count() {
        const ret = wasm.polytopology_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    neighbor_stream_len() {
        const ret = wasm.polytopology_neighbor_stream_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    neighbor_stream_ptr() {
        const ret = wasm.polytopology_neighbor_stream_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    poly_stream_len() {
        const ret = wasm.polytopology_poly_stream_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    poly_stream_ptr() {
        const ret = wasm.polytopology_poly_stream_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) PolyTopology.prototype[Symbol.dispose] = PolyTopology.prototype.free;

/**
 * @param {number} ptr
 * @param {number} vertex_count
 */
export function XYtoL1_wasm(ptr, vertex_count) {
    wasm.XYtoL1_wasm(ptr, vertex_count);
}

/**
 * @param {number} size
 * @returns {number}
 */
export function alloc_wasm_memory(size) {
    const ret = wasm.alloc_wasm_memory(size);
    return ret >>> 0;
}

/**
 * @param {Uint32Array} xy
 * @param {Uint32Array} rings
 * @param {Uint32Array} comps
 * @returns {PolyTopology}
 */
export function build_polygons_wasm(xy, rings, comps) {
    const ptr0 = passArray32ToWasm0(xy, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(rings, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(comps, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.build_polygons_wasm(ptr0, len0, ptr1, len1, ptr2, len2);
    return PolyTopology.__wrap(ret);
}

/**
 * @param {BigUint64Array} coords
 * @param {Uint32Array} lines
 * @param {Uint32Array} fids
 * @param {number} n_poly
 * @param {number} vertex_offset
 * @returns {LineTopology}
 */
export function build_polylines_wasm(coords, lines, fids, n_poly, vertex_offset) {
    const ptr0 = passArray64ToWasm0(coords, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(lines, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(fids, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.build_polylines_wasm(ptr0, len0, ptr1, len1, ptr2, len2, n_poly, vertex_offset);
    return LineTopology.__wrap(ret);
}

/**
 * @param {number} arc_buf_ptr
 * @param {number} arc_buf_len
 * @param {number} arc_meta_ptr
 * @param {number} arc_count
 * @param {number} snap_dist_sq
 * @param {number} grid_unit
 * @param {number} out_ptr
 * @param {number} out_max
 * @returns {number}
 */
export function detect_intersections_wasm(arc_buf_ptr, arc_buf_len, arc_meta_ptr, arc_count, snap_dist_sq, grid_unit, out_ptr, out_max) {
    const ret = wasm.detect_intersections_wasm(arc_buf_ptr, arc_buf_len, arc_meta_ptr, arc_count, snap_dist_sq, grid_unit, out_ptr, out_max);
    return ret >>> 0;
}

/**
 * @param {number} ptr
 * @param {number} size
 */
export function free_wasm_memory(ptr, size) {
    wasm.free_wasm_memory(ptr, size);
}

export function init_panic_hook() {
    wasm.init_panic_hook();
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_1506f2235d1bdba0: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./gint_wasm_bg.js": import0,
    };
}

const GintConverterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gintconverter_free(ptr, 1));
const LineTopologyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_linetopology_free(ptr, 1));
const PolyTopologyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_polytopology_free(ptr, 1));

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getBigUint64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedBigUint64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('gint_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
