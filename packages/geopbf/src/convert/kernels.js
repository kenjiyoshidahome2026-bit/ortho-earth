// convert/kernels.js ── 変換の「並列部分」。WGSL と CPU 参照実装を同じファイルに並べ、同じ入出力契約で書く。
// 整数演算だけ＝両者は bit 一致（tests/t-convert-gpu.html / scripts/verify-convert-gpu.mjs が全出力を比較する）。
//
//  ① project : gint u64（Morton・rank 内蔵）→ 固定小数点 X32/Y32 ＋ rank（頂点毎・ズーム非依存＝1回だけ）
//  ② lod     : (arc, zoom) 毎に「rank ≥ 閾値の頂点をタイル座標へ量子化→連続重複除去→圧縮書き出し」＝
//              ortho-core の GPU Dynamic LOD（lodSnap: rank 未満は discard・端点は L1=63 で常時保持）と同じ選別を
//              全ズーム分まとめて 1 dispatch で行う。mode 0＝件数と bbox だけ、mode 1＝offsets へ書く。
//              arc 単位なので共有境界は隣接ポリゴンで同じ頂点列に簡略化される＝タイルに隙間が出ない。
//  ③ wkb     : GeoPBF 整数座標（10^p 単位）→ IEEE754 double の bit（lo,hi）。長除算で仮数を立て最近偶数丸め＝
//              JS の `i / 10^p`（正しく丸めた除算）と bit 一致。WGSL に f64 は無いが、整数で作れば「正確な double」は作れる。
//  ④ bbox    : パート（環/線/点列）毎の整数 min/max。
import { MERC_WGSL, lonToX32, latToY32, mercTable, decodeGint } from "./merc.js";

export const WG = 64;

// ───────────────────────────── ① project ─────────────────────────────
export const PROJECT_WGSL = /* wgsl */`
struct ParamsP { n: u32, base: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> P: ParamsP;
@group(0) @binding(1) var<storage, read> arc: array<u32>;
@group(0) @binding(2) var<storage, read> ytab: array<u32>;
@group(0) @binding(3) var<storage, read_write> xy: array<u32>;
@group(0) @binding(4) var<storage, read_write> rk: array<u32>;
${MERC_WGSL}
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x + P.base;
	if (i >= P.n) { return; }
	let lo = arc[i * 2u]; let hi = arc[i * 2u + 1u];
	let l1 = (hi >> 31u) != 0u;
	let loC = select(lo & 0xFFFFFFC0u, lo, l1);
	let hiC = hi & 0x7FFFFFFFu;
	let ix = (compact16(hiC) << 16u) | compact16(loC);
	let iy = (compact16(hiC >> 1u) << 16u) | compact16(loC >> 1u);
	xy[i * 2u] = lonToX32(ix);
	xy[i * 2u + 1u] = latToY32(iy);
	rk[i] = select(lo & 0x3Fu, 63u, l1);
}`;

// arcU32: gint u64 を (lo,hi) で見た Uint32Array(2n)。→ { xy: Uint32Array(2n), rk: Uint32Array(n) }
export function projectCPU(arcU32) {
	const n = arcU32.length >>> 1, xy = new Uint32Array(n * 2), rk = new Uint32Array(n), t = mercTable(), v = [0, 0, 0];
	for (let i = 0; i < n; i++) {
		decodeGint(arcU32[i * 2], arcU32[i * 2 + 1], v);
		xy[i * 2] = lonToX32(v[0]); xy[i * 2 + 1] = latToY32(v[1], t); rk[i] = v[2];
	}
	return { xy, rk };
}

