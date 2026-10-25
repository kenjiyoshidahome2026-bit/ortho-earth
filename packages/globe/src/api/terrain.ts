// 地形と標高の口（map.setTerrain・getTerrain・queryTerrainElevation・sampleTerrain・getHeight）と一人称歩行（map.walk）＝createGlobe から切り出した（globe.js の分割 ④・2026-10-15）。
// 中身は切り出す前と同じ。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { createDemSource, resolveVectorSource } from "@ortho-earth/core";
import { createWalk, pointInPolygon } from "../walk.ts";
import type { HandlerImpl, LonLat, RenderedFeature, WalkHandle, WalkOptions } from "../../globe.d.ts";
import type { Installing, TerrainDeps, TerrainLive } from "../types/install.ts";
import type { GlobeMap, TerrainApi } from "../types/map.ts";
import type { TerrainSpec } from "../types/scope.ts";
import type { WalkInner } from "../walk.ts";

/** sampleTerrain が受ける位置（座標の配列・{lng|lon,lat}・GeoJSON）を辿る形 */
type PositionsIn = { type?: string; geometry?: PositionsIn; features?: Array<{ geometry?: PositionsIn }>; geometries?: PositionsIn[]; coordinates?: unknown };
/** {lng|lon, lat} の点（数は文字列でもよい＝+ で読む） */
type PtIn = { lng?: number | string; lon?: number | string; lat: number | string };
/** registry.handlers の中身（plugin）か builtin（walk.js）＝step 以下は builtin だけが持つ */
type WalkImpl = ReturnType<HandlerImpl["create"]> & Partial<Pick<WalkInner, "step" | "turn" | "look" | "position">>;

/** 地形の誇張の値（正の数・それ以外は 1＝実スケール） */
export const exagOf = (v: unknown): number => { const k = Number(v ?? 1); return Number.isFinite(k) && k > 0 ? k : 1; };

