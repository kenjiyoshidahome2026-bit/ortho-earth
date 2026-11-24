// 範囲読みの共通の取り順（共通化 段 4・2026-11-24）＝点群（COPC の節）と画像・標高（COG のタイル）が同じ規則で回線に出る。
//   ・優先度：大きいほど先（COPC＝節の点の間隔の画面 px・COG＝新しく頼まれたタイルほど先＝今の画面）。待っている間に付け替えられる（setPriority）
//   ・同時数：鍵（既定＝オリジン）ごとの上限。HTTP/2 でも 1 オリジンに数十本を一度に出すと、後ろの本が前の本の帯域を食って「最初の絵」が遅れる
//   ・中断：待っている物は回線に出る前に列から外す（fetch を作らない）・走っている物は AbortSignal で止める
// 1 つの realm（main・worker）の中の共有物。worker を跨いでは共有しない（それぞれの realm で 1 つ＝getScheduler()）。

/** 走らせる仕事（signal＝中断の合図・走っている間に止められたら reject してよい） */
export type Job<T> = (signal: AbortSignal) => Promise<T>;
export interface ScheduleOptions {
	/** 大きいほど先（既定 0）。同じ優先度は頼んだ順。関数＝出す時に問う（呼び手が画面に合わせて付け替える＝COPC の節） */
	priority?: number | (() => number);
	/** 同時数を数える鍵（既定 "*"）。Source はオリジンを渡す */
	key?: string;
	/** 呼び手の中断。待っている間なら列から外し、走っていれば job の signal も止まる */
	signal?: AbortSignal;
}
/** 頼んだ 1 件の手綱 */
export interface Ticket<T> {
	promise: Promise<T>;
	/** 待っている間の付け替え（走り出した後は効かない） */
	setPriority(p: number): void;
	/** 取り消し（待っている＝回線に出さない・走っている＝止める） */
	abort(): void;
	readonly state: "queued" | "running" | "done";
}
export interface SchedulerStats { queued: number; running: number; started: number; aborted: number; maxRunning: number }
export interface Scheduler {
	schedule<T>(job: Job<T>, opts?: ScheduleOptions): Ticket<T>;
	/** 簡便形＝schedule(...).promise */
	run<T>(job: Job<T>, opts?: ScheduleOptions): Promise<T>;
	/** 鍵ごとの同時数（既定は作った時の concurrency） */
	setConcurrency(n: number, key?: string): void;
	readonly stats: SchedulerStats;
}

const abortError = (): Error => { const e = new Error("aborted"); e.name = "AbortError"; return e; };

interface Item { pri: number | (() => number); seq: number; key: string; run: () => void; drop: () => void; state: "queued" | "running" | "done" }

export function createScheduler(opts: { concurrency?: number } = {}): Scheduler {
	let def = Math.max(1, opts.concurrency ?? 6);
	const per = new Map<string, number>(), running = new Map<string, number>();
	const queue: Item[] = [];
	const stats: SchedulerStats = { queued: 0, running: 0, started: 0, aborted: 0, maxRunning: 0 };
	let seq = 0;
	const limit = (k: string) => per.get(k) ?? def;
	// 走れる物のうち一番先の物から出す（列は小さい＝線形で十分。COPC は数十・COG は画面のタイル数）
	function pump(): void {
		for (;;) {
			let best = -1, bp = 0;
			for (let i = 0; i < queue.length; i++) {
				const it = queue[i];
				if ((running.get(it.key) || 0) >= limit(it.key)) continue;
				const p = typeof it.pri === "function" ? it.pri() : it.pri;
				if (best < 0 || p > bp || (p === bp && it.seq < queue[best].seq)) { best = i; bp = p; }
			}
			if (best < 0) break;
			const it = queue.splice(best, 1)[0];
			running.set(it.key, (running.get(it.key) || 0) + 1);
			stats.queued = queue.length; stats.running++; stats.started++; stats.maxRunning = Math.max(stats.maxRunning, stats.running);
			it.run();
		}
	}
	function schedule<T>(job: Job<T>, o: ScheduleOptions = {}): Ticket<T> {
		const ac = new AbortController(), key = o.key ?? "*";
		let resolve!: (v: T) => void, reject!: (e: unknown) => void;
		const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
		const it: Item = {
			pri: o.priority ?? 0, seq: seq++, key, state: "queued",
			run: () => {
				it.state = "running";
				let p: Promise<T>;
				try { p = job(ac.signal); } catch (e) { p = Promise.reject(e); }
				p.then(resolve, reject).finally(() => {
					it.state = "done"; stats.running--;
					running.set(key, Math.max(0, (running.get(key) || 1) - 1));
					o.signal?.removeEventListener("abort", onAbort);
					pump();
				});
			},
			drop: () => { const i = queue.indexOf(it); if (i >= 0) queue.splice(i, 1); stats.queued = queue.length; it.state = "done"; stats.aborted++; reject(abortError()); },
		};
		const onAbort = () => { if (it.state === "queued") it.drop(); else if (it.state === "running") { stats.aborted++; ac.abort(); } };
		if (o.signal?.aborted) { it.state = "done"; stats.aborted++; reject(abortError()); }
		else {
			o.signal?.addEventListener("abort", onAbort, { once: true });
			queue.push(it); stats.queued = queue.length;
			pump();
		}
		return {
			promise,
			setPriority(p: number) { if (it.state === "queued" && p !== it.pri) { it.pri = p; pump(); } },
			abort: onAbort,
			get state() { return it.state; },
		};
	}
	return {
		schedule,
		run: (job, o) => schedule(job, o).promise,
		setConcurrency(n, key) { if (key === undefined) def = Math.max(1, n); else per.set(key, Math.max(1, n)); pump(); },
		get stats() { return { ...stats }; },
	};
}

// この realm の共有の取り順（Source の既定）。同時数＝オリジンごと 6（ブラウザの HTTP/1.1 の上限と同じ・HTTP/2 でも「最初の絵」を先に通す）
let shared: Scheduler | null = null;
export function getScheduler(): Scheduler { return (shared ??= createScheduler({ concurrency: 6 })); }

/** URL → 同時数の鍵（オリジン） */
export function originKey(url: string): string { try { return new URL(url, (globalThis as { location?: { href: string } }).location?.href).origin; } catch { return "*"; } }
