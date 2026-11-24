// 空間索引 → チャンクのバイト範囲 → Range 読み、の共通の口（共通化 段 2・2026-11-24）。
//   点群（COPC）＝階層の頁（八分木）が節の { offset, byteSize } を持つ。COG＝IFD（overview＝段の四分木）がタイルの { offset, count } を持つ。
//   どちらも「索引で問いを解いて、要るチャンクの範囲を出す」→「その範囲を Source（端末キャッシュ→合体→並行）で取る」の 2 段で、
//   違うのは索引の解き方だけ。ここはその境の型と、取る側の 1 本（readChunks）を置く。
//   段 4（共通の取り順＝画面の誤差で優先度を付ける）はこの Chunk の列を受ける。
import type { Source } from "./source.ts";

/** 索引が解いた 1 チャンク＝ファイル内のバイト範囲（len 0＝空＝sparse のタイル・点の無い節） */
export interface Chunk<K = string> { key: K; from: number; len: number }
/** 空間索引の契約：問い（COG＝段とタイルの列・COPC＝節）→ 要るチャンク */
export interface ChunkIndex<Q, K = string> { resolve(q: Q): Chunk<K>[] }

/** チャンク群を取る（入力順・空は null）。端末キャッシュの照会・隙間の合体・並行は Source の readMany が一元に持つ */
export async function readChunks<K>(src: Source, chunks: readonly Chunk<K>[], signal?: AbortSignal): Promise<(Uint8Array | null)[]> {
	const live = chunks.map((c, i) => ({ c, i })).filter(({ c }) => c.len > 0);
	const bufs = await src.readMany(live.map(({ c }) => ({ from: c.from, len: c.len })), signal);
	const out: (Uint8Array | null)[] = chunks.map(() => null);
	live.forEach(({ i }, j) => { out[i] = bufs[j]; });
	return out;
}

/** COG の索引（IFD の段）＝[tx, ty] の列 → タイルのチャンク（範囲外・offset 0 は空） */
export interface TileTable { tilesX: number; tilesY: number; offsets: ArrayLike<number>; counts: ArrayLike<number> }
export function tiffChunks(lv: TileTable, level: number): ChunkIndex<readonly (readonly [number, number])[]> {
	return {
		resolve: list => list.map(([tx, ty]) => {
			const i = ty * lv.tilesX + tx, out = tx < 0 || ty < 0 || tx >= lv.tilesX || ty >= lv.tilesY;
			return { key: `${level}/${tx}/${ty}`, from: out ? 0 : lv.offsets[i] || 0, len: out || !lv.offsets[i] ? 0 : lv.counts[i] || 0 };
		}),
	};
}

/** COPC の索引（階層の頁の項）＝節 → チャンク（点の無い節は空） */
export interface CopcEntry { key: readonly number[]; offset: number; byteSize: number; pointCount?: number }
export const copcChunks: ChunkIndex<readonly CopcEntry[]> = {
	resolve: nodes => nodes.map(n => ({ key: n.key.join("-"), from: n.offset, len: n.pointCount === 0 ? 0 : n.byteSize })),
};
