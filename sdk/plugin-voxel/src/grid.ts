// voxel の下ごしらえ（@ortho-earth/plugin-voxel・2026-10-23）＝純関数（DOM なし・node の検定が読む）。
//   VoxelData（globe の normVoxel が検めた物）→ { dims, comps, tex（R8 か RGBA8＝GPU の 3D テクスチャ）, cmap（256×RGBA8 の色表）, anchor, A（セル → 東北上 m の 3×3）, radius, range }
//   値の詰め方（R8）＝0＝空（noData・range の外は端に寄せる）、1〜255＝range を [0,1] に写した物。色表は値 0〜1 を引く。RGBA（components 4）はそのまま（α 0＝空）。
//   置き方＝box（origin＋size＋orientation）か transform（局所の単位立方体 [0,1]³ → ECEF m・列の長さが各辺の m）。region は第 2 段。
//   DDA（セルを順に辿る・Amanatides–Woo）の CPU 版もここ＝GLSL の答え合わせと、描き手の無い器の当たり。
import type { VoxelData } from "@ortho-earth/globe";

export type Hpr = [heading: number, pitch: number, roll: number];
export type RenderMode = "blocks" | "volume";
/** 色表の指定＝名前か、色の並び（等間隔）か、[位置 0〜1, 色] の並び。色＝"#rrggbb"／"#rrggbbaa"／[r, g, b, a?]（0〜255） */
export type ColorStop = string | [number, number, number] | [number, number, number, number];
export type ColormapSpec = string | ColorStop[] | Array<[number, ColorStop]>;
export interface PrepareOptions {
	colormap?: ColormapSpec;
	/** 色表に写す値の幅（省略＝data.range か、値の min／max） */
	range?: [number, number] | null;
	/** 体積の α（色表に α が無い時）＝値 0〜1 に対する [a0, a1]（既定 [0, 1]） */
	alphaRamp?: [number, number] | null;
	/** これ未満の値のセルは空（データの単位・既定＝無し） */
	threshold?: number | null;
}
export interface Prepared {
	dims: [number, number, number]; comps: 1 | 4; n: number;
	tex: Uint8Array; cmap: Uint8Array;
	anchor: [number, number, number]; /** セルの座標（0〜dims）→ 錨からの東北上 m（行優先 3×3） */ A: Float64Array; /** 錨から箱の最遠点まで（m） */ radius: number;
	range: [number, number]; /** 空の判定の閾（R8 の 0〜1） */ thr: number; /** transform で置いた＝絶対高さ */ placed: boolean;
}
const D2R = Math.PI / 180, R_SPHERE = 6371000, R_ELL = 6378137, WGS_A = 6378137, WGS_E2 = 6.69437999014e-3;
export type Mat3 = number[];

