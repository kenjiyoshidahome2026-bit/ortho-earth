// 3D Tiles のタイルの中身を解く（#41・2026-09-23）＝model-worker（kind:"tile3d"）の中で走る。
// 形式：b3dm（glTF＋RTC_CENTER）・i3dm（glTF をインスタンスで並べる）・pnts（点群）・cmpt（束ね）・glb / glTF（3D Tiles 1.1）。
// 置き方は仕様どおり：頂点 ECEF = タイル変換 · (RTC + Y-up→Z-up · glTF のノード変換 · p)。
// 三角形は meshdecode の decodeModel（PLATEAU・模型と同じ後段＝テクスチャ/マテリアル/両面）へ、点は経緯度に直して
// 点のオーバーレイ（gadgets/points-gl.js・原点相対）の形で返す。高さは接地しない＝絶対高さ（楕円体高）−baseH をそのまま持つ。
import { decodeModel, ecef2geo } from "./meshdecode.js";

const EARTH_M = 6371000;
const td = new TextDecoder();
const magicOf = (ab, off = 0) => td.decode(new Uint8Array(ab, off, 4));
const jsonAt = (ab, off, len) => len ? JSON.parse(td.decode(new Uint8Array(ab, off, len)).replace(/\0+$/, "").trim() || "{}") : {};

// 列優先 4x4（3D Tiles の transform）→ { L:列優先 3x3, t }
const splitM4 = m => ({ L: Float64Array.of(m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]), t: [m[12], m[13], m[14]] });
const mulL = (L, v) => [L[0] * v[0] + L[3] * v[1] + L[6] * v[2], L[1] * v[0] + L[4] * v[1] + L[7] * v[2], L[2] * v[0] + L[5] * v[1] + L[8] * v[2]];
const m3mul = (a, b) => { const o = new Float64Array(9); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c*3+r] = a[r]*b[c*3] + a[3+r]*b[c*3+1] + a[6+r]*b[c*3+2]; return o; };
const apply = (M, v) => { const p = mulL(M.L, v); return [p[0] + M.t[0], p[1] + M.t[1], p[2] + M.t[2]]; };

// 特徴表（feature table）の値＝JSON の直値か、バイナリへの { byteOffset }（componentType は仕様の既定）
const ftValue = (ftJ, ftBin, key, n, Type = Float32Array, comps = 3) => {
	const v = ftJ[key];
	if (v == null) return null;
	if (Array.isArray(v) || typeof v !== "object") return v;
	const T = v.componentType ? ({ BYTE: Int8Array, UNSIGNED_BYTE: Uint8Array, SHORT: Int16Array, UNSIGNED_SHORT: Uint16Array, INT: Int32Array, UNSIGNED_INT: Uint32Array, FLOAT: Float32Array, DOUBLE: Float64Array })[v.componentType] || Type : Type;
	const off = ftBin.byteOffset + (v.byteOffset || 0);
	if (off % T.BYTES_PER_ELEMENT) return new T(ftBin.buffer.slice(off, off + n * comps * T.BYTES_PER_ELEMENT));   // 整列していない＝写して読む
	return new T(ftBin.buffer, off, n * comps);
};

