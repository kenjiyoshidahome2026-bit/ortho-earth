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
/** 輪の座標（平坦な [x,y,…]・core の解読＝Int32Array か枠で切った後＝Float64Array） */
export type RingCoords = Int32Array | Float64Array;
/** 輪の符号付き面積の 2 倍（開いた輪） */
export function ringArea2(r: ArrayLike<number>): number;
/** 外周と穴に分ける（MapLibre の classifyRings）＝[外周, 穴…] の並び（開いた輪） */
export function classifyRings(geom: { coords: RingCoords; ends: number[] }): RingCoords[][];
/** 輪をタイルの枠 [0, E]² で切る（開いた Float64Array か null） */
export function clipRing(r: ArrayLike<number>, E: number): Float64Array | null;
