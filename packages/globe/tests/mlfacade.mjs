// 外側の顔（src/mlfacade.js）の単体検定（MapLibre 互換の台帳 R1〜R3・2026-09-26）。偽の素の map を相手に、換算・同一性・イベント・ガジェット・raster を突く。
// 実描画での一巡は t-mlzoom.html（旗あり/なし）。使い方：node packages/globe/tests/mlfacade.mjs
import { createFacade, FACADE_CONV } from "../src/mlfacade.js";
import { RAW, MAP_MEMBERS } from "../src/zoomscale.js";
import { shiftZoomExpr } from "../../ortho-core/src/mlstyle.js";

let bad = 0, n = 0;
const ok = (name, cond, note = "") => { n++; if (!cond) { bad++; console.log(`✗ ${name}${note ? ` (${note})` : ""}`); } };
const deq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 偽の素の map（エンジンの z で動く・呼ばれた引数を覚える）
function fakeRaw() {
	const calls = [], ev = {}, layerEv = [];
	const raw = {
		calls, _z: 11, _min: -17, _max: 20,
		get view() { return { center: [1, 2], zoom: raw._z, pitch: 0.1, bearing: 0.2, hash: `#${raw._z}/2/1` }; },
		cam: { zoom: 11 },
		jumpTo(o) { calls.push(["jumpTo", o]); if (o?.zoom != null) raw._z = o.zoom; return raw; },
		easeTo(o) { calls.push(["easeTo", o]); return Promise.resolve(); },
		flyTo(...a) { calls.push(["flyTo", a]); return Promise.resolve(); },
		setZoom(z) { raw._z = z; return raw; }, getZoom: () => raw._z,
		fitBounds(b, o) { calls.push(["fitBounds", o]); return Promise.resolve(); },
		cameraForBounds(b, o) { calls.push(["cameraForBounds", o]); return { center: [0, 0], zoom: 13, pitch: 0, bearing: 0, padding: {} }; },
		fitZoomForBbox: () => 9,
		setMinZoom(z) { raw._min = z; return raw; }, getMinZoom: () => raw._min, setZoomMin(z) { raw._min = z; }, zoomMin: () => raw._min,
		setMaxZoom(z) { raw._max = z; return raw; }, getMaxZoom: () => raw._max,
		addGint(pbf, o) { calls.push(["addGint", o]); return { id: "h" }; },
		applyGintData(pbf, label, move, o) { calls.push(["applyGintData", o]); return pbf; },
		paint(p, f) { calls.push(["paint", p, f]); return Promise.resolve(); },
		queryRenderedFeatures: async () => [{ id: 1, expansionZoom: 15 }, { id: 2 }],
		setStyle: async () => raw,
		on(e, a, b) { if (typeof a === "function" || b == null) (ev[e] ||= []).push(a); else layerEv.push({ e, key: a, cb: b }); return raw; },
		off(e, a, b) { if (typeof a === "function" || b == null) { const l = ev[e] || []; const i = l.indexOf(a); if (i >= 0) l.splice(i, 1); } else { const i = layerEv.findIndex(L => L.e === e && L.cb === b); if (i >= 0) layerEv.splice(i, 1); } return raw; },
		emit(e, payload) { for (const f of [...(ev[e] || [])]) f(payload); },
		emitLayer(e, payload) { for (const L of [...layerEv]) if (L.e === e) L.cb(payload); },
		count: e => (ev[e] || []).length, layerCount: () => layerEv.length,
		Marker: class Marker {},
		raster: {
			add(id, spec, o) { calls.push(["raster.add", spec, o]); return Promise.resolve({ id }); },
			set(id, o) { calls.push(["raster.set", o]); return true; },
			list: () => [{ id: "r", spec: { minZoom: 3 }, opts: { minZoom: 12, maxZoom: 16, opacity: 1 } }],
			remove: () => true,
		},
	};
	raw.gadget = function (name, fn) { raw.gadget[name] = function (...a) { calls.push(["gadget." + name, a]); return fn.apply(raw, a); }; };
	raw.gadget("zoom", function (o) { return o; });
	raw.gadget("spotlight", function (src, o) { return o; });
	raw.gadget("home", function (o) { return o; });
	raw.gadget("heatmap", function (src, layer) { return layer; });
	raw.gadget("contextmenu", function (o) { const items = o.items; return it2 => it2; });
	raw.gadget("shot", function () { return { composite() {} }; });
	return raw;
}

