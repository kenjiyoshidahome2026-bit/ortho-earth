// @ortho-earth/core/worldpal — 全球ハイプソの正準パレット（テーマ＝部分上書き）。
export const WORLD_PAL_DEFAULT: Record<string, unknown>;
export const WORLD_PAL_THEMES: Record<string, Record<string, unknown>>;
/** per-key マージ（knob＝view.worldHypso）。 */
export function resolveWorldPal(knob: unknown): Record<string, unknown>;
export function fadeWorldPal(pal: Record<string, unknown>, opacity: number, land: unknown): Record<string, unknown>;
