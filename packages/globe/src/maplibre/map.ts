// MapLibre の口（公式例の門 §8・本人裁定 1「製品の口」）の Map＝`new maplibregl.Map({...})` をこの地図（createGlobe）へ通訳する。
// 約束（通訳だけ・台帳 §8）：
//   ・エンジンに機能を足さない。同じ働きがあれば言い換え、無ければ投げずに記録して何もしない（report.js の unsupported）＝点数を正直に保つ
//   ・呼ぶのは ../globe.js の公開面だけ（RAW を使わない）・エンジンの map に鍵を生やさない（状態は WeakMap）
//   ・起動は既定で MapLibre の見え方（本人裁定 4）：夜面・星空・世界の海岸線・自前の地形なし（地形は setTerrain／style の terrain の時だけ）・z は MapLibre の目盛り
//   ・同期のコンストラクタ（createGlobe は非同期）＝準備ができるまでの呼び出しは列に溜め、load の前に順に流す
//   ・1 頁 1 地図（エンジンの canvas の id が固定）＝2 枚目は何もしない実体（load は来ない）
import { createGlobe, Marker as OrthoMarker, Popup as OrthoPopup } from "../globe.ts";
import { mercatorDz } from "../zoomscale.ts";   // "mercator" の目盛り（view を組む dz）＝正典は zoomscale.js（globe.js の root export ではない・2.0.0）
import { LngLat, LngLatBounds, MercatorCoordinate, FreeCameraOptions, orientationFromPitchBearing, pitchBearingRollFromOrientation } from "./geo.ts";
import { unsupported } from "./report.ts";
import { lngArr, boundsArr, camOpts, viewOf } from "./util.ts";
import { GRANULARITY_GLOBE } from "./tilemesh.ts";
import type { GlobeMap } from "../types/map.ts";
import type { GlobeOptions, HandlerName, MarkerOptions, PopupOptions } from "../../globe.d.ts";
import type { LngLatLike, LngLatBoundsLike } from "./geo.ts";

/** エンジンの地図（createGlobe の戻り） */
type Engine = GlobeMap;
/** MapLibre の事象（type・target＋中身） */
type MlEvent = { type: string; target: object; [k: string]: unknown };
type Listener = (this: unknown, ev: MlEvent) => void;
/** 画面の点（MapLibre の PointLike） */
type XY = { x: number; y: number };
type PointLike = XY | [number, number];
/** queryRenderedFeatures の幾何（点・箱） */
type QueryGeom = PointLike | [PointLike, PointLike];
/** エンジンへ渡す幾何（点＝[x,y]・箱＝[[x,y],[x,y]]・undefined＝画面全体） */
type SyncGeom = number[] | number[][] | undefined;
type QueryOpts = { layers?: string[]; filter?: unknown; [k: string]: unknown };
type Rendered = Awaited<ReturnType<Engine["queryRenderedFeatures"]>>;
interface SyncJob { next: { g: SyncGeom; o: QueryOpts; cam: string } | null }
interface SyncQ { cache: globalThis.Map<string, { g: SyncGeom; cam: string; result: Rendered; t: number }>; pending: globalThis.Map<string, SyncJob>; armed: boolean }
interface CamAngles { zoom: number; bearing: number; pitch: number; roll: number }
interface LayerSub { type: string; layer: string | string[]; fn: Listener | undefined; w: (e: { lngLat?: LngLatLike | null }) => void }
/** カメラの指定（MapLibre の CameraOptions・center は LngLatLike） */
type CamIn = { center?: LngLatLike | null; zoom?: number; bearing?: number; pitch?: number; roll?: number; [k: string]: unknown };
/** addLayer の層（MapLibre の層・custom 層） */
type LayerIn = { id?: string; type?: string; source?: unknown; renderingMode?: string; url?: unknown; [k: string]: unknown };
/** 動く記号の画素（画素の列・または renderWithWebGL） */
interface AnimData { length?: number; renderWithWebGL?(o: { gl: WebGL2RenderingContext; texture: WebGLTexture | null; x: number; y: number; width: number; height: number }): void }
/** addImage の画像（画素の列・ImageBitmap 等・動く記号＝MapLibre の StyleImageInterface） */
interface AnimImage { width: number; height: number; data?: AnimData; render?(): unknown; onAdd?(map: Map, id: string): void; onRemove?(): void }
type ImageOpts = Parameters<Engine["addImage"]>[2];
/** 操作部品（MapLibre の IControl） */
export interface IControl { onAdd(map: Map): HTMLElement; onRemove?(map: Map): void; getDefaultPosition?(): string; _interleaved?: boolean; _props?: unknown; setProps?: unknown }
/** new Map(options)（MapLibre の MapOptions の読む分＋ortho＝この地図の起動オプションへの逃げ道） */
export interface MapOptions {
	container?: string | HTMLElement; style?: GlobeOptions["style"]; center?: LngLatLike; zoom?: number; bearing?: number; pitch?: number; roll?: number;
	minZoom?: number; maxZoom?: number; maxPitch?: number; bounds?: LngLatBoundsLike; maxBounds?: LngLatBoundsLike; fitBoundsOptions?: object;
	interactive?: boolean; cooperativeGestures?: boolean; centerClampedToGround?: boolean; elevation?: number; attributionControl?: boolean;
	maplibreLogo?: boolean; hash?: unknown; renderWorldCopies?: boolean; transformRequest?: GlobeOptions["transformRequest"];
	ortho?: GlobeOptions;
	[k: string]: unknown;
}
/** 通訳の地図の状態（WeakMap の中身＝エンジンの map に鍵を生やさない） */
interface MlState {
	options: MapOptions; container: HTMLElement; engine: Engine | null; loaded: boolean; idle: boolean; inert: boolean;
	queue: Array<() => unknown>; engineFns: Array<(eng: Engine) => void>; ev: globalThis.Map<string, Set<Listener>>; dom: Set<string>;
	layerSubs: LayerSub[]; sources: Set<string>; controls: globalThis.Map<IControl, HTMLElement>; corners: Record<string, HTMLElement> | null;
	last: CamAngles | null; raf: number; projection: string; init: { center: LngLat; zoom: number; bearing: number; pitch: number; roll: number };
	ready?: Promise<Engine | null>; handlerInit?: Record<string, boolean>; handlers?: Record<string, object>; dz?: number; down?: number[];
	sq?: SyncQ; customHost?: boolean; anim?: globalThis.Map<string, { img: AnimImage; tick: () => void; stop: () => void }>; placeholder?: HTMLCanvasElement;
	dbg?: { tileBoundaries?: boolean; padding?: boolean; collision?: boolean; overdraw?: boolean; vertices?: boolean }; repaint?: boolean; anisoPitch?: number;
	eventedParent?: { parent: unknown; data: unknown } | null;
}

