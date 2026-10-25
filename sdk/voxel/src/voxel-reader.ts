// voxel の読み手の worker（@ortho-earth/voxel・2026-10-23）＝値の詰め（R8／RGBA8）・色表・置き方を main の外で。
//   main（index.ts）が new Worker(new URL("./voxel-reader.ts", import.meta.url), { type: "module" }) で一つ立て、層ごとに { seq, data, opts } を送る。
//   答え＝{ seq, ok: true, …PreparedGrid（大きな格子はブリックに分けた物）}（配列は transfer）か { seq, ok: false, error }。worker が立たない器では index.ts が同じ prepareGrid を main で呼ぶ＝答えは同じ。
//   ファイル（NetCDF／Zarr＝sources.ts）は src で送る＝取りに行くのも読むのも worker。答えに読んだ値（values・main が当たりの値に使う）と meta を足す。
import { prepareGrid, transferables } from "./grid.ts";
import type { PrepareOptions, PreparedGrid } from "./grid.ts";
import { readSource } from "./sources.ts";
import type { SourceOptions, SourceMeta } from "./sources.ts";

/** main → worker（data＝VoxelData か、src＝URL／bytes と読み方） */
export interface ReaderRequest { seq: number; data?: unknown; src?: string | ArrayBuffer | Uint8Array; source?: Omit<SourceOptions, "fetch">; opts: PrepareOptions }
/** ファイルから読んだ時に足す物 */
export interface ReadExtra { values?: Float32Array; meta?: SourceMeta }
/** worker → main */
export type ReaderReply = ({ seq: number; ok: true } & PreparedGrid & ReadExtra) | { seq: number; ok: false; error: string };
/** 読んで下ごしらえ（worker でも main でも同じ） */
export async function readAndPrepare(m: Omit<ReaderRequest, "seq">): Promise<PreparedGrid & ReadExtra> {
	if (m.src == null) return prepareGrid(m.data, m.opts);
	const d = await readSource(m.src, m.source ?? {});
	return { ...prepareGrid(d, m.opts), values: d.values, meta: d.meta };
}

interface WorkerSelf { onmessage: ((e: { data: ReaderRequest }) => void) | null; postMessage(d: unknown, transfer?: ArrayBuffer[]): void; document?: unknown; constructor?: { name?: string } }
const w = globalThis as unknown as WorkerSelf;
if (typeof w.postMessage === "function" && typeof w.document === "undefined" && /Worker/.test(w.constructor?.name || "")) {
	w.onmessage = ({ data: m }) => {
		readAndPrepare(m).then(p => w.postMessage({ seq: m.seq, ok: true, ...p } satisfies ReaderReply, [...transferables(p), ...(p.values ? [p.values.buffer as ArrayBuffer] : [])]),
			e => w.postMessage({ seq: m.seq, ok: false, error: String((e as { message?: string } | null)?.message || e) } satisfies ReaderReply));
	};
}
