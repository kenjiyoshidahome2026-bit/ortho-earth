// worker への往復（id つき postMessage ↔ 返事）＝ガジェット 4 本（model・tiles3d・vtdraw・vtextrude）が同じ 10 行を持っていた物を 1 本に（2026-10-03）。
//
//   const pool = workerPool(() => new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "model" }), { size: 2, tag: "tiles3d" });
//   await pool.rpc({ kind: "tile3d", ... }, [ab]);          // 空いている順（size 本まで作り、以後は順繰り）
//   const { w, i } = pool.pick(`${sid}|${key}`);            // 鍵のハッシュで 1 本に固定（同じタイルの層は同じ worker＝解読と幾何を共有）
//   await pool.rpc(w, { kind: "put", ... }, [ab]);          // 第 1 引数に Worker を渡せばその 1 本へ
//   pool.destroy();                                          // 全部 terminate・待ちは捨てる（旧実装どおり reject しない＝then だけの呼び元で unhandled にしない）
//
// spawn は「new Worker(new URL(..., import.meta.url), …)」の字面を呼び元に残すための口＝vite はこの字面を見て worker を束ねる（ここに書くと束ねない）。
// 返事の契約＝{ id, error? , …}：error があれば reject（Error）、無ければ e.data をそのまま resolve。worker 側の onerror は console.error（旧実装どおり）。
/** worker の口の束（workerPool の戻り）。rpc の答え＝worker の e.data（{ id, … }・error があれば reject）＝形は呼び手が T で言う */
export interface WorkerPool {
	/** 空いている順の 1 本へ */
	rpc<T = unknown>(msg: object, transfer?: Transferable[]): Promise<T>;
	/** その 1 本へ */
	rpc<T = unknown>(w: Worker, msg: object, transfer?: Transferable[]): Promise<T>;
	/** 鍵のハッシュで 1 本に固定 */
	pick(k: string): { w: Worker; i: number };
	next(): Worker;
	readonly workers: Worker[];
	readonly size: number;
	readonly pending: number;
	destroy(): void;
}
interface Waiter { res: (d: unknown) => void; rej: (e: Error) => void }
export function workerPool(spawn: (i: number) => Worker, { size = 1, tag = "worker" }: { size?: number; tag?: string } = {}): WorkerPool {
	const workers: Worker[] = [], waiting = new Map<number, Waiter>();
	let seq = 0, rr = 0;
	const at = (i: number): Worker => {
		if (workers[i]) return workers[i];
		const w = spawn(i);
		w.onmessage = (e: MessageEvent<{ id: number; error?: string }>) => { const d = e.data, p = waiting.get(d.id); if (!p) return; waiting.delete(d.id); d.error ? p.rej(new Error(d.error)) : p.res(d); };
		w.onerror = e => console.error(`[${tag}] worker error`, e.message);
		workers[i] = w;
		return w;
	};
	let made = 0;
	const next = () => at(made < size ? made++ : (rr++) % size);   // size 本まで順に作り、以後は順繰り
	const pick = (k: string) => { let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0; const i = Math.abs(h) % size; return { w: at(i), i }; };
	const rpc = ((w: Worker | object, msg?: object | Transferable[], transfer?: Transferable[]) => {
		if (typeof (w as Partial<Worker>)?.postMessage !== "function") { transfer = msg as Transferable[] | undefined; msg = w; w = next(); }   // rpc(msg, transfer)＝空いている順
		return new Promise<unknown>((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); (w as Worker).postMessage({ id, ...msg }, transfer || []); });
	}) as WorkerPool["rpc"];
	return {
		rpc, pick, next,
		get workers() { return workers; },
		get size() { return size; },
		get pending() { return waiting.size; },
		destroy() { for (const w of workers) w?.terminate(); workers.length = 0; made = 0; waiting.clear(); },
	};
}
