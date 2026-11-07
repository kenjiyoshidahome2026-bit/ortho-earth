// 錨（anchor）と座標の算術（docs/notes/unity-roundtrip.md §2）。依存ゼロ。
//   ENU＝錨を原点に X=東・Y=北・Z=上（m）。glTF へは (E, U, −N)（右手系 Y-up）。Unity（glTFast）は Z を反転して (E, U, N) にする。
//   行列は glTF と同じ列優先 4x4。
export const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);
const D2R = Math.PI / 180;

/** 経緯度（度）＋楕円体高（m）→ ECEF（m） */
export function lonLatToEcef(lon, lat, h = 0) {
	const la = lat * D2R, lo = lon * D2R, s = Math.sin(la), N = A / Math.sqrt(1 - E2 * s * s);
	return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + h) * s];
}
/** ECEF → [lon, lat, h]（度・度・m） */
export function ecefToLonLat(x, y, z) {
	const lon = Math.atan2(y, x), p = Math.hypot(x, y);
	let lat = Math.atan2(z, p * (1 - E2)), N = A;
	for (let i = 0; i < 8; i++) { const s = Math.sin(lat); N = A / Math.sqrt(1 - E2 * s * s); lat = Math.atan2(z + E2 * N * s, p); }
	const h = p / Math.cos(lat) - N;
	return [lon / D2R, lat / D2R, h];
}

/** 錨：{ lon, lat, height } → 基底（E・N・U の ECEF 単位ベクトル）と変換 */
export function makeAnchor({ lon, lat, height = 0 }) {
	const lo = lon * D2R, la = lat * D2R, sl = Math.sin(lo), cl = Math.cos(lo), sa = Math.sin(la), ca = Math.cos(la);
	const E = [-sl, cl, 0], N = [-sa * cl, -sa * sl, ca], U = [ca * cl, ca * sl, sa];
	const ecef = lonLatToEcef(lon, lat, height);
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const toEnu = p => { const d = [p[0] - ecef[0], p[1] - ecef[1], p[2] - ecef[2]]; return [dot(E, d), dot(N, d), dot(U, d)]; };
	return {
		lon, lat, height, ecef, E, N, U,
		/** ECEF → ENU（m） */
		toEnu,
		/** ECEF → glTF（E, U, −N） */
		toGltf: p => { const [e, n, u] = toEnu(p); return [e, u, -n]; },
		/** 経緯度・楕円体高 → glTF */
		lonLatToGltf: (ln, lt, h = 0) => { const [e, n, u] = toEnu(lonLatToEcef(ln, lt, h)); return [e, u, -n]; },
		/** ENU（m）→ ECEF */
		fromEnu: ([e, n, u]) => [ecef[0] + E[0] * e + N[0] * n + U[0] * u, ecef[1] + E[1] * e + N[1] * n + U[1] * u, ecef[2] + E[2] * e + N[2] * n + U[2] * u],
	};
}

/** ECEF → 錨の glTF 座標（E, U, −N）の 4x4（列優先）＝ gltf = M·[ecef,1] */
export function ecefToGltfMatrix(anchor) {
	const { E, N, U, ecef } = anchor, dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const r0 = E, r1 = U, r2 = [-N[0], -N[1], -N[2]];
	return [
		r0[0], r1[0], r2[0], 0,
		r0[1], r1[1], r2[1], 0,
		r0[2], r1[2], r2[2], 0,
		-dot(r0, ecef), -dot(r1, ecef), -dot(r2, ecef), 1,
	];
}
/** 3D Tiles の glb（Y-up・CESIUM_RTC）→ ECEF の 4x4（列優先）：ecef = rtc + (gx, −gz, gy) */
export function tileGltfToEcefMatrix(rtc = [0, 0, 0]) {
	return [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, rtc[0], rtc[1], rtc[2], 1];
}
/** 列優先 4x4 の積 a·b */
export function mat4Mul(a, b) {
	const o = new Array(16).fill(0);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; }
	return o;
}
/** 列優先 4x4 で点を変換 */
export function mat4Point(m, p) {
	return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
}

// ── Web Mercator のタイル算術（XYZ・256px）──
export const lonToX = (lon, z) => (lon + 180) / 360 * (1 << z);
export const latToY = (lat, z) => { const s = Math.sin(lat * D2R); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * (1 << z); };
export const xToLon = (x, z) => x / (1 << z) * 360 - 180;
export const yToLat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / (1 << z); return Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) / D2R; };
/** bbox（[w,s,e,n] 度）が z で重なるタイルの範囲 { x0, y0, x1, y1 }（両端含む） */
export function tileRange(bbox, z) {
	const m = (1 << z) - 1, cl = v => Math.min(m, Math.max(0, Math.floor(v)));
	return { x0: cl(lonToX(bbox[0], z)), x1: cl(lonToX(bbox[2], z) - 1e-9), y0: cl(latToY(bbox[3], z)), y1: cl(latToY(bbox[1], z) - 1e-9) };
}
