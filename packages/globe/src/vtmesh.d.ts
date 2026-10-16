// vtmesh.js（JS のまま）の型。gadgets の vtdraw・vtextrude が読む分だけ（TS 化 段 4・batch 2）＝vtmesh.js が TS になれば消える。

/** タイルの番地 */
export interface TileXYZ { z: number; x: number; y: number }
/** 出すタイルの鍵（z/x/y）の Set＝揃っていなければ一番近い揃った祖先（minZ まで）か揃った子孫 */
export function retainTiles(wanted: Iterable<TileXYZ>, ready: (key: string) => boolean, opts?: { minZ?: number }): Set<string>;
/** paint の値が変わり得るかのズームの鍵（["zoom"] 無し＝""） */
export function paintZoomKey(paint: Record<string, unknown> | null | undefined, z: number, evalIn: (e: unknown, z: number) => unknown): string;
/** filter を評価する zoom（エンジンの目盛り） */
export function filterZoom(tileZ: number, maxzoom: number, camZoom: number): number;
/** 式が ["zoom"] を含むか */
export function hasZoom(e: unknown): boolean;
/** タイルの鍵（z/x/y） */
export function tileKey(t: TileXYZ): string;
