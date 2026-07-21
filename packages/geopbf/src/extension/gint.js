import init, { L1toL2_wasm, XYtoL1_wasm, alloc_wasm_memory, free_wasm_memory, init_panic_hook, detect_intersections_wasm, build_polygons_wasm, build_polylines_wasm, topology_full_wasm } from "../../wasm/pkg/gint_wasm.js";
let wasmReady = false;
let wasmMemoryBuffer = null;
let sharedWasmPtr = 0;
let sharedWasmSize = 0;
export class gint {
	static TERMINAL_BIT = 1n << 63n;
	static WEIGHT_MASK = 0x3Fn;
	static PRECISION = 7;
	static SCALE_E = Math.pow(10, this.PRECISION);
	static INV_SCALE_E = 1/this.SCALE_E;
	static RAD = Math.PI / 180;

	static async initialize() { if (wasmReady) return;
		const exports = await init();
		if (typeof init_panic_hook === 'function') {
			init_panic_hook();
			wasmReady = true;
			wasmMemoryBuffer = exports.memory;
			sharedWasmSize = 32 * 1024 * 1024;
			if (typeof alloc_wasm_memory === 'function') sharedWasmPtr = alloc_wasm_memory(sharedWasmSize);
		}
	}

	static _ensureBufferSize(requiredBytes) { if (requiredBytes <= sharedWasmSize) return sharedWasmPtr;
		if (typeof free_wasm_memory === 'function' && sharedWasmPtr !== 0) {
			free_wasm_memory(sharedWasmPtr, sharedWasmSize);
		}
		sharedWasmSize = Math.pow(2, Math.ceil(Math.log2(requiredBytes)));
		sharedWasmPtr = alloc_wasm_memory(sharedWasmSize);
		return sharedWasmPtr;
	}
	
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
		if (wasmReady && typeof L1toL2_wasm === 'function' && typeof alloc_wasm_memory === 'function' && sharedWasmPtr !== 0) {
			const byteLength = n * 8;
			const ptr = this._ensureBufferSize(byteLength);
			let wasmU8Memory = new Uint8Array(wasmMemoryBuffer.buffer);
			const inputU8 = new Uint8Array(L1arc.buffer, L1arc.byteOffset, byteLength);
			wasmU8Memory.set(inputU8, ptr);
			L1toL2_wasm(ptr, n);
			wasmU8Memory = new Uint8Array(wasmMemoryBuffer.buffer);
			const resultU8 = wasmU8Memory.subarray(ptr, ptr + byteLength);
			inputU8.set(resultU8);
			return;
		}
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
			* Derivation (area in square-degree units):
			* 1-pixel distance L = 1.40625 / 2^z  [degrees]
			* area A_1e7 = (L * 1e7)^2  [(1e-7 deg)^2 units]
			* Rank = 1.5 * log2(A_1e7) - 8.2365
			*       = 1.5 * log2(area * 1e14) - 8.2365
			*       = 1.5 * log2(area) + 61.51
			* ------------------------------------------------ */
			const rank = Math.floor(1.5 * Math.log2(area) + 61.51);
			return Math.min(63, Math.max(0, rank));
		};
		for (let i = 1; i < n - 1; i++) L1arc[i] = this.toL2(L1arc[i], getPhysRank(eff[i]));
	}
	// XY(Int32ペア)連結バッファ → L1 Morton化＋VW簡略化 を wasm 1往復2パスで一括実行。
	// int32ペアとu64は同サイズ＝XYtoL1はin-place変換なので、アップロード1回→XYtoL1一括→
	// arcごとL1toL2（wasmメモリ内・memcpyなし）→ダウンロード1回で完結する。
	// xy: Uint32Array [x,y,...]（座標は符号なし32bit・Int32だとx>2^31の日本全域が負値化） / ranges: Uint32Array [offset,len,...]（頂点単位）
	static XYtoGintBatch(xy, ranges) {
		const count = xy.length >>> 1;
		const rc = ranges.length >>> 1;
		if (!wasmReady || typeof XYtoL1_wasm !== 'function' || sharedWasmPtr === 0) {
			const out = new BigUint64Array(count);
			for (let i = 0; i < count; i++) out[i] = this.packFromInt(xy[i*2], xy[i*2+1]);
			for (let i = 0; i < rc; i++) this.L1toL2(out.subarray(ranges[i*2], ranges[i*2] + ranges[i*2+1]));
			return out;
		}
		const byteLength = count * 8;
		const out = new BigUint64Array(count);
		if (byteLength === 0) return out;
		const ptr = this._ensureBufferSize(byteLength);
		new Uint8Array(wasmMemoryBuffer.buffer).set(new Uint8Array(xy.buffer, xy.byteOffset, byteLength), ptr);
		XYtoL1_wasm(ptr, count);
		for (let i = 0; i < rc; i++) {
			const len = ranges[i*2+1];
			if (len >= 3) L1toL2_wasm(ptr + ranges[i*2] * 8, len);
		}
		new Uint8Array(out.buffer).set(new Uint8Array(wasmMemoryBuffer.buffer).subarray(ptr, ptr + byteLength));
		return out;
	}

	// 全arc一括のVW簡略化: wasmへのアップロード/ダウンロードを各1回に（arc単位のmemcpy往復＝数万回を排除）
	// buffer: 連結済み BigUint64Array / ranges: Uint32Array [offset, len, offset, len, ...]（要素単位）
	static L1toL2Batch(buffer, ranges) {
		const count = ranges.length >>> 1;
		if (!wasmReady || typeof L1toL2_wasm !== 'function' || sharedWasmPtr === 0) {
			for (let i = 0; i < count; i++) this.L1toL2(buffer.subarray(ranges[i*2], ranges[i*2] + ranges[i*2+1]));
			return;
		}
		const byteLength = buffer.length * 8;
		if (byteLength === 0) return;
		const ptr = this._ensureBufferSize(byteLength);
		new Uint8Array(wasmMemoryBuffer.buffer).set(new Uint8Array(buffer.buffer, buffer.byteOffset, byteLength), ptr);
		for (let i = 0; i < count; i++) {
			const len = ranges[i*2+1];
			if (len >= 3) L1toL2_wasm(ptr + ranges[i*2] * 8, len);
		}
		// wasmメモリが処理中に成長した場合に備えビューは取り直す（linear memoryは伸長のみ・ptrは不変）
		new Uint8Array(buffer.buffer, buffer.byteOffset, byteLength)
			.set(new Uint8Array(wasmMemoryBuffer.buffer).subarray(ptr, ptr + byteLength));
	}

	static detectIntersections(arcBuffer, arcMeta, arcCount, snapDistSq, gridUnit) {
		if (!wasmReady || !arcBuffer || !arcMeta || arcCount === 0) return null;
		const arcBufBytes  = arcBuffer.byteLength;
		const arcMetaBytes = arcMeta.byteLength;
		const outMaxRec    = Math.max(arcCount * 8, 256);
		const totalBytes   = arcBufBytes + arcMetaBytes + outMaxRec * 16;
		const ptr = this._ensureBufferSize(totalBytes);
		const u8  = new Uint8Array(wasmMemoryBuffer.buffer);
		u8.set(new Uint8Array(arcBuffer.buffer, arcBuffer.byteOffset, arcBufBytes), ptr);
		u8.set(new Uint8Array(arcMeta.buffer,   arcMeta.byteOffset,   arcMetaBytes), ptr + arcBufBytes);
		const outPtr = ptr + arcBufBytes + arcMetaBytes;
		const count = detect_intersections_wasm(
			ptr, arcBuffer.length,
			ptr + arcBufBytes, arcCount,
			snapDistSq, gridUnit,
			outPtr, outMaxRec
		);
		const map = new Map();
		if (count > 0) {
			const u8after = new Uint8Array(wasmMemoryBuffer.buffer);
			const r = new Uint32Array(u8after.buffer, outPtr, count * 4).slice();
			for (let i = 0; i < count; i++) {
				const packed = (BigInt(r[i*4+3]) << 32n) | BigInt(r[i*4+2]);
				const key = `${r[i*4]}-${r[i*4+1]}`;
				if (!map.has(key)) map.set(key, []);
				map.get(key).push(packed);
			}
		}
		return map;
	}

	// topology() の全量 wasm 版：feature 台帳（[fid,type,geomPos]×n）と PBF 生バイトを1回渡し、
	// GintBUF 完成品を1回で受け取る。デルタ復号→fit→densify→位相→レイアウト組立まで全部 Rust＝
	// JS に残るのは props 由来の fid 台帳組立だけ。wasm 不在なら null（従来経路へ）。
	static topologyFullWasm(self, formatVersion) {
		if (!wasmReady || typeof topology_full_wasm !== 'function') return null;
		const dir = [];
		let tub = new Map();
		self.forEach((i, map) => { const key = self.props[i].join("|");
			if (!tub.has(key)) tub.set(key, i);
			const id = tub.get(key);
			(map[2] === 6) ? map[3].forEach((p, j) => dir.push(id, map[4][j], p)) : dir.push(id, map[2], map[1]);
		});
		tub = null;
		const res = topology_full_wasm(self.pbf.buf, new Uint32Array(dir), self.e, formatVersion);
		const len = res.len();
		const out = new Uint8Array(len);
		out.set(new Uint8Array(wasmMemoryBuffer.buffer, res.ptr(), len));
		res.free();
		return out.buffer;
	}

	// topology.js ポリゴン経路（cutPolygon→meta→buildArcs→stream組立）の wasm 一括版。
	// XY連結バッファ＋リング台帳を1回渡し、GintBUF 素材（arc/meta/polyStream/neighborStream）を
	// 1往復で受け取る＝JS中盤の Map/文字列キー/GC を丸ごと排除。wasm 不在なら null（JS経路へ）。
	static buildPolygonsWasm(topo) {
		if (!wasmReady || typeof build_polygons_wasm !== 'function' || !topo.length) return null;
		let totalV = 0, ringCount = 0;
		for (const q of topo) { ringCount += q.coords.length; for (const r of q.coords) totalV += r.length >> 1; }
		const xy = new Uint32Array(totalV * 2), rings = new Uint32Array(ringCount * 2), comps = new Uint32Array(topo.length * 2);
		let vo = 0, ri = 0;
		topo.forEach((q, ci) => {
			comps[ci * 2] = q.id; comps[ci * 2 + 1] = q.coords.length;
			for (const r of q.coords) { const n = r.length >> 1; rings[ri * 2] = vo; rings[ri * 2 + 1] = n; xy.set(r, vo * 2); vo += n; ri++; }
		});
		const res = build_polygons_wasm(xy, rings, comps);
		// ビューは読む直前に都度取る（処理中に wasm メモリが成長すると旧 buffer は detach するため）
		const count = res.count();
		const buffer         = new BigUint64Array(wasmMemoryBuffer.buffer, res.arc_buffer_ptr(), res.arc_buffer_len()).slice();
		const meta           = new Uint32Array(wasmMemoryBuffer.buffer, res.arc_meta_ptr(), res.arc_meta_len()).slice();
		const polyStream     = new Int32Array(wasmMemoryBuffer.buffer, res.poly_stream_ptr(), res.poly_stream_len()).slice();
		const neighborStream = new Int32Array(wasmMemoryBuffer.buffer, res.neighbor_stream_ptr(), res.neighbor_stream_len()).slice();
		res.free();
		return { count, buffer, meta, mlen: 8, polyStream, neighborStream };
	}

	// topology.js ライン経路（cutPolyline→meta→VW→lineStream）の wasm 一括版。
	// purifier は呼び出し側(buildPolylines)が JS で適用済み。coords は L1 Morton(u64) のまま渡す。
	static buildPolylinesWasm(topo, n_poly = 0, vertexOffset = 0) {
		if (!wasmReady || typeof build_polylines_wasm !== 'function' || !topo.length) return null;
		let total = 0;
		for (const q of topo) total += q.coords.length;
		const coords = new BigUint64Array(total), lines = new Uint32Array(topo.length * 2), fids = new Uint32Array(topo.length);
		let off = 0;
		topo.forEach((q, i) => { coords.set(q.coords, off); lines[i * 2] = off; lines[i * 2 + 1] = q.coords.length; fids[i] = q.id; off += q.coords.length; });
		const res = build_polylines_wasm(coords, lines, fids, n_poly, vertexOffset);
		const count = res.count();
		const buffer     = new BigUint64Array(wasmMemoryBuffer.buffer, res.arc_buffer_ptr(), res.arc_buffer_len()).slice();
		const meta       = new Uint32Array(wasmMemoryBuffer.buffer, res.arc_meta_ptr(), res.arc_meta_len()).slice();
		const lineStream = new Int32Array(wasmMemoryBuffer.buffer, res.line_stream_ptr(), res.line_stream_len()).slice();
		res.free();
		return { count, buffer, meta, mlen: 8, lineStream };
	}

	static XY2L1(estimatedPoints = 4096) {
		if (!wasmReady) {
			const coords = [];
			return {
				push(x, y) { coords.push(gint.packFromInt(x, y)); },
				close() { return new BigUint64Array(coords); }
			};
		}
		let count = 0, i32Idx = 0, bufSize = estimatedPoints * 2;
		let ptr = this._ensureBufferSize(bufSize * 4);
		let view = new Int32Array(wasmMemoryBuffer.buffer, ptr, bufSize);
		return {
			push(x, y) {
				if (i32Idx + 2 >= view.length) { bufSize *= 2;
					ptr = gint._ensureBufferSize(bufSize * 4);
					view = new Int32Array(wasmMemoryBuffer.buffer, ptr, bufSize);
				}
				view[i32Idx++] = x; view[i32Idx++] = y; count++;
			},
			close() {
				if (count === 0) return new BigUint64Array(0);
				XYtoL1_wasm(ptr, count);
				const u64View = new BigUint64Array(wasmMemoryBuffer.buffer, ptr, count);
				return u64View.slice();
			}
		};
	}
}
