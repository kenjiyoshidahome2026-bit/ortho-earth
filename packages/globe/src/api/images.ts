// 画像（四隅で貼る画像・ドロップの自動押し出し）・点の集約とヒートマップ・記号帳（map.addImage／removeImage／updateImage／hasImage／listImages／loadSprite）と
// 記号の層＝createGlobe から切り出した（globe.js の分割 ⑦・2026-10-15）。中身は切り出す前と同じ。createGlobe の他の所が使う物は戻り値で返す。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { evalExpr, normalizeMLLayer } from "@ortho-earth/core";
import { geopbf } from "geopbf";
import { hasHeightKey } from "../extrude-keys.ts";
import { sanitizeHTML } from "geopbf/sanitize";
import type { MLLayer } from "@ortho-earth/core";
import type { Feature, GeoPBF } from "geopbf";
import type { Gadgets, LayerMouseEvent, OverlayHandle, RenderedFeature } from "../../globe.d.ts";
import type { ImagesDeps, ImagesLive, ImagesReturn, Installing } from "../types/install.ts";
import type { GadgetFactory, GlobeMap, ImagesApi } from "../types/map.ts";
import type { UserSource } from "../types/scope.ts";

/** ML 形 gadget の層（slot＝addLayer の層 id） */
// cluster・symbols の本体は正規化の前の層（MLLayer＝中の目盛り）で受ける＝公開の型（MapLibre の形・source は物も）とは別＝登録で GadgetFactory へ寄せる（assertMLLayer が中で検める）
type LayerIn = Partial<MLLayer> & { slot?: string };
/** cluster の指定（公開の口の目盛り・paint は集約の丸・unclustered は単点の層・text は件数の字） */
type ClusterIn = Partial<MLLayer> & { clusterRadius?: number; clusterMaxZoom?: number; clusterProperties?: Record<string, unknown>; unclustered?: Partial<MLLayer>; text?: { color?: string; size?: number }; slot?: string };
/** 層を丸ごと渡された時の src（{ type, source:{ data } }）／MapLibre の geojson source */
type LayerSrc = { type?: unknown; source?: { data?: unknown } } | null | undefined;
type SourceIn = { type?: unknown; data?: unknown; cluster?: unknown; [k: string]: unknown };
/** 点の読み口に来る物（GeoPBF なら geojson を読む） */
type PointsIn = { type?: unknown; geojson?: unknown } | null | undefined;

