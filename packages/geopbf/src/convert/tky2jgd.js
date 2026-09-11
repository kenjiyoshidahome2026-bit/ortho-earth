// convert/tky2jgd.js ── 日本測地系（Tokyo Datum）→ 世界測地系（JGD2000）の変換。依存ゼロ。
//   ・格子（正）: 国土地理院 TKY2JGD.par（3 次メッシュ＝30″×45″ の南西端に dB, dL 秒）を双一次補間して足す＝陸域 10〜20 cm 級。
//     データは scripts/bake-tky2jgd.mjs（bakeTKY2JGD）で 2 次メッシュ単位の Int16 残差に焼き、native-bucket 等から URL で取る（約 0.6 MB gzip）。
//   ・Helmert（内蔵の代替）: EPSG の 3 パラメータ（Tokyo→WGS84: dx −146.414, dy 507.337, dz 680.507・Bessel→GRS80）＝数 m〜10 m 級。格子が無い時・格子の外の点に使う。
//   const grid = await loadTKY2JGD(urlOrBytes);   grid.toJGD([lon, lat]) → [lon, lat] | null（格子外）
//   tokyoToJGD([lon, lat], grid?) → [lon, lat]   格子があれば格子、無ければ/外なら Helmert（grid.stats.fallback に数える）
import { inflate } from "../modules/inflate.js";

const MAGIC = "TKY2JGD1";

/** 焼いた格子を開く。src: URL 文字列 | Uint8Array | ArrayBuffer（gzip は署名で判別して展開）。 */
export async function loadTKY2JGD(src) {
	let u8 = typeof src === "string" ? new Uint8Array(await (await fetchOk(src)).arrayBuffer()) : src instanceof Uint8Array ? src : new Uint8Array(src);
	if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = await inflate(u8, "gzip");
	return parseTKY2JGD(u8);
}
async function fetchOk(url) { const r = await fetch(url); if (!r.ok) throw new Error(`tky2jgd: ${url} → ${r.status}`); return r; }

export function parseTKY2JGD(u8) {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (new TextDecoder().decode(u8.subarray(0, 8)) !== MAGIC) throw new Error("tky2jgd: 形式が違う（TKY2JGD1 でない）");
	const jl = dv.getUint32(8, true), meta = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + jl)));
	const n = dv.getUint32(12 + jl, true), head = 16 + jl, idx = head + n * 12;
	const index = new Map();   // key → n
	for (let i = 0; i < n; i++) index.set(dv.getUint32(head + i * 12, true), i);
	const stats = { grid: 0, fallback: 0 };
	// 3 次メッシュ格子 (latIdx, lonIdx) の南西端の (dB, dL) 秒。無ければ null
	const cell = (latIdx, lonIdx) => {
		const i = index.get(Math.floor(latIdx / 10) * 65536 + Math.floor(lonIdx / 10)); if (i === undefined) return null;
		const k = ((latIdx % 10 + 10) % 10) * 10 + ((lonIdx % 10 + 10) % 10), o = idx + i * 400 + k * 4;
		const rb = dv.getInt16(o, true), rl = dv.getInt16(o + 2, true); if (rb === -32768 || rl === -32768) return null;
		return [(dv.getInt32(head + i * 12 + 4, true) + rb * 100) / 1e5, (dv.getInt32(head + i * 12 + 8, true) + rl * 100) / 1e5];
	};
	const toJGD = ([lon, lat]) => {
		const fx = lon * 80, fy = lat * 120, x0 = Math.floor(fx), y0 = Math.floor(fy), u = fx - x0, v = fy - y0;
		const sw = cell(y0, x0), se = cell(y0, x0 + 1), nw = cell(y0 + 1, x0), ne = cell(y0 + 1, x0 + 1);
		if (!sw || !se || !nw || !ne) return null;
		const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
		const dB = w[0] * sw[0] + w[1] * se[0] + w[2] * nw[0] + w[3] * ne[0], dL = w[0] * sw[1] + w[1] * se[1] + w[2] * nw[1] + w[3] * ne[1];
		return [lon + dL / 3600, lat + dB / 3600];
	};
	return { meta, blocks: n, cell, toJGD, stats };
}

/** Tokyo → JGD。格子があれば格子（外なら Helmert に落ちて数える）、無ければ Helmert。 */
export function tokyoToJGD(p, grid) {
	if (grid) { const q = grid.toJGD(p); if (q) { grid.stats.grid++; return q; } grid.stats.fallback++; }
	return tokyoHelmert(p);
}

