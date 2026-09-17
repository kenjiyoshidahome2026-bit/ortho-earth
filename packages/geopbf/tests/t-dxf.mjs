#!/usr/bin/env node
// t-dxf: DXF（ASCII）→ GeoPBF。手書きの最小 DXF で、エンティティ種別（POINT/LINE/LWPOLYLINE+bulge/POLYLINE/CIRCLE/ARC/ELLIPSE/SPLINE/TEXT/MTEXT/SOLID）、
// INSERT（拡縮・回転・入れ子・列配置・レイヤ 0 の継承）、レイヤ表の色、座標系（省略＝経緯度とみなす／EPSG 6677／単位 mm／crs 無しの拒否／ignoreCrs）、Shift_JIS、worker、CLI。
globalThis.ImageData ??= class ImageData { };
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { GeoPBF } from "../src/pbf.js";
import { fromDxf, readDxf } from "../src/convert/dxf.js";
import { epsgToWKT } from "../src/convert/epsg.js";
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearPt = (p, q, eps = 1e-6) => near(p[0], q[0], eps) && near(p[1], q[1], eps);
// ── 最小 DXF の組み立て（code/value の対を改行で並べる）──
const P = (...pairs) => pairs.map(([c, v]) => `${c}\n${v}`).join("\n") + "\n";
const E = (type, ...pairs) => P([0, type], ...pairs);
const dxf = ({ header = [], layers = [], blocks = "", entities = "" }) =>
	P([0, "SECTION"], [2, "HEADER"]) + header.map(([n, c, v, v2]) => v2 === undefined ? P([9, n], [c, v]) : P([9, n], [c, v], [20, v2])).join("") + P([0, "ENDSEC"]) +
	P([0, "SECTION"], [2, "TABLES"], [0, "TABLE"], [2, "LAYER"], [70, layers.length]) + layers.map(([n, col]) => E("LAYER", [2, n], [70, 0], [62, col], [6, "CONTINUOUS"])).join("") + P([0, "ENDTAB"], [0, "ENDSEC"]) +
	P([0, "SECTION"], [2, "BLOCKS"]) + blocks + P([0, "ENDSEC"]) +
	P([0, "SECTION"], [2, "ENTITIES"]) + entities + P([0, "ENDSEC"], [0, "EOF"]);
const byType = (f, t) => f.filter(x => x.properties.type === t);

