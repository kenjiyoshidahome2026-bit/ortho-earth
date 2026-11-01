// MapLibre 形の style・source・layer の口（addSource／getSource／removeSource・addLayer／removeLayer／moveLayer・paint／layout／filter／zoom 域・
// feature state・global state・addFontFace・getLayers／getStyle／setStyle・基図の層を実行時に触る口・querySourceFeatures）と、それを支える
// 内部の入口（addSourceAt／addLayerAt・remountSource・remergeBase）＝createGlobe から切り出した（globe.js の分割 ⑫・2026-10-15）。中身は切り出す前と同じ。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { DZ_KEY, evalExpr, layerDzOf, layerPaintTable, layerPaintZoom, normalizeMLLayer, paintFast, paintTableFast, pmtilesInfo, rescaleZoomExpr, rescaleZoomNum, resolveVectorSource, sourceFeatures, truthy, usesGlobalState, ML_CZ0_KEY, ML_CZ1_KEY } from "@ortho-earth/core";
import { PAINT_DEFAULTS, createTransitions, interpolable, transitionOf } from "../transition.ts";
import { normLight } from "../light.ts";
import { normSky } from "../sky-spec.ts";
import { copyFontBytes, normSprite, spriteEcho } from "../mlsmall.ts";
import { sanitizeHTML } from "geopbf/sanitize";
import { GEOJSON_LAYER } from "@ortho-earth/core/geojsonvt";
import type { MLLayer, PaintZoom, PtLayer } from "@ortho-earth/core";
import type { Bbox, LonLat, MapLibreLayer, QuantizedMeshSource, RasterDemSource, RenderedFeature, StyleExpression } from "../../globe.d.ts";
import type { ExtExtras, Installing, StyleDeps, StyleLive, StyleOrderEntry, StyleReturn } from "../types/install.ts";
import type { StyleApi } from "../types/map.ts";
import type { BaseOverride, ExtStyle, UserLayerRec, UserSource } from "../types/scope.ts";

type Corners4 = [LonLat, LonLat, LonLat, LonLat];
/** getSource の答え（公開の型） */
type SourceFace = NonNullable<ReturnType<StyleApi["getSource"]>>;
/** 四隅の動画・canvas の手綱（videoquad の get）＝canvas だけ getCanvas・play・pause を持つ */
type MediaHandle = { setCoordinates(c: Corners4): unknown; getCanvas?(): unknown; play?(): unknown; pause?(): unknown };
/** 動画・canvas の source の顔（source の中身＋手綱） */
type MediaFace = UserSource & { setCoordinates(c: Corners4): MediaFace; getCanvas?(): unknown; play?(): void; pause?(): void };
/** GeoJSON の地物（updateData・querySourceFeatures が読む分） */
type FeatureLike = { type?: string; id?: unknown; properties?: Record<string, unknown> | null; geometry?: NonNullable<Parameters<typeof evalExpr>[1]>["geojson"] };
/** source の data（object）＝FeatureCollection か Feature */
type DataLike = FeatureLike & { features?: FeatureLike[] };
/** GeoJSONSource.updateData の差分（MapLibre 同名） */
interface SourceDiff {
	removeAll?: boolean; remove?: unknown[]; add?: FeatureLike[];
	update?: Array<{ id: unknown; removeAllProperties?: boolean; removeProperties?: string[]; addOrUpdateProperties?: Array<{ key: string; value: unknown }>; newGeometry?: FeatureLike["geometry"] }>;
}
/** getSource の顔（source の中身＋setData 等の口） */
type SourceSelf = UserSource & {
	setData(data: unknown): Promise<void>; getClusterExpansionZoom?(cid: number): Promise<number>;
	updateData?(diff: SourceDiff | null | undefined): Promise<void>; updateImage?(o: { url?: string; coordinates?: Corners4 } | null | undefined): SourceSelf; setCoordinates?(c: Corners4): SourceSelf;
};
/** その他の層の記録（set 系で書き換える＝paint・layout は在る） */
type NoteLayer = MLLayer & { paint: Record<string, unknown>; layout: Record<string, unknown> };

