import * as d3 from 'd3';
import "common/d3/selection.js";
import { drawJSON } from "./modules/drawJSON.js";
import { createLayerMap } from "./modules/layers.js";
import { geopbf } from "geopbf";

import base from './workers/base.js?worker&url';
import border from './workers/border.js?worker&url';
import image from './workers/image.js?worker&url';
import standard from './workers/standard.js?worker&url';
import gint from './workers/gint.js?worker&url';
import gintBorder from './workers/gintBorder.js?worker&url';
const workerURL = s => ({ base, border, image, gint, gintBorder }[s] || standard);

let borderRawBuffers = null;

// geoNames: for gintBorder (GL2); overlayNames: for border.js (Canvas2D)
async function getBorderRawBuffers() {
	if (borderRawBuffers) return borderRawBuffers;
	const geoNames = [
		"ne_110m_graticules_10",
		"ne_50m_admin_0_boundary_lines_land",
		"ne_50m_admin_0_boundary_lines_maritime_indicator",
		"ne_50m_geographic_lines",
	];
	const overlayNames = ["ne_110m_land", "stars.6"];
	const optionalOverlayNames = ["constellation_lines", "messier"];
	const [geo, required, optional] = await Promise.all([
		Promise.all(geoNames.map(name => geopbf(name).then(r => r.unPackGint))),
		Promise.all(overlayNames.map(name => geopbf(name, {gint:false}).then(r => r.geojson).catch(() => null))),
		Promise.all(optionalOverlayNames.map(name => geopbf(name, {gint:false}).then(r => r.geojson).catch(() => null))),
	]);
	const overlay = [...required, ...optional];
	borderRawBuffers = { geo, overlay };
	return borderRawBuffers;
}

// dash values are in screen pixels (constant visual size across zoom levels)
const BORDER_GL_STYLES = [
	{ color: [1.0,  1.0,  1.0,  0.6], lineWidth: 1.0, dash: [0, 0 ] }, // graticule (solid)
	{ color: [1.0,  1.0,  1.0,  1.0], lineWidth: 1.0, dash: [4, 2 ] }, // country borders
	{ color: [0.50, 0.50, 1.0,  0.8], lineWidth: 0.8, dash: [4, 2 ] }, // maritime
	{ color: [1.0,  1.0,  1.0,  0.6], lineWidth: 0.8, dash: [4, 2 ] }, // geographic lines
];

export async function createLayers(map, opts) {
	const Layers = map.Layers = createLayerMap(opts.tilerBase || "");
	const layers = map.layers = {};
	map.createLayer = opts => createLayer.call(map, opts);
	map.createRemoteLayer = opts => createRemoteLayer.call(map, opts);
	map.getLayer = name => layers[name] || map.createLayer({ name });
	map.removeLayer = name => (layers[name] && layers[name].destroy(), map);
	map.listOfLayers = () => Object.values(map.layers).map(layer => (layer.toString())).join("\n");
	map.setBase = name => setBase(map, name);
	const baseLayer = (await createRemoteLayer.call(map, { name: "OrthoMapGL", append: map.mapFrame, type: "base", apiUrl: opts.apiUrl, tilerBase: opts.tilerBase || "" }));
	await map.setBase(map.baseName);
	if (opts.accessories === false) return;
	const borderGLLayer = await createRemoteLayer.call(map, { name: "BorderLines", append: map.mapFrame, type: "gintBorder" });
	const borderLayer   = await createRemoteLayer.call(map, { name: "Accessories", append: map.mapFrame, type: "border" });
	const param = opts.accessories || {}; param.lang = map.lang;
	getBorderRawBuffers().then(({ geo, overlay }) => {
		borderGLLayer.set("gint", { gintDataList: geo, styles: BORDER_GL_STYLES, minZoom: 2, maxZoom: 7 });
		borderLayer.set("set", "options", { ...param, geojsons: overlay });
	});
	async function setBase(map, name) {
		baseLayer.set("base", name, map.threshold);
		const { maxZoom, attr } = Layers[name];
		map.attribution = attr;
		map.setRange(map.minZoom, Math.min(maxZoom, map.maxZoom));
		(map.zoom > maxZoom) && map.setZoom(maxZoom);
		map.stat("base", map.baseName = name);
	};
}

