// 復号 worker の常駐プール（2026-09-18）。
//
// 旧＝set() と setGintBUF() が呼ばれるたびに new Worker → 1 件処理 → terminate。apps/equal の起動は 4 層 ×2 種＝
// **8 回の worker 生成**で、そのたびに新しい realm でモジュール評価（worker.ts → decoder → pbf-base / topology）を払っていた。
// 本番実測（IDB 温・2026-09-18）＝最初の geopbf() が 1538ms、同じデータのメインスレッド解析は set 26ms + setGintBUF 20ms。
// 差はデータ量ではなく「復号経路の立ち上げ」＝ここを畳む。
//
// 設計は altpbf createTileLoader のプールと同じ流儀：
//   ・種別（decoder:pbf / decoder:gint）ごとに数本のレーン。各レーンは 1 件ずつ直列（応答 FIFO＝取りこぼさない）、レーン間は並列。
//   ・decoder/pbf.ts・decoder/gint.ts は無状態（onmessage が毎回完結）＝1 本を使い回して安全。要求 id を持たないので直列は必須。
//   ・worker が死んだら（モジュール取得失敗・OOM kill 等）作り直し、その 1 件だけ失敗として返す＝レーンを詰まらせない。
//   ・無音が続いたレーンは畳む＝「使い捨て」の良さ（常駐ゼロ）を保つ。次の要求で作り直すだけ。
// prewarm()＝最初の要求を待たずにレーンを起こす。モジュール評価が起動直後の空き時間（DB 取得・IDB 読み）と重なる。

const IDLE_MS = 45000;   // 無音でレーンを畳むまで。層を遅れて読むアプリ（equal の detail は z≥4.5）でも、畳んだ後の再生成は従来と同じコスト＝退行なし
const LANES = (): number => Math.max(1, Math.min(2, (typeof navigator !== "undefined" ? (navigator.hardwareConcurrency || 4) : 4) - 2));

/** レーンの worker を作る関数（バンドラに new Worker の直書きを見せる既存の物を渡す） */
export type LaneFactory = () => Worker;
interface Job { msg: unknown; transfer: Transferable[] | undefined; resolve: (data: unknown) => void; reject: (err: unknown) => void }
interface Lane { kind: string | null; w: Worker | null; queue: Job[]; busy: boolean; idleT: ReturnType<typeof setTimeout> | 0; onmsg?: ((e: MessageEvent) => void) | null; onerr?: ((e: ErrorEvent) => void) | null }
interface Pool { lanes: Lane[]; factory: LaneFactory }

const pools = new Map<string, Pool>();   // kind → { lanes: [lane], factory }

const getPool = (kind: string, factory: LaneFactory | undefined): Pool => {
	let p = pools.get(kind);
	if (!p) pools.set(kind, p = { lanes: [], factory: factory as LaneFactory });
	p.factory = factory || p.factory;   // 呼び手が渡した最新のファクトリを使う（テストの差し替え・遅延配線）
	return p;
};

function spawn(pool: Pool, lane: Lane): Worker {
	lane.w = pool.factory();
	lane.w.onmessage = e => lane.onmsg && lane.onmsg(e);
	lane.w.onerror = e => lane.onerr && lane.onerr(e);
	return lane.w;
}

function pump(pool: Pool, lane: Lane): void {
	if (lane.busy || !lane.queue.length) { schedIdle(pool, lane); return; }
	lane.busy = true;
	clearTimeout(lane.idleT);
	const job = lane.queue.shift()!;
	if (!lane.w) spawn(pool, lane);
	let done = false;
	const finish = (err: unknown, data?: unknown): void => {
		if (done) return; done = true;
		lane.onmsg = lane.onerr = null;
		lane.busy = false;
		err ? job.reject(err) : job.resolve(data);
		pump(pool, lane);
	};
	lane.onmsg = e => {
		// worker.ts は脚本の読込に失敗すると null を返す約束＝ここで明示的に失敗へ畳む
		// （旧 _setViaWorker は null を素通しして onmessage 内で TypeError＝Promise が宙に浮いていた）
		e.data == null ? finish(new Error(`geopbf worker (${lane.kind}) returned null — script failed to load`)) : finish(null, e.data);
	};
	lane.onerr = e => {
		// worker 自体の死＝作り直し。この 1 件は失敗、以降の要求は新しい worker で正常化
		console.warn(`[geopbf] worker lane (${lane.kind}) died -> recreating:`, e?.message || e);
		try { lane.w!.terminate(); } catch { /* 既に死んでいる */ }
		lane.w = null;
		finish((e as unknown) instanceof Error ? e : new Error(`geopbf worker (${lane.kind}) error: ${e?.message || "(opaque)"}`));
	};
	try { lane.w!.postMessage(job.msg, job.transfer || []); }
	catch (e) { finish(e); }   // transfer 済みバッファの再送等＝同期例外も 1 件の失敗に畳む
}

function schedIdle(pool: Pool, lane: Lane): void {
	clearTimeout(lane.idleT);
	if (!lane.w || lane.busy || lane.queue.length) return;
	lane.idleT = setTimeout(() => {
		if (lane.busy || lane.queue.length) return;
		try { lane.w!.terminate(); } catch { /* 既に死んでいる */ }
		lane.w = null;
	}, IDLE_MS);
}

const pickLane = (pool: Pool): Lane => {
	const n = LANES();
	while (pool.lanes.length < n) pool.lanes.push({ kind: null, w: null, queue: [], busy: false, idleT: 0 });
	let best = pool.lanes[0];
	for (const l of pool.lanes) { if (!l.busy && !l.queue.length) return l; if (l.queue.length < best.queue.length) best = l; }
	return best;
};

// 1 件投げて結果（worker からの data）を待つ。factory＝そのレーンの worker を作る関数（バンドラに直書きを見せる既存の物を渡す）。
export function runInWorker<T = unknown>(kind: string, factory: LaneFactory | undefined, msg: unknown, transfer?: Transferable[]): Promise<T> {
	const pool = getPool(kind, factory);
	return new Promise<T>((resolve, reject) => {
		const lane = pickLane(pool);
		lane.kind = kind;
		lane.queue.push({ msg, transfer, resolve: resolve as (data: unknown) => void, reject });
		pump(pool, lane);
	});
}

// レーンを先に起こす＝モジュール評価を起動直後の空き時間へ寄せる。仕事は投げない（worker.ts は届くまで待つだけ）。
export function prewarmWorkers(kinds: Iterable<[string, LaneFactory | null | undefined]>): void {
	for (const [kind, factory] of kinds) {
		if (!factory) continue;
		const pool = getPool(kind, factory), lane = pickLane(pool);
		lane.kind = kind;
		if (!lane.w) { spawn(pool, lane); schedIdle(pool, lane); }
	}
}
