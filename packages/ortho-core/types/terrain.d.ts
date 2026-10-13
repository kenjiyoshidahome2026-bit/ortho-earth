// @ortho-earth/core/terrain — 地形（世界アトラス＋外来 DEM・真の縮尺＝誇張しない）。
export function clipToDTM(box: number[], dtm: unknown): number[] | null;
export function createTerrain(opts: Record<string, unknown>): { [k: string]: unknown };
