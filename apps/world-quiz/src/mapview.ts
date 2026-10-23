// 地図の面＝地球儀（@ortho-earth/globe・地域なしのホスト）を World の地図パネル（apps/world/src/mappane.js）と同じ作法で起こす。
//   正解の国へ寄る（spotlight＝周りを薄く覆って国の形だけ残す）／「地図 → 国名」は答える前に国を指す／「国名 → 地図」は押した所の国を当てる。
//   国の形＝エンジンが持つ Natural Earth admin_0 を ISO2 で引く（spotlight("JP")）。ISO の無い主体（B コード）は World の ne-cultural（worldlayers）の形で。
//   押した所の国＝worldlayers.query（ne-cultural base＝初回 16.5MB・以降 IDB）＝Lv.3 の地図モードを始めた時だけ読む。マウスの下の国は黄色の線で囲む（名前は出さない）。
//   地形モード＝World の形状台帳（ne-physical.geopbf＝/globe/physical と同じ物・初回 1.6MB）を QID で引く＝面はスポットライト＋輪郭・川は太い線・山や滝（点）は小さな円。
// エンジンは一度だけ起動して使い回す。起動できない環境（WebGL 無し等）は null を返し、呼び手は地図なしで続ける。
import { countryLayers } from "world-data/worldlayers";
import { ASSET_BASE } from "world-data/data";
import { gunzip, isGzip } from "geopbf/gzip";
import { reachOf } from "./quiz.ts";
import type { QuizCountry } from "./quiz.ts";
import type { CountryLayers, NationLike } from "world-data/worldlayers";
import type { GeopbfFn } from "geopbf";
import type { GlobeMap, GeoJSONFeatureCollection, OrthoJapanLang, Bbox } from "@ortho-earth/globe";
type OutlineOpts = Parameters<GlobeMap["gadget"]["outline"]>[1];
type OutlineSrc = Parameters<GlobeMap["gadget"]["outline"]>[0];
type Geom = { type: string; coordinates: any };
/** 地図の面の手綱（build が返す物） */
export type MapView = Awaited<ReturnType<typeof build>>;
const ZMAX = 7;
const engineP = () => window.__orthoEngine ? Promise.resolve(window.__orthoEngine) : import("@ortho-earth/globe");
const REGION_VIEW: Record<string, number[]> = { "0": [1.6, 20, 0], "3": [2.4, 32, 90], "1": [3.2, 52, 15], "2": [2.6, 2, 20], "4": [2.3, 42, -95], "5": [2.6, -18, -60], "6": [2.4, -22, 150] };   // [zoom, lat, lon]

let paneP: Promise<MapView | null> | null = null;
export function createMapView(host: HTMLElement, { lang = "en" }: { lang?: string } = {}): Promise<MapView | null> { return paneP ||= build(host, lang).catch(e => { console.warn("[quiz] map unavailable", e); return null; }); }

