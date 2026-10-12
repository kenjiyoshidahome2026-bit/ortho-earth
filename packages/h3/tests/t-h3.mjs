#!/usr/bin/env node
// @ortho-earth/h3 の検定（Node）。node packages/h3/tests/t-h3.mjs
//  ① 辺の長さの表＝h3-js の getHexagonEdgeLengthAvg と同じ ② resForZoom＝単調・0〜15・辺が約 edgePx ③ binPoints＝count/sum/mean/min/max・重みの 4 形
//  ④ cellRing／cellsToGeoJSON＝閉じた環・六角（五角は 5）・±180° を跨ぐセルは一つの面で東へ伸びる・不正な id は飛ばす・Map/配列/オブジェクトの入口
//  ⑤ createH3Layer＝偽の map で addSource/addLayer の形（fill＋輪郭・fill-extrusion）・setData・setPaint の写し替え・remove・res "auto" の zoomend
import assert from "node:assert/strict";
import { h3, EDGE_M, resForZoom, binPoints, cellRing, cellsToGeoJSON, pointsOf, weightFn, latLngToCell } from "../src/core.js";
import { createH3Layer } from "../src/index.js";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("  ✔", name); };

await t("辺の表は h3-js と同じ", () => { for (let r = 0; r <= 15; r++) assert.ok(Math.abs(EDGE_M[r] / h3.getHexagonEdgeLengthAvg(r, "m") - 1) < 1e-4, `res ${r}`); });
await t("resForZoom＝単調・範囲内", () => {
	let prev = -1; for (let z = 0; z <= 22; z += 0.5) { const r = resForZoom(z); assert.ok(r >= 0 && r <= 15); assert.ok(r >= prev, `z${z}: ${r} < ${prev}`); prev = r; }
	assert.equal(resForZoom(0), 0); assert.ok(resForZoom(22) >= 14);
	const z = 10, r = resForZoom(z, { edgePx: 40 }), mPx = 2 * Math.PI * 6378137 / 256 / 2 ** z;
	assert.ok(Math.abs(Math.log(EDGE_M[r] / (40 * mPx))) < Math.log(2.7), "辺が 40px の 2.7 倍以内（解像度の刻み≈2.65）");
	assert.ok(resForZoom(10, { edgePx: 10 }) >= resForZoom(10, { edgePx: 80 }), "小さい辺＝細かい解像度");
});
await t("pointsOf＝GeoJSON と [{lon,lat}] の両方", () => {
	const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: { v: 1 }, geometry: { type: "Point", coordinates: [1, 2] } }, { type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: [[3, 4], [5, 6]] } }, { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] } }] };
	const p = pointsOf(fc); assert.equal(p.length, 3); assert.deepEqual([p[0].lon, p[0].lat, p[0].props.v], [1, 2, 1]);
	assert.equal(pointsOf([{ lon: 1, lat: 2 }])[0].lon, 1);
});
await t("weightFn＝数・属性名・関数・式", () => {
	const p = { lon: 0, lat: 0, props: { pop: 7 } };
	assert.equal(weightFn(null)(p), 1); assert.equal(weightFn(3)(p), 3); assert.equal(weightFn("pop")(p), 7); assert.equal(weightFn("none")(p), 0);
	assert.equal(weightFn(pr => pr.pop * 2)(p), 14);
	const evalExpr = (e, ctx) => e[0] === "get" ? ctx.props[e[1]] : undefined;   // 最小の評価器の代わり
	assert.equal(weightFn(["get", "pop"], evalExpr)(p), 7); assert.equal(weightFn(["get", "pop"])(p), 1, "評価器が無ければ 1");
});
await t("binPoints＝統計", () => {
	const pts = [{ lon: 139.77, lat: 35.68, props: { v: 2 } }, { lon: 139.771, lat: 35.681, props: { v: 4 } }, { lon: 0, lat: 0, props: { v: 1 } }, { lon: NaN, lat: 0, props: {} }];
	const b = binPoints(pts, { res: 5, weight: "v" });
	assert.equal(b.size, 2);
	const tokyo = b.get(latLngToCell(35.68, 139.77, 5));
	assert.deepEqual([tokyo.count, tokyo.sum, tokyo.mean, tokyo.min, tokyo.max, tokyo.res], [2, 6, 3, 2, 4, 5]);
	const c = binPoints(pts, { res: 11 }); assert.equal(c.size, 3, "細かい解像度＝東京の 2 点が別のセル（約 140m 離れ・res11 の辺 29m）"); for (const a of c.values()) assert.equal(a.sum, a.count, "重み無し＝sum は count");
});
await t("cellRing＝閉じた六角・五角・±180°", () => {
	const r = cellRing(latLngToCell(35.68, 139.77, 7)); assert.equal(r.length, 7); assert.deepEqual(r[0], r[6]);
	const penta = h3.getPentagons(3)[0], pr = cellRing(penta); assert.ok(pr.length === 6 || pr.length === 11, `五角＝5 頂点（歪みで 10 もある）: ${pr.length}`);
	const dl = cellRing(latLngToCell(0, 180, 3)); const lons = dl.map(c => c[0]); assert.ok(Math.max(...lons) - Math.min(...lons) < 180, "幅 180 未満＝東へ伸ばした"); assert.ok(lons.some(x => x > 180), "180 超の経度がある");
	const ok = cellRing(latLngToCell(0, 0, 3)).map(c => c[0]); assert.ok(ok.every(x => x > -10 && x < 10), "普通のセルは触らない");
});
await t("cellsToGeoJSON＝入口 3 形・属性・不正 id", () => {
	const a = latLngToCell(35, 139, 5), b = latLngToCell(36, 140, 5);
	const fc1 = cellsToGeoJSON([a, b, "not-a-cell"]); assert.equal(fc1.features.length, 2); assert.equal(fc1.features[0].properties.h3, a); assert.equal(fc1.features[0].geometry.type, "Polygon");
	const fc2 = cellsToGeoJSON(new Map([[a, { count: 3 }]]), (cell, i, p) => ({ dbl: p.count * 2 })); assert.deepEqual(fc2.features[0].properties, { h3: a, count: 3, dbl: 6 });
	const fc3 = cellsToGeoJSON({ [a]: { x: 1 }, [b]: { x: 2 } }); assert.equal(fc3.features[1].properties.x, 2); assert.equal(fc3.features[1].id, 1);
	const fc4 = cellsToGeoJSON(binPoints([{ lon: 139, lat: 35 }], { res: 5 })); assert.equal(fc4.features[0].properties.count, 1);
});
// 偽の map＝呼ばれた物を記録（globe の MapLibre 同名の口）
const fakeMap = (zoom = 5) => {
	const log = [], sources = new Map(), handlers = {};
	return { log, sources, handlers,
		getZoom: () => zoom, setZoom(z) { zoom = z; for (const f of handlers.idle || []) f(); },
		addSource(id, spec) { log.push(["addSource", id, spec.type]); sources.set(id, { spec, async setData(d) { spec.data = d; log.push(["setData", id, d.features.length]); } }); },
		getSource: id => sources.get(id), removeSource(id) { log.push(["removeSource", id]); sources.delete(id); },
		async addLayer(l, before) { log.push(["addLayer", l.id, l.type, l.paint, before]); }, removeLayer(id) { log.push(["removeLayer", id]); },
		setPaintProperty(id, k, v) { log.push(["setPaint", id, k, v]); },
		on(ev, f) { (handlers[ev] ??= []).push(f); }, off(ev, f) { handlers[ev] = (handlers[ev] || []).filter(g => g !== f); },
	};
};
await t("createH3Layer＝fill＋輪郭・setData・setPaint・remove", async () => {
	const map = fakeMap();
	const pts = [{ lon: 139.77, lat: 35.68 }, { lon: 139.771, lat: 35.681 }, { lon: 0, lat: 0 }];
	const h = await createH3Layer(map, pts, { id: "hx", res: 5, paint: { "fill-color": "#f00" } });
	assert.deepEqual(map.log.map(l => l[0]), ["addSource", "addLayer", "addLayer"]);
	assert.equal(map.log[1][2], "fill"); assert.equal(map.log[1][3]["fill-color"], "#f00"); assert.equal(map.log[2][1], "hx-line"); assert.equal(map.log[2][2], "line");
	assert.equal(h.cells.size, 2); assert.equal(h.geojson.features.length, 2); assert.equal(h.res, 5);
	await h.setData([{ lon: 10, lat: 10 }]); assert.equal(h.cells.size, 1); assert.deepEqual(map.log.at(-1), ["setData", "hx", 1]);
	h.setPaint({ "fill-opacity": 0.3 }); assert.deepEqual(map.log.at(-1), ["setPaint", "hx", "fill-opacity", 0.3]);
	await h.setRes(3); assert.equal(h.res, 3); assert.equal(h.cells.values().next().value.res, 3);
	h.remove(); assert.deepEqual(map.log.slice(-3).map(l => l[0]), ["removeLayer", "removeLayer", "removeSource"]);
	h.remove(); assert.equal(map.log.length, 9, "二度目は何もしない");
});
await t("createH3Layer＝fill-extrusion（paint の写し替え）・セル id 入口", async () => {
	const map = fakeMap();
	const a = latLngToCell(35, 139, 4);
	const h = await createH3Layer(map, { [a]: { count: 10 } }, { id: "ex", extrude: { height: ["*", ["get", "count"], 50] }, paint: { "fill-color": "#0f0" }, outline: false });
	assert.equal(map.log.length, 2, "押し出しは輪郭を足さない");
	const L = map.log[1]; assert.equal(L[2], "fill-extrusion"); assert.equal(L[3]["fill-extrusion-color"], "#0f0"); assert.deepEqual(L[3]["fill-extrusion-height"], ["*", ["get", "count"], 50]); assert.equal(L[3]["fill-extrusion-base"], 0);
	assert.equal(h.cells.get(a).res, 4); assert.equal(h.geojson.features[0].properties.count, 10);
	h.setPaint({ "fill-color": "#00f" }); assert.deepEqual(map.log.at(-1).slice(2), ["fill-extrusion-color", "#00f"]);
});
await t("res \"auto\"＝idle で解像度が変わった時だけ集約し直す", async () => {
	const map = fakeMap(4);
	const h = await createH3Layer(map, [{ lon: 139, lat: 35 }], { id: "au", res: "auto" });
	const r0 = h.res; assert.equal(r0, resForZoom(4)); const n0 = map.log.length;
	map.setZoom(4.2); assert.equal(map.log.length, n0, "同じ解像度＝何もしない");
	map.setZoom(10); await new Promise(r => setTimeout(r, 10)); assert.equal(h.res, resForZoom(10)); assert.ok(h.res > r0); assert.equal(map.log.at(-1)[0], "setData");
	h.remove(); assert.equal((map.handlers.idle || []).length, 0, "外したら聞かない");
});
console.log(`h3: ${n} passed`);
