// voxel の読み手の worker（@ortho-earth/voxel・2026-10-23）＝値の詰め（R8／RGBA8）・色表・置き方を main の外で。
//   main（index.ts）が new Worker(new URL("./voxel-reader.ts", import.meta.url), { type: "module" }) で一つ立て、層ごとに { seq, data, opts } を送る。
//   答え＝{ seq, ok: true, …PreparedGrid（大きな格子はブリックに分けた物）}（配列は transfer）か { seq, ok: false, error }。worker が立たない器では index.ts が同じ prepareGrid を main で呼ぶ＝答えは同じ。
import { prepareGrid, transferables } from "./grid.ts";
import type { PrepareOptions, PreparedGrid } from "./grid.ts";

/** main → worker */
export interface ReaderRequest { seq: number; data: unknown; opts: PrepareOptions }
/** worker → main */
export type ReaderReply = ({ seq: number; ok: true } & PreparedGrid) | { seq: number; ok: false; error: string };

interface WorkerSelf { onmessage: ((e: { data: ReaderRequest }) => void) | null; postMessage(d: unknown, transfer?: ArrayBuffer[]): void; document?: unknown; constructor?: { name?: string } }
const w = globalThis as unknown as WorkerSelf;
if (typeof w.postMessage === "function" && typeof w.document === "undefined" && /Worker/.test(w.constructor?.name || "")) {
	w.onmessage = ({ data: m }) => {
		try {
			const p = prepareGrid(m.data, m.opts);
			w.postMessage({ seq: m.seq, ok: true, ...p } satisfies ReaderReply, transferables(p));
		} catch (e) {
			w.postMessage({ seq: m.seq, ok: false, error: String((e as { message?: string } | null)?.message || e) } satisfies ReaderReply);
		}
	};
}
