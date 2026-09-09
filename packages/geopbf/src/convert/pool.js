// convert/pool.js ── tile-worker.js のプール（ブラウザ Worker / Node worker_threads 両対応・FIFO lane）。
// ⚠Vite 規律: worker URL は文字どおり new Worker(new URL('./tile-worker.js', import.meta.url), {type:'module'}) と書く
//（cog/pool.js と同じ理由＝変数経由は本番ビルドで data:URL にインライン化され相対 import が死ぬ）。
export async function createPool(n) {
	const isNode = typeof process !== "undefined" && !!process.versions?.node && typeof Worker === "undefined";
	let NodeWorker = null;
	if (isNode) ({ Worker: NodeWorker } = await import("node:worker_threads"));
	const spawn = () => {
		const w = isNode ? new NodeWorker(new URL("./tile-worker.js", import.meta.url)) : new Worker(new URL("./tile-worker.js", import.meta.url), { type: "module" });
		const lane = { w, busy: false, pending: null };
		const onMsg = (data) => { const p = lane.pending; if (!p) return; lane.pending = null; lane.busy = false; data?.error ? p.reject(new Error(data.error)) : p.resolve(data); pump(); };
		const onErr = (e) => { const p = lane.pending; lane.pending = null; lane.busy = false; p?.reject(new Error("tile worker: " + (e?.message || e))); pump(); };
		if (isNode) { w.on("message", onMsg); w.on("error", onErr); } else { w.onmessage = (e) => onMsg(e.data); w.onerror = onErr; }
		return lane;
	};
	const lanes = Array.from({ length: n }, spawn);
	const queue = [];
	let seq = 0;
	const post = (lane, msg, transfers) => lane.w.postMessage(msg, transfers);
	const pump = () => {
		for (const lane of lanes) {
			if (lane.busy || !queue.length) continue;
			const job = queue.shift();
			let payload;
			try { payload = job.make(); } catch (e) { job.reject(e); continue; }
			lane.busy = true; lane.pending = job;
			payload.msg.id = ++seq;
			post(lane, payload.msg, payload.transfers || []);
		}
	};
	return {
		size: n,
		// 全 worker に同じ静的データを送る（構造化クローン＝各 worker が自分の複製を持つ）
		async init(S) { await Promise.all(lanes.map(lane => new Promise((resolve, reject) => { lane.busy = true; lane.pending = { resolve, reject }; post(lane, { type: "init", S }, []); }))); },
		// make() は worker が空いた時に呼ばれる＝job の実体（コピー）を同時に NW 個までしか作らない
		run(make) { return new Promise((resolve, reject) => { queue.push({ make, resolve, reject }); pump(); }); },
		destroy() { for (const lane of lanes) { try { lane.w.terminate(); } catch {} } lanes.length = 0; queue.length = 0; },
	};
}
export async function defaultWorkers() {
	let n = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 0;
	if (!n && typeof process !== "undefined" && process.versions?.node) { try { n = (await import("node:os")).availableParallelism(); } catch { n = 4; } }
	// 既定＝コア数（上限 8）。4 コアでの実測（NE z0-10 組立段）: 1→15.3s 2→7.9s 3→5.2s 4→4.5s 5→4.8s 6→4.9s 7→5.3s
	//＝main は job の複製と結果の寄せ集めだけで空きが多く、コア数ぶん worker を立てた時が最速。過剰申込みは僅かに損。
	return Math.max(1, Math.min(8, n || 4));
}
