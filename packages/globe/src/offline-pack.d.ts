// offline-pack.js（JS のまま＝gadget の batch の外）の型。gadgets/offline.ts が読む分（TS 化 段 4・batch 2）＝offline-pack.js が TS になれば消える。
// bbox＝[w, s, e, n]・coverage＝基図の申告の範囲（同じ形・null＝全球）

export const PACK_CACHE: "oj-pack";
export function splitBbox(bbox: readonly number[], coverage?: readonly number[] | null): number[][];
/** bbox と z の範囲からタイル列（[z, x, y]） */
export function tilesFor(bbox: readonly number[], zmin: number, zmax: number, coverage?: readonly number[] | null): Array<[number, number, number]>;
export function tileCount(bbox: readonly number[], zmin: number, zmax: number, coverage?: readonly number[] | null): number;
/** tileUrl(z,x,y) の関数から URL の型紙（{z}/{x}/{y}） */
export function tplOf(tileUrl: (z: number, x: number, y: number) => unknown): string;
export function demCells(bbox: readonly number[], range: number): string[];
export function demNames(bbox: readonly number[], zmax: number): string[];
export function estimateBytes(count: number, samples: readonly number[], perTile?: number): number;
export function bboxIntersects(a: readonly number[], b: readonly number[]): boolean;
export function fmtMB(b: number): string;
/** runFetches の進捗 */
export interface FetchProgress { done: number; total: number; bytes: number; skipped: number; failed: number }
/** URL（等）の列を並列 n で取る。fetchOne の戻り＝取れた byte 数（負＝失敗）・has が真の物は飛ばす（再開） */
export function runFetches<T>(urls: readonly T[], opts?: {
	fetchOne: (u: T, signal: AbortSignal | null) => Promise<number>; has?: (u: T) => Promise<boolean>;
	concurrency?: number; onProgress?: (p: FetchProgress) => void; signal?: AbortSignal | null;
}): Promise<{ bytes: number; failed: number; aborted: boolean }>;
