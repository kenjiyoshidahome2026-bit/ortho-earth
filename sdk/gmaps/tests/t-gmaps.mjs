// @ortho-earth/gmaps＝google.maps の口を偽の maplibregl に通す（DOM は最小の偽物・node だけ）。
//   値の型（LatLng・LatLngBounds・MVCArray・event）・geometry の数値・Map の起動オプションとカメラ（zoom の 1 段差）・事象の通訳・
//   Marker／AdvancedMarker／InfoWindow・図形の source と layer・Data の様式・未対応の報告
import { createGoogleMaps, installGlobal, LatLng, LatLngBounds, MVCArray, event, geometry, unsupportedReport } from "../src/index.ts";
let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const tick = () => new Promise(r => setTimeout(r, 5));
const warns = []; console.warn = m => warns.push(String(m));

// ── 最小の DOM ──
class El {
	constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.l = {}; this.title = ""; this.className = ""; this.textContent = ""; this.innerHTML = ""; this.offsetHeight = 0;
		const st = { setProperty: (k, v) => { st[k] = v; } }; this.style = st; }
	appendChild(c) { this.children.push(c); c.parent = this; return c; }
	insertBefore(c) { return this.appendChild(c); }
	replaceChildren(...c) { this.children = c; }
	remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
	addEventListener(n, f) { (this.l[n] ||= []).push(f); }
	removeEventListener(n, f) { this.l[n] = (this.l[n] || []).filter(x => x !== f); }
	dispatch(n, ev = { type: n, stopPropagation() {} }) { for (const f of this.l[n] || []) f(ev); return ev; }
	querySelector() { return null; }
}
globalThis.document = { createElement: t => new El(t) };

// ── 偽の maplibregl：呼ばれた口を記録する ──
class Evented {
	constructor() { this.ev = {}; }
	on(t, a, b) { const k = typeof a === "string" ? `${t}@${a}` : t; (this.ev[k] ||= []).push(b ?? a); return this; }
	off(t, a, b) { const k = typeof a === "string" ? `${t}@${a}` : t, f = b ?? a; this.ev[k] = (this.ev[k] || []).filter(x => x !== f); return this; }
	once(t, f) { const w = e => { this.off(t, w); f(e); }; return this.on(t, w); }
	fire(k, e = {}) { for (const f of [...(this.ev[k] || [])]) f(e); }
}
class FMap extends Evented {
	constructor(o) { super(); FMap.last = this; this.o = o; this.c = o.center; this.z = o.zoom; this.b = o.bearing; this.p = o.pitch; this.sources = {}; this.layers = []; this.controls = []; this.calls = []; this.hits = []; this.canvas = new El("canvas"); }
	isStyleLoaded() { return false; }
	getCenter() { return { lng: this.c[0], lat: this.c[1] }; }
	getZoom() { return this.z; } getBearing() { return this.b; } getPitch() { return this.p; }
	jumpTo(o) { this.calls.push(["jumpTo", o]); if (o.center) this.c = o.center; if (o.zoom != null) this.z = o.zoom; if (o.bearing != null) this.b = o.bearing; if (o.pitch != null) this.p = o.pitch; }
	easeTo(o) { this.calls.push(["easeTo", o]); }
	panBy(o) { this.calls.push(["panBy", o]); }
	fitBounds(b, o) { this.calls.push(["fitBounds", b, o]); }
	getBounds() { return { getSouth: () => 30, getWest: () => 130, getNorth: () => 40, getEast: () => 145 }; }
	setStyle(s) { this.calls.push(["setStyle", s]); this.sources = {}; this.layers = []; }
	setMinZoom(z) { this.calls.push(["setMinZoom", z]); } setMaxZoom(z) { this.calls.push(["setMaxZoom", z]); } setMaxBounds(b) { this.calls.push(["setMaxBounds", b]); }
	addControl(c, pos) { this.controls.push([c, pos]); if (c.onAdd) c.onAdd(this); }
	addSource(id, s) { this.sources[id] = { ...s, setData: d => { this.sources[id].data = d; } }; }
	getSource(id) { return this.sources[id]; }
	removeSource(id) { delete this.sources[id]; }
	addLayer(l, before) { const i = before ? this.layers.findIndex(x => x.id === before) : -1; i >= 0 ? this.layers.splice(i, 0, l) : this.layers.push(l); }
	getLayer(id) { return this.layers.find(l => l.id === id); }
	removeLayer(id) { this.layers = this.layers.filter(l => l.id !== id); }
	setPaintProperty(id, k, v) { this.getLayer(id).paint[k] = v; }
	setLayoutProperty(id, k, v) { const l = this.getLayer(id); l.layout = { ...l.layout, [k]: v }; }
	queryRenderedFeatures(pt, o) { return this.hits.filter(h => o.layers.includes(h)); }
	getCanvas() { return this.canvas; }
}
class FMarker extends Evented {
	constructor(o) { super(); FMarker.all.push(this); this.o = o; this.ll = null; this.map = null; }
	setLngLat(ll) { this.ll = ll; return this; } getLngLat() { return this.ll && { lng: this.ll[0], lat: this.ll[1] }; }
	addTo(m) { this.map = m; return this; } remove() { this.map = null; this.removed = true; return this; }
	setDraggable(d) { this.o.draggable = d; return this; }
}
FMarker.all = [];
class FPopup extends Evented {
	constructor(o) { super(); FPopup.last = this; this.o = o; this.el = new El("div"); }
	setHTML(h) { this.html = h; return this; } setDOMContent(d) { this.dom = d; return this; }
	setLngLat(ll) { this.ll = ll; return this; } addTo(m) { this.map = m; return this; }
	remove() { this.map = null; this.fire("close"); return this; } setOffset(o) { this.o.offset = o; return this; } getElement() { return this.el; }
}
class Ctrl { constructor(o) { this.o = o; } onAdd() { return new El("div"); } }
const ml = { Map: FMap, Marker: FMarker, Popup: FPopup, NavigationControl: class extends Ctrl {}, FullscreenControl: class extends Ctrl {}, ScaleControl: class extends Ctrl {} };
const load = m => { m.isStyleLoaded = () => true; m.fire("load"); m.fire("style.load"); };

