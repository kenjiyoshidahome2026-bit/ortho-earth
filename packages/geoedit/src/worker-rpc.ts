// Worker RPC＝model-worker.ts（構築/再抽出/頂点数の門）への往復を Promise 化する薄い皮。
//   ・id 対応で並行呼び出し可・transfer 対応
//   ・Worker 自体の失敗（モジュール読込不可・OOM 等）＝返り便が永遠に来ない＝呼び手の busy が立ったまま全入力が死ぬ
//     → 待っている全件を reject し、Worker は捨てて次回に作り直す
// 編集モデルの worker（1 箇所で生成＝vite のチャンクも 1 本）。検定ページも index.ts 経由でこれを使う
import { spawnWorker } from "./workerFactory.ts";
import { builtinWorker } from "./builtinWorkers.ts";
import type { ModelRequest, ModelReply, ModelReplyPayload } from "./worker-msg.ts";
export const createModelWorker = (): Worker | null => spawnWorker("geoedit:model", () => builtinWorker("geoedit:model"));   // ホストの入口が勝つ（setWorkerFactory・2026-09-22）
export interface WorkerRpc {
	call(msg: ModelRequest, transfer?: Transferable[]): Promise<ModelReplyPayload>;
	terminate(): void;
}
export function createWorkerRpc(): WorkerRpc {
	let worker: Worker | null = null, reqId = 0;
	const pending = new Map<number, { res: (v: ModelReplyPayload) => void; rej: (e: Error) => void }>();
	const die = (msg: string): void => {
		const err = new Error(msg);
		for (const p of pending.values()) p.rej(err);
		pending.clear();
		worker?.terminate(); worker = null;
	};
	const ensure = (): Worker => {
		if (worker) return worker;
		worker = createModelWorker()!;   // 既定 worker は builtinWorker が必ず作る（alias で「作らない版」に差し替えたホストは自分の factory を渡す）
		worker.onmessage = (e: MessageEvent<ModelReply>) => {
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
