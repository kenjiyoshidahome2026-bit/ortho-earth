// 地形と標高の口（map.setTerrain・getTerrain・queryTerrainElevation・sampleTerrain・getHeight）と一人称歩行（map.walk）＝createGlobe から切り出した（globe.js の分割 ④・2026-10-15）。
// 中身は切り出す前と同じ。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { betaToLonLat, createDemSource, ellNormal3D, lonlatTo3D, resolveVectorSource } from "@ortho-earth/core";
import type { DemLoad, DemPixels } from "@ortho-earth/core";
import { rayMeshes } from "../meshpick.ts";
import { classifyGeometry } from "../classify.ts";
import { cssColor } from "../hillshade.ts";
import type { MeshItemRef, PickItem } from "../meshpick.ts";
import { createWalk, pointInPolygon } from "../walk.ts";
import type { ClassificationHandle, ClassificationOptions, HandlerImpl, LonLat, RaycastHit, RenderedFeature, SampleHeightResult, WalkHandle, WalkOptions } from "../../globe.d.ts";
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

/** sampleTerrain／sampleHeight が受ける位置（[lng,lat] の配列・{lng|lon,lat} の配列・GeoJSON の Point/MultiPoint/LineString…）→ [lng, lat] の列 */
function positionsOf(positions: unknown): LonLat[] {
	const pts: LonLat[] = [];
	const push = (c: unknown): void => { if (Array.isArray(c) && typeof c[0] === "number") pts.push([c[0], c[1]]); else if (c && typeof c === "object" && !Array.isArray(c) && Number.isFinite(+((c as PtIn).lng ?? (c as PtIn).lon)!) && Number.isFinite(+(c as PtIn).lat)) pts.push([+((c as PtIn).lng ?? (c as PtIn).lon)!, +(c as PtIn).lat]); else if (Array.isArray(c)) c.forEach(push); };
	const g = ((positions as PositionsIn)?.type === "Feature" ? (positions as PositionsIn).geometry : (positions as PositionsIn)?.type === "FeatureCollection" ? { type: "GeometryCollection", geometries: (positions as PositionsIn).features!.map(f => f.geometry) } : positions) as PositionsIn | undefined;
	if (g && typeof g === "object" && !Array.isArray(g) && g.type) { const walk = (x: PositionsIn | undefined): void => { if (!x) return; if (x.type === "GeometryCollection") x.geometries!.forEach(walk); else push(x.coordinates); }; walk(g); } else push(positions);
	return pts;
}
/** 地形の誇張の値（正の数・それ以外は 1＝実スケール） */
export const exagOf = (v: unknown): number => { const k = Number(v ?? 1); return Number.isFinite(k) && k > 0 ? k : 1; };

