// @ortho-earth/leaflet＝Leaflet の口を偽の maplibregl に通す（DOM は最小の偽物・node だけ）。
//   値の型（LatLng・Bounds・CRS）・Class.extend と事象の伝播・Map の起動オプションとカメラ（zoom の 1 段差・fitBounds の段）・
//   TileLayer／WMS の source と重ね順・図形が一つの source に入る様式・GeoJSON・click の行き先（図形→群→地図、marker は地図へ届かない）・
//   Popup／Tooltip・Layers 操作部品・marker の drag・未対応の報告
import { createLeaflet, installGlobal, unsupportedReport } from "../src/index.ts";
let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const tick = () => new Promise(r => setTimeout(r, 5));
const warns = []; console.warn = m => warns.push(String(m));

// ── 最小の DOM ──
class El {
	constructor(tag) {
		this.tagName = tag.toUpperCase(); this.children = []; this.l = {}; this.attrs = {}; this.title = ""; this.className = ""; this.textContent = ""; this._html = ""; this.clientWidth = 0; this.clientHeight = 0;
		const st = { setProperty: (k, v) => { st[k] = v; } }; this.style = st;
		const self = this;
		this.classList = { add: (...c) => { for (const x of c) if (!self.className.split(" ").includes(x)) self.className = `${self.className} ${x}`.trim(); }, remove: c => { self.className = self.className.split(" ").filter(x => x !== c).join(" "); }, contains: c => self.className.split(" ").includes(c) };
	}
	get innerHTML() { return this._html; } set innerHTML(v) { this._html = v; this.children = []; }
	get firstChild() { return this.children[0] ?? null; }
	get parentNode() { return this.parent ?? null; }
	appendChild(c) { c.parent?.removeChild(c); this.children.push(c); c.parent = this; return c; }
	insertBefore(c, ref) { c.parent?.removeChild(c); const i = this.children.indexOf(ref); i >= 0 ? this.children.splice(i, 0, c) : this.children.push(c); c.parent = this; return c; }
	removeChild(c) { this.children = this.children.filter(x => x !== c); c.parent = null; return c; }
	replaceChildren(...c) { this.children = []; for (const x of c) this.appendChild(x); }
	remove() { this.parent?.removeChild(this); }
	setAttribute(k, v) { this.attrs[k] = v; }
	addEventListener(n, f) { (this.l[n] ||= []).push(f); }
	removeEventListener(n, f) { this.l[n] = (this.l[n] || []).filter(x => x !== f); }
	dispatch(n, ev = {}) { ev.type = n; ev.stopPropagation ||= () => { ev.stopped = true; }; ev.preventDefault ||= () => {}; for (const f of [...(this.l[n] || [])]) f(ev); return ev; }
	getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
	find(f) { if (f(this)) return this; for (const c of this.children) { const r = c.find?.(f); if (r) return r; } return null; }
}
const byId = {};
globalThis.document = { createElement: t => new El(t), getElementById: id => byId[id] ?? null, head: null };

