// @ortho-earth/h3：H3 のセルを @ortho-earth/globe に描く（deck.gl の H3HexagonLayer／HexagonLayer（点の集約）相当・計画 段 A1〜A2・2026-10-11）。
// 多角形になる物は既存の層経路（MapLibre 同名の addSource/addLayer＝geojson → gint）へ流す＝描画・LOD・地形ドレープ・当たり判定（queryRenderedFeatures・層イベント）は既にある。
// ここで書くのは「データ → セル＋属性 → GeoJSON」の変換と手綱だけ。計算は core.ts（Node の検定が読む）。
//
// 使い方（map.addH3 は globe が遅延 import で用意する）：
//   const h = await map.addH3(cells | points | geojson, {
//     id: "h3",                      // 層 id（source id も同じ・輪郭は `${id}-line`）
//     res: 7 | "auto",               // 解像度。"auto"＝表示のズームから（resForZoom・ズームで変わる＝点の時だけ・セル id を渡した時は固定）
//     weight: "pop" | 2 | fn | 式,    // 点の集約の重み（既定 1＝count）
//     paint: { "fill-color": ["interpolate", ["linear"], ["get", "count"], 0, "#ffffb2", 100, "#bd0026"], "fill-opacity": 0.7 },
//     extrude: { height: ["*", ["get", "count"], 50], base: 0, bottom: 0 } | null,   // 立てる（fill-extrusion）・式は MapLibre のまま。bottom＝床の高さ m（globe の押し出しの層の bottom＝その平面に立てる・
//                                     屋根の細分が粗い＝広いセルが軽い。無し＝MapLibre と同じく地面から＝屋根を 1.5 km 刻みで地形に沿わせる＝粗い段の大きな六角形では重い）
//     outline: { "line-color": "#333", "line-width": 0.5 } | false,
//     props: (cell, i, agg) => ({ … }),   // 属性の足し込み
//   });
//   h.setData(cells | points) / h.setPaint(paint) / h.setRes(res) / h.cells（Map）/ h.geojson / h.remove()
// セルの属性＝{ h3, res, count, sum, mean, min, max }（点の集約）か渡した属性（セル id の Map／{ id: props }）
import { binPoints, cellsToGeoJSON, resForZoom, pointsOf, h3 } from "./core.ts";
import type { H3CellCollection, H3CellSource, H3EvalExpr, H3PointSource, H3PropsFn, H3Weight } from "./core.ts";
export * from "./core.ts";

/** 渡せるデータ＝セル id（配列・Map・{ id: props }）か点（GeoJSON・[{ lon, lat }]） */
export type H3Source = H3CellSource | H3PointSource;
/** 1 セルの属性（セル id を渡した時＝{ h3, res, …渡した属性 }・点の集約＝H3Bin） */
export type H3CellProps = { h3: string; res: number; [k: string]: unknown };
/** 描く先（@ortho-earth/globe の map＝MapLibre 形の口だけ使う） */
export interface H3Map {
	getZoom?: () => number;
	addSource(id: string, source: Record<string, unknown>): unknown;
	addLayer(layer: Record<string, unknown>, before?: string): unknown;
	getSource(id: string): { setData?: (data: unknown) => unknown } | null | undefined;
	setPaintProperty(id: string, name: string, value: unknown): unknown;
	removeLayer(id: string): unknown;
	removeSource(id: string): unknown;
	on(type: string, listener: () => void): unknown;
	off?: (type: string, listener: () => void) => unknown;
}
export interface H3Extrude { height?: unknown; base?: unknown; bottom?: number | null }
export interface H3LayerOptions {
	id?: string;
	res?: number | "auto";
	weight?: H3Weight;
	paint?: Record<string, unknown> | null;
	extrude?: H3Extrude | null;
	outline?: Record<string, unknown> | false | null;
	props?: H3PropsFn | Record<string, unknown> | null;
	before?: string;
	evalExpr?: H3EvalExpr | null;
	minzoom?: number;
	maxzoom?: number;
}
/** createH3Layer の手綱 */
export interface H3Layer {
	readonly id: string;
	readonly lineId: string;
	readonly cells: Map<string, H3CellProps>;
	readonly geojson: H3CellCollection | null;
	readonly res: number;
	setData(next: H3Source): Promise<H3Layer>;
	setPaint(paint: Record<string, unknown>): H3Layer;
	setRes(res: number | "auto"): Promise<H3Layer>;
	remove(): void;
}

const isCellList = (src: H3Source): src is string[] => Array.isArray(src) && src.length > 0 && typeof src[0] === "string";
const isCellMap = (src: H3Source): src is Map<string, unknown> | Record<string, unknown> => src instanceof Map || (!!src && typeof src === "object" && !Array.isArray(src) && (src as { type?: unknown }).type == null && Object.keys(src).every(k => h3.isValidCell(k)));

export async function createH3Layer(map: H3Map, src: H3Source, { id = "h3", res = 7, weight = null, paint = null, extrude = null, outline = { "line-color": "rgba(0,0,0,0.35)", "line-width": 0.5 }, props = null, before = undefined, evalExpr = null, minzoom, maxzoom }: H3LayerOptions = {}): Promise<H3Layer> {
	let data = src, cells: Map<string, H3CellProps> = new Map(), geojson: H3CellCollection | null = null, curRes = +res, added = false, zoomHandler: (() => void) | null = null;
	const lineId = `${id}-line`;
	const resNow = (): number => res === "auto" ? resForZoom(map.getZoom?.() ?? 5) : +res;
	const build = (): H3CellCollection => {
		curRes = resNow();
		if (isCellList(data) || isCellMap(data)) {   // セル id（解像度はセルの物）
			const entries: Map<string, unknown> = data instanceof Map ? data : Array.isArray(data) ? new Map(data.map(c => [c, null] as [string, null])) : new Map(Object.entries(data));
			cells = new Map([...entries].map(([c, p]) => [c, { h3: c, res: h3.getResolution(c), ...(p && typeof p === "object" ? p : {}) }]));
		} else cells = binPoints(pointsOf(data as H3PointSource), { res: curRes, weight, evalExpr });   // 点の集約
		geojson = cellsToGeoJSON(cells, props);
		return geojson;
	};
	const layerSpec = (): Record<string, unknown> => extrude
		? { id, type: "fill-extrusion", source: id, paint: { "fill-extrusion-color": paint?.["fill-color"] ?? paint?.["fill-extrusion-color"] ?? "#3182bd", "fill-extrusion-opacity": paint?.["fill-opacity"] ?? paint?.["fill-extrusion-opacity"] ?? 0.8, "fill-extrusion-height": extrude.height ?? ["*", ["get", "count"], 100], "fill-extrusion-base": extrude.base ?? 0, ...(paint || {}) }, ...(extrude.bottom != null ? { bottom: extrude.bottom } : {}), ...(minzoom != null ? { minzoom } : {}), ...(maxzoom != null ? { maxzoom } : {}) }
		: { id, type: "fill", source: id, paint: { "fill-color": "#3182bd", "fill-opacity": 0.6, ...(paint || {}) }, ...(minzoom != null ? { minzoom } : {}), ...(maxzoom != null ? { maxzoom } : {}) };
	const add = async (): Promise<void> => {
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
	const h: H3Layer = {
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