export function installTerrain(map: Installing<TerrainApi>, live: TerrainLive, {
	EARTH_M, cam, elevMemo, elevOf, heightAt, pluginHost, qmSpecOf, requestDraw, requester, terrLazy, wPost
}: TerrainDeps): void {
	map.getHeight = heightAt;
	// MapLibre 同名：setTerrain({ source: id|spec, exaggeration }) / setTerrain(null)。source＝raster-dem（tiles か TileJSON の url・encoding）。
	// exaggeration＝地形の誇張（本人裁定 2026-10-24＝指定した時だけ・省略＝1＝実スケール・null で外すと 1 に戻る）。地形のセル（R01）と 1 点の標高の両方がこの DEM を見る
	map.setTerrain = async t => {
		let sp: TerrainSpec | string | null = t?.source ?? null;
		if (typeof sp === "string") sp = (live.mlSources.get(sp) ?? live.EXT?.ms.sources?.[sp] ?? null) as TerrainSpec | null;   // addSource の物（型は自由）は raster-dem／quantized-mesh として読む
		if (t && !sp) throw new Error("setTerrain: raster-dem source not found");
		setExag(t ? exagOf(t.exaggeration) : 1);
		if (sp?.type === "quantized-mesh") return setDem(qmSpecOf(sp));   // Cesium の地形（#110）＝raster-dem の詰め直しを通さない
		if (sp && !sp.tiles && sp.url) { const r = await resolveVectorSource(sp, live.EXT?.baseUrl || location.href, { fetchFn: ((u, init) => requester.fetch(u as string, "Source", init)) as typeof fetch }); sp = { ...sp, tiles: r.tiles, minzoom: sp.minzoom ?? r.minzoom, maxzoom: sp.maxzoom ?? r.maxzoom, bounds: sp.bounds ?? r.bounds, encoding: sp.encoding ?? r.demEncoding ?? undefined, tileSize: sp.tileSize ?? r.tileSize ?? undefined }; }   // encoding/tileSize は TileJSON の申告も（mapterhorn＝terrarium・旧＝捨てて mapbox で解いた＝256m ごとに折り返す鋸歯）
		if (sp?.tiles) sp = { ...sp, tiles: sp.tiles.map((u: string) => /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, location.href).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}")) };
		const demSpec = sp ? { tiles: sp.tiles, encoding: sp.encoding || "mapbox", tileSize: sp.tileSize ?? 512, minzoom: sp.minzoom, maxzoom: sp.maxzoom ?? 22, bounds: sp.bounds, dtm: !!sp.dtm, cellZoom: sp.cellZoom,
			redFactor: sp.redFactor, greenFactor: sp.greenFactor, blueFactor: sp.blueFactor, baseShift: sp.baseShift } : null;   // MapLibre の raster-dem の既定＝tileSize 512・maxzoom 22・encoding custom の係数（段 6）   // MapLibre の raster-dem の既定 encoding は mapbox
		return setDem(demSpec);
	};
	function setDem(spec: TerrainSpec | null): GlobeMap {   // 標高のソースを差し替える（raster-dem も quantized-mesh も同じ 4 つの口＝core createDemSource が振り分ける）
		live.demSpec = spec;
		live.demMain = live.demSpec ? createDemSource(live.demSpec) : null;
		live.geGen++; live.geBusy = false; live.geKey = "";   // 中心の地面の高さも新しい DEM で引き直す（古い照会の答えは捨てる）
		elevMemo.clear(); live.elevGen++;   // DOM オーバーレイの持ち上げも新しい DEM で引き直す（次フレームから）
		if (terrLazy && live.demSpec) live.noTerr = false;   // terrain:false の地図に初めて DEM が来た＝render worker が地形を作る（持ち上げもここから）
		wPost({ type: "set", cmd: "dem", data: live.demSpec });
		requestDraw();
		return map;
	}
	map.getTerrain = () => live.demSpec ? { source: live.demSpec, exaggeration: live.terrExag } : null;
	// 地形の誇張（Cesium の scene.verticalExaggeration に当たる・2026-10-24）。地形と、地形に乗る物（建物・3D Tiles・模型・注記・マーカー）の足元を同じ倍率で持ち上げる。
	//   建物や模型そのものの高さは伸ばさない（MapLibre の exaggeration と同じ）。既定の標高（setTerrain をしていない地図）にも効く
	function setExag(k: number): void {
		if (k === live.terrExag) return;
		live.terrExag = k;
		elevMemo.clear(); live.elevGen++;   // DOM オーバーレイの持ち上げを新しい倍率で引き直す
		wPost({ type: "set", cmd: "terrainExag", data: k });
		requestDraw();
	}
	map.setTerrainExaggeration = k => { setExag(exagOf(k)); return map; };
	map.getTerrainExaggeration = () => live.terrExag;
	map.queryTerrainElevation = (lon, lat) => (live.demSpec ? (elevOf(lon, lat) ?? null) : null);   // MapLibre 同名（同期）＝地形（setTerrain／style の terrain）がある時だけ・メモに無ければ null（照会を起こす＝次の呼び出しで返る・MapLibre も地形の未着は null）2026-09-30   // ローダ着荷（数秒）を待ってから照会＝初期化中に 0 を返さない（旧＝未着 0。SDK ドッグフード 2026-09-10）。初期化失敗は reject
	// 地形の一括標本（第 2 波 F6・2026-10-12・実装つき）：map.sampleTerrain(positions, { concurrency }) → Promise<[{ lng, lat, height }]>。
	//   出どころは描いている地形と同じ（setTerrain／style の terrain の DEM が先・無い所は既定の DTM＝heightAt＝map.getHeight と同じ）。負の標高はそのまま（描く側は 0 に切る＝文書）。
	//   positions＝[lng,lat] の配列・{lng|lon,lat} の配列・GeoJSON（Point/MultiPoint/LineString の座標）。到着を待つ（wait）＝起動直後でも 0m に化けない。同時 8 件ずつ
	map.sampleTerrain = async (positions, { concurrency = 8 } = {}) => {
		const pts: LonLat[] = [];
		const push = (c: unknown): void => { if (Array.isArray(c) && typeof c[0] === "number") pts.push([c[0], c[1]]); else if (c && typeof c === "object" && !Array.isArray(c) && Number.isFinite(+((c as PtIn).lng ?? (c as PtIn).lon)!) && Number.isFinite(+(c as PtIn).lat)) pts.push([+((c as PtIn).lng ?? (c as PtIn).lon)!, +(c as PtIn).lat]); else if (Array.isArray(c)) c.forEach(push); };
		const g = ((positions as PositionsIn)?.type === "Feature" ? (positions as PositionsIn).geometry : (positions as PositionsIn)?.type === "FeatureCollection" ? { type: "GeometryCollection", geometries: (positions as PositionsIn).features!.map(f => f.geometry) } : positions) as PositionsIn | undefined;
		if (g && typeof g === "object" && !Array.isArray(g) && g.type) { const walk = (x: PositionsIn | undefined): void => { if (!x) return; if (x.type === "GeometryCollection") x.geometries!.forEach(walk); else push(x.coordinates); }; walk(g); } else push(positions);
		const out = new Array<{ lng: number; lat: number; height: number }>(pts.length); let i = 0;
		await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pts.length)) }, async () => { while (i < pts.length) { const k = i++; const [lng, lat] = pts[k]; let h = 0; try { h = await heightAt(lng, lat); } catch { h = 0; } out[k] = { lng, lat, height: Number.isFinite(h) ? h : 0 }; } }));
		return out;
	};
	// 一人称歩行（F6 の口・第 3 波 W3 で中身＝src/walk.js）：map.walk(opts) → 手綱 { start, stop, active, opts, step, turn, look, position }。
	//   registry.handlers の "walk"（plugin の { create(map, opts) → { start, stop, active } }）があればそれが勝つ（capabilities "camera.walk" は plugin）・無ければ builtin（"builtin"）。
	//   builtin の足元＝heightAt（描いている地形と同じ出どころ）・壁＝wallHeightAt（基図の建物の足跡の高さ＋geojson の押し出し）
	let walkCur: WalkHandle | null = null, wallCache: { t: number; fs: RenderedFeature[] } = { t: 0, fs: [] };
	const wallHeightAt = (lon: number, lat: number): number => {
		let h = 0;
		const B = live.style?.schema?.buildings;
		if (B?.layer) {   // 基図の建物（出しているタイルの写し＝querySourceFeatures・1 秒だけ覚える）
			const now = performance.now();
			if (now - wallCache.t > 1000) { wallCache = { t: now, fs: map.querySourceFeatures(live.baseSidNow(), { sourceLayer: B.layer }) }; }
			for (const f of wallCache.fs) if (pointInPolygon(lon, lat, f.geometry)) { h = Math.max(h, (B.heightByCode && B.heightByCode[f.properties?.[B.codeKey]]) || B.defaultHeight || 10); }
		}
		for (const u of live.modelCtl?.extrudedFeatures || []) if (u.h > h && pointInPolygon(lon, lat, u.f?.geometry)) h = Math.max(h, u.h);   // gadget.extrude・fill-extrusion の geojson
		return h;
	};
	const WALK_BUILTIN = { create: (m: GlobeMap, o: WalkOptions) => createWalk(m, o, { heightAt, wallHeightAt, radiusM: EARTH_M }) };
	map.walk = (opts = {}) => {
		const o = { speed: Number.isFinite(+opts.speed!) ? +opts.speed! : 1.4, eyeHeight: Number.isFinite(+opts.eyeHeight!) ? +opts.eyeHeight! : 1.7, collide: opts.collide !== false, keys: opts.keys !== false, ...opts };
		const impl = pluginHost.registry.handlers.get("walk") || WALK_BUILTIN;
		const inner: WalkImpl | null = impl && typeof impl.create === "function" ? impl.create(map, o) : null;
		if (walkCur) walkCur.stop();
		const h: WalkHandle = { opts: o, get active() { return inner ? !!inner.active : false; },
			start() { if (!inner) { console.warn("[walk] no walk handler installed (registry.handlers \"walk\"); keeping the spec only"); return false; } inner.start?.(); return true; },
			stop() { inner?.stop?.(); if (walkCur === h) walkCur = null; return h; },
			step: (f: number, s2 = 0) => inner?.step ? inner.step(+f || 0, +s2 || 0) : 0, turn: (deg: number) => { inner?.turn?.(+deg || 0); return h; }, look: (deg: number) => { inner?.look?.(+deg || 0); return h; },
			position: () => inner?.position ? inner.position() : null };
		walkCur = h; return h;
	};
	map.getZoom = () => cam.zoom;             // 現在ズーム（派生アプリのズーム連動 LOD＝集約⇄市区町村の層切替に）
}