// ── 偽の maplibregl：Web Mercator（512 px の世界）で project／unproject・呼ばれた口を記録する ──
class Evented {
	constructor() { this.ev = {}; }
	on(t, a, b) { const k = typeof a === "string" ? `${t}@${a}` : t; (this.ev[k] ||= []).push(b ?? a); return this; }
	off(t, a, b) { const k = typeof a === "string" ? `${t}@${a}` : t, f = b ?? a; this.ev[k] = (this.ev[k] || []).filter(x => x !== f); return this; }
	once(t, f) { const w = e => { this.off(t, w); f(e); }; return this.on(t, w); }
	fire(k, e = {}) { for (const f of [...(this.ev[k] || [])]) f(e); }
}
const merc = (lng, lat, z) => { const s = 512 * 2 ** z, sin = Math.sin(lat * Math.PI / 180); return [s * (0.5 + lng / 360), s * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI))]; };
const unmerc = (x, y, z) => { const s = 512 * 2 ** z, n = Math.PI - 2 * Math.PI * y / s; return { lng: x / s * 360 - 180, lat: 180 / Math.PI * Math.atan(Math.sinh(n)) }; };
class FMap extends Evented {
	constructor(o) { super(); FMap.last = this; this.o = o; this.c = o.center; this.z = o.zoom; this.sources = {}; this.layers = []; this.controls = []; this.calls = []; this.hits = []; this.canvas = new El("canvas"); this.W = 800; this.H = 600;
		for (const h of ["dragPan", "scrollZoom", "boxZoom", "doubleClickZoom", "keyboard", "touchZoomRotate", "dragRotate"]) { const st = { on: o[h] !== false }; this[h] = { enable: () => { st.on = true; }, disable: () => { st.on = false; }, isEnabled: () => st.on, disableRotation: () => { this.calls.push(["disableRotation"]); } }; } }
	isStyleLoaded() { return false; }
	getCenter() { return { lng: this.c[0], lat: this.c[1] }; }
	getZoom() { return this.z; }
	jumpTo(o) { this.calls.push(["jumpTo", o]); if (o.center) this.c = o.center; if (o.zoom != null) this.z = o.zoom; }
	easeTo(o) { this.calls.push(["easeTo", o]); if (o.center) this.c = o.center; if (o.zoom != null) this.z = o.zoom; }
	flyTo(o) { this.calls.push(["flyTo", o]); }
	panBy(o, opt) { this.calls.push(["panBy", o, opt]); }
	stop() {}
	resize() { this.calls.push(["resize"]); }
	project(ll) { const [cx, cy] = merc(this.c[0], this.c[1], this.z), [x, y] = merc(ll[0], ll[1], this.z); return { x: x - cx + this.W / 2, y: y - cy + this.H / 2 }; }
	unproject(p) { const [cx, cy] = merc(this.c[0], this.c[1], this.z); return unmerc(p[0] + cx - this.W / 2, p[1] + cy - this.H / 2, this.z); }
	getBounds() { const sw = this.unproject([0, this.H]), ne = this.unproject([this.W, 0]); return { getSouth: () => sw.lat, getWest: () => sw.lng, getNorth: () => ne.lat, getEast: () => ne.lng }; }
	setMinZoom(z) { this.calls.push(["setMinZoom", z]); } setMaxZoom(z) { this.calls.push(["setMaxZoom", z]); } setMaxBounds(b) { this.calls.push(["setMaxBounds", b]); }
	addControl(c, pos) { this.controls.push([c, pos, c.onAdd(this)]); }
	removeControl(c) { const i = this.controls.findIndex(x => x[0] === c); if (i >= 0) { this.controls.splice(i, 1); c.onRemove?.(this); } }
	addSource(id, s) { this.sources[id] = { ...s, setData: d => { this.sources[id].data = d; this.sources[id].sets = (this.sources[id].sets || 0) + 1; } }; }
	getSource(id) { return this.sources[id]; }
	removeSource(id) { delete this.sources[id]; }
	addLayer(l, before) { const i = before ? this.layers.findIndex(x => x.id === before) : -1; i >= 0 ? this.layers.splice(i, 0, l) : this.layers.push(l); }
	moveLayer(id, before) { const l = this.getLayer(id); this.layers = this.layers.filter(x => x !== l); this.addLayer(l, before); }
	getLayer(id) { return this.layers.find(l => l.id === id); }
	removeLayer(id) { this.layers = this.layers.filter(l => l.id !== id); }
	setPaintProperty(id, k, v) { this.getLayer(id).paint[k] = v; }
	queryRenderedFeatures(pt, o) { return this.hits.filter(h => o.layers.includes(h.layer)).map(h => ({ id: h.id, properties: { _lid: h.id }, layer: { id: h.layer } })); }
	getCanvas() { return this.canvas; }
	getStyle() { return { sources: { base: { attribution: "© Base" }, ...this.sources } }; }
	remove() { this.removed = true; }
}
class FMarker extends Evented {
	constructor(o) { super(); FMarker.all.push(this); this.o = o; this.ll = null; this.map = null; }
	setLngLat(ll) { this.ll = ll; return this; } getLngLat() { return this.ll && { lng: this.ll[0], lat: this.ll[1] }; }
	addTo(m) { this.map = m; return this; } remove() { this.map = null; this.removed = true; return this; }
	setDraggable(d) { this.o.draggable = d; return this; }
}
FMarker.all = [];
class FPopup extends Evented {
	constructor(o) { super(); FPopup.all.push(this); this.o = o; this.el = new El("div"); }
	setHTML(h) { this.html = h; return this; } setDOMContent(d) { this.dom = d; return this; }
	setLngLat(ll) { this.ll = ll; return this; } addTo(m) { this.map = m; return this; }
	remove() { this.map = null; this.fire("close"); return this; } setOffset(o) { this.o.offset = o; return this; } getElement() { return this.el; }
}
FPopup.all = [];
const ml = { Map: FMap, Marker: FMarker, Popup: FPopup };
const load = m => { m.isStyleLoaded = () => true; m.fire("load"); m.fire("style.load"); };
const L = createLeaflet(ml);

