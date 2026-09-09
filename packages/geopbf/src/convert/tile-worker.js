// convert/tile-worker.js ── assembleZoom を別スレッドで。ブラウザ Worker と Node worker_threads の両方で同じ本体。
// メッセージ: { type: "init", S } → 静的データを保持 / { type: "job", J, gzip: bool } → { tiles, contents:[[key, bytes]] }
import { assembleZoom } from "./assemble.js";
import { gzipMany } from "./gzip.js";

let S = null;
async function handle(m) {
	if (m.type === "init") { S = m.S; return { msg: { type: "ready" }, transfers: [] }; }
	const r = assembleZoom(S, m.J);
	const raws = r.contents.map(c => c[1]);
	const bytes = m.gzip ? await gzipMany(raws) : raws;
	const contents = r.contents.map((c, i) => [c[0], bytes[i]]);
	return { msg: { id: m.id, tiles: r.tiles, contents }, transfers: bytes.map(b => b.buffer) };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
	self.onmessage = (e) => handle(e.data).then(r => self.postMessage(r.msg, r.transfers), err => self.postMessage({ id: e.data.id, error: String(err?.stack || err) }));
} else {
	const { parentPort } = await import("node:worker_threads");
	parentPort.on("message", (m) => handle(m).then(r => parentPort.postMessage(r.msg, r.transfers), err => parentPort.postMessage({ id: m.id, error: String(err?.stack || err) })));
}