function initLayer(map, param = {}) {
	param.name = param.name || "Layer";
	let name = param.name, count = 0, _opacity = 1;
	while (name in map.layers) name = `${param.name}(${++count})`;
	const beforeOverlays = c => map.overlays ? c.insert("canvas", () => map.overlays.node()) : c.append("canvas");
	const layer = param.before ? param.before.parent().insert("canvas", () => param.before.node()) :
		param.after ? param.after.parent().insert("canvas", () => param.after.node().nextSibling) :
		param.prepend ? param.prepend.prepend("canvas") :
		param.append ? (param.append.node() === map.mapFrame.node() ? beforeOverlays(param.append) : param.append.append("canvas")) :
		beforeOverlays(map.mapFrame);
	layer.name = name, layer.attr("name", name);
	layer.base = map; layer.context = null;
	layer.dpr = param.scale || window.devicePixelRatio || 1;
	layer.width = window.innerWidth * layer.dpr;
	layer.height = window.innerHeight * layer.dpr;
	layer.proj = map.proj;
	layer.canvas = layer.node();
	layer.opacity = v => v == null ? _opacity : layer.style("opacity", (_opacity = v));
	return map.layers[name] = layer;
}

export function createLayer(param = {}) {
	const map = this;
	const layer = initLayer(map, param), { canvas, name, proj, dpr } = layer;
	const ctx = layer.context = canvas.getContext("2d"), path = d3.geoPath(proj, ctx);
	let jsons = [];
	Object.entries({ set, destroy, toString }).forEach(([name, func]) => layer[name] = func);
	map.dispatcher.on(`Drawing.${name}`, drawing);
	map.dispatcher.on(`Drawn.${name}`, drawn);
	map.dispatcher.on(`Resize.${name}`, resize);
	resize();
	layer.clear = () => ctx.clearRect(0, 0, ~~map.width, ~~map.height);
	layer.drawJSON = (json, prop) => {
		const { zoom, width, height } = map;
		drawJSON.call({ ctx, proj, zoom, path, width, height }, json, prop);
	}
	console.log(`[ortho-earth] 🗺️ Layer ("${layer.name}": ${ctx.constructor.name} [ ${map.width} x ${map.height} ] x ${dpr}) is append to "${layer.parent().attr("name")}".`);
	return layer;
	function set(cmd, data, prop) {
		const toFeatures = json => (json ? json.features ? json.features : Array.isArray(json) ? json : [json] : []);
		cmd == "geojson" && jsons.push([toFeatures(data), prop]);
		layer.show();
		drawing();
	}
	function drawing() {
		const { width, height, zoom } = map;
		ctx.clearRect(0, 0, width, height);
		jsons.forEach(t => drawJSON.call({ ctx, proj, zoom, path, width, height }, ...t))
	}
	function drawn() { }
	function resize() {
		const { width, height } = map;
		layer.css({ width: width + "px", height: height + "px" });
		canvas.width = width * dpr; canvas.height = height * dpr;
		ctx.scale(dpr, dpr);
		drawing();
	}
	function destroy() {
		map.dispatcher.on(`.${name}`, null);
		jsons.forEach(t => t = null); jsons.length = 0; jsons = null;
		layer.remove(); delete map.layers[name];
	}
 }

