// MapLibre の口（公式例の門 §8・本人裁定 1「製品の口」）の Map＝`new maplibregl.Map({...})` をこの地図（createGlobe）へ通訳する。
// 約束（通訳だけ・台帳 §8）：
//   ・エンジンに機能を足さない。同じ働きがあれば言い換え、無ければ投げずに記録して何もしない（report.js の unsupported）＝点数を正直に保つ
//   ・呼ぶのは ../globe.js の公開面だけ（RAW を使わない）・エンジンの map に鍵を生やさない（状態は WeakMap）
//   ・起動は既定で MapLibre の見え方（本人裁定 4）：夜面・星空・世界の海岸線・自前の地形なし（地形は setTerrain／style の terrain の時だけ）・z は MapLibre の目盛り
//   ・同期のコンストラクタ（createGlobe は非同期）＝準備ができるまでの呼び出しは列に溜め、load の前に順に流す
//   ・1 頁 1 地図（エンジンの canvas の id が固定）＝2 枚目は何もしない実体（load は来ない）
import { createGlobe, Marker as OrthoMarker, Popup as OrthoPopup } from "../globe.js";
import { LngLat, LngLatBounds } from "./geo.js";
import { unsupported } from "./report.js";
import { lngArr, boundsArr, camOpts, viewOf } from "./util.js";

// MapLibre GL JS 6.11.2 の Map の公開の口（型定義から）。ここに実装の無い口は「unsupported を記録して this」を返す
const ML_METHODS = new Set(["addControl", "addImage", "addLayer", "addSource", "addSprite", "areTilesLoaded", "calculateAnchoredCameraOptions", "calculateCameraOptionsFromCameraLngLatAltRotation", "calculateCameraOptionsFromTo", "cameraForBounds", "coveringTiles", "easeTo", "fire", "fitBounds", "fitScreenCoordinates", "flyTo", "getAnisotropicFilterPitch", "getBearing", "getBounds", "getCameraTargetElevation", "getCanvas", "getCanvasContainer", "getCenter", "getCenterClampedToGround", "getCenterElevation", "getContainer", "getFeatureState", "getFilter", "getFontFaces", "getGlobalState", "getGlyphs", "getImage", "getLayer", "getLayersOrder", "getLayoutProperty", "getLight", "getMaxBounds", "getMaxPitch", "getMaxZoom", "getMinPitch", "getMinZoom", "getPadding", "getPaintProperty", "getPitch", "getPixelRatio", "getProjection", "getRenderWorldCopies", "getRoll", "getSky", "getSource", "getSprite", "getStyle", "getStyleUrl", "getTerrain", "getVerticalFieldOfView", "getZoom", "getZoomSnap", "hasControl", "hasImage", "isMoving", "isRotating", "isSourceLoaded", "isStyleLoaded", "isZooming", "jumpTo", "listImages", "listens", "loadImage", "loaded", "migrateProjection", "moveLayer", "off", "on", "once", "panBy", "panTo", "project", "queryRenderedFeatures", "querySourceFeatures", "queryTerrainElevation", "redraw", "refreshTiles", "remove", "removeControl", "removeFeatureState", "removeImage", "removeLayer", "removeSource", "removeSprite", "repaint", "resetNorth", "resetNorthPitch", "resize", "rotateTo", "setAnisotropicFilterPitch", "setBearing", "setCenter", "setCenterClampedToGround", "setCenterElevation", "setEventedParent", "setFeatureState", "setFilter", "setFontFaces", "setGlobalStateProperty", "setGlyphs", "setLayerZoomRange", "setLayoutProperty", "setLight", "setMaxBounds", "setMaxPitch", "setMaxZoom", "setMinPitch", "setMinZoom", "setMissingStyleImageResolver", "setPadding", "setPaintProperty", "setPitch", "setPixelRatio", "setProjection", "setRenderWorldCopies", "setRoll", "setSky", "setSourceTileLodParams", "setSprite", "setStyle", "setTerrain", "setTransformCameraUpdate", "setTransformConstrain", "setTransformRequest", "setVerticalFieldOfView", "setZoom", "setZoomSnap", "showCollisionBoxes", "showOverdrawInspector", "showPadding", "showTileBoundaries", "snapToNorth", "stop", "triggerRepaint", "unproject", "updateImage", "version", "vertices", "zoomIn", "zoomOut", "zoomTo"]);
const HANDLERS = ["scrollZoom", "boxZoom", "dragRotate", "dragPan", "keyboard", "doubleClickZoom", "touchZoomRotate", "touchPitch", "cooperativeGestures"];
// 事象：エンジンの事象から作る物／容れ物の DOM から作る物（点と経緯度は公開の unproject）
const ENGINE_EVENTS = new Set(["load", "style.load", "styledata", "data", "sourcedata", "idle", "error", "resize", "remove", "render",
	"move", "movestart", "moveend", "zoom", "zoomstart", "zoomend", "rotate", "rotatestart", "rotateend", "pitch", "pitchstart", "pitchend"]);