// ---- 色表 ----
/** 名前のある色表（matplotlib／turbo の要約＝9 点を等間隔に。厳密な表ではない） */
export const COLORMAPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	viridis: ["#440154", "#482878", "#3e4a89", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"],
	magma: ["#000004", "#1c1044", "#4f127b", "#812581", "#b5367a", "#e55c30", "#fb8761", "#fec287", "#fcfdbf"],
	inferno: ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#f7d13d", "#fcffa4"],
	plasma: ["#0d0887", "#46039f", "#7201a8", "#9c179e", "#bd3786", "#d8576b", "#ed7953", "#fb9f3a", "#fdca26", "#f0f921"],
	turbo: ["#30123b", "#4662d7", "#36aaf9", "#1ae4b6", "#72fe5e", "#c8ef34", "#faba39", "#f66b19", "#ca2a04", "#7a0403"],
	grey: ["#000000", "#ffffff"],
	heat: ["#000000", "#8b0000", "#ff4500", "#ffd700", "#ffffff"],
	cool: ["#00ffff", "#ff00ff"],
	blues: ["#f7fbff", "#c6dbef", "#6baed6", "#2171b5", "#08306b"],
	reds: ["#fff5f0", "#fcbba1", "#fb6a4a", "#cb181d", "#67000d"],
});
export const COLORMAP_NAMES: readonly string[] = Object.freeze(Object.keys(COLORMAPS));
export function parseColor(c: ColorStop): [number, number, number, number | null] {
	if (typeof c === "string") {
		const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
		if (!m) throw new TypeError(`plugin-voxel: color must be #rrggbb or #rrggbbaa (got ${JSON.stringify(c)})`);
		const v = parseInt(m[1], 16);
		return [(v >> 16) & 255, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) : null];
	}
	if (!Array.isArray(c) || c.length < 3 || c.length > 4 || !c.every(Number.isFinite)) throw new TypeError("plugin-voxel: color must be [r, g, b, a?] (0..255)");
	return [c[0], c[1], c[2], c.length === 4 ? (c[3] as number) : null];
}
/** 色表の指定 → [位置, 色] の並び（位置は昇順・0 と 1 を含む） */
export function colorStops(spec: ColormapSpec | undefined): Array<[number, [number, number, number, number | null]]> {
	if (spec == null) spec = "viridis";
	let list: Array<[number, ColorStop]>;
	if (typeof spec === "string") { const m = COLORMAPS[spec]; if (!m) throw new RangeError(`plugin-voxel: unknown colormap "${spec}" (${COLORMAP_NAMES.join(" | ")} or stops)`); list = m.map((c, i) => [i / (m.length - 1), c]); }
	else if (!Array.isArray(spec) || !spec.length) throw new TypeError("plugin-voxel: colormap must be a name, a list of colors or a list of [t, color]");
	else if (Array.isArray(spec[0]) && typeof (spec[0] as unknown[])[0] === "number" && (spec[0] as unknown[]).length === 2 && (typeof (spec[0] as unknown[])[1] === "string" || Array.isArray((spec[0] as unknown[])[1]))) list = (spec as Array<[number, ColorStop]>).map(([t, c]) => [+t, c]);
	else list = (spec as ColorStop[]).map((c, i, a) => [a.length === 1 ? 0 : i / (a.length - 1), c]);
	const out = list.map(([t, c]) => { if (!(t >= 0 && t <= 1)) throw new RangeError("plugin-voxel: colormap stop positions must be within 0..1"); return [t, parseColor(c)] as [number, [number, number, number, number | null]]; }).sort((a, b) => a[0] - b[0]);
	if (out[0][0] > 0) out.unshift([0, out[0][1]]); if (out[out.length - 1][0] < 1) out.push([1, out[out.length - 1][1]]);
	return out;
}
/** 色表＝256 段の RGBA8（値 0〜1 → 色・α は stop に無ければ alphaRamp＝[a0, a1] の線形） */
export function buildColormap(spec: ColormapSpec | undefined, alphaRamp: [number, number] | null = null): Uint8Array {
	const st = colorStops(spec), out = new Uint8Array(256 * 4), [a0, a1] = alphaRamp ?? [0, 1];
	let k = 0;
	for (let i = 0; i < 256; i++) {
		const t = i / 255;
		while (k < st.length - 2 && t > st[k + 1][0]) k++;
		const [t0, c0] = st[k], [t1, c1] = st[k + 1], f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
		const aa = c0[3] != null && c1[3] != null ? c0[3] + (c1[3] - c0[3]) * f : (a0 + (a1 - a0) * t) * 255;
		out[i * 4] = Math.round(c0[0] + (c1[0] - c0[0]) * f); out[i * 4 + 1] = Math.round(c0[1] + (c1[1] - c0[1]) * f); out[i * 4 + 2] = Math.round(c0[2] + (c1[2] - c0[2]) * f); out[i * 4 + 3] = Math.round(Math.min(255, Math.max(0, aa)));
	}
	return out;
}

