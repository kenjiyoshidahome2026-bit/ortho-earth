// convert/engine.js ── カーネルの GPU 実行面。CPU 参照（kernels.js の *CPU）と同じ入出力契約を GPU で満たす。
// dispatch は maxComputeWorkgroupsPerDimension（既定 65535）× WG を超えたら base をずらして分割する。
// dispatch ごとの uniform は submit 直後に destroy（投入済みコマンドが済むまで GPU 側が保持＝安全）。旧＝未解放で dispatch 数だけ漏れた。
import { createContext } from "./gpu.ts";
import type { ConvertDevice, GPUInfo } from "./gpu.ts";
import { mercTable } from "./merc.ts";
import { PROJECT_WGSL, LOD_WGSL, WKB_WGSL, BBOX_WGSL, WG, lodUniform, packArcThresholds, projectCPU, lodCPU, wkbCPU, bboxCPU } from "./kernels.ts";
import type { LodParams, ProjectResult } from "./kernels.ts";

/** project の戻り（GPU 常駐＝lod へ直接渡す／CPU は typed array のまま） */
export interface Projected {
	xy: GPUBuffer | Uint32Array;
	rk: GPUBuffer | Uint32Array;
	n: number;
	read(): Promise<ProjectResult>;
	destroy(): void;
}
export interface LodCount { counts: Uint32Array; bbox: Uint32Array }
/** GPU/CPU 共通の契約 */
export interface Engine {
	kind: "gpu" | "cpu";
	info: GPUInfo;
	project(arcU32: Uint32Array): Projected;
	lodCount(proj: Projected, arcs: Uint32Array, params: LodParams): Promise<LodCount>;
	lodWrite(proj: Projected, arcs: Uint32Array, params: LodParams, offsets: Uint32Array, total: number, zoomFrom?: number, zoomTo?: number): Promise<Uint32Array>;
	wkb(iv: Int32Array, d: number): Promise<Uint32Array>;
	bbox(iv: Int32Array, parts: Uint32Array): Promise<Int32Array>;
	destroy(): void;
}

export function createEngine(device: ConvertDevice | null | undefined): Engine {
	if (!device) return cpuEngine();
	const ctx = createContext(device);
	const chunk = ctx.maxWG * WG;   // 1 dispatch で捌ける x 方向の要素数
	const u4 = (...v: number[]): Uint32Array => { const u = new Uint32Array(4); v.forEach((x, i) => u[i] = x); return u; };
	let ytabBuf: GPUBuffer | null = null;
	const ytab = (): GPUBuffer => ytabBuf ??= ctx.upload(mercTable());
	const gb = (b: GPUBuffer | Uint32Array): GPUBuffer => b as GPUBuffer;   // GPU エンジンの proj は常に GPUBuffer

	return {
		kind: "gpu", info: device.__info || {},
		// ① arcU32(2n) → { xy: GPUBuffer(2n u32), rk: GPUBuffer(n u32), n }（GPU 常駐＝lod に直接渡す）
		project(arcU32: Uint32Array): Projected {
			const n = arcU32.length >>> 1;
			const arc = ctx.upload(arcU32), xy = ctx.alloc(n * 8), rk = ctx.alloc(n * 4);
			const pipe = ctx.pipeline(PROJECT_WGSL);
			for (let base = 0; base < n; base += chunk) {
				const cnt = Math.min(chunk, n - base);
				const u = ctx.uniform(u4(n, base)); ctx.run(pipe, [u, arc, ytab(), xy, rk], [Math.ceil(cnt / WG)]); u.destroy();
			}
			arc.destroy();
			return { xy, rk, n, async read() { return { xy: new Uint32Array(await ctx.readback(xy, n * 8)), rk: new Uint32Array(await ctx.readback(rk, n * 4)) }; }, destroy() { xy.destroy(); rk.destroy(); } };
		},
		// ② mode 0 → { counts: Uint32Array(Z·A), bbox: Uint32Array(Z·A·4) }
		async lodCount(proj: Projected, arcs: Uint32Array, params: LodParams): Promise<LodCount> {
			const { arcCount, zoomCount } = params;
			const arcsBuf = ctx.upload(arcs), counts = ctx.alloc(zoomCount * arcCount * 4), bbox = ctx.alloc(zoomCount * arcCount * 16);
			// 同じバッファを read と read_write の両 binding に挙げると bind group が無効＝黙って何も走らない。dummy は別々に。
			const d1 = ctx.alloc(4), d2 = ctx.alloc(4), thBuf = ctx.upload(packArcThresholds(params.arcThresholds));
			const pipe = ctx.pipeline(LOD_WGSL);
			for (let base = 0; base < arcCount; base += chunk) {
				const cnt = Math.min(chunk, arcCount - base);
				const u = ctx.uniform(lodUniform({ ...params, base, mode: 0 })); ctx.run(pipe, [u, gb(proj.xy), gb(proj.rk), arcsBuf, d1, counts, bbox, d2, thBuf], [Math.ceil(cnt / WG), zoomCount]); u.destroy();
			}
			const out = { counts: new Uint32Array(await ctx.readback(counts, zoomCount * arcCount * 4)), bbox: new Uint32Array(await ctx.readback(bbox, zoomCount * arcCount * 16)) };
			arcsBuf.destroy(); counts.destroy(); bbox.destroy(); d1.destroy(); d2.destroy(); thBuf.destroy();
			return out;
		},
		// ② mode 1 → Uint32Array(total·2)。offsets はズーム先頭からの累積（呼び出し側が prefix sum）。
		//   zoomLo..zoomHi（添字）だけを書く＝出力が GPU の1バッファ上限を超える時は呼び出し側がズームを分ける。
		async lodWrite(proj: Projected, arcs: Uint32Array, params: LodParams, offsets: Uint32Array, total: number, zoomFrom = 0, zoomTo: number = params.zoomCount): Promise<Uint32Array> {
			const { arcCount } = params;
			const arcsBuf = ctx.upload(arcs), offBuf = ctx.upload(offsets), outBuf = ctx.alloc(total * 8), d1 = ctx.alloc(4), d2 = ctx.alloc(4);
			const pipe = ctx.pipeline(LOD_WGSL);
			const sub = subParams(params, zoomFrom, zoomTo), thBuf = ctx.upload(packArcThresholds(sub.arcThresholds));
			// slot = k·arcCount + a は「部分ズーム」の k で数えるので offsets も部分を渡す（呼び出し側で slice 済み前提）
			for (let base = 0; base < arcCount; base += chunk) {
				const cnt = Math.min(chunk, arcCount - base);
				const u = ctx.uniform(lodUniform({ ...sub, base, mode: 1 })); ctx.run(pipe, [u, gb(proj.xy), gb(proj.rk), arcsBuf, offBuf, d1, d2, outBuf, thBuf], [Math.ceil(cnt / WG), sub.zoomCount]); u.destroy();
			}
			const out = new Uint32Array(await ctx.readback(outBuf, total * 8));
			arcsBuf.destroy(); offBuf.destroy(); outBuf.destroy(); d1.destroy(); d2.destroy(); thBuf.destroy();
			return out;
		},
		// ③ Int32Array(n) / d → Uint32Array(2n)（double の lo,hi）
		async wkb(iv: Int32Array, d: number): Promise<Uint32Array> {
			const n = iv.length;
			const inBuf = ctx.upload(iv), outBuf = ctx.alloc(n * 8);
			const pipe = ctx.pipeline(WKB_WGSL);
			for (let base = 0; base < n; base += chunk) {
				const cnt = Math.min(chunk, n - base);
				const u = ctx.uniform(u4(n, base, d)); ctx.run(pipe, [u, inBuf, outBuf], [Math.ceil(cnt / WG)]); u.destroy();
			}
			const out = new Uint32Array(await ctx.readback(outBuf, n * 8));
			inBuf.destroy(); outBuf.destroy();
			return out;
		},
		// ④ Int32Array(2v) + parts(2p: offset,len) → Int32Array(4p)
		async bbox(iv: Int32Array, parts: Uint32Array): Promise<Int32Array> {
			const p = parts.length >>> 1;
			const inBuf = ctx.upload(iv), pBuf = ctx.upload(parts), outBuf = ctx.alloc(p * 16);
			const pipe = ctx.pipeline(BBOX_WGSL);
			for (let base = 0; base < p; base += chunk) {
				const cnt = Math.min(chunk, p - base);
				const u = ctx.uniform(u4(p, base)); ctx.run(pipe, [u, inBuf, pBuf, outBuf], [Math.ceil(cnt / WG)]); u.destroy();
			}
			const out = new Int32Array(await ctx.readback(outBuf, p * 16));
			inBuf.destroy(); pBuf.destroy(); outBuf.destroy();
			return out;
		},
		destroy() { ytabBuf?.destroy(); ytabBuf = null; ctx.destroy(); },
	};
}