export function installStyle(map: Installing<StyleApi>, live: StyleLive, {
	AUTO_BLD, BASE_SOURCE, BASE_SRC, DEBUG_GLOBALS, GJVT, NO_BG_WHITE, PUBLIC_DZ, R2D, STYLE_DZ, animNow, assertMLLayer, autoBldLayer, autoBldOn,
	autoBldReadOnly, baseOverrides, baseMoves, moveBefore, baseSidNow, baseSrcSpec, baseVis, bgOf, bldFillLi, cam, dbgHost, drawLayerOf, dropFollow, emitSourceData, extBaseStyle,
	extSourceFields, isVecSrc, kindOf, landDefault, landOf, loadExtStyle, mergeReq, mkThemes, mlFeatureState, mlGintData, mlIdOf, mlLayers, mlPasses,
	mlSourceDz, mlSources, mlVisible, mountLayer, onMove, rasterAdjust, rasterFade, rasterPaintOpts, rasterPend, rasterSampling, clusterOf, clusterNow,
	rebuildGint, reliefOpacity, renderer, reorderLayers, requestDraw, requester, seaLi, seaOf, sendLight, sendSky, sendUserAnchors, setAutoBld,
	setDataLive, setDataQ, setMapGS, setPipelineStyle, setSrcAttr, size, spriteDrop, spriteLoad, spriteNames, srcId, srcOf, stripMl, unmountLayer, userBg, vtRaw,
	vtRouted, vtdDesc, vtdMounting, vtdOrder, vtxDescs, vtxFS, vtxFSKey, vtxStateOf, wPost, withBaseOverrides, withPM, withUserBg
}: StyleDeps): StyleReturn {
	map.setCustomLayerHost = h => { live.customHost = h; return map; };
	map.getCustomLayerCanvas = () => live.customCtl?.canvas ?? null;
	map.getCustomLayerHandle = id => mlLayers.get(id)?.ov ?? null;   // worker 経路の custom 層（addLayer の url）のオーバーレイの手綱（post/onmessage/remove）＝検定・利用者の層へのメッセージ
	// この source を使う層を載せ直す（setData・updateData・updateImage・視野追従の読み足し＝#176）
	const remountSource: StyleReturn["remountSource"] = async (id, dataChanged = true) => {
		const vs = [...mlLayers.values()].filter(v => srcId(v.layer) === id && mlVisible(v));
		if (vs.some(v => v.kind === "gint")) await rebuildGint(id, { dataChanged });
		for (const v of vs) if (v.kind !== "gint") await mountLayer(v);
		emitSourceData(id);
	};
	const addSourceAt: StyleReturn["addSourceAt"] = (id, spec, dz) => { if (mlSources.has(id)) throw new Error(`addSource: source "${id}" already exists`); mlSources.set(id, spec); mlSourceDz.set(id, dz); return map; };
	map.addSource = (id, spec) => addSourceAt(id, spec as UserSource, PUBLIC_DZ);
	map.getSource = id => {
		const sp = mlSources.get(id);
		if (!sp) return baseSrcSpec(id) ? { type: "vector", ...(live.EXT?.ms.sources![id] || {}) } as SourceFace : undefined;   // 基図の source（段 8①）＝読むだけ
		if (sp.type === "video" || sp.type === "canvas") {   // MapLibre の VideoSource／CanvasSource の顔（#49・C3）＝この source を使う最初の層の動画／canvas
			const v = [...mlLayers.values()].find(x => srcId(x.layer) === id && x.kind === "raster"), h = v ? live.videoCtl?.get(v.layer.id) as MediaHandle | undefined : null;
			const face: MediaFace = { ...sp, ...(h || {}), setCoordinates(c) { sp.coordinates = c; h?.setCoordinates(c); return this; } };
			if (sp.type === "canvas") { face.getCanvas = () => h?.getCanvas?.() ?? (typeof sp.canvas === "string" ? document.getElementById(sp.canvas) : sp.canvas); face.play = () => { sp.animate = true; h?.play?.(); }; face.pause = () => { sp.animate = false; h?.pause?.(); }; }   // 層が無い間は記録だけ
			return face as UserSource as SourceFace;
		}
		const extra = sp.cluster ? { getClusterExpansionZoom: async (cid: number) => { const ez = (await clusterOf(id))?.byCid.get(cid); if (ez == null) throw new Error(`getClusterExpansionZoom: no cluster ${cid} in source "${id}"`); return rescaleZoomNum(ez, 0, PUBLIC_DZ)!; } } : {};   // MapLibre 同名（段 6・公開の口の目盛り）
		const remount = (dataChanged = true) => remountSource(id, dataChanged);   // この source を使う層を載せ直す（setData・updateData・updateImage の共通）
		const self: SourceSelf = { ...sp, ...extra, setData: data => { sp.data = data; delete sp.cacheKey; return setDataLive(id); } };   // cacheKey＝足した時の data の鍵＝入れ替えたら外す（古い控えを掴まない）
		// MapLibre 同名（公式例の門 2 巡目）：GeoJSONSource.updateData（差分＝remove/add/update・地物の id で当てる）・ImageSource.updateImage／setCoordinates
		if (sp.type === "geojson") self.updateData = async diff => {
			const d = sp.data as DataLike | string | null | undefined;
			if (!d || typeof d !== "object") throw new Error(`updateData: source "${id}" data is not an object (a URL source cannot take a diff)`);
			const fc = (d.type === "FeatureCollection" ? d : { type: "FeatureCollection", features: d.type === "Feature" ? [d] : [] }) as DataLike & { features: FeatureLike[] };
			const pk = sp.promoteId == null ? null : typeof sp.promoteId === "string" ? sp.promoteId : Object.values(sp.promoteId)[0];
			const idOf = (f: FeatureLike) => f.id ?? (pk != null ? f.properties?.[pk] : undefined);
			let fs: FeatureLike[] = diff?.removeAll ? [] : [...fc.features];
			if (diff?.remove?.length) { const rm = new Set(diff.remove); fs = fs.filter(f => !rm.has(idOf(f))); }
			for (const u of diff?.update || []) {
				const i = fs.findIndex(f => idOf(f) === u.id); if (i < 0) continue;
				const f: FeatureLike & { properties: Record<string, unknown> } = { ...fs[i], properties: u.removeAllProperties ? {} : { ...(fs[i].properties || {}) } };
				for (const k of u.removeProperties || []) delete f.properties[k];
				for (const { key, value } of u.addOrUpdateProperties || []) f.properties[key] = value;
				if (u.newGeometry) f.geometry = u.newGeometry;
				fs[i] = f;
			}
			if (diff?.add?.length) { const add = new Set(diff.add.map(idOf)); fs = fs.filter(f => !add.has(idOf(f))).concat(diff.add); }
			sp.data = { ...fc, features: fs }; delete sp.cacheKey; await remount();
		};
		if (sp.type === "image") {
			self.updateImage = o => { if (o?.url) sp.url = o.url; if (o?.coordinates) sp.coordinates = o.coordinates; remount(false); return self; };
			self.setCoordinates = c => { sp.coordinates = c; remount(false); return self; };
		}
		return self as SourceFace;
	};
	map.removeSource = id => {
		if ([...mlLayers.values()].some(v => srcId(v.layer) === id)) throw new Error(`removeSource: source "${id}" is used by a layer`);   // MapLibre と同じ＝使われている source は外せない
		mlSources.delete(id); vtxDescs.delete(id); vtdDesc.delete(id); dropFollow(id); setSrcAttr(id, null); for (const k of [...live.vtdQueryCache.keys()]) if (k.startsWith(id + "|")) live.vtdQueryCache.delete(k); return map;
	};
	// global-state（MapLibre v5 同名・記号の残件③・2026-09-28）：式の ["global-state", 鍵] が読む地図全体の状態。変えたらそれを読む層だけ評価し直す。
	// geojson の fill/line/circle＝gint の表を作り直す（main の buildMLTable）・記号/集約/模様/押し出し＝relayer（main）・vector の描く層/押し出し＝版を上げて組み直す（worker へ gs）・基図の層＝restyleBase（tile worker へ globalState）
	map.setGlobalStateProperty = (key, value) => {
		if (typeof key !== "string") throw new Error("setGlobalStateProperty: key must be a string");
		setMapGS({ ...live.MAP_GS, [key]: value === undefined ? null : value });
		const uses = (L: MLLayer | null | undefined) => usesGlobalState([L?.filter, L?.layout, L?.paint]);
		for (const e of mlPasses.values()) if (e.holder?.pass?.layers?.some(uses)) e.h.setPaint({}, null);
		for (const v of mlLayers.values()) {
			if (v.kind === "gint" || v.kind === "custom" || !uses(drawLayerOf(v)) || !mlVisible(v)) continue;
			if (v.kind === "vtdraw" || v.kind === "vtextrude") v.layer = { ...v.layer, metadata: { ...(v.layer.metadata || {}), "ortho:gs": ((v.layer.metadata?.["ortho:gs"] as number | undefined) ?? 0) + 1 } };   // 組み立ての署名を変える（worker は build の gs で評価）
			relayer(v);
		}
		if (live.EXT && live.style.layers.some(uses)) restyleBase();
		requestDraw();
		return map;
	};
	map.getGlobalState = () => ({ ...live.MAP_GS });
	// Web フォントを差す口（段 2）：text-font の family がブラウザに無い時、利用者が書体を持ち込む。main（DOM の注記・popup）と render worker（注記 canvas・記号・集約）の両方に同じ FontFace を載せる。
	// source＝URL 文字列（"url(…)" を付けても付けなくても）か ArrayBuffer。descriptors＝weight/style（MapLibre の名前で "Noto Sans Bold" を引くなら weight "700" で載せる）。戻り＝両方の読み込みの Promise
	map.addFontFace = async (family, source, descriptors = {}) => {
		if (typeof family !== "string" || !family.trim()) throw new Error("addFontFace: family is required");
		const src = typeof source === "string" ? (/^\s*url\(/.test(source) ? source : `url(${JSON.stringify(new URL(source, location.href).href)})`) : source;
		if (typeof source === "string") { const r = await fetch(new URL(source, location.href).href, { credentials: "omit" }); if (!r.ok) throw new Error(`addFontFace: HTTP ${r.status} for ${source}`); }   // 先に取れるか確かめる（worker の失敗は黙る）
		const buf = typeof source === "string" ? null : source;
		const mainP = (async () => { if (typeof FontFace !== "function" || !document.fonts) return false; const ff = new FontFace(family, buf ?? src, descriptors); await ff.load(); document.fonts.add(ff); return true; })();
		wPost({ type: "fontFace", family, source: buf ? copyFontBytes(buf) : src, descriptors }, buf ? [] : undefined);
		await mainP;
		requestDraw();
		return map;
	};
	// 画像タイル層の source（raster/raster-dem→hillshade/image/video）＝その source を使う見えている層が、開く途中（mounting＝TileJSON/画像の取得・worker が開くまで）か未着（rasterPend）なら false
	const rasterSrcLoaded = (sid: string) => {
		for (const [lid, v] of mlLayers) if ((v.kind === "raster" || v.kind === "hillshade" || v.kind === "colorrelief") && srcId(v.layer) === sid && mlVisible(v) && (v.mounting || rasterPend.get(lid)! > 0)) return false;
		if (live.EXT) for (const lid of extExtras.raster) if (live.EXT.ms.layers.find(L => L.id === lid)?.source === sid && rasterPend.get(lid)! > 0) return false;   // 外来 style の画像層（mountExtExtras）
		return true;
	};
	// 外来 style の source（vector の基図・画像層・地形の raster-dem）も受ける＝画像層は mountExtExtras の途中（extExtras.mounting）と未着を見る
	const extSrcKnown = (id: string) => !!live.EXT?.ms.sources?.[id];
	map.isSourceLoaded = id => (mlSources.has(id) || !!baseSrcSpec(id) || extSrcKnown(id)) && ![...mlLayers.values()].some(v => v.mounting && srcId(v.layer) === id) && !setDataQ.has(id) && (live.vtxCtl ? live.vtxCtl.loaded(id) : true) && !vtdMounting.has(id) && (live.vtdCtl ? live.vtdCtl.loaded(id) : true) && rasterSrcLoaded(id) && !(extSrcKnown(id) && extExtras.mounting);   // vector source の押し出し・描く層＝見えているタイルが組み上がって載るまで false（MapLibre 同名）
	// get 系＝渡されたままを返す。層の目盛りが公開の口と違う時（style.json 由来など）だけ metadata["ortho:dz"] でその目盛りを申告する
	// always＝getStyle（もう一度 setStyle に読ませる文書）＝公開の口と同じ目盛りでも申告する（style 経路の既定は MapLibre の z＝省くと二重にずれる）
	// TODO(ts): core の layerDzOf の型は dflt に null（申告が無い＝null）を受けない＝型を広げる
	const echoLayer = (v: UserLayerRec, always = false): MLLayer => (!always && v.dz === PUBLIC_DZ) || layerDzOf(v.layer, null as unknown as number) != null ? v.layer : { ...v.layer, metadata: { ...(v.layer.metadata || {}), [DZ_KEY]: v.dz } };
	map.getLayer = id => { const v = mlLayers.get(id); if (v) return echoLayer(v) as MapLibreLayer; if (id === AUTO_BLD && autoBldOn()) return autoBldLayer() as MapLibreLayer; const B = baseLayerOf(id); if (B) return echoBase(B) as MapLibreLayer; const X = extOtherOf(id); return X ? echoOther(X) as MapLibreLayer : undefined; };   // 基図の層も（段 7）・自動の建物（building-extrusion）も
	// beforeId＝その層の下に差し込む（MapLibre と同じ）。同じ id の層は置き換え
	const addLayerAt: StyleReturn["addLayerAt"] = async (layer, beforeId, dz) => {
		// source に object を書いた層＝MapLibre は層の id で source を足してから層を足す（後の層が "source": その id で引ける・公式例の門 2 巡目）
		if (layer?.source && typeof layer.source === "object" && layer.id != null && !mlSources.has(layer.id)) { addSourceAt(layer.id, layer.source, layerDzOf(layer as MLLayer, dz)); layer = { ...layer, source: layer.id }; }
		if (layer?.type === "background") {   // background 層（B5）＝球の床の色・不透明度（基図の層として持つ＝get/setPaintProperty・removeLayer・getStyle は基図の層の道）
			assertMLLayer(layer as MLLayer, "addLayer");
			const i = userBg.findIndex(L => L.id === layer.id); if (i >= 0) userBg.splice(i, 1);
			userBg.push({ ...layer as MLLayer, paint: { ...(layer.paint || {}) }, layout: { ...(layer.layout || {}) } }); baseOverrides.delete(layer.id); baseVis.delete(layer.id);
			restyleBase(); return null;
		}
		const sp = layer?.type === "custom" ? { type: "custom" } : srcOf(layer); if (!sp) throw new Error(`addLayer: source "${layer.source}" not found`);
		if (layer?.type === "custom" && typeof layer.render !== "function" && typeof layer.url !== "string") throw new Error(`addLayer: custom layer "${layer.id}" needs a render(gl, args) method (or url of a layer module for the worker route)`);
		assertMLLayer(layer as MLLayer, "addLayer");
		const v: UserLayerRec = { layer: layer?.type === "custom" ? layer as MLLayer : { ...layer as MLLayer, paint: { ...(layer.paint || {}) }, layout: { ...(layer.layout || {}) } }, src: sp, dz: layerDzOf(layer as MLLayer, dz) };   // custom 層は object そのまま（this が層＝onAdd/render の書き方）
		v.kind = kindOf(drawLayerOf(v), sp);   // 先に引く＝描けない層はここで投げる（登録簿を触る前）
		if (mlLayers.has(layer.id)) { const old = mlLayers.get(layer.id)!; mlLayers.delete(layer.id); await unmountLayer(old); }
		if (beforeId != null && mlLayers.has(beforeId)) {
			const ents = [...mlLayers]; const i = ents.findIndex(([k]) => k === beforeId);
			ents.splice(i, 0, [layer.id, v]); mlLayers.clear(); for (const [k, x] of ents) mlLayers.set(k, x);
		} else mlLayers.set(layer.id, v);
		if (beforeId != null && beforeId !== layer.id && (mlLayers.has(beforeId) || baseLayerOf(beforeId) || extOtherOf(beforeId))) v.before = beforeId;   // getStyle の順（§8 A4）＝どの層の前か。vector の描く層は描く順も（#123＝sendUserAnchors）・他の描き方は描画の段のまま（§4）
		v.kind = kindOfV(v);   // 置いた所で決まる描き方（基図の層の間の geojson の層＝vtdraw）
		const r = mlVisible(v) ? await mountLayer(v) : null;
		if (beforeId != null) reorderLayers();
		return r;
	};
	map.addLayer = (layer, beforeId) => addLayerAt(layer as MLLayer, beforeId, PUBLIC_DZ);
	map.removeLayer = id => {
		const v = mlLayers.get(id);
		if (!v) {
			if (id === AUTO_BLD && autoBldOn()) { setAutoBld(true); live.autoBldRemoved = true; return map; }
			const ub = userBg.findIndex(L => L.id === id); if (ub >= 0) { userBg.splice(ub, 1); baseVis.delete(id); baseOverrides.delete(id); restyleBase(); return map; }   // 実行時の background 層（B5）
			if (baseLayerOf(id)) { baseVis.delete(id); overrideBase(id, o => { o.removed = true; }); }
			else if (extOtherOf(id)) { if (isExtImage(id)) { map.raster.remove(id); extExtras.raster = extExtras.raster.filter(x => x !== id); } extNotes.set(id, { removed: true }); }   // その他の層（§8 A）
			return map;
		}   // 基図の層を外す（段 7）・自動の建物は伏せて getStyle からも外す
		mlLayers.delete(id); transitions.cancelPrefix(TR_KEY(id, ""));
		unmountLayer(v); rekindAll();   // この層の前に置いた層の行き先が変わり得る（S-P2）
		if (extExtras.layers.includes(id)) extNotes.set(id, { removed: true });   // style 由来の層を外した＝getStyle の「その他の層」として復活させない（§8 A）
		return map;
	};
	map.moveLayer = (id, beforeId) => {
		const v = mlLayers.get(id);
		if (!v && baseLayerOf(id)) {   // 基図の層（S-P2-2・2026-10-22）＝基図の層の順を並べ替えて組み直す（描く順＝li・注記の順・#123 の差し込みの位置も追随）。
			// beforeId が利用者の層・その他の層＝今の style の順でその後ろにある最初の基図の層の前（利用者の層は基図の層に差し込む＝#123）
			if (beforeId === id) return map;
			const list = styleOrder().filter(e => e.id !== id), i = beforeId == null ? -1 : list.findIndex(e => e.id === beforeId);
			baseMoves.push([id, beforeId ?? null, i < 0 ? null : list.slice(i).find(e => e.base)?.id ?? null]);
			restyleBase(); rekindAll();
			return map;
		}
		if (!v) { if (id === AUTO_BLD && autoBldOn()) console.info(`[moveLayer] "${id}" is the regional auto-buildings layer — its order is fixed`); return map; }
		mlLayers.delete(id);
		if (beforeId != null && mlLayers.has(beforeId)) {
			const ents = [...mlLayers]; const i = ents.findIndex(([k]) => k === beforeId);
			ents.splice(i, 0, [id, v]); mlLayers.clear(); for (const [k, x] of ents) mlLayers.set(k, x);
		} else mlLayers.set(id, v);
		v.before = beforeId != null && beforeId !== id && (mlLayers.has(beforeId) || baseLayerOf(beforeId) || extOtherOf(beforeId)) ? beforeId : null;   // getStyle の順（§8 A4）
		const re = rekind(v); rekindAll();   // 描き方が変わった層は載せ直す（鎖でこの層の前に置いた層も）
		if (!re && v.kind === "vtdraw") live.vtdCtl?.setOrder(vtdOrder(), id);   // 動いた層だけ鍵を振り直す（その source を組み直す）
		reorderLayers();
		return map;
	};
	// geojson の層を基図の層の間に（S-P2・2026-10-22 Kenji 裁定）：style の順でその後ろに基図の層がある geojson の fill／line／circle の層は vtdraw（geojson vt plan の G-2＝手元のタイル）で描く
	//＝#123 の差し込み（sendUserAnchors）で基図の層の間へ。後ろに基図の層が無い層（基図の上）は gint のまま（大きな面の stencil・地物ごとの表の書き換えが速い）。集約の source は gint のまま
	const baseAfter = (id: string) => { const o = styleOrder(), i = o.findIndex(e => e.id === id); return i >= 0 && o.slice(i + 1).some(e => e.base); };
	const kindOfV = (v: UserLayerRec) => { const k = kindOf(drawLayerOf(v), v.src); return k === "gint" && v.src?.type === "geojson" && !v.src.cluster && GJVT && baseAfter(v.layer.id) ? "vtdraw" : k; };
	// 描き方が変わった層を外して載せ直す（true＝変わった）
	const rekind = (v: UserLayerRec) => {
		const k = kindOfV(v); if (k === v.kind) return false;
		if (mlVisible(v)) { const old = { ...v }, id = v.layer.id; v.kind = k; Promise.resolve(unmountLayer(old)).then(() => mlLayers.get(id) === v && mlVisible(v) && mountLayer(v)); } else v.kind = k;
		return true;
	};
	const rekindAll = () => { for (const v of [...mlLayers.values()]) if (v.src?.type === "geojson") rekind(v); };   // 基図の層が動いた＝後ろに基図の層があるかが変わり得る
	// 性質の変更＝登録簿の層を書き換えて描き直す（gint は fid 表の書き換えだけ＝安い・画像の不透明度は map.raster.set）
	const relayer = (v: UserLayerRec) => mlVisible(v) ? (v.kind === "gint" ? rebuildGint(srcId(v.layer)) : mountLayer(v)) : null;
	// paint の transition（B1・2026-10-12・MapLibre の `*-transition`・style の根の `transition`・既定 300ms）：利用者の層（mlLayers）だけ。数・色・数の配列を rAF ごとに補間して描き直す
	// （gint＝fid 表の書き換え・他＝relayer）。式は補間しない（MapLibre も同じ）。基図の層（restyleBase＝組み直し）とその他の層（描かない）は即時。getPaintProperty は set した目標値を返す
	const transitions = createTransitions({ now: animNow });   // 時計＝map.setNow で止められる（C10）
	const TR_KEY = (id: string, name: string) => `${id}\u0000${name}`;
	const styleTransitionOf = () => live.EXT?.ms?.transition ?? null;
	const NO_TRANSITION = new Set(["raster-fade-duration"]);   // style-spec で transition:false の数の paint（補間しない＝即時）
	map.setPaintProperty = (id, name, value, o = undefined) => {
		const v = mlLayers.get(id);
		if (/-transition$/.test(name)) {   // 遷移の指定そのもの＝値を記録するだけ（描き直さない）
			if (v) { if (value == null) delete v.layer.paint![name]; else v.layer.paint![name] = value; }
			else if (baseLayerOf(id) || extOtherOf(id)) paintTransitionsOther.set(TR_KEY(id, name), value);
			else throw new Error(`setPaintProperty: layer "${id}" not found`);
			return map;
		}
		if (value !== undefined) assertMLLayer({ id, paint: { [name]: value } }, "setPaintProperty");
		if (v && o?.transition !== false && value !== undefined && mlVisible(v) && !v.mounting) {
			const tr = transitionOf(v.layer, name, styleTransitionOf());
			const to = rescaleZoomExpr(value, PUBLIC_DZ, v.dz), from = v.layer.paint?.[name] ?? PAINT_DEFAULTS[name];
			if (tr.duration > 0 && interpolable(from, to) && !NO_TRANSITION.has(name)) {
				(v.trans ??= {})[name] = to;
				transitions.start(TR_KEY(id, name), from, to, tr, (mid, done) => {
					if (mlLayers.get(id) !== v) return false;   // 外された・入れ替わった層＝走者から消える
					if (done && v.trans) delete v.trans[name];
					applyPaintNow(v, id, name, mid, true);
					return true;
				});
				return map;
			}
		}
		transitions.cancel(TR_KEY(id, name)); if (v?.trans) delete v.trans[name];
		return applyPaintNow(v, id, name, value, false);
	};
	const paintTransitionsOther = new Map<string, unknown>();   // 基図・その他の層の *-transition（記録だけ・getPaintProperty で戻す）
	const applyPaintNow = (v: UserLayerRec | undefined, id: string, name: string, value: unknown, raw: boolean) => {   // raw＝走者の補間値（層の目盛りのまま・検査済み）
		if (!v && id === AUTO_BLD && autoBldOn()) autoBldReadOnly("setPaintProperty");
		if (!v && !baseLayerOf(id) && extOtherOf(id)) {   // その他の層（§8 A）＝記録だけ・画像の raster は不透明度が効く
			noteOther(id, n => { if (value === undefined) delete n.paint[name]; else n.paint[name] = rescaleZoomExpr(value, PUBLIC_DZ, STYLE_DZ); });
			if (isExtImage(id) && name === "raster-opacity") map.raster.set(id, { opacity: typeof value === "number" ? value : 1 });
			if (isExtImage(id) && (name === "raster-resampling" || name === "resampling" || name === "raster-fade-duration" || name === "raster-split" || name === "raster-sse")) map.raster.set(id, rasterPaintOpts({ [name]: value }));
			return map;
		}
		if (!v) { if (!baseLayerOf(id)) throw new Error(`setPaintProperty: layer "${id}" not found`); if (!fastBasePaint(id, name, value)) overrideBase(id, o => { o.paint = { ...(o.paint || {}), [name]: baseValueIn(name, value) }; }); return map; }   // 基図の層（段 7）
		if (value === undefined) delete v.layer.paint![name]; else v.layer.paint![name] = raw ? value : rescaleZoomExpr(value, PUBLIC_DZ, v.dz);   // 呼び手の目盛り→層の目盛り
		if (v.kind === "raster" && name === "raster-opacity") { map.raster.set(id, { opacity: (value ?? 1) as number }); return map; }
		if ((v.kind === "raster" || v.kind === "hillshade" || v.kind === "colorrelief") && (name === "raster-resampling" || name === "resampling")) {   // C4＝標本化はタイルを作り直さない。今触った鍵を優先（別名 resampling と raster-resampling の両方が有っても）
			const P = v.layer.paint!, x = P[name] ?? P[name === "resampling" ? "raster-resampling" : "resampling"];
			map.raster.set(id, { resampling: rasterSampling({ "raster-resampling": x }) ?? "linear" }); return map;
		}
		if (v.kind === "raster" && name === "raster-split") { map.raster.set(id, { split: rasterPaintOpts({ "raster-split": value }).split ?? 0 }); return map; }   // 分割（Cesium の splitDirection）＝タイルを作り直さない
		if (v.kind === "raster" && name === "raster-sse") { map.raster.set(id, { sse: rasterPaintOpts({ "raster-sse": value }).sse ?? 0 }); return map; }   // Cesium の口の z の選び＝タイルを作り直さない
		if (v.kind === "raster" && name === "raster-fade-duration") { map.raster.set(id, { fadeDuration: rasterFade(v.layer.paint) ?? 300 }); return map; }
		if (v.kind === "colorrelief" && name === "color-relief-opacity") { map.raster.set(id, { opacity: reliefOpacity(v.layer) }); return map; }   // 不透明度はタイルを作り直さない（#114）
		if (rekind(v)) return map;   // 描き方が変わる paint（line-offset を足した gint の線→canvas2D の口 等）＝外して載せ直す
		relayer(v); return map;
	};
	const echoProp = (v: UserLayerRec | undefined, x: unknown) => (v && x !== undefined ? rescaleZoomExpr(x, v.dz, PUBLIC_DZ) : x) as StyleExpression | undefined;   // 層の目盛り→呼び手の目盛り（set したものが get で戻る）
	map.getPaintProperty = (id, name) => { const v = mlLayers.get(id); if (v) return echoProp(v, v.trans?.[name] ?? v.layer.paint?.[name]); if (/-transition$/.test(name) && paintTransitionsOther.has(TR_KEY(id, name))) return paintTransitionsOther.get(TR_KEY(id, name)) as StyleExpression | undefined; const B = baseLayerOf(id); if (!B) { const x = extOtherOf(id)?.paint?.[name] as StyleExpression | undefined; return x === undefined ? undefined : rescaleZoomExpr(x, STYLE_DZ, PUBLIC_DZ); } const x = B.paint?.[name] as StyleExpression | undefined; return x === undefined ? undefined : rescaleZoomExpr(x, 0, PUBLIC_DZ); };
	map.setLayoutProperty = (id, name, value) => {
		const v = mlLayers.get(id);
		if (value !== undefined) assertMLLayer({ id, layout: { [name]: value } }, "setLayoutProperty");
		if (!v && id === AUTO_BLD && autoBldOn()) { if (name !== "visibility") autoBldReadOnly("setLayoutProperty"); setAutoBld(value === "none"); return map; }   // 自動の建物＝出し入れだけ
		if (!v && !baseLayerOf(id) && extOtherOf(id)) {   // その他の層（§8 A）＝記録だけ・画像の raster は出し入れが効く
			noteOther(id, n => { if (value === undefined) delete n.layout[name]; else n.layout[name] = rescaleZoomExpr(value, PUBLIC_DZ, STYLE_DZ); });
			if (isExtImage(id) && name === "visibility") map.raster.set(id, { visible: value !== "none" });
			return map;
		}
		if (!v) {
			const B = baseLayerOf(id); if (!B) throw new Error(`setLayoutProperty: layer "${id}" not found`);
			if (name === "visibility") {   // 基図の層の出し入れ（段 7）＝結合で外すだけ。元の style で隠されていた層を出す時だけ組み直す
				const now = value === "none" ? "none" : "visible";
				if (now === "visible" && B.layout?.visibility === "none") { baseVis.delete(id); overrideBase(id, o => { o.layout = { ...(o.layout || {}), visibility: "visible" }; }); }
				else { if (now === "none") baseVis.set(id, "none"); else baseVis.delete(id); remergeBase(); }
				if (B.type === "background") { live.bg = bgOf(live.style); live.land = landOf(live.bg, NO_BG_WHITE ? landDefault() : live.land); renderer.set("view", { land: live.land, sea: seaOf(live.bg) }); requestDraw(); }   // background の出し入れ＝床の色（B5）
				return map;
			}
			overrideBase(id, o => { o.layout = { ...(o.layout || {}), [name]: value === undefined ? undefined : normalizeMLLayer({ layout: { [name]: value } } as MLLayer, PUBLIC_DZ).layout![name] }; });
			return map;
		}
		const was = mlVisible(v);
		if (value === undefined) delete v.layer.layout![name]; else v.layer.layout![name] = rescaleZoomExpr(value, PUBLIC_DZ, v.dz);
		const now = mlVisible(v);
		if (name === "visibility" && v.kind === "vtextrude") { if (was !== now) { if (live.vtxCtl?.has(id)) live.vtxCtl.setVisible(id, now); else if (now) mountLayer(v); } return map; }   // ベクタタイルの押し出し＝外さず伏せる（組んだタイルを残す）
		if (name === "visibility" && v.kind === "vtdraw") { if (was !== now) { if (live.vtdCtl?.has(id)) live.vtdCtl.setVisible(id, now); else if (now) mountLayer(v); } return map; }   // vector の描く層＝結合で隠すだけ（組んだタイルを残す）
		if (name === "visibility") { if (was && !now) unmountLayer(v); else if (!was && now) (v.kind === "gint" ? rebuildGint(srcId(v.layer)) : mountLayer(v)); return map; }
		relayer(v); return map;
	};
	map.getLayoutProperty = (id, name) => { const v = mlLayers.get(id); if (v) return echoProp(v, v.layer.layout?.[name]); if (id === AUTO_BLD && autoBldOn()) return name === "visibility" && live.autoBldHidden ? "none" : undefined; const B = baseLayerOf(id); if (!B) { const x = extOtherOf(id)?.layout?.[name] as StyleExpression | undefined; return x === undefined ? undefined : rescaleZoomExpr(x, STYLE_DZ, PUBLIC_DZ); } if (name === "visibility" && baseVis.get(id) === "none") return "none"; const x = B.layout?.[name] as StyleExpression | undefined; return x === undefined ? undefined : rescaleZoomExpr(x, 0, PUBLIC_DZ); };
	map.setFilter = (id, filter) => {
		const v = mlLayers.get(id);
		if (filter != null) assertMLLayer({ id, filter }, "setFilter");
		if (!v && id === AUTO_BLD && autoBldOn()) autoBldReadOnly("setFilter");
		if (!v && !baseLayerOf(id) && extOtherOf(id)) { noteOther(id, n => { if (filter == null) delete n.filter; else n.filter = rescaleZoomExpr(filter, PUBLIC_DZ, STYLE_DZ); }); return map; }   // その他の層（§8 A）＝記録だけ
		if (!v) { if (!baseLayerOf(id)) throw new Error(`setFilter: layer "${id}" not found`); overrideBase(id, o => { o.filter = filter == null ? null : normalizeMLLayer({ filter } as MLLayer, PUBLIC_DZ).filter; }); return map; }   // 基図の層（段 7）
		if (filter == null) delete v.layer.filter; else v.layer.filter = rescaleZoomExpr(filter, PUBLIC_DZ, v.dz);
		relayer(v); return map;
	};
	map.getFilter = id => { const v = mlLayers.get(id); if (v) return echoProp(v, v.layer.filter); const B = baseLayerOf(id); if (!B) { const X = extOtherOf(id); return X?.filter == null ? undefined : rescaleZoomExpr(X.filter as StyleExpression, STYLE_DZ, PUBLIC_DZ); } return B.filter == null ? undefined : rescaleZoomExpr(B.filter as StyleExpression, 0, PUBLIC_DZ); };
	map.setLayerZoomRange = (id, minzoom, maxzoom) => { const v = mlLayers.get(id); if (!v && id === AUTO_BLD && autoBldOn()) autoBldReadOnly("setLayerZoomRange"); if (!v) { if (baseLayerOf(id)) overrideBase(id, o => { o.minzoom = rescaleZoomNum(minzoom, PUBLIC_DZ, 0); o.maxzoom = rescaleZoomNum(maxzoom, PUBLIC_DZ, 0); }); else if (extOtherOf(id)) noteOther(id, n => { n.minzoom = rescaleZoomNum(minzoom, PUBLIC_DZ, STYLE_DZ)!; n.maxzoom = rescaleZoomNum(maxzoom, PUBLIC_DZ, STYLE_DZ)!; }); return map; } v.layer.minzoom = rescaleZoomNum(minzoom, PUBLIC_DZ, v.dz)!; v.layer.maxzoom = rescaleZoomNum(maxzoom, PUBLIC_DZ, v.dz)!; relayer(v); return map; };   // gint の pass の署名は出しズームを含む＝変われば作り直し
	// feature-state（MapLibre 同名）：{ source, id } の id＝その source の地物の番号（GeoJSON の並び順＝gint の fid）。
	// 効くのは fill/line/circle（gint の層）の paint に ["feature-state", key] がある時。基図の地物は塗りと線の色・不透明度・線幅（paint 表の (b) 類の段 3・GL2 の md＝表の行を描き手が評価し直す・
	// 地物の id＝MVT の Feature.id・基図の source の promoteId は未対応）。WebGPU・?nomd=1・?pt=0 の基図は効かない（焼いた既定の状態）。
	// vector source（sourceLayer 必須）＝押し出し（vtextrude・段 8①b）と描く層（vtdraw・#109）がその地物を含むタイルだけ組み直す（置き場は vtxFS）
	// feature-state の id＝MapLibre の id（Feature.id／promoteId／並び順・段 6）。状態は source に住む（pass を作り直しても・データを差し替えても id で当て直す）
	const fidOfMl = (source: string, id: number | string) => { const m = mlGintData.get(source)?.idToFid; return m ? (m.get(id) ?? m.get(typeof id === "string" && id !== "" && !isNaN(+id) ? +id : String(id))) : undefined; };
	// geojson の source の feature-state を切ったタイルの層（vtdraw・G-2／S-P2）へも＝vector と同じ置き場（vtxFS・source-layer＝GEOJSON_LAYER）に写してその地物のタイルを組み直す。
	// id＝null は全部を消す。gint の層は今どおり mlFeatureState（fid の表）
	const gjvtFS = (source: string, id: string | number | null | undefined, state: Record<string, unknown> | null) => {
		let w = vtxFS.get(source);
		if (id == null) { if (w) for (const k of [...w.keys()]) if (k.startsWith(GEOJSON_LAYER + "\u0000")) w.delete(k); live.vtdCtl?.touchFS(source, GEOJSON_LAYER, undefined); return; }
		const k = vtxFSKey(GEOJSON_LAYER, id);
		if (state) { if (!w) vtxFS.set(source, w = new Map()); w.set(k, { id, state }); } else w?.delete(k);
		live.vtdCtl?.touchFS(source, GEOJSON_LAYER, id);
	};
	map.setFeatureState = ({ source, sourceLayer, id }, state) => {
		if (id == null) return map;
		if (isVecSrc(source)) {   // vector source（押し出し・段 8①b）＝MapLibre と同じく sourceLayer が要る
			if (sourceLayer == null) throw new Error(`setFeatureState: sourceLayer is required for vector source "${source}"`);
			let m = vtxFS.get(source); if (!m) vtxFS.set(source, m = new Map());
			const k = vtxFSKey(sourceLayer, id); m.set(k, { id, state: { ...(m.get(k)?.state || {}), ...state } });
			live.vtxCtl?.touchFS(source, sourceLayer, id); live.vtdCtl?.touchFS(source, sourceLayer, id);   // 押し出し（8①b）と描く層（#109）＝その地物を含むタイルだけ組み直す
			if (baseSrcSpec(source)) renderer.set("ptFs", [[sourceLayer, String(id), m.get(k)!.state]]);   // 基図の層（paint 表の (b) 類の段 3・GL2 の md）＝描き手がその地物の行を評価し直す
			return map;
		}
		let m = mlFeatureState.get(source); if (!m) mlFeatureState.set(source, m = new Map());
		m.set(id, { ...m.get(id), ...state });
		gjvtFS(source, id, m.get(id)!);
		const fid = fidOfMl(source, id);
		if (fid != null) for (const e of mlPasses.values()) if (e.sid === source) e.h.setFeatureState(fid, state);
		return map;
	};
	map.removeFeatureState = ({ source, sourceLayer, id } = {} as Parameters<StyleApi["removeFeatureState"]>[0], key) => {
		if (isVecSrc(source)) {   // vector source：id 無し＝その source（sourceLayer があればその層）を全部
			const m = vtxFS.get(source); if (!m) return map;
			if (id == null) { for (const k of [...m.keys()]) if (sourceLayer == null || k.startsWith(sourceLayer + "\u0000")) m.delete(k); live.vtxCtl?.touchFS(source, sourceLayer ?? null, undefined); live.vtdCtl?.touchFS(source, sourceLayer ?? null, undefined); if (baseSrcSpec(source)) renderer.set("ptFs", [[sourceLayer ?? null, null, null]]); return map; }
			if (sourceLayer == null) throw new Error(`removeFeatureState: sourceLayer is required for vector source "${source}"`);
			const k = vtxFSKey(sourceLayer, id), cur = m.get(k); if (!cur) return map;
			if (key != null) { const st = { ...cur.state }; delete st[key]; m.set(k, { id, state: st }); } else m.delete(k);
			live.vtxCtl?.touchFS(source, sourceLayer, id); live.vtdCtl?.touchFS(source, sourceLayer, id);
			if (baseSrcSpec(source)) renderer.set("ptFs", [[sourceLayer, String(id), m.get(k)?.state ?? null]]);
			return map;
		}
		const m = mlFeatureState.get(source);
		if (m) { if (id == null) m.clear(); else if (key != null) { const st = { ...m.get(id) }; delete st[key]; m.set(id, st); } else m.delete(id); }
		gjvtFS(source, id, id == null ? null : m?.get(id) ?? null);
		const fid = id == null ? null : fidOfMl(source, id);
		if (id != null && fid == null) return map;
		for (const e of mlPasses.values()) if (e.sid !== source) continue; else if (key != null && id != null) e.h.setFeatureState(fid, { [key]: undefined }); else e.h.removeFeatureState(fid);
		return map;
	};
	// MapLibre 同名（段 8①b）：その地物の今の状態（無ければ {}）。vector source は sourceLayer が要る
	map.getFeatureState = ({ source, sourceLayer, id } = {} as Parameters<StyleApi["getFeatureState"]>[0]) => {
		if (isVecSrc(source)) { if (sourceLayer == null) throw new Error(`getFeatureState: sourceLayer is required for vector source "${source}"`); return { ...(vtxFS.get(source)?.get(vtxFSKey(sourceLayer, id))?.state || {}) }; }
		return { ...(mlFeatureState.get(source)?.get(id) || {}) };
	};
	map.getLayers = () => [...mlLayers.values()].map(v => echoLayer(v)) as MapLibreLayer[];
	// 利用者の層の「直後の style の層」（#123）＝beforeId の鎖を辿る（利用者の層の前 → その層の前 …）。style の層（基図・その他・style 由来の利用者の層）に着けばその id・末尾なら null。
	// 旧＝v.before だけを見た＝c0→c1→基図の層 の c0 が、まだ並べていない c1 を探せず末尾に出ていた
	const beforeStyleId = (v: UserLayerRec) => {
		const extra = new Set(extExtras.layers), seen = new Set<string>();
		let b = v.before;
		while (b != null && !seen.has(b) && mlLayers.has(b) && !(live.EXT && extra.has(b))) { seen.add(b); b = mlLayers.get(b)!.before ?? null; }
		return b ?? null;
	};
	// 全部の層の順（MapLibre の style の順）＝[{ id, base（基図の style の層）| v（利用者の層）| other（その他の層）| auto（自動の建物） }]。
	// 外来 style＝元の style の順（基図の層・画像の raster・style の vector/geojson の層・描かない層＝MapLibre の getStyle と同じ全ての層）／地域の基図＝基図の層 → 自動の建物。
	// 利用者の層は beforeId（の鎖の先）が style の層を指せばその前・無ければ末尾（登録順）。custom 層は入れない（MapLibre の getStyle は書き出さない）
	const styleOrder = () => {
		const extraIds = new Set(extExtras.layers);
		let list: StyleOrderEntry[];
		if (live.EXT) {
			const byId = new Map<string, MLLayer>(live.style.layers.map(L => [L.id, L]));
			list = [];
			const ext = [...live.EXT.ms.layers];
			for (const [id, raw, bb] of baseMoves) moveBefore(ext, id, raw != null && ext.some(L => L.id === raw) ? raw : bb, (L: MLLayer) => L.id);   // 基図の moveLayer（S-P2-2）
			for (const L0 of ext) {
				const v = mlLayers.get(L0.id);
				if (v && extraIds.has(L0.id)) { list.push({ id: L0.id, v }); continue; }
				const B = byId.get(L0.id); if (B) { list.push({ id: B.id, base: B }); byId.delete(L0.id); continue; }
				const X = extOtherOf(L0.id); if (X) list.push({ id: L0.id, other: X });
			}
			for (const B of byId.values()) list.push({ id: B.id, base: B });   // 元の style に無い基図の層（念のため末尾）
		} else list = [...(live.style.layers || []).map(B => ({ id: B.id, base: B })), ...(autoBldOn() ? [{ id: AUTO_BLD, auto: true }] : [])];
		for (const v of mlLayers.values()) {
			if (live.EXT && extraIds.has(v.layer.id)) continue;
			if (v.kind === "custom") continue;
			const bid = beforeStyleId(v), i = bid != null ? list.findIndex(e => e.id === bid) : -1;
			if (i >= 0) list.splice(i, 0, { id: v.layer.id, v }); else list.push({ id: v.layer.id, v });
		}
		return list;
	};
	// getStyle＝MapLibre の style の形（version 8）。layers＝基図の層（外来 style ならその source 名・地域の基図は "basemap"＝読むだけ）の上に利用者の層（登録順）
	map.getStyle = () => {
		const baseSid = live.EXT?.split.vectorSource ?? "basemap";
		const baseSrc = live.EXT ? live.EXT.ms.sources![baseSid] : { type: "vector" };
		// 目盛りの申告（setStyle(getStyle()) で二重にずれない）：基図の層＝エンジンの目盛りに直した物（metadata["ortho:dz"]:0）・利用者の層＝echoLayer・
		// その他の層（描かない層・画像の raster）＝style.json の目盛りのまま（dz 1）・source の目盛り＝root の metadata["ortho:sourceDz"]（source には metadata の欄が無い＝MapLibre の検査を汚さない）
		const baseL = (L: MLLayer) => L.metadata?.[DZ_KEY] != null ? L : { ...L, metadata: { ...(L.metadata || {}), [DZ_KEY]: 0 } };
		const baseEcho = (L: MLLayer) => baseL(echoBase(L.type === "background" ? { ...L } : { ...L, source: L.source ?? baseSid }));
		const userEcho = (v: UserLayerRec) => ({ ...echoLayer(v, true), source: srcId(v.layer) });
		// 並べ方＝styleOrder（getStyle と #123 の差し込みが共有）
		const list = styleOrder().map(e => e.base ? baseEcho(e.base) : e.v ? userEcho(e.v) : e.auto ? autoBldLayer()! : echoOther(e.other!));
		return {
			version: 8, ...(live.EXT ? { name: live.EXT.ms.name } : {}), ...(spriteEcho(live.spriteList) !== undefined ? { sprite: spriteEcho(live.spriteList) } : {}), ...(live.mlGlyphs ? { glyphs: live.mlGlyphs } : {}),   // sprite/glyphs＝setSprite/addSprite/removeSprite/setGlyphs の後の値（B6）
			...(live.EXT ? Object.fromEntries(["center", "zoom", "bearing", "pitch"].filter(k => live.EXT!.ms[k] != null).map(k => [k, live.EXT!.ms[k]])) : {}),   // style の根の視点（MapLibre の getStyle と同じ・style.json の目盛り＝MapLibre の z）
			...(live.EXT?.ms?.transition ? { transition: live.EXT.ms.transition } : {}),   // style の根の transition（B1）
			...(live.mlLight ? { light: normLight(live.mlLight) } : {}),   // style の根の light（B3）＝setLight した物も
			...(live.mlSky ? { sky: normSky(live.mlSky) } : {}),   // style の根の sky（B4）＝setSky した物も
			metadata: { "ortho:sourceDz": Object.fromEntries([...mlSourceDz]) },
			sources: { ...(live.EXT ? live.EXT.ms.sources : {}), [baseSid]: baseSrc, ...Object.fromEntries(mlSources), ...Object.fromEntries([...mlLayers.values()].filter(v => typeof v.layer.source !== "string").map(v => [v.layer.id, v.layer.source])) },
			layers: list,
		};
	};
	// 外来 style の基図以外の層＝画像層（raster source）と利用者の層（geojson / image source）へ振り分ける（起動後・setStyle の後）
	const extExtras: ExtExtras = { raster: [], layers: [], sources: [], offs: [], mounting: 0 };   // mounting＝振り分けの途中（isSourceLoaded / idle は待つ）
	const mountExtExtras = async (ext: ExtStyle) => { extExtras.mounting++; try { return await mountExtExtrasRaw(ext); } finally { extExtras.mounting--; } };
	// style 由来の source（geojson・image・video・raster-dem）を足す（相対 URL は style の置き場基準・目盛りは root の metadata["ortho:sourceDz"]・無ければ style.json＝dz 1）。足したら extExtras.sources に控える
	const ensureExtSource = (ext: ExtStyle, sid: string) => {
		if (mlSources.has(sid) || !ext.ms.sources?.[sid]) return;
		const sp = { ...ext.ms.sources[sid] };
		if (typeof sp.data === "string") sp.data = new URL(sp.data, ext.baseUrl).href; if (sp.url) sp.url = new URL(sp.url, ext.baseUrl).href; if (Array.isArray(sp.urls)) sp.urls = sp.urls.map(u => new URL(u, ext.baseUrl).href);
		if (Array.isArray(sp.tiles)) sp.tiles = sp.tiles.map(u => /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, ext.baseUrl).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}"));
		addSourceAt(sid, sp, ext.ms.metadata?.["ortho:sourceDz"]?.[sid] ?? STYLE_DZ); extExtras.sources.push(sid);
	};
	const mountExtExtrasRaw = async (ext: ExtStyle) => {
		const ms = ext.ms, baseIdx = ms.layers.findIndex(L => L.source === ext.split.vectorSource && L.type !== "background");
		for (const L of ext.split.raster) {
			// 画像層は基図の塗りの「上」にしか合成できない（地面アトラスで塗りの後に重ねる）。style で基図の塗りより前（下）に書かれた画像
			//（例：陰影図を土地被覆の下に敷く）は描かない＝上に載せると塗りを白く洗ってしまう。数えて知らせる
			if (baseIdx >= 0 && ms.layers.findIndex(x => x.id === L.id) < baseIdx) { console.info(`[style] raster layer "${L.id}" sits under the vector fills — not drawn (imagery can only go above the basemap fills)`); continue; }
			try {
				const sp = await resolveVectorSource(ms.sources![L.source!], ext.baseUrl, { fetchFn: ((u, init) => requester.fetch(u as string, "Source", init)) as typeof fetch });   // TileJSON の解決は raster も同じ
				const op = L.paint?.["raster-opacity"] ?? 1, opNow = () => +(evalExpr<number>(op, { zoom: cam.zoom, props: {}, geom: null, vars: {}, gs: live.MAP_GS, origin: "ml" }) ?? 1);   // style.json の層＝MapLibre の意味
				await map.raster.add(L.id, { url: sp.tiles![0], tileSize: ms.sources![L.source!].tileSize ?? sp.tileSize ?? 512, minZoom: sp.minzoom, maxZoom: sp.maxzoom, bbox: sp.bounds as Bbox | null | undefined, attribution: sp.attribution, tms: sp.scheme === "tms", adjust: rasterAdjust(L.paint) }, { order: "over", opacity: opNow(), ...rasterPaintOpts(L.paint), hideFills: false, ...(L.minzoom != null ? { minZoom: L.minzoom } : {}), ...(L.maxzoom != null ? { maxZoom: L.maxzoom - 1e-6 } : {}) });   // tileSize の既定＝MapLibre の 512（段 6）・層の出しズーム＝表示窓
				if (Array.isArray(op)) { const f = () => map.raster.set(L.id, { opacity: opNow() }); map.on("settle", f); extExtras.offs.push(() => map.off("settle", f)); }   // ズームの式＝止まるたび評価し直す
				extExtras.raster.push(L.id);
			} catch (err) { console.warn("[style] raster layer", L.id, err); }
		}
		// 地形は sprite より先（sprite は大きいと数秒＝その間に注記が地形より先に届く。render worker は DEM の生き替わりで注記の標高を付け直すが、順も元のまま）
		if (ms.terrain?.source && ms.sources?.[ms.terrain.source]?.type === "quantized-mesh") {   // style の terrain＝quantized-mesh の source（この地図の拡張・#110）
			const sp = { ...ms.sources[ms.terrain.source] }; if (sp.url) sp.url = new URL(sp.url, ext.baseUrl).href;
			await map.setTerrain({ source: sp as QuantizedMeshSource }).catch(err => console.warn("[style] terrain", err));
		} else if (ms.terrain?.source && ms.sources?.[ms.terrain.source]?.type === "raster-dem") {   // style の terrain（MapLibre）＝その raster-dem を地形へ（#36）
			const sp = { ...ms.sources[ms.terrain.source] }; if (sp.url) sp.url = new URL(sp.url, ext.baseUrl).href; if (sp.tiles) sp.tiles = sp.tiles.map(u => /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, ext.baseUrl).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}"));
			await map.setTerrain({ source: sp as RasterDemSource, exaggeration: ms.terrain.exaggeration }).catch(err => console.warn("[style] terrain", err));
		}
		if (ms.sprite && ms.layers.some(L => L.type === "symbol" && L.layout?.["icon-image"] != null)) {   // どの経路の symbol 層でも（geojson・基図・vector source＝段 3）記号を使うなら sprite を読む（旧＝geojson の層だけ）
			// 複数の sprite（MapLibre v4）＝[{ id, url }]・default 以外は "id:名前"（段 6・旧＝最初の 1 本だけ）
			const list = Array.isArray(ms.sprite) ? ms.sprite : [{ id: "default", url: ms.sprite }];
			await Promise.all(list.filter(e => e?.url).map(e => spriteLoad(e.id ?? "default", new URL(e.url!, ext.baseUrl).href).catch(err => console.warn("[style] sprite", e.id, err))));
		}
		// vector source の fill-extrusion（段 8①）＝利用者の層の口（dz 1）。基図と同じ source はその名前のまま（srcOf が基図の記述子を返す）・別の vector source は source を足す（相対 URL は style の置き場から）
		for (const L of ms.layers.filter(L => vtRouted(L, ms, ext.split.vectorSource))) {   // ＋2 本目以降の vector source の描く層・基図の source の circle（段 8⑤）
			try {
				if (L.source !== ext.split.vectorSource && !mlSources.has(L.source!)) {
					const sp = { ...ms.sources![L.source!] };
					if (sp.url && !/^[a-z][\w+.-]*:\/\//i.test(sp.url.replace(/^pmtiles:\/\//, ""))) sp.url = /^pmtiles:\/\//.test(sp.url) ? "pmtiles://" + new URL(sp.url.slice(10), ext.baseUrl).href : new URL(sp.url, ext.baseUrl).href;
					if (Array.isArray(sp.tiles)) sp.tiles = sp.tiles.map(u => /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, ext.baseUrl).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}"));
					addSourceAt(L.source!, sp, ms.metadata?.["ortho:sourceDz"]?.[L.source!] ?? STYLE_DZ); extExtras.sources.push(L.source!);
				}
				await addLayerAt(L, undefined, STYLE_DZ); extExtras.layers.push(L.id);
			} catch (err) { console.warn("[style] layer", L.id, err); }
		}
		for (const L of ext.split.geojson) {
			extExtras.layers.push(L.id);   // 先に控える＝足す時に style の順が分かる（基図の層の間の geojson の層＝vtdraw・S-P2）
			try {
				ensureExtSource(ext, L.source!);
				await addLayerAt(L, undefined, STYLE_DZ);   // style.json の層＝MapLibre の z（dz 1・層の metadata の申告が勝つ）
			} catch (err) { extExtras.layers.splice(extExtras.layers.indexOf(L.id), 1); console.warn("[style] layer", L.id, err); }
		}
		sendUserAnchors();   // style の層は style の順（#123）＝extExtras.layers が揃ってから差し込む位置を配る（層を足す時はまだ style 由来と分からない）
	};
	const unmountExtExtras = () => {
		for (const id of extExtras.raster) map.raster.remove(id);
		for (const id of extExtras.layers) map.removeLayer(id);
		for (const sid of extExtras.sources) { try { map.removeSource(sid); } catch { /* 利用者が同じ source に層を足している＝残す */ } }
		for (const f of extExtras.offs) f();
		extExtras.raster = []; extExtras.layers = []; extExtras.sources = []; extExtras.offs = [];
	};
	if (live.EXT) map.on("load", () => { mountExtExtras(live.EXT!); });
	// ── 基図の層を実行時に触る（MapLibre 互換の段 7）──────────────────────────
	// 色・filter・出しズーム・層の削除＝有効な style を組み直して worker へ（基図タイルを新しい style で建て直す＝テーマの生き替えと同じ重さ）。
	// 出し入れ（visibility）は結合で外すだけ（baseVis・安い）。値は MapLibre の入口と同じく旧書式を読み替え、公開の口の目盛りからエンジンの目盛りへ。
	const baseRawStyle = () => withUserBg(live.EXT ? extBaseStyle(live.EXT) : withPM(live.theme.style));
	const baseLayerOf = (id: string) => mlLayers.has(id) ? null : live.style.layers.find(L => L.id === id) ?? null;   // 利用者の層と同じ id なら利用者の層が勝つ
	// 外来 style の「その他の層」＝基図にも利用者の層にも居ない層（画像として載せた raster・描かない層＝線に沿う注記・アイコン・hillshade・塗りより下の画像・知らない型）。
	// MapLibre の getStyle／getLayer は style の全ての層を返す＝こちらも返し、set 系は投げずに記録だけ（絵は変わらない・画像の raster は出し入れと不透明度だけ効く）＝公式例の門 §8 A。
	// 値は style.json の目盛り（MapLibre の z＝dz 1）のまま持つ。setStyle で捨てる
	const extNotes = new Map<string, MLLayer | { removed: true }>();   // id → 今の姿（set 系の記録）｜{ removed: true }
	const extOtherOf = (id: string) => {
		if (!live.EXT || mlLayers.has(id) || live.style.layers.some(L => L.id === id) || baseOverrides.get(id)?.removed) return null;
		const n = extNotes.get(id); if (n?.removed) return null;
		return (n as MLLayer | undefined) ?? live.EXT.ms.layers.find(L => L.id === id) ?? null;
	};
	const isExtImage = (id: string) => extExtras.raster.includes(id);
	const echoOther = (L: MLLayer): MLLayer => ({ ...L, metadata: { ...(L.metadata || {}), [DZ_KEY]: L.metadata?.[DZ_KEY] ?? STYLE_DZ, ...(isExtImage(L.id) ? {} : { "ortho:drawn": false }) } });
	const noteOther = (id: string, fn: (n: NoteLayer) => void) => { const L = extOtherOf(id)!; const n = { ...L, paint: { ...(L.paint || {}) }, layout: { ...(L.layout || {}) } }; fn(n); extNotes.set(id, n); return n; };
	// setPaintProperty の速い道（paint 表の (b) 類の前段・2026-10-22・GL2）：外来 style の基図の塗りと線の色・不透明度・線幅・ずらしで、新しい値が地物に依らない
	// （core build.ts paintFast）なら組み直さない＝tile worker には新しい style を配る（次に作るタイルから）が、作ったタイルは捨てず、描き手が層の差し替えの式で焼いた値を上書きする。
	// 上書きは層の id で覚え、style が変わるたび（restyleBase・setStyle の差分）に今の層の paint から作り直して添字（li）ごとに配る。WebGPU は読まない＝組み直し
	const pzFast = new Set<string>();
	const sendPzOver = () => {
		if (live.renderBackend !== "webgl2") return;
		const list: [number, PaintZoom][] = [], seen = new Set<string>();
		live.style.layers.forEach((L, li) => {
			if (!pzFast.has(L.id)) return;
			const pz = L.type === "fill" || L.type === "line" ? layerPaintZoom(L.type, L.paint as Record<string, unknown> | undefined, "ml", true) : null;
			if (pz) { list.push([li, pz]); seen.add(L.id); }
		});
		for (const id of [...pzFast]) if (!seen.has(id)) pzFast.delete(id);
		renderer.set("pzOver", list);
	};
	// 地物の属性を読む色・不透明度・線幅（paint 表の (b) 類の段 2・線幅は 2b・GL2 の md＝live.paintTable）：前も後も (b) 類で、後の式が読む属性が前の鍵に含まれる（core painttable.ts の paintTableFast）なら
	// 組み直さない＝描き手が表の行を後の式で評価し直す（renderer.set("ptOver", [[層 id, 式]…])）。覚え方と配り直しは pzFast と同じ（層 id で覚え、今の paint から作り直す）
	const ptFast = new Set<string>();
	const sendPtOver = () => {
		if (!live.paintTable) return;
		const list: [string, PtLayer][] = [];
		for (const L of live.style.layers) {
			if (!ptFast.has(L.id)) continue;
			const T = layerPaintTable(L.type, L.paint as Record<string, unknown> | undefined, "ml");
			if (T) list.push([L.id, T]);
		}
		for (const id of [...ptFast]) if (!list.some(e => e[0] === id)) ptFast.delete(id);
		renderer.set("ptOver", list);
	};
	const fastBasePaint = (id: string, name: string, value: unknown): boolean => {
		if (!live.EXT || live.renderBackend !== "webgl2") return false;
		const L = live.style.layers.find(x => x.id === id); if (!L) return false;
		const nv = baseValueIn(name, value), prev = L.paint as Record<string, unknown> | undefined, next = { ...(prev || {}) };
		if (nv === undefined) delete next[name]; else next[name] = nv;
		const pz = paintFast(L.type, prev, next, name, "ml"), pt = pz || !live.paintTable ? null : paintTableFast(L.type, prev, next, name, "ml");
		if (!pz && !pt) return false;
		const o = baseOverrides.get(id) || {}; o.paint = { ...(o.paint || {}), [name]: nv }; baseOverrides.set(id, o);
		live.style = withBaseOverrides(baseRawStyle());
		live.style.globalState = { ...live.MAP_GS };
		setPipelineStyle(live.style, true);
		if (pt) { ptFast.add(id); sendPtOver(); } else pzFast.add(id);
		sendPzOver(); requestDraw(); styleStats.paintFast++;
		return true;
	};
	function restyleBase() {
		live.style = withBaseOverrides(baseRawStyle());
		if (live.EXT) live.style.globalState = { ...live.MAP_GS };   // tile worker の global-state（基図の層の filter/layout）
		live.bg = bgOf(live.style);
		live.land = landOf(live.bg, NO_BG_WHITE ? landDefault() : live.land);
		renderer.set("view", { land: live.land, sea: seaOf(live.bg) });
		live.inspectReapply();   // 検査表示の間（#174）＝陸は背景色のまま
		if (!live.EXT) { renderer.set("sea", { li: seaLi(live.style, "water"), li2: seaLi(live.style, "water-hi"), minzoom: 9 }); renderer.set("bldFill", { li: bldFillLi(live.style) }); }   // 層の添字（削除で動く）
		live.themes = mkThemes(live.style);
		setPipelineStyle(live.style);
		if (pzFast.size) sendPzOver();   // 層の出し入れで添字が動く・組み直しの間の古いタイルも今の値
		if (ptFast.size) sendPtOver();
		live.readySig = ""; live.baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; requestDraw(); onMove();
	}
	const remergeBase = () => { live.readySig = ""; live.baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = ""; requestDraw(); onMove(); };   // 出し入れ＝結合し直すだけ
	const overrideBase = (id: string, fn: (o: BaseOverride) => void) => { const o = baseOverrides.get(id) || {}; fn(o); baseOverrides.set(id, o); restyleBase(); };
	const baseValueIn = (key: string, value: unknown) => value === undefined ? undefined : normalizeMLLayer({ paint: { [key]: value } } as MLLayer, PUBLIC_DZ).paint![key];   // 旧書式の読み替え＋目盛り（公開の口→エンジン）
	const echoBase = (L: MLLayer): MLLayer => ({ ...L, ...(baseVis.get(L.id) === "none" ? { layout: { ...(L.layout || {}), visibility: "none" } } : {}) });
	// 基図の style を生き替える（外来 style で起動した地図だけ）。spec＝URL か style の object。解決は新しい style の基図が描き始めた後
	// setStyle の差分適用（B2・2026-10-12・MapLibre の options.diff＝既定 true）：次の style が「畳める」なら建て直さず、変わった所だけ既存の口に落とす。
	// 畳める＝基図の vector source（id と中身）・sprite・glyphs・terrain・projection・画像の raster 層（と source）・vector の描く層／押し出し（と source）が同じ。
	// 畳めない差（基図の source の tiles が変わる・層の type が変わる等）は従来の建て直し（unmount→mount）。style-spec の diff() は使わない（依存ゼロ）。
	// 基図の層の差（paint/layout/filter/zoom/順/add/remove）＝有効な style を組み直す 1 回（setPaintProperty の上書きと同じ重さ・タイルの生バイトは温間キャッシュ）。
	// style 由来の利用者の層＝id ごとに JSON で比べ、変わった層（と source が変わった層）だけ外して載せ直し、順を style の順に戻す。上書きの台帳（baseOverrides・baseVis・extNotes）は捨てる（新しい style が正）
	const styleStats = dbgHost.__styleStats = { full: 0, diff: 0, rebuilds: 0, paintFast: 0 };   // paintFast＝setPaintProperty の速い道（組み直さなかった回数）   // 検定の窓（debugGlobals）
	const styleFoldable = (a: ExtStyle, b: ExtStyle) => {   // a＝今の EXT・b＝次。畳めない理由の文字列｜null（畳める）
		const J = (x: unknown) => JSON.stringify(x ?? null);
		if (!a.split.vectorSource || a.split.vectorSource !== b.split.vectorSource) return "basemap source id";
		if (J(a.ms.sources?.[a.split.vectorSource]) !== J(b.ms.sources?.[b.split.vectorSource])) return "basemap source";
		for (const k of ["sprite", "glyphs", "terrain", "projection"]) if (J(a.ms[k]) !== J(b.ms[k])) return k;
		const rasterOf = (e: ExtStyle) => J(e.split.raster.map(L => [L, e.ms.sources?.[L.source!] ?? null]));
		if (rasterOf(a) !== rasterOf(b)) return "raster layers";
		const vtOf = (e: ExtStyle) => J(e.ms.layers.filter(L => vtRouted(L, e.ms, e.split.vectorSource)).map(L => [L, L.source === e.split.vectorSource ? null : e.ms.sources?.[L.source!] ?? null]));
		if (vtOf(a) !== vtOf(b)) return "vector layers";
		return null;
	};
	const applyStyleDiff = async (nx: ExtStyle) => {
		const old = live.EXT!, ms = nx.ms, J = (x: unknown) => JSON.stringify(x ?? null);
		baseOverrides.clear(); baseMoves.length = 0; baseVis.clear(); extNotes.clear(); userBg.length = 0;
		live.EXT = nx;
		if (J(old.ms.light) !== J(ms.light)) { live.mlLight = ms.light ? normLight(ms.light) : null; sendLight(); }   // 根の light（B3）
		if (J(old.ms.sky) !== J(ms.sky)) { live.mlSky = ms.sky ? normSky(ms.sky) : null; sendSky(); }   // 根の sky（B4）
		const ns = extBaseStyle(nx); ns.globalState = { ...live.MAP_GS };
		if (J(ns.layers) !== J(live.style.layers)) {   // 基図の層が変わった＝有効な style を組み直す 1 回（restyleBase と同じ手順）
			live.style = ns; live.bg = bgOf(live.style);
			live.land = landOf(live.bg, NO_BG_WHITE ? landDefault() : live.land);
			renderer.set("view", { land: live.land, sea: seaOf(live.bg) }); live.inspectReapply();
			live.themes = mkThemes(live.style); setPipelineStyle(live.style); styleStats.rebuilds++;
			live.readySig = ""; live.baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = "";
		} else live.style = ns;
		if (pzFast.size) sendPzOver();   // setPaintProperty の速い道の上書き＝新しい層の paint から（添字も）
		if (ptFast.size) sendPtOver();
		// style 由来の利用者の層＝変わった層（と source の変わった層）を外して載せ直す
		const oldL = new Map<string, MLLayer>(old.split.geojson.map(L => [L.id, L])), newL = new Map<string, MLLayer>(nx.split.geojson.map(L => [L.id, L]));
		const srcChanged = (sid: string) => J(old.ms.sources?.[sid]) !== J(ms.sources?.[sid]);
		const touched: string[] = [];
		for (const [id, L] of newL) { const p = oldL.get(id); if (!p || J(p) !== J(L) || srcChanged(L.source!) || !mlLayers.has(id)) touched.push(id); }
		for (const id of oldL.keys()) if (!newL.has(id) || touched.includes(id)) { if (mlLayers.has(id)) map.removeLayer(id); extExtras.layers = extExtras.layers.filter(x => x !== id); }
		for (const sid of [...extExtras.sources]) if ((!ms.sources?.[sid] || srcChanged(sid)) && mlSources.has(sid) && ![...mlLayers.values()].some(v => srcId(v.layer) === sid)) { try { map.removeSource(sid); } catch { /* 利用者の層が使っている＝残す */ } extExtras.sources = extExtras.sources.filter(x => x !== sid); }
		for (const id of touched) { const L = newL.get(id)!; extExtras.layers.push(id); try { ensureExtSource(nx, L.source!); await addLayerAt(L, undefined, STYLE_DZ); } catch (err) { extExtras.layers.splice(extExtras.layers.indexOf(id), 1); console.warn("[style] layer", id, err); } }   // 先に控える（mountExtExtrasRaw と同じ・S-P2）
		const order = nx.split.geojson.map(L => L.id);   // 順＝style の順（載せ直した層は末尾に居る＝次の「触っていない」層の前へ）
		for (const id of touched) { const i = order.indexOf(id), anchor = order.slice(i + 1).find(x => mlLayers.has(x) && !touched.includes(x)); if (anchor && mlLayers.has(id)) map.moveLayer(id, anchor); }
		sendUserAnchors();
		styleStats.diff++; requestDraw(); onMove();
		return map;
	};
	map.setStyle = async (spec, o = {}) => {
		if (!live.EXT) throw new Error("setStyle: this map uses the regional basemap — boot with opts.style (or ?style=) to switch MapLibre styles");
		const nx = await loadExtStyle(spec, o?.transformStyle);
		const why = o.diff === false ? "diff:false" : styleFoldable(live.EXT, nx);
		if (!why) return applyStyleDiff(nx);
		if (o.diff !== false && DEBUG_GLOBALS) console.info(`[style] setStyle rebuilds (not foldable: ${why})`);
		styleStats.full++; styleStats.rebuilds++;
		unmountExtExtras();
		const oldBaseSid = baseSidNow();
		baseOverrides.clear(); baseMoves.length = 0; baseVis.clear(); extNotes.clear(); userBg.length = 0;   // 新しい style＝基図の層の上書き（その他の層の記録も・実行時の background 層も）は捨てる（MapLibre の setStyle と同じ）
		live.EXT = nx;
		live.mlLight = nx.ms.light ? normLight(nx.ms.light) : null; sendLight();   // 新しい style の根の light（B3）
		live.mlSky = nx.ms.sky ? normSky(nx.ms.sky) : null; sendSky();   // 新しい style の根の sky（B4）
		for (const id of [...spriteNames.keys()]) spriteDrop(id); live.spriteList = normSprite(nx.ms.sprite); live.mlGlyphs = nx.ms.glyphs ?? null;   // 新しい style の sprite/glyphs（B6）＝前の sprite の記号は消す
		Object.assign(BASE_SOURCE, extSourceFields(nx));
		if (BASE_SOURCE.kind === "pmtiles") {
			const info = await pmtilesInfo(BASE_SOURCE.url!).catch(err => { console.warn("[style] cannot read PMTiles", err); return null; });
			BASE_SOURCE.info = info; if (info?.attribution && !BASE_SOURCE.attrHTML) BASE_SOURCE.attrHTML = sanitizeHTML(String(info.attribution));
		}
		live.style = extBaseStyle(nx);
		live.bg = bgOf(live.style);
		live.land = landOf(live.bg, NO_BG_WHITE ? landDefault() : live.land);
		renderer.set("view", { land: live.land, sea: seaOf(live.bg) });
		live.inspectReapply();   // 検査表示の間（#174）＝陸は背景色のまま
		live.themes = mkThemes(live.style);
		setPipelineStyle(live.style);   // （sea / bldFill の門は外来 style では常に -1＝差し替え不要）
		if (pzFast.size) { pzFast.clear(); sendPzOver(); }   // setPaintProperty の速い道の上書きを捨てる（別の style の層の添字）
		if (ptFast.size) { ptFast.clear(); sendPtOver(); }
		live.readySig = ""; live.baseSig = ""; mergeReq.main.sig = ""; mergeReq.base.sig = "";   // テーマの生き替え（上）と同じ＝結合の署名を捨てる。⚠これが無いと同じタイル集合では旧色のシーンが結合し直されず残る（t-request ④が 0% になった）
		live.attrZone = null; requestDraw(); onMove();
		for (const [id, v] of [...mlLayers]) if ((v.kind === "vtextrude" || v.kind === "vtdraw") && v.src?.[BASE_SRC] && srcId(v.layer) === oldBaseSid) {   // 利用者が基図の source に載せた押し出し・描く層（段 8①・8⑤）
			if (baseSidNow() === oldBaseSid) mountLayer(v);   // 同じ名前の source＝新しい style のタイルで組み直す
			else { mlLayers.delete(id); unmountLayer(v); console.warn(`[style] layer "${id}" removed — the new style has no source "${oldBaseSid}"`); }
		}
		await mountExtExtras(nx);
		return map;
	};
	// source の地物（MapLibre の querySourceFeatures・同期・公式例の門 3 巡目）：集約の source＝今の段の丸と単点（画面の内側＋余白）＝properties に cluster/cluster_id/point_count・
	// geojson の source（data が object）＝全部の地物（MapLibre は読んだタイルの分＝おおよそ見えている所＋余白・こちらは全部＝上位互換）。vector の source は空（未対応・記録）
	map.querySourceFeatures = (sid, qo = {}) => {
		const sp = mlSources.get(sid), isVec = sp ? sp.type === "vector" : vtdDesc.has(sid) || vtxDescs.has(sid) || vtRaw.keys(sid).length > 0;   // style.json の vector source（基図の source 名）は mlSources に無い＝写し／記述子で見る
		if (!sp && !isVec) return [];
		const qf = <F extends FeatureLike>(fs: F[]) => qo.filter ? fs.filter(f => truthy(evalExpr(normalizeMLLayer({ filter: qo.filter } as MLLayer, PUBLIC_DZ).filter, { zoom: cam.zoom, props: f.properties, geom: f.geometry?.type?.replace("Multi", ""), vars: {}, gs: live.MAP_GS, geojson: f.geometry, pitch: cam.pitch * R2D, origin: "ml" }))) : fs;
		if (isVec) {   // C7（2026-10-12）：出しているタイル（vtdraw／vtextrude が取った写し）を同期で解く。sourceLayer 必須（MapLibre と同じ）・タイルをまたぐ地物は枚数ぶん重複（同じ）
			const sl = qo.sourceLayer; if (!sl) { console.warn(`[querySourceFeatures] vector source "${sid}": sourceLayer is required`); return []; }
			const keys = new Set([...(live.vtdCtl?.shownTiles(sid) || []).map(o => o.key), ...(live.vtxCtl?.shownTiles(sid) || [])]);
			if (!keys.size) for (const k of vtRaw.keys(sid)) keys.add(k);   // 出している物が無い（層が外れた直後など）＝写しに残っている分
			const filter = qo.filter ? normalizeMLLayer({ filter: qo.filter } as MLLayer, PUBLIC_DZ).filter : null, promoteId = vtdDesc.get(sid)?.promoteId ?? sp?.promoteId ?? null, out: RenderedFeature[] = [];
			for (const key of keys) {
				const data = vtRaw.decoded(sid, key); if (!data) continue;
				const [z, x, y] = key.split("/").map(Number);
				for (const f of sourceFeatures(data, { z, x, y, key }, { sourceLayer: sl, filter, zoom: cam.zoom, gs: live.MAP_GS, promoteId, source: sid, pitch: cam.pitch * R2D }) as Array<RenderedFeature & { tile?: string; state?: Record<string, unknown> }>) { f.state = vtxStateOf(sid, sl, f.id); delete f.tile; out.push(f); }
			}
			return out;
		}
		const cl = sp!.cluster ? clusterNow(sid) : null;   // 集約の source＝今の段の丸と単点（cluster as data・段＝エンジンの z）
		const W = size.w / live.dpr, H = size.h / live.dpr, mx = W / 4, my = H / 4;   // 画面の内側（余白 1/4）＝MapLibre の「読んであるタイル」の近似
		const onScreen = (c: number[]) => { const p = map.projectLL(c[0], c[1]); return p[2] >= 0 && p[0] >= -mx && p[1] >= -my && p[0] <= W + mx && p[1] <= H + my; };
		if (cl) return qf(cl.fc.features.filter(f => cam.zoom >= (f.properties[ML_CZ0_KEY] as number) && cam.zoom < (f.properties[ML_CZ1_KEY] as number) && onScreen(f.geometry.coordinates)).map(f => ({ type: "Feature", ...(f.id != null ? { id: f.id } : {}), properties: stripMl(f.properties), geometry: f.geometry, source: sid }))) as RenderedFeature[];
		const d = sp!.data as DataLike | string | null | undefined; if (!d || typeof d !== "object") return [];
		const fs = (d.type === "FeatureCollection" ? d.features : d.type === "Feature" ? [d] : []) as FeatureLike[];
		return qf(fs.map((f, i) => ({ type: "Feature", id: f.id ?? mlIdOf(sid, i) ?? i, properties: f.properties || {}, geometry: f.geometry, source: sid }))) as RenderedFeature[];
	};
	return { extExtras, remergeBase, addSourceAt, addLayerAt, remountSource, styleOrder };
}