export function installImages(map: Installing<ImagesApi>, live: ImagesLive, {
	IMAGE_KEY, LOW_MEM, PUBLIC_DZ, ac, cam, imageAttrs, mapOn, modelCtlGet, ownDestroy, rasterChanged, readGeoData, registerGadget, requestDraw, size, wPost
}: ImagesDeps): ImagesReturn {
	// 覆う描き方（本人裁定 9/21「画像で覆いましょう」）＝画像タイル層（地面アトラス＝道路・注記が上に乗る）でなく、同一フレームのオーバーレイ
	// （render worker 組み込み gadgets/imagequad-draw.js＝注記の後・geoedit と同じ drawImageQuad）。map.raster.add の { image, corners } は従来どおり地面へ貼る口
	let quadOv: OverlayHandle | null = null;
	const quadOverlay = () => quadOv ??= map.overlay({ builtin: "imagequad" }, { name: "imagequad", above: true });   // 注記の上＝注記も覆う
	const clearImages = () => { quadOv?.post({ type: "clear" }); for (const id of live.imageIds) imageAttrs.delete(id); live.imageIds = []; live.imageQuads = []; rasterChanged(); };
	const placeImages = async (pbf: GeoPBF, name: string): Promise<GeoPBF | null> => {
		clearImages();
		const { isImageFeature, cornersOf } = await import("geopbf/edit/imagequad");
		const gj = pbf.geojson, imgs: Feature[] = [], rest: Feature[] = [];
		for (const f of gj.features) (isImageFeature(f) && f.properties![IMAGE_KEY] instanceof Blob ? imgs : rest).push(f);
		const cap = LOW_MEM ? 2048 : 4096;   // 長辺の上限（省メモリ機＝Air3 jetsam の轍）
		await Promise.all(imgs.map(async (f, k) => {
			const id = `img:${k}`, op = +(f.properties!["@opacity"] as number), corners = cornersOf(f.geometry as { coordinates?: unknown } | null);
			live.imageIds.push(id); live.imageQuads.push({ id, corners, properties: f.properties! });
			try {
				let bm = await createImageBitmap(f.properties![IMAGE_KEY] as Blob);
				if (Math.max(bm.width, bm.height) > cap) { const s2 = cap / Math.max(bm.width, bm.height); const b2 = await createImageBitmap(bm, { resizeWidth: Math.round(bm.width * s2), resizeHeight: Math.round(bm.height * s2), resizeQuality: "high" }); bm.close(); bm = b2; }
				quadOverlay().post({ type: "set", id, bitmap: bm, corners, opacity: op > 0 && op <= 1 ? op : 1 }, [bm]);
				const credit = f.properties!.attribution || f.properties!.name || (f.properties![IMAGE_KEY] as File).name || name;   // 出典（HTML 可）＝消毒して出典欄の画像の項へ
				if (credit) imageAttrs.set(id, sanitizeHTML(String(credit)));
			} catch (err) { console.warn("[image] failed", id, err); }
		}));
		if (imgs.length) rasterChanged();
		if (imgs.length) console.info(`[image] ${imgs.length} image(s) placed by four corners`);
		if (!rest.length) return null;
		if (!imgs.length) return pbf;
		return geopbf({ type: "FeatureCollection", features: rest }, { gint: true, name: `drop/${name}` }).catch(err => { console.error("[image] rest", err); return null; });
	};
	// 自動押し出し＝本道の続き。前の押し出しは外す（「最後の 1 枚が勝つ」）。高さの鍵が無ければ遅延 chunk も降ろさない
	const extrudeQ = (() => { const v = new URLSearchParams(location.search).get("extrude"); if (v == null) return null; const [k, sc] = v.split(","); return { off: k === "0" || k === "off", key: k || undefined, scale: +sc > 0 ? +sc : 1 }; })();
	const BOTTOM_Q = (v => v === "drape" || v === "ground" ? v : v != null && v !== "" && isFinite(+v) ? +v : null)(new URLSearchParams(location.search).get("bottom"));   // ?bottom=<m>＝ドロップ/?g= の自動押し出しの床の高さ（既定 2000m の平面）・?bottom=drape＝地形に沿わせる・?bottom=ground＝建物と同じ接地
	const autoExtrude = async (pbf: GeoPBF) => {
		live.modelCtl?.clearExtrude();
		if (extrudeQ?.off || !(extrudeQ?.key ? pbf.keys?.includes(extrudeQ.key) : hasHeightKey(pbf.keys))) return null;
		try { return await (await modelCtlGet()).extrude(pbf.geojson, { height: extrudeQ?.key, scale: extrudeQ?.scale ?? 1, bottom: BOTTOM_Q }); }
		catch (err) { console.warn("[extrude] failed", err); return null; }
	};
	// ── 点の集約（クラスタ）とヒートマップ（MapLibre の cluster／heatmap 相当・gadgets/aggregate.js・遅延chunk・2026-09-21）──────────────
	// ヒートマップは同一フレームのオーバーレイ（heatmap-gl.js）。src＝GeoJSON/GeoPBF/File/URL（押し出しと同じ読み口）。
	//   heatmap(src, { paint:{ "heatmap-*": 式 }, minzoom, maxzoom }) または層を丸ごと（{ type:"heatmap", source:{ type:"geojson", data }, paint }）
	//   cluster(src, { clusterRadius, clusterMaxZoom, paint, unclustered:{ paint }, text }) または MapLibre の source（{ type:"geojson", data, cluster:true, … }）
	//   null＝外す。ズームは ortho の z（MapLibre の z＋1 と同じ見た目の縮尺）。
	const aggGet = async () => { const m = await import("../gadgets/aggregate.ts"); return live.aggCtl ??= m.createAggregate(map, { signal: ac.signal }); };
	const readPoints = async (src: unknown) => (typeof src === "string" || src instanceof Blob) ? await readGeoData(src) : (!(src as PointsIn)?.type && !Array.isArray(src) && (src as PointsIn)?.geojson) ? (src as PointsIn)!.geojson : src;
	// 中身（native）＝層は正規化済み（エンジンの目盛り）で受ける。内部（addLayer の描き出し）はこちらを直に呼ぶ＝公開の入口を二度くぐらない（台帳 R4）
	const heatmapNative = async (src: unknown, layer: Partial<MLLayer>, slot: string) => (await aggGet()).heatmap(await readPoints(src), layer, slot);
	registerGadget("heatmap", async (m, src: unknown, layer: LayerIn = {}) => {
		if (src == null) { (await aggGet()).clear("heatmap", layer.slot ?? "default"); return null; }   // slot＝addLayer の層 id（#34）・既定 "default"＝ガジェット直呼びの 1 枠
		if ((src as LayerSrc)?.type === "heatmap") { layer = { ...(src as LayerIn), ...layer }; src = (src as LayerSrc)!.source?.data ?? (src as LayerSrc)!.source; }
		live.assertMLLayer(layer, "heatmap");
		return heatmapNative(src, normalizeMLLayer(layer as MLLayer, PUBLIC_DZ), layer.slot ?? "default");
	});
	// 集約＝集約の source（cluster:true）と 3 枚の層（丸・単点・件数）を内部で足す（2026-10-22・旧＝cluster-2d の canvas2D のオーバーレイ）＝addLayer の集約と同じ道
	//（丸は gint・件数は注記層の GPU の字・queryRenderedFeatures／querySourceFeatures もそのまま）。id＝gadget-cluster（slot 付きは gadget-cluster:<slot>）と -clusters／-unclustered／-count。
	// 丸をクリック＝その集約がばらけるズームへ寄る（MapLibre の getClusterExpansionZoom の定番）
	const clusterIds = (slot: string) => { const s = slot === "default" ? "gadget-cluster" : `gadget-cluster:${slot}`; return { s, c: s + "-clusters", u: s + "-unclustered", t: s + "-count" }; };
	const clusterClicks = new Map<string, (e: LayerMouseEvent) => void>();   // slot → 丸のクリック
	const clusterClear = (slot: string) => {
		const k = clusterIds(slot), cb = clusterClicks.get(slot);
		if (cb) { map.off("click", k.c, cb); clusterClicks.delete(slot); }
		for (const id of [k.t, k.u, k.c]) if (map.getLayer(id)) map.removeLayer(id);
		if (map.getSource(k.s)) map.removeSource(k.s);
	};
	registerGadget("cluster", (async (m: GlobeMap, src: unknown, opts: ClusterIn = {}) => {
		const slot = opts.slot ?? "default";
		clusterClear(slot);
		if (src == null) return null;
		if ((src as SourceIn)?.type === "geojson" && "data" in (src as object)) { const { data, cluster, type, ...rest } = src as SourceIn; opts = { ...rest, ...opts }; src = data; }   // MapLibre の source（cluster:true・clusterRadius・clusterMaxZoom）
		live.assertMLLayer(opts, "cluster"); if (opts.unclustered) live.assertMLLayer(opts.unclustered, "cluster");
		const { CLUSTER_DEFAULT } = await import("../gadgets/aggregate-core.ts"), k = clusterIds(slot), tx = { ...CLUSTER_DEFAULT.text, ...(opts.text || {}) };
		let data = await readPoints(src); if (Array.isArray(data)) data = { type: "FeatureCollection", features: data };
		live.addSourceAt(k.s, { type: "geojson", data, cluster: true, clusterRadius: opts.clusterRadius ?? 50, clusterMaxZoom: opts.clusterMaxZoom ?? 14, ...(opts.clusterProperties ? { clusterProperties: opts.clusterProperties } : {}) } as UserSource, PUBLIC_DZ);   // 公開の口の目盛り（clusterMaxZoom の既定 14 も）
		const L = (id: string, layer: Partial<MLLayer>, filter: unknown) => live.addLayerAt({ ...layer, id, source: k.s, filter: layer.filter != null ? ["all", filter, layer.filter] : filter } as MLLayer, undefined, PUBLIC_DZ);
		const zr: Partial<MLLayer> = {}; for (const key of ["minzoom", "maxzoom", "metadata"] as const) if (opts[key] != null) (zr as Record<string, unknown>)[key] = opts[key];   // 集約の丸と件数の出しズーム・出自
		await L(k.c, { type: "circle", ...zr, paint: { ...CLUSTER_DEFAULT.paint, ...(opts.paint || {}) } }, ["has", "point_count"]);
		await L(k.u, { type: "circle", ...(opts.unclustered || {}), paint: { ...CLUSTER_DEFAULT.unclustered.paint, ...(opts.unclustered?.paint || {}) } }, ["!", ["has", "point_count"]]);
		await L(k.t, { type: "symbol", ...zr, layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Semibold"], "text-size": tx.size, "text-allow-overlap": true, "text-ignore-placement": true },
			paint: { "text-color": tx.color } }, ["has", "point_count"]);   // 件数は必ず出す（旧 cluster-2d と同じ＝衝突で消さない）
		const cb = (e: LayerMouseEvent) => {
			const f = e.features?.[0] as (RenderedFeature & { expansionZoom?: number }) | undefined, ez = f?.expansionZoom;
			if (ez == null || f!.geometry?.type !== "Point") return;
			const [lon, lat] = f!.geometry.coordinates as number[];
			map.flyTo(lon, lat, Math.min(20, Math.max(ez, map.getZoom() + 1)), (map.view.pitch || 0) * 180 / Math.PI, (map.view.bearing || 0) * 180 / Math.PI);
		};
		map.on("click", k.c, cb); clusterClicks.set(slot, cb);
		const cs = await live.clusterOf(k.s);
		return { points: cs?.points ?? 0, clusters: cs?.counts ?? [] };
	}) as GadgetFactory<Gadgets["cluster"]>);
	// ── 記号帳（sprite）と記号の層（MapLibre の addImage／sprite／symbol 相当・gadgets/symbols.js・遅延chunk・2026-09-21）──────────────
	// 線に沿う geojson の注記（C9・gadgets/gjlabels.js）＝symbol-placement line/line-center の geojson の symbol 層。vector の注記と同じ口（sendLabels "vt:"）へ
	const gjGet = async () => { const m = await import("../gadgets/gjlabels.ts"); if (live.gjCtl) return live.gjCtl; ownDestroy.push(() => live.gjCtl?.destroy()); return live.gjCtl = m.createGJLabels(map, { cam, size: () => size, dpr: live.dpr, sendLabels: (id, list, meta) => { wPost({ type: "set", cmd: "vtLabels", layer: "vt:" + id, data: { list, ...meta } }); requestDraw(); } }); };
	const gjIsLine = (layer: Partial<MLLayer>) => { const p = layer.layout?.["symbol-placement"]; if (p == null) return false; const v = typeof p === "string" ? p : evalExpr(p, { zoom: cam.zoom, props: {}, geom: "LineString", vars: {}, gs: live.MAP_GS, origin: "ml" }); return v === "line" || v === "line-center"; };
	const missingImgs = new Set<string>();   // styleimagemissing を鳴らした名前（名前ごとに 1 回＝MapLibre と同じ）
	function imageMissing(name: string) {
		if (!name || missingImgs.has(name) || live.symCtl?.hasImage(name)) return;
		missingImgs.add(name);
		for (const cb of [...mapOn.styleimagemissing]) { try { cb({ id: name }); } catch (e) { console.error("[map.on styleimagemissing]", e); } }
	}
	// 記号帳の写しは render worker の注記層（labels2d）にも届ける＝基図と vector source の symbol 層の icon-image（段 3）。ImageBitmap は写して転送（main の記号帳はそのまま）
	const symGet = async () => { const m = await import("../gadgets/symbols.ts"); return live.symCtl ??= m.createSymbols(map, { signal: ac.signal,
		onImage: (name, e) => createImageBitmap(e.bitmap).then(bm => { wPost({ type: "set", cmd: "labelImage", data: { name, bitmap: bm, pixelRatio: e.pixelRatio, sdf: e.sdf, stretchX: e.stretchX ?? null, stretchY: e.stretchY ?? null, content: e.content ?? null } }, [bm]); requestDraw(); }).catch(err => console.warn("[symbols] image to labels", name, err)),
		onImageRemoved: name => { wPost({ type: "set", cmd: "labelImage", data: { name, bitmap: null } }); requestDraw(); }, onMissing: imageMissing }); };
	// 足している途中の画像（公式例の門 2 巡目）＝MapLibre の addImage は同期＝直後の addLayer（fill-pattern・icon-image）がその画像を使える。
	// こちらは画像の変換で非同期＝層を載せる前（mountLayer の頭）に待つ（途中の画像が無ければ何も待たない）
	const pendingImages = new Set<Promise<unknown>>();
	map.addImage = (name, img, o) => {   // img＝ImageBitmap/HTMLImageElement/Blob/URL/{width,height,data}・o＝{ pixelRatio, sdf }
		const p = (async () => (await symGet()).addImage(name, img, o))();
		pendingImages.add(p); p.catch(() => {}).finally(() => pendingImages.delete(p));
		return p;
	};
	map.removeImage = name => live.symCtl?.removeImage(name);
	map.updateImage = async (name, img) => {   // 画素だけ差し替える（MapLibre 同名・動く記号）＝層を評価し直さない。足している途中の画像は待つ（待たずに「無い名前」として足すと pixelRatio が落ちる）
		if (pendingImages.size) await Promise.allSettled([...pendingImages]);
		return live.symCtl?.hasImage(name) ? live.symCtl.updateImage(name, img) : map.addImage(name, img);
	};
	map.hasImage = name => !!live.symCtl?.hasImage(name);
	map.listImages = () => live.symCtl?.listImages() ?? [];
	map.loadSprite = async (base, prefix) => (await symGet()).loadSprite(base, prefix);                          // MapLibre の sprite（base.json＋base.png・@2x）
	// 中身（native）＝層はエンジンの目盛り・ネイティブの意味で受ける（worldcontent の記号の層はここ＝MapLibre 形の入口を通らない・台帳 R8）。
	// 記号と字は注記層（gjlabels の点置き＝基図と同じ衝突・テキスト GPU 化 T-P3 §4i）・gadget は評価だけ（queryRenderedFeatures・styleimagemissing）。
	// 注記層の組は "n:<id>"（MapLibre の層の id と分ける）・順の鍵 -1＝利用者の MapLibre の層の後・基図の前
	const symbolsNative = async (src: unknown, layer: Partial<MLLayer> = {}) => {
		const id = layer.id || "symbols", c = await symGet(), gj = await gjGet();
		if (src == null) { c.removeLayer(id); gj.remove("n:" + id); return null; }
		const pts = await readPoints(src), r = c.addLayer(id, pts, layer, false);
		gj.set("n:" + id, { type: "symbol", ...layer, id } as MLLayer, pts, -1, true);   // 型の無い層（worldcontent）も symbol として焼く
		return r;
	};
	registerGadget("symbols", (async (m: GlobeMap, src: unknown, layer: LayerIn = {}) => {   // 記号の層（src＝点の GeoJSON/GeoPBF/File/URL か層を丸ごと）・null＋{id}＝外す
		if (src == null) return symbolsNative(null, layer);
		if ((src as LayerSrc)?.type === "symbol") { layer = { ...(src as LayerIn), ...layer }; src = (src as LayerSrc)!.source?.data ?? (src as LayerSrc)!.source; }
		live.assertMLLayer(layer, "symbols");
		return symbolsNative(src, normalizeMLLayer(layer as MLLayer, PUBLIC_DZ));
	}) as GadgetFactory<Gadgets["symbols"]>);

	return { imageMissing, symGet, placeImages, clearImages, autoExtrude, readPoints, aggGet, pendingImages, heatmapNative, gjIsLine, gjGet, symbolsNative };
}
