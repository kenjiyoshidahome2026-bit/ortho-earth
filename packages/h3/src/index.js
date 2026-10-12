// @ortho-earth/h3：H3 のセルを @ortho-earth/globe に描く（deck.gl の H3HexagonLayer／HexagonLayer（点の集約）相当・計画 段 A1〜A2・2026-10-11）。
// 多角形になる物は既存の層経路（MapLibre 同名の addSource/addLayer＝geojson → gint）へ流す＝描画・LOD・地形ドレープ・当たり判定（queryRenderedFeatures・層イベント）は既にある。
// ここで書くのは「データ → セル＋属性 → GeoJSON」の変換と手綱だけ。計算は core.js（Node の検定が読む）。
//
// 使い方（map.addH3 は globe が遅延 import で用意する）：
//   const h = await map.addH3(cells | points | geojson, {
//     id: "h3",                      // 層 id（source id も同じ・輪郭は `${id}-line`）
//     res: 7 | "auto",               // 解像度。"auto"＝表示のズームから（resForZoom・ズームで変わる＝点の時だけ・セル id を渡した時は固定）
//     weight: "pop" | 2 | fn | 式,    // 点の集約の重み（既定 1＝count）
//     paint: { "fill-color": ["interpolate", ["linear"], ["get", "count"], 0, "#ffffb2", 100, "#bd0026"], "fill-opacity": 0.7 },
//     extrude: { height: ["*", ["get", "count"], 50], base: 0 } | null,   // 立てる（fill-extrusion）・式は MapLibre のまま
//     outline: { "line-color": "#333", "line-width": 0.5 } | false,
//     props: (cell, i, agg) => ({ … }),   // 属性の足し込み
//   });
//   h.setData(cells | points) / h.setPaint(paint) / h.setRes(res) / h.cells（Map）/ h.geojson / h.remove()
// セルの属性＝{ h3, res, count, sum, mean, min, max }（点の集約）か渡した属性（セル id の Map／{ id: props }）
import { binPoints, cellsToGeoJSON, resForZoom, pointsOf, h3 } from "./core.js";
export * from "./core.js";

const isCellList = src => Array.isArray(src) && src.length > 0 && typeof src[0] === "string";
const isCellMap = src => src instanceof Map || (src && typeof src === "object" && !Array.isArray(src) && src.type == null && Object.keys(src).every(k => h3.isValidCell(k)));

export async function createH3Layer(map, src, { id = "h3", res = 7, weight = null, paint = null, extrude = null, outline = { "line-color": "rgba(0,0,0,0.35)", "line-width": 0.5 }, props = null, before = undefined, evalExpr = null, minzoom, maxzoom } = {}) {
	let data = src, cells = new Map(), geojson = null, curRes = res, added = false, zoomHandler = null;
	const lineId = `${id}-line`;
	const resNow = () => res === "auto" ? resForZoom(map.getZoom?.() ?? 5) : +res;
	const build = () => {
		curRes = resNow();
		if (isCellList(data) || isCellMap(data)) {   // セル id（解像度はセルの物）
			const entries = data instanceof Map ? data : Array.isArray(data) ? new Map(data.map(c => [c, null])) : new Map(Object.entries(data));
			cells = new Map([...entries].map(([c, p]) => [c, { h3: c, res: h3.getResolution(c), ...(p && typeof p === "object" ? p : {}) }]));
		} else cells = binPoints(pointsOf(data), { res: curRes, weight, evalExpr });   // 点の集約
		geojson = cellsToGeoJSON(cells, props);
		return geojson;
	};
	const layerSpec = () => extrude
		? { id, type: "fill-extrusion", source: id, paint: { "fill-extrusion-color": paint?.["fill-color"] ?? paint?.["fill-extrusion-color"] ?? "#3182bd", "fill-extrusion-opacity": paint?.["fill-opacity"] ?? paint?.["fill-extrusion-opacity"] ?? 0.8, "fill-extrusion-height": extrude.height ?? ["*", ["get", "count"], 100], "fill-extrusion-base": extrude.base ?? 0, ...(paint || {}) }, ...(minzoom != null ? { minzoom } : {}), ...(maxzoom != null ? { maxzoom } : {}) }
		: { id, type: "fill", source: id, paint: { "fill-color": "#3182bd", "fill-opacity": 0.6, ...(paint || {}) }, ...(minzoom != null ? { minzoom } : {}), ...(maxzoom != null ? { maxzoom } : {}) };
	const add = async () => {
		build();
		map.addSource(id, { type: "geojson", data: geojson });
		await map.addLayer(layerSpec(), before);
		if (outline && !extrude) await map.addLayer({ id: lineId, type: "line", source: id, paint: { "line-color": "rgba(0,0,0,0.35)", "line-width": 0.5, ...outline } }, before);
		added = true;
		if (res === "auto" && !(isCellList(data) || isCellMap(data))) {   // 表示のズームで解像度が変わったら集約し直す（止まった時に見て、解像度が変わった時だけ）
			zoomHandler = () => { if (resNow() !== curRes) h.setData(data); };
			map.on("idle", zoomHandler);   // globe の "idle"（動きが止まった後）＝zoomend 相当
		}
	};
	const h = {
		id, lineId,
		get cells() { return cells; }, get geojson() { return geojson; }, get res() { return curRes; },
		async setData(next) { data = next; build(); const s = map.getSource(id); if (s?.setData) await s.setData(geojson); return h; },
		setPaint(p) { paint = { ...(paint || {}), ...p }; for (const [k, v] of Object.entries(p)) map.setPaintProperty(id, extrude && k === "fill-color" ? "fill-extrusion-color" : extrude && k === "fill-opacity" ? "fill-extrusion-opacity" : k, v); return h; },
		async setRes(r) { res = r; return h.setData(data); },
		remove() { if (!added) return; added = false; if (zoomHandler) { map.off?.("idle", zoomHandler); zoomHandler = null; } try { map.removeLayer(lineId); } catch { /* 無い */ } try { map.removeLayer(id); } catch { /* 無い */ } try { map.removeSource(id); } catch { /* 無い */ } },
	};
	await add();
	return h;
}
