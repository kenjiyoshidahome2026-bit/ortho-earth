// @ortho-earth/core/build — タイルの描画命令列（worker 側）。
export function extendToPole(flat: number[], tris: number[], extent: number, pole: number): void;
export function clipToExtent(flat: number[], holes: number[], extent: number): unknown;
export function subdivideTris(flat: number[], tris: number[], cell: number): unknown;
/** line-dasharray → 先頭の [線, 間] の対（3 要素以上は近似）。 */
export function dashPattern(v: unknown): number[] | null;
export function miterSlides(coords: number[][], ls: number, le: number): unknown;
export function buildTileDrawList(tile: unknown, style: unknown, origin: unknown, pale?: (c: number[]) => number[]): unknown[];
export function buildEmptySeaOps(layers: unknown, tile: { z: number; x: number; y: number }, style: unknown, origin: unknown): unknown[];
