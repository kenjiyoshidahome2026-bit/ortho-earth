// 標高セルの GPU 再標本化の係数と CPU 退避（改善計画の段階 3・2026-11-01）＝両 renderer が同式で持っていた純関数の正本。
// 描き手の違いは「焼く先」だけ（GL2＝FBO へ drawArrays・WebGPU＝render pass）。uniform の詰め（dim 0-3・a 4-7・lo 8-11・o 12-15・box 16-19・ix 20-23・iy 24-27）はここで一度に決める。
import { downsampleFlipped, cropResample } from "./elevation.ts";
import { worldAtlasCell } from "./elevation/worldatlas.ts";
import type { ElevGrid, ElevTileGrid } from "./elevation.ts";

/** セルの元（scene worker の生タイルの記述子）：down＝タイル 1 枚を N×N へ・crop＝タイルの一部（lng0/lat0/span 度）を N×N へ・world＝世界アトラスの (cx, cy) 格子 */
export interface ElevCellSrc { mode: "down" | "crop" | "world"; tile?: ElevTileGrid; atlas?: ElevGrid; edge?: number; sea?: boolean; lng0?: number; lat0?: number; span?: number; cx?: number; cy?: number }
/** uniform の u32 語数（28＝112 バイト） */
export const RESAMPLE_U32 = 28;

/** 再標本化の uniform を詰める（u＝Uint32Array(28)・f＝同じ buffer の Float32Array）。戻り＝false＝この元は GPU では焼けない（CPU 退避へ）。
 *  u[2]（生タイルの型 kind）だけは呼び手が生テクスチャ／バッファを上げた後に置く。
 *  標本位置は整数の分数 gx = (Ax + Bx·(2i+1)) / Dx で厳密に（ix/iy）。切り出しの幾何が整数で書けない（外来 DEM の端数など）時だけ f32 の一般形（mode 3） */
export function packResampleParams(u: Uint32Array, f: Float32Array, src: ElevCellSrc, cx: number, cy: number, N: number): boolean {
	const tile = (src.tile || src.atlas) as ElevTileGrid, w = tile.width, h = tile.height;
	if (!(w >= 2 && h >= 2)) return false;
	u.fill(0);
	if (src.mode === "down") { u[20] = N; u[21] = w; u[22] = 2 * N; u[23] = 1; u[24] = N; u[25] = h; u[26] = 2 * N; u[27] = 1; u[16] = src.edge ?? 2; }   // box.x＝読まない最外周 M（既定 2・R10/R90 は 0）   // gx=(w(2i+1)−N)/2N＝画素中心（2026-10-02）
	else if (src.mode === "crop") {
		const rg = tile.range, dl = src.lng0! - tile.lng, dt = src.lat0! - tile.lat, sp = src.span!;
		const ints = [rg, dl, dt, sp, N].every(Number.isInteger) && dl >= 0 && dt >= 0 && rg > 0 && sp > 0;
		// 画素中心：gx = ((dl + sp(i+½)/N)/rg)·w − ½ = (dl·2N·w + sp·w·(2i+1) − N·rg) / (2N·rg)。分子が負になり得る（dl=0 の西端）＝D を足して ix.w=1 で商から引く
		const Ax = dl * 2 * N * w + N * rg, Ay = dt * 2 * N * h + N * rg, Bx = sp * w, By = sp * h, D = 2 * N * rg;
		if (ints && Ax + Bx * (2 * N - 1) < 0x100000000 && Ay + By * (2 * N - 1) < 0x100000000 && D < 0x100000000) { u[3] = 2; u[20] = Ax; u[21] = Bx; u[22] = D; u[23] = 1; u[24] = Ay; u[25] = By; u[26] = D; u[27] = 1; }
		else { u[3] = 3; f[4] = dl / rg * w - 0.5; f[5] = sp / N / rg * w; f[6] = dt / rg * h - 0.5; f[7] = sp / N / rg * h; f[8] = -1e30; f[9] = 1e30; f[10] = -1e30; f[11] = 1e30; }
	}
	else if (src.mode === "world") { const C = w >> 2; if (C % N) return false; u[3] = 1; u[15] = C / N; u[16] = w; u[17] = (1 - src.cy!) * C; u[18] = src.cx! * C; }
	else return false;
	u[0] = w; u[1] = h; u[12] = cx * N; u[13] = cy * N; u[14] = N;
	if (src.mode !== "world" && src.sea) u[19] = 1;   // box.w＝海底（負値を通す・mode 0/2 だけ＝mode 1 は box.w を読まない）
	return true;
}
/** CPU 退避（EXT_color_buffer_float 無し・?cpuelev=1・型が想定外）＝GPU 再標本化と同式の正本（elevation.ts）で N×N を作る */
export const cpuResampleCell = (src: ElevCellSrc, N: number): Float32Array => src.mode === "down" ? downsampleFlipped(src.tile!, N, src.edge ?? 2, !!src.sea) : src.mode === "crop" ? cropResample(src.tile!, src.lng0!, src.lat0!, src.span!, N, !!src.sea) : worldAtlasCell(src.atlas!, src.cx!, src.cy!, N);