// ── 値の型・Class・事象 ──
{
	const a = L.latLng(35.68, 139.77), b = L.latLng([1, 2]), c = L.latLng({ lat: 3, lon: 4 });
	ok("LatLng", a.lat === 35.68 && b.lng === 2 && c.lng === 4 && a.equals([35.68, 139.77]) && a.toString() === "LatLng(35.68, 139.77)" && L.latLng(null) === null);
	const d = L.latLng(35.6812, 139.7671).distanceTo([34.7025, 135.4959]);
	ok("distanceTo", d > 400000 && d < 404000, d.toFixed(0));
	const bb = L.latLngBounds([[1, 2], [3, 4]]);
	ok("LatLngBounds", bb.contains([2, 3]) && !bb.contains([5, 3]) && bb.getCenter().lat === 2 && bb.toBBoxString() === "2,1,4,3" && bb.pad(0.5).getNorth() === 4 && bb.intersects([[2.5, 3.5], [10, 10]]));
	const p = L.CRS.EPSG3857.latLngToPoint(L.latLng(0, 0), 0);
	ok("CRS", near(p.x, 128) && near(p.y, 128) && near(L.CRS.EPSG3857.pointToLatLng(L.point(128, 128), 0).lat, 0) && L.CRS.EPSG3857.scale(2) === 1024);
	ok("Util.template", L.Util.template("{a}/{b}", { a: 1, b: () => 2 }) === "1/2");
	const Base = L.Class.extend({ options: { a: 1, b: 2 }, initialize(o) { L.setOptions(this, o); }, hi() { return "base"; } });
	const Sub = Base.extend({ options: { b: 3 }, hi() { return "sub+" + Base.prototype.hi.call(this); } });
	let hooked = 0; Sub.addInitHook(function () { hooked = this.options.a; });
	Base.include({ extra: () => "x" }); Sub.mergeOptions({ c: 4 });
	const s = new Sub({ a: 9 });
	ok("Class.extend", s.options.a === 9 && s.options.b === 3 && s.options.c === 4 && new Base().options.c === undefined && s.hi() === "sub+base" && s.extra() === "x" && hooked === 9 && s instanceof Base && Sub.__super__ === Base.prototype);
	const parent = new L.Evented(), child = new L.Evented(), got = [];
	child.addEventParent(parent);
	parent.on("ping", e => got.push(["p", e.layer === child, e.target === parent, e.sourceTarget === child]));
	child.once("ping", () => got.push(["c"]));
	child.fire("ping", {}, true); child.fire("ping", {}, true);
	ok("Evented", JSON.stringify(got) === '[["c"],["p",true,true,true],["p",true,true,true]]' && parent.listens("ping") && child.listens("ping", true) && !child.listens("ping"), JSON.stringify(got));
}