// ───────────────────────────── ② lod ─────────────────────────────
// uniform Q: arcCount, base, zoomCount, minZoom, extentShift, mode, useArcTh, pad, th[8] (vec4u ×8 = 32 ズーム分の閾値)
// arcTh: useArcTh=1 のとき (arc, zoom) 毎の閾値（u8 を u32 に 4 個詰め・slot = k·arcCount + a）＝calibrate.js の DP 予算
export const LOD_WGSL = /* wgsl */`
struct ParamsQ { arcCount: u32, base: u32, zoomCount: u32, minZoom: u32, extentShift: u32, mode: u32, useArcTh: u32, pad1: u32, th: array<vec4<u32>, 8> };
@group(0) @binding(0) var<uniform> Q: ParamsQ;
@group(0) @binding(1) var<storage, read> xy: array<u32>;
@group(0) @binding(2) var<storage, read> rk: array<u32>;
@group(0) @binding(3) var<storage, read> arcs: array<u32>;
@group(0) @binding(4) var<storage, read> offsets: array<u32>;
@group(0) @binding(5) var<storage, read_write> counts: array<u32>;
@group(0) @binding(6) var<storage, read_write> bbox: array<u32>;
@group(0) @binding(7) var<storage, read_write> outv: array<u32>;
@group(0) @binding(8) var<storage, read> arcTh: array<u32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
	let a = g.x + Q.base; let k = g.y;
	if (a >= Q.arcCount || k >= Q.zoomCount) { return; }
	let z = Q.minZoom + k;
	let sh = 32u - z - Q.extentShift;
	let off = arcs[a * 2u]; let len = arcs[a * 2u + 1u];
	let slot = k * Q.arcCount + a;
	var th = Q.th[k >> 2u][k & 3u];
	if (Q.useArcTh == 1u) { th = (arcTh[slot >> 2u] >> ((slot & 3u) * 8u)) & 255u; }
	var n = 0u; var px = 0u; var py = 0u;
	var minx = 0xFFFFFFFFu; var miny = 0xFFFFFFFFu; var maxx = 0u; var maxy = 0u;
	var base = 0u;
	if (Q.mode == 1u) { base = offsets[slot]; }
	for (var i = 0u; i < len; i++) {
		let v = off + i;
		if (rk[v] < th) { continue; }
		let x = xy[v * 2u] >> sh; let y = xy[v * 2u + 1u] >> sh;
		if (n > 0u && x == px && y == py) { continue; }
		if (Q.mode == 1u) { outv[(base + n) * 2u] = x; outv[(base + n) * 2u + 1u] = y; }
		n++; px = x; py = y;
		minx = min(minx, x); miny = min(miny, y); maxx = max(maxx, x); maxy = max(maxy, y);
	}
	if (Q.mode == 0u) {
		counts[slot] = n;
		bbox[slot * 4u] = minx; bbox[slot * 4u + 1u] = miny; bbox[slot * 4u + 2u] = maxx; bbox[slot * 4u + 3u] = maxy;
	}
}`;

export function lodUniform({ arcCount, base = 0, zoomCount, minZoom, extentShift, mode, thresholds, arcThresholds }) {
	const u = new Uint32Array(8 + 32);
	u[0] = arcCount; u[1] = base; u[2] = zoomCount; u[3] = minZoom; u[4] = extentShift; u[5] = mode; u[6] = arcThresholds ? 1 : 0;
	for (let k = 0; k < zoomCount; k++) u[8 + k] = thresholds[k];
	return u;
}
// (arc, zoom) 閾値表（Uint8Array・k 優先）→ GPU 用の u32 詰め（4 バイト境界に揃えた複製）
export function packArcThresholds(arcTh) {
	if (!arcTh) return new Uint32Array(1);
	const u = new Uint32Array((arcTh.length + 3) >> 2);
	new Uint8Array(u.buffer).set(arcTh);
	return u;
}

// CPU 参照。mode 0: counts/bbox を埋める。mode 1: offsets に従い out へ書く（out は呼び出し側が確保）。
export function lodCPU({ xy, rk, arcs, arcCount, zoomCount, minZoom, extentShift, thresholds, arcThresholds, mode, offsets, counts, bbox, out }) {
	for (let k = 0; k < zoomCount; k++) {
		const z = minZoom + k, sh = 32 - z - extentShift, thz = thresholds[k];
		const shift = (v) => sh >= 32 ? 0 : (v >>> sh);
		for (let a = 0; a < arcCount; a++) {
			const off = arcs[a * 2], len = arcs[a * 2 + 1], slot = k * arcCount + a, th = arcThresholds ? arcThresholds[slot] : thz;
			let n = 0, px = 0, py = 0, minx = 0xFFFFFFFF, miny = 0xFFFFFFFF, maxx = 0, maxy = 0;
			const base = mode === 1 ? offsets[slot] : 0;
			for (let i = 0; i < len; i++) {
				const v = off + i;
				if (rk[v] < th) continue;
				const x = shift(xy[v * 2]), y = shift(xy[v * 2 + 1]);
				if (n > 0 && x === px && y === py) continue;
				if (mode === 1) { out[(base + n) * 2] = x; out[(base + n) * 2 + 1] = y; }
				n++; px = x; py = y;
				if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y;
			}
			if (mode === 0) { counts[slot] = n; bbox[slot * 4] = minx; bbox[slot * 4 + 1] = miny; bbox[slot * 4 + 2] = maxx; bbox[slot * 4 + 3] = maxy; }
		}
	}
}

