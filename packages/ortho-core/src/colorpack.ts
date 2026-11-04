// 色と幅を GPU の表の語へ詰める小物＝gint/style.ts（fid スタイル表）と mltables.ts（MapLibre 形の表）が字句まで同じに持っていた純関数の正本（2026-11-04）。
/** [r,g,b,a](0..1) × opacity → RGBA8 パック u32（α が 0 なら 0＝描かない） */
export function packColor(c: readonly number[], opacity: number): number {
	const a = Math.round(Math.max(0, Math.min(1, (c[3] ?? 1) * opacity)) * 255);
	if (a === 0) return 0;
	const u = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255);
	return ((u(c[0]) << 24) | (u(c[1]) << 16) | (u(c[2]) << 8) | a) >>> 0;
}
/** 0..255 へ丸めて挟む */
export const clampU8 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
/** 0..65535 へ丸めて挟む（線幅 1/8px・2026-10-22 から u16＝旧の u8 は約 32px で頭打ち） */
export const clampU16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));