// ── Map：起動オプション・zoom の 1 段差・操作部品 ──
const div = new El("div"); div.clientWidth = 800; div.clientHeight = 600; byId.map = div;
const map = L.map("map", { center: [35.68, 139.77], zoom: 13, minZoom: 3, dragging: false, maxBounds: [[24, 122], [46, 154]] });
const m = FMap.last;
ok("Map.options", m.o.container === div && m.o.center[0] === 139.77 && m.o.center[1] === 35.68 && m.o.zoom === 12 && m.o.minZoom === 2 && m.o.dragPan === false && m.o.attributionControl === false && m.o.dragRotate === false && JSON.stringify(m.o.maxBounds) === "[[122,24],[154,46]]" && JSON.stringify(m.o.style) === '{"version":8,"sources":{},"layers":[]}' && div.className.includes("leaflet-container"));
ok("Map.controls", m.controls.length === 2 && m.controls[0][1] === "bottom-right" && m.controls[1][1] === "top-left" && map.zoomControl && map.attributionControl && !map.dragging.enabled() && map.scrollWheelZoom.enabled());
let loaded = 0; map.whenReady(() => loaded++);
load(m); await tick();
ok("Map.load", loaded === 1 && map._loaded);
ok("Map.camera", map.getZoom() === 13 && map.getCenter().lat === 35.68 && map.getBounds().contains(map.getCenter()));
map.setView([1, 2], 10.4);
ok("Map.setView", m.z === 9 && m.c[0] === 2 && m.c[1] === 1, "zoomSnap 1 rounds 10.4 → 10");
map.panBy([10, 20], { animate: false });
ok("Map.panBy", JSON.stringify(m.calls.at(-1).slice(0, 2)) === '["panBy",[10,20]]');
map.fitBounds([[35, 139], [36, 140]]);
{
	const z = map.getZoom(), w = q => map.project([36, 140], q).x - map.project([35, 139], q).x, h = q => map.project([35, 139], q).y - map.project([36, 140], q).y;
	ok("Map.fitBounds", Number.isInteger(z) && w(z) <= 800 && h(z) <= 600 && (w(z + 1) > 800 || h(z + 1) > 600) && near(map.getCenter().lng, 139.5), `zoom ${z}`);
}
const cp = map.latLngToContainerPoint(map.getCenter());
ok("Map.points", near(cp.x, 400) && near(cp.y, 300) && near(map.containerPointToLatLng([400, 300]).lat, map.getCenter().lat) && map.getSize().x === 800);
map.dragging.enable();
ok("Map.handlers", m.dragPan.isEnabled() && map.dragging.enabled());

// ── TileLayer／WMS：source・zoom の上限・重ね順 ──
const osm = L.tileLayer("https://{s}.tile.example.org/{z}/{x}/{y}{r}.png?key={apiKey}", { apiKey: "K", attribution: "© OSM", maxZoom: 19 }).addTo(map);
const tid = osm._rid(), ts = m.sources[tid];
ok("TileLayer.source", ts.type === "raster" && JSON.stringify(ts.tiles) === '["https://a.tile.example.org/{z}/{x}/{y}.png?key=K","https://b.tile.example.org/{z}/{x}/{y}.png?key=K","https://c.tile.example.org/{z}/{x}/{y}.png?key=K"]' && ts.tileSize === 256 && ts.maxzoom === 19 && ts.attribution === "© OSM", JSON.stringify(ts));
ok("TileLayer.layer", m.getLayer(tid).type === "raster" && m.getLayer(tid).paint["raster-opacity"] === 1 && near(m.getLayer(tid).maxzoom, 18, 1e-3));
ok("TileLayer.maxZoom", map.getMaxZoom() === 19 && JSON.stringify(m.calls.filter(c => c[0] === "setMaxZoom").at(-1)) === '["setMaxZoom",18]');
osm.setOpacity(0.5);
ok("TileLayer.opacity", m.getLayer(tid).paint["raster-opacity"] === 0.5);
const wms = L.tileLayer.wms("https://wms.example.org/wms?", { layers: "a,b", format: "image/png", transparent: true, version: "1.3.0" }).addTo(map);
const wt = m.sources[wms._rid()].tiles[0];
ok("TileLayer.WMS", wt === "https://wms.example.org/wms?&service=WMS&request=GetMap&layers=a%2Cb&styles=&format=image%2Fpng&transparent=true&version=1.3.0&height=256&width=256&crs=EPSG%3A3857&bbox={bbox-epsg-3857}", wt);
const tms = L.tileLayer("t/{z}/{x}/{-y}.png", { tms: true }).addTo(map);
ok("TileLayer.tms", m.sources[tms._rid()].scheme === "tms" && m.sources[tms._rid()].tiles[0] === "t/{z}/{x}/{y}.png");
ok("Attribution", map.attributionControl.getContainer().innerHTML.includes("© OSM") && map.attributionControl.getContainer().innerHTML.includes("© Base") && map.attributionControl.getContainer().innerHTML.includes("MapLibre"));