// 部分ズーム [zoomFrom, zoomTo) のパラメータ（閾値・arc 別閾値表は k 優先なので連続部分）
function subParams(params: LodParams, zoomFrom: number, zoomTo: number): LodParams {
	return { ...params, minZoom: params.minZoom + zoomFrom, zoomCount: zoomTo - zoomFrom, thresholds: Array.prototype.slice.call(params.thresholds, zoomFrom, zoomTo) as number[],
		arcThresholds: params.arcThresholds ? params.arcThresholds.subarray(zoomFrom * params.arcCount, zoomTo * params.arcCount) : undefined };
}

// CPU 版＝同じ契約（GPU 無し・検定の参照）。project の戻りは typed array のまま（read() で同形に）。
export function cpuEngine(): Engine {
	const ta = (b: GPUBuffer | Uint32Array): Uint32Array => b as Uint32Array;   // CPU エンジンの proj は常に typed array
	return {
		kind: "cpu", info: {},
		project(arcU32: Uint32Array): Projected { const r = projectCPU(arcU32); return { ...r, n: r.rk.length, async read() { return { xy: r.xy, rk: r.rk }; }, destroy() {} }; },
		async lodCount(proj: Projected, arcs: Uint32Array, params: LodParams): Promise<LodCount> {
			const { arcCount, zoomCount } = params;
			const counts = new Uint32Array(zoomCount * arcCount), bbox = new Uint32Array(zoomCount * arcCount * 4);
			lodCPU({ xy: ta(proj.xy), rk: ta(proj.rk), arcs, ...params, mode: 0, counts, bbox });
			return { counts, bbox };
		},
		async lodWrite(proj: Projected, arcs: Uint32Array, params: LodParams, offsets: Uint32Array, total: number, zoomFrom = 0, zoomTo: number = params.zoomCount): Promise<Uint32Array> {
			const out = new Uint32Array(total * 2);
			lodCPU({ xy: ta(proj.xy), rk: ta(proj.rk), arcs, ...subParams(params, zoomFrom, zoomTo), mode: 1, offsets, out });
			return out;
		},
		async wkb(iv: Int32Array, d: number): Promise<Uint32Array> { return wkbCPU(iv, d); },
		async bbox(iv: Int32Array, parts: Uint32Array): Promise<Int32Array> { return bboxCPU(iv, parts); },
		destroy() {},
	};
}