// ── 3 パラメータ Helmert（測地→地心直交→平行移動→測地）。Bessel 1841 → GRS80。 ──
const BESSEL = { a: 6377397.155, f: 1 / 299.1528128 }, GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const DX = -146.414, DY = 507.337, DZ = 680.507;
const D = 180 / Math.PI;
export function tokyoHelmert([lon, lat]) {
	const { a, f } = BESSEL, e2 = f * (2 - f), phi = lat / D, lam = lon / D;
	const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
	const X = N * Math.cos(phi) * Math.cos(lam) + DX, Y = N * Math.cos(phi) * Math.sin(lam) + DY, Z = (N * (1 - e2)) * Math.sin(phi) + DZ;
	const { a: a2, f: f2 } = GRS80, e22 = f2 * (2 - f2), b2 = a2 * (1 - f2), ep2 = (a2 * a2 - b2 * b2) / (b2 * b2);
	const p = Math.hypot(X, Y), th = Math.atan2(Z * a2, p * b2);   // Bowring
	const phi2 = Math.atan2(Z + ep2 * b2 * Math.sin(th) ** 3, p - e22 * a2 * Math.cos(th) ** 3);
	return [Math.atan2(Y, X) * D, phi2 * D];
}

// ── 焼き（scripts/bake-tky2jgd.mjs が呼ぶ・検定でも使う）。text = TKY2JGD.par の中身（Shift_JIS 復号済み）。 ──
export function bakeTKY2JGD(text) {
	const lines = text.split(/\r?\n/), version = (lines[0] || "").trim();
	const blocks = new Map(); let cells = 0;
	for (let i = 2; i < lines.length; i++) {
		const p = lines[i].trim().split(/\s+/); if (p.length < 3 || p[0].length !== 8) continue;
		const code = p[0], P = +code.slice(0, 2), U = +code.slice(2, 4), Q = +code[4], V = +code[5], R = +code[6], W = +code[7];
		const latIdx = P * 80 + Q * 10 + R, lonIdx = (U + 100) * 80 + V * 10 + W, key = Math.floor(latIdx / 10) * 65536 + Math.floor(lonIdx / 10);
		let b = blocks.get(key); if (!b) { b = new Array(200).fill(null); blocks.set(key, b); }
		const k = (latIdx % 10) * 10 + (lonIdx % 10); b[k * 2] = Math.round(+p[1] * 1e5); b[k * 2 + 1] = Math.round(+p[2] * 1e5); cells++;
	}
	const keys = [...blocks.keys()].sort((a, b) => a - b);
	const meta = { format: MAGIC, source: "国土地理院 TKY2JGD.par", version, license: "国土地理院コンテンツ利用規約（出典の明示で利用可）", units: { mean: "1e-5 arcsec", cell: "1e-3 arcsec relative to mean", missing: -32768 }, cells, blocks: keys.length, grid: "3rd mesh (30\" x 45\"), value at SW corner, bilinear" };
	const json = new TextEncoder().encode(JSON.stringify(meta));
	const head = 16 + json.length, idx = keys.length * 12;
	const out = new Uint8Array(head + idx + keys.length * 400), dv = new DataView(out.buffer);
	out.set(new TextEncoder().encode(MAGIC), 0); dv.setUint32(8, json.length, true); out.set(json, 12); dv.setUint32(12 + json.length, keys.length, true);
	let maxRes = 0;
	keys.forEach((key, n) => {
		const b = blocks.get(key); let sB = 0, sL = 0, c = 0;
		for (let k = 0; k < 100; k++) if (b[k * 2] !== null) { sB += b[k * 2]; sL += b[k * 2 + 1]; c++; }
		const mB = Math.round(sB / c), mL = Math.round(sL / c);
		dv.setUint32(head + n * 12, key, true); dv.setInt32(head + n * 12 + 4, mB, true); dv.setInt32(head + n * 12 + 8, mL, true);
		for (let k = 0; k < 100; k++) for (let t = 0; t < 2; t++) {
			const v = b[k * 2 + t], o = head + idx + n * 400 + k * 4 + t * 2;
			if (v === null) { dv.setInt16(o, -32768, true); continue; }
			const r = Math.round((v - (t ? mL : mB)) / 100); if (Math.abs(r) > 32767) throw new Error(`tky2jgd: 残差が Int16 を超えた（block ${key}）`);
			maxRes = Math.max(maxRes, Math.abs(r)); dv.setInt16(o, r, true);
		}
	});
	return { bytes: out, meta, maxResidualArcsec: maxRes / 1e3 };
}