const DOM_EVENTS = new Set(["click", "dblclick", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "contextmenu", "wheel", "touchstart", "touchend", "touchmove", "touchcancel"]);
const LAYER_EVENTS = new Set(["click", "mousemove", "mouseenter", "mouseleave"]);   // エンジンが層ごとに持つ事象（#34）

const S = new WeakMap();   // 通訳の地図（と Proxy）→ 状態
let liveMaps = 0;


// 通訳の地図の中のエンジンの地図（公式例の門の走らせ台だけが使う＝index.js からは出さない）
export const engineOf = map => S.get(map)?.engine ?? null;
export const whenEngine = map => S.get(map)?.ready ?? Promise.resolve(null);

function emit(self, type, props = {}) {
	const st = S.get(self), set = st.ev.get(type);
	if (!set || !set.size) return;
	const ev = { type, target: self, ...props };
	for (const fn of [...set]) {
		try { fn.call(self, ev); } catch (e) { queueMicrotask(() => { throw e; }); }   // 聞き手の例外は MapLibre と同じく握りつぶさない（頁の未捕捉の例外になる）
	}
}
const fail = (self, name, e) => { console.error(`[mlshim] ${name}:`, e?.message ?? e); emit(self, "error", { error: e instanceof Error ? e : new Error(String(e)) }); };

// エンジンへ渡す。準備前は列に溜めて before を返す。Promise を返す口は待たずに this（失敗は error 事象）
function ask(self, name, args, { before, conv } = {}) {
	const st = S.get(self);
	if (st.inert) return before;
	const run = () => {
		let r;
		try { r = st.engine[name](...args); } catch (e) { fail(self, name, e); return before; }
		if (r && typeof r.then === "function") { r.catch(e => fail(self, name, e)); return self; }
		return conv ? conv(r) : r;
	};
	if (st.engine && st.loaded) return run();
	st.queue.push(run);
	return before;
}
const onEngine = (st, fn) => { if (st.engine) fn(st.engine); else st.engineFns.push(fn); };

// 容れ物の DOM の事象（素の click／mousemove…）＝点は容れ物の左上原点・経緯度は公開の unproject。click はドラッグの後には出さない（3px）
function domEvent(self, st, type, e) {
	const r = st.container.getBoundingClientRect(), src = e.touches?.[0] || e.changedTouches?.[0] || e;
	const point = { x: src.clientX - r.left, y: src.clientY - r.top };
	const ll = st.engine?.unproject([point.x, point.y]);
	let prevented = false;
	return { type, target: self, originalEvent: e, point, lngLat: ll ? new LngLat(ll.lng, ll.lat) : null,
		preventDefault() { prevented = true; }, get defaultPrevented() { return prevented; } };
}
function bindDom(self, st, type) {
	if (st.dom.has(type)) return;
	st.dom.add(type);
	const src = type === "mouseover" ? "mouseenter" : type === "mouseout" ? "mouseleave" : type;
	if (type === "click" || type === "mousedown") st.container.addEventListener("mousedown", e => { st.down = [e.clientX, e.clientY]; }, true);
	st.container.addEventListener(src, e => {
		if (type === "click" && st.down && Math.hypot(e.clientX - st.down[0], e.clientY - st.down[1]) > 3) return;
		emit(self, type, domEvent(self, st, type, e));
	});
}