async function build(host: HTMLElement, lang: string) {
	const engine = await engineP();
	const map = await engine.createGlobe({
		target: host, lang: lang as OrthoJapanLang, view: "#1.6/20/0", zoomMax: ZMAX, mesh: false, chips: false, instruments: ["attr"], countryTip: false, persistView: false,
		keyboard: false,   // 矢印キーは答えの選択に使う
	});
	map.gadget.zoom(); map.gadget.compass();
	let inside: CountryLayers | null = null, spot: { bbox: number[] | null; clear(): void } | null = null, token = 0, onTap: ((key: string | null, ll: number[]) => void) | null = null, hovKey: string | null = null, hovAt = 0;
	let olQ: Promise<unknown> = Promise.resolve();
	const line = (src: OutlineSrc, o?: OutlineOpts): Promise<unknown> => (olQ = olQ.then(() => map.gadget.outline(src, o)).catch(() => null));   // 輪郭の枠は 1 つ＝ホバーと押した印を呼んだ順に当てる（後から来たホバーが赤い印を消さない）
	const layers = () => inside ||= countryLayers(map, engine.geopbf as unknown as GeopbfFn);
	// 地形の形状台帳（QID → 形の列）。山脈は NE の面（軸線＝帯の材料は使わない）。fetch は no-cache＝台帳の作り直しを ETag で拾う（physical.ts の loadPbf と同じ理由）
	let physP: Promise<Map<string, Geom[]>> | null = null;
	const physical = () => physP ||= (async () => {
		const r = await fetch(ASSET_BASE + "ne-physical.geopbf", { cache: "no-cache" }); if (!r.ok) throw new Error(`ne-physical: HTTP ${r.status}`);
		const b = await r.blob(), pbf = await engine.geopbf(await (await isGzip(b) ? await gunzip(b) : b).arrayBuffer(), { gint: false });
		const by = new Map<string, Geom[]>();
		for (let i = 0, n = pbf.length; i < n; i++) {
			const f = pbf.getFeature(i) as { geometry?: Geom; properties?: Record<string, any> } | null, p = f?.properties || pbf.getProperties(i) || {};
			if (!f?.geometry || !p.qid || p.shape === "axis") continue;
			(by.get(p.qid) || by.set(p.qid, []).get(p.qid)!).push(f.geometry);
		}
		return by;
	})().catch(e => { physP = null; throw e; });
	// 点（山・滝・岬）＝画面で見える小さな円（半径 km）に。輪郭の器は点を描かない
	const circle = (c: number[], km: number): Geom => { const ring: number[][] = []; for (let i = 0; i <= 32; i++) { const a = i / 32 * 2 * Math.PI; ring.push([c[0] + km / (111.32 * Math.cos(c[1] * Math.PI / 180)) * Math.cos(a), c[1] + km / 110.57 * Math.sin(a)]); } return { type: "Polygon", coordinates: [ring] }; };
	const bboxOfGeoms = (gs: Geom[]): number[] | null => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, lon: number | null = null;
		const w = (c: any): void => { if (Array.isArray(c[0])) { c.forEach(w); return; } lon = lon == null ? c[0] : c[0] + 360 * Math.round((lon - c[0]) / 360); x0 = Math.min(x0, lon!); x1 = Math.max(x1, lon!); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); };
		gs.forEach(g => w(g.coordinates)); return x0 <= x1 ? [x0, y0, x1, y1] : null; };
	const TERRAIN_LINE: OutlineOpts = { color: [0.85, 0.15, 0.25, 0.95], width: 3 };
	// 地形を指す：面＝周りを薄く覆う＋輪郭・線（川・運河）＝太い輪郭だけ・点＝円。戻り＝寄り先の外接矩形
	const showTerrain = async (c: QuizCountry): Promise<number[] | null> => {
		const gs = (await physical().catch(() => new Map<string, Geom[]>())).get(c.key) || [];
		const polys = gs.filter(g => /Polygon$/.test(g.type)), lines = gs.filter(g => /LineString$/.test(g.type));
		const pts = gs.filter(g => g.type === "Point").map(g => g.coordinates as number[]);
		if (!gs.length && c.coord) pts.push(c.coord);
		const area = [...polys, ...pts.map(p => circle(p, 45))];
		if (area.length) spot = await map.gadget.spotlight({ type: "FeatureCollection", features: area.map(geometry => ({ type: "Feature", properties: {}, geometry })) } as GeoJSONFeatureCollection, { fit: false, opacity: 0.4 });
		const edge = lines.length ? lines.flatMap(g => g.type === "LineString" ? [g.coordinates] : g.coordinates) : null;
		if (edge) line({ type: "MultiLineString", coordinates: edge } as OutlineSrc, TERRAIN_LINE);
		else if (area.length) line({ type: "FeatureCollection", features: area.map(geometry => ({ type: "Feature", properties: {}, geometry })) } as OutlineSrc, TERRAIN_LINE);
		const bb = bboxOfGeoms([...polys, ...lines]);
		if (bb) return bb;
		const p = pts[0]; return p ? [p[0] - 4, p[1] - 3, p[0] + 4, p[1] + 3] : null;   // 点だけ＝周り数百 km を見せる（山脈や海岸で分かる）
	};
	const clear = ({ keepMark = false } = {}) => { spot?.clear(); spot = null; if (!keepMark) { hovKey = null; line(null); } };
	const bboxOf = (c: QuizCountry): number[] | null => { const r = Math.sqrt(Math.max(1, c.area || 0) / Math.PI) / 111.32 * 1.6 + 0.8; return c.coord ? [c.coord[0] - r, c.coord[1] - r, c.coord[0] + r, c.coord[1] + r] : null; };
	const flyBbox = (bb: number[] | null, pad = 1): void => { if (!bb) return; const z = Math.min(ZMAX, map.fitZoomForBbox(bb as Bbox) - Math.log2(pad)); map.flyTo((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2, Math.max(1.2, z), 0, 0); };
	// 形＝ISO2 でエンジンから。無ければ World の形（ne-cultural）
	const shapeOf = async (c: QuizCountry) => {
		if (c.iso2) { const s = await map.gadget.spotlight(c.iso2, { fit: false }); if (s) return s; }
		const sh = await layers().shape(c.key, c as NationLike).catch(() => null);
		return sh ? await map.gadget.spotlight(sh.fc as GeoJSONFeatureCollection, { fit: false }) : null;
	};
	map.on("click", e => { if (!onTap || !e?.lngLat) return; const hit = inside?.query!(e.lngLat, lang); onTap(hit?.key || null, e.lngLat); });
	// 押して当てる問のホバー＝マウスの下の国を黄色の線で囲む（押す前に「どの国を押すか」が分かる・Kenji 2026-10-12）。
	//   名前は出さない（出すと答えを探し当てられる）。指（ホバーが無い）とドラッグ中は出さない。当たりは押す時と同じ worldlayers.query。
	const HOVER: OutlineOpts = { color: [1, 0.82, 0.15, 0.95], width: 2.6 };
	const hover = async (key: string | null): Promise<void> => {
		if (key === hovKey) return; hovKey = key;
		if (!key) { line(null); return; }
		if (key.length === 2 && await line(key, HOVER)) return;
		const sh = await layers().shape(key).catch(() => null);   // ISO で引けない主体（B コード）＝World の形で
		if (hovKey === key && onTap && sh) line(sh.fc as GeoJSONFeatureCollection, HOVER);
	};
	host.addEventListener("pointermove", e => {
		if (!onTap || e.pointerType === "touch" || e.buttons) return;
		const now = performance.now(); if (now - hovAt < 60) return; hovAt = now;   // 16ms 毎に 12k 面を当てない
		const c = host.querySelector("canvas"); if (!c) return;
		const r = c.getBoundingClientRect(), ll = map.unprojectXY(e.clientX - r.left, e.clientY - r.top);
		hover((ll && inside?.query!(ll, lang)?.key) || null);
	});
	host.addEventListener("pointerleave", () => { if (onTap) hover(null); });
	return {
		map,
		/** 正解の国へ寄って形を指す。pad＝周りをどれだけ見せるか（1＝ぴったり・大きいほど引く） */
		async focus(c: QuizCountry, { pad = 1.6, fly = true, keepMark = false }: { pad?: number; fly?: boolean; keepMark?: boolean } = {}): Promise<void> {
			const my = ++token; clear({ keepMark });
			if (c.category) {   // 地形
				const bb = await showTerrain(c);
				if (my !== token) return;
				if (fly) flyBbox(bb, pad);
				return;
			}
			spot = await shapeOf(c);
			if (my !== token) return;
			if (fly) flyBbox(spot?.bbox || bboxOf(c), pad);
		},
		/** 地域の全体を見せる（国名 → 地図を押す問の前） */
		region(r: string): void { clear(); const v = REGION_VIEW[r] || REGION_VIEW["0"]; map.flyTo(v[2], v[1], v[0], 0, 0); },
		/** 押した所の国を当てる準備（ne-cultural の base を読む）。cb(key|null)。戻り＝base が読めたか（読めなければ呼び手は選択肢の問に落とす） */
		async arm(cb: (key: string | null, ll: number[]) => void): Promise<boolean> {
			await layers().shape("JP").catch(() => null);   // shape()＝base を読む口（結果は捨てる）
			if (!inside?.query!([139.75, 35.68])) return false;   // 東京で当たらない＝base が無い（取得失敗・オフライン）
			onTap = cb; return true;
		},
		disarm() { onTap = null; hovKey = null; },
		/** 押した点から国の形までの画面上の距離（小さい国の押し損ねを救う）。戻り＝{ px, size } | null */
		async reach(c: QuizCountry, lngLat: number[]): Promise<{ px: number; size: number } | null> {
			const sh = await layers().shape(c.key, c as NationLike).catch(() => null);
			if (!sh && !c.coord) return null;
			const [tx, ty] = map.projectLL(lngLat[0], lngLat[1]);
			return reachOf(sh?.fc, (lon, lat) => map.projectLL(lon, lat), [tx, ty], c.coord);
		},
		/** 押した所に印（赤い輪郭） */
		async mark(key: string | null, lngLat: number[] | null | undefined): Promise<void> {
			line(null);
			const c: OutlineOpts = { color: [0.95, 0.25, 0.2, 0.95], width: 2.2 };
			if (key && key.length === 2) { const r = await line(key, c); if (r) return; }
			if (key) { const sh = await layers().shape(key).catch(() => null); if (sh) { await line(sh.fc as GeoJSONFeatureCollection, c); return; } }
			if (lngLat) await line({ type: "Point", coordinates: lngLat }, c);
		},
		clear: () => clear(),
	};
}