export function installTerrain(map: Installing<TerrainApi>, live: TerrainLive, {
	EARTH_M, ELL_ON, cam, elevMemo, elevOf, heightAt, pluginHost, qmSpecOf, requestDraw, requester, terrLazy, wPost
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
			redFactor: sp.redFactor, greenFactor: sp.greenFactor, blueFactor: sp.blueFactor, baseShift: sp.baseShift, ...(sp.seafloor ? { seafloor: true } : {}) } : null;   // MapLibre の raster-dem の既定＝tileSize 512・maxzoom 22・encoding custom の係数（段 6）   // MapLibre の raster-dem の既定 encoding は mapbox
		// 独自スキーム（addProtocol）の型紙＝取得は main の読み口で（関数は worker へ渡せない）：main の照会は読み口を直に、render worker へは
		// MessagePort を渡して { id, url } → { id, data } で頼ませる（MapLibre の raster-dem も addProtocol を通す・Cesium の互換の口の地形プロバイダ 2026-10-30）
		//   読み口の答え＝画像のバイト列（ArrayBuffer・Blob）か画素（ImageData・{ width, height, data }）
		const custom = demSpec?.tiles?.some((u: string) => requester.resolve(u, "Tile").load);
		const pixels = (d: unknown) => d && typeof d === "object" && "width" in d && "data" in d ? d as DemPixels : null;
		return setDem(demSpec, custom ? (u: string) => Promise.resolve(requester.resolve(u, "Tile").load?.("image")).then(d => pixels(d) ?? (d instanceof Blob || d instanceof ArrayBuffer ? d : ArrayBuffer.isView(d) ? new Blob([d as Uint8Array<ArrayBuffer>]) : null), () => null) : null);
	};
	let demChan: MessageChannel | null = null;
	function setDem(spec: TerrainSpec | null, load: DemLoad | null = null): GlobeMap {   // 標高のソースを差し替える（raster-dem も quantized-mesh も同じ 4 つの口＝core createDemSource が振り分ける）
		live.demSpec = spec;
		live.demMain = live.demSpec ? createDemSource(live.demSpec, { load }) : null;
		demChan?.port1.close(); demChan = null;
		if (spec && load) {
			const ch = demChan = new MessageChannel();
			ch.port1.onmessage = (e: MessageEvent) => { const { id, url } = e.data as { id: number; url: string }; void load(url).then(data => ch.port1.postMessage({ id, data })); };   // 写しで送る（読み口が本体を取り置いていても切り離さない）
		}
		live.geGen++; live.geBusy = false; live.geKey = "";   // 中心の地面の高さも新しい DEM で引き直す（古い照会の答えは捨てる）
		elevMemo.clear(); live.elevGen++;   // DOM オーバーレイの持ち上げも新しい DEM で引き直す（次フレームから）
		if (terrLazy && live.demSpec) live.noTerr = false;   // terrain:false の地図に初めて DEM が来た＝render worker が地形を作る（持ち上げもここから）
		if (demChan) wPost({ type: "set", cmd: "dem", data: { ...live.demSpec, port: demChan.port2 } }, [demChan.port2]);
		else wPost({ type: "set", cmd: "dem", data: live.demSpec });
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
		for (const [id, c] of classes) if (c.opts.minHeight == null || c.opts.maxHeight == null) uploadCls(id);   // 既定の柱の高さは誇張に合わせる
		requestDraw();
	}
	// 面の貼り付け（分類・Cesium の ClassificationPrimitive／GroundPrimitive の classificationType・P0 #1・2026-10-25）：
	//   map.addClassification(geojson, { color, opacity, type, width, minHeight, maxHeight, id }) → { id, setData, setStyle, remove }。
	//   面・線（幅 width m の帯）を上下に伸ばした柱にして、描いた地形・3D Tiles・模型・建物のうち柱の内側の面だけを塗る（src/classify.ts・core の set("classify")）。
	//   type＝"both"（既定）・"terrain"（建物・メッシュの画素を除く）・"tiles3d"（建物・メッシュ＝3D Tiles・模型・LOD2 の画素だけ）。
	//   柱の高さ（m・楕円体高）＝既定 −1000〜10000（誇張の倍率を掛ける）。柱の外の物（高い所を通る線など）は塗らない
	const classes = new Map<string, { data: unknown; opts: ClassificationOptions }>();
	let clsSeq = 0;
	const CLS_TYPE: Record<string, number> = { both: 0, terrain: 1, tiles3d: 2 };
	const clsTypeOf = (t: unknown): number => { const v = CLS_TYPE[String(t ?? "both")]; if (v == null) throw new Error(`addClassification: type must be "both" | "terrain" | "tiles3d" (got ${String(t)})`); return v; };
	const clsColorOf = (o: ClassificationOptions): number[] => { const c = cssColor(o.color ?? "rgba(255, 200, 0, 0.5)", [1, 0.78, 0, 0.5]); return [c[0], c[1], c[2], c[3] * Math.max(0, Math.min(1, o.opacity ?? 1))]; };
	function uploadCls(id: string): void {
		const c = classes.get(id); if (!c) return;
		const k = Math.max(1, live.terrExag), o = c.opts;
		const g = classifyGeometry(c.data, { width: o.width, minHeight: o.minHeight ?? -1000 * k, maxHeight: o.maxHeight ?? 10000 * k, earthM: EARTH_M, ell: !!ELL_ON });
		wPost({ type: "set", cmd: "classify", prop: id, data: g ? { pos: g.pos, idx: g.idx, origin: g.origin, color: clsColorOf(o), type: clsTypeOf(o.type) } : null }, g ? [g.pos.buffer, g.idx.buffer] : []);
		requestDraw();
	}
	map.addClassification = (data, opts = {}) => {
		const id = opts.id != null ? String(opts.id) : `cls${++clsSeq}`;
		clsTypeOf(opts.type);
		classes.set(id, { data, opts: { ...opts } });
		uploadCls(id);
		const h: ClassificationHandle = {
			id,
			setData(d) { const c = classes.get(id); if (c) { c.data = d; uploadCls(id); } return h; },
			setStyle(st = {}) {
				const c = classes.get(id); if (!c) return h;
				const geomChanged = ["width", "minHeight", "maxHeight"].some(key => key in st);
				if (st.type !== undefined) clsTypeOf(st.type);
				c.opts = { ...c.opts, ...st };
				if (geomChanged) uploadCls(id);
				else { wPost({ type: "set", cmd: "classifyStyle", prop: id, data: { color: clsColorOf(c.opts), type: clsTypeOf(c.opts.type) } }); requestDraw(); }
				return h;
			},
			remove() { if (classes.delete(id)) { wPost({ type: "set", cmd: "classify", prop: id, data: null }); requestDraw(); } },
		};
		return h;
	};
	map.setTerrainExaggeration = k => { setExag(exagOf(k)); return map; };
	map.getTerrainExaggeration = () => live.terrExag;
	map.queryTerrainElevation = (lon, lat) => (live.demSpec ? (elevOf(lon, lat) ?? null) : null);   // MapLibre 同名（同期）＝地形（setTerrain／style の terrain）がある時だけ・メモに無ければ null（照会を起こす＝次の呼び出しで返る・MapLibre も地形の未着は null）2026-09-30   // ローダ着荷（数秒）を待ってから照会＝初期化中に 0 を返さない（旧＝未着 0。SDK ドッグフード 2026-09-10）。初期化失敗は reject
	// 地形の一括標本（第 2 波 F6・2026-10-12・実装つき）：map.sampleTerrain(positions, { concurrency }) → Promise<[{ lng, lat, height }]>。
	//   出どころは描いている地形と同じ（setTerrain／style の terrain の DEM が先・無い所は既定の DTM＝heightAt＝map.getHeight と同じ）。負の標高はそのまま（描く側は 0 に切る＝文書）。
	//   positions＝[lng,lat] の配列・{lng|lon,lat} の配列・GeoJSON（Point/MultiPoint/LineString の座標）。到着を待つ（wait）＝起動直後でも 0m に化けない。同時 8 件ずつ
	map.sampleTerrain = async (positions, { concurrency = 8 } = {}) => {
		const pts = positionsOf(positions);
		const out = new Array<{ lng: number; lat: number; height: number }>(pts.length); let i = 0;
		await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pts.length)) }, async () => { while (i < pts.length) { const k = i++; const [lng, lat] = pts[k]; let h = 0; try { h = await heightAt(lng, lat); } catch { h = 0; } out[k] = { lng, lat, height: Number.isFinite(h) ? h : 0 }; } }));
		return out;
	};
	// 3D Tiles・模型の高さ（Cesium の scene.sampleHeight／clampToHeight に当たる・P0 #2・2026-10-25）：map.sampleHeight(positions, { terrain, from }) → Promise<[{ lng, lat, height, source, id?, featureId? }]>。
	//   各点の真上（from m・既定 10000）から鉛直に下ろした半直線を、読み込んである 3D Tiles と模型の三角形に当てる（一番上の面）。当たらない点は地形（sampleTerrain と同じ出どころ）＝source "terrain"。
	//   terrain:false＝地形に落とさない（当たらない点は height null・source null）。高さは実スケールの m（誇張は掛けない）。今の視点で読み込んである詳細度のタイルに当てる（無い所は粗い親）
	map.sampleHeight = async (positions, { terrain = true, from = 10000, concurrency = 8 } = {}) => {
		const pts = positionsOf(positions), k = 1 / EARTH_M;
		const originH = new Map<string, Promise<number>>();   // 束の原点の地面の高さ（地形へ持ち上げる束＝"drape" と模型）
		const groundAt = (o: ArrayLike<number>) => { const ll = betaToLonLat(o), key = ll[0].toFixed(5) + "," + ll[1].toFixed(5); let p = originH.get(key); if (!p) { p = heightAt(ll[0], ll[1]).then(h => Math.max(0, +h || 0), () => 0); originH.set(key, p); } return p; };
		const raw: Array<MeshItemRef & { src: "tiles3d" | "model" }> = [
			...(live.t3dCtl?.meshItems() ?? []).map(r => ({ ...r, src: "tiles3d" as const })),
			...(live.modelCtl?.meshItems?.() ?? []).map(r => ({ ...r, src: "model" as const }))];
		const items: PickItem[] = await Promise.all(raw.map(async r => ({ ...r.item, lift: r.mode === "plane" ? 0 : (await groundAt(r.item.origin)) * k })));
		const out = new Array<SampleHeightResult>(pts.length); let i = 0;
		await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pts.length)) }, async () => { while (i < pts.length) {
			const q = i++, [lng, lat] = pts[q], u = lonlatTo3D(lng, lat), m = ELL_ON ? ellNormal3D(lng, lat) : u;   // 高さ h の点＝u + h/EARTH_M·m（query.ts の pos と同じ）
			const h = items.length ? rayMeshes(items, [u[0] + from * k * m[0], u[1] + from * k * m[1], u[2] + from * k * m[2]], [-m[0], -m[1], -m[2]]) : null;
			if (h) { const r = raw[h.item]; out[q] = { lng, lat, height: from - h.t / k, source: r.src, id: r.id, ...(h.featureId != null ? { featureId: h.featureId } : {}) }; continue; }
			if (!terrain) { out[q] = { lng, lat, height: null, source: null }; continue; }
			let th = 0; try { th = await heightAt(lng, lat); } catch { th = 0; }
			out[q] = { lng, lat, height: Number.isFinite(th) ? th : 0, source: "terrain" };
		} }));
		return out;
	};
	// 半直線の当たり（Cesium の scene.pickFromRay／drillPickFromRay・2026-10-30）：map.raycast(from, to, { limit }) → [{ lng, lat, height, distance, source, id, tile?, featureId? }]（近い順・同期）。
	//   from・to＝[lng, lat, height(m)]＝from から to の向きへ伸ばした半直線（to で止めない）。読み込んである 3D Tiles と模型の三角形に当てる（sampleHeight と同じ束）。
	//   limit（既定 1）＝奥へ進みながら別の物（id と地物の番号の組）を集める数。地形には当てない。地形へ持ち上げる束の持ち上げ＝queryTerrainElevation（同期・未着は 0）
	map.raycast = (from, to, { limit = 1 } = {}) => {
		const k = 1 / EARTH_M, w = (q: ArrayLike<number>) => { const u = lonlatTo3D(q[0], q[1]), m = ELL_ON ? ellNormal3D(q[0], q[1]) : u, h = (+q[2] || 0) * k; return [u[0] + h * m[0], u[1] + h * m[1], u[2] + h * m[2]]; };
		const raw: Array<MeshItemRef & { src: "tiles3d" | "model" }> = [
			...(live.t3dCtl?.meshItems() ?? []).map(r => ({ ...r, src: "tiles3d" as const })),
			...(live.modelCtl?.meshItems?.() ?? []).map(r => ({ ...r, src: "model" as const }))];
		const out: RaycastHit[] = [];
		if (!raw.length) return out;
		const items: PickItem[] = raw.map(r => { if (r.mode === "plane") return { ...r.item, lift: 0 }; const ll = betaToLonLat(r.item.origin), g = map.queryTerrainElevation(ll[0], ll[1]); return { ...r.item, lift: Math.max(0, Number.isFinite(g) ? +g! : 0) * k }; });
		const a = w(from), b = w(to), d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]);
		if (!(L > 0)) return out;
		const u = [d[0] / L, d[1] / L, d[2] / L], seen = new Set<string>();
		let t0 = 0;
		for (let n = 0; n < 64 && out.length < Math.max(1, limit); n++) {
			const o = [a[0] + t0 * u[0], a[1] + t0 * u[1], a[2] + t0 * u[2]], h = rayMeshes(items, o, u);
			if (!h) break;
			t0 += h.t + 1e-3 * k;   // 1 mm 奥から次を探す
			const r = raw[h.item], key = `${r.src}:${r.id}:${h.featureId ?? ""}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const P = h.world, ll = betaToLonLat(P), q = lonlatTo3D(ll[0], ll[1]), m = ELL_ON ? ellNormal3D(ll[0], ll[1]) : q, mm = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
			const height = ((P[0] - q[0]) * m[0] + (P[1] - q[1]) * m[1] + (P[2] - q[2]) * m[2]) / mm / k;   // 法線方向の高さ（m）
			out.push({ lng: ll[0], lat: ll[1], height, distance: (t0 - 1e-3 * k) / k, source: r.src, id: r.id, ...(r.tile != null && { tile: r.tile }), ...(h.featureId != null && { featureId: h.featureId }) });
		}
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