// ---- 値の詰め（R8／RGBA8）----
/** 値の min／max（noData を除く・1 成分） */
export function valueRange(values: ArrayLike<number>, noData: number | undefined): [number, number] {
	let lo = Infinity, hi = -Infinity;
	for (let i = 0; i < values.length; i++) { const v = values[i]; if (v === noData || v !== v) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
	if (!(lo <= hi)) return [0, 1];
	return lo < hi ? [lo, hi] : [lo, lo + 1];
}
/** 1 成分の値 → R8（0＝空・1〜255＝range を [0,1] に写した物。range の外は端に寄せる・threshold 未満は空） */
export function quantize(values: ArrayLike<number>, range: [number, number], noData: number | undefined, threshold: number | null | undefined): Uint8Array {
	const out = new Uint8Array(values.length), [lo, hi] = range, sc = 254 / (hi - lo), th = threshold ?? -Infinity;
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v === noData || v !== v || v < th) continue;
		const t = (v - lo) * sc;
		out[i] = 1 + (t <= 0 ? 0 : t >= 254 ? 254 : Math.round(t));
	}
	return out;
}
/** 4 成分（RGBA）→ RGBA8（Uint8 はそのまま・Uint16 は 1/257・Float32 は 0〜1 を 255 倍。noData は α 0） */
export function toRgba8(values: Float32Array | Uint16Array | Uint8Array, noData: number | undefined): Uint8Array {
	if (values instanceof Uint8Array && noData == null) return values.slice();   // 写し＝transfer しても渡した人の配列は手放さない
	const out = new Uint8Array(values.length), sc = values instanceof Uint8Array ? 1 : values instanceof Uint16Array ? 1 / 257 : 255;
	for (let i = 0; i < values.length; i += 4) {
		if (noData != null && values[i + 3] === noData) continue;
		for (let c = 0; c < 4; c++) { const t = values[i + c] * sc; out[i + c] = t <= 0 ? 0 : t >= 255 ? 255 : Math.round(t); }
	}
	return out;
}

// ---- 置き方 ----
const unit = (lon: number, lat: number, rAx: number): number[] => { const a = lon * D2R; let b = lat * D2R; if (rAx !== 1) b = Math.atan(rAx * Math.tan(b)); const cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; };
export interface EnuBasis { E: number[]; N: number[]; U: number[]; u: number[] }
/** 錨の東北上 m → 単位球（列＝東・北・上×1/R）＝本体の単位球（y が極）。plugin-splat の splat-gl.ts と同じ */
export function enuBasis(lon: number, lat: number, rAx = 1): EnuBasis {
	const u = unit(lon, lat, rAx), cl = Math.hypot(u[0], u[2]), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL);
	const E = cl < 1e-12 ? [1, 0, 0] : [-u[2] / cl, 0, u[0] / cl], N = [E[1] * u[2] - E[2] * u[1], E[2] * u[0] - E[0] * u[2], E[0] * u[1] - E[1] * u[0]];
	return { E: E.map(v => v * k), N: N.map(v => v * k), U: u.map(v => v * k), u };
}
/** ECEF（WGS84・z が極）→ 経緯度・楕円体高 */
export function ecefToLngLat(x: number, y: number, z: number): [number, number, number] {
	const lon = Math.atan2(y, x), p = Math.hypot(x, y); let lat = Math.atan2(z, p * (1 - WGS_E2)), h = 0;
	for (let i = 0; i < 6; i++) { const s = Math.sin(lat), N = WGS_A / Math.sqrt(1 - WGS_E2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - WGS_E2 * N / (N + h))); }
	return [lon / D2R, lat / D2R, h];
}
/** ECEF の東北上の基底（行＝東・北・上の単位ベクトル・ECEF m → ENU m は行優先 3×3） */
export function ecefEnuRows(lon: number, lat: number): Mat3 {
	const a = lon * D2R, b = lat * D2R, sa = Math.sin(a), ca = Math.cos(a), sb = Math.sin(b), cb = Math.cos(b);
	return [-sa, ca, 0, -sb * ca, -sb * sa, cb, cb * ca, cb * sa, sb];
}
export const mul3 = (A: ArrayLike<number>, B: ArrayLike<number>): Mat3 => { const C: number[] = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; };
/** 行優先 3×3 の逆行列（特異なら投げる） */
export function inv3(m: ArrayLike<number>): Mat3 {
	const [a, b, c, d, e, f, g, h, i] = Array.from(m, Number);
	const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
	if (!(Math.abs(det) > 1e-30)) throw new Error("plugin-voxel: the box is degenerate (singular placement)");
	const k = 1 / det;
	return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}
