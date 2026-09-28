// 断面とクリッピング平面（#111）の純関数＝レンダラの共有部（shadow.js と同じ置き方・2026-09-29 段 0）。
// 面は単位球ワールド（camera.js lonlatTo3D と同じ軸・β空間）の平面 n·X = c。残すのは n·X − c ≥ 0 の側。
// 精度：面からの距離は「main 原点からの相対位置」で測る＝d = n·rel + K・K = n·originPt − c（CPU f64）。
// 切り口が画面にある時は原点が面の近く＝K は小さい＝f32 に落としても桁落ちしない（影の 0.4m の甘さを持ち込まない）。
// 切らない限りどの関数も呼ばれない＝切っていない描画には一切関与しない。
import { lonlatTo3D, ellNormal3D, worldRadiusM } from "./camera.js";

export const CLIP_MAX = 6;   // 面の枚数の上限（箱＝6 枚・本人裁定）＝WGSL の ClipP と対

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// 鉛直面：2 点 a→b（[lon,lat]）を通り、中点で鉛直（測地法線＝標高の持ち上げと同じ向き）。a→b に向かって右側を残す。
// 戻り＝[nx, ny, nz, c]（n は単位）。a と b が同じ点なら null
export function clipPlaneVertical(a, b) {
	const A = lonlatTo3D(a[0], a[1]), B = lonlatTo3D(b[0], b[1]);
	let dl = b[0] - a[0]; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;   // 日付変更線を跨ぐ 2 点は短い方の中点
	const up = ellNormal3D(a[0] + dl / 2, (a[1] + b[1]) / 2);
	const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
	const n0 = cross(up, ab);   // ワールドの軸（x=経度0・y=北極・z=経度90°）は地理の東北上と逆手＝この順で右側が正
	if (Math.hypot(n0[0], n0[1], n0[2]) < 1e-15) return null;
	const n = norm(n0);
	return [n[0], n[1], n[2], dot(n, A)];
}

// 切り方の記述 → 面の列。spec＝{ planes?: [[nx,ny,nz,c]...], vertical?: [[a, b]...] }（段 0 は鉛直面だけ・段 1 で水平と箱を足す）
export function clipPlanes(spec) {
	const out = [];
	for (const p of spec?.planes || []) if (p && p.length >= 4) out.push([+p[0], +p[1], +p[2], +p[3]]);
	for (const [a, b] of spec?.vertical || []) { const p = clipPlaneVertical(a, b); if (p) out.push(p); }
	return out.slice(0, CLIP_MAX);
}

// 面の uniform（ClipP＝pl[6]・p）＝pl[i]＝(n.xyz, K)・K＝n·originPt − c（f64 で引いてから f32 へ）・p.x＝枚数。
// originPt＝main 原点の単位球点（lonlatTo3D・f64）＝地形と建物メッシュの「原点相対」の基準
export function packClip(planes, originPt, out = new Float32Array(CLIP_MAX * 4 + 4)) {
	out.fill(0);
	const n = Math.min(planes.length, CLIP_MAX);
	for (let i = 0; i < n; i++) {
		const [x, y, z, c] = planes[i];
		out[i * 4] = x; out[i * 4 + 1] = y; out[i * 4 + 2] = z;
		out[i * 4 + 3] = x * originPt[0] + y * originPt[1] + z * originPt[2] - c;
	}
	out[CLIP_MAX * 4] = n;
	return out;
}

// 点 [lon,lat,hM] が残る側か（検定と問い合わせ用）＝面ごとの距離(m) の最小（負＝切られる）
export function clipDistanceM(planes, lon, lat, hM = 0) {
	const Re = worldRadiusM(), u = lonlatTo3D(lon, lat), m = ellNormal3D(lon, lat), k = hM / Re;
	const X = [u[0] + m[0] * k, u[1] + m[1] * k, u[2] + m[2] * k];
	let d = Infinity;
	for (const [x, y, z, c] of planes) d = Math.min(d, (x * X[0] + y * X[1] + z * X[2] - c) * Re);
	return d;
}