// 点群（pnts）
function decodePnts(ab, M, baseH) {
	const dv = new DataView(ab), ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true);
	const J = jsonAt(ab, 28, ftJ), bin = new Uint8Array(ab, 28 + ftJ, ftB);
	const n = J.POINTS_LENGTH | 0;
	if (!n) return null;
	const rtc = J.RTC_CENTER || [0, 0, 0];
	let P = ftValue(J, bin, "POSITION", n), qo = null, qs = null;
	if (!P) { P = ftValue(J, bin, "POSITION_QUANTIZED", n, Uint16Array); qo = J.QUANTIZED_VOLUME_OFFSET; qs = J.QUANTIZED_VOLUME_SCALE; }
	if (!P) return null;
	const RGBA = ftValue(J, bin, "RGBA", n, Uint8Array, 4), RGB = RGBA ? null : ftValue(J, bin, "RGB", n, Uint8Array, 3), R565 = RGBA || RGB ? null : ftValue(J, bin, "RGB565", n, Uint16Array, 1);
	const K = J.CONSTANT_RGBA || [221, 221, 221, 255];
	const geo = new Float64Array(n * 3), rgba = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		let x = P[i*3], y = P[i*3+1], z = P[i*3+2];
		if (qo) { x = qo[0] + x / 65535 * qs[0]; y = qo[1] + y / 65535 * qs[1]; z = qo[2] + z / 65535 * qs[2]; }
		const e = apply(M, [x + rtc[0], y + rtc[1], z + rtc[2]]), g = ecef2geo(e[0], e[1], e[2]);
		geo[i*3] = g[0]; geo[i*3+1] = g[1]; geo[i*3+2] = g[2];
		if (RGBA) { rgba[i*4] = RGBA[i*4]; rgba[i*4+1] = RGBA[i*4+1]; rgba[i*4+2] = RGBA[i*4+2]; rgba[i*4+3] = RGBA[i*4+3]; }
		else if (RGB) { rgba[i*4] = RGB[i*3]; rgba[i*4+1] = RGB[i*3+1]; rgba[i*4+2] = RGB[i*3+2]; rgba[i*4+3] = 255; }
		else if (R565) { const c = R565[i]; rgba[i*4] = ((c >> 11) & 31) * 255 / 31; rgba[i*4+1] = ((c >> 5) & 63) * 255 / 63; rgba[i*4+2] = (c & 31) * 255 / 31; rgba[i*4+3] = 255; }
		else { rgba[i*4] = K[0]; rgba[i*4+1] = K[1]; rgba[i*4+2] = K[2]; rgba[i*4+3] = K[3] ?? 255; }
	}
	return pointsOut({ geo, rgba }, baseH);
}

// 点（経緯度 rad・楕円体高）→ 単位球の原点相対 float32（points-gl の layer に渡す形）
function pointsOut(p, baseH) {
	const geo = p.geo instanceof Float64Array ? p.geo : Float64Array.from(p.geo), n = geo.length / 3;
	if (!n) return null;
	const w = new Float64Array(n * 3);
	let ox = 0, oy = 0, oz = 0;
	for (let i = 0; i < n; i++) {
		const lon = geo[i*3], lat = geo[i*3+1], r = 1 + (geo[i*3+2] - baseH) / EARTH_M, cb = Math.cos(lat);
		w[i*3] = cb * Math.cos(lon) * r; w[i*3+1] = Math.sin(lat) * r; w[i*3+2] = cb * Math.sin(lon) * r;
		ox += w[i*3]; oy += w[i*3+1]; oz += w[i*3+2];
	}
	const origin = [ox / n, oy / n, oz / n], pos = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) { pos[i*3] = w[i*3] - origin[0]; pos[i*3+1] = w[i*3+1] - origin[1]; pos[i*3+2] = w[i*3+2] - origin[2]; }
	return { pos, origin, rgba: p.rgba instanceof Uint8Array ? p.rgba : Uint8Array.from(p.rgba), n };
}

// ECEF の点の東・北・上（列優先 3x3）
const enuAt = e => {
	const g = ecef2geo(e[0], e[1], e[2]), sl = Math.sin(g[0]), cl = Math.cos(g[0]), sp = Math.sin(g[1]), cp = Math.cos(g[1]);
	return Float64Array.of(-sl, cl, 0, -sp * cl, -sp * sl, cp, cp * cl, cp * sl, sp);
};

