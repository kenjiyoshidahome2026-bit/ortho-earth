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

// ---- gpx：trkpt/rtept の ele・time が属性配列で残り、往復で戻る（旧＝trk の ele/time を全て捨てていた・2026-09-17）----
{
	const gpxText = `<?xml version="1.0"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="35.5" lon="139.5"><ele>12.5</ele><time>2026-09-17T01:00:00Z</time><name>A&amp;B</name><type>peak</type></wpt>
<trk><name>Run &quot;1&quot;</name><type>running</type>
  <trkseg>
    <trkpt lat="35.1" lon="139.1"><ele>10</ele><time>2026-09-17T02:00:00Z</time></trkpt>
    <trkpt lon="139.2"
           lat="35.2"><ele>11</ele><time>2026-09-17T02:00:10Z</time></trkpt>
    <trkpt lat="35.3" lon="139.3" />
  </trkseg>
  <trkseg>
    <trkpt lat="35.4" lon="139.4"><ele>13</ele><time>2026-09-17T02:01:00Z</time></trkpt>
    <trkpt lat="35.5" lon="139.5"><ele>14</ele><time>2026-09-17T02:01:10Z</time></trkpt>
  </trkseg>
</trk>
<rte><name>Plan</name><rtept lat="36" lon="140"><ele>100</ele></rtept><rtept lat="36.1" lon="140.1"><ele>101</ele></rtept></rte>
</gpx>`;
	const back = await dec("gpx", new File([gpxText], "trip.gpx", { type: "application/gpx+xml" }));
	ok(back && back.type === "gpxdec" && back.data instanceof ArrayBuffer, "gpx decoder が読む");
	const pbf = await new GeoPBF().set(back.data);
	ok(pbf.length === 3, `gpx: wpt + trk + rte で 3 地物（${pbf.length}）`);
	const [w, t, r] = [0, 1, 2].map(i => pbf.getFeature(i));
	ok(w.properties.name === "A&B" && w.properties.ele === 12.5 && w.properties.time === "2026-09-17T01:00:00Z", `gpx: wpt の name を unescape・ele/time 保持（${JSON.stringify(w.properties)}）`);
	ok(t.geometry.type === "MultiLineString" && t.geometry.coordinates[0].length === 3 && t.properties.name === 'Run "1"', `gpx: trk が 2 trkseg の MultiLineString・lat/lon 逆順の点も拾う（${t.geometry.type} ${t.geometry.coordinates.map(s => s.length)}）`);
	ok(JSON.stringify(t.properties.ele) === "[[10,11,null],[13,14]]", `gpx: trk の ele が trkseg ごとの入れ子配列（${JSON.stringify(t.properties.ele)}）`);
	ok(JSON.stringify(t.properties.time) === JSON.stringify([["2026-09-17T02:00:00Z", "2026-09-17T02:00:10Z", null], ["2026-09-17T02:01:00Z", "2026-09-17T02:01:10Z"]]), `gpx: trk の time が入れ子配列（${JSON.stringify(t.properties.time)}）`);
	ok(r.geometry.type === "LineString" && r.properties.route === true && JSON.stringify(r.properties.ele) === "[100,101]" && r.properties.time == null, `gpx: rte が route:true の LineString・ele 平配列・time 無しは省く（${JSON.stringify(r.properties)}）`);

	// 書き戻し → 再読み込みで同じになる
	const f = await runWorker(new URL("../src/encoder/gpx.js", import.meta.url).href, { buf: back.data.slice(0), name: "trip", opts: {} });
	ok(f instanceof File && f.size > 0, `gpx encoder: File（${f && f.size} B）`);
	const xml = await f.text();
	ok(/<trkpt lat="35.2" lon="139.2"><ele>11<\/ele><time>2026-09-17T02:00:10Z<\/time><\/trkpt>/.test(xml), "gpx encoder: trkpt に ele/time を書く");
	ok(/<trkpt lat="35.3" lon="139.3" \/>/.test(xml), "gpx encoder: ele/time の無い点は自己閉じ");
	ok(/<rte>[\s\S]*<rtept lat="36" lon="140"><ele>100<\/ele><\/rtept>/.test(xml) && !/<rte>[\s\S]*<trkseg>[\s\S]*<\/rte>/.test(xml), "gpx encoder: route:true は <rte>/<rtept>");
	ok(/<name>A&amp;B<\/name>/.test(xml) && /<name>Run &quot;1&quot;<\/name>/.test(xml), "gpx encoder: name を escape");
	const back2 = await dec("gpx", f);
	const pbf2 = await new GeoPBF().set(back2.data);
	const same = [0, 1, 2].every(i => JSON.stringify(pbf.getFeature(i)) === JSON.stringify(pbf2.getFeature(i)));
	ok(pbf2.length === 3 && same, "gpx: 往復（decode → encode → decode）で幾何・属性が一致");
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
