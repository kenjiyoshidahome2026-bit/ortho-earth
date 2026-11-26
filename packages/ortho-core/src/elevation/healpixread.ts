// 標高の HEALPix タイルを読む側の純関数（2026-11-27・規約＝docs/design/healpix.md）。
// 経緯度の窓（地形のアトラスのセル＝南上げ・texel 中心 (i+0.5)/N）を、HEALPix タイル（幅 W・列＝ix・行＝iy）からバイリニアで埋める。
// 焼き（healpixbake.ts）の逆向き＝描く側（terrain.ts のアトラス・シェーダ）は経緯度の窓のまま＝ここを通せば GL2／WebGPU とも無変更で HEALPix を大元にできる。
// 面の縁をまたぐ標本は隣の面の画素を借りる（hpxWrap・ファイルに重なりは焼いていない）。隣が無い角（3 面しか集まらない所）は自分の面の縁の画素。
import { locToXYF, hpxWrap, nestOf } from "../healpix.ts";
import type { HpxXYF, HpxCell } from "../healpix.ts";

/** タイルを引く口：npix → W×W の画素（行優先）。無い＝null（0 m として扱う） */
export type HpxTileGetter = (npix: number) => ArrayLike<number> | null | undefined;

/** 面の一辺の角度（度）＝√(4π/12)。タイルの 1 画素＝これ /(W·2^order) */
export const HPX_FACE_DEG = Math.sqrt(Math.PI / 3) * 180 / Math.PI;
/** 1 texel が degPerTexel 度の窓を水増しせずに埋められる最も粗い order（min..max に収める） */
export const hpxOrderFor = (degPerTexel: number, W: number, min: number, max: number): number =>
	Math.max(min, Math.min(max, Math.ceil(Math.log2(HPX_FACE_DEG / (W * degPerTexel)) - 1e-9)));

// 1 点のバイリニアが読む 4 画素を回す。tap(i＝行 2 + 列, npix, 画素の添字)。戻り＝横の端数（縦の端数は fyOut[0]）。
// 速さ：窓は行ごとに緯度が同じ＝sin(緯度) と経度の rad は呼び手が先に作る（格子 g）。4 画素が同じタイルに収まる時（ほとんど）は番号を 1 回だけ組み、直前のタイルは覚えておく
const xyf: HpxXYF = { face: 0, x: 0, y: 0 }, cell: HpxCell = { face: 0, ix: 0, iy: 0 }, fyOut = [0];
const D2R = Math.PI / 180, TWO_PI = 2 * Math.PI;
interface Grid { order: number; W: number; F: number; pOrder: number; lastF: number; lastTX: number; lastTY: number; lastN: number }
const gridOf = (order: number, W: number): Grid => ({ order, W, F: W * 2 ** order, pOrder: order + Math.log2(W), lastF: -1, lastTX: -1, lastTY: -1, lastN: -1 });
function forTaps(z: number, phi: number, g: Grid, tap: (i: number, npix: number, idx: number) => void): number {
	locToXYF(z, phi, xyf);
	const { F, W } = g, px = xyf.x * F - 0.5, py = xyf.y * F - 0.5, x0 = Math.floor(px), y0 = Math.floor(py);
	const tx = Math.floor(x0 / W), ty = Math.floor(y0 / W), lx = x0 - tx * W, ly = y0 - ty * W;
	if (x0 >= 0 && y0 >= 0 && lx < W - 1 && ly < W - 1) {   // 4 画素とも同じタイルの内側
		if (xyf.face !== g.lastF || tx !== g.lastTX || ty !== g.lastTY) { g.lastF = xyf.face; g.lastTX = tx; g.lastTY = ty; g.lastN = nestOf(g.order, xyf.face, tx, ty); }
		const n = g.lastN, i0 = ly * W + lx;
		tap(0, n, i0); tap(1, n, i0 + 1); tap(2, n, i0 + W); tap(3, n, i0 + W + 1);
	} else for (let i = 0; i < 4; i++) {
		let X = x0 + (i & 1), Y = y0 + (i >> 1), face = xyf.face;
		if (X < 0 || Y < 0 || X >= F || Y >= F) {
			const c = hpxWrap(g.pOrder, face, X, Y, cell);
			if (c) { face = c.face; X = c.ix; Y = c.iy; }
			else { X = Math.max(0, Math.min(F - 1, X)); Y = Math.max(0, Math.min(F - 1, Y)); }
		}
		tap(i, nestOf(g.order, face, Math.floor(X / W), Math.floor(Y / W)), (Y % W) * W + X % W);
	}
	fyOut[0] = py - y0;
	return px - x0;
}
// 窓の列の経度（rad・[0, 2π)）と、行の sin(緯度)
function axes(lng0: number, lat0: number, spanX: number, spanY: number, NX: number, NY: number): { phi: Float64Array; z: Float64Array } {
	const phi = new Float64Array(NX), z = new Float64Array(NY);
	for (let i = 0; i < NX; i++) { let p = ((lng0 + spanX * (i + 0.5) / NX) * D2R) % TWO_PI; if (p < 0) p += TWO_PI; phi[i] = p; }
	for (let j = 0; j < NY; j++) z[j] = Math.sin(Math.max(-90, Math.min(90, lat0 + spanY * (j + 0.5) / NY)) * D2R);
	return { phi, z };
}

/** 窓（南西隅 lng0, lat0・幅 spanX×spanY 度・NX×NY texel）を埋めるのに要るタイル（order の npix） */
export function hpxTilesForWindow(lng0: number, lat0: number, spanX: number, spanY: number, NX: number, NY: number, order: number, W: number): Set<number> {
	const out = new Set<number>(), g = gridOf(order, W), { phi, z } = axes(lng0, lat0, spanX, spanY, NX, NY);
	let last = -1;
	const tap = (_i: number, npix: number): void => { if (npix !== last) { out.add(npix); last = npix; } };
	for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) forTaps(z[j], phi[i], g, tap);
	return out;
}

/** 窓を HEALPix タイルからバイリニアで埋める＝NX×NY の Float32（row0＝南・texel 中心 (i+0.5)/N＝downsampleFlipped と同じ規約）。
 *  sea＝海底の負値を通す（偽＝0 へ寄せる＝既定の地形と同じ）。無いタイルは 0 */
export function hpxSampleWindow(get: HpxTileGetter, order: number, W: number, lng0: number, lat0: number, spanX: number, spanY: number, NX: number, NY: number, sea = false): Float32Array {
	const out = new Float32Array(NX * NY), v = [0, 0, 0, 0], g = gridOf(order, W), { phi, z } = axes(lng0, lat0, spanX, spanY, NX, NY);
	let lastN = -1, last: ArrayLike<number> | null | undefined = null;
	const tap = (i: number, npix: number, idx: number): void => {
		if (npix !== lastN) { lastN = npix; last = get(npix); if (last && last.length !== W * W) throw new Error(`hpxSampleWindow: Npix${npix} is not ${W}x${W}`); }
		v[i] = last ? last[idx] : 0;
	};
	for (let j = 0; j < NY; j++) {
		const zj = z[j];
		for (let i = 0; i < NX; i++) {
			const fx = forTaps(zj, phi[i], g, tap), fy = fyOut[0];
			const a = v[0] + (v[1] - v[0]) * fx, b = v[2] + (v[3] - v[2]) * fx, e = a + (b - a) * fy;
			out[j * NX + i] = e < 0 && !sea ? 0 : e;
		}
	}
	return out;
}
