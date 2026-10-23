// 解析（2026-10-24・WebGPU 専用）＝日影時間と可視域を、描いている物（基図の押し出し・建物メッシュ・3D Tiles・模型・地形）から GPU で測る。
//   日影時間＝時刻ごとに太陽の正射影で落とす側の深度を描き（影のパスの使い回し＝renderer.ts encodeShadowCasters）、
//     測定面の升目を同じ窓へ投げて深さを比べ、影なら 1 足す（compute）。
//   可視域＝真上からの正射影で地表（地形＋屋根）の高さを升目に取り（compute）、視点から縦横の縁の升目へ光線を歩いて見える升目に印（compute・
//     CPU 版 sunshadow.ts の ray() と同じ式＝地球の丸みと屈折の下がり込み）。
//   ここは WGSL と升目の位置の純関数だけ。資源・パス・読み戻しの段取りは renderer.ts の analysis（レンダラの中身＝落とす側のパイプラインを使うため）。
import { lonlatTo3D, ellNormal3D, ellipsoidOn, worldRadiusM } from "../camera.ts";

/** レンダラの解析の口（renderer.analysis・WebGPU だけ）。升目は bbox＝[w,s,e,n] を W×H（row0＝北・画素の中心）。ground＝升目の地形の高さ m（null＝0） */
export interface RendererAnalysis {
	/** 日影時間：suns＝時刻ごとの太陽の方向（単位球ワールド・日の出ている物だけ）・planeH＝測定面の高さ m（地形の上）。cnt＝升目ごとに影だった回数・used＝数えた時刻の数・tris＝落とした三角形（最後の時刻） */
	sunHours(o: { bbox: readonly number[]; W: number; H: number; ground: ArrayLike<number> | null; planeH: number; suns: ArrayLike<number>[] }): Promise<{ cnt: Uint32Array; used: number; tris: number; texelM: number; exag: number }>;
	/** 地表（地形＋屋根・N×N・本当の m＝地形の誇張は外す）＝真上からの深度 */
	surface(o: { bbox: readonly number[]; N: number; ground: ArrayLike<number> | null }): Promise<{ S: Float32Array; tris: number }>;
	/** 可視域：地表を取って視点（升目 ox/oy）から縦横の縁へ光線を歩く。cellX/cellY＝升目の一辺 m・rCells＝半径（升目）・dropK＝(1−k)/(2R)・eyeH/targetH＝m */
	viewshed(o: { bbox: readonly number[]; N: number; ground: ArrayLike<number> | null; ox: number; oy: number; rCells: number; cellX: number; cellY: number; dropK: number; eyeH: number; targetH: number }): Promise<{ vis: Uint32Array; S: Float32Array; tris: number }>;
}

/** 日影の数え（時刻 1 つ分）。U.q＝(余白[深度], 升目の数, 0, 0)・pos＝升目の位置（錨からの相対・単位球・測定面の高さに置いた物） */
export const SUN_COUNT_WGSL = /* wgsl */`
struct AP { mvp: mat4x4f, clipT: vec4f, q: vec4f };
@group(0) @binding(0) var<uniform> U: AP;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read> pos: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> cnt: array<u32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x;
	if (i >= u32(U.q.y)) { return; }
	let c = U.clipT + U.mvp * vec4f(pos[i].xyz, 0.0);
	let uv = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
	if (uv.x < 0.0 || uv.x >= 1.0 || uv.y < 0.0 || uv.y >= 1.0 || c.z <= 0.0 || c.z >= 1.0) { return; }
	let dim = vec2f(textureDimensions(depth));
	let z = textureLoad(depth, vec2i(uv * dim), 0);
	if (z < c.z - U.q.x) { cnt[i] = cnt[i] + 1u; }
}`;

/** 地表の高さ取り（真上の窓）。U.q＝(奥行き m, 升目の数, 1/誇張, 0)・pos＝升目の位置（海抜 0・w＝地形の高さ m＝描いた物が無い所の答え）・S＝地表 m（本当の m＝誇張を外す） */
export const SURFACE_WGSL = /* wgsl */`
struct AP { mvp: mat4x4f, clipT: vec4f, q: vec4f };
@group(0) @binding(0) var<uniform> U: AP;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var<storage, read> pos: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> S: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x;
	if (i >= u32(U.q.y)) { return; }
	let c = U.clipT + U.mvp * vec4f(pos[i].xyz, 0.0);
	let uv = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
	var h = pos[i].w;
	if (uv.x >= 0.0 && uv.x < 1.0 && uv.y >= 0.0 && uv.y < 1.0) {
		let dim = vec2f(textureDimensions(depth));
		let z = textureLoad(depth, vec2i(uv * dim), 0);
		if (z < 1.0) { h = max(h, (c.z - z) * U.q.x * U.q.z); }   // 深度が手前（＝高い）＝海抜 0 の点との差を m に（正射影＝深度は線形）・誇張を外す
	}
	S[i] = h;
}`;

/** 可視域の光線歩き（CPU 版 computeViewshed の ray() と同式）。1 スレッド＝縁の升目 1 つへの光線（4N 本）。
 *  U.q0＝(N, ox, oy, rCells)・q1＝(cellX, cellY, dropK＝(1−k)/(2R), eyeH)・q2＝(targetH, 0, 0, 0)。vis＝見える升目に 1（atomicMax＝同じ升目を何本もが踏む） */
