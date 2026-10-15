// Gaussian splat の読み手と、描く前の下ごしらえ（純関数・main で動く・node で検定できる）。@ortho-earth/plugin-splat。
//   読み手（.ply／.splat／.spz）は file の局所座標の SplatData（crs "local"・単位 m・軸は file の約束＝axes）を返す。
//   下ごしらえ（toEnu）は SplatData（lnglat／ecef／local）を「錨（経度・緯度・高さ）＋東北上 m の中心＋東北上の共分散（6 個）＋RGBA」にする＝worker はこれだけ描く。
// 四元数は x,y,z,w（契約＝globe の SplatData）。scales は楕円の各軸の σ（m・線形）。colors の A は不透明度。sh は持つが描かない（DC＝colors だけ）。
export const SH_C0 = 0.28209479177387814;
const sigmoid = x => 1 / (1 + Math.exp(-x));
const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));

// ---- .ply（3D Gaussian Splatting の書き出し＝binary_little_endian・x y z・f_dc_0..2・opacity（logit）・scale_0..2（log）・rot_0..3（w x y z）・f_rest_*） ----
const PLY_TYPES = { char: ["getInt8", 1], int8: ["getInt8", 1], uchar: ["getUint8", 1], uint8: ["getUint8", 1], short: ["getInt16", 2], int16: ["getInt16", 2], ushort: ["getUint16", 2], uint16: ["getUint16", 2], int: ["getInt32", 4], int32: ["getInt32", 4], uint: ["getUint32", 4], uint32: ["getUint32", 4], float: ["getFloat32", 4], float32: ["getFloat32", 4], double: ["getFloat64", 8], float64: ["getFloat64", 8] };
export function parsePly(buf) {
	const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 65536)));
	const end = head.indexOf("end_header");
	if (!head.startsWith("ply") || end < 0) throw new Error("plugin-splat: not a PLY file");
	const lines = head.slice(0, end).split(/\r?\n/), body = end + "end_header".length + (head[end + 10] === "\r" ? 2 : 1);
	if (!lines.some(l => /^format\s+binary_little_endian\b/.test(l))) throw new Error("plugin-splat: only binary_little_endian PLY is supported");
	const elements = []; let el = null;
	for (const l of lines) {
		const w = l.trim().split(/\s+/);
		if (w[0] === "element") elements.push(el = { name: w[1], count: +w[2], props: [] });
		else if (w[0] === "property" && el) { if (w[1] === "list") throw new Error("plugin-splat: PLY list properties are not supported"); const t = PLY_TYPES[w[1]]; if (!t) throw new Error(`plugin-splat: PLY type ${w[1]}`); el.props.push({ name: w[2], get: t[0], size: t[1] }); }
	}
	let off = body;
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	for (const e of elements) {
		const stride = e.props.reduce((s, p) => s + p.size, 0);
		if (e.name !== "vertex") { off += stride * e.count; continue; }
		const n = e.count, at = {}; let o = 0;
		for (const p of e.props) { at[p.name] = { o, get: p.get }; o += p.size; }
		if (!at.x || !at.y || !at.z) throw new Error("plugin-splat: PLY vertex needs x y z");
		if (off + stride * n > u8.length) throw new Error("plugin-splat: PLY is truncated");
		const rd = (i, name, d = 0) => { const a = at[name]; return a ? dv[a.get](off + i * stride + a.o, true) : d; };
		const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4);
		const gs = !!at.scale_0, hasRot = !!at.rot_0, dc = !!at.f_dc_0, rgb = !!at.red;
		const rest = Object.keys(at).filter(k => /^f_rest_\d+$/.test(k)).sort((a, b) => +a.slice(7) - +b.slice(7));
		const sh = rest.length ? new Float32Array(n * rest.length) : null;
		for (let i = 0; i < n; i++) {
			positions[i * 3] = rd(i, "x"); positions[i * 3 + 1] = rd(i, "y"); positions[i * 3 + 2] = rd(i, "z");
			if (gs) for (let k = 0; k < 3; k++) scales[i * 3 + k] = Math.exp(rd(i, "scale_" + k));
			else scales.fill(0.01, i * 3, i * 3 + 3);   // 点群の PLY＝小さな丸
			let qw = 1, qx = 0, qy = 0, qz = 0;
			if (hasRot) { qw = rd(i, "rot_0"); qx = rd(i, "rot_1"); qy = rd(i, "rot_2"); qz = rd(i, "rot_3"); }
			const ql = Math.hypot(qx, qy, qz, qw) || 1; rotations.set([qx / ql, qy / ql, qz / ql, qw / ql], i * 4);
			if (dc) for (let k = 0; k < 3; k++) colors[i * 4 + k] = clamp255((0.5 + SH_C0 * rd(i, "f_dc_" + k)) * 255);
			else if (rgb) { colors[i * 4] = rd(i, "red"); colors[i * 4 + 1] = rd(i, "green"); colors[i * 4 + 2] = rd(i, "blue"); }
			else colors.fill(200, i * 4, i * 4 + 3);
			colors[i * 4 + 3] = at.opacity ? clamp255(sigmoid(rd(i, "opacity")) * 255) : at.alpha ? rd(i, "alpha") : 255;
			if (sh) for (let k = 0; k < rest.length; k++) sh[i * rest.length + k] = rd(i, rest[k]);
		}
		return { n, crs: "local", axes: "-y", positions, scales, rotations, colors, ...(sh ? { sh } : {}) };
	}
	throw new Error("plugin-splat: PLY has no vertex element");
}

