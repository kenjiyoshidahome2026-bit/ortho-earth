// 画像（四隅で貼る画像・ドロップの自動押し出し）・点の集約とヒートマップ・記号帳（map.addImage／removeImage／updateImage／hasImage／listImages／loadSprite）と
// 記号の層＝createGlobe から切り出した（globe.js の分割 ⑦・2026-10-15）。中身は切り出す前と同じ。createGlobe の他の所が使う物は戻り値で返す。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { evalExpr, normalizeMLLayer, rescaleZoomNum } from "@ortho-earth/core";
import { geopbf } from "geopbf";
import { hasHeightKey } from "../extrude-keys.js";
import { sanitizeHTML } from "geopbf/sanitize";

export function installImages(map, live, {
	IMAGE_KEY, LOW_MEM, PUBLIC_DZ, ac, cam, imageAttrs, mapOn, modelCtlGet, ownDestroy, rasterChanged, readGeoData, requestDraw, size, wPost
}) {
	// 覆う描き方（本人裁定 9/21「画像で覆いましょう」）＝画像タイル層（地面アトラス＝道路・注記が上に乗る）でなく、同一フレームのオーバーレイ
	// （render worker 組み込み gadgets/imagequad-draw.js＝注記の後・geoedit と同じ drawImageQuad）。map.raster.add の { image, corners } は従来どおり地面へ貼る口
	let quadOv = null;
	const quadOverlay = () => quadOv ??= map.overlay({ builtin: "imagequad" }, { name: "imagequad", above: true });   // 注記の上＝注記も覆う
	const clearImages = () => { quadOv?.post({ type: "clear" }); for (const id of live.imageIds) imageAttrs.delete(id); live.imageIds = []; live.imageQuads = []; rasterChanged(); };
	const placeImages = async (pbf, name) => {
		clearImages();
		const { isImageFeature, cornersOf } = await import("geopbf/edit/imagequad");
		const gj = pbf.geojson, imgs = [], rest = [];
		for (const f of gj.features) (isImageFeature(f) && f.properties[IMAGE_KEY] instanceof Blob ? imgs : rest).push(f);
		const cap = LOW_MEM ? 2048 : 4096;   // 長辺の上限（省メモリ機＝Air3 jetsam の轍）
		await Promise.all(imgs.map(async (f, k) => {
			const id = `img:${k}`, op = +f.properties["@opacity"], corners = cornersOf(f.geometry);
			live.imageIds.push(id); live.imageQuads.push({ id, corners, properties: f.properties });
			try {
				let bm = await createImageBitmap(f.properties[IMAGE_KEY]);
				if (Math.max(bm.width, bm.height) > cap) { const s2 = cap / Math.max(bm.width, bm.height); const b2 = await createImageBitmap(bm, { resizeWidth: Math.round(bm.width * s2), resizeHeight: Math.round(bm.height * s2), resizeQuality: "high" }); bm.close(); bm = b2; }
				quadOverlay().post({ type: "set", id, bitmap: bm, corners, opacity: op > 0 && op <= 1 ? op : 1 }, [bm]);
				const credit = f.properties.attribution || f.properties.name || f.properties[IMAGE_KEY].name || name;   // 出典（HTML 可）＝消毒して出典欄の画像の項へ
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
	const autoExtrude = async pbf => {
		live.modelCtl?.clearExtrude();
		if (extrudeQ?.off || !(extrudeQ?.key ? pbf.keys?.includes(extrudeQ.key) : hasHeightKey(pbf.keys))) return null;
		try { return await (await modelCtlGet()).extrude(pbf.geojson, { height: extrudeQ?.key, scale: extrudeQ?.scale ?? 1, bottom: BOTTOM_Q }); }
		catch (err) { console.warn("[extrude] failed", err); return null; }
	};
	// ── 点の集約（クラスタ）とヒートマップ（MapLibre の cluster／heatmap 相当・gadgets/aggregate.js・遅延chunk・2026-09-21）──────────────
	// 描画は同一フレームのオーバーレイ（heatmap-gl.js・cluster-2d.js）＝エンジン本体は触らない。src＝GeoJSON/GeoPBF/File/URL（押し出しと同じ読み口）。
	//   heatmap(src, { paint:{ "heatmap-*": 式 }, minzoom, maxzoom }) または層を丸ごと（{ type:"heatmap", source:{ type:"geojson", data }, paint }）
	//   cluster(src, { clusterRadius, clusterMaxZoom, paint, unclustered:{ paint }, text }) または MapLibre の source（{ type:"geojson", data, cluster:true, … }）
	//   null＝外す。ズームは ortho の z（MapLibre の z＋1 と同じ見た目の縮尺）。
	const aggGet = async () => { const m = await import("../gadgets/aggregate.js"); return live.aggCtl ??= m.createAggregate(map, { signal: ac.signal }); };
	const readPoints = async src => (typeof src === "string" || src instanceof Blob) ? await readGeoData(src) : (!src?.type && !Array.isArray(src) && src?.geojson) ? src.geojson : src;
	// 中身（native）＝層は正規化済み（エンジンの目盛り）で受ける。内部（addLayer の描き出し）はこちらを直に呼ぶ＝公開の入口を二度くぐらない（台帳 R4）
	const heatmapNative = async (src, layer, slot) => (await aggGet()).heatmap(await readPoints(src), layer, slot);
	const clusterNative = async (src, opts, slot) => (await aggGet()).cluster(await readPoints(src), opts, slot);
	map.gadget("heatmap", async function (src, layer = {}) {
		if (src == null) { (await aggGet()).clear("heatmap", layer.slot ?? "default"); return null; }   // slot＝addLayer の層 id（#34）・既定 "default"＝ガジェット直呼びの 1 枠
		if (src?.type === "heatmap") { layer = { ...src, ...layer }; src = src.source?.data ?? src.source; }
		live.assertMLLayer(layer, "heatmap");
		return heatmapNative(src, normalizeMLLayer(layer, PUBLIC_DZ), layer.slot ?? "default");
	});
	map.gadget("cluster", async function (src, opts = {}) {
		if (src == null) { (await aggGet()).clear("cluster", opts.slot ?? "default"); return null; }
		if (src?.type === "geojson" && "data" in src) { const { data, cluster, type, ...rest } = src; opts = { ...rest, ...opts }; src = data; }   // MapLibre の source（cluster:true・clusterRadius・clusterMaxZoom）
		live.assertMLLayer(opts, "cluster"); if (opts.unclustered) live.assertMLLayer(opts.unclustered, "cluster");
		const o = { ...normalizeMLLayer(opts, PUBLIC_DZ), clusterMaxZoom: rescaleZoomNum(opts.clusterMaxZoom ?? 14, PUBLIC_DZ, 0) };   // clusterMaxZoom の既定 14 は公開の口の目盛り
		if (opts.unclustered) o.unclustered = normalizeMLLayer(opts.unclustered, PUBLIC_DZ);
		return clusterNative(src, o, opts.slot ?? "default");
	});
	// ── 記号帳（sprite）と記号の層（MapLibre の addImage／sprite／symbol 相当・gadgets/symbols.js・遅延chunk・2026-09-21）──────────────
	// 線に沿う geojson の注記（C9・gadgets/gjlabels.js）＝symbol-placement line/line-center の geojson の symbol 層。vector の注記と同じ口（sendLabels "vt:"）へ
	const gjGet = async () => { const m = await import("../gadgets/gjlabels.js"); if (live.gjCtl) return live.gjCtl; ownDestroy.push(() => live.gjCtl?.destroy()); return live.gjCtl = m.createGJLabels(map, { cam, size: () => size, dpr: live.dpr, sendLabels: (id, list, meta) => { wPost({ type: "set", cmd: "vtLabels", layer: "vt:" + id, data: { list, ...meta } }); requestDraw(); } }); };
	const gjIsLine = layer => { const p = layer.layout?.["symbol-placement"]; if (p == null) return false; const v = typeof p === "string" ? p : evalExpr(p, { zoom: cam.zoom, props: {}, geom: "LineString", vars: {}, gs: live.MAP_GS, origin: "ml" }); return v === "line" || v === "line-center"; };
	const missingImgs = new Set();   // styleimagemissing を鳴らした名前（名前ごとに 1 回＝MapLibre と同じ）
	function imageMissing(name) {
		if (!name || missingImgs.has(name) || live.symCtl?.hasImage(name)) return;
		missingImgs.add(name);
		for (const cb of [...mapOn.styleimagemissing]) { try { cb({ id: name }); } catch (e) { console.error("[map.on styleimagemissing]", e); } }
	}
	// 記号帳の写しは render worker の注記層（labels2d）にも届ける＝基図と vector source の symbol 層の icon-image（段 3）。ImageBitmap は写して転送（main の記号帳はそのまま）
	const symGet = async () => { const m = await import("../gadgets/symbols.js"); return live.symCtl ??= m.createSymbols(map, { signal: ac.signal,
		onImage: (name, e) => createImageBitmap(e.bitmap).then(bm => { wPost({ type: "set", cmd: "labelImage", data: { name, bitmap: bm, pixelRatio: e.pixelRatio, sdf: e.sdf, stretchX: e.stretchX ?? null, stretchY: e.stretchY ?? null, content: e.content ?? null } }, [bm]); requestDraw(); }).catch(err => console.warn("[symbols] image to labels", name, err)),
		onImageRemoved: name => { wPost({ type: "set", cmd: "labelImage", data: { name, bitmap: null } }); requestDraw(); }, onMissing: imageMissing }); };
	// 足している途中の画像（公式例の門 2 巡目）＝MapLibre の addImage は同期＝直後の addLayer（fill-pattern・icon-image）がその画像を使える。
	// こちらは画像の変換で非同期＝層を載せる前（mountLayer の頭）に待つ（途中の画像が無ければ何も待たない）
	const pendingImages = new Set();
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
	// 中身（native）＝層はエンジンの目盛り・ネイティブの意味で受ける（worldcontent の記号の層はここ＝MapLibre 形の入口を通らない・台帳 R8）
	const symbolsNative = async (src, layer = {}) => {
		const c = await symGet();
		if (src == null) { c.removeLayer(layer.id || "symbols"); return null; }
		return c.addLayer(layer.id || "symbols", await readPoints(src), layer);
	};
	map.gadget("symbols", async function (src, layer = {}) {   // 記号の層（src＝点の GeoJSON/GeoPBF/File/URL か層を丸ごと）・null＋{id}＝外す
		if (src == null) return symbolsNative(null, layer);
		if (src?.type === "symbol") { layer = { ...src, ...layer }; src = src.source?.data ?? src.source; }
		live.assertMLLayer(layer, "symbols");
		return symbolsNative(src, normalizeMLLayer(layer, PUBLIC_DZ));
	});

	return { imageMissing, symGet, placeImages, clearImages, autoExtrude, readPoints, clusterNative, aggGet, pendingImages, heatmapNative, gjIsLine, gjGet, symbolsNative };
}
