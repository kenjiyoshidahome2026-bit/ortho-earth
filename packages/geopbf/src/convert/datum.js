// convert/datum.js ── 測地系（datum）の変換。依存ゼロ。国土地理院のメッシュ補正パラメータ（.par）を共通の器で扱う。
//
//   ① 日本測地系 → JGD2000        TKY2JGD.par                      （陸域 10〜20 cm 級 / 格子なしは内蔵 Helmert 10 m 級）
//   ② JGD2000    → JGD2011        touhokutaiheiyouoki2011.par      （2011 年東北地方太平洋沖地震・対象域外は無変換＝定義上ずれない）
//
// どちらも中身は同じ書式（先頭に説明行・以降「3 次メッシュコード dB(秒) dL(秒)」）で、値は「変換前の経緯度に足す」向き。
// 3 次メッシュ＝30″×45″、値はその南西端の量。間は双一次補間する。
//
//   const { bytes, meta } = bakeMeshGrid(parText);            // scripts/bake-datum-grid.mjs が使う焼き
//   const grid = await loadMeshGrid(urlOrBytes);              // URL / バイト列 / gzip（署名で判別）
//   grid.shift([lon, lat]) → [lon, lat] | null                // null＝格子の外
//   const datum = await resolveDatum({ tky2jgd, patchjgd });  // 入口（filegdb / gpkg）が受け取る形
//   tokyoToJGD(p, datum?.tokyo)   jgd2000To2011(p, datum?.patch)
//
// 焼いた形（geopbf 独自・小さくするためだけの器）:
//   "GSIMESH1" | u32 JSON 長 | JSON（transform/source/version/resScale…）| u32 ブロック数
//   | 索引 [u32 key, i32 meanB, i32 meanL] × n | 本体 [i16 dB, i16 dL] × 100 × n
//   key = floor(latIdx/10)×65536 + floor(lonIdx/10)（latIdx=floor(lat×120)・lonIdx=floor(lon×80)＝2 次メッシュ 1 枚に 3 次メッシュ 10×10）
//   mean は 1e-5 秒・本体は平均からの差を resScale 秒（データに合わせて 1e-5〜1e-2 から自動で選ぶ）の Int16・欠測は -32768。
import { inflate } from "../modules/inflate.js";

const MAGIC = "GSIMESH1";
const RES_SCALES = [1e-5, 1e-4, 1e-3, 1e-2];   // 残差 1 単位あたりの秒（細かい順に試して Int16 に収まる最初のもの）
const MISSING = -32768;

