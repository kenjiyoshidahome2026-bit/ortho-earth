// convert/engine.js ── カーネルの GPU 実行面。CPU 参照（kernels.js の *CPU）と同じ入出力契約を GPU で満たす。
// dispatch は maxComputeWorkgroupsPerDimension（既定 65535）× WG を超えたら base をずらして分割する。
import { createContext } from "./gpu.js";
import { mercTable, YT_LEN } from "./merc.js";
import { PROJECT_WGSL, LOD_WGSL, WKB_WGSL, BBOX_WGSL, WG, lodUniform, packArcThresholds, projectCPU, lodCPU, wkbCPU, bboxCPU } from "./kernels.js";

export function createEngine(device) {
	if (!device) return cpuEngine();
	const ctx = createContext(device);
	const chunk = ctx.maxWG * WG;   // 1 dispatch で捌ける x 方向の要素数
	const u4 = (...v) => { const u = new Uint32Array(4); v.forEach((x, i) => u[i] = x); return u; };
	let ytabBuf = null;
	const ytab = () => ytabBuf ??= ctx.upload(mercTable());

	return {
		kind: "gpu", info: device.__info || {},
		// ① arcU32(2n) → { xy: GPUBuffer(2n u32), rk: GPUBuffer(n u32), n }（GPU 常駐＝lod に直接渡す）
		project(arcU32) {
			const n = arcU32.length >>> 1;
			const arc = ctx.upload(arcU32), xy = ctx.alloc(n * 8), rk = ctx.alloc(n * 4);
			const pipe = ctx.pipeline(PROJECT_WGSL);
			for (let base = 0; base < n; base += chunk) {
				const cnt = Math.min(chunk, n - base);
				ctx.run(pipe, [ctx.uniform(u4(n, base)), arc, ytab(), xy, rk], [Math.ceil(cnt / WG)]);
			}
			arc.destroy();
			return { xy, rk, n, async read() { return { xy: new Uint32Array(await ctx.readback(xy, n * 8)), rk: new Uint32Array(await ctx.readback(rk, n * 4)) }; }, destroy() { xy.destroy(); rk.destroy(); } };
		},
		// ② mode 0 → { counts: Uint32Array(Z·A), bbox: Uint32Array(Z·A·4) }
		async lodCount(proj, arcs, params) {
			const { arcCount, zoomCount } = params;
			const arcsBuf = ctx.upload(arcs), counts = ctx.alloc(zoomCount * arcCount * 4), bbox = ctx.alloc(zoomCount * arcCount * 16);
			// 同じバッファを read と read_write の両 binding に挙げると bind group が無効＝黙って何も走らない。dummy は別々に。
			const d1 = ctx.alloc(4), d2 = ctx.alloc(4), thBuf = ctx.upload(packArcThresholds(params.arcThresholds));
			const pipe = ctx.pipeline(LOD_WGSL);
			for (let base = 0; base < arcCount; base += chunk) {
				const cnt = Math.min(chunk, arcCount - base);
				ctx.run(pipe, [ctx.uniform(lodUniform({ ...params, base, mode: 0 })), proj.xy, proj.rk, arcsBuf, d1, counts, bbox, d2, thBuf], [Math.ceil(cnt / WG), zoomCount]);
			}
			const out = { counts: new Uint32Array(await ctx.readback(counts, zoomCount * arcCount * 4)), bbox: new Uint32Array(await ctx.readback(bbox, zoomCount * arcCount * 16)) };
			arcsBuf.destroy(); counts.destroy(); bbox.destroy(); d1.destroy(); d2.destroy(); thBuf.destroy();
			return out;
		},
		// ② mode 1 → Uint32Array(total·2)。offsets はズーム先頭からの累積（呼び出し側が prefix sum）。
		//   zoomLo..zoomHi（添字）だけを書く＝出力が GPU の1バッファ上限を超える時は呼び出し側がズームを分ける。
		async lodWrite(proj, arcs, params, offsets, total, zoomFrom = 0, zoomTo = params.zoomCount) {
			const { arcCount } = params;
			const arcsBuf = ctx.upload(arcs), offBuf = ctx.upload(offsets), outBuf = ctx.alloc(total * 8), d1 = ctx.alloc(4), d2 = ctx.alloc(4);
			const pipe = ctx.pipeline(LOD_WGSL);
			const sub = subParams(params, zoomFrom, zoomTo), thBuf = ctx.upload(packArcThresholds(sub.arcThresholds));
			// slot = k·arcCount + a は「部分ズーム」の k で数えるので offsets も部分を渡す（呼び出し側で slice 済み前提）
			for (let base = 0; base < arcCount; base += chunk) {
				const cnt = Math.min(chunk, arcCount - base);
				ctx.run(pipe, [ctx.uniform(lodUniform({ ...sub, base, mode: 1 })), proj.xy, proj.rk, arcsBuf, offBuf, d1, d2, outBuf, thBuf], [Math.ceil(cnt / WG), sub.zoomCount]);
			}
			const out = new Uint32Array(await ctx.readback(outBuf, total * 8));
			arcsBuf.destroy(); offBuf.destroy(); outBuf.destroy(); d1.destroy(); d2.destroy(); thBuf.destroy();
			return out;
		},
		// ③ Int32Array(n) / d → Uint32Array(2n)（double の lo,hi）
		async wkb(iv, d) {
			const n = iv.length;
			const inBuf = ctx.upload(iv), outBuf = ctx.alloc(n * 8);
			const pipe = ctx.pipeline(WKB_WGSL);
			for (let base = 0; base < n; base += chunk) {
				const cnt = Math.min(chunk, n - base);
				ctx.run(pipe, [ctx.uniform(u4(n, base, d)), inBuf, outBuf], [Math.ceil(cnt / WG)]);
			}
			const out = new Uint32Array(await ctx.readback(outBuf, n * 8));
			inBuf.destroy(); outBuf.destroy();
			return out;
		},
		// ④ Int32Array(2v) + parts(2p: offset,len) → Int32Array(4p)
		async bbox(iv, parts) {
			const p = parts.length >>> 1;
			const inBuf = ctx.upload(iv), pBuf = ctx.upload(parts), outBuf = ctx.alloc(p * 16);
			const pipe = ctx.pipeline(BBOX_WGSL);
			for (let base = 0; base < p; base += chunk) {
				const cnt = Math.min(chunk, p - base);
				ctx.run(pipe, [ctx.uniform(u4(p, base)), inBuf, pBuf, outBuf], [Math.ceil(cnt / WG)]);
			}
			const out = new Int32Array(await ctx.readback(outBuf, p * 16));
			inBuf.destroy(); pBuf.destroy(); outBuf.destroy();
			return out;
		},
		destroy() { ytabBuf?.destroy(); ytabBuf = null; ctx.destroy(); },
	};
}

