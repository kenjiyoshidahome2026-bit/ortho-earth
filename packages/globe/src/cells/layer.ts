// セル・等高線・画面格子の層（deck.gl 差分 PR-5・2026-10-12）＝globe が遅延 import する手綱。計算は core.js／contour.js（node の検定が読む）。
// 多角形になる物（セル・等値帯）と線（等値線）は既存の層経路（addSource/addLayer＝fill／fill-extrusion／line）へ流す＝H3（@ortho-earth/h3）と同じ流儀。画面格子だけ overlay（gadgets/screengrid-draw.js）。
//   map.addCells(cells | points, { kind:"grid"|"mesh"|"geohash"|"quadkey"|"s2", id, res|"auto", weight, paint, extrude, outline, props, before })＝extrude＝{ height, base, bottom }（bottom＝床の高さ m＝@ortho-earth/h3 と同じ） → { id, lineId, cells, geojson, res, setData, setPaint, setRes, remove }
//   map.addContour(points, { id, cellSize（m か {dLon,dLat}）, thresholds|bands, weight, agg, smooth, paint, linePaint, before }) → { id, field, geojson, setData, setThresholds, remove }
//   map.addScreenGrid(points, { id, cellPx, colorRange, weight, agg, opacity, above }) → { id, overlay, setData, setStyle, pick, remove }
//   map.addAggregate(src, { kind:"h3"|"grid"|"mesh"|"geohash"|"quadkey"|"s2"|"screen"|"contour", … })＝上の 3 つと map.addH3 への振り分け（計画の入口案）
import { binPoints, cellsToGeoJSON, resForZoom, pointsOf, KINDS } from "./core.ts";
import { gridField, smooth as smoothField, contourGeoJSON, autoThresholds } from "./contour.ts";
import type { CellPoint, CellRes, CellWeight, GridSpec, PointSrc } from "./core.ts";
import type { ContourField, GridFieldOptions, Isoband, Isoline } from "./contour.ts";
import type { evalExpr as EvalExprFn } from "@ortho-earth/core";
import type { CellsLayerHandle, CellsLayerOptions, ContourLayerHandle, GeoJSONFeatureCollection, MapLibreLayer, ScreenGridHandle, StyleExpression } from "../../globe.d.ts";
import type { DataApi, GlobeMap } from "../types/map.ts";

type Props = Record<string, unknown>;
type EvalExpr = typeof EvalExprFn;
/** extrude の中身（code が読む分） */
interface ExtrudeSpec { height?: StyleExpression; base?: StyleExpression; bottom?: number }
/** addCells の options（code が読む形＝CellsLayerOptions より広い） */
export interface CellsOptions {
	kind?: string; id?: string; res?: CellRes | "auto"; weight?: CellWeight; paint?: Record<string, StyleExpression> | null;
	extrude?: ExtrudeSpec | StyleExpression | null; outline?: Record<string, StyleExpression> | null;
	props?: Props | ((id: string, i: number, p: unknown) => Props | null | undefined) | null;
	before?: string; evalExpr?: EvalExpr | null; minzoom?: number; maxzoom?: number;
}
/** addContour の options（code が読む形） */
export interface ContourOptions {
	id?: string; cellSize?: GridFieldOptions["cellSize"]; thresholds?: number[] | "auto" | null; bands?: Array<ArrayLike<number>> | null;
	weight?: CellWeight; agg?: string; smooth?: number; paint?: Record<string, StyleExpression> | null; linePaint?: Record<string, StyleExpression> | null;
	props?: Props | ((item: Isoline | Isoband, k: number) => Props | null | undefined) | null; before?: string; evalExpr?: EvalExpr | null; bbox?: ArrayLike<number> | null;
}
/** addScreenGrid の options（code が読む形） */
export interface ScreenGridOpts {
	id?: string; cellPx?: number; colorRange?: unknown; weight?: CellWeight; agg?: string; opacity?: number; gap?: number; above?: boolean;
	evalExpr?: EvalExpr | null;
}
type CellsHandle = CellsLayerHandle & { lineId: string; kind: string };
type ContourHandle = ContourLayerHandle & { lineId: string };

const isIdList = (src: unknown): src is string[] => Array.isArray(src) && src.length > 0 && typeof src[0] === "string";
const isIdMap = (src: unknown) => src instanceof Map || (src && typeof src === "object" && !Array.isArray(src) && (src as Props).type == null && !("lon" in src));

