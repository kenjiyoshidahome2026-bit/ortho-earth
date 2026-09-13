#!/usr/bin/env node
// t-encoders: encoder worker 脚本（encoder/*.js）を Node で直接叩き、「必ず settle する」ことと往復を検定する。
//   経緯：fgbFile() / shapeFile() が 2 ポリゴンの FC で永久に settle しなかった（2026-09-14）。原因＝両 encoder が
//   ../pbf-base.js の GeoPBF を使っており bbox / getBbox（pbf.js 側の prototype）が無く TypeError → fgb は書き手の
//   非同期 IIFE が unhandled rejection のまま Response.blob() が解決せず、shape は onmessage が例外で落ちて postMessage
//   されなかった。ここでは全 encoder を同じ harness で回し、File が返ること（または明示の null）を保証する。
//   worker 脚本は「グローバルの onmessage を張り、postMessage で返す」契約＝t-moj.mjs と同じ流儀で Node から呼ぶ。
globalThis.ImageData ??= class ImageData { };   // Node に無い（pbf-base のエンコード経路が参照）＝他の検定と同じスタブ
import { GeoPBF } from "../src/pbf.js";
import { gint } from "../src/extension/gint.js";
import { topology } from "../src/extension/topology.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
{   // Node で WASM を読む（fetch(file:) は未実装）＝t-anchors と同じ手
	const wasmJs = fileURLToPath(new URL("../wasm/pkg/gint_wasm.js", import.meta.url));
	const mod = await import(wasmJs);
	await mod.default({ module_or_path: readFileSync(wasmJs.replace(/\.js$/, "_bg.wasm")) });
	await gint.initialize();
}

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

const fc = { type: "FeatureCollection", features: [
	{ type: "Feature", properties: { n: "A", v: 1 }, geometry: { type: "Polygon", coordinates: [[[139, 35], [140, 35], [140, 36], [139, 36], [139, 35]]] } },
	{ type: "Feature", properties: { n: "B", v: 2 }, geometry: { type: "Polygon", coordinates: [[[140, 35], [141, 35], [141, 36], [140, 36], [140, 35]]] } },
	{ type: "Feature", properties: { n: "L", v: 3 }, geometry: { type: "LineString", coordinates: [[139.2, 35.2], [140.8, 35.8]] } },
	{ type: "Feature", properties: { n: "P", v: 4 }, geometry: { type: "Point", coordinates: [139.5, 35.5] } },
]};
const src = await new GeoPBF().name("two").set(fc);

// worker 脚本を Node で 1 回叩く：onmessage を張らせ、postMessage を捕まえる。settle しない事故を timeout で検出。
async function runWorker(modulePath, data, ms = 8000) {
	globalThis.onmessage = null;
	const got = new Promise(resolve => { globalThis.postMessage = (m) => resolve(m); });
	await import(modulePath + "?v=" + Date.now());
	if (typeof globalThis.onmessage !== "function") throw new Error(`${modulePath}: onmessage not installed`);
	globalThis.onmessage({ data });
	return Promise.race([got, new Promise(resolve => setTimeout(() => resolve("TIMEOUT"), ms))]);
}
const enc = (name, opts = {}) => runWorker(new URL(`../src/encoder/${name}.js`, import.meta.url).href, { buf: src.arrayBuffer.slice(0), name: "two", opts });
const dec = (name, file, extra = {}) => runWorker(new URL(`../src/decoder/${name}.js`, import.meta.url).href, { file, name: "two", precision: 6, encoding: "utf8", ...extra });

// ---- fgb：settle・File・往復 ----
{
	const f = await enc("fgb");
	ok(f !== "TIMEOUT", "fgb encoder が settle する（旧＝永久 hang）");
	ok(f instanceof File && f.size > 0 && f.name === "two.fgb", `fgb: File が返る（${f && f.size} B）`);
	const back = await dec("fgb", f);
	ok(back && back.type === "fgbdec" && back.data instanceof ArrayBuffer, "fgb decoder が読み戻す");
	if (back?.data) {
		const pbf = await new GeoPBF().set(back.data);
		ok(pbf.length === 4, `fgb 往復で 4 地物（${pbf.length}）`);
		const b = pbf.bbox;
		ok(Math.abs(b[0] - 139) < 1e-6 && Math.abs(b[2] - 141) < 1e-6 && Math.abs(b[3] - 36) < 1e-6, `fgb 往復で bbox 保存（${b.map(v => v.toFixed(3))}）`);
	}
}

// ---- shape：settle・zip File・往復（型ごとに分割された shp の読み戻し）----
{
	const f = await enc("shape");
	ok(f !== "TIMEOUT", "shape encoder が settle する（旧＝永久 hang）");
	ok(f instanceof File && f.size > 0 && f.name === "two.zip", `shape: zip File が返る（${f && f.size} B）`);
	const back = await dec("shape", f);
	ok(back && back.type === "shpdec" && back.data instanceof ArrayBuffer, "shape decoder が読み戻す");
	if (back?.data) {
		const pbf = await new GeoPBF().set(back.data);
		ok(pbf.length === 4, `shape 往復で 4 地物（${pbf.length}・point/polyline/polygon の 3 ファイル）`);
		const names = new Set(Array.from({ length: pbf.length }, (_, i) => pbf.getProperties(i).n));
		ok(["A", "B", "L", "P"].every(n => names.has(n)), `shape 往復で属性 n 保存（${[...names].join(",")}）`);
	}
}

// ---- 残りの encoder も「必ず settle・File を返す」----
for (const [name, ext] of [["geojson", "two.geojson"], ["topojson", "two.topojson"], ["gpx", "two.gpx"], ["gml", "two.gml"], ["kmz", "two.kmz"], ["geopbf", "two.geopbf"]]) {
	const gintbuf = name === "topojson" ? topology(src) : undefined;   // topojson は gint 前提＝WASM で焼いて渡す
	const f = await runWorker(new URL(`../src/encoder/${name}.js`, import.meta.url).href, { buf: src.arrayBuffer.slice(0), name: "two", opts: {}, gintbuf });
	ok(f !== "TIMEOUT" && f instanceof File && f.size > 0 && f.name === ext, `${name} encoder: settle＋File（${f && f.name} ${f && f.size} B）`);
}

// ---- 失敗経路：壊れた buf でも必ず settle（空データセットの File か、明示の null）----
for (const name of ["fgb", "shape"]) {
	const r = await runWorker(new URL(`../src/encoder/${name}.js`, import.meta.url).href, { buf: new Uint8Array([1, 2, 3]).buffer, name: "broken", opts: {} });
	ok(r !== "TIMEOUT" && (r === null || r instanceof File), `${name} encoder: 壊れた入力でも settle（${r === "TIMEOUT" ? "TIMEOUT" : r === null ? "null" : "File " + r.size + " B"}）`);
}

console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