export const MARCH_WGSL = /* wgsl */`
struct MP { q0: vec4f, q1: vec4f, q2: vec4f };
@group(0) @binding(0) var<uniform> U: MP;
@group(0) @binding(1) var<storage, read> S: array<f32>;
@group(0) @binding(2) var<storage, read_write> vis: array<atomic<u32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	let N = i32(U.q0.x);
	let r = i32(g.x);
	if (r >= 4 * N) { return; }
	let fN = f32(N);
	var tx = 0.0; var ty = 0.0;
	if (r < N) { tx = f32(r) + 0.5; ty = 0.5; }
	else if (r < 2 * N) { tx = f32(r - N) + 0.5; ty = fN - 0.5; }
	else if (r < 3 * N) { tx = 0.5; ty = f32(r - 2 * N) + 0.5; }
	else { tx = fN - 0.5; ty = f32(r - 3 * N) + 0.5; }
	let ox = U.q0.y; let oy = U.q0.z; let rCells = U.q0.w;
	let cellX = U.q1.x; let cellY = U.q1.y; let dropK = U.q1.z;
	let oi = clamp(i32(oy), 0, N - 1) * N + clamp(i32(ox), 0, N - 1);
	let z0 = S[oi] + U.q1.w;
	let dx = tx - ox; let dy = ty - oy; let L = sqrt(dx * dx + dy * dy);
	if (L < 1e-6) { return; }
	let steps = i32(ceil(L * 2.0));
	let sx = dx / f32(steps); let sy = dy / f32(steps);
	var maxSlope = -1e30;
	for (var k = 1; k <= steps; k++) {
		let x = ox + sx * f32(k); let y = oy + sy * f32(k);
		let ix = i32(x); let iy = i32(y);
		if (ix < 0 || iy < 0 || ix >= N || iy >= N) { break; }
		let ex = (x - ox) * cellX; let ey = (y - oy) * cellY;
		let d = sqrt(ex * ex + ey * ey);
		let i = iy * N + ix;
		let dr = d * d * dropK;
		let s = S[i];
		let tSlope = (s + U.q2.x - dr - z0) / d;
		let seen = tSlope >= maxSlope;
		let gx = x - ox; let gy = y - oy;
		if (seen && sqrt(gx * gx + gy * gy) <= rCells) { atomicMax(&vis[i], 1u); }
		let sSlope = (s - dr - z0) / d;
		if (sSlope > maxSlope) { maxSlope = sSlope; }
	}
}`;

/** 升目の位置（錨からの相対・単位球）＝CPU の f64 で作る（f32 の絶対座標は 0.4m 刻み＝影の texel と同じ桁で揺れる）。
 *  bbox＝[w,s,e,n]・W×H（row0＝北・画素の中心）・ground＝升目の地形の高さ m（null＝0）・hScale＝地形の高さ 1m が単位球でいくら（誇張/半径）・liftM＝全升目に足す高さ m（測定面）
 *  戻り＝vec4 ×（W·H）：xyz＝位置−錨・w＝地形の高さ（本当の m）。持ち上げの向き＝描き手と同じ（球＝動径・楕円体＝測地法線の β 空間像） */
export function cellPositions(bbox: readonly number[], W: number, H: number, ground: ArrayLike<number> | null, hScale: number, liftM: number, anchor: ArrayLike<number>): Float32Array<ArrayBuffer> {
	const [w, s, e, n] = bbox, Re = worldRadiusM(), ell = ellipsoidOn();
	const out = new Float32Array(W * H * 4);
	for (let r = 0; r < H; r++) {
		const lat = n - (r + 0.5) / H * (n - s);
		for (let c = 0; c < W; c++) {
			const lon = w + (c + 0.5) / W * (e - w), i = r * W + c, g = ground ? (ground[i] || 0) : 0;
			const P = lonlatTo3D(lon, lat), lift = g * hScale + liftM / Re;
			let d: number[];
			if (ell) d = ellNormal3D(lon, lat);
			else { const l = Math.hypot(P[0], P[1], P[2]) || 1; d = [P[0] / l, P[1] / l, P[2] / l]; }
			out[i * 4] = P[0] + d[0] * lift - anchor[0]; out[i * 4 + 1] = P[1] + d[1] * lift - anchor[1]; out[i * 4 + 2] = P[2] + d[2] * lift - anchor[2]; out[i * 4 + 3] = g;
		}
	}
	return out;
}

/** 升目の四隅＋中心（高さ h0〜h1 m）＝窓を合わせる点（shadowWindowFit の pts）。角は 2 段の高さで */
export function bboxPoints(bbox: readonly number[], h0: number, h1: number): number[][] {
	const [w, s, e, n] = bbox, Re = worldRadiusM(), out: number[][] = [];
	for (const [lo, la] of [[w, s], [e, s], [w, n], [e, n], [(w + e) / 2, (s + n) / 2]]) {
		const P = lonlatTo3D(lo, la);
		for (const h of [h0, h1]) { const k = 1 + h / Re; out.push([P[0] * k, P[1] * k, P[2] * k]); }
	}
	return out;
}