// エンジンの事象 → MapLibre の事象（move は zoom/rotate/pitch に分け、start/end を付ける＝end はエンジンの settle）
function wireEngine(self, st) {
	const eng = st.engine;
	let moving = null;
	eng.on("move", e => {
		st.idle = false;
		const c = { zoom: eng.getZoom(), bearing: eng.getBearing(), pitch: eng.getPitch() };
		if (!moving) { moving = { from: st.last ?? c, zoom: false, rotate: false, pitch: false }; emit(self, "movestart"); }
		const p = st.last ?? moving.from;
		for (const [k, name] of [["zoom", "zoom"], ["bearing", "rotate"], ["pitch", "pitch"]]) {
			if (Math.abs(c[k] - p[k]) < 1e-9) continue;
			if (!moving[name]) { moving[name] = true; emit(self, `${name}start`); }
			emit(self, name);
		}
		emit(self, "move");
		st.last = c;
	});
	eng.on("settle", () => {
		if (!moving) return;
		const m = moving; moving = null;
		for (const name of ["zoom", "rotate", "pitch"]) if (m[name]) emit(self, `${name}end`);
		emit(self, "moveend");
	});
	eng.on("idle", () => {
		st.idle = true;
		for (const id of st.sources) { emit(self, "sourcedata", { dataType: "source", sourceId: id, isSourceLoaded: true, sourceDataType: "idle" }); emit(self, "data", { dataType: "source", sourceId: id }); }
		emit(self, "idle");
	});
	if (typeof ResizeObserver === "function") new ResizeObserver(() => emit(self, "resize")).observe(st.container);
}

const TRAP = {
	get(t, p, r) {
		if (p in t) return Reflect.get(t, p, r);
		if (typeof p === "string" && ML_METHODS.has(p)) return (...a) => { unsupported(r, `${p}()`); return /^(get|is|query|calculate|covering)/.test(p) ? undefined : r; };
		return undefined;
	},
};

export class Map {
	constructor(options = {}) {
		const container = typeof options.container === "string" ? document.getElementById(options.container) : options.container;
		if (!container) throw new Error(`Container '${options.container}' not found.`);
		const st = { options, container, engine: null, loaded: false, idle: false, inert: false, queue: [], engineFns: [], ev: new globalThis.Map(), dom: new Set(),
			layerSubs: [], sources: new Set(), controls: new globalThis.Map(), corners: null, last: null, raf: 0,
			init: { center: LngLat.convert(options.center ?? [0, 0]), zoom: options.zoom ?? 0, bearing: options.bearing ?? 0, pitch: options.pitch ?? 0 } };
		const self = new Proxy(this, TRAP);
		S.set(this, st); S.set(self, st);
		// 操作ハンドラ（scrollZoom.disable()・touchZoomRotate.disableRotation() …）＝どの口も受ける。止める系は見た目の記録（操作の手触り＝最初の絵は変わらない）
		const handler = h => new Proxy({ isEnabled: () => true, isActive: () => false }, { get: (o, k) => k in o ? o[k] : typeof k !== "string" ? undefined
			: (...a) => { if (/^disable/.test(k)) unsupported(self, `${h}.${k}()`, "cosmetic"); return undefined; } });
		st.handlers = Object.fromEntries(HANDLERS.map(h => [h, handler(h)]));
		if (liveMaps++ > 0) { st.inert = true; unsupported(self, "second Map on the page (one map per page)"); return self; }
		if (options.maplibreLogo) unsupported(self, "option maplibreLogo", "cosmetic");
		if (options.hash) unsupported(self, "option hash", "cosmetic");
		if (options.interactive === false) unsupported(self, "option interactive: false", "cosmetic");
		if (options.renderWorldCopies === false) unsupported(self, "option renderWorldCopies: false (the globe has no world copies)", "cosmetic");
		const o = {
			target: container, view: viewOf(st.init), zoomScale: "maplibre",
			night: false, sky: false, coastline: false, terrain: false, chips: false, countryTip: false, persistView: false,
			instruments: options.attributionControl === false ? false : ["attr"],
			style: options.style ?? { version: 8, sources: {}, layers: [] },   // style 無しの Map＝空の style（MapLibre と同じく後から setStyle できる・エンジンは起動時の style が要る）
			...(options.maxZoom != null && { zoomMax: options.maxZoom }),
			...(options.maxPitch != null && { maxPitch: options.maxPitch }),
			...(options.transformRequest && { transformRequest: options.transformRequest }),
			...options.ortho,   // この地図の起動オプションへの逃げ道（夜面・星空を点ける・時計を止める…）
		};
		st.ready = createGlobe(o).then(async eng => {
			st.engine = eng;
			wireEngine(self, st);
			for (const f of st.engineFns.splice(0)) f(eng);
			if (options.minZoom != null) eng.setMinZoom(options.minZoom);
			if (options.maxBounds) eng.setMaxBounds(boundsArr(options.maxBounds));
			if (options.bounds) eng.fitBounds(boundsArr(options.bounds), { ...options.fitBoundsOptions, animate: false });
			await eng.once("load");
			// 視点をコンストラクタで 1 つも変えていない地図だけ style の根の center/zoom/bearing/pitch（MapLibre 6.11.2 と同じ＝transform.unmodified の時だけ
			// style.load で jumpTo・既定値と同じ値を書いたのは変えていない扱い・bounds は変えた扱い）。style.json は MapLibre の z
			const c0 = options.center == null ? null : LngLat.convert(options.center);
			const unmodified = !options.bounds && (c0 == null || (c0.lng === 0 && c0.lat === 0)) && !options.zoom && !options.bearing && !options.pitch;
			const sty = unmodified ? (() => { try { return eng.getStyle(); } catch { return null; } })() : null;
			const cam = Object.fromEntries(["center", "zoom", "bearing", "pitch"].filter(k => sty?.[k] != null).map(k => [k, sty[k]]));
			if (Object.keys(cam).length) eng.jumpTo(cam);
			st.loaded = true;
			for (const f of st.queue.splice(0)) f();
			emit(self, "styledata", { dataType: "style" }); emit(self, "data", { dataType: "style" });
			emit(self, "style.load");
			emit(self, "load");
			return eng;
		}).catch(e => { fail(self, "Map", e); return null; });
		return self;
	}

