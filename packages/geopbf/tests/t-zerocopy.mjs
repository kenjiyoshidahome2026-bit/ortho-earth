#!/usr/bin/env node
// t-zerocopy: GintBUF のゼロコピー（俯瞰まとめ 2026-10-04 §2-E 10、§3 の 3）。
//   ・unPackGintBuffer は渡されたバッファ（ArrayBuffer / SharedArrayBuffer / view）の上に view を切る（旧＝丸ごと slice）
//   ・bbox 台帳（polyBboxByFid / lineBboxByFid / polyCompBbox）は遅延＝非列挙で、読めば従来と同じ中身
//   ・topology(pbf, { shared:true }) は SharedArrayBuffer に直に組む、setGintBUF は SAB をそのまま掴む・AB を写さない
//   ・identify / contain / topojson / cleanTopology / repack が view 経路でも同じ答え
import { GeoPBF } from "../src/pbf.ts";
import { initGintWasm } from "../src/convert/node-gint.ts";
import { topology, unPackGintBuffer, repackGintBuffer, isSharedView } from "../src/extension/topology.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
// 弧は 1° 箱に収める（1° 超は度アンカーの挿入＝repack の ArrayBuffer になる・それは別の経路）
const sq = (x0, y0, w = 0.5) => ({ type: "Polygon", coordinates: [[[x0, y0], [x0 + w, y0], [x0 + w, y0 + w], [x0, y0 + w], [x0, y0]]] });
const fc = { type: "FeatureCollection", features: [
	{ type: "Feature", geometry: sq(0, 0), properties: { n: "a" } },
	{ type: "Feature", geometry: sq(0.5, 0), properties: { n: "b" } },
	{ type: "Feature", geometry: { type: "LineString", coordinates: [[5, 5], [5.3, 5.3], [5.6, 5]] }, properties: { n: "l" } },
	{ type: "Feature", geometry: { type: "Point", coordinates: [9, 9] }, properties: { n: "p" } },
] };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

await initGintWasm();
const pbf = await new GeoPBF().set(JSON.parse(JSON.stringify(fc)));
const ab = topology(pbf);
ok(ab instanceof ArrayBuffer && new Uint32Array(ab, 0, 1)[0] === 1953392967, "topology() は ArrayBuffer の GintBUF");

// 1) view＝コピー無し
const d = unPackGintBuffer(ab);
ok(d.arcBuffer.buffer === ab && d.arcMeta.buffer === ab && d.polyStream.buffer === ab, "unpack は入力バッファの上の view（slice しない）");
ok(!Object.keys(d).includes("polyBboxByFid") && !Object.keys(d).includes("polyCompBbox"), "bbox 台帳は非列挙（structured clone に乗らない）");
ok(d.polyBboxByFid instanceof Map && d.polyBboxByFid.size === 2 && d.lineBboxByFid.size === 1 && d.polyCompBbox instanceof Uint32Array && d.polyCompBbox.length === 8, "読めば遅延生成される（面 2・線 1・成分 2）");
ok(d.polyBboxByFid === d.polyBboxByFid, "二度目は同じ物");
ok(JSON.stringify(Object.keys(d)) === JSON.stringify(Object.keys(unPackGintBuffer(ab.slice(0)))), "列挙キーは従来と同じ");
// view 入力（byteOffset 付き）
const padded = new Uint8Array(ab.byteLength + 16); padded.set(new Uint8Array(ab), 16);
const dv = unPackGintBuffer(new Uint8Array(padded.buffer, 16, ab.byteLength));
ok(dv && dv.arcBuffer.buffer === padded.buffer && dv.arcBuffer.byteOffset === 16 + 64, "8 の倍数の byteOffset を持つ view も受ける");
{ const err = console.error; console.error = () => {}; const r = unPackGintBuffer(new Uint8Array(padded.buffer, 12, ab.byteLength)); console.error = err; ok(r === null, "8 の倍数でない view は null（例外ではなく）"); }