// ── 図形：一つの source・様式は feature の properties・重ね順は tilePane の上 ──
const line = L.polyline([[35, 139], [36, 140], [37, 141]], { color: "red", weight: 5, dashArray: "4, 8" }).addTo(map);
const poly = L.polygon([[[35, 139], [35, 140], [36, 140], [35, 139]], [[35.2, 139.5], [35.4, 139.5], [35.3, 139.6]]], { fillColor: "#0f0" }).addTo(map);
const circ = L.circle([35.5, 139.5], { radius: 1000 }).addTo(map);
const cm = L.circleMarker([35.6, 139.6], { radius: 8, stroke: false }).addTo(map);
const rect = L.rectangle([[1, 2], [3, 4]], { interactive: false }).addTo(map);
L.tileLayer("late/{z}/{x}/{y}.png").addTo(map);   // 図形より後に足した tile も図形の下
await tick();
const rid = map._renderer._id, src = m.sources[rid], fs = src.data.features;
ok("Path.source", fs.length === 5 && src.sets >= 1 && src.data.features.map(f => f.properties._g).join("") === "lppcp", fs.map(f => f.properties._g).join(""));
const fl = fs[0].properties, fp = fs[1].properties, fc = fs[3].properties;
ok("Path.style", fl._c === "red" && fl._w === 5 && fl._f === 0 && fl._d === "4, 8|5|round" && fp._f === 1 && fp._fc === "#0f0" && fp._fo === 0.2 && fp._c === "#3388ff" && fc._r === 8 && fc._sw === 0 && fs[4].properties._i === 0);
ok("Path.geometry", fs[0].geometry.type === "LineString" && fs[1].geometry.type === "Polygon" && fs[1].geometry.coordinates.length === 2 && fs[1].geometry.coordinates[0].length === 4 && fs[2].geometry.coordinates[0].length === 65 && fs[3].geometry.type === "Point");
const order = m.layers.map(l => l.id);
ok("Path.layers", order.includes(`${rid}-dash1`) && m.getLayer(`${rid}-dash1`).paint["line-dasharray"].join() === "0.8,1.6" && order.indexOf(`${rid}-fill`) > Math.max(...[...m.layers].filter(l => l.type === "raster").map(l => order.indexOf(l.id))), order.join(","));
poly.setStyle({ color: "#123", weight: 1 }); line.bringToBack(); await tick();
ok("Path.setStyle", src.data.features[0].properties._lid === L.stamp(line) && src.data.features.find(f => f.properties._lid === L.stamp(poly)).properties._c === "#123");
ok("Path.toGeoJSON", JSON.stringify(poly.toGeoJSON().geometry.coordinates[1]) === "[[139.5,35.2],[139.5,35.4],[139.6,35.3],[139.5,35.2]]" && line.toGeoJSON().geometry.type === "LineString" && circ.toGeoJSON().geometry.type === "Point");
ok("Path.bounds", line.getBounds().getNorth() === 37 && near(circ.getBounds().getNorth() - 35.5, 1000 / 111195, 1e-4) && near(line.getCenter().lat, 36, 0.05));
rect.remove(); await tick();
ok("Path.remove", src.data.features.length === 4);

// ── GeoJSON ──
const gj = L.geoJSON({ type: "FeatureCollection", features: [
	{ type: "Feature", id: "a", properties: { kind: "park" }, geometry: { type: "Polygon", coordinates: [[[139, 35], [140, 35], [140, 36], [139, 35]]] } },
	{ type: "Feature", properties: { kind: "road" }, geometry: { type: "MultiLineString", coordinates: [[[139, 35], [140, 36]], [[139, 36], [140, 35]]] } },
	{ type: "Feature", properties: { kind: "poi", name: "X" }, geometry: { type: "Point", coordinates: [139.5, 35.5] } },
	{ type: "Feature", properties: { kind: "skip" }, geometry: { type: "Point", coordinates: [0, 0] } },
] }, {
	style: f => ({ color: f.properties.kind === "park" ? "green" : "gray" }),
	pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 4 }),
	onEachFeature: (f, layer) => { layer.bindTooltip(f.properties.kind); },
	filter: f => f.properties.kind !== "skip",
}).addTo(map);
await tick();
const gl = gj.getLayers();
ok("GeoJSON.layers", gl.length === 3 && gl[0] instanceof L.Polygon && gl[1] instanceof L.Polyline && gl[2] instanceof L.CircleMarker && gl[0].options.color === "green" && gl[1].options.color === "gray" && gl[2].feature.properties.name === "X");
gj.setStyle({ color: "blue" }); gj.resetStyle(gl[0]);
ok("GeoJSON.style", gl[0].options.color === "green" && gl[1].options.color === "blue");
ok("GeoJSON.toGeoJSON", gj.toGeoJSON().features.length === 3 && gj.toGeoJSON().features[0].id === "a" && gj.toGeoJSON().features[1].geometry.type === "MultiLineString");
ok("GeoJSON.oneSource", Object.keys(m.sources).filter(k => k.startsWith("lf-r")).length === 1 && m.sources[rid].data.features.length === 7);