export async function createCellsLayer(map: GlobeMap, src: unknown, { kind = "grid", id = kind, res = kind === "grid" ? 1000 : kind === "mesh" ? 3 : kind === "s2" ? 10 : kind === "quadkey" ? 12 : 6, weight = null, paint = null, extrude = null, outline = { "line-color": "rgba(0,0,0,0.35)", "line-width": 0.5 }, props = null, before = undefined, evalExpr = null, minzoom, maxzoom }: CellsOptions = {}): Promise<CellsHandle> {
	if (!(KINDS as Record<string, unknown>)[kind]) throw new Error(`addCells: unknown kind "${kind}"`);
	let data = src, cells: Map<string, unknown> = new Map(), geojson: GeoJSONFeatureCollection | null = null, curRes: CellRes | null = null, added = false, zoomHandler: (() => void) | null = null;
	const lineId = `${id}-line`;
	const resNow = (): CellRes => res === "auto" ? resForZoom(kind, map.getZoom?.() ?? 5, { lat: map.getCenter?.()?.lat ?? 35 }) : res;
	const build = () => {
		curRes = resNow();
		if (isIdList(data) || isIdMap(data)) {
			const entries: Map<string, unknown> = data instanceof Map ? data : Array.isArray(data) ? new Map(data.map(c => [c, null])) : new Map(Object.entries(data as Props));
			cells = new Map([...entries].map(([c, p]) => [c, { id: c, kind, ...(p && typeof p === "object" ? p : {}) }]));
		} else cells = binPoints(data as PointSrc, kind, curRes, { weight, evalExpr });
		geojson = cellsToGeoJSON(cells, kind, curRes, props) as GeoJSONFeatureCollection;
		return geojson;
	};
	const layerSpec = (): MapLibreLayer => extrude
		? { id, type: "fill-extrusion", source: id, paint: { "fill-extrusion-color": paint?.["fill-color"] ?? paint?.["fill-extrusion-color"] ?? "#3182bd", "fill-extrusion-opacity": paint?.["fill-opacity"] ?? paint?.["fill-extrusion-opacity"] ?? 0.8, "fill-extrusion-height": (extrude as ExtrudeSpec).height ?? ["*", ["get", "count"], 100], "fill-extrusion-base": (extrude as ExtrudeSpec).base ?? 0, ...(paint || {}) }, ...((extrude as ExtrudeSpec).bottom != null ? { bottom: (extrude as ExtrudeSpec).bottom } : {}), ...(minzoom != null ? { minzoom } : {}), ...(maxzoom != null ? { maxzoom } : {}) }
		: { id, type: "fill", source: id, paint: { "fill-color": "#3182bd", "fill-opacity": 0.6, ...(paint || {}) }, ...(minzoom != null ? { minzoom } : {}), ...(maxzoom != null ? { maxzoom } : {}) };
	const h: CellsHandle = {
		id, lineId, kind,
		get cells() { return cells; }, get geojson() { return geojson!; }, get res() { return curRes as number | GridSpec; },
		async setData(next: unknown) { data = next; build(); const s = map.getSource(id); if (s?.setData) await s.setData(geojson!); return h; },
		setPaint(p) { paint = { ...(paint || {}), ...p }; for (const [k, v] of Object.entries(p)) map.setPaintProperty(id, extrude && k === "fill-color" ? "fill-extrusion-color" : extrude && k === "fill-opacity" ? "fill-extrusion-opacity" : k, v); return h; },
		async setRes(r) { res = r; return h.setData(data); },
		remove() { if (!added) return; added = false; if (zoomHandler) { map.off?.("idle", zoomHandler); zoomHandler = null; } for (const L of [lineId, id]) { try { map.removeLayer(L); } catch { /* 無い */ } } try { map.removeSource(id); } catch { /* 無い */ } },
	};
	build();
	map.addSource(id, { type: "geojson", data: geojson! });
	await map.addLayer(layerSpec(), before);
	if (outline && !extrude) await map.addLayer({ id: lineId, type: "line", source: id, paint: { "line-color": "rgba(0,0,0,0.35)", "line-width": 0.5, ...outline } }, before);
	added = true;
	if (res === "auto" && !(isIdList(data) || isIdMap(data))) { zoomHandler = () => { const r = resNow(); if (JSON.stringify(r) !== JSON.stringify(curRes)) h.setData(data); }; map.on("idle", zoomHandler); }
	return h;
}

