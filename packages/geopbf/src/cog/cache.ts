// 二層キャッシュの席（本計画 §5-7）。
//   一層目: メモリ LRU（デコード済み RGBA・byte 予算・挿入順 Map＝terrain.js:27 と同じ流儀）
//   二層目: 注入式 {get,set}（IDB 等・既定 no-op）。geopbf は native-bucket を import しない＝
//           アプリが opts.cache に Cache("GIS/cog") 等を渡す（pbf-io の provider 注入と同型）。
interface LRUEntry<V> { v: V; bytes: number }
/** 一層目（メモリ LRU）。値は何でも（ImageBitmap なら追い出し時に close() を呼ぶ） */
export interface LRU<V> {
	get(k: string): V | null;
	set(k: string, v: V, b: number): void;
	clear(): void;
	readonly bytes: number;
}
/** 二層目（注入式・圧縮バイト）。get は無ければ null／undefined */
export interface ByteCache {
	get(key: string): Promise<Uint8Array | null | undefined>;
	set(key: string, value: Uint8Array): Promise<unknown>;
}
const closeOf = (v: unknown): void => { (v as { close?: () => void } | null | undefined)?.close?.(); };   // ImageBitmap は close 規律（iOS メモリ）
export function makeLRU<V>(budgetBytes: number): LRU<V> {
	const m = new Map<string, LRUEntry<V>>();   // key → {v, bytes}
	let bytes = 0;
	return {
		get(k: string): V | null {
			const e = m.get(k);
			if (!e) return null;
			m.delete(k); m.set(k, e);   // touch＝末尾へ
			return e.v;
		},
		set(k: string, v: V, b: number): void {
			const old = m.get(k);
			if (old) { bytes -= old.bytes; m.delete(k); }
			m.set(k, { v, bytes: b }); bytes += b;
			for (const [kk, ee] of m) {
				if (bytes <= budgetBytes) break;
				m.delete(kk); bytes -= ee.bytes;
				closeOf(ee.v);   // ImageBitmap は close 規律（iOS メモリ）
			}
		},
		clear(): void { for (const [, e] of m) closeOf(e.v); m.clear(); bytes = 0; },
		get bytes(): number { return bytes; },
	};
}

export const noopCache: ByteCache = { get: async () => null, set: async () => {} };