// 部分ズーム [zoomFrom, zoomTo) のパラメータ（閾値・arc 別閾値表は k 優先なので連続部分）
function subParams(params, zoomFrom, zoomTo) {
	return { ...params, minZoom: params.minZoom + zoomFrom, zoomCount: zoomTo - zoomFrom, thresholds: params.thresholds.slice(zoomFrom, zoomTo),
		arcThresholds: params.arcThresholds ? params.arcThresholds.subarray(zoomFrom * params.arcCount, zoomTo * params.arcCount) : undefined };
}

// CPU 版＝同じ契約（GPU 無し・検定の参照）。project の戻りは typed array のまま（read() で同形に）。
export function cpuEngine() {
	return {
		kind: "cpu", info: {},
		project(arcU32) { const r = projectCPU(arcU32); return { ...r, n: r.rk.length, async read() { return { xy: r.xy, rk: r.rk }; }, destroy() {} }; },
		async lodCount(proj, arcs, params) {
			const { arcCount, zoomCount } = params;
			const counts = new Uint32Array(zoomCount * arcCount), bbox = new Uint32Array(zoomCount * arcCount * 4);
			lodCPU({ xy: proj.xy, rk: proj.rk, arcs, ...params, mode: 0, counts, bbox });
			return { counts, bbox };
		},
		async lodWrite(proj, arcs, params, offsets, total, zoomFrom = 0, zoomTo = params.zoomCount) {
			const out = new Uint32Array(total * 2);
			lodCPU({ xy: proj.xy, rk: proj.rk, arcs, ...subParams(params, zoomFrom, zoomTo), mode: 1, offsets, out });
			return out;
		},
		async wkb(iv, d) { return wkbCPU(iv, d); },
		async bbox(iv, parts) { return bboxCPU(iv, parts); },
		destroy() {},
	};
}