// ---- .splat（32 byte／個＝位置 f32×3・尺 f32×3（線形）・RGBA u8×4・回転 u8×4（w x y z を (v−128)/128）） ----
export function parseSplat(buf) {
	const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	if (u8.length % 32) throw new Error("plugin-splat: .splat length must be a multiple of 32");
	const n = u8.length / 32, dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		const b = i * 32;
		for (let k = 0; k < 3; k++) { positions[i * 3 + k] = dv.getFloat32(b + k * 4, true); scales[i * 3 + k] = dv.getFloat32(b + 12 + k * 4, true); }
		colors.set(u8.subarray(b + 24, b + 28), i * 4);
		const w = (u8[b + 28] - 128) / 128, x = (u8[b + 29] - 128) / 128, y = (u8[b + 30] - 128) / 128, z = (u8[b + 31] - 128) / 128, l = Math.hypot(x, y, z, w) || 1;
		rotations.set([x / l, y / l, z / l, w / l], i * 4);
	}
	return { n, crs: "local", axes: "-y", positions, scales, rotations, colors };
}

// ---- .spz（Niantic の gzip 圧縮の形・v2／v3）＝gzip は素の DecompressionStream で解く（WASM は要らない）。軸は RUB（右・上・後）＝axes "y" ----
export async function gunzip(buf) {
	const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	if (u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;   // 既に解いた中身
	if (typeof DecompressionStream === "undefined") throw new Error("plugin-splat: DecompressionStream is not available; pass splatPlugin({ decoders: { spz } })");
	const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function parseSpz(buf) { return decodeSpz(await gunzip(buf)); }
export function decodeSpz(u8) {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (u8.length < 16 || dv.getUint32(0, true) !== 0x5053474e) throw new Error("plugin-splat: not an SPZ file (magic)");
	const version = dv.getUint32(4, true), n = dv.getUint32(8, true), shDeg = u8[12], frac = u8[13];
	if (version < 2 || version > 3) throw new Error(`plugin-splat: SPZ version ${version} is not supported (2 and 3 are)`);
	if (shDeg > 3) throw new Error(`plugin-splat: SPZ sh degree ${shDeg}`);
	const shN = [0, 3, 8, 15][shDeg] * 3, rotB = version >= 3 ? 4 : 3;
	const need = 16 + n * (9 + 1 + 3 + 3 + rotB + shN);
	if (u8.length < need) throw new Error("plugin-splat: SPZ is truncated");
	let o = 16;
	const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4), sh = shN ? new Float32Array(n * shN) : null;
	const fs = 1 / (1 << frac);
	for (let i = 0; i < n * 3; i++, o += 3) { let v = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16); if (v & 0x800000) v |= ~0xffffff; positions[i] = v * fs; }
	for (let i = 0; i < n; i++, o++) colors[i * 4 + 3] = u8[o];
	for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++, o++) colors[i * 4 + k] = clamp255((0.5 + SH_C0 * ((u8[o] / 255 - 0.5) / 0.15)) * 255);
	for (let i = 0; i < n * 3; i++, o++) scales[i] = Math.exp(u8[o] / 16 - 10);
	for (let i = 0; i < n; i++) {
		let q = [0, 0, 0, 0];
		if (version >= 3) {   // 最大成分を落とした 3 成分（各 9 bit＋符号）＋最大成分の番号 2 bit
			let c = dv.getUint32(o, true); o += 4;
			const big = c >>> 30; let ss = 0;
			for (let k = 3; k >= 0; k--) { if (k === big) continue; const mag = c & 511, neg = (c >>> 9) & 1; c >>>= 10; const v = Math.SQRT1_2 * mag / 511; q[k] = neg ? -v : v; ss += v * v; }
			q[big] = Math.sqrt(Math.max(0, 1 - ss));
		} else {
			const x = u8[o] / 127.5 - 1, y = u8[o + 1] / 127.5 - 1, z = u8[o + 2] / 127.5 - 1; o += 3;
			q = [x, y, z, Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z))];
		}
		const l = Math.hypot(...q) || 1; rotations.set(q.map(v => v / l), i * 4);
	}
	if (sh) for (let i = 0; i < n * shN; i++, o++) sh[i] = (u8[o] - 128) / 128;
	return { n, crs: "local", axes: "y", positions, scales, rotations, colors, ...(sh ? { sh } : {}) };
}
export const formatOf = u => { const m = String(u).match(/\.(ply|splat|spz)(\?|#|$)/i); return m ? m[1].toLowerCase() : null; };

// ---- 下ごしらえ ----
const R_SPHERE = 6371000, WGS_A = 6378137, WGS_E2 = 6.69437999014e-3;
const D2R = Math.PI / 180;
// 四元数（x,y,z,w）→ 3×3（行優先）
export function quatMat(x, y, z, w) {
	return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
		2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
		2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
}
const mul3 = (A, B) => { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; };
// file の軸 → 東北上（x 東 y 北 z 上）。"z"＝そのまま、"y"＝y が上・z が後（RUB）、"-y"＝y が下・z が前（RDF＝3DGS の .ply／.splat）
export const AXES = Object.freeze({ z: [1, 0, 0, 0, 1, 0, 0, 0, 1], y: [1, 0, 0, 0, 0, -1, 0, 1, 0], "-y": [1, 0, 0, 0, 0, 1, 0, -1, 0] });
// heading（北から時計回り）・pitch・roll（度）×大きさ＝東北上の中の向き
export function placeMat(axes = "z", [hd = 0, pt = 0, rl = 0] = [], scale = 1) {
	const A = AXES[axes]; if (!A) throw new Error(`plugin-splat: upAxis must be ${Object.keys(AXES).join(" | ")}`);
	const h = -hd * D2R, p = pt * D2R, r = rl * D2R;
	const Rz = [Math.cos(h), -Math.sin(h), 0, Math.sin(h), Math.cos(h), 0, 0, 0, 1], Rx = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)], Ry = [Math.cos(r), 0, Math.sin(r), 0, 1, 0, -Math.sin(r), 0, Math.cos(r)];
	return mul3(mul3(mul3(Rz, Rx), Ry), A).map(v => v * scale);
}
// 共分散（6 個＝xx xy xz yy yz zz）＝(T·R·S)(T·R·S)ᵀ
function covOf(T, q, s, out, k) {
	const R = quatMat(q[0], q[1], q[2], q[3]), M = mul3(T, R);
	for (let c = 0; c < 3; c++) { M[c] *= s[c]; M[3 + c] *= s[c]; M[6 + c] *= s[c]; }
	const d = (a, b) => M[a * 3] * M[b * 3] + M[a * 3 + 1] * M[b * 3 + 1] + M[a * 3 + 2] * M[b * 3 + 2];
	out[k] = d(0, 0); out[k + 1] = d(0, 1); out[k + 2] = d(0, 2); out[k + 3] = d(1, 1); out[k + 4] = d(1, 2); out[k + 5] = d(2, 2);
}
const enuBasis = (lon, lat) => { const l = lon * D2R, f = lat * D2R, sl = Math.sin(l), cl = Math.cos(l), sf = Math.sin(f), cf = Math.cos(f); return [-sl, cl, 0, -sf * cl, -sf * sl, cf, cf * cl, cf * sl, sf]; };   // 行＝東・北・上（ECEF）
export function ecefToLngLat(x, y, z) {
	const lon = Math.atan2(y, x), p = Math.hypot(x, y); let lat = Math.atan2(z, p * (1 - WGS_E2)), h = 0;
	for (let i = 0; i < 6; i++) { const s = Math.sin(lat), N = WGS_A / Math.sqrt(1 - WGS_E2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - WGS_E2 * N / (N + h))); }
	return [lon / D2R, lat / D2R, h];
}
// SplatData（lnglat／ecef／local）→ { n, anchor:[lng,lat,alt], ctr: Float32Array(n*3)（東北上 m）, cov: Float32Array(n*6)（東北上 m²）, rgba, radius（m） }
//   local＝origin（[lng,lat,alt]）・upAxis（既定は file の axes）・orientation（[heading,pitch,roll] 度）・scale で置く。lnglat の回転は東北上の中の向き、ecef の回転は地心直交の中の向き
export function toEnu(d, { origin, upAxis, orientation, scale = 1, opacity = 1 } = {}) {
	const n = d.n, P = d.positions, ctr = new Float32Array(n * 3), cov = new Float32Array(n * 6);
	let anchor, T;
	if (d.crs === "local") {
		if (!origin || !Number.isFinite(+origin[0]) || !Number.isFinite(+origin[1])) throw new Error("plugin-splat: a .ply/.splat/.spz source needs opts.origin [lng, lat, alt?]");
		anchor = [+origin[0], +origin[1], +origin[2] || 0]; T = placeMat(upAxis ?? d.axes ?? "z", orientation, scale);
		for (let i = 0; i < n; i++) { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; ctr[i * 3] = T[0] * x + T[1] * y + T[2] * z; ctr[i * 3 + 1] = T[3] * x + T[4] * y + T[5] * z; ctr[i * 3 + 2] = T[6] * x + T[7] * y + T[8] * z; }
	} else if (d.crs === "ecef") {
		let sx = 0, sy = 0, sz = 0; for (let i = 0; i < n; i++) { sx += P[i * 3]; sy += P[i * 3 + 1]; sz += P[i * 3 + 2]; }
		const a = n ? [sx / n, sy / n, sz / n] : [WGS_A, 0, 0]; anchor = ecefToLngLat(a[0], a[1], a[2]); T = enuBasis(anchor[0], anchor[1]);
		for (let i = 0; i < n; i++) { const x = P[i * 3] - a[0], y = P[i * 3 + 1] - a[1], z = P[i * 3 + 2] - a[2]; ctr[i * 3] = T[0] * x + T[1] * y + T[2] * z; ctr[i * 3 + 1] = T[3] * x + T[4] * y + T[5] * z; ctr[i * 3 + 2] = T[6] * x + T[7] * y + T[8] * z; }
	} else {
		let sl = 0, sb = 0, sh = 0; for (let i = 0; i < n; i++) { sl += P[i * 3]; sb += P[i * 3 + 1]; sh += P[i * 3 + 2]; }
		anchor = n ? [sl / n, sb / n, sh / n] : [0, 0, 0]; T = [1, 0, 0, 0, 1, 0, 0, 0, 1];
		const ce = Math.cos(anchor[1] * D2R) * D2R * R_SPHERE, cn = D2R * R_SPHERE;
		for (let i = 0; i < n; i++) { const e = (P[i * 3] - anchor[0]) * ce, nn = (P[i * 3 + 1] - anchor[1]) * cn; ctr[i * 3] = e; ctr[i * 3 + 1] = nn; ctr[i * 3 + 2] = P[i * 3 + 2] - anchor[2] - (e * e + nn * nn) / (2 * R_SPHERE); }   // 丸みの落ち込みも入れる
	}
	const S = d.scales, Q = d.rotations, s = [0, 0, 0], q = [0, 0, 0, 1];
	let r2 = 0;
	for (let i = 0; i < n; i++) {
		s[0] = S[i * 3]; s[1] = S[i * 3 + 1]; s[2] = S[i * 3 + 2]; q[0] = Q[i * 4]; q[1] = Q[i * 4 + 1]; q[2] = Q[i * 4 + 2]; q[3] = Q[i * 4 + 3];
		covOf(T, q, s, cov, i * 6);
		r2 = Math.max(r2, ctr[i * 3] ** 2 + ctr[i * 3 + 1] ** 2 + ctr[i * 3 + 2] ** 2);
	}
	let rgba = d.colors;
	if (opacity !== 1) { rgba = rgba.slice(); for (let i = 3; i < rgba.length; i += 4) rgba[i] = clamp255(rgba[i] * opacity); }
	return { n, anchor, ctr, cov, rgba, radius: Math.sqrt(r2) };
}
// 中心の経緯度（当たりの答え用・近似＝錨の東北上から）
export function enuToLngLat(anchor, e, n) { return [anchor[0] + e / (Math.cos(anchor[1] * D2R) * D2R * R_SPHERE), anchor[1] + n / (D2R * R_SPHERE)]; }