/** heading（北から時計回り）・pitch・roll（度）＝東北上の中の向き（行優先 3×3・plugin-splat の placeMat と同じ約束） */
export function hprMat([hd = 0, pt = 0, rl = 0]: Hpr | [] = []): Mat3 {
	const h = -hd * D2R, p = pt * D2R, r = rl * D2R;
	const Rz = [Math.cos(h), -Math.sin(h), 0, Math.sin(h), Math.cos(h), 0, 0, 0, 1], Rx = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)], Ry = [Math.cos(r), 0, Math.sin(r), 0, 1, 0, -Math.sin(r), 0, Math.cos(r)];
	return mul3(mul3(Rz, Rx), Ry);
}
export interface Placement { anchor: [number, number, number]; A: Float64Array; radius: number; placed: boolean }
/** VoxelData の box → 錨＋A（セル → 東北上 m）。transform＝局所の単位立方体 [0,1]³ → ECEF m */
export function placeBox(box: NonNullable<VoxelData["box"]>, dims: [number, number, number]): Placement {
	let anchor: [number, number, number], T: Mat3, placed = false;
	if ("transform" in box && box.transform != null) {
		const M = Array.from(box.transform, Number);
		if (M.length !== 16 || !M.every(Number.isFinite)) throw new TypeError("plugin-voxel: box.transform must be a column-major 4×4 (16 finite numbers)");
		anchor = ecefToLngLat(M[12], M[13], M[14]); placed = true;
		// 列優先 → 行優先の 3×3・列 i を dims[i] で割る＝セル 1 個ぶんの ECEF ベクトル → 東北上 m
		const lin: Mat3 = [M[0] / dims[0], M[4] / dims[1], M[8] / dims[2], M[1] / dims[0], M[5] / dims[1], M[9] / dims[2], M[2] / dims[0], M[6] / dims[1], M[10] / dims[2]];
		T = mul3(ecefEnuRows(anchor[0], anchor[1]), lin);
	} else {
		const b = box as { origin: [number, number, number]; size: [number, number, number]; orientation?: Hpr };
		anchor = [b.origin[0], b.origin[1], b.origin[2] || 0];
		const R = hprMat(b.orientation ?? []);
		T = [R[0] * b.size[0] / dims[0], R[1] * b.size[1] / dims[1], R[2] * b.size[2] / dims[2], R[3] * b.size[0] / dims[0], R[4] * b.size[1] / dims[1], R[5] * b.size[2] / dims[2], R[6] * b.size[0] / dims[0], R[7] * b.size[1] / dims[1], R[8] * b.size[2] / dims[2]];
	}
	// 錨から箱の最遠点まで＝各辺の長さの和（上界・地平線の向こうの判定に使うだけ）
	const radius = Math.hypot(T[0] * dims[0], T[3] * dims[0], T[6] * dims[0]) + Math.hypot(T[1] * dims[1], T[4] * dims[1], T[7] * dims[1]) + Math.hypot(T[2] * dims[2], T[5] * dims[2], T[8] * dims[2]);
	return { anchor, A: Float64Array.from(T), radius, placed };
}

// ---- 下ごしらえ ----
type NormVoxel = VoxelData & { shape: "box" | "region"; dims: [number, number, number]; components: 1 | 4 };
export function checkVoxelData(d: unknown): NormVoxel {
	const v = d as NormVoxel;
	if (!v || typeof v !== "object" || !Array.isArray(v.dims) || v.dims.length !== 3 || !(v.values instanceof Float32Array || v.values instanceof Uint16Array || v.values instanceof Uint8Array)) throw new TypeError("plugin-voxel: data must be VoxelData (dims, values, box | region)");
	const comps = (v.components ?? 1) as 1 | 4;
	if (comps !== 1 && comps !== 4) throw new RangeError("plugin-voxel: components must be 1 | 4");
	if (v.values.length !== v.dims[0] * v.dims[1] * v.dims[2] * comps) throw new RangeError(`plugin-voxel: values length ${v.values.length} != ${v.dims[0] * v.dims[1] * v.dims[2] * comps}`);
	const shape = v.shape ?? (v.box ? "box" : v.region ? "region" : undefined);
	if (shape !== "box" && shape !== "region") throw new RangeError("plugin-voxel: shape must be box | region");
	return { ...v, shape, components: comps };
}
/** VoxelData → 描き手へ渡す物（worker で。配列は transfer できる物） */
export function prepare(data: unknown, o: PrepareOptions = {}): Prepared {
	const d = checkVoxelData(data), dims = d.dims, comps = d.components, n = dims[0] * dims[1] * dims[2];
	if (d.shape !== "box" || !d.box) throw new Error("plugin-voxel: shape \"region\" is not drawn yet (stage 2); use a box");
	const { anchor, A, radius, placed } = placeBox(d.box, dims);
	let tex: Uint8Array, range: [number, number], thr = 0;
	if (comps === 4) { tex = toRgba8(d.values, d.noData); range = [0, 1]; }
	else {
		range = o.range ?? d.range ?? valueRange(d.values, d.noData);
		if (!(range[0] < range[1])) throw new RangeError("plugin-voxel: range must be [min, max] with min < max");
		tex = quantize(d.values, range, d.noData, o.threshold);
		if (o.threshold != null) thr = Math.min(1, Math.max(0, (o.threshold - range[0]) / (range[1] - range[0])));
	}
	const cmap = buildColormap(o.colormap, o.alphaRamp ?? null);
	return { dims: [dims[0], dims[1], dims[2]], comps, n, tex, cmap, anchor, A, radius, range, thr, placed };
}
export const transferables = (p: Prepared): ArrayBuffer[] => [p.tex.buffer as ArrayBuffer, p.cmap.buffer as ArrayBuffer, p.A.buffer as ArrayBuffer].filter((b, i, a) => a.indexOf(b) === i);

