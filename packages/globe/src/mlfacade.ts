// 外側の顔（facade・2026-09-26・MapLibre 互換の台帳 maplibre-compat.md の約束 1〜3）。
// createGlobe({ zoomScale: "maplibre" }) の地図だけ、最後に返す map をこの Proxy で包む（旗なしは素の map をそのまま返す）。
// 公開面の「数」の zoom を MapLibre の z で受け渡す（入力 +dz・出力 −dz・null は素通し）。文字列（view.hash）と台本の族はエンジン z のまま。
// 代理するのは map・map.gadget（関数）・map.raster の 3 つだけ。gint の手綱は包まない（hits[i].layer === h の同一性）＝addGint に _dz を渡して中で換算。
// 層（addLayer…・ML 形 gadget・問い合わせの filter）は globe の中の PUBLIC_DZ が換算する＝ここでは触らない（二重に換算しない）。
// 内部（ガジェット・地域パック・worldcontent）は素の map を握ったまま＝エンジンの z（ガジェットは func.apply(素の map)）。
// 換算の表＝zoomscale.js（ここはその表の「in/out/io/event」を実装する）。shiftZoomExpr は core の物を呼び手（globe.js）が渡す＝このファイルは import が zoomscale.js だけ＝node で検定できる。
import { RAW, zIn, zOut, GADGET_MEMBERS } from "./zoomscale.ts";

// 顔は素の map のメンバーを名前で呼ぶだけ（引数は利用者の物をそのまま流す）＝ここでの map は「名前 → 関数」の緩い形で読む
type Call = { call(...args: unknown[]): unknown }["call"];   // 引数は双変（名前で引いた口に利用者の引数を流す）
/** 顔が読む素の map（gadget＝関数に性質が生えた物・raster＝口の束） */
interface RawMap {
	[k: string | symbol]: unknown;
	gadget: Call & Record<string | symbol, unknown>;
	raster?: Record<string, unknown> & { add: Call; set: Call; list(): unknown[] };
	view?: unknown;
	on: Call; off: Call;
	/** 換算する口（FACADE_CONV） */
	flyTo: Call; jumpTo: Call; easeTo: Call; setZoom: Call; getZoom: Call; fitBounds: Call; fitScreenCoordinates: Call; lookAt: Call; follow: Call; setCamera: Call;
	cameraForBounds(...args: unknown[]): Zoomish | null; fitZoomForBbox: Call; setMinZoom: Call; getMinZoom: Call; setMaxZoom: Call; getMaxZoom: Call; setZoomMin: Call; zoomMin: Call;
	addGint: Call; applyGintData: Call; paint: Call; queryRenderedFeatures: Call;
}
type Zoomish = { zoom?: number | null; maxZoom?: number | null; minZoom?: number | null; expansionZoom?: number | null; label?: unknown; style?: unknown };
export interface FacadeOptions { shiftZoomExpr?: <T>(e: T, dz: number) => T }

// ここで換算する公開メンバー（tests/mlfacade.mjs が zoomscale.js の表の in/out/io/event と突き合わせる）。view は getter で別扱い
export const FACADE_CONV: readonly string[] = ["flyTo", "jumpTo", "easeTo", "setZoom", "getZoom", "fitBounds", "fitScreenCoordinates", "lookAt", "follow", "setCamera", "cameraForBounds", "fitZoomForBbox",
	"setMinZoom", "getMinZoom", "setMaxZoom", "getMaxZoom", "setZoomMin", "zoomMin", "addGint", "applyGintData", "paint",
	"queryRenderedFeatures", "on", "off", "once"];

