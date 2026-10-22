// 利用者の geojson の symbol 層＝線に沿う注記（symbol-placement "line"／"line-center"・C9・2026-10-12）と点置きの注記（テキスト GPU 化 T-P3・2026-10-22）。
// 点置き＝錨は symbols-core と同じ（点・線の各部分の最初の頂点・面の到達不能極）を、世界 1 枚の仮のタイル（z0・extent 2^28＝約 15cm）の点にして buildLabels で焼く＝
// 基図／vector source の注記と同じ衝突・同じ層の位置（旧＝symbols-2d の別の canvas と別の衝突＝基図の注記と重なった・層の順に挟まらなかった）。式の ["geometry-type"] は元の型（gt）。
// 線に沿う注記は基図／vector source の注記と同じ経路に流す：
// 視野のタイル（selectLOD＝描く側と同じ選び）ごとに線をタイル単位（extent 4096）へ写して枠で切り（clipLineGeom）、core の buildLabels で
// 錨と折れ線（symbol-spacing・line-center・text-max-angle・keep-upright は描く側 labels2d が裁く）を焼き、sendLabels（"vt:" の層＝vector の注記と同じ口）で渡す。
// 止まるたび（settle）にタイルの集合と ["zoom"] の値（quantZoom）が変わっていれば焼き直す。衝突は基図の注記と同じ土俵（利用者の層が勝つ＝sort を負の帯に）。
import { selectLOD } from "@ortho-earth/core";
import { buildLabels } from "@ortho-earth/core/tilelabels";
import { clipLineGeom, substituteZoom, quantZoom } from "../vtops.ts";
import { poleOf } from "./symbols-core.ts";
import type { MLLayer, TileXYZ } from "@ortho-earth/core";
import type { GlobeMap } from "../types/map.ts";
import type { DrawSize, GlobeCam } from "../types/scope.ts";

/** 線に沿う geojson の注記（symbol-placement line/line-center の geojson の symbol 層） */
export interface GJLabels {
	/** 層を足す／置き換える（layer＝正規化済み・src＝GeoJSON・key＝重ね順・point＝点置き（無ければ線に沿う）） */
	set(id: string, layer: MLLayer, src: unknown, key?: number, point?: boolean): { features: number };
	remove(id: string): void;
	setOrder(id: string, n: number): void;
	has(id: string): boolean;
	readonly layerIds: string[];
	destroy(): void;
}
/** core の buildLabels の入力（解読済みのタイル）と 1 件の注記 */
type LabelsTile = Parameters<typeof buildLabels>[0];
type Label = ReturnType<typeof buildLabels>["labels"][number];
/** 線の地物（parts＝世界メルカトル [0,1] の平らな列・bbox＝同じ単位） */
interface LineFeat { id: unknown; props: Record<string, unknown>; parts: Float64Array[]; bbox: number[] }
/** 点置きの地物（pts＝錨の世界メルカトル [0,1] の平らな列・gt＝元の型） */
interface PtFeat { id: unknown; props: Record<string, unknown>; gt: string; pts: number[] }
/** 層の 1 枚（sig＝最後に焼いたタイルの集合と ["zoom"] の値・rev＝set の回数・pt＝点置き・zdep＝式が ["zoom"] を読む） */
interface GJLayer { layer: MLLayer; feats: LineFeat[]; pfeats: PtFeat[]; pt: boolean; zdep: boolean; key: number; sig: string | null; rev: number }
/** gjLineFeatures が読む地物 */
interface GJFeature { id?: unknown; properties?: Record<string, unknown> | null; geometry?: { type: string; coordinates: unknown } | null }
type GJSrc = { type?: unknown; coordinates?: unknown; features?: Array<GJFeature | null | undefined> } | null | undefined;

// 焼く層＝表示の z（quantZoom）を ["zoom"] に差し込む（worker と同じ近似）・zoom 域は描く側（sendLabels の meta）・source-layer は仮の "g"
const layerAt = (L0: MLLayer, pz: number): MLLayer => ({ ...L0, "source-layer": "g", minzoom: undefined, maxzoom: undefined, ...(L0.filter != null ? { filter: substituteZoom(L0.filter, pz) } : {}), paint: substituteZoom(L0.paint || {}, pz), layout: { ...substituteZoom(L0.layout || {}, pz), visibility: "visible" } }) as MLLayer;
const E = 4096, D2R = Math.PI / 180, R2D = 180 / Math.PI, MAX_TILES = 48, TILE_PX = 512 * Math.SQRT2;
const merc = (lon: number, lat: number) => { const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * D2R); return [lon / 360 + 0.5, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]; };
const tileBbox = (z: number, x: number, y: number) => { const n = 2 ** z, lat = (v: number) => R2D * Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))); return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)]; };

