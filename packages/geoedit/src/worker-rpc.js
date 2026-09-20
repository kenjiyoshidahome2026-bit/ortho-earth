// Worker RPC＝model-worker.js（構築/再抽出/頂点数の門）への往復を Promise 化する薄い皮。
//   ・id 対応で並行呼び出し可・transfer 対応
//   ・Worker 自体の失敗（モジュール読込不可・OOM 等）＝返り便が永遠に来ない＝呼び手の busy が立ったまま全入力が死ぬ
//     → 待っている全件を reject し、Worker は捨てて次回に作り直す
// 編集モデルの worker（1 箇所で生成＝vite のチャンクも 1 本）。検定ページも index.js 経由でこれを使う
export const createModelWorker = () => new Worker(new URL("./model-worker.js", import.meta.url), { type: "module", name: "geoedit-model" });
export function createWorkerRpc() {
	let worker = null, reqId = 0;
	const pending = new Map();
	const die = msg => {
		const err = new Error(msg);
		for (const p of pending.values()) p.rej(err);
		pending.clear();
		worker?.terminate(); worker = null;
	};
	const ensure = () => {
		if (worker) return worker;
		worker = createModelWorker();
		worker.onmessage = e => {
			const p = pending.get(e.data.id);
			if (!p) return;
			pending.delete(e.data.id);
			e.data.ok ? p.res(e.data.payload) : p.rej(new Error(e.data.error));
		};
		worker.onerror = e => { e.preventDefault?.(); die("worker error: " + (e.message || "unknown")); };
		worker.onmessageerror = () => die("worker message error");
		return worker;
	};
	return {
		call: (msg, transfer = []) => new Promise((res, rej) => {
			const id = ++reqId;
			pending.set(id, { res, rej });
			ensure().postMessage({ id, ...msg }, transfer);
		}),
		terminate() { worker?.terminate(); worker = null; pending.clear(); },
	};
}