const raw = fakeRaw();
const f = createFacade(raw, 1, { shiftZoomExpr });

// 旗なし＝素の map そのもの
ok("noFlagReturnsRaw", createFacade(raw, 0, { shiftZoomExpr }) === raw);
ok("rawKey", f[RAW] === raw && RAW in f);
// カメラ
ok("jumpTo", f.jumpTo({ zoom: 10 }) === f && raw.calls.at(-1)[1].zoom === 11);
ok("getZoom", f.getZoom() === 10);
ok("view", f.view.zoom === 10 && f.view.hash === "#11/2/1" && f.view.pitch === 0.1, JSON.stringify(f.view));
ok("setZoomChain", f.setZoom(9) === f && raw._z === 10);
await f.flyTo({ center: [1, 2], zoom: 12 }); ok("flyToObj", raw.calls.at(-1)[1][0].zoom === 13);
await f.flyTo(1, 2, 12, 30, 40); ok("flyToPos", deq(raw.calls.at(-1)[1], [1, 2, 13, 30, 40]));
await f.flyTo(1, 2, f.getZoom()); ok("flyToGetZoomRoundtrip", raw.calls.at(-1)[1][2] === raw._z, `${raw.calls.at(-1)[1][2]} vs ${raw._z}`);   // sats.js の形
await f.easeTo({ zoom: 5 }); ok("easeTo", raw.calls.at(-1)[1].zoom === 6);
await f.fitBounds([0, 0, 1, 1], { maxZoom: 13 }); ok("fitBoundsMax", raw.calls.at(-1)[1].maxZoom === 14);
await f.fitBounds([0, 0, 1, 1]); ok("fitBoundsNoOpts", raw.calls.at(-1)[1] === undefined);
const cb = f.cameraForBounds([0, 0, 1, 1], { maxZoom: 13 }); ok("cameraForBounds", cb.zoom === 12 && raw.calls.at(-1)[1].maxZoom === 14);
ok("fitZoomForBbox", f.fitZoomForBbox([0, 0, 1, 1]) === 8);
ok("minMax", f.setMinZoom(3) === f && raw._min === 4 && f.getMinZoom() === 3 && f.setMaxZoom(18) === f && raw._max === 19 && f.getMaxZoom() === 18);
f.setMinZoom(null); ok("nullPassthrough", raw._min === null, String(raw._min));
f.setZoomMin(2.5); ok("zoomMin", raw._min === 3.5 && f.zoomMin() === 2.5);
// 同一性・Promise の解決値
ok("methodIdentity", f.jumpTo === f.jumpTo && f.getZoom === f.getZoom && f.gadget.zoom === f.gadget.zoom && f.raster.add === f.raster.add);
ok("setStyleResolvesFacade", (await f.setStyle({})) === f);
ok("classesUnwrapped", f.Marker === raw.Marker);
ok("camRaw", f.cam === raw.cam);
// gint
f.addGint({}, { minZoom: 9, label: { field: "n", minZoom: 10 }, style: { maxZoom: 15 } });
{ const o = raw.calls.at(-1)[1]; ok("addGint", o.minZoom === 10 && o.label.minZoom === 11 && o.style.maxZoom === 16 && o._dz === 1, JSON.stringify(o)); }
f.addGint({}); ok("addGintNoOpts", raw.calls.at(-1)[1]._dz === 1 && raw.calls.at(-1)[1].minZoom === undefined);
f.applyGintData({}, "x", false, { minZoom: 6 }); ok("applyGintData", raw.calls.at(-1)[1].minZoom === 7);
await f.paint({ "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 4] }, ["<", ["zoom"], 12]);
{ const [, p, fl] = raw.calls.at(-1); ok("paintExpr", deq(p["line-width"][2], ["-", ["zoom"], 1]) && deq(fl[1], ["-", ["zoom"], 1]), JSON.stringify([p, fl])); }
// 問い合わせ
const qs = await f.queryRenderedFeatures([1, 2]); ok("queryExpansionZoom", qs[0].expansionZoom === 14 && qs[1].expansionZoom === undefined);
// イベント
let got = null; const h = e => { got = e; };
f.on("move", h); raw.emit("move", { zoom: 12, center: [0, 0] }); ok("moveZoom", got?.zoom === 11);
f.off("move", h); ok("offRemoves", raw.count("move") === 0);
got = null; raw.emit("move", { zoom: 12 }); ok("offSilent", got === null);
f.on("settle", h); raw.emit("settle", { zoom: 8, hash: "#8/0/0" }); ok("settleHashKept", got.zoom === 7 && got.hash === "#8/0/0"); f.off("settle", h);
const p1 = f.once("settle"); raw.emit("settle", { zoom: 5, hash: "#5/0/0" }); const e1 = await p1; ok("oncePromise", e1.zoom === 4 && raw.count("settle") === 0);
let onceN = 0; f.once("move", () => onceN++); raw.emit("move", { zoom: 3 }); raw.emit("move", { zoom: 3 }); ok("onceCallback", onceN === 1 && raw.count("move") === 0);
let le = null; const lh = e => { le = e; };
f.on("click", "fb", lh); raw.emitLayer("click", { target: raw, features: [{ expansionZoom: 10 }] }); ok("layerEvent", le.target === f && le.features[0].expansionZoom === 9);
f.off("click", "fb", lh); ok("layerOff", raw.layerCount() === 0);
f.on("load", h); raw.emit("load", {}); ok("otherEventsPass", deq(got, {})); f.off("load", h);
// ガジェット
ok("gadgetOpts", f.gadget.zoom({ zoomMin: 3, zoomMax: 18 }).zoomMin === 4 && f.gadget.zoom({ zoomMax: 18 }).zoomMax === 19);
ok("gadgetDisplayRange", deq(f.gadget.zoom({ zoom: [5, 8] }).zoom, [6, 9]));
ok("gadgetArg1", f.gadget.spotlight("JP", { maxZoom: 7 }).maxZoom === 8);
ok("gadgetView", deq(f.gadget.home({ view: [135, 35, 5] }).view, [135, 35, 6]));
ok("gadgetLayerUntouched", f.gadget.heatmap({}, { minzoom: 5 }).minzoom === 5);   // 層の gadget は中の PUBLIC_DZ が換算
ok("gadgetResultFacade", f.gadget.shot() !== raw);
f.gadget("mine", function () { return this; });
ok("userGadgetThis", raw.gadget.mine() === f && f.gadget.mine() === f);
let cmMap = null; const setItems = f.gadget.contextmenu({ items: [{ name: "a", onClick: c => { cmMap = c.map; } }] });
raw.calls.filter(c => c[0] === "gadget.contextmenu").at(-1)[1][0].items[0].onClick({ map: raw, x: 0, y: 0 }); ok("contextmenuMap", cmMap === f);
const passed = setItems([{ name: "b", onClick: c => { cmMap = c.map; } }]); cmMap = null; passed[0].onClick({ map: raw }); ok("contextmenuSetItems", cmMap === f);
ok("gadgetFnProps", typeof f.gadget === "function" && f.gadget.length === raw.gadget.length);
// raster（spec＝tile z は換算しない・opts＝表示窓は換算する）
await f.raster.add("r", { url: "x/{z}/{x}/{y}", minZoom: 3, maxZoom: 16 }, { minZoom: 12, opacity: 1 });
{ const [, spec, o] = raw.calls.at(-1); ok("rasterAdd", spec.minZoom === 3 && spec.maxZoom === 16 && o.minZoom === 13 && o.opacity === 1); }
f.raster.set("r", { maxZoom: 15 }); ok("rasterSet", raw.calls.at(-1)[1].maxZoom === 16);
{ const e = f.raster.list()[0]; ok("rasterList", e.opts.minZoom === 11 && e.opts.maxZoom === 15 && e.spec.minZoom === 3); }
ok("rasterPassthrough", f.raster.remove("r") === true);

// 表との突き合わせ：in/out/io/event の公開メンバーは全部ここで換算している（view は getter・gadget/raster は専用の代理）
for (const [k, kind] of Object.entries(MAP_MEMBERS)) {
	if (["in", "out", "io", "event"].includes(kind) && !FACADE_CONV.includes(k) && k !== "view") ok(`covered:${k}`, false, `zoomscale says "${kind}" but mlfacade does not convert it`);
}
for (const k of FACADE_CONV) ok(`classified:${k}`, ["in", "out", "io", "event"].includes(MAP_MEMBERS[k]), `mlfacade converts "${k}" but zoomscale says "${MAP_MEMBERS[k]}"`);

console.log(bad ? `mlfacade: ${bad}/${n} failed` : `✓ mlfacade PASS（${n} checks）`);
process.exit(bad ? 1 : 0);