	// ── 事象 ──
	on(type, layerOrFn, fn) {
		const st = S.get(this);
		if (typeof layerOrFn === "function") {
			if (!st.ev.has(type)) st.ev.set(type, new Set());
			st.ev.get(type).add(layerOrFn);
			if (DOM_EVENTS.has(type)) bindDom(this, st, type);
			else if (type === "render") this._render(st);
			else if (!ENGINE_EVENTS.has(type)) unsupported(this, `on("${type}")`);
			return this;
		}
		if (!LAYER_EVENTS.has(type)) { unsupported(this, `on("${type}", layerId)`); return this; }
		const sub = { type, layer: layerOrFn, fn, w: e => fn.call(this, { ...e, type, target: this, lngLat: e.lngLat ? LngLat.convert(e.lngLat) : e.lngLat }) };
		st.layerSubs.push(sub);
		onEngine(st, eng => eng.on(type, sub.layer, sub.w));
		return this;
	}
	off(type, layerOrFn, fn) {
		const st = S.get(this);
		if (typeof layerOrFn === "function") { st.ev.get(type)?.delete(layerOrFn); return this; }
		const i = st.layerSubs.findIndex(s => s.type === type && s.fn === fn && String(s.layer) === String(layerOrFn));
		if (i >= 0) { const [s] = st.layerSubs.splice(i, 1); onEngine(st, eng => eng.off(type, s.layer, s.w)); }
		return this;
	}
	once(type, layerOrFn, fn) {
		const layer = typeof layerOrFn === "function" || layerOrFn == null ? null : layerOrFn, cb = typeof layerOrFn === "function" ? layerOrFn : fn;
		if (!cb) return new Promise(res => this.once(type, ...(layer ? [layer] : []), res));
		const w = e => { layer ? this.off(type, layer, w) : this.off(type, w); cb.call(this, e); };
		return layer ? this.on(type, layer, w) : this.on(type, w);
	}
	listens(type) { return !!S.get(this).ev.get(type)?.size; }
	fire(ev, props) { const type = typeof ev === "string" ? ev : ev.type; emit(this, type, { ...(typeof ev === "object" ? ev : {}), ...props }); return this; }
	_render(st) {
		if (st.raf) return;
		const tick = () => { st.raf = st.ev.get("render")?.size ? requestAnimationFrame(tick) : 0; if (st.loaded) emit(this, "render"); };
		st.raf = requestAnimationFrame(tick);
	}