// ───────────────────────────── ③ wkb（int → double bits） ─────────────────────────────
export const WKB_WGSL = /* wgsl */`
struct ParamsW { n: u32, base: u32, d: u32, pad: u32 };
@group(0) @binding(0) var<uniform> W: ParamsW;
@group(0) @binding(1) var<storage, read> iv: array<i32>;
@group(0) @binding(2) var<storage, read_write> outv: array<u32>;
// v / d を最近偶数丸めの IEEE754 double にして (lo, hi) で返す
fn toDouble(v: i32, d: u32) -> vec2<u32> {
	if (v == 0) { return vec2<u32>(0u, 0u); }
	let sign = select(0u, 0x80000000u, v < 0);
	let a = select(u32(v), u32(-v), v < 0);
	let q = a / d; var r = a - q * d;
	var mh = 0u; var ml = 0u; var nb = 0u;   // 53bit 仮数（先頭1込み）を (mh:上位21bit, ml:下位32bit) に積む
	var e = 0;
	if (q > 0u) {
		let L = 32u - countLeadingZeros(q);
		e = i32(L) - 1;
		// q の L bit を積む
		for (var i = 0u; i < L; i++) {
			let b = (q >> (L - 1u - i)) & 1u;
			mh = (mh << 1u) | (ml >> 31u); ml = (ml << 1u) | b; nb++;
		}
	} else {
		// 先頭の 1 まで小数ビットを読み飛ばす（r ≥ 1・d ≤ 1e9 → 30 bit 以内に必ず現れる）
		var z = 0;
		loop {
			r = r << 1u; z++;
			if (r >= d) { r = r - d; break; }
		}
		e = -z;
		mh = 0u; ml = 1u; nb = 1u;
	}
	for (; nb < 53u; nb++) {
		r = r << 1u;
		var b = 0u;
		if (r >= d) { r = r - d; b = 1u; }
		mh = (mh << 1u) | (ml >> 31u); ml = (ml << 1u) | b;
	}
	// 丸め：round bit と sticky
	r = r << 1u;
	var rb = 0u;
	if (r >= d) { r = r - d; rb = 1u; }
	let sticky = r != 0u;
	if (rb == 1u && (sticky || (ml & 1u) == 1u)) {
		ml = ml + 1u;
		if (ml == 0u) { mh = mh + 1u; }
		if (mh >= 0x200000u) { mh = 0x100000u; ml = 0u; e = e + 1; }   // 2^53 へ繰り上がり＝仮数 1.0・指数 +1
	}
	let hi = sign | (u32(e + 1023) << 20u) | (mh & 0xFFFFFu);
	return vec2<u32>(ml, hi);
}
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
	let i = g.x + W.base;
	if (i >= W.n) { return; }
	let dbl = toDouble(iv[i], W.d);
	outv[i * 2u] = dbl.x; outv[i * 2u + 1u] = dbl.y;
}`;

// CPU 参照：JS の除算（IEEE 正しい丸め）の bit をそのまま
export function wkbCPU(iv, d) {
	const n = iv.length, out = new Uint32Array(n * 2), f = new Float64Array(1), u = new Uint32Array(f.buffer);
	for (let i = 0; i < n; i++) { f[0] = iv[i] / d; out[i * 2] = u[0]; out[i * 2 + 1] = u[1]; }
	return out;
}

// ───────────────────────────── ④ bbox（パート毎） ─────────────────────────────
export const BBOX_WGSL = /* wgsl */`
struct ParamsB { n: u32, base: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> B: ParamsB;
@group(0) @binding(1) var<storage, read> iv: array<i32>;
@group(0) @binding(2) var<storage, read> parts: array<u32>;
@group(0) @binding(3) var<storage, read_write> outv: array<i32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3<u32>) {
	let p = g.x + B.base;
	if (p >= B.n) { return; }
	let off = parts[p * 2u]; let len = parts[p * 2u + 1u];
	var minx = 2147483647; var miny = 2147483647; var maxx = -2147483648; var maxy = -2147483648;
	for (var i = 0u; i < len; i++) {
		let x = iv[(off + i) * 2u]; let y = iv[(off + i) * 2u + 1u];
		minx = min(minx, x); miny = min(miny, y); maxx = max(maxx, x); maxy = max(maxy, y);
	}
	outv[p * 4u] = minx; outv[p * 4u + 1u] = miny; outv[p * 4u + 2u] = maxx; outv[p * 4u + 3u] = maxy;
}`;

export function bboxCPU(iv, parts) {
	const n = parts.length >>> 1, out = new Int32Array(n * 4);
	for (let p = 0; p < n; p++) {
		const off = parts[p * 2], len = parts[p * 2 + 1];
		let minx = 2147483647, miny = 2147483647, maxx = -2147483648, maxy = -2147483648;
		for (let i = 0; i < len; i++) {
			const x = iv[(off + i) * 2], y = iv[(off + i) * 2 + 1];
			if (x < minx) minx = x; if (y < miny) miny = y; if (x > maxx) maxx = x; if (y > maxy) maxy = y;
		}
		out[p * 4] = minx; out[p * 4 + 1] = miny; out[p * 4 + 2] = maxx; out[p * 4 + 3] = maxy;
	}
	return out;
}