// ── ① 経緯度の図面（CRS 無し＝範囲から経緯度とみなす）・全エンティティ ──
{
	const src = dxf({
		header: [["$ACADVER", 1, "AC1015"], ["$INSUNITS", 70, 0], ["$EXTMIN", 10, 139, 35], ["$EXTMAX", 10, 141, 37]],
		layers: [["road", 1], ["0", 7]],
		blocks: E("BLOCK", [8, "0"], [2, "B1"], [70, 0], [10, 0], [20, 0]) + E("LINE", [8, "0"], [10, 0], [20, 0], [11, 1], [21, 0]) + E("POINT", [8, "pin"], [10, 0], [20, 0]) + E("ENDBLK") +
			E("BLOCK", [2, "B2"], [10, 0], [20, 0]) + E("INSERT", [8, "0"], [2, "B1"], [10, 0], [20, 0.5]) + E("ENDBLK"),
		entities:
			E("POINT", [8, "road"], [5, "A1"], [10, 139.5], [20, 35.5]) +
			E("LINE", [8, "road"], [62, 3], [6, "DASHED"], [10, 139], [20, 35], [11, 140], [21, 36]) +
			E("LWPOLYLINE", [8, "road"], [90, 3], [70, 0], [10, 139], [20, 35], [42, 1], [10, 139.2], [20, 35], [10, 139.4], [20, 35]) +   // 先頭辺は半円（bulge 1）
			E("LWPOLYLINE", [8, "road"], [90, 4], [70, 1], [10, 139], [20, 35], [10, 140], [20, 35], [10, 140], [20, 36], [10, 139], [20, 36]) +   // 閉＝面
			E("POLYLINE", [8, "road"], [70, 1]) + E("VERTEX", [10, 0], [20, 0]) + E("VERTEX", [10, 1], [20, 0]) + E("VERTEX", [10, 1], [20, 1]) + E("SEQEND") +
			E("CIRCLE", [8, "road"], [10, 139.5], [20, 35.5], [40, 0.1]) +
			E("ARC", [8, "road"], [10, 139.5], [20, 35.5], [40, 0.1], [50, 0], [51, 90]) +
			E("ELLIPSE", [8, "road"], [10, 139.5], [20, 35.5], [11, 0.2], [21, 0], [40, 0.5], [41, 0], [42, 6.283185307179586]) +
			E("SPLINE", [8, "road"], [70, 0], [71, 3], [72, 8], [73, 4], [40, 0], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [40, 1], [10, 0], [20, 0], [10, 0], [20, 1], [10, 1], [20, 1], [10, 1], [20, 0]) +
			E("TEXT", [8, "0"], [10, 139.6], [20, 35.6], [40, 2.5], [50, 30], [1, "駅"]) +
			E("MTEXT", [8, "0"], [10, 139.7], [20, 35.7], [40, 1], [3, "one\\P"], [1, "two"]) +
			E("SOLID", [8, "0"], [10, 0], [20, 0], [11, 1], [21, 0], [12, 0], [22, 1], [13, 1], [23, 1]) +
			E("INSERT", [8, "ins"], [2, "B1"], [10, 10], [20, 20], [41, 2], [42, 2], [50, 90]) +
			E("INSERT", [8, "ins2"], [2, "B2"], [10, 100], [20, 100]) +
			E("INSERT", [8, "arr"], [2, "B1"], [10, 50], [20, 50], [70, 2], [71, 1], [44, 3], [45, 0]) +
			E("HATCH", [8, "0"]) + E("DIMENSION", [8, "0"]),
	});
	const r = readDxf(src);
	ok(r.header.acadver === "AC1015" && r.header.insunits === 0 && r.header.extmin[0] === 139 && r.layers.map(l => `${l.name}:${l.color}`).join() === "road:1,0:7" && r.blocks.join() === "B1,B2", "readDxf: ヘッダ・レイヤ表・ブロック");
	ok(r.counts.LWPOLYLINE === 2 && r.counts.INSERT === 3 && r.counts.VERTEX === 3 && r.entities === 21, `種別の数（${Object.entries(r.counts).map(([k, v]) => k + "×" + v).join(" ")}）`);
	const { pbf, stats } = await fromDxf(src, { name: "t", precision: 7 });
	const f = pbf.geojson.features;
	ok(stats.assumedLonLat && stats.crs.startsWith("assumed") && !stats.reprojected, "CRS 無し＝範囲から経緯度とみなす");
	ok(stats.skipped.HATCH === 1 && stats.skipped.DIMENSION === 1, "HATCH/DIMENSION は数えて飛ばす");
	const pt = byType(f, "POINT");
	ok(pt.length === 1 + 1 + 1 + 2 && nearPt(pt[0].geometry.coordinates, [139.5, 35.5]) && pt[0].properties.layer === "road" && pt[0].properties.color === 1 && pt[0].properties.handle === "A1", "POINT: 座標・layer・BYLAYER 色はレイヤ表から・handle");
	const ln = byType(f, "LINE");
	ok(ln[0].properties.color === 3 && ln[0].properties.linetype === "DASHED" && nearPt(ln[0].geometry.coordinates[1], [140, 36]), "LINE: 明示色・線種");
	const lw = byType(f, "LWPOLYLINE");
	ok(lw[0].geometry.type === "LineString" && lw[0].geometry.coordinates.length === 36 + 2 && nearPt(lw[0].geometry.coordinates[18], [139.1, 34.9], 1e-9) && nearPt(lw[0].geometry.coordinates[36], [139.2, 35]), `LWPOLYLINE: bulge 1＝半円（CCW＝弦の下へ膨らむ・頂点 ${lw[0].geometry.coordinates.length}・頂点 ${lw[0].geometry.coordinates[18]}）`);
	ok(lw[1].geometry.type === "Polygon" && lw[1].geometry.coordinates[0].length === 5 && nearPt(lw[1].geometry.coordinates[0][4], [139, 35]), "閉じた LWPOLYLINE＝Polygon（閉合点を足す）");
	const pl = byType(f, "POLYLINE");
	ok(pl.length === 1 && pl[0].geometry.type === "Polygon" && pl[0].geometry.coordinates[0].length === 4, "POLYLINE+VERTEX+SEQEND（閉）＝Polygon");
	const ci = byType(f, "CIRCLE")[0], ar = byType(f, "ARC")[0], el = byType(f, "ELLIPSE")[0];
	const has = (r, q) => r.some(p => nearPt(p, q));   // 環の向きはエンコーダが正規化する＝含む点で見る
	ok(ci.geometry.type === "Polygon" && ci.geometry.coordinates[0].length === 73 && nearPt(ci.geometry.coordinates[0][0], [139.6, 35.5]) && has(ci.geometry.coordinates[0], [139.5, 35.6]) && has(ci.geometry.coordinates[0], [139.4, 35.5]), "CIRCLE: 72 分割の面");
	ok(ar.geometry.type === "LineString" && ar.geometry.coordinates.length === 19 && nearPt(ar.geometry.coordinates[0], [139.6, 35.5]) && nearPt(ar.geometry.coordinates[18], [139.5, 35.6]), "ARC 0→90°");
	ok(el.geometry.type === "Polygon" && el.geometry.coordinates[0].length === 73 && nearPt(el.geometry.coordinates[0][0], [139.7, 35.5]) && has(el.geometry.coordinates[0], [139.5, 35.6]) && has(el.geometry.coordinates[0], [139.3, 35.5]), "ELLIPSE 全周＝面（長軸 0.2・比 0.5）");
	const sp = byType(f, "SPLINE")[0].geometry.coordinates;
	ok(nearPt(sp[0], [0, 0]) && nearPt(sp[sp.length - 1], [1, 0]) && nearPt(sp[16], [0.5, 0.75], 1e-6), `SPLINE: clamped 3 次＝Bezier（端点厳密・中点 ${sp[16]}）`);
	const tx = byType(f, "TEXT")[0].properties, mt = byType(f, "MTEXT")[0].properties;
	ok(tx.text === "駅" && tx.height === 2.5 && tx.rotation === 30 && mt.text === "one\ntwo", "TEXT/MTEXT: 文字・高さ・回転・\\P 改行");
	ok(byType(f, "SOLID")[0].geometry.coordinates[0].length === 5 && nearPt(byType(f, "SOLID")[0].geometry.coordinates[0][2], [1, 1]), "SOLID: 1,2,4,3 の順で面");
	// INSERT: B1 の LINE (0,0)-(1,0) を (10,20) に ×2・90° 回転 → (10,20)-(10,22)。block 内レイヤ 0 は INSERT のレイヤを継ぐ
	const ins = f.filter(x => x.properties.block === "B1" && x.properties.layer === "ins");
	const insLine = ins.find(x => x.properties.type === "LINE");
	ok(ins.length === 1 && insLine && nearPt(insLine.geometry.coordinates[0], [10, 20]) && nearPt(insLine.geometry.coordinates[1], [10, 22]), `INSERT: 拡縮 2・回転 90（${insLine?.geometry.coordinates[1]}）・レイヤ 0 は INSERT のレイヤを継ぐ`);
	ok(f.find(x => x.properties.block === "B1" && x.properties.type === "POINT" && x.properties.layer === "pin") !== undefined && !f.some(x => x.properties.type === "POINT" && x.properties.layer === "ins"), "block 内の明示レイヤ（pin）は保つ");
	const nest = f.filter(x => x.properties.layer === "ins2");
	ok(nest.length >= 1 && nest.some(x => x.properties.type === "LINE" && nearPt(x.geometry.coordinates[0], [100, 100.5])), `入れ子 INSERT（B2→B1・オフセット 0.5）（${nest.find(x => x.properties.type === "LINE")?.geometry.coordinates[0]}）`);
	const arr = f.filter(x => x.properties.layer === "arr" && x.properties.type === "LINE");
	ok(arr.length === 2 && nearPt(arr[1].geometry.coordinates[0], [53, 50]), "INSERT の列配置（2 列・間隔 3）");
	ok(stats.inserts === 4 && pbf.keys.join() === "block,color,handle,height,layer,linetype,rotation,text,type", `INSERT 展開 ${stats.inserts}（列配置は 1 回）・keys 固定`);
}
// ── ② 平面直角 IX（EPSG:6677）・mm 単位 ──
{
	const src = dxf({ header: [["$INSUNITS", 70, 4], ["$EXTMIN", 10, -12065988, -33275345], ["$EXTMAX", 10, -12065988, -33275345]], entities: E("POINT", [8, "0"], [10, -12065988.612833316], [20, -33275345.71413028]) });
	let threw = ""; try { await fromDxf(src); } catch (e) { threw = e.message; }
	ok(/unknown CRS/.test(threw) && /6677/.test(threw), "CRS 無し＋範囲外＝拒否（EPSG 番号を促す）");
	const r = await fromDxf(src, { crs: 6677 });
	ok(r.stats.reprojected && r.stats.unitScale === 0.001 && nearPt(r.pbf.geojson.features[0].geometry.coordinates, [139.7, 35.7], 2e-6), `EPSG:6677（mm→m 自動）→ ${r.pbf.geojson.features[0].geometry.coordinates}`);
	const r2 = await fromDxf(src, { crs: "EPSG:6677", unitScale: 0.001 });
	ok(nearPt(r2.pbf.geojson.features[0].geometry.coordinates, [139.7, 35.7], 2e-6), "文字列 EPSG:6677 と unitScale 明示");
	const r3 = await fromDxf(src, { crs: epsgToWKT(6677), unitScale: 0.001 });
	ok(nearPt(r3.pbf.geojson.features[0].geometry.coordinates, [139.7, 35.7], 2e-6), "WKT 文字列でも同じ");
	const r4 = await fromDxf(src, { ignoreCrs: true });
	ok(!r4.stats.reprojected && r4.stats.features === 1, "ignoreCrs＝図面座標のまま");
	threw = ""; try { await fromDxf(src, { crs: 99999 }); } catch (e) { threw = e.message; } ok(/not in the built-in table/.test(threw), "未収録 EPSG は拒否");
	// UTM 54N（EPSG:32654）＝(139.7,35.7) の東距/北距
	const utm = dxf({ header: [["$INSUNITS", 70, 6]], entities: E("POINT", [8, "0"], [10, 382388.694], [20, 3951453.574]) });
	const r5 = await fromDxf(utm, { crs: 32654 });
	ok(nearPt(r5.pbf.geojson.features[0].geometry.coordinates, [139.7, 35.7], 2e-6), `UTM 54N → ${r5.pbf.geojson.features[0].geometry.coordinates}`);
}
// ── ③ Shift_JIS・closedAsPolygon=false ──
{
	const head = dxf({ header: [["$EXTMIN", 10, 139, 35], ["$EXTMAX", 10, 140, 36]], entities: E("TEXT", [8, "0"], [10, 139], [20, 35], [1, "@@"]) + E("LWPOLYLINE", [8, "0"], [90, 3], [70, 1], [10, 0], [20, 0], [10, 1], [20, 0], [10, 1], [20, 1]) });
	const u8 = new TextEncoder().encode(head); const i = u8.indexOf(0x40);
	const sj = new Uint8Array(u8.length); sj.set(u8); sj[i] = 0x89; sj[i + 1] = 0x77;   // "駅" の Shift_JIS
	const r = await fromDxf(sj, { closedAsPolygon: false });
	ok(byType(r.pbf.geojson.features, "TEXT")[0].properties.text === "駅", "Shift_JIS の TEXT を自動判別");
	ok(byType(r.pbf.geojson.features, "LWPOLYLINE")[0].geometry.type === "LineString", "closedAsPolygon=false＝閉じた折線も LineString");
}
// ── ④ worker と CLI ──
{
	const src = dxf({ header: [["$EXTMIN", 10, 139, 35], ["$EXTMAX", 10, 140, 36]], entities: E("LINE", [8, "0"], [10, 139], [20, 35], [11, 140], [21, 36]) + E("HATCH", [8, "0"]) });
	globalThis.onmessage = null;
	const got = new Promise(resolve => { globalThis.postMessage = (m) => resolve(m); });
	await import("../src/decoder/dxf.js?v=" + Date.now());
	globalThis.onmessage({ data: { file: new File([src], "t.dxf"), name: "t", precision: 6 } });
	const r = await Promise.race([got, new Promise(res => setTimeout(() => res("TIMEOUT"), 8000))]);
	ok(r && r !== "TIMEOUT" && r.type === "dxfdec" && r.data instanceof ArrayBuffer && /assumed lon\/lat/.test(r.warning) && /HATCH×1/.test(r.warning), `decoder worker: ${r?.warning}`);
	if (r?.data) { const p = await new GeoPBF().set(r.data); ok(p.length === 1, "worker 経由 1 地物"); }
	const tmp = new URL("./fixtures/_t.dxf", import.meta.url).pathname; writeFileSync(tmp, src);
	const out = execFileSync("node", [new URL("../bin/geopbf.mjs", import.meta.url).pathname, "dxf2pbf", tmp], { encoding: "utf8", env: { ...process.env, GEOPBF_LANG: "en" } });
	ok(/entities 2/.test(out) && /LINE×1/.test(out), "CLI dxf2pbf の一覧");
	const outPbf = tmp.replace(/\.dxf$/, ".geopbf");
	const out2 = execFileSync("node", [new URL("../bin/geopbf.mjs", import.meta.url).pathname, "dxf2pbf", tmp, outPbf, "--crs", "4326"], { encoding: "utf8", env: { ...process.env, GEOPBF_LANG: "en" } });
	ok(/features 1/.test(out2) && /EPSG:4326/.test(out2), "CLI dxf2pbf --crs 4326 で変換");
	const { unlinkSync } = await import("node:fs"); unlinkSync(tmp); unlinkSync(outPbf);
}
console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
