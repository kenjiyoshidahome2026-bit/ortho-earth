// 外側の顔（facade・2026-09-26・MapLibre 互換の台帳 maplibre-compat.md の約束 1〜3）。
// createGlobe({ zoomScale: "maplibre" }) の地図だけ、最後に返す map をこの Proxy で包む（旗なしは素の map をそのまま返す）。
// 公開面の「数」の zoom を MapLibre の z で受け渡す（入力 +dz・出力 −dz・null は素通し）。文字列（view.hash）と台本の族はエンジン z のまま。
// 代理するのは map・map.gadget（関数）・map.raster の 3 つだけ。gint の手綱は包まない（hits[i].layer === h の同一性）＝addGint に _dz を渡して中で換算。
// 層（addLayer…・ML 形 gadget・問い合わせの filter）は globe の中の PUBLIC_DZ が換算する＝ここでは触らない（二重に換算しない）。
// 内部（ガジェット・地域パック・worldcontent）は素の map を握ったまま＝エンジンの z（ガジェットは func.apply(素の map)）。
// 換算の表＝zoomscale.js（ここはその表の「in/out/io/event」を実装する）。shiftZoomExpr は core の物を呼び手（globe.js）が渡す＝このファイルは import が zoomscale.js だけ＝node で検定できる。
import { RAW, zIn, zOut, GADGET_MEMBERS } from "./zoomscale.js";

// ここで換算する公開メンバー（tests/mlfacade.mjs が zoomscale.js の表の in/out/io/event と突き合わせる）。view は getter で別扱い
export const FACADE_CONV = ["flyTo", "jumpTo", "easeTo", "setZoom", "getZoom", "fitBounds", "cameraForBounds", "fitZoomForBbox",
	"setMinZoom", "getMinZoom", "setMaxZoom", "getMaxZoom", "setZoomMin", "zoomMin", "addGint", "applyGintData", "paint",
	"queryRenderedFeatures", "on", "off", "once"];

