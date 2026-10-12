// @ortho-earth/core/raster — 画像タイル層（XYZ/WMS/WMTS/PMTiles・render worker 常駐）。
export function buildTileMesh(z: number, y: number, n: number): unknown;
export const subdivOf: (z: number) => number;
export function ancestorUV(x: number, y: number, d: number): number[];
export function createRaster(opts?: { renderer?: unknown; requestDraw?: () => void; lowMem?: boolean; post?: unknown; maxTiles?: number; budgetMB?: number | null }): { [k: string]: unknown };