// ── 値の型 ──
{
	const a = new LatLng(35.68, 139.77), b = new LatLng({ lat: 95, lng: 190 });
	ok("LatLng", a.lat() === 35.68 && a.lng() === 139.77 && b.lat() === 90 && b.lng() === -170 && new LatLng(10, 200, true).lng() === 200 && a.toUrlValue(2) === "35.68,139.77" && a.equals({ lat: 35.68, lng: 139.77 }) && JSON.stringify(a) === '{"lat":35.68,"lng":139.77}');
	const bb = new LatLngBounds().extend({ lat: 1, lng: 2 }).extend(new LatLng(3, 4));
	ok("LatLngBounds", bb.contains({ lat: 2, lng: 3 }) && !bb.contains({ lat: 5, lng: 3 }) && bb.getCenter().lat() === 2 && bb.getNorthEast().lng() === 4 && new LatLngBounds().isEmpty() && new LatLngBounds({ north: 3, south: 1, east: 4, west: 2 }).equals(bb) && bb.intersects({ north: 10, south: 2.5, east: 10, west: 3.5 }));
	const arr = new MVCArray([1, 2]), seen = [];
	const h = event.addListener(arr, "insert_at", i => seen.push(["i", i]));
	event.addListener(arr, "remove_at", (i, v) => seen.push(["r", i, v]));
	arr.push(3); arr.removeAt(0); h.remove(); arr.push(4);
	ok("MVCArray", JSON.stringify(seen) === '[["i",2],["r",0,1]]' && arr.getLength() === 3 && arr.getAt(0) === 2);
	const o = {}; let n = 0; event.addListenerOnce(o, "x", () => n++); event.trigger(o, "x"); event.trigger(o, "x");
	ok("event.once", n === 1 && !event.hasListeners(o, "x"));
}
// ── geometry ──
{
	const { spherical: s, encoding, poly } = geometry;
	const tokyo = { lat: 35.6812, lng: 139.7671 }, osaka = { lat: 34.7025, lng: 135.4959 };
	const d = s.computeDistanceBetween(tokyo, osaka);
	ok("distance", d > 400000 && d < 404000, d.toFixed(0));
	ok("heading", near(s.computeHeading({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }), 0) && near(s.computeHeading({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }), 90));
	const off = s.computeOffset(tokyo, 1000, 90);
	ok("offset", near(s.computeDistanceBetween(tokyo, off), 1000, 1e-3) && near(s.computeHeading(tokyo, off), 90, 0.01));
	const mid = s.interpolate({ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, 0.5);
	ok("interpolate", near(mid.lat(), 0) && near(mid.lng(), 5));
	const sq = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }], area = s.computeArea(sq);
	ok("area", area > 1.22e10 && area < 1.24e10 && s.computeSignedArea(sq) > 0 && s.computeSignedArea([...sq].reverse()) < 0, area.toExponential(3));
	ok("length", near(s.computeLength(sq.slice(0, 2)), s.computeDistanceBetween(sq[0], sq[1])));
	const enc = encoding.encodePath([{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }]);
	ok("encodePath", enc === "_p~iF~ps|U_ulLnnqC_mqNvxq`@", enc);
	ok("decodePath", JSON.stringify(encoding.decodePath(enc).map(p => p.toJSON())) === '[{"lat":38.5,"lng":-120.2},{"lat":40.7,"lng":-120.95},{"lat":43.252,"lng":-126.453}]');
	const pg = { getPath: () => new MVCArray(sq.map(p => new LatLng(p))) };
	ok("containsLocation", poly.containsLocation({ lat: 0.5, lng: 0.5 }, pg) && !poly.containsLocation({ lat: 2, lng: 0.5 }, pg) && poly.isLocationOnEdge({ lat: 0, lng: 0.5 }, pg, 1e-6));
}
const gm = createGoogleMaps(ml, { styles: { roadmap: "road.json", satellite: "sat.json" } });
// ── Map：起動オプション・zoom の 1 段差・操作部品 ──
const div = new El("div");
const map = new gm.Map(div, { center: { lat: 35.68, lng: 139.77 }, zoom: 15, heading: 30, tilt: 45, minZoom: 3, gestureHandling: "cooperative", draggable: false, restriction: { latLngBounds: { north: 46, south: 24, east: 154, west: 122 } } });
const m = FMap.last;
ok("Map.options", m.o.container === div && m.o.center[0] === 139.77 && m.o.center[1] === 35.68 && m.o.zoom === 14 && m.o.bearing === 30 && m.o.pitch === 45 && m.o.minZoom === 2 && m.o.cooperativeGestures === true && m.o.dragPan === false && m.o.style === "road.json" && JSON.stringify(m.o.maxBounds) === "[[122,24],[154,46]]");
ok("Map.defaultUI", m.controls.length === 2 && m.controls[0][1] === "bottom-right" && m.controls[1][1] === "top-right");
ok("Map.camera", map.getZoom() === 15 && map.getCenter().lat() === 35.68 && map.getHeading() === 30 && map.getTilt() === 45);
map.setZoom(10); map.setCenter({ lat: 1, lng: 2 }); map.panBy(10, 20);
ok("Map.setters", m.z === 9 && m.c[0] === 2 && m.c[1] === 1 && JSON.stringify(m.calls.at(-1)) === '["panBy",[10,20]]');
map.fitBounds(new LatLngBounds({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }), 20);
ok("Map.fitBounds", JSON.stringify(m.calls.at(-1)) === '["fitBounds",[[2,1],[4,3]],{"padding":20,"animate":false}]');
ok("Map.getBounds", map.getBounds().toJSON().east === 145);
map.setMapTypeId(gm.MapTypeId.HYBRID);
ok("Map.mapType", map.getMapTypeId() === "hybrid" && JSON.stringify(m.calls.at(-1)) === '["setStyle","sat.json"]');
const ctl = new El("button"); map.controls[gm.ControlPosition.TOP_CENTER].push(ctl); map.controls[gm.ControlPosition.LEFT_TOP].push(new El("div"));
ok("Map.controls", div.children.length === 1 && div.children[0].children[0].children[0] === ctl && m.controls.at(-1)[1] === "top-left");
const p = map.getProjection().fromLatLngToPoint({ lat: 0, lng: 0 });
ok("Map.projection", near(p.x, 128) && near(p.y, 128) && near(map.getProjection().fromPointToLatLng(p).lat(), 0));
// ── 事象 ──
const got = [];
map.addListener("click", e => got.push(["click", e.latLng.lat(), e.pixel.x]));
map.addListener("zoom_changed", () => got.push(["zoom", map.getZoom()]));
map.addListener("idle", () => got.push(["idle"]));
map.addListener("rightclick", () => got.push(["right"]));
m.fire("click", { lngLat: { lng: 5, lat: 6 }, point: { x: 7, y: 8 }, originalEvent: {} });
m.z = 11; m.fire("zoom"); m.fire("zoom"); m.fire("idle"); m.fire("contextmenu", {});
ok("Map.events", JSON.stringify(got) === '[["click",6,7],["zoom",12],["idle"],["right"]]', JSON.stringify(got));
// ── Marker：準備前に作っても地図の上に出る・位置・drag・click は地図の click にならない ──
const mk = new gm.Marker({ position: { lat: 35, lng: 139 }, map, title: "Tokyo", label: "A" });
const fm = FMarker.all.at(-1);
ok("Marker.add", fm.map === m && fm.ll[0] === 139 && fm.o.anchor === "bottom" && fm.o.element.title === "Tokyo" && mk.getPosition().lat() === 35);
let mclick = 0; mk.addListener("click", e => { mclick += e.latLng.lng() === 139 ? 1 : 0; });
const domEv = fm.o.element.dispatch("click");
m.fire("click", { lngLat: { lng: 0, lat: 0 }, point: { x: 0, y: 0 }, originalEvent: domEv });
ok("Marker.click", mclick === 1 && got.filter(g => g[0] === "click").length === 1);
const moved = []; mk.addListener("dragend", e => moved.push(e.latLng.lat())); mk.addListener("position_changed", () => moved.push("pc"));
fm.ll = [140, 36]; fm.fire("drag"); fm.fire("dragend");
ok("Marker.drag", JSON.stringify(moved) === '["pc",36]' && mk.getPosition().lng() === 140);
mk.setIcon({ url: "x.png", scaledSize: new gm.Size(20, 30), anchor: new gm.Point(10, 30) });
const fm2 = FMarker.all.at(-1);
ok("Marker.icon", fm.removed && fm2 !== fm && fm2.o.anchor === "top-left" && fm2.o.offset[0] === -10 && fm2.o.offset[1] === -30);
mk.setVisible(false); ok("Marker.visible", fm2.o.element.style.display === "none");
mk.setMap(null); ok("Marker.remove", fm2.removed && mk.getMap() === null);
const sym = new gm.Marker({ position: { lat: 0, lng: 0 }, map, icon: { path: gm.SymbolPath.CIRCLE, scale: 8, fillColor: "#f00", fillOpacity: 1 } });
ok("Marker.symbol", FMarker.all.at(-1).o.element.innerHTML.includes("A 1,1") && FMarker.all.at(-1).o.element.innerHTML.includes("scale(8)") && !!sym);
// AdvancedMarkerElement＋PinElement
const pin = new gm.marker.PinElement({ background: "#00f", glyph: "★" });
const adv = new gm.marker.AdvancedMarkerElement({ map, position: { lat: 1, lng: 2 }, content: pin.element, title: "adv" });
const fa = FMarker.all.at(-1);
ok("AdvancedMarker", fa.o.element === adv.element && adv.element.children[0] === pin.element && pin.element.innerHTML.includes("#00f") && adv.element.title === "adv");
adv.position = { lat: 3, lng: 4 }; ok("AdvancedMarker.position", fa.ll[0] === 4 && adv.position.lat() === 3);
let gmp = 0; adv.addListener("click", () => gmp++); adv.addEventListener("gmp-click", () => gmp++); adv.element.dispatch("click");
ok("AdvancedMarker.click", gmp === 2);
// ── InfoWindow：marker の上に開く・閉じる・closeclick ──
const iw = new gm.InfoWindow({ content: "<b>hi</b>", pixelOffset: new gm.Size(0, -5) });
const mk2 = new gm.Marker({ position: { lat: 10, lng: 20 }, map });
iw.open({ map, anchor: mk2 });
const pp = FPopup.last;
ok("InfoWindow.open", pp.html === "<b>hi</b>" && pp.ll[0] === 20 && pp.map === m && pp.o.offset[1] === -48 && pp.o.closeOnClick === false && iw.isOpen);
mk2.setPosition({ lat: 11, lng: 21 }); ok("InfoWindow.follow", pp.ll[0] === 21);
const iwEv = []; iw.addListener("closeclick", () => iwEv.push("cc")); iw.addListener("close", () => iwEv.push("close"));
iw.close(); ok("InfoWindow.close", !iw.isOpen && JSON.stringify(iwEv) === '["close"]');
iw.open(map, mk2); FPopup.last.remove(); ok("InfoWindow.closeclick", JSON.stringify(iwEv) === '["close","cc","close"]');
// ── 図形：準備前は待つ・load で source と layer・様式・path の変化・click ──
const line = new gm.Polyline({ path: [{ lat: 0, lng: 0 }, { lat: 0, lng: 10 }], strokeColor: "#f00", strokeWeight: 4, map });
ok("Polyline.wait", Object.keys(m.sources).length === 0);
load(m);
const lid = Object.keys(m.sources)[0];
ok("Polyline.add", m.sources[lid].data.geometry.coordinates.length === 2 && m.getLayer(`${lid}-line`).paint["line-color"] === "#f00" && m.getLayer(`${lid}-line`).paint["line-width"] === 4);
line.getPath().push(new LatLng(5, 5)); ok("Polyline.mvc", m.sources[lid].data.geometry.coordinates.length === 3);
line.setOptions({ strokeColor: "#0f0", geodesic: true });
ok("Polyline.options", m.getLayer(`${lid}-line`).paint["line-color"] === "#0f0" && m.sources[lid].data.geometry.coordinates.length > 3);
const pg = new gm.Polygon({ paths: [[{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }], [{ lat: 0.2, lng: 0.5 }, { lat: 0.3, lng: 0.6 }, { lat: 0.2, lng: 0.6 }]], fillColor: "#00f", fillOpacity: 0.5, zIndex: -1, map });
const pid = Object.keys(m.sources)[1];
ok("Polygon", m.sources[pid].data.geometry.coordinates.length === 2 && m.sources[pid].data.geometry.coordinates[0].length === 4 && m.getLayer(`${pid}-fill`).paint["fill-opacity"] === 0.5);
ok("zIndex.order", m.layers.findIndex(l => l.id === `${pid}-fill`) < m.layers.findIndex(l => l.id === `${lid}-line`));
let pclick = 0; pg.addListener("click", e => { pclick += e.latLng ? 1 : 0; });
const ce = { lngLat: { lng: 0.5, lat: 0.5 }, point: { x: 1, y: 1 }, originalEvent: {} };
m.hits = [`${pid}-fill`]; m.fire(`click@${pid}-fill`, ce); m.fire(`click@${pid}-line`, ce); m.fire("click", ce); m.hits = [];
ok("Polygon.click", pclick === 1 && got.filter(g => g[0] === "click").length === 1);
const circle = new gm.Circle({ center: { lat: 35, lng: 139 }, radius: 1000, map });
const cid = Object.keys(m.sources)[2], cr = m.sources[cid].data.geometry.coordinates[0];
ok("Circle", cr.length === 73 && near(geometry.spherical.computeDistanceBetween({ lat: 35, lng: 139 }, { lat: cr[10][1], lng: cr[10][0] }), 1000, 1e-3) && near(circle.getBounds().getNorthEast().lat(), geometry.spherical.computeOffset({ lat: 35, lng: 139 }, 1000, 0).lat()));
circle.setRadius(2000); ok("Circle.radius", circle.getRadius() === 2000 && m.sources[cid].data.geometry.coordinates[0][0][1] > cr[0][1]);
new gm.Rectangle({ bounds: { north: 2, south: 1, east: 4, west: 3 }, map });
ok("Rectangle", JSON.stringify(m.sources[Object.keys(m.sources)[3]].data.geometry.coordinates) === "[[[3,1],[4,1],[4,2],[3,2],[3,1]]]");
line.setVisible(false); ok("Shape.visible", m.getLayer(`${lid}-line`).layout.visibility === "none");
line.setMap(null); ok("Shape.remove", !m.getSource(lid) && !m.getLayer(`${lid}-line`));
// style を替えると図形を載せ直す
map.setMapTypeId("roadmap"); m.fire("style.load");
ok("Shape.restyle", !!m.getSource(pid) && !!m.getLayer(`${pid}-fill`) && !m.getSource(lid));
// ── Data：GeoJSON・関数の様式・overrideStyle・click の feature ──
const feats = map.data.addGeoJson({ type: "FeatureCollection", features: [
	{ type: "Feature", id: "a", properties: { kind: "park" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } },
	{ type: "Feature", id: "b", properties: { kind: "shop" }, geometry: { type: "Point", coordinates: [5, 6] } },
] });
map.data.setStyle(f => ({ fillColor: f.getProperty("kind") === "park" ? "green" : "red", strokeWeight: 1 }));
await tick();
const did = Object.keys(m.sources).find(k => k.startsWith("gm-data")), dd = m.sources[did].data.features;
ok("Data.add", feats.length === 2 && dd.length === 2 && dd[0].properties._gm_fc === "green" && dd[0].properties.kind === "park" && dd[1].properties._gm_fc === "red" && map.data.getFeatureById("b").getGeometry().get().lat() === 6);
map.data.overrideStyle(feats[0], { fillColor: "blue" }); await tick();
ok("Data.override", m.sources[did].data.features[0].properties._gm_fc === "blue");
map.data.revertStyle(); feats[1].setProperty("kind", "park"); await tick();
ok("Data.revert+setProperty", m.sources[did].data.features[0].properties._gm_fc === "green" && m.sources[did].data.features[1].properties._gm_fc === "green");
let dclick = null; map.data.addListener("click", e => { dclick = e.feature.getId(); });
m.fire(`click@${did}-point`, { ...ce, features: [{ properties: { _gm_i: 1 } }] });
ok("Data.click", dclick === "b");
let gj = null; map.data.toGeoJson(o => { gj = o; }); ok("Data.toGeoJson", gj.features.length === 2 && gj.features[0].id === "a" && !("_gm_fc" in gj.features[0].properties));
map.data.remove(feats[0]); await tick(); ok("Data.remove", m.sources[did].data.features.length === 1 && !map.data.getFeatureById("a"));
const pt = new gm.Data.Point({ lat: 1, lng: 2 }); ok("Data.Point", pt.getType() === "Point" && pt.get().lng() === 2);
// ── 未対応：投げずに報告・Google の services は拒む ──
warns.length = 0;
new gm.Map(new El("div"), { styles: [{ featureType: "water" }] });
const geocoder = new gm.Geocoder();
let rejected = false; await geocoder.geocode({ address: "Tokyo" }).catch(() => { rejected = true; });
ok("unsupported", rejected && warns.some(w => w.includes("MapOptions.styles")) && warns.some(w => w.includes("google.maps.Geocoder")) && unsupportedReport().length >= 2);
ok("importLibrary", (await gm.importLibrary("maps")).Map === gm.Map && (await gm.importLibrary("marker")).AdvancedMarkerElement === gm.marker.AdvancedMarkerElement && (await gm.importLibrary("geometry")).spherical === geometry.spherical);
ok("installGlobal", installGlobal(gm) === globalThis.google.maps);
ok("needsMaplibre", (() => { try { createGoogleMaps({}); return false; } catch { return true; } })());
if (fails) { console.error(`${fails} failed`); process.exit(1); } else console.log("ALL PASS gmaps");
