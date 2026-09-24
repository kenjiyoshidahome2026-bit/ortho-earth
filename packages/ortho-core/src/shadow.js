// 建物の影（リアルタイム・shadow map）の純関数＝WebGPU/GL 両レンダラの共有部（2026-09-24）。
// 太陽の方向から建物を正射影で深度テクスチャへ描き、受け手（地形・球の床・塗り・線・建物・メッシュ）の FS が比べる。
// 座標は単位球ワールド（camera.js lonlatTo3D と同じ軸）。行列は列優先（mat.js と同規約）・クリップ z は [0,1]（WebGPU 流。GL は受け手側で同じ z を使う）。
// 影を点けない限りどの関数も呼ばれない＝影なしの描画には一切関与しない。
import { lonlatTo3D, worldRadiusM } from "./camera.js";
import { sunSubpoint } from "@ortho-earth/ephem/sun";

const D2R = Math.PI / 180;

// 太陽の方向（単位ベクトル・ワールド）。t＝ms epoch
export function sunVector(t) {
	const [lng, lat] = sunSubpoint(t);   // ラジアン（renderer の夜面と同じ出所）
	const c = Math.cos(lat);
	return [c * Math.cos(lng), Math.sin(lat), c * Math.sin(lng)];
}

// 影の窓（正射影）を決める。
//   sun＝太陽の方向・center＝[lon,lat]（カメラの注視点）・halfM＝窓の半幅(m)・N＝深度テクスチャの一辺(texel)
// 戻り＝{ mvp(Float64Array 列優先), alt(rad), texelM, zRangeM } または null（太陽が地平線の下）。
// 基底は太陽と地軸だけで決める（注視点に依らない）＝パンで窓の向きが回らない。窓の中心は texel の格子に吸着＝パンで影の縁が揺れない。
export function shadowWindow(sun, center, halfM, N) {
	const Re = worldRadiusM();
	const C = lonlatTo3D(center[0], center[1]);
	const up = norm(C);
	const sinAlt = dot(sun, up);
	if (sinAlt < Math.sin(2 * D2R)) return null;   // 日の出前・日没後（地平線すれすれは影が無限に伸びる）
	const f = [-sun[0], -sun[1], -sun[2]];          // 光の進む向き（太陽→地面）
	let r = cross(f, [0, 1, 0]);
	if (Math.hypot(r[0], r[1], r[2]) < 1e-6) r = cross(f, [1, 0, 0]);   // 太陽が極の真上（実際には来ない）の保険
	r = norm(r);
	const u = cross(r, f);
	const R = halfM / Re;                          // 窓の半幅（単位球）
	const texel = 2 * R / N;
	const cx = Math.round(dot(C, r) / texel) * texel, cy = Math.round(dot(C, u) / texel) * texel;
	// 奥行き：窓の中の地面（±R）と建物・山（上 4000m 程度）が必ず入る幅。正射影なので広くても精度はほぼ落ちない（depth32float）
	const zh = R + 5000 / Re, z0 = dot(C, f) - zh, Z = 2 * zh;
	const m = new Float64Array(16);
	// 行0＝(dot(P,r)−cx)/R・行1＝(dot(P,u)−cy)/R・行2＝(dot(P,f)−z0)/Z・行3＝(0,0,0,1)
	m[0] = r[0] / R; m[4] = r[1] / R; m[8] = r[2] / R; m[12] = -cx / R;
	m[1] = u[0] / R; m[5] = u[1] / R; m[9] = u[2] / R; m[13] = -cy / R;
	m[2] = f[0] / Z; m[6] = f[1] / Z; m[10] = f[2] / Z; m[14] = -z0 / Z;
	m[15] = 1;
	return { mvp: m, alt: Math.asin(sinAlt), texelM: texel * Re, zRangeM: Z * Re, eye: [C[0] + sun[0], C[1] + sun[1], C[2] + sun[2]] };
}

// 窓の半幅(m)＝画面が見ている地面の広さ。1/4 段（2^0.25）に量子化＝小さなズームで窓が伸縮して影の縁が揺れない
export function shadowHalfM(zoom, lat, W, H, dpr) {
	const mpp = 156543.03392 * Math.cos(lat * D2R) / Math.pow(2, zoom);   // CSS px あたり m
	const want = 0.75 * Math.hypot(W, H) / (dpr || 1) * mpp;
	const q = Math.pow(2, Math.round(Math.log2(Math.max(120, Math.min(6000, want))) * 4) / 4);
	return q;
}

// 深度の比較の余白（深度単位）：平らな屋根でも太陽が低いと 1 texel の中で深さが変わる＝その分を見込む
export function shadowBias(win) {
	const slope = Math.min(1 / Math.tan(win.alt), 6);
	return (0.25 + win.texelM * slope * 0.75) / win.zRangeM;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
