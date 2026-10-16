// convert/pool.js ── tile-worker.js のプール（ブラウザ Worker / Node worker_threads 両対応・FIFO lane）。
// ⚠Vite 規律: worker URL は文字どおり new Worker(new URL('./tile-worker.ts', import.meta.url), {type:'module'}) と書く
//（cog/pool.js と同じ理由＝変数経由は本番ビルドで data:URL にインライン化され相対 import が死ぬ）。
import { spawnWorker } from "../modules/workerFactory.js";
import { builtinWorker } from "../modules/builtinWorkers.js";
import type { AssembleStatic } from "./assemble.ts";
import type { TileWorkerRequest, TileWorkerResponse, TileWorkerResult } from "./tile-worker-types.ts";

/** run() の make が返す job の実体 */
export interface JobPayload { msg: TileWorkerRequest; transfers?: ArrayBuffer[] }
export interface TilePool {
	size: number;
	init(S: AssembleStatic): Promise<void>;
	run(make: () => JobPayload): Promise<TileWorkerResult>;
	destroy(): void;
}
/** Node の worker_threads.Worker の使う分だけ */
interface NodeWorkerLike {
	postMessage(msg: unknown, transfers?: ArrayBuffer[]): void;
	on(ev: "message", fn: (data: TileWorkerResponse) => void): unknown;
	on(ev: "error", fn: (e: Error) => void): unknown;
	terminate(): unknown;
}
type AnyWorker = Worker | NodeWorkerLike;
interface Pending { resolve: (v: TileWorkerResult) => void; reject: (e: unknown) => void }
interface Job extends Pending { make: () => JobPayload }
interface Lane { w: AnyWorker; busy: boolean; pending: Pending | null }

export async function createPool(n: number): Promise<TilePool> {
	const isNode = typeof process !== "undefined" && !!process.versions?.node && typeof Worker === "undefined";
	let NodeWorker: (new (url: URL) => NodeWorkerLike) | null = null;
	if (isNode) ({ Worker: NodeWorker } = await import(/* @vite-ignore */ "node:" + "worker_threads"));   // 組み立て式＋@vite-ignore＝バンドラに node: を解決させない（modules/inflate.js と同じ）
	const spawn = (): Lane => {
		const w: AnyWorker = isNode ? new (NodeWorker as new (url: URL) => NodeWorkerLike)(new URL("./tile-worker.ts", import.meta.url)) : spawnWorker("geopbf:tile", () => builtinWorker("geopbf:tile"));   // ブラウザはホストの入口が勝つ・既定＝geopbf の入口 src/worker.js の "geopbf:tile"
		const lane: Lane = { w, busy: false, pending: null };
		const onMsg = (data: TileWorkerResponse): void => { const p = lane.pending; if (!p) return; lane.pending = null; lane.busy = false; data?.error ? p.reject(new Error(data.error)) : p.resolve(data as TileWorkerResult); pump(); };
		const onErr = (e: unknown): void => { const p = lane.pending; lane.pending = null; lane.busy = false; p?.reject(new Error("tile worker: " + ((e as { message?: string } | null)?.message || e))); pump(); };
		if (isNode) { const nw = w as NodeWorkerLike; nw.on("message", onMsg); nw.on("error", onErr); } else { const bw = w as Worker; bw.onmessage = (e: MessageEvent<TileWorkerResponse>) => onMsg(e.data); bw.onerror = onErr; }
		return lane;
	};
	const lanes = Array.from({ length: n }, spawn);
	const queue: Job[] = [];
	let seq = 0;
	const post = (lane: Lane, msg: TileWorkerRequest, transfers: ArrayBuffer[]): void => lane.w.postMessage(msg, transfers);
	const pump = (): void => {
		for (const lane of lanes) {
			if (lane.busy || !queue.length) continue;
			const job = queue.shift() as Job;
			let payload: JobPayload;
			try { payload = job.make(); } catch (e) { job.reject(e); continue; }
			lane.busy = true; lane.pending = job;
			payload.msg.id = ++seq;
			post(lane, payload.msg, payload.transfers || []);
		}
	};
	return {
		size: n,
		// 全 worker に同じ静的データを送る（構造化クローン＝各 worker が自分の複製を持つ）
		async init(S: AssembleStatic): Promise<void> { await Promise.all(lanes.map(lane => new Promise<void>((resolve, reject) => { lane.busy = true; lane.pending = { resolve: () => resolve(), reject }; post(lane, { type: "init", S }, []); }))); },
		// make() は worker が空いた時に呼ばれる＝job の実体（コピー）を同時に NW 個までしか作らない
		run(make: () => JobPayload): Promise<TileWorkerResult> { return new Promise<TileWorkerResult>((resolve, reject) => { queue.push({ make, resolve, reject }); pump(); }); },
		destroy(): void { for (const lane of lanes) { try { lane.w.terminate(); } catch {} } lanes.length = 0; queue.length = 0; },
	};
}
export async function defaultWorkers(): Promise<number> {
	let n = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 0;
	if (!n && typeof process !== "undefined" && process.versions?.node) { try { n = (await import(/* @vite-ignore */ "node:" + "os")).availableParallelism(); } catch { n = 4; } }
	// 既定＝コア数（上限 8）。4 コアでの実測（NE z0-10 組立段）: 1→15.3s 2→7.9s 3→5.2s 4→4.5s 5→4.8s 6→4.9s 7→5.3s
	//＝main は job の複製と結果の寄せ集めだけで空きが多く、コア数ぶん worker を立てた時が最速。過剰申込みは僅かに損。
	return Math.max(1, Math.min(8, n || 4));
}
