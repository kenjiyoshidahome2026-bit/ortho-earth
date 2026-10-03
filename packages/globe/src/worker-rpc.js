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
export function workerPool(spawn, { size = 1, tag = "worker" } = {}) {
	const workers = [], waiting = new Map();
	let seq = 0, rr = 0;
	const at = i => {
		if (workers[i]) return workers[i];
		const w = spawn(i);
		w.onmessage = e => { const d = e.data, p = waiting.get(d.id); if (!p) return; waiting.delete(d.id); d.error ? p.rej(new Error(d.error)) : p.res(d); };
		w.onerror = e => console.error(`[${tag}] worker error`, e.message);
		workers[i] = w;
		return w;
	};
	let made = 0;
	const next = () => at(made < size ? made++ : (rr++) % size);   // size 本まで順に作り、以後は順繰り
	const pick = k => { let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0; const i = Math.abs(h) % size; return { w: at(i), i }; };
	const rpc = (w, msg, transfer) => {
		if (typeof w?.postMessage !== "function") { transfer = msg; msg = w; w = next(); }   // rpc(msg, transfer)＝空いている順
		return new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); w.postMessage({ id, ...msg }, transfer || []); });
	};
	return {
		rpc, pick, next,
		get workers() { return workers; },
		get size() { return size; },
		get pending() { return waiting.size; },
		destroy() { for (const w of workers) w?.terminate(); workers.length = 0; made = 0; waiting.clear(); },
	};
}