export async function createContourLayer(map: GlobeMap, src: unknown, { id = "contour", cellSize = 1000, thresholds = null, bands = null, weight = null, agg = "count", smooth = 0, paint = null, linePaint = null, props = null, before = undefined, evalExpr = null, bbox = null }: ContourOptions = {}): Promise<ContourHandle> {
	let data = src, field: ContourField | null = null, geojson: GeoJSONFeatureCollection | null = null, added = false;
	const lineId = `${id}-line`;
	const build = () => {
		field = gridField(data as PointSrc, { cellSize, weight, evalExpr, agg, bbox });
		if (smooth) field = smoothField(field, smooth);
		const th = thresholds === "auto" || (!thresholds && !bands) ? autoThresholds(field, 5) : thresholds;
		geojson = contourGeoJSON(field, { thresholds: th as number[] | null, bands, props }) as GeoJSONFeatureCollection;
		return geojson;
	};
	const h: ContourHandle = {
		id, lineId,
		get field() { return field; }, get geojson() { return geojson!; },
		async setData(next: unknown) { data = next; build(); const s = map.getSource(id); if (s?.setData) await s.setData(geojson!); return h; },
		async setThresholds(t, b) { if (t !== undefined) thresholds = t; if (b !== undefined) bands = b; return h.setData(data); },
		remove() { if (!added) return; added = false; for (const L of [lineId, id]) { try { map.removeLayer(L); } catch { /* 無い */ } } try { map.removeSource(id); } catch { /* 無い */ } },
	};
	build();
	map.addSource(id, { type: "geojson", data: geojson! });
	const hasBands = !!bands, hasLines = !!(thresholds || !bands);
	if (hasBands) await map.addLayer({ id, type: "fill", source: id, filter: ["has", "lo"], paint: { "fill-color": ["interpolate", ["linear"], ["get", "index"], 0, "#ffffb2", Math.max(1, bands!.length - 1), "#bd0026"], "fill-opacity": 0.6, ...(paint || {}) } }, before);
	if (hasLines) await map.addLayer({ id: hasBands ? lineId : id, type: "line", source: id, filter: ["has", "threshold"], paint: { "line-color": "#333", "line-width": 1, ...(linePaint || (hasBands ? {} : paint) || {}) } }, before);
	added = true;
	return h;
}

export function createScreenGrid(map: GlobeMap, src: unknown, { id = "screengrid", cellPx = 24, colorRange, weight = null, agg = "sum", opacity, gap, above = false, evalExpr = null }: ScreenGridOpts = {}): ScreenGridHandle {
	const ov = map.overlay({ builtin: "screengrid" }, { name: id, above });
	const style: Props = { cellPx, agg }; if (colorRange) style.colorRange = colorRange; if (opacity != null) style.opacity = opacity; if (gap != null) style.gap = gap;
	ov.post({ type: "style", ...style });
	const bake = (pts: unknown) => {
		const P = pointsOf(pts as PointSrc), lon = new Float64Array(P.length), lat = new Float64Array(P.length);
		const wf: ((p: CellPoint) => number) | null = weight == null ? null : (typeof weight === "function" ? p => +(weight(p.props, p) as number) || 0 : typeof weight === "string" ? p => +(p.props?.[weight] as number) || 0 : typeof weight === "number" ? () => weight : null);
		const w = wf ? new Float32Array(P.length) : null;
		P.forEach((p, i) => { lon[i] = p.lon; lat[i] = p.lat; if (w) w[i] = wf!(p); });
		ov.post({ type: "data", lon, lat, w }, [lon.buffer, lat.buffer, ...(w ? [w.buffer] : [])]);
		return P.length;
	};
	const h = { id, overlay: ov, n: bake(src) } as ScreenGridHandle & { overlay: typeof ov };
	h.setData = pts => { h.n = bake(pts); return h; };
	h.setStyle = s => { ov.post({ type: "style", ...s }); return h; };
	h.pick = (x, y, r) => ov.pick(x, y, r);
	h.remove = () => ov.remove();
	return h;
}

export async function addAggregate(map: GlobeMap, src: unknown, { kind = "grid", ...o }: { kind?: string; evalExpr?: EvalExpr | null; [k: string]: unknown } = {}): ReturnType<DataApi["addAggregate"]> {
	if (kind === "h3") return map.addH3(src, o as CellsLayerOptions);
	if (kind === "screen") return createScreenGrid(map, src, o);
	if (kind === "contour") return createContourLayer(map, src, o);
	return createCellsLayer(map, src, { kind, ...o });
}
