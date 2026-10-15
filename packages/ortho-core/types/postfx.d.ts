// @ortho-earth/core/postfx — 後処理（fxaa・bloom・tonemap・lut・vignette）の設定の正規化（deck.gl 差分 PR-8・第 3 波 W1）。main・GL2・WebGPU が同じ既定を見る。
export type TonemapMode = "linear" | "reinhard" | "aces" | "agx" | "filmic";
/** tonemap.mode の語彙（既定 "aces"）。 */
export const TONEMAP_MODES: readonly TonemapMode[];
/** lut.size の語彙＝[16, 32, 64]（既定 32）。 */
export const LUT_SIZES: readonly number[];
export interface BloomOptions { threshold?: number; strength?: number; radius?: number }
export interface VignetteOptions { strength?: number; radius?: number; softness?: number }
export interface FxaaOptions { enabled?: boolean }
export interface TonemapOptions { mode?: TonemapMode; exposure?: number }
/** url＝.cube の文章か size²×size の板画像。 */
export interface LutOptions { url: string; size?: number; intensity?: number }
export interface PostProcessOptions {
	bloom?: true | BloomOptions;
	vignette?: true | VignetteOptions;
	fxaa?: boolean | FxaaOptions;
	tonemap?: true | TonemapOptions;
	lut?: LutOptions | null;
}
/** 正規化の戻り。fxaa/tonemap/lut の鍵は on の時だけ生える（従来の { bloom, vignette } の形を壊さない）。 */
export interface PostProcessNormalized {
	bloom: { threshold: number; strength: number; radius: number } | null;
	vignette: { strength: number; radius: number; softness: number } | null;
	fxaa?: true;
	tonemap?: { mode: TonemapMode; exposure: number };
	lut?: { url: string; size: number; intensity: number };
}
/** 設定を正規化する。全部 off なら null。数値は有限に・範囲に畳む。 */
export function normPost(p: PostProcessOptions | null | undefined): PostProcessNormalized | null;