// MapLibre GL JS 6.11.2 の Map の公開の口（型定義から）。ここに実装の無い口は「unsupported を記録して this」を返す
const ML_METHODS = new Set(["addControl", "addImage", "addLayer", "addSource", "addSprite", "areTilesLoaded", "calculateAnchoredCameraOptions", "calculateCameraOptionsFromCameraLngLatAltRotation", "calculateCameraOptionsFromTo", "cameraForBounds", "coveringTiles", "easeTo", "fire", "fitBounds", "fitScreenCoordinates", "flyTo", "getAnisotropicFilterPitch", "getBearing", "getBounds", "getCameraTargetElevation", "getCanvas", "getCanvasContainer", "getCenter", "getCenterClampedToGround", "getCenterElevation", "getContainer", "getFeatureState", "getFilter", "getFontFaces", "getGlobalState", "getGlyphs", "getImage", "getLayer", "getLayersOrder", "getLayoutProperty", "getLight", "getMaxBounds", "getMaxPitch", "getMaxZoom", "getMinPitch", "getMinZoom", "getPadding", "getPaintProperty", "getPitch", "getPixelRatio", "getProjection", "getRenderWorldCopies", "getRoll", "getSky", "getSource", "getSprite", "getStyle", "getStyleUrl", "getTerrain", "getVerticalFieldOfView", "getZoom", "getZoomSnap", "hasControl", "hasImage", "isMoving", "isRotating", "isSourceLoaded", "isStyleLoaded", "isZooming", "jumpTo", "listImages", "listens", "loadImage", "loaded", "moveLayer", "off", "on", "once", "panBy", "panTo", "project", "queryRenderedFeatures", "querySourceFeatures", "queryTerrainElevation", "redraw", "refreshTiles", "remove", "removeControl", "removeFeatureState", "removeImage", "removeLayer", "removeSource", "removeSprite", "repaint", "resetNorth", "resetNorthPitch", "resize", "rotateTo", "setAnisotropicFilterPitch", "setBearing", "setCenter", "setCenterClampedToGround", "setCenterElevation", "setEventedParent", "setFeatureState", "setFilter", "setFontFaces", "setGlobalStateProperty", "setGlyphs", "setLayerZoomRange", "setLayoutProperty", "setLight", "setMaxBounds", "setMaxPitch", "setMaxZoom", "setMinPitch", "setMinZoom", "setPadding", "setPaintProperty", "setPitch", "setPixelRatio", "setProjection", "setRenderWorldCopies", "setRoll", "setSky", "setSourceTileLodParams", "setSprite", "setStyle", "setTerrain", "setTransformCameraUpdate", "setTransformConstrain", "setTransformRequest", "setVerticalFieldOfView", "setZoom", "setZoomSnap", "showCollisionBoxes", "showOverdrawInspector", "showPadding", "showTileBoundaries", "snapToNorth", "stop", "triggerRepaint", "unproject", "updateImage", "version", "vertices", "zoomIn", "zoomOut", "zoomTo"]);
const HANDLERS = ["scrollZoom", "boxZoom", "dragRotate", "dragPan", "keyboard", "doubleClickZoom", "touchZoomRotate", "touchPitch", "cooperativeGestures"];
// 事象：エンジンの事象から作る物／容れ物の DOM から作る物（点と経緯度は公開の unproject）
const ENGINE_EVENTS = new Set(["load", "style.load", "styledata", "data", "sourcedata", "idle", "error", "resize", "remove", "render", "styleimagemissing",
	"move", "movestart", "moveend", "zoom", "zoomstart", "zoomend", "rotate", "rotatestart", "rotateend", "pitch", "pitchstart", "pitchend", "roll", "rollstart", "rollend", "dragstart", "drag", "dragend", "boxzoomstart", "boxzoomend", "boxzoomcancel", "cooperativegestureprevented"]);
const DOM_EVENTS = new Set(["click", "dblclick", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "contextmenu", "wheel", "touchstart", "touchend", "touchmove", "touchcancel"]);
const LAYER_EVENTS = new Set(["click", "mousemove", "mouseenter", "mouseleave", "mousedown", "mouseup", "touchstart", "touchend", "dblclick", "contextmenu"]);   // C8＝押し系も（エンジンの同期当たり・preventDefault でパン止め）   // エンジンが層ごとに持つ事象（#34）

const S = new WeakMap<object, MlState>();   // 通訳の地図（と Proxy）→ 状態
let liveMaps = 0;


// 通訳の地図の中のエンジンの地図（公式例の門の走らせ台だけが使う＝index.js からは出さない）
export const engineOf = (map: object): Engine | null => S.get(map)?.engine ?? null;
export const whenEngine = (map: object): Promise<Engine | null> => S.get(map)?.ready ?? Promise.resolve(null);

function emit(self: object, type: string, props: object = {}): void {
	const st = S.get(self)!, set = st.ev.get(type);
	if (!set || !set.size) return;
	const ev = { type, target: self, ...props };
	for (const fn of [...set]) {
		try { fn.call(self, ev); } catch (e) { queueMicrotask(() => { throw e; }); }   // 聞き手の例外は MapLibre と同じく握りつぶさない（頁の未捕捉の例外になる）
	}
}
const fail = (self: object, name: string, e: unknown): void => { console.error(`[mlshim] ${name}:`, (e as Error | null)?.message ?? e); emit(self, "error", { error: e instanceof Error ? e : new Error(String(e)) }); };

// エンジンへ渡す。準備前は列に溜めて before を返す。Promise を返す口は待たずに this（失敗は error 事象）
function ask<R = unknown>(self: object, name: string, args: unknown[], { before, conv, then }: { before?: R; conv?: (r: unknown) => R; then?: () => void } = {}): R {
	const st = S.get(self)!;
	if (st.inert) return before as R;
	const run = (): R => {
		let r: unknown;
		try {   // 名前で引く口は関数の時だけ呼ぶ（CodeQL の動的呼び出し＝関数でなければ素の呼び出しと同じ TypeError）
			const fn = (st.engine as unknown as Record<string, unknown>)[name];
			if (typeof fn !== "function") throw new TypeError("st.engine[name] is not a function");
			r = fn.apply(st.engine, args);
		} catch (e) { fail(self, name, e); return before as R; }
		if (r && typeof (r as PromiseLike<unknown>).then === "function") { (r as PromiseLike<unknown>).then(() => then?.(), e => fail(self, name, e)); return self as R; }
		then?.();
		return conv ? conv(r) : r as R;
	};
	if (st.engine && st.loaded) return run();
	st.queue.push(run);
	return before as R;
}
const onEngine = (st: MlState, fn: (eng: Engine) => void): void => { if (st.engine) fn(st.engine); else st.engineFns.push(fn); };

// 容れ物の DOM の事象（素の click／mousemove…）＝点は容れ物の左上原点・経緯度は公開の unproject。click はドラッグの後には出さない（3px）
function domEvent(self: Map, st: MlState, type: string, e: MouseEvent | TouchEvent) {
	const r = st.container.getBoundingClientRect(), src = ((e as TouchEvent).touches?.[0] || (e as TouchEvent).changedTouches?.[0] || e) as { clientX: number; clientY: number };
	const point = { x: src.clientX - r.left, y: src.clientY - r.top };
	const ll = st.engine?.unproject([point.x, point.y]);
	let prevented = false;
	return { type, target: self, originalEvent: e, point, lngLat: ll ? new LngLat(ll.lng, ll.lat) : null,
		preventDefault() { prevented = true; }, get defaultPrevented() { return prevented; } };
}
function bindDom(self: Map, st: MlState, type: string): void {
	if (st.dom.has(type)) return;
	st.dom.add(type);
	const src = type === "mouseover" ? "mouseenter" : type === "mouseout" ? "mouseleave" : type;
	if (type === "click" || type === "mousedown") st.container.addEventListener("mousedown", e => { st.down = [e.clientX, e.clientY]; }, true);
	st.container.addEventListener(src, e => {
		if (type === "click" && st.down && Math.hypot((e as MouseEvent).clientX - st.down[0], (e as MouseEvent).clientY - st.down[1]) > 3) return;
		emit(self, type, domEvent(self, st, type, e as MouseEvent));
	});
}

// 同期の queryRenderedFeatures の道具（C7）。幾何＝undefined（画面全体）｜{x,y}／[x,y]（点）｜[a, b]（箱）
const syncGeom = (g: QueryGeom | null | undefined): SyncGeom => { if (g == null) return undefined; if (!Array.isArray(g)) return [g.x, g.y]; if (typeof g[0] === "number") return [g[0], g[1] as number]; const a = Array.isArray(g[0]) ? g[0] : [g[0].x, g[0].y], b = Array.isArray(g[1]) ? g[1] : [(g[1] as XY).x, (g[1] as XY).y]; return [a, b]; };
const syncKey = (o: QueryOpts): string => (o.layers ? [...o.layers].sort().join(",") : "") + (o.filter != null ? "|" + JSON.stringify(o.filter) : "");
const camSig = (eng: Engine): string => { const c = eng.getCenter(); return `${eng.getZoom().toFixed(4)}|${c.lng.toFixed(6)}|${c.lat.toFixed(6)}|${eng.getBearing().toFixed(2)}|${eng.getPitch().toFixed(2)}`; };
const syncMatch = (a: SyncGeom, b: SyncGeom): boolean => {
	if (a === undefined || b === undefined) return a === b;
	const pa = typeof a[0] === "number", pb = typeof b[0] === "number";
	if (pa !== pb) return false;
	if (pa) return Math.hypot((a as number[])[0] - (b as number[])[0], (a as number[])[1] - (b as number[])[1]) <= 8;
	return Math.abs((a as number[][])[0][0] - (b as number[][])[0][0]) <= 2 && Math.abs((a as number[][])[0][1] - (b as number[][])[0][1]) <= 2 && Math.abs((a as number[][])[1][0] - (b as number[][])[1][0]) <= 2 && Math.abs((a as number[][])[1][1] - (b as number[][])[1][1]) <= 2;
};
// 裏で走らせる（鍵ごとに 1 本＝走っている間に来た物は最新の 1 つだけ覚えて続けて走らせる）
function syncKick(st: MlState, key: string, g: SyncGeom, o: QueryOpts, cam: string): void {
	const q = st.sq!, p = q.pending.get(key);
	if (p) { p.next = { g, o, cam }; return; }
	const job: SyncJob = { next: null }; q.pending.set(key, job);
	const run = (g2: SyncGeom, o2: QueryOpts, cam2: string): Promise<void> => Promise.resolve().then(() => st.engine!.queryRenderedFeatures(g2 as Parameters<Engine["queryRenderedFeatures"]>[0], { ...o2 } as Parameters<Engine["queryRenderedFeatures"]>[1])).then(r => { q.cache.set(key, { g: g2, cam: cam2, result: r, t: performance.now() }); }, () => {}).then(() => {
		if (job.next) { const n = job.next; job.next = null; return run(n.g, n.o, n.cam); }
		q.pending.delete(key);
	});
	run(g, o, cam);
}
function armPrewarm(self: Map, st: MlState): void {
	let raf = 0, last: number[] | null = null;
	st.container.addEventListener("mousemove", e => {
		const r = st.container.getBoundingClientRect(); last = [e.clientX - r.left, e.clientY - r.top];
		if (raf) return;
		raf = requestAnimationFrame(() => { raf = 0; if (st.engine && last) syncKick(st, "", last, {}, camSig(st.engine)); });
	}, { passive: true });
}

