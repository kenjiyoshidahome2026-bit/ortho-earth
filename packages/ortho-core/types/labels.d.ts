// @ortho-earth/core/labels — 注記の 2D 描画層（Canvas2D・render worker 側）。
export interface LabelLayer {
	set(key: string, value: unknown): void;
	draw(...args: unknown[]): unknown;
	dispose(): void;
	[k: string]: unknown;
}
export function createLabelLayer(canvas: OffscreenCanvas | HTMLCanvasElement, opts?: { pad?: number; fadeMs?: number; recollideMs?: number; shieldFor?: unknown; elevBase?: number; /** 字形アトラスで描く（既定 true）。 */ glyphAtlas?: boolean; /** 線注記を平らに置く幅［px］の [下限, 上限]（既定 [4.5, 5.5]）。 */ lineFlatPx?: [number, number] }): LabelLayer;
export function stretchFit(im: unknown, size: number[], fit: unknown, t: unknown, p: unknown): unknown;
export const isStretch: (im: unknown) => boolean;
export function boxGrid(): unknown;