// ───────────────────────────── 焼き ─────────────────────────────
/** 国土地理院の .par（Shift_JIS を復号したテキスト）→ 焼いた格子。opts.transform で種別を明示（省略時は先頭行から推定）。 */
export function bakeMeshGrid(text, opts = {}) {
	const lines = text.split(/\r?\n/), header = lines[0]?.trim() ?? "";
	const transform = opts.transform ?? (/PatchJGD/i.test(header) ? "patchjgd" : /TokyoDatum/i.test(header) ? "tky2jgd" : "unknown");
	const blocks = new Map(); let cells = 0;
	for (const line of lines) {                       // 説明行の長さは版で違う＝「8 桁コード＋数値 2 つ」の行だけ拾う
		const p = line.trim().split(/\s+/);
		if (p.length < 3 || !/^\d{8}$/.test(p[0])) continue;
		const dB = +p[1], dL = +p[2]; if (!Number.isFinite(dB) || !Number.isFinite(dL)) continue;
		const c = p[0], P = +c.slice(0, 2), U = +c.slice(2, 4), Q = +c[4], V = +c[5], R = +c[6], W = +c[7];
		const latIdx = P * 80 + Q * 10 + R, lonIdx = (U + 100) * 80 + V * 10 + W;
		const key = Math.floor(latIdx / 10) * 65536 + Math.floor(lonIdx / 10);
		let b = blocks.get(key); if (!b) { b = new Array(200).fill(null); blocks.set(key, b); }
		const k = (latIdx % 10) * 10 + (lonIdx % 10);
		b[k * 2] = Math.round(dB * 1e5); b[k * 2 + 1] = Math.round(dL * 1e5); cells++;
	}
	if (!cells) throw new Error("datum: .par にデータ行が無い（8 桁のメッシュコード＋dB＋dL）");
	const keys = [...blocks.keys()].sort((a, b) => a - b);
	// 各ブロックの平均と、平均からの残差の最大（→ 目盛りを決める）
	const means = new Map(); let maxAbs = 0;
	for (const key of keys) {
		const b = blocks.get(key); let sB = 0, sL = 0, c = 0;
		for (let k = 0; k < 100; k++) if (b[k * 2] !== null) { sB += b[k * 2]; sL += b[k * 2 + 1]; c++; }
		const mB = Math.round(sB / c), mL = Math.round(sL / c); means.set(key, [mB, mL]);
		for (let k = 0; k < 100; k++) if (b[k * 2] !== null) maxAbs = Math.max(maxAbs, Math.abs(b[k * 2] - mB), Math.abs(b[k * 2 + 1] - mL));
	}
	const resScale = RES_SCALES.find(s => maxAbs * 1e-5 / s <= 32767);
	if (!resScale) throw new Error("datum: 残差が大きすぎて Int16 に収まらない");
	const unit = resScale * 1e5;   // 1 残差単位 = unit × 1e-5 秒
	const meta = { format: MAGIC, transform, source: opts.source ?? "国土地理院 座標補正パラメータ (.par)", version: header, license: "国土地理院コンテンツ利用規約（出典の明示で利用可）",
		cells, blocks: keys.length, resScale, grid: "3rd mesh (30\" x 45\"), value at SW corner, bilinear, added to the source coordinates" };
	const json = new TextEncoder().encode(JSON.stringify(meta));
	const head = 16 + json.length, idx = keys.length * 12;
	const out = new Uint8Array(head + idx + keys.length * 400), dv = new DataView(out.buffer);
	out.set(new TextEncoder().encode(MAGIC), 0); dv.setUint32(8, json.length, true); out.set(json, 12); dv.setUint32(12 + json.length, keys.length, true);
	let maxRes = 0;
	keys.forEach((key, n) => {
		const b = blocks.get(key), [mB, mL] = means.get(key);
		dv.setUint32(head + n * 12, key, true); dv.setInt32(head + n * 12 + 4, mB, true); dv.setInt32(head + n * 12 + 8, mL, true);
		for (let k = 0; k < 100; k++) for (let t = 0; t < 2; t++) {
			const v = b[k * 2 + t], o = head + idx + n * 400 + k * 4 + t * 2;
			if (v === null) { dv.setInt16(o, MISSING, true); continue; }
			const r = Math.round((v - (t ? mL : mB)) / unit);
			if (Math.abs(r) > 32767) throw new Error(`datum: 残差が Int16 を超えた（block ${key}）`);
			maxRes = Math.max(maxRes, Math.abs(r)); dv.setInt16(o, r, true);
		}
	});
	return { bytes: out, meta, maxResidualArcsec: maxRes * resScale };
}

// ───────────────────────────── 読み ─────────────────────────────
/** URL / Uint8Array / ArrayBuffer（gzip 可）→ 格子。 */
export async function loadMeshGrid(src) {
	let u8 = typeof src === "string" ? new Uint8Array(await fetchBytes(src)) : src instanceof Uint8Array ? src : new Uint8Array(src);
	if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = await inflate(u8, "gzip");
	return parseMeshGrid(u8);
}
async function fetchBytes(url) { const r = await fetch(url); if (!r.ok) throw new Error(`datum: ${url} → ${r.status}`); return r.arrayBuffer(); }

export function parseMeshGrid(u8) {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (u8.length < 16 || new TextDecoder().decode(u8.subarray(0, 8)) !== MAGIC) throw new Error(`datum: 形式が違う（${MAGIC} でない）`);
	const jl = dv.getUint32(8, true), meta = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + jl)));
	const n = dv.getUint32(12 + jl, true), head = 16 + jl, idx = head + n * 12;
	const unit = (meta.resScale ?? 1e-3) * 1e5;
	const index = new Map(); for (let i = 0; i < n; i++) index.set(dv.getUint32(head + i * 12, true), i);
	const stats = { hit: 0, miss: 0 };
	/** 3 次メッシュ (latIdx, lonIdx) 南西端の [dB, dL]（秒）。欠測は null。 */
	const cell = (latIdx, lonIdx) => {
		const i = index.get(Math.floor(latIdx / 10) * 65536 + Math.floor(lonIdx / 10)); if (i === undefined) return null;
		const k = ((latIdx % 10) + 10) % 10 * 10 + ((lonIdx % 10) + 10) % 10, o = idx + i * 400 + k * 4;
		const rb = dv.getInt16(o, true), rl = dv.getInt16(o + 2, true); if (rb === MISSING || rl === MISSING) return null;
		return [(dv.getInt32(head + i * 12 + 4, true) + rb * unit) / 1e5, (dv.getInt32(head + i * 12 + 8, true) + rl * unit) / 1e5];
	};
	/** 補正量 [dB, dL]（秒）を双一次補間。四隅のどれかが欠ければ null。 */
	const delta = ([lon, lat]) => {
		const fx = lon * 80, fy = lat * 120, x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
		const sw = cell(y0, x0), se = cell(y0, x0 + 1), nw = cell(y0 + 1, x0), ne = cell(y0 + 1, x0 + 1);
		if (!sw || !se || !nw || !ne) return null;
		const w0 = (1 - u) * (1 - v), w1 = u * (1 - v), w2 = (1 - u) * v, w3 = u * v;
		return [w0 * sw[0] + w1 * se[0] + w2 * nw[0] + w3 * ne[0], w0 * sw[1] + w1 * se[1] + w2 * nw[1] + w3 * ne[1]];
	};
	const shift = (p) => { const d = delta(p); if (!d) { stats.miss++; return null; } stats.hit++; return [p[0] + d[1] / 3600, p[1] + d[0] / 3600]; };
	return { meta, transform: meta.transform, blocks: n, cell, delta, shift, stats };
}