export function createFacade(raw, dz, { shiftZoomExpr } = {}) {
	if (!dz) return raw;
	if (typeof shiftZoomExpr !== "function") throw new Error("createFacade: shiftZoomExpr is required");
	let facade;
	const fix = r => r === raw ? facade : r;   // 連鎖（return map）と Promise の解決値（setStyle 等）を顔へ
	const out = r => r && typeof r.then === "function" ? r.then(fix) : fix(r);
	const zi = z => zIn(z, dz), zo = z => zOut(z, dz);
	const camIn = o => o && typeof o === "object" && o.zoom != null ? { ...o, zoom: zi(o.zoom) } : o;
	const fitIn = o => o && typeof o === "object" && o.maxZoom != null ? { ...o, maxZoom: zi(o.maxZoom) } : o;
	const rangeIn = o => { if (!o || typeof o !== "object") return o; const r = { ...o }; if (r.minZoom != null) r.minZoom = zi(r.minZoom); if (r.maxZoom != null) r.maxZoom = zi(r.maxZoom); return r; };
	const rangeOut = o => { if (!o || typeof o !== "object") return o; const r = { ...o }; if (r.minZoom != null) r.minZoom = zo(r.minZoom); if (r.maxZoom != null) r.maxZoom = zo(r.maxZoom); return r; };
	const exprIn = e => e == null ? e : shiftZoomExpr(e, dz);   // 利用者の式の ["zoom"]＝MapLibre の z＝エンジンの z − dz
	const gintOptsIn = o => { const r = { ...rangeIn(o || {}), _dz: dz }; if (o?.label) r.label = rangeIn(o.label); if (o?.style) r.style = rangeIn(o.style); return r; };   // _dz＝手綱が自分の setData/style/setLabel/setPaint を換算する
	const featOut = f => f && typeof f === "object" && f.expansionZoom != null ? { ...f, expansionZoom: zo(f.expansionZoom) } : f;

	// ── イベント：利用者の handler → 包んだ handler（off は同一性で探す＝(ev, 層キー) ごとの WeakMap）──
	const handlers = new Map();
	const keyOf = (ev, layerKey) => ev + "|" + (layerKey == null ? "" : JSON.stringify(layerKey));
	const wrapOf = (ev, layerKey, cb, make) => {
		const k = keyOf(ev, layerKey);
		let m = handlers.get(k); if (!m) handlers.set(k, m = new WeakMap());
		let w = m.get(cb); if (!w) { w = make(cb); m.set(cb, w); }
		return w;
	};
	const findWrap = (ev, layerKey, cb) => handlers.get(keyOf(ev, layerKey))?.get(cb);
	const evPlain = (ev, e) => e && typeof e === "object" && (ev === "move" || ev === "settle") && e.zoom != null ? { ...e, zoom: zo(e.zoom) } : e;
	const evLayer = e => e && typeof e === "object" ? { ...e, target: facade, features: Array.isArray(e.features) ? e.features.map(featOut) : e.features } : e;
	const plain = (a, b) => typeof a === "function" || b == null;
	function on(ev, a, b) {
		if (plain(a, b)) raw.on(ev, wrapOf(ev, null, a, cb => e => cb(evPlain(ev, e))));
		else raw.on(ev, a, wrapOf(ev, a, b, cb => e => cb(evLayer(e))));
		return facade;
	}
	function off(ev, a, b) {
		if (plain(a, b)) raw.off(ev, findWrap(ev, null, a) ?? a);
		else raw.off(ev, a, findWrap(ev, a, b) ?? b);
		return facade;
	}
	function once(ev, a, b) {   // 顔の on/off の上で組む（素の once は素の on/off を呼ぶ＝換算も target も素のまま）
		if (typeof a === "function" || (a == null && b == null)) {
			if (!a) return new Promise(res => { const f = e => { off(ev, f); res(e); }; on(ev, f); });
			const f = e => { off(ev, f); a(e); }; return on(ev, f);
		}
		if (!b) return new Promise(res => { const f = e => { off(ev, a, f); res(e); }; on(ev, a, f); });
		const f = e => { off(ev, a, f); b(e); }; return on(ev, a, f);
	}

	const CONV = {
		flyTo: (a, ...r) => a && typeof a === "object" ? raw.flyTo(camIn(a)) : raw.flyTo(a, r[0], zi(r[1]), ...r.slice(2)),   // {…} と位置引数（lon, lat, zoom, tilt, bearing）の両方
		jumpTo: o => raw.jumpTo(camIn(o)),
		easeTo: o => raw.easeTo(camIn(o)),
		setZoom: z => raw.setZoom(zi(z)),
		getZoom: () => zo(raw.getZoom()),
		fitBounds: (b, o) => raw.fitBounds(b, fitIn(o)),
		cameraForBounds: (b, o) => { const r = raw.cameraForBounds(b, fitIn(o)); return r && { ...r, zoom: zo(r.zoom) }; },
		fitZoomForBbox: b => zo(raw.fitZoomForBbox(b)),
		setMinZoom: z => raw.setMinZoom(zi(z)), getMinZoom: () => zo(raw.getMinZoom()),
		setMaxZoom: z => raw.setMaxZoom(zi(z)), getMaxZoom: () => zo(raw.getMaxZoom()),
		setZoomMin: z => raw.setZoomMin(zi(z)), zoomMin: () => zo(raw.zoomMin()),
		addGint: (pbf, o) => raw.addGint(pbf, gintOptsIn(o)),
		applyGintData: (pbf, label, move, o) => raw.applyGintData(pbf, label, move, o && o.minZoom != null ? { ...o, minZoom: zi(o.minZoom) } : o),
		paint: (p, f) => raw.paint(p && typeof p === "object" ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, exprIn(v)])) : p, f == null ? f : exprIn(f)),
		queryRenderedFeatures: (...a) => Promise.resolve(raw.queryRenderedFeatures(...a)).then(fs => Array.isArray(fs) ? fs.map(featOut) : fs),
		on, off, once,
	};

	// ── map.gadget（関数に性質が生えた物）──
	const itemsIn = items => typeof items === "function" ? c => itemsIn(items({ ...c, map: facade }))
		: Array.isArray(items) ? items.map(it => it && typeof it.onClick === "function" ? { ...it, onClick: c => it.onClick({ ...c, map: facade }) } : it) : items;
	function gadgetArgsIn(name, args) {
		const spec = GADGET_MEMBERS[name], a = [...args];
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
	const gadgetOut = (name, r) => {
		if (name !== "contextmenu") return r;
		if (typeof r === "function") return items => r(itemsIn(items));
		if (r && typeof r.setItems === "function") return { ...r, setItems: items => r.setItems(itemsIn(items)) };
		return r;
	};
	const gadgetCache = new Map();
	const gadgetProxy = new Proxy(raw.gadget, {
		apply(t, thisArg, args) {   // 利用者のガジェット登録＝this を顔に（旗つきの頁で this.getZoom() が MapLibre の z）
			let [name, fn] = args;
			if (typeof name === "function") { fn = name; name = fn.name; }
			return raw.gadget(name, function (...a) { return fn.apply(facade, a); });
		},
		get(t, k) {
			const g = raw.gadget[k];
			if (typeof k !== "string" || typeof g !== "function") return g;
			let w = gadgetCache.get(k);
			if (!w) { w = (...args) => out(gadgetOut(k, raw.gadget[k](...gadgetArgsIn(k, args)))); gadgetCache.set(k, w); }
			return w;
		},
	});

	// ── map.raster（spec の minZoom/maxZoom は source の tile z＝換算しない・opts は表示窓＝換算する）──
	const rasterConv = {
		add: (id, spec, o) => raw.raster.add(id, spec, rangeIn(o)),
		set: (id, o) => raw.raster.set(id, rangeIn(o)),
		list: () => raw.raster.list().map(e => e && typeof e === "object" ? { ...e, opts: rangeOut(e.opts) } : e),
	};
	const rasterCache = new Map();
	const rasterProxy = raw.raster && new Proxy(raw.raster, {
		get(t, k) {
			if (!(k in rasterConv)) return Reflect.get(t, k);
			let w = rasterCache.get(k);
			if (!w) { w = (...a) => out(rasterConv[k](...a)); rasterCache.set(k, w); }
			return w;
		},
	});

	const cache = new Map();
	facade = new Proxy(raw, {
		get(t, k) {
			if (k === RAW) return raw;
			if (k === "gadget") return gadgetProxy;
			if (k === "raster") return rasterProxy;
			if (k === "view") { const v = raw.view; return v && typeof v === "object" ? { ...v, zoom: zo(v.zoom) } : v; }   // view.hash は文字列＝エンジン z のまま
			const c = CONV[k], v = Reflect.get(raw, k);
			if (!c && (typeof v !== "function" || k === "Marker" || k === "Popup")) return v;   // クラスは new で使う＝包まない
			let w = cache.get(k);
			if (!w) { w = c ? (...a) => out(c(...a)) : (...a) => out(raw[k](...a)); cache.set(k, w); }
			return w;
		},
		has(t, k) { return k === RAW || Reflect.has(raw, k); },
	});
	return facade;
}
