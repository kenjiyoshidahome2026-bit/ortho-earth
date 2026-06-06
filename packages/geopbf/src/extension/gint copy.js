import initWasm, { 
    bulk_l1_to_l2_wasm, 
    allocate_u64_buffer, 
    allocate_u32_buffer,
    free_u64_buffer,
    free_u32_buffer 
} from "gishub-wasm";

let wasmInstance = null;
const wasmPromise = initWasm().then(instance => {
    wasmInstance = instance;
});

export class gint {

    static TERMINAL_BIT = 1n << 63n;
    static WEIGHT_MASK = 0x3Fn;
    static PRECISION = 7;
    static SCALE_E = Math.pow(10, this.PRECISION);
    static INV_SCALE_E = 1/this.SCALE_E;
    static RAD = Math.PI / 180;

    static pack([lng, lat]) {
        const ix = Math.round((lng + 180) * this.SCALE_E);
        const iy = Math.round((lat + 90) * this.SCALE_E);
        return this._pureMortonFromInt(ix, iy) | this.TERMINAL_BIT;
    }

    static packFromInt(ix, iy) {
        const xl = this._spread16(ix & 0xFFFF), xh = this._spread16((ix >>> 16) & 0xFFFF);
        const yl = this._spread16(iy & 0xFFFF), yh = this._spread16((iy >>> 16) & 0xFFFF);
        return ((BigInt((xh | (yh << 1)) >>> 0) << 32n) | BigInt((xl | (yl << 1)) >>> 0)) | this.TERMINAL_BIT;
    }

    static unpackToInt(m) {
        const isL1 = (m & this.TERMINAL_BIT) !== 0n;
        const morton = isL1 ? (m & ~this.TERMINAL_BIT) : (m & ~this.WEIGHT_MASK);
        const low32 = Number(morton & 0xFFFFFFFFn) >>> 0;
        const high32 = Number((morton >> 32n) & 0x7FFFFFFFn) >>> 0;
        const ix = ((this._compact16(high32) << 16) | this._compact16(low32)) >>> 0;
        const iy = ((this._compact16(high32 >>> 1) << 16) | this._compact16(low32 >>> 1)) >>> 0;
        return [ix, iy];
    }

    static intToVal([ix, iy]) {
        return [(ix * this.INV_SCALE_E) - 180, (iy * this.INV_SCALE_E) - 90].map(t => Number(t.toFixed(this.PRECISION)));
    }

    static unpack(m) {
        return this.intToVal(this.unpackToInt(m));
    }

    static toL2(L1, weight) {
        const [ix, iy] = this.unpackToInt(L1);
        const rx = Math.round(ix / 8) * 8;
        const ry = Math.round(iy / 8) * 8;
        return (this._pureMortonFromInt(rx, ry) & ~this.WEIGHT_MASK) | BigInt(weight & 0x3F);
    }

    static getWeight(m) {
        return (m & this.TERMINAL_BIT) !== 0n ? 63 : Number(m & this.WEIGHT_MASK);
    }

    static _pureMortonFromInt(ix, iy) {
        const xl = this._spread16(ix & 0xFFFF), xh = this._spread16((ix >>> 16) & 0xFFFF);
        const yl = this._spread16(iy & 0xFFFF), yh = this._spread16((iy >>> 16) & 0xFFFF);
        return (BigInt((xh | (yh << 1)) >>> 0) << 32n) | BigInt((xl | (yl << 1)) >>> 0);
    }

    static _spread16(x) {
        x = (x | (x << 8)) & 0x00FF00FF;
        x = (x | (x << 4)) & 0x0F0F0F0F;
        x = (x | (x << 2)) & 0x33333333;
        x = (x | (x << 1)) & 0x55555555;
        return x >>> 0;
    }

    static _compact16(m) {
        m &= 0x55555555;
        m = (m | (m >>> 1)) & 0x33333333;
        m = (m | (m >>> 2)) & 0x0F0F0F0F;
        m = (m | (m >>> 4)) & 0x00FF00FF;
        m = (m | (m >>> 8)) & 0x0000FFFF;
        return m & 0xFFFF;
    }

