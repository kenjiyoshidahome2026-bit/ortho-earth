// t-validate: 符号化の検証層（改良点 ⑧'・options.validate＝"lenient"（既定）／"strict"）＝黙った欠損を無くす。
// 幾何なし・空の座標・壊れた座標（NaN）・緯度の範囲外・退化した環・NaN／Infinity の属性・単要素の Multi・GeometryCollection の空要素を、
// lenient＝直すか落として（緯度の範囲外は数えるだけ）pbf.issues／issueCount に残す、strict＝最初の問題で throw。"legacy"（1.19 までの挙動）は 2.0 で撤去＝lenient に落ちる
globalThis.ImageData ??= class ImageData { };
import { GeoPBFBase } from "../src/pbf-base.ts";
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const F = (type, coordinates, properties = {}) => ({ type: "Feature", properties, geometry: coordinates === null ? null : { type, coordinates } });
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const enc = (features, options = {}) => new GeoPBFBase({ name: "t-validate", ...options }).set({ type: "FeatureCollection", features });
const warns = []; const origWarn = console.warn; console.warn = (...a) => warns.push(a.join(" "));

const features = [
	F("Polygon", [sq(139, 35, 139.1, 35.1)], { v: 1 }),                       // 0 正常
	F("Point", null, { v: 2 }),                                                 // 1 幾何なし
	F("Point", [], { v: 3 }),                                                   // 2 空の点
	F("Point", [139.5, NaN], { v: 4 }),                                         // 3 壊れた座標
	F("Point", [139.5, 95], { v: 5 }),                                          // 4 緯度の範囲外
	F("LineString", [[139, 35], [139, 35]], { v: 6 }),                          // 5 同じ 2 点＝正常（dedupe は書く側）
	F("Polygon", [sq(139, 35, 139.1, 35.1), [[139.02, 35.02], [139.03, 35.03]]], { v: 7 }),   // 6 穴が退化（2 点）＝穴だけ落ちる
	F("Polygon", [[[139, 35], [139.1, 35]]], { v: 8 }),                        // 7 外環が退化＝地物が落ちる
	F("Point", [139.2, 35.2], { v: NaN, w: Infinity, s: "x", n: { a: -Infinity, b: 1 } }),   // 8 NaN／Infinity の属性
	F("MultiPolygon", [[sq(139, 35, 139.1, 35.1)]], { v: 10 }),                // 9 単要素の Multi
	{ type: "Feature", properties: { v: 11 }, geometry: { type: "GeometryCollection", geometries: [{ type: "Point", coordinates: [] }, { type: "Point", coordinates: [139, 35] }] } },   // 10 GC の空要素
	F("MultiLineString", [[[139, 35], [139.1, 35.1]], [[1, 1]]], { v: 12 }),    // 11 片方の線が 1 点
	F("LineString", [[139, 35], [NaN, 35], [139.1, 35.1]], { v: 13 }),          // 12 途中の壊れた位置＝落として続く
];
// ── lenient（既定）──
{
	const p = await enc(features.map(f => structuredClone(f)));
	ok(p.length === 9, `lenient: 13 → ${p.length} 地物（幾何なし・空の点・壊れた点・外環退化を落とす）`);
	const C = p.issueCount;
	ok(C.nullGeometry === 1 && C.emptyCoords === 3 && C.badCoordinate === 2 && C.latitude === 1 && C.degenerateRing === 2 && C.badNumber === 3 && C.multiDegraded === 2,   // emptyCoords＝Point []・GC の子・MultiLineString の 1 点の線、multiDegraded＝9 と 11（片方が落ちて単数へ）
		`lenient: issueCount ${JSON.stringify(C)}`);
	ok(p.issues.length === 14 && p.issues[0].kind === "nullGeometry" && p.issues[0].index === 1, `lenient: issues（${p.issues.length} 件・先頭 ${JSON.stringify(p.issues[0])}）`);
	const vs = p.geojson.features.map(f => f.properties.v);
	ok(vs.join() === "1,5,6,7,,10,11,12,13", `lenient: 残った地物の v＝${vs.join()}`);
	const g4 = p.geojson.features[1].geometry; ok(g4.coordinates[1] === 95 && C.latitude === 1, `lenient: 緯度 95 は数えるだけで値は不変（${g4.coordinates[1]}）`);
	const g6 = p.geojson.features[3].geometry; ok(g6.coordinates.length === 1, `lenient: 退化した穴だけ落ちる（環 ${g6.coordinates.length}）`);
	const pr = p.geojson.features[4].properties; ok(pr.v === undefined && pr.w === undefined && pr.s === "x" && pr.n?.b === 1 && pr.n?.a === undefined, `lenient: NaN／Infinity の属性は無し（${JSON.stringify(pr)}）`);
	const g10 = p.geojson.features[6].geometry; ok(g10.type === "GeometryCollection" && g10.geometries.length === 1, `lenient: GC の空要素を落とす（${g10.geometries.length}）`);
	const g11 = p.geojson.features[7].geometry; ok(g11.type === "LineString", `lenient: MultiLineString の片方が落ちて 1 本＝LineString へ（${g11.type}）`);
	const g12 = p.geojson.features[8].geometry; ok(g12.coordinates.length === 2, `lenient: 途中の壊れた位置を落として続く（${g12.coordinates.length} 点）`);
	ok(warns.some(w => /issue\(s\)/.test(w)) && warns.filter(w => /issue\(s\)/.test(w)).length === 1, `lenient: warn は 1 行（${warns.length}）`);
	ok(p.dropped === 4, `lenient: dropped ${p.dropped}`);
}
// ── strict ──
{
	let err = null; try { await enc(features.map(f => structuredClone(f)), { validate: "strict" }); } catch (e) { err = e; }
	ok(err && err.issue?.kind === "nullGeometry" && err.issue.index === 1 && /feature 1/.test(err.message), `strict: 最初の問題で throw（${err?.message}）`);
	let e2 = null; try { await enc([features[0], features[8]].map(f => structuredClone(f)), { validate: "strict" }); } catch (e) { e2 = e; }
	ok(e2 && e2.issue?.kind === "badNumber", `strict: NaN の属性で throw（${e2?.issue?.kind}）`);
	const okp = await enc([features[0], features[9]].map(f => structuredClone(f)), { validate: "strict" });
	ok(okp.length === 2 && okp.issueCount.multiDegraded === 1, "strict: 単要素の Multi は問題ではない（数えるだけ）");
}
// ── "legacy" は撤去（2.0）＝未知の値は lenient に落ちる ──
{
	const p = await enc([features[2], features[0]].map(f => structuredClone(f)), { validate: "legacy" });
	ok(p.validate === "lenient" && p.length === 1 && p.issueCount.emptyCoords === 1, `validate:"legacy" は lenient として動く（Point の [] は落ちて数える・${p.validate}）`);
}
// ── issues の上限 100 ──
{
	const many = []; for (let i = 0; i < 300; i++) many.push(F("Point", [], { v: i }));
	const p = await enc(many);
	ok(p.issues.length === 100 && p.issueCount.emptyCoords === 300 && p.length === 0, `issues は 100 件まで・count は全部（${p.issues.length}／${p.issueCount.emptyCoords}）`);
}
console.warn = origWarn;
console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
