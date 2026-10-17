// query.ts（queryRenderedFeatures／querySourceFeatures の当たりと GeoJSON 化）の検定。解読済みのタイルを cache に置く＝取得なし・外部データ不要。
//   ・点の当たり：面は中（穴は外）・線は線幅の半分＋許容・記号の点は +8px・円は半径＋縁・幅 0 の線は当たらない
//   ・箱の当たり：外接箱の重なり
//   ・層の選別：hidden・visibility none・layers・minzoom/maxzoom・層の filter・問い合わせの filter
//   ・並び：上の層から・点は最細のタイル 1 枚
//   ・promoteId・id・source・tile
//   ・toGeoJSON：Point／MultiPoint／LineString／MultiLineString／穴あき Polygon／MultiPolygon
//   ・sourceFeatures：filter・空のタイル
import { queryTiles, sourceFeatures } from "../src/query.ts";
import { tileLocalToLonLat } from "../src/tile.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const E = 4096, Z = 10, X = 900, Y = 400, KEY = `${Z}/${X}/${Y}`;
const ll = (px, py, z = Z, x = X, y = Y) => tileLocalToLonLat(x, y, z, px, py, E);
const ring = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
const hole = (x0, y0, x1, y1) => [x0, y0, x0, y1, x1, y1, x1, y0, x0, y0];   // 逆回り＝穴
const geom = (rings) => { const c = rings.flat(), ends = []; let n = 0; for (const r of rings) ends.push(n += r.length); return { coords: new Int32Array(c), ends }; };
const tile = {
	area: { extent: E, features: [
		{ type: "Polygon", id: 1, props: { name: "a", code: "A1", kind: 1 }, geom: geom([ring(1000, 1000, 2000, 2000), hole(1400, 1400, 1600, 1600)]) },
		{ type: "Polygon", id: 2, props: { name: "b", kind: 2 }, geom: geom([ring(3000, 3000, 3200, 3200), ring(3500, 3500, 3700, 3700)]) },
	] },
	road: { extent: E, features: [
		{ type: "LineString", id: 10, props: { w: 4 }, geom: geom([[0, 2500, 4096, 2500]]) },
		{ type: "LineString", id: 11, props: {}, geom: geom([[0, 100, 100, 100], [200, 100, 300, 100]]) },
	] },
	poi: { extent: E, features: [
		{ type: "Point", id: 20, props: { name: "p" }, geom: geom([[500, 500]]) },
		{ type: "Point", id: 21, props: {}, geom: geom([[2600, 600, 2700, 700]]) },
	] },
};
const style = { layers: [
	{ id: "bg", type: "background" },
	{ id: "area", type: "fill", "source-layer": "area" },
	{ id: "road", type: "line", "source-layer": "road", paint: { "line-width": ["get", "w"] } },
	{ id: "road0", type: "line", "source-layer": "road", paint: { "line-width": 0 } },
	{ id: "poi", type: "symbol", "source-layer": "poi" },
	{ id: "dot", type: "circle", "source-layer": "poi", paint: { "circle-radius": 10, "circle-stroke-width": 2 } },
] };
const q = (area, o = {}) => queryTiles({ style, order: [{ key: KEY }], tileUrl: () => "https://example.invalid/t.mvt", zoom: Z, area, cache: new Map([[KEY, tile]]), ...o });
const ids = fs => fs.map(f => `${f.layer.id}:${f.id}`).join(",");