	// ── カメラ ──
	getCenter() { const st = S.get(this); if (!st.engine) return st.init.center; const c = st.engine.getCenter(); return new LngLat(c.lng, c.lat); }
	getZoom() { const st = S.get(this); return st.engine ? st.engine.getZoom() : st.init.zoom; }
	getBearing() { const st = S.get(this); return st.engine ? st.engine.getBearing() : st.init.bearing; }
	getPitch() { const st = S.get(this); return st.engine ? st.engine.getPitch() : st.init.pitch; }
	setCenter(c, e) { return this.jumpTo({ center: c }, e); }
	setZoom(z, e) { return this.jumpTo({ zoom: z }, e); }
	setBearing(b, e) { return this.jumpTo({ bearing: b }, e); }
	setPitch(p, e) { return this.jumpTo({ pitch: p }, e); }
	jumpTo(o) { ask(this, "jumpTo", [camOpts(o)]); return this; }
	easeTo(o) { ask(this, "easeTo", [camOpts(o)]); return this; }
	flyTo(o) { ask(this, "flyTo", [camOpts(o)]); return this; }
	panTo(c, o) { return this.easeTo({ ...o, center: c }); }
	panBy(off, o) {
		const st = S.get(this), [dx, dy] = Array.isArray(off) ? off : [off.x, off.y];
		const r = st.container.getBoundingClientRect(), c = this.unproject([r.width / 2 + dx, r.height / 2 + dy]);
		return c ? this.easeTo({ ...o, center: c }) : this;
	}
	zoomTo(z, o) { return this.easeTo({ ...o, zoom: z }); }
	zoomIn(o) { return this.easeTo({ ...o, zoom: this.getZoom() + 1 }); }
	zoomOut(o) { return this.easeTo({ ...o, zoom: this.getZoom() - 1 }); }
	rotateTo(b, o) { return this.easeTo({ ...o, bearing: b }); }
	resetNorth(o) { return this.easeTo({ duration: 1000, ...o, bearing: 0 }); }
	resetNorthPitch(o) { return this.easeTo({ duration: 1000, ...o, bearing: 0, pitch: 0 }); }
	snapToNorth(o) { return Math.abs(this.getBearing()) < 7 ? this.resetNorth(o) : this; }
	fitBounds(b, o = {}) { ask(this, "fitBounds", [boundsArr(b), o]); return this; }
	cameraForBounds(b, o) { const c = ask(this, "cameraForBounds", [boundsArr(b), o]); return c && c.center ? { ...c, center: new LngLat(c.center[0], c.center[1]) } : c; }
	getBounds() { const b = ask(this, "getBounds", []); return b ? new LngLatBounds([b[0], b[1]], [b[2], b[3]]) : new LngLatBounds(); }
	setMaxBounds(b) { ask(this, "setMaxBounds", [b ? boundsArr(b) : null]); return this; }
	getMaxBounds() { const b = ask(this, "getMaxBounds", []); return b ? new LngLatBounds([b[0], b[1]], [b[2], b[3]]) : null; }
	setMinZoom(z) { ask(this, "setMinZoom", [z]); return this; }
	getMinZoom() { return ask(this, "getMinZoom", [], { before: 0 }); }
	setMaxZoom(z) { ask(this, "setMaxZoom", [z]); return this; }
	getMaxZoom() { return ask(this, "getMaxZoom", [], { before: 22 }); }
	setMaxPitch(p) { ask(this, "setMaxPitch", [p]); return this; }
	getMaxPitch() { return ask(this, "getMaxPitch", [], { before: 60 }); }
	setPadding(p) { ask(this, "setPadding", [p]); return this; }
	getPadding() { return ask(this, "getPadding", [], { before: { top: 0, bottom: 0, left: 0, right: 0 } }); }
	isMoving() { return !!ask(this, "isMoving", [], { before: false }); }
	isZooming() { return this.isMoving(); }
	isRotating() { return this.isMoving(); }
	stop() { ask(this, "stop", []); return this; }
	project(ll) { const p = S.get(this).engine?.project(lngArr(ll)); return p ? { x: p.x, y: p.y } : { x: NaN, y: NaN }; }
	unproject(p) { const ll = S.get(this).engine?.unproject(Array.isArray(p) ? p : [p.x, p.y]); return ll ? new LngLat(ll.lng, ll.lat) : null; }