// 2) SAB
const sab = topology(pbf, { shared: true });
ok(sab instanceof SharedArrayBuffer && same(new Uint8Array(sab), new Uint8Array(ab)), "topology({ shared:true }) は SAB で byte 同一");
const ds = unPackGintBuffer(sab);
ok(ds.arcBuffer.buffer === sab && isSharedView(ds.arcBuffer) && !isSharedView(d.arcBuffer), "SAB の上の view＝共有のまま（isSharedView）");
const p2 = await new GeoPBF().set(pbf.arrayBuffer);
await p2.setGintBUF(sab);
ok(p2._gintBuffer === sab && p2.unPackGint.arcBuffer.buffer === sab, "setGintBUF(SAB) は写さずそのまま掴む");
const p3 = await new GeoPBF().set(pbf.arrayBuffer);
const ab2 = ab.slice(0);
await p3.setGintBUF(ab2);
ok(p3._gintBuffer instanceof SharedArrayBuffer && same(new Uint8Array(p3._gintBuffer), new Uint8Array(ab2)), "setGintBUF(AB) は Node（SAB あり）では SAB へ 1 回写す");

// 3) 答えが同じ
ok(p2.contain([0.25, 0.25]) === 0 && p2.contain([0.75, 0.25]) === 1 && p2.contain([3, 3]) === null, "contain（SAB view・遅延 bbox）");
ok(p2.identifyAt(5.3, 5.3) === 2 && p2.identifyAt(9, 9) === 3, "identifyAt（線・点）");
ok(p2.neighbors(0).includes(1) && p2.topojson().arcs.length === p2.unPackGint.arcCount, "neighbors / topojson");
const re = repackGintBuffer(p2.unPackGint);
ok(same(new Uint8Array(re), new Uint8Array(ab)), "repack は byte 同一");
p2.cleanTopology({});
ok(p2.unPackGint && p2.contain([0.25, 0.25]) === 0, "cleanTopology 後も contain");

// 4) worker 経路の版検札落ち（2026-10-21 N02 駅）：decoder:gint は旧版 GintBUF に null ではなく { unpackFailed } を返し、
//    setGintBUF は例外にせず unPackGint=null（＝呼び手の _staleGint 自己修復へ）。旧＝null→workerPool が「脚本の読込失敗」で reject
{
	const posted = [];
	globalThis.postMessage = (m) => posted.push(m); globalThis.onmessage = null;   // worker の大域を Node に用意
	await import("../src/decoder/gint.ts");
	const decode = globalThis.onmessage;
	const stale = ab.slice(0); new Uint32Array(stale, 0, 2)[1] = 3;   // 版を v3 に書き換えた旧キャッシュ
	const err = console.error; console.error = () => {};
	decode({ data: { sab: stale } });
	console.error = err;
	ok(posted[0] && posted[0].unpackFailed === true, "decoder:gint は旧版に { unpackFailed:true }（null ではない）");
	class FakeWorker { postMessage(msg) { posted.length = 0; const e = console.error; console.error = () => {}; decode({ data: msg }); console.error = e;
		const data = posted[0]; queueMicrotask(() => this.onmessage({ data })); } terminate() {} }
	const prevW = globalThis.Worker, prevF = GeoPBF._gintWorkerFactory;
	globalThis.Worker = FakeWorker; GeoPBF._gintWorkerFactory = () => new FakeWorker();
	const p4 = await new GeoPBF().set(pbf.arrayBuffer);
	let threw = null; try { await p4.setGintBUF(stale.slice(0)); } catch (e) { threw = e; }
	ok(!threw && p4.unPackGint === null, "worker 経路: 旧版 GINT は unPackGint=null（例外にしない＝自己修復へ）");
	await p4.setGintBUF(ab.slice(0));
	ok(p4.unPackGint && p4.unPackGint.arcCount === d.arcCount, "worker 経路: 現行版は普通に解ける");
	globalThis.Worker = prevW; GeoPBF._gintWorkerFactory = prevF;
	delete globalThis.postMessage; delete globalThis.onmessage;
}

console.log(fails ? `\nFAIL ${fails}` : "\nPASS t-zerocopy");
process.exit(fails ? 1 : 0);