// ── 点の当たり ──
{
	const a = await q({ ll: ll(1200, 1200) });
	ok("面の中＝当たる", ids(a) === "area:1", ids(a));
	ok("穴の中＝当たらない", (await q({ ll: ll(1500, 1500) })).length === 0);
	ok("面の外＝当たらない", (await q({ ll: ll(2500, 1200) })).length === 0);
	// 1 単位＝256/4096 px＝1/16 px。線幅 4px＝半分 2px＋許容 3px＝5px＝80 単位
	ok("線：幅の半分＋許容（80 単位）の内は当たる", ids(await q({ ll: ll(2000, 2500 + 75) })) === "road:10");
	ok("線：その外は当たらない", (await q({ ll: ll(2000, 2500 + 90) })).length === 0);
	ok("線：幅 0 の層は許容 0 では当たらない", !ids(await q({ ll: ll(2000, 2500) }, { tolPx: 0 })).includes("road0"));
	ok("線：幅 0 の層も許容があれば当たる", ids(await q({ ll: ll(2000, 2500) })).includes("road0:10"));
	// 記号の点＝許容 3＋8＝11px＝176 単位・円＝3＋10＋2＝15px＝240 単位
	const p = await q({ ll: ll(500 + 170, 500) });
	ok("記号の点：+8px の内は当たる・円も当たる（上の層から）", ids(p) === "dot:20,poi:20", ids(p));
	ok("円：半径＋縁の内だけ", ids(await q({ ll: ll(500 + 230, 500) })) === "dot:20");
	ok("点も円も外", (await q({ ll: ll(500 + 250, 500) })).length === 0);
	ok("MultiPoint のどれか", ids(await q({ ll: ll(2700, 700) }, { layers: ["poi"] })) === "poi:21");
}

// ── 箱の当たり ──
{
	const b = await q({ bbox: [...ll(2900, 3800), ...ll(3800, 2900)] });
	ok("箱：外接箱の重なり（MultiPolygon も）", ids(b).includes("area:2"));
	const [w, s] = ll(0, E), [e, n] = ll(E, 0);
	const all = await q({ bbox: [w, s, e, n] });
	ok("箱：タイル全体なら全層の地物", ["area:1", "area:2", "road:10", "road:11", "poi:20", "dot:21"].every(k => ids(all).split(",").includes(k)), ids(all));
}

// ── 層の選別 ──
{
	const at = { ll: ll(1200, 1200) };
	ok("hidden の層は外す", (await q(at, { hidden: new Set([1]) })).length === 0);
	ok("visibility none は外す", (await queryTiles({ style: { layers: [{ ...style.layers[1], layout: { visibility: "none" } }] }, order: [{ key: KEY }], tileUrl: () => "u", zoom: Z, area: at, cache: new Map([[KEY, tile]]) })).length === 0);
	const zs = [{ minzoom: 11 }, { maxzoom: 10 }, { minzoom: 9, maxzoom: 11 }].map(r => ({ layers: [{ ...style.layers[1], ...r }] }));
	const zr = await Promise.all(zs.map(st => queryTiles({ style: st, order: [{ key: KEY }], tileUrl: () => "u", zoom: Z, area: at, cache: new Map([[KEY, tile]]) })));
	ok("minzoom/maxzoom（max は含まない）", zr[0].length === 0 && zr[1].length === 0 && zr[2].length === 1);
	ok("layers の絞り込み", (await q({ ll: ll(500, 500) }, { layers: ["poi"] })).length === 1);
	const lf = await queryTiles({ style: { layers: [{ ...style.layers[1], filter: ["==", ["get", "kind"], 2] }] }, order: [{ key: KEY }], tileUrl: () => "u", zoom: Z, area: at, cache: new Map([[KEY, tile]]) });
	ok("層の filter に落ちた地物は当たらない", lf.length === 0);
	ok("問い合わせの filter（ML の式）", (await q(at, { filter: ["==", ["get", "name"], "b"] })).length === 0 && (await q(at, { filter: ["==", ["get", "name"], "a"] })).length === 1);
	ok("tileUrl が null のタイルは読まない", (await q(at, { tileUrl: () => null })).length === 0);
	ok("空のタイル（__empty）は読まない", (await q(at, { cache: new Map([[KEY, { __empty: true }]]) })).length === 0);
}

