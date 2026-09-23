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
let runSeq = 0;
async function runWorker(modulePath, data, ms = 8000) {
	globalThis.onmessage = null;
	const got = new Promise(resolve => { globalThis.postMessage = (m) => resolve(m); });
	await import(modulePath + "?v=" + (++runSeq));   // 連番＝同じミリ秒に 2 回叩くと Date.now では同じ URL＝キャッシュされた module で onmessage が張られなかった（2026-09-23）
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

// ---- gpx：属性の引用符は ' も・CDATA は中身（旧＝lat='…' は 0 地物・名前が <![CDATA[…]]> のまま・2026-09-23）----
{
	const g = `<?xml version='1.0' encoding='UTF-8'?>
<gpx version='1.1' creator='x' xmlns='http://www.topografix.com/GPX/1/1'>
<wpt lat='35.1' lon='139.1'><name><![CDATA[Café & Bar <1>]]></name><desc>A &amp; <![CDATA[B&amp;C]]></desc></wpt>
<trk><name><![CDATA[Morning Run]]></name><trkseg>
<trkpt lat='35.2' lon='139.2'><ele>10</ele><time>2026-09-17T02:00:00Z</time></trkpt>
<trkpt lon="139.3" lat='35.3'><ele>11</ele></trkpt>
</trkseg></trk></gpx>`;
	const r = await dec("gpx", new File([g], "q.gpx"));
	const pbf = await new GeoPBF().set(r.data);
	const w = pbf.getFeature(0), t = pbf.getFeature(1);
	ok(pbf.length === 2 && t.geometry.coordinates.length === 2, `gpx: 単引用符の lat/lon を読む（${pbf.length} 地物・${t.geometry.coordinates.length} 点）`);
	ok(w.properties.name === "Café & Bar <1>" && t.properties.name === "Morning Run", `gpx: CDATA は中身（${w.properties.name} / ${t.properties.name}）`);
	ok(w.properties.desc === "A & B&amp;C", `gpx: CDATA の外だけ逃がしを戻す（${w.properties.desc}）`);
}

// ---- czml：referenceFrame INERTIAL＝標本の時刻で地球固定へ（歳差＋恒星時）。旧＝ECEF として読み経度が恒星時の分だけ回っていた（2026-09-23）----
{
	const { czmlToFeatures, inertialToFixed, ecefToLLH } = await import("../src/modules/czml.js");
	const R = 6778137;
	const lon0 = ecefToLLH(...inertialToFixed(R, 0, 0, Date.parse("2000-01-01T12:00:00Z")))[0];
	ok(Math.abs(lon0 - 79.539) < 0.002, `czml: J2000.0 の慣性 x 軸（春分点）＝GMST 280.46° の反対＝79.539°E（${lon0.toFixed(4)}）`);
	const lat1 = ecefToLLH(...inertialToFixed(0, 0, R, Date.parse("2026-09-23T00:00:00Z")))[1];
	ok(Math.abs(lat1 - (90 - 0.148)) < 0.003, `czml: J2000 の極は 2026 年に歳差 θ≈0.148° だけ傾く（${lat1.toFixed(4)}）`);
	const { features } = czmlToFeatures([{ id: "document", version: "1.0" }, { id: "sat", position: { referenceFrame: "INERTIAL", epoch: "2000-01-01T12:00:00Z", cartesian: [0, R, 0, 0, 60, R, 0, 0] } }]);
	const c = features[0].geometry.coordinates;
	ok(Math.abs(c[0][0] - 79.539) < 0.002 && Math.abs((c[0][0] - c[1][0]) - 0.2507) < 0.002, `czml: INERTIAL の標本は時刻ごとに回る（60 秒で西へ 0.2507°＝地球の自転）（${c.map(q => q[0].toFixed(4))}）`);
	ok(!features[0].properties.czml?.position?.referenceFrame, "czml: 地球固定へ直したら書き戻しに INERTIAL を残さない");
	const st = czmlToFeatures([{ id: "s", position: { referenceFrame: "INERTIAL", cartesian: [R, 0, 0] } }]).features[0];
	ok(st.properties.czml?.position?.referenceFrame === "INERTIAL", "czml: 時刻の無い静的な INERTIAL は回せない＝referenceFrame を温存");
}

// ---- czml：Cesium CZML の往復（静的パケットは等価・sampled position は LineString + time 配列・ECEF は経緯度へ）2026-09-17 ----
{
	const { ecefToLLH, featureToPackets } = await import("../src/modules/czml.js");
	const A = 6378137, E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563), rad = Math.PI / 180;
	const ecef = (lon, lat, h) => { const s = Math.sin(lat * rad), N = A / Math.sqrt(1 - E2 * s * s); return [(N + h) * Math.cos(lat * rad) * Math.cos(lon * rad), (N + h) * Math.cos(lat * rad) * Math.sin(lon * rad), (N * (1 - E2) + h) * s]; };
	{
		const [lon, lat, h] = ecefToLLH(...ecef(139.7, 35.7, 1234.5));
		ok(Math.abs(lon - 139.7) < 1e-9 && Math.abs(lat - 35.7) < 1e-9 && Math.abs(h - 1234.5) < 1e-3, `czml: ECEF → WGS84 経緯度・高さ（${lon.toFixed(9)} ${lat.toFixed(9)} ${h.toFixed(4)}）`);
	}
	const czml = [
		{ id: "document", name: "Trip", version: "1.0", description: "a scene", clock: { interval: "2026-09-17T00:00:00Z/2026-09-17T01:00:00Z" } },
		{ id: "pt", name: "Tokyo", availability: "2026-09-17T00:00:00Z/2026-09-17T01:00:00Z", position: { cartographicDegrees: [139.7, 35.7, 40] }, billboard: { image: "x.png", scale: 1.5 }, properties: { kind: "city", pop: 14000000, score: { number: [0, 1, 3600, 2] } } },
		{ id: "sat", position: { epoch: "2026-09-17T00:00:00Z", interpolationAlgorithm: "LAGRANGE", interpolationDegree: 5, cartographicDegrees: [0, 139, 35, 500000, 60, 140, 36, 500000, 120, 141, 37, 500000] }, path: { width: 2 } },
		{ id: "ln", polyline: { positions: { cartesian: [...ecef(139, 35, 0), ...ecef(140, 36, 100)] }, width: 3, material: { solidColor: { color: { rgba: [255, 0, 0, 255] } } } } },
		{ id: "pg", polygon: { positions: { cartographicDegrees: [139, 35, 0, 140, 35, 0, 140, 36, 0, 139, 36, 0] }, holes: { cartographicDegrees: [[139.4, 35.4, 0, 139.6, 35.4, 0, 139.6, 35.6, 0, 139.4, 35.6, 0]] }, material: { solidColor: { color: { rgba: [0, 255, 0, 128] } } } } },
		{ id: "rc", rectangle: { coordinates: { wsenDegrees: [130, 30, 131, 31] }, fill: true } },
		{ id: "ref", position: { reference: "pt#position" }, point: { pixelSize: 5 } },   // 参照＝幾何を持たない＝落ちる
	];
	const back = await dec("czml", new File([JSON.stringify(czml)], "trip.czml", { type: "application/json" }));
	ok(back && back.type === "czmldec" && back.data instanceof ArrayBuffer, "czml decoder が読む");
	const pbf = await new GeoPBF().set(back.data);
	ok(pbf.length === 5 && pbf.name() === "Trip" && pbf.description() === "a scene", `czml: 参照だけのパケットを落として 5 地物・document の name/description がヘッダ（${pbf.length} ${pbf.name()} ${pbf.description()}）`);
	const byId = {}; for (let i = 0; i < pbf.length; i++) { const f = pbf.getFeature(i); byId[f.properties.id] = f; }
	const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
	{
		const { geometry: g, properties: p } = byId.pt;
		ok(g.type === "Point" && near(g.coordinates[0], 139.7) && p.ele === 40 && p.name === "Tokyo" && p.kind === "city" && p.pop === 14000000 && p.availability === czml[1].availability, `czml: 静的 position → Point・ele・availability・スカラー properties（${JSON.stringify(p)}）`);
		ok(p.czml.billboard.scale === 1.5 && p.czml.properties.score.number.length === 4, "czml: billboard と時系列 properties は czml 属性に温存");
	}
	{
		const { geometry: g, properties: p } = byId.sat;
		ok(g.type === "LineString" && g.coordinates.length === 3 && JSON.stringify(p.time) === JSON.stringify(["2026-09-17T00:00:00.000Z", "2026-09-17T00:01:00.000Z", "2026-09-17T00:02:00.000Z"]), `czml: sampled position → LineString + time 配列（epoch + 秒を ISO へ）（${JSON.stringify(p.time)}）`);
		ok(JSON.stringify(p.ele) === "[500000,500000,500000]" && p.czml.position.interpolationAlgorithm === "LAGRANGE" && p.czml.path.width === 2, "czml: 高さ配列・補間指定・path を温存");
	}
	{
		const { geometry: g, properties: p } = byId.ln;
		ok(g.type === "LineString" && near(g.coordinates[0][0], 139) && near(g.coordinates[1][1], 36) && near(p.ele[0], 0, 1e-3) && near(p.ele[1], 100, 1e-3) && p.czml.polyline.width === 3, `czml: cartesian（ECEF）の polyline → 経緯度 LineString・ele（${JSON.stringify(g.coordinates)} ${JSON.stringify(p.ele)}）`);
	}
	{
		const { geometry: g, properties: p } = byId.pg;
		ok(g.type === "Polygon" && g.coordinates.length === 2 && g.coordinates[0].length === 5 && g.coordinates[1].length === 5 && p.ele == null && p.czml.polygon.material, `czml: polygon + holes → 2 環の閉じた Polygon・全点 0 なら ele 無し（${g.coordinates.map(r => r.length)}）`);
	}
	{
		const { geometry: g, properties: p } = byId.rc;
		ok(g.type === "Polygon" && g.coordinates[0].length === 5 && p.czml.rectangle.fill === true, "czml: rectangle → 4 隅の Polygon・czml.rectangle を温存");
	}

	// 書き戻し
	const f = await runWorker(new URL("../src/encoder/czml.js", import.meta.url).href, { buf: back.data.slice(0), name: "trip", opts: {} });
	ok(f instanceof File && f.size > 0 && f.name === "trip.czml", `czml encoder: File（${f && f.name} ${f && f.size} B）`);
	const out = JSON.parse(await f.text());
	const pk = Object.fromEntries(out.map(q => [q.id, q]));
	ok(out[0].id === "document" && out[0].name === "Trip" && out[0].description === "a scene" && out[0].version === "1.0", "czml encoder: 先頭が document パケット");
	ok(JSON.stringify(pk.pt.position.cartographicDegrees) === "[139.7,35.7,40]" && pk.pt.billboard.scale === 1.5 && pk.pt.properties.kind === "city" && pk.pt.properties.score.number.length === 4 && pk.pt.availability === czml[1].availability && pk.pt.point === undefined, "czml encoder: Point → position + billboard + properties（visual があれば既定の point は足さない）");
	ok(pk.sat.position.epoch === "2026-09-17T00:00:00.000Z" && JSON.stringify(pk.sat.position.cartographicDegrees) === JSON.stringify(czml[2].position.cartographicDegrees) && pk.sat.position.interpolationAlgorithm === "LAGRANGE" && pk.sat.path.width === 2 && pk.sat.point?.pixelSize === 8, `czml encoder: time 配列の線 → sampled position（epoch + 秒）・visual 無しなら既定の point（${JSON.stringify(pk.sat.position)}）`);
	ok(pk.ln.polyline.positions.cartographicDegrees.length === 6 && pk.ln.polyline.width === 3 && near(pk.ln.polyline.positions.cartographicDegrees[5], 100, 1e-3), "czml encoder: LineString → polyline（cartographicDegrees・高さ付き）");
	ok(pk.pg.polygon.positions.cartographicDegrees.length === 12 && pk.pg.polygon.holes.cartographicDegrees[0].length === 12 && pk.pg.polygon.material, "czml encoder: Polygon → polygon（環を開く）+ holes");
	ok(JSON.stringify(pk.rc.rectangle.coordinates.wsenDegrees) === "[130,30,131,31]" && pk.rc.rectangle.fill === true && pk.rc.polygon === undefined, "czml encoder: czml.rectangle が残っていれば rectangle に戻す");

	// 再読み込みで一致（sat は既定の point が足された分だけ増える）
	const back2 = await dec("czml", f);
	const pbf2 = await new GeoPBF().set(back2.data);
	const byId2 = {}; for (let i = 0; i < pbf2.length; i++) { const q = pbf2.getFeature(i); byId2[q.properties.id] = q; }
	ok(byId2.sat?.properties.czml.point?.pixelSize === 8, "czml: 2 周目の sat に既定の point");
	delete byId2.sat.properties.czml.point;
	const same = ["pt", "sat", "ln", "pg", "rc"].filter(id => JSON.stringify(byId[id]) !== JSON.stringify(byId2[id]));
	ok(pbf2.length === 5 && same.length === 0, `czml: 往復（decode → encode → decode）で幾何・属性が一致${same.length ? "（不一致: " + same.join(",") + "）" : ""}`);

	// GPX の trk（MultiLineString + 入れ子の time/ele）→ 1 本の sampled position
	const trk = { type: "Feature", geometry: { type: "MultiLineString", coordinates: [[[139.1, 35.1], [139.2, 35.2]], [[139.4, 35.4]]] },
		properties: { name: "Run", ele: [[10, null], [13]], time: [["2026-09-17T02:00:00Z", "2026-09-17T02:00:10Z"], ["2026-09-17T02:01:00Z"]], type: "running" } };
	const [tp] = featureToPackets(trk, 7);
	ok(tp.id === "feature-7" && tp.name === "Run" && tp.position.epoch === "2026-09-17T02:00:00.000Z" && JSON.stringify(tp.position.cartographicDegrees) === "[0,139.1,35.1,10,10,139.2,35.2,0,60,139.4,35.4,13]" && tp.properties.type === "running", `czml: GPX trk（MultiLineString + time）→ sampled position 1 本（${JSON.stringify(tp.position.cartographicDegrees)}）`);
	const [a, b] = featureToPackets({ type: "Feature", geometry: { type: "MultiLineString", coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }, properties: { name: "X" } }, 0);
	ok(a.id === "feature-0:0" && b.id === "feature-0:1" && a.polyline.positions.cartographicDegrees.length === 6, "czml: time 無しの MultiLineString → 部品ごとの polyline パケット（id に :n）");
}

// ---- 残りの encoder も「必ず settle・File を返す」----
for (const [name, ext] of [["geojson", "two.geojson"], ["topojson", "two.topojson"], ["gpx", "two.gpx"], ["czml", "two.czml"], ["gml", "two.gml"], ["kmz", "two.kmz"], ["geopbf", "two.geopbf"]]) {
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