// ───────────────────────────── 変換 ─────────────────────────────
/** 日本測地系 → JGD2000。格子があれば格子、格子の外や格子なしは Helmert（数え分ける）。 */
export function tokyoToJGD(p, grid) {
	if (grid) { const q = grid.shift(p); if (q) return q; }
	return tokyoHelmert(p);
}
/** JGD2000 → JGD2011（PatchJGD）。対象域の外は定義上ずれない＝そのまま返す。 */
export function jgd2000To2011(p, patch) {
	if (!patch) return p;
	return patch.shift(p) ?? p;
}

// 3 パラメータ Helmert（測地→地心直交→平行移動→測地）。Bessel 1841 → GRS80。EPSG の Tokyo→WGS84 の値。
const BESSEL = { a: 6377397.155, f: 1 / 299.1528128 }, GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const DX = -146.414, DY = 507.337, DZ = 680.507, D = 180 / Math.PI;
export function tokyoHelmert([lon, lat]) {
	const { a, f } = BESSEL, e2 = f * (2 - f), phi = lat / D, lam = lon / D;
	const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
	const X = N * Math.cos(phi) * Math.cos(lam) + DX, Y = N * Math.cos(phi) * Math.sin(lam) + DY, Z = N * (1 - e2) * Math.sin(phi) + DZ;
	const { a: a2, f: f2 } = GRS80, e22 = f2 * (2 - f2), b2 = a2 * (1 - f2), ep2 = (a2 * a2 - b2 * b2) / (b2 * b2);
	const p = Math.hypot(X, Y), th = Math.atan2(Z * a2, p * b2);   // Bowring
	return [Math.atan2(Y, X) * D, Math.atan2(Z + ep2 * b2 * Math.sin(th) ** 3, p - e22 * a2 * Math.cos(th) ** 3) * D];
}

// ───────────────────────────── 入口が受け取る形 ─────────────────────────────
/** opts.tky2jgd / opts.patchjgd（URL | バイト列 | 読み込み済みの格子）→ { tokyo, patch }。読めなければ警告して null（近似に落ちる）。 */
export async function resolveDatum(opts = {}) {
	const one = async (src, want) => {
		if (!src) return null;
		let g;
		if (typeof src === "object" && typeof src.shift === "function") g = src;
		else { try { g = await loadMeshGrid(src); } catch (e) { console.warn(`[datum] ${want} の格子を読めない＝近似で続行: ${e.message}`); return null; } }
		if (g.transform && g.transform !== want) { console.warn(`[datum] ${want} に ${g.transform} の格子が渡された＝使わない`); return null; }
		return g;
	};
	const [tokyo, patch] = await Promise.all([one(opts.tky2jgd, "tky2jgd"), one(opts.patchjgd, "patchjgd")]);
	return tokyo || patch ? { tokyo, patch } : null;
}
/** stats へ出す形（何点を格子で引けたか）。 */
export function datumStats(datum) {
	if (!datum) return null;
	const out = {};
	if (datum.tokyo) out.tky2jgd = { grid: datum.tokyo.stats.hit, helmert: datum.tokyo.stats.miss };
	if (datum.patch) out.patchjgd = { grid: datum.patch.stats.hit, outside: datum.patch.stats.miss };
	return out;
}
