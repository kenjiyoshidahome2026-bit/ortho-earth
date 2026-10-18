// Gaussian splat の読み手の worker（@ortho-earth/plugin-splat・2026-10-18）＝fetch・gunzip・読み（.ply／.splat／.spz）・東北上への下ごしらえ・SH の詰め・LoD の順位を main の外で。
//   main（index.ts）が new Worker(new URL("./splat-reader.ts", import.meta.url), { type: "module" }) で一つ立て、層ごとに { seq, src, … } を送る。
//   答え＝{ seq, ok: true, …Prepared }（配列は transfer＝写さない）か { seq, ok: false, error }。main はそのまま描き手（render worker のオーバーレイ）へ transfer する。
//   自前の読み手（splatPlugin({ decoders })）は関数＝worker へ渡せないので、その format だけ main が読む（index.ts）。
//   worker が立たない器（別オリジンの CDN から読んだ時の SecurityError など）では index.ts が同じ関数（formats.ts）を main で呼ぶ＝答えは同じ。
import { readerFor, checkSplatData, prepare, transferables } from "./formats.ts";
import type { SplatData, SplatFormat, PrepareOptions, Prepared } from "./formats.ts";

/** main → worker */
export interface ReaderRequest { seq: number; src: string | ArrayBuffer | Uint8Array | SplatData; format: SplatFormat | null; opts: PrepareOptions }
/** worker → main */
export type ReaderReply = ({ seq: number; ok: true } & Prepared) | { seq: number; ok: false; error: string };

export async function read(src: ReaderRequest["src"], format: SplatFormat | null, opts: PrepareOptions, fetchFn: typeof fetch = fetch): Promise<Prepared> {
	let d: SplatData & { n: number; crs: SplatData["crs"] & string };
	if (typeof src === "string" || src instanceof ArrayBuffer || src instanceof Uint8Array) {
		if (!format) throw new Error("plugin-splat: format is required for bytes");
		const reader = readerFor(format);   // 知らない format はここで投げる
		let bytes: Uint8Array;
		if (typeof src === "string") { const r = await fetchFn(src); if (!r.ok) throw new Error(`plugin-splat: ${src} → HTTP ${r.status}`); bytes = new Uint8Array(await r.arrayBuffer()); }
		else bytes = src instanceof ArrayBuffer ? new Uint8Array(src) : src;
		d = checkSplatData(await reader(bytes));
	} else d = checkSplatData(src);
	return prepare(d, opts, false);   // worker の中の配列は自分の物＝写さずに transfer できる
}
// ---- worker の入口（main の module として import された時は何もしない） ----
interface WorkerSelf { onmessage: ((e: { data: ReaderRequest }) => void) | null; postMessage(d: unknown, transfer?: ArrayBuffer[]): void; document?: unknown; constructor?: { name?: string } }
const w = globalThis as unknown as WorkerSelf;
if (typeof w.postMessage === "function" && typeof w.document === "undefined" && /Worker/.test(w.constructor?.name || "")) {
	w.onmessage = async ({ data: m }) => {
		try {
			const p = await read(m.src, m.format, m.opts);
			w.postMessage({ seq: m.seq, ok: true, ...p } satisfies ReaderReply, transferables(p));
		} catch (e) {
			w.postMessage({ seq: m.seq, ok: false, error: String((e as { message?: string } | null)?.message || e) } satisfies ReaderReply);
		}
	};
}