// ── click の行き先 ──
const ev = []; const fire = (t, x = 400, y = 300) => m.fire(t, { point: { x, y }, lngLat: map.containerPointToLatLng([x, y]), originalEvent: { clientX: x, clientY: y } });
map.on("click", e => ev.push(["map", +e.latlng.lat.toFixed(2)]));
map.on("preclick", () => ev.push(["pre"]));
gj.on("click", e => ev.push(["group", e.layer === gl[0]]));
gl[0].on("click", () => ev.push(["poly"]));
m.hits = [{ id: L.stamp(gl[0]), layer: `${rid}-fill` }];
fire("click");
ok("click.path", JSON.stringify(ev) === `[["pre"],["poly"],["group",true],["map",${+map.getCenter().lat.toFixed(2)}]]`, JSON.stringify(ev));
ev.length = 0; m.hits = [];
fire("click");
ok("click.map", ev.length === 2 && ev[1][0] === "map");
// 図形の popup：click の位置で開き、地図の click にはならない
gl[1].bindPopup("<b>road</b>");
ev.length = 0; m.hits = [{ id: L.stamp(gl[1]), layer: `${rid}-line` }];
fire("click", 410, 290);
const pp = FPopup.all.at(-1);
ok("popup.path", gl[1].isPopupOpen() && pp.map === m && near(pp.ll[1], map.containerPointToLatLng([410, 290]).lat) && !ev.some(e => e[0] === "map") && pp.dom.innerHTML === "<b>road</b>" && pp.o.anchor === "bottom" && JSON.stringify(pp.o.offset) === "[0,0]", JSON.stringify(ev));
m.hits = [];
fire("click");
ok("popup.closeOnMapClick", !gl[1].isPopupOpen() && pp.map === null);
// hover：mouseover／mouseout と tooltip
const hov = [];
gl[0].on("mouseover", () => hov.push("over")).on("mouseout", () => hov.push("out"));
m.hits = [{ id: L.stamp(gl[0]), layer: `${rid}-fill` }]; fire("mousemove"); fire("mousemove");
const tip = FPopup.all.findLast(p => p.dom?.innerHTML === "park" && p.map);   // click.path で開いた tooltip（click でも開く＝Leaflet と同じ）
ok("hover.over", JSON.stringify(hov) === '["over"]' && gl[0].isTooltipOpen() && tip.dom.innerHTML === "park" && tip.o.closeButton === false && m.canvas.style.cursor === "pointer");
m.hits = []; fire("mousemove");
ok("hover.out", JSON.stringify(hov) === '["over","out"]' && !gl[0].isTooltipOpen() && m.canvas.style.cursor === "");

