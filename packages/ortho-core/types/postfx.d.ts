// @ortho-earth/core/postfx — 後処理（bloom・vignette）の設定の正規化（deck.gl 差分 PR-8）。main・GL2・WebGPU が同じ既定を見る。
export interface BloomOptions { threshold?: number; strength?: number; radius?: number }
export interface VignetteOptions { strength?: number; radius?: number; softness?: number }
export interface PostProcessOptions { bloom?: true | BloomOptions; vignette?: true | VignetteOptions }
export interface PostProcessNormalized {
	bloom: { threshold: number; strength: number; radius: number } | null;
	vignette: { strength: number; radius: number; softness: number } | null;
}
/** 設定を正規化する。両方 off なら null。 */
export function normPost(p: PostProcessOptions | null | undefined): PostProcessNormalized | null;