// GeoJSON → 線の地物（LineString／MultiLineString だけ・点と面は捨てる＝MapLibre の line 配置と同じ）。parts＝世界メルカトル [0,1] の平らな列・bbox＝同じ単位
function gjLineFeatures(src: unknown): LineFeat[] {
	const feats = (Array.isArray(src) ? src : (src as GJSrc)?.type === "FeatureCollection" ? (src as GJSrc)!.features : (src as GJSrc)?.type === "Feature" ? [src] : (src as GJSrc)?.type && (src as GJSrc)?.coordinates ? [{ type: "Feature", properties: {}, geometry: src }] : (src as GJSrc)?.features || []) as Array<GJFeature | null | undefined>;
	const out: LineFeat[] = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		const lines = (g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : null) as unknown[] | null;
		if (!lines) continue;
		const parts: Float64Array[] = [], bbox = [Infinity, Infinity, -Infinity, -Infinity];
		for (const l of lines) {
			if (!Array.isArray(l) || l.length < 2) continue;
			const p = new Float64Array(l.length * 2);
			for (let i = 0; i < l.length; i++) { const [mx, my] = merc(+(l[i] as number[])[0], +(l[i] as number[])[1]); p[i * 2] = mx; p[i * 2 + 1] = my; if (mx < bbox[0]) bbox[0] = mx; if (my < bbox[1]) bbox[1] = my; if (mx > bbox[2]) bbox[2] = mx; if (my > bbox[3]) bbox[3] = my; }
			parts.push(p);
		}
		if (parts.length) out.push({ id: f!.id, props: f!.properties || {}, parts, bbox });
	}
	return out;
}

// GeoJSON → 点置きの地物（symbols-core の symbolItems と同じ錨：点・多点・線の各部分の最初の頂点・面の到達不能極）
function gjPointFeatures(src: unknown): PtFeat[] {
	const feats = (Array.isArray(src) ? src : (src as GJSrc)?.type === "FeatureCollection" ? (src as GJSrc)!.features : (src as GJSrc)?.type === "Feature" ? [src] : (src as GJSrc)?.type && (src as GJSrc)?.coordinates ? [{ type: "Feature", properties: {}, geometry: src }] : (src as GJSrc)?.features) as Array<GJFeature | null | undefined> || [];
	type Pos = number[];
	const out: PtFeat[] = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		const c = g.coordinates as unknown;
		const ps: Array<Pos | null> | null = g.type === "Point" ? [c as Pos] : g.type === "MultiPoint" ? c as Pos[]
			: g.type === "LineString" ? [(c as Pos[])[0]] : g.type === "MultiLineString" ? (c as Pos[][]).map(l => l[0])
			: g.type === "Polygon" ? [poleOf(c as Pos[][])] : g.type === "MultiPolygon" ? (c as Pos[][][]).map(poleOf) : null;
		if (!ps?.length || ps.some(p => !p || !isFinite(+p[0]) || !isFinite(+p[1]))) continue;
		const pts: number[] = [];
		for (const p of ps as Pos[]) { const [mx, my] = merc(+p[0], +p[1]); pts.push(mx, my); }
		out.push({ id: f!.id, props: f!.properties || {}, gt: g.type.replace(/^Multi/, ""), pts });
	}
	return out;
}
const PE = 2 ** 28;   // 点置きの仮のタイルの extent（z0 の 1 枚＝世界）＝buildLabels の重複の畳み（整数に丸めた位置）が別の点を畳まない細かさ