// ── Marker：DOM の click は marker へ・地図へは届かない・popup は toggle ──
const mk = L.marker([35.68, 139.77], { title: "Tokyo", draggable: true }).addTo(map).bindPopup("Tokyo Station");
const fm = FMarker.all.at(-1), icon = mk.getElement();
ok("Marker.add", fm.map === m && fm.ll[0] === 139.77 && fm.o.anchor === "top-left" && fm.o.draggable && icon.tagName === "IMG" && icon.title === "Tokyo" && icon.style.marginLeft === "-12px" && icon.style.marginTop === "-41px" && icon.className.includes("leaflet-marker-icon") && fm.o.element.children.length === 2);
ev.length = 0;
let mclick = 0; mk.on("click", () => mclick++);
const domClick = () => { const e = icon.dispatch("click", { clientX: 400, clientY: 300 }); m.fire("click", { point: { x: 400, y: 300 }, lngLat: { lng: 139.77, lat: 35.68 }, originalEvent: e }); };
domClick();
const mp = FPopup.all.at(-1);
ok("Marker.click", mclick === 1 && !ev.some(e => e[0] === "map") && mk.isPopupOpen() && JSON.stringify(mp.o.offset) === "[1,-34]", JSON.stringify(ev));
domClick();
ok("Marker.popupToggle", mclick === 2 && !mk.isPopupOpen());
domClick();
const opened = mk.getPopup();
L.popup().setLatLng([1, 1]).setContent("other").openOn(map);
ok("popup.autoClose", !opened.isOpen() && map._popup.getContent() === "other");
map.closePopup();
mk.setLatLng([35, 139]);
ok("Marker.setLatLng", fm.ll[0] === 139 && fm.ll[1] === 35);
const drags = []; mk.on("dragstart drag dragend move", e => drags.push(e.type));
fm.fire("dragstart"); fm.ll = [140, 36]; fm.fire("drag"); fm.fire("dragend");
ok("Marker.drag", mk.getLatLng().lat === 36 && JSON.stringify(drags) === '["dragstart","move","drag","dragend"]', JSON.stringify(drags));
mk.dragging.disable();
ok("Marker.dragging", fm.o.draggable === false && !mk.dragging.enabled());
const dmk = L.marker([0, 0], { icon: L.divIcon({ html: "<i>x</i>", className: "pin", iconSize: [20, 20] }) }).addTo(map).bindTooltip("label", { permanent: true, direction: "top" });
const dEl = dmk.getElement(), dt = FPopup.all.at(-1);
ok("DivIcon", dEl.tagName === "DIV" && dEl.innerHTML === "<i>x</i>" && dEl.style.marginLeft === "-10px" && dEl.className.includes("pin"));
ok("Tooltip.permanent", dmk.isTooltipOpen() && dt.o.anchor === "bottom" && JSON.stringify(dt.o.offset) === "[0,-6]" && dt.o.className.includes("leaflet-tooltip-top"));
L.Icon.Default.mergeOptions({ iconUrl: "marker-icon.png" }); L.Icon.Default.imagePath = "/img/";
const im = L.marker([0, 0]).addTo(map);
ok("Icon.Default.imagePath", im.getElement().src === "/img/marker-icon.png");

// ── Layers 操作部品 ──
const a = L.tileLayer("a/{z}/{x}/{y}"), b = L.tileLayer("b/{z}/{x}/{y}"), ov = L.layerGroup([L.marker([1, 1])]);
a.addTo(map);
const lc = L.control.layers({ A: a, B: b }, { Pins: ov }, { collapsed: false }).addTo(map);
const changes = []; map.on("baselayerchange overlayadd", e => changes.push([e.type, e.name]));
const inputs = lc._layerControlInputs;
ok("Layers.build", inputs.length === 3 && inputs[0].checked && !inputs[1].checked && inputs[2].type === "checkbox" && lc.getContainer().className.includes("leaflet-control-layers-expanded"));
inputs[0].checked = false; inputs[1].checked = true; inputs[2].checked = true; inputs[1].dispatch("click");
ok("Layers.switch", !map.hasLayer(a) && map.hasLayer(b) && map.hasLayer(ov) && JSON.stringify(changes) === '[["baselayerchange","B"],["overlayadd","Pins"]]', JSON.stringify(changes));
ok("Layers.zIndex", a.options.zIndex === 1 && b.options.zIndex === 2);

// ── LayerGroup の出し入れ・removeLayer・remove ──
const grp = L.featureGroup([L.marker([2, 2]), L.circleMarker([3, 3])]).addTo(map);
await tick();
const before = m.sources[rid].data.features.length;
map.removeLayer(grp); await tick();
ok("FeatureGroup.remove", m.sources[rid].data.features.length === before - 1 && grp.getBounds().getNorth() === 3);
ok("installGlobal", installGlobal(L) === L && globalThis.L === L && L.noConflict() === L && globalThis.L === undefined);
L.map(new El("div"), { crs: L.CRS.Simple });
ok("unsupported", unsupportedReport().some(s => s.includes("crs")) && warns.some(w => w.startsWith("[lfshim] unsupported:")), unsupportedReport().join(" / "));
map.remove();
ok("Map.remove", m.removed && !div._leaflet_id);

console.log(fails ? `\n${fails} FAIL` : "\nall PASS");
process.exit(fails ? 1 : 0);