// ── 並び・最細のタイル ──
{
	const coarse = `${Z - 1}/${X >> 1}/${Y >> 1}`, cache = new Map([[KEY, tile], [coarse, { area: { extent: E, features: [{ type: "Polygon", id: 99, props: {}, geom: geom([ring(0, 0, E, E)]) }] } }]]);
	const r = await q({ ll: ll(1200, 1200) }, { order: [{ key: coarse }, { key: KEY }], cache, layers: ["area"] });
	ok("点＝その場所を覆う最細のタイル 1 枚", ids(r) === "area:1" && r[0].tile === KEY);
	const b = await q({ bbox: [...ll(1100, 1900), ...ll(1900, 1100)] }, { order: [{ key: coarse }, { key: KEY }], cache, layers: ["area"] });
	ok("箱＝掛かるタイルを全部", ids(b).split(",").sort().join() === "area:1,area:99");
	const off = await q({ ll: ll(1200, 1200) }, { order: [{ key: `${Z}/${X + 5}/${Y}` }] });
	ok("掛からないタイルは読まない", off.length === 0);
}

// ── promoteId・付帯 ──
{
	const at = { ll: ll(1200, 1200) };
	const [f] = await q(at);
	ok("id・properties・source・sourceLayer・tile", f.id === 1 && f.properties.name === "a" && f.source === "basemap" && f.sourceLayer === "area" && f.tile === KEY && f.layer["source-layer"] === "area");
	ok("promoteId（文字列）", (await q(at, { promoteId: "code" }))[0].id === "A1");
	ok("promoteId（source-layer ごと）・無い属性は元の id", (await q(at, { promoteId: { area: "name" } }))[0].id === "a" && (await q(at, { promoteId: "nope" }))[0].id === 1);
	ok("source の名乗り", (await q(at, { source: "mine" }))[0].source === "mine");
}

// ── toGeoJSON ──
{
	const t = { z: Z, x: X, y: Y, key: KEY };
	const g = id => [...sourceFeatures(tile, t, { sourceLayer: "area" }), ...sourceFeatures(tile, t, { sourceLayer: "road" }), ...sourceFeatures(tile, t, { sourceLayer: "poi" })].find(f => f.id === id).geometry;
	const p = g(1);
	ok("穴あき Polygon＝外周＋穴の 2 環", p.type === "Polygon" && p.coordinates.length === 2 && p.coordinates[0].length === 5);
	ok("Polygon の頂点＝タイル座標の経緯度", near(p.coordinates[0][0][0], ll(1000, 1000)[0]) && near(p.coordinates[0][0][1], ll(1000, 1000)[1]));
	ok("外周 2 つ＝MultiPolygon", g(2).type === "MultiPolygon" && g(2).coordinates.length === 2);
	ok("LineString・MultiLineString", g(10).type === "LineString" && g(10).coordinates.length === 2 && g(11).type === "MultiLineString" && g(11).coordinates.length === 2);
	ok("Point・MultiPoint", g(20).type === "Point" && near(g(20).coordinates[0], ll(500, 500)[0]) && g(21).type === "MultiPoint" && g(21).coordinates.length === 2);
}

// ── sourceFeatures ──
{
	const t = { z: Z, x: X, y: Y, key: KEY };
	ok("sourceFeatures：source-layer の全部", sourceFeatures(tile, t, { sourceLayer: "area" }).length === 2);
	ok("sourceFeatures：filter", sourceFeatures(tile, t, { sourceLayer: "area", filter: ["==", ["get", "kind"], 2] }).map(f => f.id).join() === "2");
	ok("sourceFeatures：無い層・空のタイル・null は []", sourceFeatures(tile, t, { sourceLayer: "nope" }).length === 0 && sourceFeatures({ __empty: true }, t, { sourceLayer: "area" }).length === 0 && sourceFeatures(null, t, { sourceLayer: "area" }).length === 0);
	ok("sourceFeatures：promoteId・source・tile", (() => { const [f] = sourceFeatures(tile, t, { sourceLayer: "area", promoteId: "code", source: "s" }); return f.id === "A1" && f.source === "s" && f.tile === KEY && !f.layer; })());
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ query 全 PASS");
process.exit(fail ? 1 : 0);