// 呼び手の口：cam・size()＝{ w, h }（device px）・dpr・sendLabels(id, list|null, meta)（globe の vtdraw と同じ）
export function createGJLabels(map: GlobeMap, { cam, size, dpr = 1, sendLabels }: {
	cam: GlobeCam; size: () => DrawSize; dpr?: number;
	sendLabels(id: string, list: unknown[] | null, meta: { minZoom?: number | null; maxZoom?: number | null }): void;
}): GJLabels {
	const layers = new Map<string, GJLayer>();   // id → { layer, feats, key, sig }
	const tilesNow = () => {
		const { w, h } = size();
		let ts = selectLOD(cam, w, h, { minZ: 0, maxZ: 22, tilePx: TILE_PX * dpr });
		if (!ts.length) return [];
		const fine = Math.max(...ts.map(t => t.z));
		ts = ts.filter(t => t.z >= fine - 2);   // 急な傾きの遠くの粗い段は捨てる（vtdraw と同じ）
		const [cx, cy] = cam.center, cw = Math.cos(cy * D2R);
		const d2 = (t: TileXYZ) => { const b = tileBbox(t.z, t.x, t.y), dx = Math.max(b[0] - cx, 0, cx - b[2]) * cw, dy = Math.max(b[1] - cy, 0, cy - b[3]); return dx * dx + dy * dy; };
		return ts.sort((a, b) => d2(a) - d2(b)).slice(0, MAX_TILES);
	};
	const build = (s: GJLayer, ts: TileXYZ[], pz: number) => {
		const L = layerAt(s.layer, pz);
		const out: Label[] = [];
		for (const t of ts) {
			const n = 2 ** t.z, x0 = t.x / n, y0 = t.y / n, x1 = (t.x + 1) / n, y1 = (t.y + 1) / n, feats: Array<{ type: "LineString"; id: unknown; props: Record<string, unknown>; geom: { coords: Float64Array; ends: number[] } }> = [];
			for (const f of s.feats) {
				if (f.bbox[2] < x0 || f.bbox[0] > x1 || f.bbox[3] < y0 || f.bbox[1] > y1) continue;
				const coords: number[] = [], ends: number[] = [];
				for (const p of f.parts) { for (let i = 0; i < p.length; i += 2) coords.push((p[i] * n - t.x) * E, (p[i + 1] * n - t.y) * E); ends.push(coords.length); }
				const g = clipLineGeom({ coords, ends }, E);
				if (g) feats.push({ type: "LineString", id: f.id, props: f.props, geom: g });
			}
			if (!feats.length) continue;
			const { labels } = buildLabels({ layers: { g: { extent: E, features: feats } }, z: t.z, x: t.x, y: t.y } as unknown as LabelsTile, { layers: [L] });   // 線はタイル単位の小数のまま（core は座標を ArrayLike で読む）
			for (const lb of labels) { lb.usk = lb.sort || 0; lb.sort = -1e6 - s.key * 1e3 + lb.usk; delete (lb as { li?: number }).li; out.push(lb); }   // 利用者の注記が基図に勝つ・上の層ほど先に置く（vtdraw-worker と同じ）
		}
		return out;
	};
	// 点置き＝世界 1 枚の仮のタイルで 1 回（錨は視野に依らない＝画面の外は描く側が捨てる）
	const buildPoints = (s: GJLayer, pz: number) => {
		const feats: Array<{ type: "Point"; gt: string; id: unknown; props: Record<string, unknown>; geom: { coords: number[]; ends: number[] } }> = [];
		for (const f of s.pfeats) for (let i = 0; i < f.pts.length; i += 2) feats.push({ type: "Point", gt: f.gt, id: f.id, props: f.props, geom: { coords: [f.pts[i] * PE, f.pts[i + 1] * PE], ends: [2] } });
		if (!feats.length) return [];
		const { labels } = buildLabels({ layers: { g: { extent: PE, features: feats } }, z: 0, x: 0, y: 0 } as unknown as LabelsTile, { layers: [layerAt(s.layer, pz)] });
		for (const lb of labels) { lb.usk = lb.sort || 0; lb.sort = -1e6 - s.key * 1e3 + lb.usk; delete (lb as { li?: number }).li; }   // 利用者の注記が基図に勝つ・上の層ほど先に置く（線と同じ）
		return labels;
	};
	const refresh = (force = false) => {
		if (!layers.size) return;
		const ts = [...layers.values()].some(s => !s.pt) ? tilesNow() : [], pz = quantZoom(cam.zoom), tsig = ts.map(t => `${t.z}/${t.x}/${t.y}`).join(",") + "@" + pz;
		for (const [id, s] of layers) {
			const sig = (s.pt ? (s.zdep ? "@" + pz : "") : tsig) + "#" + s.key + "#" + s.rev;   // 点置き＝タイルの集合に依らない（["zoom"] を読む層だけ z で焼き直す）
			if (!force && s.sig === sig) continue;
			s.sig = sig;
			const list = s.pt ? buildPoints(s, pz) : build(s, ts, pz);
			sendLabels(id, list.length ? list : null, { minZoom: s.layer.minzoom ?? null, maxZoom: s.layer.maxzoom ?? null });
		}
	};
	const onSettle = () => refresh();
	map.on("settle", onSettle);
	let rev = 0;
	const ctl: GJLabels = {
		// 層を足す／置き換える（layer＝正規化済み＝エンジンの目盛り・src＝GeoJSON・key＝重ね順・point＝点置き）
		set(id, layer, src, key = 0, point = false) {
			const old = layers.get(id), zdep = /"zoom"/.test(JSON.stringify([layer.layout, layer.paint, layer.filter]));
			layers.set(id, { layer, feats: point ? [] : gjLineFeatures(src), pfeats: point ? gjPointFeatures(src) : [], pt: point, zdep, key: old?.key ?? key, sig: null, rev: ++rev });
			refresh();
			const s = layers.get(id)!;
			return { features: s.pt ? s.pfeats.length : s.feats.length };
		},
		remove(id) { if (layers.delete(id)) sendLabels(id, null, {}); },
		setOrder(id, n) { const s = layers.get(id); if (s && s.key !== n) { s.key = n; refresh(); } },
		has: (id: string) => layers.has(id),
		get layerIds() { return [...layers.keys()]; },
		destroy() { for (const id of [...layers.keys()]) ctl.remove(id); map.off("settle", onSettle); },
	};
	return ctl;
}
