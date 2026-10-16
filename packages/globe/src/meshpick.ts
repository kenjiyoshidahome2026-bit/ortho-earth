// 模型・3D Tiles の当たり（第 3 波 W7・2026-10-12）＝画面の点に一番手前で重なる三角形と、その地物の番号（EXT_mesh_features／_BATCHID）。
//   renderer と同じ式で頂点を画面へ写す（RTE の原点＋原点相対の頂点・束の剛体変換 xf（W4）・地形への持ち上げは束の中心で 1 回）＝描いた所に当たる。
//   GPU の番号焼きは使わない（メッシュは core の renderer が描く＝オーバーレイの当たりの道に乗らない）。三角形の数に比例＝クリックの瞬間だけ走らせる。
//   feature state の色（tintColors）＝頂点色を地物ごとに差し替えた列（renderer の "meshCol" で色の頂点バッファだけ書き換える）。
import { NO_FEATURE } from "./mesh-features.ts";
import { betaToLonLat } from "@ortho-earth/core";
import type { LonLat } from "../globe.d.ts";
import type { MeshFeatures } from "./mesh-features.ts";
import type { MeshPickEnv } from "./types/install.ts";

/** 当てる束（原点相対の頂点・xf＝剛体変換（L 9＋xt 3）・lift＝原点の向きへの持ち上げ（世界単位））。_aabb・_up は pickMeshes が書く写し */
export interface PickItem { pos: ArrayLike<number>; idx: ArrayLike<number>; origin: ArrayLike<number>; xf?: ArrayLike<number> | null; lift?: number; features?: Pick<MeshFeatures, "ids"> | null; hidden?: boolean; _aabb?: number[]; _up?: number[] }
/** 一番手前の当たり（item＝束の番号・w＝奥行き（clip の w）・vertex＝一番近い頂点・world＝当たった点の世界座標） */
export interface MeshPickHit { item: number; tri: number; w: number; featureId: number | null; vertex: number; world: number[] }
// 束の局所の箱（原点相対）＝画面で外れる束を素早く捨てる
function aabbOf(item: PickItem): number[] {
	if (item._aabb) return item._aabb;
	const p = item.pos, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v; }
	return (item._aabb = b);
}
// 原点相対の点 → 世界座標（xf＝L 9（列優先）＋xt 3・lift＝原点の向きへの持ち上げ（世界単位））
function worldOf(item: PickItem, i: number, out: number[]): number[] {
	const p = item.pos, x = p[i*3], y = p[i*3+1], z = p[i*3+2], xf = item.xf, o = item.origin, L = item.lift || 0, u = item._up!;
	let ax = x, ay = y, az = z;
	if (xf) { ax = xf[0]*x + xf[3]*y + xf[6]*z + xf[9]; ay = xf[1]*x + xf[4]*y + xf[7]*z + xf[10]; az = xf[2]*x + xf[5]*y + xf[8]*z + xf[11]; }
	out[0] = o[0] + ax + L * u[0]; out[1] = o[1] + ay + L * u[1]; out[2] = o[2] + az + L * u[2];
	return out;
}
const clip = (M: ArrayLike<number>, p: ArrayLike<number>) => [M[0]*p[0] + M[4]*p[1] + M[8]*p[2] + M[12], M[1]*p[0] + M[5]*p[1] + M[9]*p[2] + M[13], M[3]*p[0] + M[7]*p[1] + M[11]*p[2] + M[15]];
// items＝[{ pos, idx, origin, xf?, lift?, features?: { ids }, two? }]・view＝{ mvp, W, H, eye }（CSS px）・(x, y)＝CSS px
// → { item（番号）, tri, w（奥行き＝clip の w）, featureId（無し＝null）, world: [x,y,z] } | null
export function pickMeshes(items: Array<PickItem | null>, view: MeshPickEnv["view"], x: number, y: number): MeshPickHit | null {
	const { mvp: M, W, H, eye: E } = view;
	let best: MeshPickHit | null = null;
	const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
	const scr = (p: ArrayLike<number>) => { const q = clip(M, p); return q[2] > 1e-9 ? [(q[0] / q[2] * 0.5 + 0.5) * W, (1 - (q[1] / q[2] * 0.5 + 0.5)) * H, q[2]] : null; };
	for (let k = 0; k < items.length; k++) {
		const it = items[k]; if (!it || !it.pos?.length || !it.idx?.length || it.hidden) continue;
		const ol = Math.hypot(it.origin[0], it.origin[1], it.origin[2]) || 1; it._up = [it.origin[0] / ol, it.origin[1] / ol, it.origin[2] / ol];
		if (!it.xf) {   // 箱で外れ判定（剛体変換中は箱が回る＝省く）
			const bb = aabbOf(it); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
			for (let m = 0; m < 8 && !behind; m++) {
				const p = [it.origin[0] + bb[m & 1 ? 3 : 0] + (it.lift || 0) * it._up![0], it.origin[1] + bb[m & 2 ? 4 : 1] + (it.lift || 0) * it._up![1], it.origin[2] + bb[m & 4 ? 5 : 2] + (it.lift || 0) * it._up![2]];
				const s = scr(p); if (!s) { behind = true; break; }
				x0 = Math.min(x0, s[0]); y0 = Math.min(y0, s[1]); x1 = Math.max(x1, s[0]); y1 = Math.max(y1, s[1]);
			}
			if (!behind && (x < x0 - 1 || x > x1 + 1 || y < y0 - 1 || y > y1 + 1)) continue;
		}
		const I = it.idx, n = it.pos.length / 3, S = new Float64Array(n * 3), done = new Uint8Array(n);   // 頂点の画面（使う物だけ写す）
		const sv = (i: number) => { if (!done[i]) { done[i] = 1; const s = scr(worldOf(it, i, a)); if (s) { S[i*3] = s[0]; S[i*3+1] = s[1]; S[i*3+2] = s[2]; } else S[i*3+2] = -1; } return S[i*3+2] > 0; };
		for (let t = 0; t + 2 < I.length; t += 3) {
			const i0 = I[t], i1 = I[t+1], i2 = I[t+2];
			if (!sv(i0) || !sv(i1) || !sv(i2)) continue;
			const x0 = S[i0*3], y0 = S[i0*3+1], x1 = S[i1*3], y1 = S[i1*3+1], x2 = S[i2*3], y2 = S[i2*3+1];
			if ((x < x0 && x < x1 && x < x2) || (x > x0 && x > x1 && x > x2) || (y < y0 && y < y1 && y < y2) || (y > y0 && y > y1 && y > y2)) continue;
			const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2); if (Math.abs(d) < 1e-12) continue;
			const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d, l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d, l2 = 1 - l0 - l1;
			if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
			const iw = l0 / S[i0*3+2] + l1 / S[i1*3+2] + l2 / S[i2*3+2], w = 1 / iw;   // 透視で正しい奥行き（1/w を線形に）
			if (best && w >= best.w) continue;
			// 当たった点（世界）＝画面の重心座標を透視補正して頂点を混ぜる。球の裏（renderer の v_front < 0）は当てない
			const p0 = worldOf(it, i0, a), p1 = worldOf(it, i1, b), p2 = worldOf(it, i2, c), g0 = l0 / S[i0*3+2] * w, g1 = l1 / S[i1*3+2] * w, g2 = l2 / S[i2*3+2] * w;
			const P = [p0[0]*g0 + p1[0]*g1 + p2[0]*g2, p0[1]*g0 + p1[1]*g1 + p2[1]*g2, p0[2]*g0 + p1[2]*g1 + p2[2]*g2];
			const pl = Math.hypot(P[0], P[1], P[2]); if ((P[0]*E[0] + P[1]*E[1] + P[2]*E[2]) / pl - 1 < 0) continue;
			const ids = it.features?.ids, gs = [g0, g1, g2], vs = [i0, i1, i2], m = gs.indexOf(Math.max(g0, g1, g2)), fid = ids ? ids[vs[m]] : NO_FEATURE;   // 番号＝一番近い頂点の番号（三角形の中で番号が揃っていなくても迷わない）
			best = { item: k, tri: t / 3, w, featureId: fid === NO_FEATURE ? null : fid, vertex: vs[m], world: P };
		}
	}
	return best;
}
// 世界座標（描いた頂点と同じ空間＝β の単位球・S は mvp 側）→ [経度, 緯度]（度・測地）。楕円体では y を直に asin すると β＝緯度 35° で約 0.09°（≒10 km 南）ずれる
// （2026-10-13・t-plugin?v=gltf の f.lngLat が既定＝楕円体の器で落ちた）＝core の betaToLonLat（β → 測地緯度・球は恒等）に通す。worldToLonLat は S⁻¹ が二重に掛かり逆に 10 km 北へずれる（実測）
export const lngLatOfWorld = (P: ArrayLike<number>): LonLat => betaToLonLat(P);
// feature state の色：col0（元の頂点色 RGBA8）・ids（頂点の番号）・colorOf(id) → [r,g,b(,a)]（0..255）| null（元のまま）
export function tintColors(col0: Uint8Array, ids: ArrayLike<number> | null | undefined, colorOf: (id: number) => ArrayLike<number> | null): Uint8Array {
	const out = new Uint8Array(col0);
	if (!ids) return out;
	let last = -1, lastC: ArrayLike<number> | null = null;
	for (let i = 0; i < ids.length; i++) {
		const id = ids[i]; if (id === NO_FEATURE) continue;
		const c = id === last ? lastC : (lastC = colorOf(id), last = id, lastC);
		if (!c) continue;
		out[i*4] = c[0]; out[i*4+1] = c[1]; out[i*4+2] = c[2]; if (c.length > 3 && c[3] != null) out[i*4+3] = c[3];
	}
	return out;
}