async function createRemoteLayer(param = {}) {
	const map = this;
	const layer = initLayer(map, param).hide(), { canvas, name, proj, dpr } = layer;
	let offscreen;
	try {
		offscreen = canvas.transferControlToOffscreen();
	} catch (e) {
		console.error(`🚨 [${name}] CanvasのOffscreen化に失敗しました。すでに転送済みの可能性があります:`, e);
		return Promise.reject(e);
	}

	const worker = new Worker(workerURL(param.type), { type: 'module' });
	worker.onerror = e => console.error(`🚨 [${name}] Worker Error:`, e);

	const workers = map.simultaneousTileLoading || navigator.hardwareConcurrency || 4;
	const threshold = map.threshold;

	return new Promise((resolve, reject) => {
		let ctxType = null;
		worker.onmessage = e => {
			const data = e.data;
			if (data.action === "identify") { layer.onIdentify?.(data.featureId, data.geomType, data.x, data.y); return; }
			if (data.action === "redraw")   { drawing(); return; }
			if (data.action === "click")    { layer.onClick?.(data.featureId, data.geomType, data.x, data.y, data.lng, data.lat); return; }
			if (data.action !== "done") return;
			if (data.type === "init") {
				ctxType = data.ctx;
				console.log(`[ortho-earth] 🗺️ Layer ("${layer.name}": ${ctxType} [ ${map.width} x ${map.height} ] x ${dpr}) is append to "${layer.parent().attr("name")}".`);
				resolve(layer);
			}
			if (data.type === "destroy") terminate();
			if (data.type === "resize") drawing();
			if (data.type === "set") {
				layer.show();
				drawing();
				if (data.cmd === "base") map.trigger("LoadEnd", data.data);
			}
		};

		Object.entries({ set, destroy }).forEach(([name, func]) => layer[name] = func);

		map.dispatcher.on(`Drawing.${name}`, () => drawing(true));
		map.dispatcher.on(`Drawn.${name}`, drawn);
		map.dispatcher.on(`Move.${name}`, move);
		map.dispatcher.on(`Leave.${name}`, leave);
		map.dispatcher.on(`Click.${name}`, click);
		map.dispatcher.on(`Resize.${name}`, resize);

		init();
		resize();

		function init() {
			try {
				worker.postMessage({ type: "init", offscreen, dpr, workers, threshold, apiUrl: param.apiUrl, tilerBase: param.tilerBase }, [offscreen]);
			} catch (err) {
				console.error(`🚨 [${name}] WorkerへのCanvas転送に失敗しました:`, err);
				reject(err);
			}
		}
		function set(cmd, data, prop, transferables) {
			if (transferables) {
				worker.postMessage({ type: "set", cmd, data: cmd, prop: data }, transferables);
			} else if (prop?.rawBuffers) {
				const { rawBuffers, ...rest } = prop;
				worker.postMessage({ type: "set", cmd, data, prop: rest, rawBuffers }, rawBuffers);
			} else if (prop?.geojsons) {
				const { geojsons, ...rest } = prop;
				worker.postMessage({ type: "set", cmd, data, prop: rest, geojsons });
			} else {
				worker.postMessage({ type: "set", cmd, data, prop });
				(cmd === "base") && map.trigger("LoadStart", data);
			}
		}
		function drawing(panning = false) {
			// Do not send drawing commands until initialization completes (ctxType is set).
			// Safari requires the offscreen canvas to be fully initialized before receiving draw calls.
			if (!ctxType) return;
			worker.postMessage({ type: "drawing", scale: proj.scale(), rotate: proj.rotate(), attr: map.attribution, panning, minZoom: map.minZoom, maxZoom: map.maxZoom });
		}
		function drawn() { worker.postMessage({ type: "drawn", scale: proj.scale(), rotate: proj.rotate() }); }
		function move(e = {}) { worker.postMessage({ type: "move", ...e }); }
		function leave() { worker.postMessage({ type: "leave" }); }
		function click(e = {}) { worker.postMessage({ type: "click", ...e }); }
		function resize() {
			const { width, height } = map;
			layer.css({ width: width + "px", height: height + "px" });
			worker.postMessage({ type: "resize", width, height });
		}
		function destroy() { worker.postMessage({ type: "destroy" }); }
		function terminate() {
			worker.terminate();
			map.dispatcher.on(`.${name}`, null);
			layer.remove(); delete map.layers[name];
		}
	});
}