// ---- DDA（CPU 版＝GLSL と同じ手順・検定と当たりの参照）----
export interface RayHit { cell: [number, number, number]; t: number; axis: 0 | 1 | 2 | -1; steps: number }
/** 光線と箱 [0, dims] の交わり（t0, t1）。無ければ null */
export function rayBox(ro: ArrayLike<number>, rd: ArrayLike<number>, dims: ArrayLike<number>): [number, number, number] | null {
	let t0 = -Infinity, t1 = Infinity, axis = -1;
	for (let i = 0; i < 3; i++) {
		if (Math.abs(rd[i]) < 1e-12) { if (ro[i] < 0 || ro[i] > dims[i]) return null; continue; }
		let a = (0 - ro[i]) / rd[i], b = (dims[i] - ro[i]) / rd[i]; if (a > b) [a, b] = [b, a];
		if (a > t0) { t0 = a; axis = i; } if (b < t1) t1 = b;
	}
	return t1 > Math.max(t0, 0) ? [t0, t1, axis] : null;
}
/** ブロックの DDA：値（R8・0＝空）が thr 以上の最初のセル。tMax＝ここまで（シーンの深度）。cell 空間の光線 */
export function marchBlocks(tex: Uint8Array, dims: [number, number, number], ro: ArrayLike<number>, rd: ArrayLike<number>, thr = 0, tMax = Infinity, comps: 1 | 4 = 1): RayHit | null {
	const hit = rayBox(ro, rd, dims); if (!hit) return null;
	const t0 = Math.max(hit[0], 0), t1 = Math.min(hit[1], tMax); if (t1 <= t0) return null;
	const p = [ro[0] + rd[0] * (t0 + 1e-6), ro[1] + rd[1] * (t0 + 1e-6), ro[2] + rd[2] * (t0 + 1e-6)];
	const c = p.map((v, i) => Math.min(dims[i] - 1, Math.max(0, Math.floor(v)))), st = [0, 1, 2].map(i => rd[i] > 0 ? 1 : rd[i] < 0 ? -1 : 0);
	const tMaxA = [0, 1, 2].map(i => st[i] === 0 ? Infinity : ((st[i] > 0 ? c[i] + 1 : c[i]) - ro[i]) / rd[i]), tDelta = [0, 1, 2].map(i => st[i] === 0 ? Infinity : Math.abs(1 / rd[i]));
	let axis = hit[0] >= 0 ? (hit[2] as 0 | 1 | 2 | -1) : -1, t = t0;
	const solid = (i: number): boolean => comps === 4 ? tex[i * 4 + 3] > 0 : tex[i] > 0 && (tex[i] - 1) / 254 >= thr;
	for (let steps = 0; steps < dims[0] + dims[1] + dims[2] + 2; steps++) {
		const idx = c[0] + dims[0] * (c[1] + dims[1] * c[2]);
		if (solid(idx)) return { cell: [c[0], c[1], c[2]], t, axis, steps };
		const ax = tMaxA[0] < tMaxA[1] ? (tMaxA[0] < tMaxA[2] ? 0 : 2) : (tMaxA[1] < tMaxA[2] ? 1 : 2);
		t = tMaxA[ax]; if (t > t1) return null;
		c[ax] += st[ax]; if (c[ax] < 0 || c[ax] >= dims[ax]) return null;
		tMaxA[ax] += tDelta[ax]; axis = ax as 0 | 1 | 2;
	}
	return null;
}