// エンジンの事象 → MapLibre の事象（move は zoom/rotate/pitch に分け、start/end を付ける＝end はエンジンの settle）
function wireEngine(self: Map, st: MlState): void {
	const eng = st.engine!;
	let moving: { from: CamAngles; zoom: boolean; rotate: boolean; pitch: boolean; roll: boolean } | null = null, dragArm = false, dragging = false;
	// drag 系（MapLibre の dragstart／drag／dragend＝指やマウスで掴んで動かしている間の move）：容れ物の pointerdown で構え、エンジンの move が来たら drag・離したら dragend（deck.gl の MapboxOverlay が購読する・2026-09-30）
	const dragEnd = (): void => { dragArm = false; if (dragging) { dragging = false; emit(self, "dragend"); } };
	st.container.addEventListener("pointerdown", e => { if (e.button === 0 || e.pointerType !== "mouse") dragArm = true; }, { passive: true });
	for (const t of ["pointerup", "pointercancel"]) window.addEventListener(t, dragEnd, { passive: true });
	eng.on("move", e => {
		st.idle = false;
		const c = { zoom: eng.getZoom(), bearing: eng.getBearing(), pitch: eng.getPitch(), roll: eng.getRoll() };
		if (!moving) { moving = { from: st.last ?? c, zoom: false, rotate: false, pitch: false, roll: false }; emit(self, "movestart"); }
		if (dragArm) { if (!dragging) { dragging = true; emit(self, "dragstart"); } emit(self, "drag"); }
		const p = st.last ?? moving.from;
		for (const [k, name] of [["zoom", "zoom"], ["bearing", "rotate"], ["pitch", "pitch"], ["roll", "roll"]] as Array<[keyof CamAngles, "zoom" | "rotate" | "pitch" | "roll"]>) {
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
		for (const name of ["zoom", "rotate", "pitch"] as const) if (m[name]) emit(self, `${name}end`);
		emit(self, "moveend");
	});
	(eng as Engine & { on(ev: "styleimagemissing", cb: (e: { id: string }) => void): Engine }).on("styleimagemissing", e => emit(self, "styleimagemissing", { id: e.id }));   // 記号帳に無い名前（名前ごとに 1 回）
	eng.on("sourcedata", e => { if (st.sources.has(e.sourceId)) self._sourceLoaded(e.sourceId); });   // C8＝setData／層が載った合図（エンジンの sourcedata）を sourcedata/data（isSourceLoaded:true）に
	eng.on("boxzoomstart", () => emit(self, "boxzoomstart"));
	eng.on("boxzoomend", e => emit(self, "boxzoomend", { boxZoomBounds: new LngLatBounds([e.bbox[0], e.bbox[1]], [e.bbox[2], e.bbox[3]]) }));   // MapLibre の boxzoomend＝boxZoomBounds（例 select-features-with-boxzoomend-callback）
	eng.on("boxzoomcancel", () => emit(self, "boxzoomcancel"));
	eng.on("cooperativegestureprevented", e => emit(self, "cooperativegestureprevented", { gestureType: e.kind === "touch" ? "touch_pan" : "wheel_zoom" }));
	eng.on("idle", () => {
		st.idle = true;
		for (const id of st.sources) { emit(self, "sourcedata", { dataType: "source", sourceId: id, isSourceLoaded: true, sourceDataType: "idle" }); emit(self, "data", { dataType: "source", sourceId: id, isSourceLoaded: true }); }
		emit(self, "idle");
	});
	if (typeof ResizeObserver === "function") new ResizeObserver(() => emit(self, "resize")).observe(st.container);
}

const TRAP: ProxyHandler<Map> = {
	get(t, p, r) {
		if (p in t) return Reflect.get(t, p, r);
		if (typeof p === "string" && ML_METHODS.has(p)) return (...a: unknown[]) => { unsupported(r, `${p}()`); return /^(get|is|query|calculate|covering)/.test(p) ? undefined : r; };
		return undefined;
	},
};

export class Map {
	constructor(options: MapOptions = {}) {
		const container = typeof options.container === "string" ? document.getElementById(options.container) : options.container;
		if (!container) throw new Error(`Container '${options.container}' not found.`);
		const st: MlState = { options, container, engine: null, loaded: false, idle: false, inert: false, queue: [], engineFns: [], ev: new globalThis.Map(), dom: new Set(),
			layerSubs: [], sources: new Set(), controls: new globalThis.Map(), corners: null, last: null, raf: 0, projection: (options.style as { projection?: { type?: string } } | undefined)?.projection?.type === "globe" ? "globe" : "mercator",   // style の projection（object の style）も申告に数える
			init: { center: LngLat.convert(options.center ?? [0, 0]), zoom: options.zoom ?? 0, bearing: options.bearing ?? 0, pitch: options.pitch ?? 0, roll: options.roll ?? 0 } };
		const self = new Proxy(this, TRAP);
		S.set(this, st); S.set(self, st);
		// 操作ハンドラ（scrollZoom.disable()・touchZoomRotate.disableRotation() …）＝エンジンの handler の旗を叩く実体（A2・2026-10-12。旧＝記録だけ）。
		// touchZoomRotate.enableRotation/disableRotation＝旗 touchRotate。isActive は false（掴んでいる最中の判定は持たない）
		const flag = (h: string, k: string): string => h === "touchZoomRotate" && /Rotation$/.test(k) ? "touchRotate" : h;
		const handler = (h: string): object => new Proxy({}, { get: (o, k) => typeof k !== "string" ? undefined
			: k === "isEnabled" ? () => (st.engine ? st.engine.handlerOn(h as HandlerName) : st.handlerInit![h] !== false)
			: k === "isActive" ? () => false
			: /^(enable|disable)/.test(k) ? () => { const on = /^enable/.test(k), f = flag(h, k); st.handlerInit![f] = on; onEngine(st, eng => eng.setHandler(f as HandlerName, on)); return undefined; }
			: () => { unsupported(self, `${h}.${k}()`, "cosmetic"); return undefined; } });
		st.handlerInit = Object.fromEntries(HANDLERS.map(h => [h, options[h] !== false && options.interactive !== false]));
		st.handlerInit.touchRotate = st.handlerInit.touchZoomRotate;
		st.handlerInit.cooperativeGestures = !!options.cooperativeGestures;
		st.handlers = Object.fromEntries(HANDLERS.map(h => [h, handler(h)]));
		if (liveMaps++ > 3) { liveMaps--; st.inert = true; unsupported(self, "fifth Map on the page (at most four live maps)"); return self; }   // 1 頁に 4 枚まで（#173 の裁定 2 枚→2026-09-30 本人「4 枚まで」＝sync-movement-of-multiple-maps の 3 枚が生きる。GL の文脈は 1 枚 2 本＝8 本 < 16）
		if (options.maplibreLogo) unsupported(self, "option maplibreLogo", "cosmetic");
		if (options.hash) unsupported(self, "option hash", "cosmetic");
		if (options.renderWorldCopies === false) unsupported(self, "option renderWorldCopies: false (the globe has no world copies)", "cosmetic");
		st.dz = (options.ortho?.zoomScale ?? "mercator") === "mercator" ? mercatorDz(st.init.center.lat) : 1;   // 公開の z とエンジンの z の差（setTransformConstrain の往復に）
		const o = {
			// 目盛り＝"mercator"（MapLibre のメルカトルの縮尺＝起動の中心緯度で log2(sec φ) 寄る・style は MapLibre の z で評価）。options.ortho.zoomScale で "maplibre"（一律 +1）にもできる
			target: container, view: viewOf(st.init, (options.ortho?.zoomScale ?? "mercator") === "mercator" ? mercatorDz(st.init.center.lat) : 1), zoomScale: "mercator",
			night: false, sky: false, coastline: false, terrain: false, fog: false, chips: false, countryTip: false, persistView: false,   // fog:false＝MapLibre は霧を持たない（遠くの建物・地形が地の色へ溶けない・2026-09-30）
			centerElevation: options.centerClampedToGround === false ? +(options.elevation ?? 0) : "ground",   // 注視点の高さ＝MapLibre の centerClampedToGround（既定＝地形の上の中心点）／false＋elevation＝固定（2026-09-30）
			ellipsoid: false,   // 表示の形は球に固定（#43・2026-09-28 本人裁定）＝MapLibre の地球儀と同じ（楕円体はデスクトップの既定だが、ここは「同じ絵」が物差し）。options.ortho.ellipsoid で変えられる・?ell=1 は URL が勝つ
			instruments: options.attributionControl === false ? false : ["attr"],
			style: options.style ?? { version: 8, sources: {}, layers: [] },   // style 無しの Map＝空の style（MapLibre と同じく後から setStyle できる・エンジンは起動時の style が要る）
			...(options.maxZoom != null && { zoomMax: options.maxZoom }),
			handlers: st.handlerInit, interactive: options.interactive, cooperativeGestures: !!options.cooperativeGestures,   // 手触りの旗（A2）
			maxPitch: options.maxPitch ?? 85,   // MapLibre の既定は 60・この口の既定は 85（MapLibre 6.x が許す 180 の手前・地平線まで見せる・2026-10-12 本人裁定 A1）。ortho の口（createGlobe）の既定 75 は変えない
			...(options.transformRequest && { transformRequest: options.transformRequest }),
			...options.ortho,   // この地図の起動オプションへの逃げ道（夜面・星空を点ける・時計を止める…）
		} as GlobeOptions;   // TODO(ts): fog（globe.js が読む）が公開の GlobeOptions に無い＝注釈でなく as
		st.ready = createGlobe(o).then(async eng => {
			st.engine = eng;
			wireEngine(self, st);
			if (options.cooperativeGestures) {   // MapLibre の協調モードの案内（.maplibregl-cooperative-gesture-screen 相当・修飾キー無しのホイール／1 本指で 1 秒出す）
				const mac = /Mac|iPhone|iPad/.test(navigator.platform), txt = { wheel: `Use ${mac ? "⌘" : "Ctrl"} + scroll to zoom the map`, touch: "Use two fingers to move the map" };
				const scr = document.createElement("div"); scr.className = "maplibregl-cooperative-gesture-screen";
				Object.assign(scr.style, { position: "absolute", inset: "0", display: "none", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,.4)", color: "#fff", font: "20px/1.4 sans-serif", textAlign: "center", pointerEvents: "none", zIndex: 99 });
				container.appendChild(scr); let t = 0;
				eng.on("cooperativegestureprevented", e => { scr.textContent = txt[e.kind] || txt.wheel; scr.style.display = "flex"; clearTimeout(t); t = setTimeout(() => { scr.style.display = "none"; }, 1000); });
			}
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
			const cam = Object.fromEntries(["center", "zoom", "bearing", "pitch"].filter(k => (sty as Record<string, unknown> | null)?.[k] != null).map(k => [k, (sty as Record<string, unknown>)[k]]));
			if (Object.keys(cam).length) eng.jumpTo(cam as Parameters<Engine["jumpTo"]>[0]);
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
	on(type: string, layerOrFn: string | string[] | Listener, fn?: Listener): this {
		const st = S.get(this)!;
		if (typeof layerOrFn === "function") {
			if (!st.ev.has(type)) st.ev.set(type, new Set());
			st.ev.get(type)!.add(layerOrFn);
			if (DOM_EVENTS.has(type)) bindDom(this, st, type);
			else if (type === "render") this._render(st);
			else if (!ENGINE_EVENTS.has(type)) unsupported(this, `on("${type}")`);
			return this;
		}
		if (!LAYER_EVENTS.has(type)) { unsupported(this, `on("${type}", layerId)`); return this; }
		const sub: LayerSub = { type, layer: layerOrFn, fn, w: e => fn!.call(this, { ...e, type, target: this, lngLat: e.lngLat ? LngLat.convert(e.lngLat) : e.lngLat }) };
		st.layerSubs.push(sub);
		onEngine(st, eng => eng.on(type as "click", sub.layer, sub.w));
		return this;
	}
	off(type: string, layerOrFn?: string | string[] | Listener, fn?: Listener): this {
		const st = S.get(this)!;
		if (typeof layerOrFn === "function") { st.ev.get(type)?.delete(layerOrFn); return this; }
		const i = st.layerSubs.findIndex(s => s.type === type && s.fn === fn && String(s.layer) === String(layerOrFn));
		if (i >= 0) { const [s] = st.layerSubs.splice(i, 1); onEngine(st, eng => eng.off(type as "click", s.layer, s.w)); }
		return this;
	}
	once(type: string, layerOrFn?: string | string[] | Listener | null, fn?: Listener): this | Promise<unknown> {
		const layer = typeof layerOrFn === "function" || layerOrFn == null ? null : layerOrFn, cb = typeof layerOrFn === "function" ? layerOrFn : fn;
		if (!cb) return new Promise(res => this.once(type, ...((layer ? [layer] : []) as [(string | string[])?]), res));
		const w = (e: MlEvent): void => { layer ? this.off(type, layer, w) : this.off(type, w); cb.call(this, e); };
		return layer ? this.on(type, layer, w) : this.on(type, w);
	}
	listens(type: string): boolean { return !!S.get(this)!.ev.get(type)?.size; }
	fire(ev: string | { type: string; [k: string]: unknown }, props?: object): this { const type = typeof ev === "string" ? ev : ev.type; emit(this, type, { ...(typeof ev === "object" ? ev : {}), ...props }); return this; }
	_render(st: MlState): void {
		if (st.raf) return;
		const tick = (): void => { st.raf = st.ev.get("render")?.size ? requestAnimationFrame(tick) : 0; if (st.loaded) emit(this, "render"); };
		st.raf = requestAnimationFrame(tick);
	}

	// ── カメラ ──
	getCenter(): LngLat { const st = S.get(this)!; if (!st.engine) return st.init.center; const c = st.engine.getCenter(); return new LngLat(c.lng, c.lat); }
	getZoom(): number { const st = S.get(this)!; return st.engine ? st.engine.getZoom() : st.init.zoom; }
	getBearing(): number { const st = S.get(this)!; return st.engine ? st.engine.getBearing() : st.init.bearing; }
	getPitch(): number { const st = S.get(this)!; return st.engine ? st.engine.getPitch() : st.init.pitch; }
	getRoll(): number { const st = S.get(this)!; return st.engine ? st.engine.getRoll() : st.init.roll; }
	setRoll(r: number, e?: unknown): this { return this.jumpTo({ roll: r }, e); }
	getVerticalFieldOfView() { return ask(this, "getVerticalFieldOfView", [], { before: 50 }); }   // エンジンの既定 50°（MapLibre は 36.87°＝絵の奥行きの差は §4）
	setVerticalFieldOfView(deg: number): this { ask(this, "setVerticalFieldOfView", [deg]); return this; }
	setCenter(c: LngLatLike, e?: unknown): this { return this.jumpTo({ center: c }, e); }
	setZoom(z: number, e?: unknown): this { return this.jumpTo({ zoom: z }, e); }
	setBearing(b: number, e?: unknown): this { return this.jumpTo({ bearing: b }, e); }
	setPitch(p: number, e?: unknown): this { return this.jumpTo({ pitch: p }, e); }
	jumpTo(o: CamIn, eventData?: unknown): this;
	jumpTo(o: CamIn): this { ask(this, "jumpTo", [camOpts(o)]); return this; }
	easeTo(o: CamIn): this { ask(this, "easeTo", [camOpts(o)]); return this; }
	flyTo(o: CamIn): this { ask(this, "flyTo", [camOpts(o)]); return this; }
	panTo(c: LngLatLike, o?: CamIn): this { return this.easeTo({ ...o, center: c }); }
	panBy(off: PointLike, o?: CamIn): this {
		const st = S.get(this)!, [dx, dy] = Array.isArray(off) ? off : [off.x, off.y];
		const r = st.container.getBoundingClientRect(), c = this.unproject([r.width / 2 + dx, r.height / 2 + dy]);
		return c ? this.easeTo({ ...o, center: c }) : this;
	}
	zoomTo(z: number, o?: CamIn): this { return this.easeTo({ ...o, zoom: z }); }
	zoomIn(o?: CamIn): this { return this.easeTo({ ...o, zoom: this.getZoom() + 1 }); }
	zoomOut(o?: CamIn): this { return this.easeTo({ ...o, zoom: this.getZoom() - 1 }); }
	rotateTo(b: number, o?: CamIn): this { return this.easeTo({ ...o, bearing: b }); }
	resetNorth(o?: CamIn): this { return this.easeTo({ duration: 1000, ...o, bearing: 0 }); }
	resetNorthPitch(o?: CamIn): this { return this.easeTo({ duration: 1000, ...o, bearing: 0, pitch: 0 }); }
	snapToNorth(o?: CamIn): this { return Math.abs(this.getBearing()) < 7 ? this.resetNorth(o) : this; }
	fitBounds(b: LngLatBoundsLike, o: object = {}): this { ask(this, "fitBounds", [boundsArr(b), o]); return this; }
	cameraForBounds(b: LngLatBoundsLike, o?: object) { const c = ask<{ center?: number[]; [k: string]: unknown } | null | undefined>(this, "cameraForBounds", [boundsArr(b), o]); return c && c.center ? { ...c, center: new LngLat(c.center[0], c.center[1]) } : c; }
	getBounds(): LngLatBounds { const b = ask<number[] | null | undefined>(this, "getBounds", []); return b ? new LngLatBounds([b[0], b[1]], [b[2], b[3]]) : new LngLatBounds(); }
	setMaxBounds(b?: LngLatBoundsLike | null): this { ask(this, "setMaxBounds", [b ? boundsArr(b) : null]); return this; }
	getMaxBounds(): LngLatBounds | null { const b = ask<number[] | null | undefined>(this, "getMaxBounds", []); return b ? new LngLatBounds([b[0], b[1]], [b[2], b[3]]) : null; }
	setMinZoom(z: number | null): this { ask(this, "setMinZoom", [z]); return this; }
	getMinZoom() { return ask(this, "getMinZoom", [], { before: 0 }); }
	setMaxZoom(z: number | null): this { ask(this, "setMaxZoom", [z]); return this; }
	getMaxZoom() { return ask(this, "getMaxZoom", [], { before: 22 }); }
	setMaxPitch(p: number | null): this { ask(this, "setMaxPitch", [p]); return this; }
	getMaxPitch() { return ask(this, "getMaxPitch", [], { before: 85 }); }
	setPadding(p: unknown): this { ask(this, "setPadding", [p]); return this; }
	getPadding() { return ask(this, "getPadding", [], { before: { top: 0, bottom: 0, left: 0, right: 0 } }); }
	fitScreenCoordinates(p0: PointLike, p1: PointLike, bearing: number, o: object = {}): this { const xy = (p: PointLike): number[] => Array.isArray(p) ? p : [p.x, p.y]; ask(this, "fitScreenCoordinates", [xy(p0), xy(p1), bearing, o]); return this; }
	// 注視点の高さ（A3・2026-10-12）＝エンジンの centerElevation を実行時に
	setCenterClampedToGround(b: boolean): this { ask(this, "setCenterClampedToGround", [!!b]); return this; }
	getCenterClampedToGround(): boolean { return !!ask(this, "getCenterClampedToGround", [], { before: S.get(this)!.options.centerClampedToGround !== false }); }
	setCenterElevation(m: number): this { ask(this, "setCenterElevation", [m]); return this; }
	getCenterElevation(): number { return ask(this, "getCenterElevation", [], { before: 0 }) ?? 0; }
	getCameraTargetElevation(): number { return this.getCenterElevation(); }
	// 可動域の自作（MapLibre 同名・A3）：fn(LngLat, zoom) → { center, zoom }（MapLibre の z）。エンジンの口はエンジンの z＝dz を往復させる
	setTransformConstrain(fn?: ((center: LngLat, zoom: number) => { center?: LngLatLike | null; zoom?: number | null } | null | undefined) | null): this {
		const st = S.get(this)!, dz = st.dz ?? 1;
		ask(this, "setConstrain", [typeof fn === "function" ? (v: { center: number[]; zoom: number }) => { const r = fn(new LngLat(v.center[0], v.center[1]), v.zoom - dz); return r ? { center: r.center != null ? lngArr(r.center) : undefined, zoom: r.zoom != null ? r.zoom + dz : undefined } : null; } : null]);
		return this;
	}
	// 自由カメラ（MapLibre 同名・A3）：位置＝目の経緯度と高さ（MercatorCoordinate）・向き＝四元数（geo.js の約束）。set は位置と向きから center/zoom/pitch/bearing/roll へ分解して jumpTo
	getFreeCameraOptions(): FreeCameraOptions {
		const st = S.get(this)!, eng = st.engine;
		if (!eng) return new FreeCameraOptions(MercatorCoordinate.fromLngLat(st.init.center, 0), orientationFromPitchBearing(st.init.pitch, st.init.bearing, st.init.roll));
		const e = eng.view.eye as { lon: number; lat: number; altM: number };
		return new FreeCameraOptions(MercatorCoordinate.fromLngLat([e.lon, e.lat], e.altM), orientationFromPitchBearing(eng.getPitch(), eng.getBearing(), eng.getRoll()));
	}
	setFreeCameraOptions(o?: FreeCameraOptions | null): this {
		if (!o || !o.position) return this;
		const ll = o.position.toLngLat(), alt = o.position.toAltitude();
		const pbr = o.orientation ? pitchBearingRollFromOrientation(o.orientation) : { pitch: this.getPitch(), bearing: this.getBearing(), roll: this.getRoll() };
		return this.jumpTo(this.calculateCameraOptionsFromCameraLngLatAltRotation(ll, alt, pbr.bearing, pbr.pitch, pbr.roll));
	}
	// MapLibre 同名（6.x・例 walk-around-a-map-in-first-person）＝目の経緯度・高さ［m］・方位・チルト・roll → 地面の注視点と zoom（純粋な計算・MapLibre の cameraToCenterDistance＝0.5/tan(fov/2)·高さ px・fov 36.87°）。
	// pitch が 89° を超える（地面を見ない）時は注視点＝目の真下の点を目の高さに置く（elevation＝alt）
	calculateCameraOptionsFromCameraLngLatAltRotation(cameraLngLat: LngLatLike, cameraAlt: number, bearing: number, pitch: number, roll = 0) {
		const c = LngLat.convert(cameraLngLat), H = S.get(this)!.container?.clientHeight || 600, fov = 36.86989764584402 * Math.PI / 180, c2c = 0.5 / Math.tan(fov / 2) * H;
		const R = 6371008.8, p = Math.max(0, Math.min(89, pitch)) * Math.PI / 180, alt = Math.max(1, +cameraAlt || 0);
		if (pitch > 89) {   // 地平線より上＝注視点は目の高さの先（距離は目の高さ分）
			const zoom = Math.log2(c2c * 2 * Math.PI * R * Math.cos(c.lat * Math.PI / 180) / (512 * alt));
			return { center: new LngLat(c.lng, c.lat), elevation: alt, zoom, bearing, pitch, roll };
		}
		const hor = alt * Math.tan(p), dist = alt / Math.cos(p);   // 地面までの水平距離・直線距離［m］
		const d = hor / R, b = bearing * Math.PI / 180, la1 = c.lat * Math.PI / 180, lo1 = c.lng * Math.PI / 180;
		const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
		const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
		const center = new LngLat(((lo2 * 180 / Math.PI + 540) % 360) - 180, la2 * 180 / Math.PI);
		const zoom = Math.log2(c2c * 2 * Math.PI * R * Math.cos(la2) / (512 * dist));
		return { center, elevation: 0, zoom, bearing, pitch, roll };
	}
	isMoving(): boolean { return !!ask(this, "isMoving", [], { before: false }); }
	isZooming(): boolean { return this.isMoving(); }
	isRotating(): boolean { return this.isMoving(); }
	stop(): this { ask(this, "stop", []); return this; }
	project(ll: LngLatLike): XY { const p = S.get(this)!.engine?.project(lngArr(ll)); return p ? { x: p.x, y: p.y } : { x: NaN, y: NaN }; }
	unproject(p: PointLike): LngLat | null { const ll = S.get(this)!.engine?.unproject(Array.isArray(p) ? p : [p.x, p.y]); return ll ? new LngLat(ll.lng, ll.lat) : null; }

	// ── style・source・層 ──
	setStyle(style: unknown, o?: unknown): this { if (style && typeof style === "object" && (style as { projection?: { type?: string } }).projection) S.get(this)!.projection = (style as { projection: { type?: string } }).projection.type === "globe" ? "globe" : "mercator"; ask(this, "setStyle", [style, o]); return this; }
	getStyle() { return ask<ReturnType<Engine["getStyle"]> | undefined>(this, "getStyle", []); }
	isStyleLoaded(): boolean { return S.get(this)!.loaded; }
	loaded(): boolean { const st = S.get(this)!; return st.loaded && st.idle && !st.engine?.isMoving(); }
	areTilesLoaded(): boolean { return S.get(this)!.idle; }
	// source の中身が載った合図（MapLibre の sourcedata/data・isSourceLoaded）＝source を足した時・その source の層が載った時・idle の時
	_sourceLoaded(id: string): void { emit(this, "sourcedata", { dataType: "source", sourceId: id, isSourceLoaded: true, sourceDataType: "content" }); emit(this, "data", { dataType: "source", sourceId: id, isSourceLoaded: true }); }
	addSource(id: string, src: unknown): this { S.get(this)!.sources.add(id); ask(this, "addSource", [id, src], { then: () => this._sourceLoaded(id) }); return this; }
	removeSource(id: string): this { S.get(this)!.sources.delete(id); ask(this, "removeSource", [id]); return this; }
	getSource(id: string) { return ask(this, "getSource", [id]); }
	isSourceLoaded(id: string): boolean { return !!ask(this, "isSourceLoaded", [id], { before: false }); }
	addLayer(layer: LayerIn, before?: string): this {
		if (layer?.type === "custom") {   // CustomLayerInterface＝エンジンの main の WebGL2 canvas に描く（onAdd/render の map はこの口＝setCustomLayerHost）
			const st = S.get(this)!; if (!st.customHost) { st.customHost = true; ask(this, "setCustomLayerHost", [this]); }
			if (layer.renderingMode === "3d" && typeof layer.url !== "string") unsupported(this, "custom layer depth shared with the map (3d models are drawn above the map; pass url of a layer module to draw in the worker with depth)", "cosmetic");
			ask(this, "addLayer", before != null ? [layer, before] : [layer]); return this;
		}
		const sid = typeof layer?.source === "string" ? layer.source : layer?.id;
		ask(this, "addLayer", before != null ? [layer, before] : [layer], { then: () => sid && this._sourceLoaded(sid) }); return this;
	}
	removeLayer(id: string): this { ask(this, "removeLayer", [id]); return this; }
	getLayer(id: string) { return ask(this, "getLayer", [id]); }
	getLayersOrder() { return (this.getStyle()?.layers || []).map(l => l.id); }
	moveLayer(id: string, before?: string): this { ask(this, "moveLayer", [id, before]); return this; }
	setPaintProperty(id: string, k: string, v: unknown, o?: unknown): this { ask(this, "setPaintProperty", [id, k, v, o]); return this; }
	getPaintProperty(id: string, k: string) { return ask(this, "getPaintProperty", [id, k]); }
	setLayoutProperty(id: string, k: string, v: unknown, o?: unknown): this { ask(this, "setLayoutProperty", [id, k, v, o]); return this; }
	getLayoutProperty(id: string, k: string) { return ask(this, "getLayoutProperty", [id, k]); }
	setFilter(id: string, f: unknown, o?: unknown): this { ask(this, "setFilter", [id, f, o]); return this; }
	setGlobalStateProperty(k: string, v: unknown): this { ask(this, "setGlobalStateProperty", [k, v]); return this; }   // global-state（記号の残件③）
	getGlobalState() { return ask(this, "getGlobalState", []) ?? {}; }
	getFilter(id: string) { return ask(this, "getFilter", [id]); }
	setLayerZoomRange(id: string, a: number, b: number): this { ask(this, "setLayerZoomRange", [id, a, b]); return this; }
	setFeatureState(f: object, s: object): this { ask(this, "setFeatureState", [f, s]); return this; }
	removeFeatureState(f: object, k?: string): this { ask(this, "removeFeatureState", [f, k]); return this; }
	getFeatureState(f: object) { return ask(this, "getFeatureState", [f]); }
	// 同期の queryRenderedFeatures（C7・2026-10-12・本人裁定「直近の描画のヒット索引で近似」）：エンジンの答えは非同期（タイルを取り直す）＝この口は
	// 「同じ視点で・同じ所（点は 8px 以内・箱は 2px 以内）・同じ層と filter で直近に済んだ答え」を同期で返し、裏で今の問い合わせを走らせて次の呼び出しに備える。
	// 初回は []（MapLibre 用の hover のコードは次の mousemove で埋まる）。一度でもこの口が呼ばれた地図は容れ物の mousemove で先回りして全層を問い合わせる（rAF に畳む）＝
	// click の直後の同期の呼び出し（layers で絞る物）はその答えから作る。filter つきは先回りから作らない（エンジンの filter の評価を待つ）。正確な答えが要る時はエンジンの非同期の口（await）か層のイベント
	queryRenderedFeatures(geometry?: QueryGeom | QueryOpts | null, opts?: QueryOpts): Rendered {
		const st = S.get(this)!; if (st.inert) return [];
		if (geometry && !Array.isArray(geometry) && typeof geometry.x !== "number") { opts = geometry; geometry = undefined; }
		const g = syncGeom(geometry as QueryGeom | null | undefined), q = (st.sq ||= { cache: new globalThis.Map(), pending: new globalThis.Map(), armed: false } as SyncQ);
		if (!st.engine) return [];
		if (!q.armed) { q.armed = true; armPrewarm(this, st); }
		const o = opts || {}, key = syncKey(o), cam = camSig(st.engine);
		syncKick(st, key, g, o, cam);
		const c = q.cache.get(key);
		if (c && c.cam === cam && syncMatch(c.g, g)) return c.result;
		if (key !== "" && o.filter == null) {   // 層で絞るだけ＝先回り（全層）の答えから（順は全層の順のまま＝MapLibre の層の順）
			const a = q.cache.get(""); if (a && a.cam === cam && syncMatch(a.g, g)) { const want = new Set(o.layers); return a.result.filter(f => want.has(f.layer?.id)); }
		}
		return [];
	}
	querySourceFeatures(id: string, o?: object) { return ask<unknown[]>(this, "querySourceFeatures", [id, o], { before: [] }) ?? []; }   // 同期（集約の丸・geojson の地物）
	queryTerrainElevation(ll: LngLatLike): number | null { const p = lngArr(ll); return ask<number | null>(this, "queryTerrainElevation", [p[0], p[1]], { before: null }) ?? null; }   // 同期＝エンジンの標高のメモ（地形がある時・未着は null＝MapLibre と同じ）
	// MapLibre 同名＝目の位置（from・高さ m）から注視点（to・高さ m）を見るカメラ（純粋な計算・MapLibre の式のまま：メルカトルの距離と cameraToCenterDistance＝0.5/tan(fov/2)·高さ px・fov 36.87°）
	calculateCameraOptionsFromTo(from: LngLatLike, altitudeFrom: number, to: LngLatLike, altitudeTo = 0) {
		const a = MercatorCoordinate.fromLngLat(LngLat.convert(from), altitudeFrom), b = MercatorCoordinate.fromLngLat(LngLat.convert(to), altitudeTo);
		const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d3 = Math.hypot(dx, dy, dz);
		if (d3 === 0) throw new Error("Can't calculate camera options with same From and To");
		const H = S.get(this)!.container?.clientHeight || 600, fov = 36.86989764584402 * Math.PI / 180, c2c = 0.5 / Math.tan(fov / 2) * H;
		const zoom = Math.log2(c2c / d3 / 512), bearing = Math.atan2(dx, -dy) * 180 / Math.PI;
		let pitch = Math.acos(Math.hypot(dx, dy) / d3) * 180 / Math.PI; pitch = dz < 0 ? 90 - pitch : 90 + pitch;
		return { center: b.toLngLat(), elevation: altitudeTo, zoom, pitch, bearing };
	}
	setTerrain(t: unknown): this { ask(this, "setTerrain", [t]); return this; }
	getTerrain() { return ask<unknown>(this, "getTerrain", [], { before: null }); }
	setLight(light: unknown, o?: unknown): this { ask(this, "setLight", [light]); return this; }   // style の light（B3・2026-10-12）＝エンジンの押し出し・glTF の陰影（GL2）
	getLight() { return ask(this, "getLight", [], { before: { anchor: "viewport", color: "#ffffff", intensity: 0.5, position: [1.15, 210, 30] } }); }
	setSky(sky: unknown, o?: unknown): this { ask(this, "setSky", [sky]); return this; }   // style の sky（B4・2026-10-12）＝エンジンの簡易の空（GL2）と霧の色・濃さ
	getSky() { return ask<unknown>(this, "getSky", [], { before: undefined }); }
	// ── 小口の束（B6・2026-10-12）＝旧 stub をエンジンの口へ ──
	getSprite() { return ask<unknown[]>(this, "getSprite", [], { before: [] }) ?? []; }
	setSprite(url: unknown, o?: unknown): this { ask(this, "setSprite", [url]); return this; }
	addSprite(id: string, url: string, o?: unknown): this { ask(this, "addSprite", [id, url]); return this; }
	removeSprite(id: string): this { ask(this, "removeSprite", [id]); return this; }
	getImage(id: string) { return ask<unknown>(this, "getImage", [id], { before: undefined }); }
	getGlyphs() { return ask<unknown>(this, "getGlyphs", [], { before: undefined }); }
	setGlyphs(url: string, o?: unknown): this { ask(this, "setGlyphs", [url]); return this; }
	getStyleUrl() { return ask<unknown>(this, "getStyleUrl", [], { before: typeof S.get(this)!.options.style === "string" ? S.get(this)!.options.style : undefined }); }
	getFontFaces() { return ask<unknown[]>(this, "getFontFaces", [], { before: [] }) ?? []; }
	setFontFaces(list: unknown): this { ask(this, "setFontFaces", [list]); return this; }
	refreshTiles(sourceId: string, tileIds?: unknown): this { ask(this, "refreshTiles", [sourceId]); return this; }   // tileIds（一部だけ）は読まない＝source 全体
	coveringTiles(o: object) { return ask<unknown[]>(this, "coveringTiles", [o], { before: [] }) ?? []; }
	setSourceTileLodParams(a: number, b: number): this { ask(this, "setSourceTileLodParams", [a, b]); return this; }
	setTransformCameraUpdate(fn?: ((v: { center: LngLat; zoom: number; pitch: number; bearing: number; roll: number; elevation: number }) => (CamIn & { zoom?: number | null }) | null | undefined) | null): this {   // 制約の後にカメラを書き換える（zoom は公開の z で往復・角は度・elevation は m）
		const st = S.get(this)!, dz = st.dz ?? 1;
		ask(this, "setCameraUpdate", [typeof fn === "function" ? (v: { center: number[]; zoom: number; pitch: number; bearing: number; roll: number; elevation: number }) => { const r = fn({ center: new LngLat(v.center[0], v.center[1]), zoom: v.zoom - dz, pitch: v.pitch, bearing: v.bearing, roll: v.roll, elevation: v.elevation }); return r ? { ...r, center: r.center != null ? lngArr(r.center) : undefined, zoom: r.zoom != null ? r.zoom + dz : undefined } : null; } : null]);
		return this;
	}
	setMinPitch(p?: number | null): this { ask(this, "setMinPitch", [p ?? 0]); return this; }
	getMinPitch() { return ask(this, "getMinPitch", [], { before: 0 }); }
	setPixelRatio(r: number): this { ask(this, "setPixelRatio", [r]); return this; }
	setZoomSnap(v: number): this { ask(this, "setZoomSnap", [v]); return this; }   // 目盛りの刻み（A2 のエンジンの口・zoom の数ではない＝換算なし）
	getZoomSnap() { return ask(this, "getZoomSnap", [], { before: 0 }); }
	setAnisotropicFilterPitch(p: number): this { S.get(this)!.anisoPitch = p; unsupported(this, "setAnisotropicFilterPitch (raster filtering is not configurable)", "cosmetic"); return this; }
	getAnisotropicFilterPitch(): number { return S.get(this)!.anisoPitch ?? 60; }   // 既定 60 は本物と未照合
	setEventedParent(parent?: unknown, data?: unknown): this { S.get(this)!.eventedParent = parent ? { parent, data } : null; unsupported(this, "setEventedParent", "cosmetic"); return this; }
	// property の口（MapLibre は map.showTileBoundaries = true と書く）
	get showTileBoundaries(): boolean { return !!S.get(this)!.dbg?.tileBoundaries; }
	set showTileBoundaries(v: boolean) { const st = S.get(this)!; (st.dbg ??= {}).tileBoundaries = !!v; ask(this, "setDebug", [{ tileBoundaries: !!v }]); }
	get showPadding(): boolean { return !!S.get(this)!.dbg?.padding; }
	set showPadding(v: boolean) { const st = S.get(this)!; (st.dbg ??= {}).padding = !!v; ask(this, "setDebug", [{ padding: !!v }]); }
	get showCollisionBoxes(): boolean { return !!S.get(this)!.dbg?.collision; }
	set showCollisionBoxes(v: boolean) { const st = S.get(this)!; (st.dbg ??= {}).collision = !!v; if (v) unsupported(this, "showCollisionBoxes", "cosmetic"); }
	get showOverdrawInspector(): boolean { return !!S.get(this)!.dbg?.overdraw; }
	set showOverdrawInspector(v: boolean) { const st = S.get(this)!; (st.dbg ??= {}).overdraw = !!v; if (v) unsupported(this, "showOverdrawInspector", "cosmetic"); }
	get vertices(): boolean { return !!S.get(this)!.dbg?.vertices; }
	set vertices(v: boolean) { const st = S.get(this)!; (st.dbg ??= {}).vertices = !!v; if (v) unsupported(this, "vertices (wireframe)", "cosmetic"); }
	get repaint(): boolean { return !!S.get(this)!.repaint; }
	set repaint(v: boolean) { S.get(this)!.repaint = !!v; ask(this, "setRepaint", [!!v]); }
	// 投影＝頼まれた物を覚える（MapLibre の既定は mercator・setProjection({type:"globe"}) で globe）。絵はどちらも球（文書の違い）だが、custom 層の variant（mercator の行列か球の prelude か）はこの申告に従う（2026-09-30）
	setProjection(p?: { type?: string } | string | null): this { const t = (p as { type?: string } | null | undefined)?.type ?? p ?? "mercator"; S.get(this)!.projection = t === "globe" ? "globe" : "mercator"; return this; }
	getProjection(): { type: string } { return { type: S.get(this)!.projection ?? "mercator" }; }
	getRenderWorldCopies(): boolean { return false; }   // 球に世界の写しは無い（deck.gl の MapboxOverlay が repeat に使う）
	setRenderWorldCopies(): this { return this; }
	get style() { return { projection: { type: S.get(this)!.projection ?? "mercator", subdivisionGranularity: GRANULARITY_GLOBE } }; }   // 例が map.style.projection.subdivisionGranularity.tile.getGranularityForZoomLevel(z) を読む（custom 層のタイル格子）＝球の既定。他は getStyle()/getLayer() の口
	setTransformRequest(fn: unknown): this { ask(this, "setTransformRequest", [fn]); return this; }

	// ── 画像 ──
	addImage(id: string, img: AnimImage | null | undefined, o?: ImageOpts): this {
		if (img && (typeof img.render === "function" || typeof img.data?.renderWithWebGL === "function")) return this._addAnimated(id, img, o);
		ask(this, "addImage", [id, img?.data && img.width ? { width: img.width, height: img.height, data: img.data } : img, o]);
		return this;
	}
	updateImage(id: string, img: AnimImage | null | undefined): this { ask(this, "updateImage", [id, img?.data && img.width ? { width: img.width, height: img.height, data: img.data } : img]); return this; }
	// 動く記号（StyleImageInterface）＝MapLibre と同じく onAdd → 毎フレーム render()（true＝変わった）→ 画素を差し替える（エンジンの updateImage＝層を評価し直さない）。
	// data が画素列ならそのまま・data.renderWithWebGL なら画面外の WebGL2 に描かせて読む（行は上から＝MapLibre の atlas と同じ向き）。差し替えの途中は次のフレームを飛ばす（溜めない）
	_addAnimated(id: string, img: AnimImage, o?: ImageOpts): this {
		const st = S.get(this)!, anim = st.anim ??= new globalThis.Map();   // このモジュールの Map は地図のクラス
		this._stopAnimated(id);
		const w = img.width, h = img.height;
		let gl: WebGL2RenderingContext | null = null, tex: WebGLTexture | null = null, fbo: WebGLFramebuffer | null = null, busy = false, first = true, raf = 0;
		const pixels = (): Uint8Array | null => {
			const d = img.data;
			if (typeof d?.renderWithWebGL === "function") {
				if (!gl) {
					const cv = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
					gl = (cv as HTMLCanvasElement).getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
					if (!gl) { unsupported(this, "addImage (renderWithWebGL without WebGL2)"); return null; }
					tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
					fbo = gl.createFramebuffer();
				}
				d.renderWithWebGL({ gl, texture: tex, x: 0, y: 0, width: w, height: h });
				gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
				const out = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
				return out;
			}
			return d && d.length! >= w * h * 4 ? d as Uint8Array : null;
		};
		const push = (): void => {
			const px = pixels(); if (!px) return;
			const src = { width: w, height: h, data: px };
			if (first) { first = false; if (st.engine && st.loaded) { busy = true; Promise.resolve(st.engine.addImage(id, src, o)).catch(e => fail(this, "addImage", e)).finally(() => { busy = false; }); } else ask(this, "addImage", [id, src, o]); return; }   // 最初の登録が済むまで差し替えない
			const eng = st.engine; if (!eng || !st.loaded) { ask(this, "updateImage", [id, src]); return; }
			busy = true;
			Promise.resolve(eng.updateImage(id, src)).catch(e => fail(this, "updateImage", e)).finally(() => { busy = false; });
		};
		const tick = (): void => {
			if (anim.get(id)?.tick !== tick) return;
			raf = requestAnimationFrame(tick);
			if (busy) return;
			let changed = false;
			try { changed = typeof img.render === "function" ? !!img.render() : false; } catch (e) { fail(this, "StyleImageInterface.render", e); }
			if (changed) push();
		};
		anim.set(id, { img, tick, stop: () => { cancelAnimationFrame(raf); try { img.onRemove?.(); } catch { /* 聞き手の後片付け */ } gl?.getExtension("WEBGL_lose_context")?.loseContext(); } });
		try { img.onAdd?.(this, id); } catch (e) { fail(this, "StyleImageInterface.onAdd", e); }
		try { if (typeof img.render === "function") img.render(); } catch (e) { fail(this, "StyleImageInterface.render", e); }
		push();
		raf = requestAnimationFrame(tick);
		return this;
	}
	_stopAnimated(id: string): void { const a = S.get(this)!.anim?.get(id); if (a) { S.get(this)!.anim!.delete(id); a.stop(); } }
	hasImage(id: string): boolean { return !!ask(this, "hasImage", [id], { before: false }); }
	setMissingStyleImageResolver(fn: (id: string) => void): this { this.on("styleimagemissing", e => fn(e.id as string)); return this; }   // MapLibre 6＝styleimagemissing の聞き手の省略形
	removeImage(id: string): this { this._stopAnimated(id); ask(this, "removeImage", [id]); return this; }
	listImages() { return ask<unknown[]>(this, "listImages", [], { before: [] }); }
	async loadImage(url: string): Promise<{ data: ImageBitmap }> {
		const r = await fetch(url);
		if (!r.ok) throw new Error(`AJAXError: ${r.statusText} (${r.status}): ${url}`);
		return { data: await createImageBitmap(await r.blob()) };
	}

	// ── 容れ物・描画・後片付け ──
	getContainer(): HTMLElement { return S.get(this)!.container; }
	get transform() {   // MapLibre の内部（公式の口ではない）。deck.gl の MapboxOverlay が地形のある地図で transform.elevation・height を読む＝最小の写し
		const st = S.get(this)!, c = st.container;
		return { width: c?.clientWidth ?? 0, height: c?.clientHeight ?? 0, elevation: 0, center: this.getCenter(), zoom: this.getZoom(), bearing: this.getBearing(), pitch: this.getPitch() };
	}
	getCanvasContainer(): HTMLElement { return S.get(this)!.container; }
	getCanvas(): HTMLCanvasElement {
		const st = S.get(this)!, cg = st.engine?.getCustomLayerCanvas?.();
		if (cg) return cg;   // custom 層がある地図＝その WebGL2 canvas（three.js の new WebGLRenderer({ canvas: map.getCanvas(), context: gl }) が同じ canvas と文脈を受け取る）
		const c = st.container.querySelector("canvas#c");
		if (c) return c as HTMLCanvasElement;
		unsupported(this, "getCanvas before the map is ready");
		return (st.placeholder ??= document.createElement("canvas"));
	}
	getPixelRatio() { return ask(this, "getPixelRatio", [], { before: window.devicePixelRatio || 1 }); }
	triggerRepaint(): void { S.get(this)!.engine?.requestDraw?.(); }
	redraw(): this { this.triggerRepaint(); return this; }
	resize(): this { return this; }   // 容れ物の大きさはエンジンが ResizeObserver で追う
	remove(): void {
		for (const id of [...(S.get(this)!.anim?.keys() ?? [])]) this._stopAnimated(id);   // 動く記号の毎フレームを止める
		const st = S.get(this)!;
		for (const c of [...st.controls.keys()]) this.removeControl(c);
		if (!st.inert) { liveMaps--; onEngine(st, eng => eng.destroy()); }
		emit(this, "remove");
	}
	get version(): string { return "ortho-earth"; }

	// ── 操作部品（IControl）＝MapLibre の CSS の class 名の四隅へ ──
	addControl(ctrl: IControl, pos?: string): this {
		const st = S.get(this)!;
		if (!ctrl || typeof ctrl.onAdd !== "function") throw new Error("Invalid argument to map.addControl(). Argument must be a control with onAdd and onRemove methods.");
		if (!st.corners) {
			const root = document.createElement("div"); root.className = "maplibregl-control-container";
			st.corners = Object.fromEntries(["top-left", "top-right", "bottom-left", "bottom-right"].map(k => { const d = document.createElement("div"); d.className = `maplibregl-ctrl-${k}`; root.appendChild(d); return [k, d]; }));
			st.container.appendChild(root);
		}
		// deck.gl の MapboxOverlay（PR-7）：interleaved（地図の GL 文脈へ描く）はこの地図では成り立たない（地図は worker が描く）＝overlaid に倒す。overlaid は render／resize／mouse・drag 系の事象と getCenter/getZoom/getBearing/getPitch/getPadding/getRenderWorldCopies で追従する
		if (ctrl._interleaved === true && ctrl._props && typeof ctrl.setProps === "function") { unsupported(this, "MapboxOverlay interleaved (deck.gl cannot draw into this map's GL context; falling back to overlaid)", "cosmetic"); ctrl._interleaved = false; }
		const where = pos || ctrl.getDefaultPosition?.() || "top-right", el = ctrl.onAdd(this);
		const corner = st.corners[where] || st.corners["top-right"];
		if (where.startsWith("bottom")) corner.insertBefore(el, corner.firstChild); else corner.appendChild(el);
		st.controls.set(ctrl, el);
		return this;
	}
	removeControl(ctrl: IControl): this { const st = S.get(this)!; if (!st.controls.has(ctrl)) return this; st.controls.delete(ctrl); ctrl.onRemove?.(this); return this; }
	hasControl(ctrl: IControl): boolean { return S.get(this)!.controls.has(ctrl); }
}
for (const h of HANDLERS) Object.defineProperty(Map.prototype, h, { get() { return S.get(this)!.handlers![h]; } });

// Marker／Popup＝エンジンの部品に、通訳の地図と LngLat の受け渡しだけを足す（準備前の addTo は準備を待って載せる）
export class Marker extends OrthoMarker {
	constructor(options?: MarkerOptions | HTMLElement, legacy?: MarkerOptions) { super(typeof HTMLElement !== "undefined" && options instanceof HTMLElement ? { ...legacy, element: options } : options); }
	addTo(map: Map | GlobeMap): this {
		const st = S.get(map);
		if (!st) return super.addTo(map as GlobeMap);
		if (!st.inert) onEngine(st, eng => super.addTo(eng));
		return this;
	}
	setLngLat(ll: LngLatLike): this { return super.setLngLat(lngArr(ll)); }
	getLngLat(): LngLat | null { const v = super.getLngLat(); return v ? LngLat.convert(v) : v; }
}
export class Popup extends OrthoPopup {
	addTo(map: Map | GlobeMap): this {
		const st = S.get(map);
		if (!st) return super.addTo(map as GlobeMap);
		if (!st.inert) onEngine(st, eng => super.addTo(eng));
		return this;
	}
	setLngLat(ll: LngLatLike): this { return super.setLngLat(lngArr(ll)); }
	getLngLat(): LngLat | null { const v = super.getLngLat?.(); return v ? LngLat.convert(v) : v; }
}
