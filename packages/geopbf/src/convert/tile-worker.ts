// convert/tile-worker.js ── assembleZoom を別スレッドで。ブラウザ Worker と Node worker_threads の両方で同じ本体。
// メッセージ: { type: "init", S } → 静的データを保持 / { type: "job", J, gzip: bool } → { tiles, contents:[[key, bytes]] }
import { assembleZoom } from "./assemble.ts";
import type { AssembleStatic } from "./assemble.ts";
import { gzipMany } from "./gzip.ts";
import type { TileWorkerRequest, TileWorkerResponse } from "./tile-worker-types.ts";

interface Reply { msg: TileWorkerResponse; transfers: ArrayBuffer[] }

let S: AssembleStatic | null = null;
async function handle(m: TileWorkerRequest): Promise<Reply> {
	if (m.type === "init") { S = m.S; return { msg: { type: "ready" }, transfers: [] }; }
	const r = assembleZoom(S as AssembleStatic, m.J);
	const raws = r.contents.map(c => c[1]);
	const bytes = m.gzip ? await gzipMany(raws) : raws;
	const contents = r.contents.map((c, i): [string, Uint8Array] => [c[0], bytes[i]]);
	return { msg: { id: m.id, tiles: r.tiles, contents }, transfers: bytes.map(b => b.buffer as ArrayBuffer) };
}
const errOf = (err: unknown): string => String((err as { stack?: unknown } | null)?.stack || err);

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
	self.onmessage = (e: MessageEvent<TileWorkerRequest>) => handle(e.data).then(r => self.postMessage(r.msg, r.transfers), err => self.postMessage({ id: e.data.id, error: errOf(err) } satisfies TileWorkerResponse));
} else {
	// トップレベル await を使わない（ホストの worker 入口から動的 import される時、ビルド対象が TLA を許さないことがある・2026-09-22）
	(async () => {
		const { parentPort } = await import(/* @vite-ignore */ "node:" + "worker_threads");   // 組み立て式＋@vite-ignore＝バンドラに node: を解決させない（modules/inflate.js と同じ）
		parentPort.on("message", (m: TileWorkerRequest) => handle(m).then(r => parentPort.postMessage(r.msg, r.transfers), (err: unknown) => parentPort.postMessage({ id: m.id, error: errOf(err) } satisfies TileWorkerResponse)));
	})();
}
