// 優先付き共有キュー（vt perf plan §3.1・2026-10-22）：tile worker へ渡す前に main で待たせ、「空いた worker に一番急ぐ物」を渡す。
// 旧＝round-robin で即 post＝worker 内は到着順＝tilemanager.update の ensure 順（毛布→下地→主層）で、画面中心の詳細タイルが視野 3 倍の毛布の後ろに並んだ。
// 鍵＝(役: 主層 0／下地 1／毛布 2, 画面中心からの距離)。優先度は update ごとに付け直す（未発送分だけ＝setPriority・発送済みは従来どおり abort で切る）。
// 純関数の器（Worker を知らない）＝node で検定できる（tests/tilequeue.mjs）。発送は dispatch(item, slot) に任せ、slot ごとの同時実行は perSlot まで（fetch の待ちを重ねる）
export interface TilePriority { role: number; dist: number }
export interface TileQueueOptions<T> { slots: number; perSlot: number; dispatch: (item: T, slot: number) => void }
export interface TileQueue<T> {
	/** 列に入れる（slot が空いていれば即発送）。同じ key が待っていれば置き換えない（false を返す） */
	enqueue(key: string, pri: TilePriority, item: T): boolean;
	/** 待っている物の優先度を付け直す（発送済み・無い物は何もしない） */
	setPriority(key: string, pri: TilePriority): boolean;
	/** 待っている物を取り下げる（戻り＝取り下げた item・発送済みなら undefined） */
	remove(key: string): T | undefined;
	/** slot の 1 件が終わった（成功・失敗・中断とも）＝次を発送する */
	done(slot: number): void;
	/** 待っている物を全部取り下げて返す（destroy） */
	drain(): T[];
	/** 観測：待ち数・発送中の数 */
	stats(): { queued: number; inflight: number };
}
export function createTileQueue<T>({ slots, perSlot, dispatch }: TileQueueOptions<T>): TileQueue<T> {
	const waiting = new Map<string, { pri: TilePriority; item: T }>();
	const inflight = new Int32Array(slots);
	const better = (a: TilePriority, b: TilePriority): boolean => a.role !== b.role ? a.role < b.role : a.dist < b.dist;
	// 一番急ぐ物を 1 件取り出す（線形＝待ちは高々 100 件級・ヒープにするほどでない）
	const popBest = (): { key: string; item: T } | null => {
		let bk: string | null = null, bp: TilePriority | null = null, bi: T | undefined;
		for (const [k, v] of waiting) if (!bp || better(v.pri, bp)) { bk = k; bp = v.pri; bi = v.item; }
		if (bk === null) return null;
		waiting.delete(bk);
		return { key: bk, item: bi! };
	};
	// 空きのある slot のうち最も空いている物へ、空きが尽きるか待ちが尽きるまで発送
	const pump = (): void => {
		for (;;) {
			let s = -1; for (let i = 0; i < slots; i++) if (inflight[i] < perSlot && (s < 0 || inflight[i] < inflight[s])) s = i;
			if (s < 0) return;
			const n = popBest(); if (!n) return;
			inflight[s]++;
			dispatch(n.item, s);
		}
	};
	return {
		enqueue(key, pri, item) { if (waiting.has(key)) return false; waiting.set(key, { pri, item }); pump(); return true; },
		setPriority(key, pri) { const w = waiting.get(key); if (!w) return false; w.pri = pri; return true; },
		remove(key) { const w = waiting.get(key); if (!w) return undefined; waiting.delete(key); return w.item; },
		done(slot) { if (inflight[slot] > 0) inflight[slot]--; pump(); },
		drain() { const out = [...waiting.values()].map(w => w.item); waiting.clear(); return out; },
		stats() { let f = 0; for (let i = 0; i < slots; i++) f += inflight[i]; return { queued: waiting.size, inflight: f }; },
	};
}
