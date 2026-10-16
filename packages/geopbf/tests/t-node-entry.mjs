#!/usr/bin/env node
// t-node-entry: src/index.js（createGeopbf）が Node でそのまま動く（俯瞰まとめ 2026-10-04 §2-B の 4・5、§2-G 23）。
//   ・globalThis.ImageData のスタブ無しで new GeoPBF().set(geojson) が通る（旧＝ImageData is not defined）
//   ・createGeopbf() を一度呼んだ後でも、Node（Worker 無し）では set(ArrayBuffer)／setGintBUF が main スレッドで解ける（旧＝Worker is not defined）
//   ・createGeopbf(undefined, { worker:false }) は各インスタンスへ worker:false が渡る（旧＝クラス静的な配線が勝って worker 経路に固定）
//   ・geopbf(geojson) が gint を main スレッドの topology で焼く（encoder worker が作れない時の予備が Node でも効く）
//   ・geopbf(ArrayBuffer)・geopbf(GeoPBF)・geopbf(Feature)・geopbf("https://…") の失敗（throw）
if (typeof globalThis.ImageData !== "undefined") { console.error("この検定は ImageData スタブ無しで走らせる"); process.exit(1); }
import { createGeopbf, geopbf as legacy } from "../src/index.js";
import { GeoPBF } from "../src/pbf.js";
import { initGintWasm } from "../src/convert/node-gint.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const rejects = async (p, re, msg) => { try { await p; ok(false, msg + "（例外が出ない）"); } catch (e) { ok(re.test(String(e.message)), `${msg}: ${String(e.message).slice(0, 80)}`); } };
const fc = { type: "FeatureCollection", features: [
	{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] }, properties: { name: "a", n: 1 } },
	{ type: "Feature", geometry: { type: "Polygon", coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]] }, properties: { name: "b", n: 2 } },
] };
const clone = () => JSON.parse(JSON.stringify(fc));

// 1) スタブ無しで set(geojson)
const base = await new GeoPBF().set(clone());
ok(base.length === 2 && base.getProperties(1).name === "b", "new GeoPBF().set(geojson) が ImageData スタブ無しで通る");
const bytes = base.arrayBuffer;

// 2) createGeopbf() 後の素の set(ArrayBuffer)＝Node では main スレッド
await rejects(legacy(clone()), /createGeopbf/, "createGeopbf 前の geopbf() は明示エラー");
const g = createGeopbf();
ok(typeof GeoPBF._workerFactory === "function", "createGeopbf() はクラスに worker の入口を配線する（ブラウザ用）");
const viaSet = await new GeoPBF().set(bytes.slice(0));
ok(viaSet.length === 2 && viaSet.getProperties(0).n === 1, "createGeopbf() 後の new GeoPBF().set(ArrayBuffer) が Node で main スレッド復号");
ok(new GeoPBF({ worker: false })._useWorker === false && new GeoPBF()._useWorker === undefined, "インスタンスの worker:false");

// 3) geopbf(geojson) ＝ gint を main スレッドで焼く（wasm は node-gint の手で初期化）
await initGintWasm();
const p1 = await g(clone(), { name: "two" });
ok(p1 instanceof GeoPBF && p1.length === 2 && p1.name() === "two", "geopbf(geojson) が Node で GeoPBF を返す");
ok(!!p1.unPackGint && p1._gintBuffer?.byteLength > 0, "gint が main スレッドの topology で焼かれる（encoder worker 無し）");
ok(p1.contain([0.5, 0.5]) === 0 && p1.contain([1.5, 0.5]) === 1, "contain が効く（Gint が正しい）");
const p2 = await g(bytes.slice(0), { gint: false });
ok(p2.length === 2 && !p2.unPackGint, "geopbf(ArrayBuffer, { gint:false }) が Node で復号・gint 無し");
ok((await g(p1)) === p1, "geopbf(GeoPBF) はそのまま返す");
ok((await g({ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: {} }, { gint: false })).length === 1, "geopbf(Feature) は 1 件の FC に包む");
{ const e = await g({ type: "FeatureCollection", features: [] }); ok(e instanceof GeoPBF && e.length === 0, "0 件の FC は空の GeoPBF（文字列入力だけが throw）"); }

// 4) worker:false の入口
const g2 = createGeopbf(undefined, { worker: false });
const p3 = await g2(bytes.slice(0), { gint: false });
ok(p3.length === 2 && p3._useWorker === false, "createGeopbf(undefined, { worker:false }) のインスタンスは worker:false を持つ");

// 5) detach の約束：set(ArrayBuffer) は main スレッド経路ならバッファを残す（worker 経路は transfer＝reference.md に明記）
const keep = bytes.slice(0); await new GeoPBF({ worker: false }).set(keep);
ok(keep.byteLength === bytes.byteLength, "main スレッド経路の set(ArrayBuffer) は呼び手のバッファを detach しない");

console.log(fails ? `\nFAIL ${fails}` : "\nPASS t-node-entry");
process.exit(fails ? 1 : 0);
