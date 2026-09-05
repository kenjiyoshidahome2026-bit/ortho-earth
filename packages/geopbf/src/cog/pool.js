// worker プール＝altpbf/src/createGetHeight.js の型（NW=min(3,cores-2)・lane 直列 FIFO・
// タイムアウトで worker 再生成＝死んだ worker は message も error も出さず lane を永久に塞ぐため）。
// ⚠Vite 規律: worker URL は文字どおり new Worker(new URL('./worker.js', import.meta.url), {type:'module'})
// と書く。変数に貯めると本番ビルドで data:URL にインライン化され worker 内の相対 import が silent 死。
const REQ_TIMEOUT = 45000;

export function makePool(opts = {}) {
	const NW = opts.workers ?? Math.min(3, Math.max(1, (globalThis.navigator?.hardwareConcurrency || 4) - 2));
	const mk = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
	const lanes = Array.from({ length: NW }, () => ({ w: null, queue: [], busy: false }));
	let seq = 0, rr = 0;

	const pump = (lane) => {
		if (lane.busy || !lane.queue.length) return;
		lane.busy = true;
		const job = lane.queue.shift();
		lane.w ??= mk();
		const timer = setTimeout(() => {   // ハング＝worker 作り直して lane 解放
			try { lane.w.terminate(); } catch {}
			lane.w = null; lane.busy = false;
			job.reject(new Error("cog: worker timeout"));
			pump(lane);
		}, REQ_TIMEOUT);
		lane.w.onmessage = ({ data }) => {
			if (data.id !== job.id) return;
			clearTimeout(timer); lane.busy = false;
			data.error ? job.reject(new Error(data.error)) : job.resolve(data);
			pump(lane);
		};
		lane.w.onerror = (e) => {
			clearTimeout(timer);
			try { lane.w.terminate(); } catch {}
			lane.w = null; lane.busy = false;
			job.reject(new Error(`cog: worker error ${e.message || ""}`));
			pump(lane);
		};
		lane.w.postMessage(job.msg, job.transfers);
	};

	return {
		submit(msg, transfers = []) {
			return new Promise((resolve, reject) => {
				const lane = lanes[rr++ % NW];
				lane.queue.push({ id: msg.id = ++seq, msg, transfers, resolve, reject });
				pump(lane);
			});
		},
		destroy() { for (const l of lanes) { try { l.w?.terminate(); } catch {} l.w = null; l.queue.length = 0; } },
	};
}