	// ── style・source・層 ──
	setStyle(style, o) { ask(this, "setStyle", [style, o]); return this; }
	getStyle() { return ask(this, "getStyle", []); }
	isStyleLoaded() { return S.get(this).loaded; }
	loaded() { const st = S.get(this); return st.loaded && st.idle && !st.engine?.isMoving(); }
	areTilesLoaded() { return S.get(this).idle; }
	addSource(id, src) { S.get(this).sources.add(id); ask(this, "addSource", [id, src]); return this; }
	removeSource(id) { S.get(this).sources.delete(id); ask(this, "removeSource", [id]); return this; }
	getSource(id) { return ask(this, "getSource", [id]); }
	isSourceLoaded(id) { return !!ask(this, "isSourceLoaded", [id], { before: false }); }
	addLayer(layer, before) {
		if (layer?.type === "custom") { unsupported(this, "addLayer type custom (CustomLayerInterface — this map does not hand out its WebGL context)"); return this; }
		ask(this, "addLayer", before != null ? [layer, before] : [layer]); return this;
	}
	removeLayer(id) { ask(this, "removeLayer", [id]); return this; }
	getLayer(id) { return ask(this, "getLayer", [id]); }
	getLayersOrder() { return (this.getStyle()?.layers || []).map(l => l.id); }
	moveLayer(id, before) { ask(this, "moveLayer", [id, before]); return this; }
	setPaintProperty(id, k, v, o) { ask(this, "setPaintProperty", [id, k, v, o]); return this; }
	getPaintProperty(id, k) { return ask(this, "getPaintProperty", [id, k]); }
	setLayoutProperty(id, k, v, o) { ask(this, "setLayoutProperty", [id, k, v, o]); return this; }
	getLayoutProperty(id, k) { return ask(this, "getLayoutProperty", [id, k]); }
	setFilter(id, f, o) { ask(this, "setFilter", [id, f, o]); return this; }
	getFilter(id) { return ask(this, "getFilter", [id]); }
	setLayerZoomRange(id, a, b) { ask(this, "setLayerZoomRange", [id, a, b]); return this; }
	setFeatureState(f, s) { ask(this, "setFeatureState", [f, s]); return this; }
	removeFeatureState(f, k) { ask(this, "removeFeatureState", [f, k]); return this; }
	getFeatureState(f) { return ask(this, "getFeatureState", [f]); }
	// 問い合わせ＝この地図は非同期（台帳 §4）＝MapLibre の同期の答えは返せない。空で返し、差として記録する（通訳で隠さない）
	queryRenderedFeatures() { unsupported(this, "queryRenderedFeatures (synchronous result)"); return []; }
	querySourceFeatures() { unsupported(this, "querySourceFeatures"); return []; }
	queryTerrainElevation() { unsupported(this, "queryTerrainElevation (synchronous result)"); return null; }
	setTerrain(t) { ask(this, "setTerrain", [t]); return this; }
	getTerrain() { return ask(this, "getTerrain", [], { before: null }); }
	setProjection(p) { if ((p?.type ?? p) !== "globe") unsupported(this, `setProjection(${JSON.stringify(p?.type ?? p)}) (this map is always a globe)`); return this; }
	getProjection() { return { type: "globe" }; }
	setTransformRequest(fn) { ask(this, "setTransformRequest", [fn]); return this; }