    static L1toL2(L1arc) { // VisvalingamWhyatt
        const n = L1arc.length; if (n < 3) return;
        const xs = new Float64Array(n), ys = new Float64Array(n), prev = new Int32Array(n), next = new Int32Array(n);
        const areas = new Float64Array(n), heap = new Int32Array(n), pos = new Int32Array(n).fill(-1), eff = new Float64Array(n);
        let minLat = Infinity, maxLat = -Infinity;
        for (let i = 0; i < n; i++) {
            const [lng, lat] = this.unpack(L1arc[i]); xs[i] = lng; ys[i] = lat; prev[i] = i - 1; next[i] = i + 1;
            if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        }
        const cosLat = Math.cos(((minLat + maxLat) / 2) * this.RAD);
        const getArea = (i) => {
            const p = prev[i], nx = next[i]; if (p < 0 || nx >= n) return Infinity;
            return Math.abs((xs[i] - xs[p]) * cosLat * (ys[nx] - ys[p]) - (xs[nx] - xs[p]) * cosLat * (ys[i] - ys[p])) * 0.5;
        };
        const swap = (a, b) => { [heap[a], heap[b]] = [heap[b], heap[a]]; pos[heap[a]] = a; pos[heap[b]] = b; };
        const up = (i) => { for (; i > 0 && areas[heap[i]] < areas[heap[(i - 1) >>> 1]]; i = (i - 1) >>> 1) swap(i, (i - 1) >>> 1); };
        const down = (i) => {
            while (true) {
                let l = (i << 1) + 1, r = l + 1, d = l; if (l >= heapSize) break;
                if (r < heapSize && areas[heap[r]] < areas[heap[l]]) d = r;
                if (areas[heap[d]] >= areas[heap[i]]) break; swap(i, d); i = d;
            }
        };
        let heapSize = 0; for (let i = 1; i < n - 1; i++) { areas[i] = getArea(i); heap[heapSize] = i; pos[i] = heapSize; up(heapSize++); }
        let maxA = 0; while (heapSize > 0) {
            const curr = heap[0]; pos[curr] = -1; if (--heapSize > 0) { heap[0] = heap[heapSize]; pos[heap[0]] = 0; down(0); }
            maxA = Math.max(maxA, areas[curr]); eff[curr] = maxA;
            const p = prev[curr], nx = next[curr]; if (p >= 0) next[p] = nx; if (nx < n) prev[nx] = p;
            [p, nx].forEach(idx => { if (idx > 0 && idx < n - 1 && pos[idx] !== -1) { areas[idx] = Math.max(getArea(idx), maxA); up(pos[idx]); down(pos[idx]); } });
        }
        const getPhysRank = (area) => {
            if (area <= 0) return 0;
            /* ------------------------------------------------
            * 論理式の導出:
            * 1px相当の距離 L = 14,062,500 / 2^z
            * 面積 A = L^2 = (14,062,500^2) / 4^z
            * log2(A) = log2(14,062,500^2) - 2z
            * z = (47.491 - log2(A)) / 2
            * * Rank = (21 - z) * 3  (ズーム21を0、0を63とする)
            * Rank = (21 - (47.491 - log2(A)) / 2) * 3
            * Rank = (21 - 23.745 + 0.5 * log2(A)) * 3
            * Rank = 1.5 * log2(A) - 8.2365
            * ------------------------------------------------ */
            const rank = Math.floor(1.5 * Math.log2(area) - 8.2365);
            return Math.min(63, Math.max(0, rank));// 0-63の範囲にクランプ
        };
        for (let i = 1; i < n - 1; i++) this.toL2(L1arc[i], getPhysRank(eff[i]));
    }
    static L1toL2_js(buffer, meta, count, mlen) {
        for (let i = 0; i < count; i++) {
            const offset = meta[i * mlen];
            const length = meta[i * mlen + 1];

            if (length < 3) continue;

            // 巨大バッファから、このアークに相当する部分配列（ビュー）を切り出し
            // サブアレイはゼロコピーなので軽量です
            const arcSlice = buffer.subarray(offset, offset + length);

            // 既存のVisvalingamWhyattアルゴリズムを呼び出す
            this.L1toL2(arcSlice);
        }
    }
    static async L1toL2_wasm(buffer, meta, count, mlen) {
        await wasmPromise;

        // Rust側のメモリ空間に領域を確保（戻り値はメモリのアドレスを示す「数値」です）
        const bufferPtr = allocate_u64_buffer(buffer.length);
        const metaPtr = allocate_u32_buffer(meta.length);
        
        if (bufferPtr === 0 || metaPtr === 0) {
            throw new Error("WASM Memory Allocation Failed!");
        }

        try {
            // JS側の生データをWASMのメモリバッファへコピー
            new BigUint64Array(wasmInstance.memory.buffer, bufferPtr, buffer.length).set(buffer);
            new Uint32Array(wasmInstance.memory.buffer, metaPtr, meta.length).set(meta);

            // 🌟 Rustの関数を呼び出し。引数の位置（Ptr）を厳密に合わせます
            bulk_l1_to_l2_wasm(bufferPtr, metaPtr, count, mlen);

            // WASM側で直接書き換わった結果を、JS側のbufferに上書き回収
            buffer.set(new BigUint64Array(wasmInstance.memory.buffer, bufferPtr, buffer.length));
        } finally {
            // 確保したアドレスのメモリを安全に解放
            free_u64_buffer(bufferPtr, buffer.length);
            free_u32_buffer(metaPtr, meta.length);
        }
    }
}