// インスタンス（i3dm）＝glTF をインスタンスの数だけ置く（置き方の列を decodeModel へ）
async function decodeI3dm(ab, M, opts, maxInstances) {
	const dv = new DataView(ab), ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true), fmt = dv.getUint32(28, true);
	const J = jsonAt(ab, 32, ftJ), bin = new Uint8Array(ab, 32 + ftJ, ftB);
	const n = Math.min(J.INSTANCES_LENGTH | 0, maxInstances);
	if (!n) return null;
	const rtc = J.RTC_CENTER || [0, 0, 0];
	let P = ftValue(J, bin, "POSITION", n), qo = null, qs = null;
	if (!P) { P = ftValue(J, bin, "POSITION_QUANTIZED", n, Uint16Array); qo = J.QUANTIZED_VOLUME_OFFSET; qs = J.QUANTIZED_VOLUME_SCALE; }
	if (!P) return null;
	const UP = ftValue(J, bin, "NORMAL_UP", n), RIGHT = ftValue(J, bin, "NORMAL_RIGHT", n), S = ftValue(J, bin, "SCALE", n, Float32Array, 1), SN = ftValue(J, bin, "SCALE_NON_UNIFORM", n);
	const places = [];
	for (let i = 0; i < n; i++) {
		let x = P[i*3], y = P[i*3+1], z = P[i*3+2];
		if (qo) { x = qo[0] + x / 65535 * qs[0]; y = qo[1] + y / 65535 * qs[1]; z = qo[2] + z / 65535 * qs[2]; }
		const e = apply(M, [x + rtc[0], y + rtc[1], z + rtc[2]]);
		let R;   // インスタンスの向き（列＝右・上・前）
		if (UP && RIGHT) { const u = [UP[i*3], UP[i*3+1], UP[i*3+2]], r = [RIGHT[i*3], RIGHT[i*3+1], RIGHT[i*3+2]], f = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]]; R = m3mul(M.L, Float64Array.of(...r, ...u, ...f)); }
		else if (J.EAST_NORTH_UP) R = enuAt(e);
		else R = Float64Array.from(M.L);
		const sx = SN ? SN[i*3] : S ? S[i] : 1, sy = SN ? SN[i*3+1] : S ? S[i] : 1, sz = SN ? SN[i*3+2] : S ? S[i] : 1;
		places.push({ L: m3mul(R, Float64Array.of(sx, 0, 0, 0, sy, 0, 0, 0, sz)), t: e });
	}
	let glb;
	if (fmt === 1) glb = ab.slice(32 + ftJ + ftB + btJ + btB);
	else { const uri = td.decode(new Uint8Array(ab, 32 + ftJ + ftB + btJ + btB)).replace(/\0+$/, "").trim(); const r = await fetch(new URL(uri, opts.baseUri).href, { credentials: "omit" }); if (!r.ok) throw new Error(`i3dm glTF HTTP ${r.status}`); glb = await r.arrayBuffer(); }
	return decodeModel(glb, { baseUri: opts.baseUri, textures: opts.textures, ...opts.gOpt, tile: { places, rtc: [0, 0, 0], baseH: opts.baseH, points: true } });
}

// 中身一つ → { batches, points, stats }（null＝描く物なし）
// ground＝"terrain"：三角形は PLATEAU と同じ「連結成分ごとに最低点で接地」（呼び手は地形へ持ち上げて置く）＝建物の tileset 向け。既定＝絶対高さ（写真測量の街並み・点群）
export async function decodeTile3D(ab, { transform, baseUri, baseH = 0, textures = true, maxInstances = 5000, ground = "absolute" } = {}) {
	const M = splitM4(transform || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	const out = { batches: [], points: [], stats: { triangles: 0, points: 0 } };
	const gOpt = ground === "terrain" ? { ground: "each" } : {}, bH = ground === "terrain" ? null : baseH;   // 接地＝baseH を渡さない（decodeModel が成分ごとの最低点を使う）
	const merge = r => {
		if (!r) return;
		if (r.batches?.length) { out.batches.push(...r.batches); out.stats.triangles += r.stats?.triangles || 0; }
		const p = r.points && !r.points.pos ? pointsOut(r.points, baseH) : r.points;   // decodeModel の点（経緯度）は形を揃える
		if (p) { out.points.push(p); out.stats.points += p.n; }
		if (r.pos && r.n) { out.points.push(r); out.stats.points += r.n; }
	};
	const one = async (buf) => {
		const magic = magicOf(buf);
		if (magic === "b3dm") {
			const dv = new DataView(buf), ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true);
			const J = jsonAt(buf, 28, ftJ);
			const glb = buf.slice(28 + ftJ + ftB + btJ + btB);
			merge(await decodeModel(glb, { baseUri, textures, ...gOpt, tile: { places: [M], rtc: J.RTC_CENTER || null, baseH: bH, points: true } }));
		} else if (magic === "i3dm") merge(await decodeI3dm(buf, M, { baseUri, textures, baseH }, maxInstances));
		else if (magic === "pnts") merge(decodePnts(buf, M, baseH));
		else if (magic === "cmpt") {
			const dv = new DataView(buf), nT = dv.getUint32(12, true);
			let off = 16;
			for (let k = 0; k < nT && off + 12 <= buf.byteLength; k++) { const len = new DataView(buf, off).getUint32(8, true); await one(buf.slice(off, off + len)); off += len; }
		} else if (magic === "glTF" || new Uint8Array(buf, 0, 1)[0] === 0x7b) merge(await decodeModel(buf, { baseUri, textures, ...gOpt, tile: { places: [M], rtc: null, baseH: bH, points: true } }));   // glb / glTF(JSON)＝3D Tiles 1.1
		else throw new Error(`unknown tile content "${magic}"`);
	};
	await one(ab);
	return out.batches.length || out.points.length ? out : null;
}