	// ── 画像 ──
	addImage(id, img, o) {
		if (img && typeof img.render === "function") unsupported(this, "addImage (animated StyleImageInterface)");
		ask(this, "addImage", [id, img?.data && img.width ? { width: img.width, height: img.height, data: img.data } : img, o]);
		return this;
	}
	hasImage(id) { return !!ask(this, "hasImage", [id], { before: false }); }
	removeImage(id) { ask(this, "removeImage", [id]); return this; }
	listImages() { return ask(this, "listImages", [], { before: [] }); }
	async loadImage(url) {
		const r = await fetch(url);
		if (!r.ok) throw new Error(`AJAXError: ${r.statusText} (${r.status}): ${url}`);
		return { data: await createImageBitmap(await r.blob()) };
	}

	// ── 容れ物・描画・後片付け ──
	getContainer() { return S.get(this).container; }
	getCanvasContainer() { return S.get(this).container; }
	getCanvas() {
		const st = S.get(this), c = st.container.querySelector("canvas#c");
		if (c) return c;
		unsupported(this, "getCanvas before the map is ready");
		return (st.placeholder ??= document.createElement("canvas"));
	}
	getPixelRatio() { return window.devicePixelRatio || 1; }
	triggerRepaint() { S.get(this).engine?.requestDraw?.(); }
	redraw() { this.triggerRepaint(); return this; }
	resize() { return this; }   // 容れ物の大きさはエンジンが ResizeObserver で追う
	remove() {
		const st = S.get(this);
		for (const c of [...st.controls.keys()]) this.removeControl(c);
		if (!st.inert) { liveMaps--; onEngine(st, eng => eng.destroy()); }
		emit(this, "remove");
	}
	get version() { return "ortho-earth"; }

	// ── 操作部品（IControl）＝MapLibre の CSS の class 名の四隅へ ──
	addControl(ctrl, pos) {
		const st = S.get(this);
		if (!ctrl || typeof ctrl.onAdd !== "function") throw new Error("Invalid argument to map.addControl(). Argument must be a control with onAdd and onRemove methods.");
		if (!st.corners) {
			const root = document.createElement("div"); root.className = "maplibregl-control-container";
			st.corners = Object.fromEntries(["top-left", "top-right", "bottom-left", "bottom-right"].map(k => { const d = document.createElement("div"); d.className = `maplibregl-ctrl-${k}`; root.appendChild(d); return [k, d]; }));
			st.container.appendChild(root);
		}
		const where = pos || ctrl.getDefaultPosition?.() || "top-right", el = ctrl.onAdd(this);
		const corner = st.corners[where] || st.corners["top-right"];
		if (where.startsWith("bottom")) corner.insertBefore(el, corner.firstChild); else corner.appendChild(el);
		st.controls.set(ctrl, el);
		return this;
	}
	removeControl(ctrl) { const st = S.get(this); if (!st.controls.has(ctrl)) return this; st.controls.delete(ctrl); ctrl.onRemove?.(this); return this; }
	hasControl(ctrl) { return S.get(this).controls.has(ctrl); }
}
for (const h of HANDLERS) Object.defineProperty(Map.prototype, h, { get() { return S.get(this).handlers[h]; } });

// Marker／Popup＝エンジンの部品に、通訳の地図と LngLat の受け渡しだけを足す（準備前の addTo は準備を待って載せる）
export class Marker extends OrthoMarker {
	constructor(options, legacy) { super(typeof HTMLElement !== "undefined" && options instanceof HTMLElement ? { ...legacy, element: options } : options); }
	addTo(map) {
		const st = S.get(map);
		if (!st) return super.addTo(map);
		if (!st.inert) onEngine(st, eng => super.addTo(eng));
		return this;
	}
	setLngLat(ll) { return super.setLngLat(lngArr(ll)); }
	getLngLat() { const v = super.getLngLat(); return v ? LngLat.convert(v) : v; }
}
export class Popup extends OrthoPopup {
	addTo(map) {
		const st = S.get(map);
		if (!st) return super.addTo(map);
		if (!st.inert) onEngine(st, eng => super.addTo(eng));
		return this;
	}
	setLngLat(ll) { return super.setLngLat(lngArr(ll)); }
	getLngLat() { const v = super.getLngLat?.(); return v ? LngLat.convert(v) : v; }
	trackPointer() { unsupported(this, "Popup.trackPointer", "cosmetic"); return this; }
}