export function createFacade<M extends object>(raw: M, dz: number, opts?: FacadeOptions): M;
export function createFacade(raw: RawMap, dz: number, { shiftZoomExpr }: FacadeOptions = {}): RawMap {
	if (!dz) return raw;
	if (typeof shiftZoomExpr !== "function") throw new Error("createFacade: shiftZoomExpr is required");
	let facade: RawMap;
	const fix = (r: unknown) => r === raw ? facade : r;   // 連鎖（return map）と Promise の解決値（setStyle 等）を顔へ
	const out = (r: unknown) => r && typeof (r as Promise<unknown>).then === "function" ? (r as Promise<unknown>).then(fix) : fix(r);
	const zi = (z: unknown) => zIn(z as number, dz), zo = (z: unknown) => zOut(z as number, dz);
	const camIn = (o: unknown) => o && typeof o === "object" && (o as Zoomish).zoom != null ? { ...o, zoom: zi((o as Zoomish).zoom) } : o;
	const fitIn = (o: unknown) => o && typeof o === "object" && (o as Zoomish).maxZoom != null ? { ...o, maxZoom: zi((o as Zoomish).maxZoom) } : o;
	const rangeIn = (o: unknown) => { if (!o || typeof o !== "object") return o; const r: Zoomish = { ...o }; if (r.minZoom != null) r.minZoom = zi(r.minZoom); if (r.maxZoom != null) r.maxZoom = zi(r.maxZoom); return r; };
	const rangeOut = (o: unknown) => { if (!o || typeof o !== "object") return o; const r: Zoomish = { ...o }; if (r.minZoom != null) r.minZoom = zo(r.minZoom); if (r.maxZoom != null) r.maxZoom = zo(r.maxZoom); return r; };
	const exprIn = (e: unknown) => e == null ? e : shiftZoomExpr(e, dz);   // 利用者の式の ["zoom"]＝MapLibre の z＝エンジンの z − dz
	const gintOptsIn = (o: Zoomish | null | undefined) => { const r: Zoomish & { _dz: number } = { ...rangeIn(o || {}) as object, _dz: dz }; if (o?.label) r.label = rangeIn(o.label); if (o?.style) r.style = rangeIn(o.style); return r; };   // _dz＝手綱が自分の setData/style/setLabel/setPaint を換算する
	const featOut = (f: unknown) => f && typeof f === "object" && (f as Zoomish).expansionZoom != null ? { ...f, expansionZoom: zo((f as Zoomish).expansionZoom) } : f;

	// ── イベント：利用者の handler → 包んだ handler（off は同一性で探す＝(ev, 層キー) ごとの WeakMap）──
	const handlers = new Map<string, WeakMap<Call, Call>>();
	const keyOf = (ev: string, layerKey: unknown) => ev + "|" + (layerKey == null ? "" : JSON.stringify(layerKey));
	const wrapOf = (ev: string, layerKey: unknown, cb: Call, make: (cb: Call) => Call) => {
		const k = keyOf(ev, layerKey);
		let m = handlers.get(k); if (!m) handlers.set(k, m = new WeakMap());
		let w = m.get(cb); if (!w) { w = make(cb); m.set(cb, w); }
		return w;
	};
	const findWrap = (ev: string, layerKey: unknown, cb: Call) => handlers.get(keyOf(ev, layerKey))?.get(cb);
	const evPlain = (ev: string, e: unknown) => e && typeof e === "object" && (ev === "move" || ev === "settle") && (e as Zoomish).zoom != null ? { ...e, zoom: zo((e as Zoomish).zoom) } : e;
	const evLayer = (e: unknown) => e && typeof e === "object" ? { ...e, target: facade, features: Array.isArray((e as { features?: unknown }).features) ? ((e as { features: unknown[] }).features).map(featOut) : (e as { features?: unknown }).features } : e;
	const plain = (a: unknown, b: unknown) => typeof a === "function" || b == null;
	function on(ev: string, a?: unknown, b?: unknown): RawMap {
		if (plain(a, b)) raw.on(ev, wrapOf(ev, null, a as Call, cb => e => cb(evPlain(ev, e))));
		else raw.on(ev, a, wrapOf(ev, a, b as Call, cb => e => cb(evLayer(e))));
		return facade;
	}
	function off(ev: string, a?: unknown, b?: unknown): RawMap {
		if (plain(a, b)) raw.off(ev, findWrap(ev, null, a as Call) ?? a);
		else raw.off(ev, a, findWrap(ev, a, b as Call) ?? b);
		return facade;
	}
	function once(ev: string, a?: unknown, b?: unknown): RawMap | Promise<unknown> {   // 顔の on/off の上で組む（素の once は素の on/off を呼ぶ＝換算も target も素のまま）
		if (typeof a === "function" || (a == null && b == null)) {
			if (!a) return new Promise(res => { const f = (e: unknown) => { off(ev, f); res(e); }; on(ev, f); });
			const f = (e: unknown) => { off(ev, f); (a as Call)(e); }; return on(ev, f);
		}
		if (!b) return new Promise(res => { const f = (e: unknown) => { off(ev, a, f); res(e); }; on(ev, a, f); });
		const f = (e: unknown) => { off(ev, a, f); (b as Call)(e); }; return on(ev, a, f);
	}

	const CONV: Record<string | symbol, Call> = {
		flyTo: (a, ...r) => a && typeof a === "object" ? raw.flyTo(camIn(a)) : raw.flyTo(a, r[0], zi(r[1]), ...r.slice(2)),   // {…} と位置引数（lon, lat, zoom, tilt, bearing）の両方
		jumpTo: o => raw.jumpTo(camIn(o)),
		easeTo: o => raw.easeTo(camIn(o)),
		setZoom: z => raw.setZoom(zi(z)),
		getZoom: () => zo(raw.getZoom()),
		fitBounds: (b, o) => raw.fitBounds(b, fitIn(o)),
		fitScreenCoordinates: (p0, p1, br, o) => raw.fitScreenCoordinates(p0, p1, br, fitIn(o)),
		lookAt: (t, o) => raw.lookAt(t, camIn(o)), follow: (t, o) => raw.follow(t, camIn(o)), setCamera: c => raw.setCamera(camIn(c)),   // A4
		cameraForBounds: (b, o) => { const r = raw.cameraForBounds(b, fitIn(o)); return r && { ...r, zoom: zo(r.zoom) }; },
		fitZoomForBbox: b => zo(raw.fitZoomForBbox(b)),
		setMinZoom: z => raw.setMinZoom(zi(z)), getMinZoom: () => zo(raw.getMinZoom()),
		setMaxZoom: z => raw.setMaxZoom(zi(z)), getMaxZoom: () => zo(raw.getMaxZoom()),
		setZoomMin: z => raw.setZoomMin(zi(z)), zoomMin: () => zo(raw.zoomMin()),
		addGint: (pbf, o) => raw.addGint(pbf, gintOptsIn(o as Zoomish | null | undefined)),
		applyGintData: (pbf, label, move, o) => raw.applyGintData(pbf, label, move, o && (o as Zoomish).minZoom != null ? { ...o, minZoom: zi((o as Zoomish).minZoom) } : o),
		paint: (p, f) => raw.paint(p && typeof p === "object" ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, exprIn(v)])) : p, f == null ? f : exprIn(f)),
		queryRenderedFeatures: (...a) => Promise.resolve(raw.queryRenderedFeatures(...a)).then(fs => Array.isArray(fs) ? fs.map(featOut) : fs),
		on, off, once,
	};

	// ── map.gadget（関数に性質が生えた物）──
	const itemsIn = (items: unknown): unknown => typeof items === "function" ? (c: object) => itemsIn((items as Call)({ ...c, map: facade }))
		: Array.isArray(items) ? items.map(it => it && typeof it.onClick === "function" ? { ...it, onClick: (c: object) => it.onClick({ ...c, map: facade }) } : it) : items;
	function gadgetArgsIn(name: string, args: unknown[]) {
		const spec = GADGET_MEMBERS[name], a = [...args] as Array<Record<string, unknown> | null | undefined>;
		if (spec !== "layer" && spec !== "engine") {
			const o0 = a[0];
			if (o0 && typeof o0 === "object" && Array.isArray(o0.zoom)) a[0] = { ...o0, zoom: o0.zoom.map(zi) };   // 表示帯 zoom:[zmin, zmax)（全ガジェット共通の宣言）
			if (spec && spec.opts) {
				const i = spec.arg ?? 0, o = a[i];
				if (o && typeof o === "object") {
					const r = { ...o };
					for (const key of spec.opts) {
						if (key === "view[2]") { if (Array.isArray(r.view) && r.view[2] != null) r.view = [r.view[0], r.view[1], zi(r.view[2]), ...r.view.slice(3)]; }
						else if (r[key] != null) r[key] = zi(r[key]);
					}
					a[i] = r;
				}
			}
		}
		if (name === "contextmenu" && a[0]?.items) a[0] = { ...a[0], items: itemsIn(a[0].items) };   // 項目の onClick に渡る c.map も顔へ
		return a;
	}
	const gadgetOut = (name: string, r: unknown) => {
		if (name !== "contextmenu") return r;
		if (typeof r === "function") return (items: unknown) => (r as Call)(itemsIn(items));
		if (r && typeof (r as { setItems?: unknown }).setItems === "function") return { ...r, setItems: (items: unknown) => (r as { setItems: Call }).setItems(itemsIn(items)) };
		return r;
	};
	const gadgetCache = new Map<string, Call>();
	const gadgetProxy = new Proxy(raw.gadget, {
		apply(t, thisArg, args: unknown[]) {   // 利用者のガジェット登録＝this を顔に（旗つきの頁で this.getZoom() が MapLibre の z）
			let [name, fn] = args as [string | Call, Call];
			if (typeof name === "function") { fn = name; name = fn.name; }
			return raw.gadget(name, function (...a: unknown[]) { return fn.apply(facade, a); });
		},
		get(t, k) {
			const g = raw.gadget[k];
			if (typeof k !== "string" || typeof g !== "function") return g;
			let w = gadgetCache.get(k);
			if (!w) { w = (...args: unknown[]) => out(gadgetOut(k, (raw.gadget[k] as Call)(...gadgetArgsIn(k, args)))); gadgetCache.set(k, w); }
			return w;
		},
	});

	// ── map.raster（spec の minZoom/maxZoom は source の tile z＝換算しない・opts は表示窓＝換算する）──
	const rasterConv: Record<string | symbol, Call> = {
		add: (id, spec, o) => raw.raster!.add(id, spec, rangeIn(o)),
		set: (id, o) => raw.raster!.set(id, rangeIn(o)),
		list: () => raw.raster!.list().map(e => e && typeof e === "object" ? { ...e, opts: rangeOut((e as { opts?: unknown }).opts) } : e),
	};
	const rasterCache = new Map<string | symbol, Call>();
	const rasterProxy = raw.raster && new Proxy(raw.raster, {
		get(t, k) {
			if (!(k in rasterConv)) return Reflect.get(t, k);
			let w = rasterCache.get(k);
			if (!w) { w = (...a: unknown[]) => out(rasterConv[k]!(...a)); rasterCache.set(k, w); }
			return w;
		},
	});

	const cache = new Map<string | symbol, Call>();
	facade = new Proxy(raw, {
		get(t, k) {
			if (k === RAW) return raw;
			if (k === "gadget") return gadgetProxy;
			if (k === "raster") return rasterProxy;
			if (k === "view") { const v = raw.view; return v && typeof v === "object" ? { ...v, zoom: zo((v as Zoomish).zoom) } : v; }   // view.hash は文字列＝エンジン z のまま
			const c = CONV[k], v = Reflect.get(raw, k);
			if (!c && (typeof v !== "function" || k === "Marker" || k === "Popup")) return v;   // クラスは new で使う＝包まない
			let w = cache.get(k);
			if (!w) { w = c ? (...a: unknown[]) => out(c(...a)) : (...a: unknown[]) => out((raw[k] as Call)(...a)); cache.set(k, w); }
			return w;
		},
		has(t, k) { return k === RAW || Reflect.has(raw, k); },
	});
	return facade;
}
