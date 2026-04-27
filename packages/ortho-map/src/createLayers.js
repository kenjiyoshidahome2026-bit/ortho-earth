import * as d3 from 'd3';
import "common/d3/selection.js";
import { drawJSON } from "./modules/drawJSON.js";
import { Borders } from "./modules/Borders.js";
import { layerList } from "./modules/layerList.js";

import base from './workers/base.js?worker&url';
import image from './workers/image.js?worker&url';
import standard from './workers/standard.js?worker&url';
const workerURL = s => ({ base, image }[s] || standard);

export async function createLayers(map) {
    const layers = map.layers = {};
    map.createLayer = opts => createLayer.call(map, opts);
    map.createRemoteLayer = opts => createRemoteLayer.call(map, opts);
    map.getLayer = name => layers[name] || map.createLayer({ name });
    map.removeLayer = name => (layers[name] && layers[name].destroy(), map);
    map.listOfLayers = () => Object.values(map.layers).map(layer => (layer.toString())).join("\n");
    map.setBase = name => setBase(map, name);
    ////--------------------------------------------------------------------------
    (await createRemoteLayer.call(map, { name: "OrthoMapGL", append: map.mapFrame, type: "base" }));
    (await createRemoteLayer.call(map, { name: "OrthoBorder", append: map.mapFrame }));
    ////--------------------------------------------------------------------------
    await Promise.all([setBase(map, map.baseName), setBorder(map)]);
    ////--------------------------------------------------------------------------
    async function setBase(map, name) {
        const layer = map.layers.OrthoMapGL;
        if (layer) {
            layer.set("base", name);
            layer.set("tile", name, map.threshold);
        }
        const { maxZoom, attr } = layerList[name];
        map.attribution = attr;
        map.setRange(map.minZoom, Math.min(maxZoom, map.maxZoom));
        if (map.zoom > maxZoom) map.setZoom(maxZoom);
        map.stat("base", map.baseName = name);
    };
    async function setBorder(map) {
        const { graticule, border, maritime, lines } = await Borders();
        const layer = map.layers.OrthoBorder;
        const maxZoom = map.maxBorder, minZoom = map.minEdit;
        layer.set("geojson", { type: "Sphere" }, { maxZoom, minZoom, stroke: "rgba(200,200,200,0.8)", width: 0.8 });
        layer.set("geojson", graticule.geojson, { maxZoom, minZoom, stroke: "rgba(255,255,255,0.5)", width: 0.5 });
        layer.set("geojson", lines.geojson, { maxZoom, minZoom, stroke: "rgba(255,255,255,1)", width: 0.5, dash: [4, 2] });
        layer.set("geojson", border.geojson, { maxZoom, minZoom, stroke: "rgba(255,255,255,0.8)", width: 1, dash: [3, 1] });
        layer.set("geojson", maritime.geojson, { maxZoom, minZoom, stroke: "rgba(128,128,255,0.8)", width: 0.8, dash: [3, 1] });
    };
}
////=====================================================================================
function initLayer(map, param = {}) {
    param.name = param.name || "Layer";
    let name = param.name, count = 0, _opacity = 1;
    while (name in map.layers) name = `${param.name}(${++count})`;
    const layer = param.before ? param.before.parent().insert("canvas", () => param.before.node()) :
        param.after ? param.after.parent().insert("canvas", () => param.after.node().nextSibling) :
        param.prepend ? param.prepend.prepend("canvas") :
        param.append ? param.append.append("canvas") : map.mapFrame.append("canvas");
    layer.name = name, layer.attr("name", name);
    layer.base = map; layer.context = null;
    layer.dpr = param.scale || window.devicePixelRatio || 1;
    layer.proj = map.proj;
    layer.canvas = layer.node();
    layer.opacity = v => v == null ? _opacity : layer.style("opacity", (_opacity = v));
    return map.layers[name] = layer;
}
////=====================================================================================
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
    layer.clear = () => ctx.clearRect(0, 0, map.width, map.height);
    layer.drawJSON = (json, prop) => {
        const { zoom, width, height } = map;
        drawJSON.call({ ctx, proj, zoom, path, width, height }, json, prop);
    }
    console.log(layer.toString());
    return layer;
    ////------------------------------------------------------------------------
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
    function toString() { return `Layer ("${layer.name}": ${ctx.constructor.name} [ ${map.width} x ${map.height} ] x ${dpr}) is append to "${layer.parent().attr("name")}".`; }
}
////=====================================================================================
async function createRemoteLayer(param = {}) {
    const map = this;
    const layer = initLayer(map, param).hide(), { canvas, name, proj, dpr } = layer;
    const offscreen = canvas.transferControlToOffscreen();
    console.log(param.type, param)
    const worker = new Worker(workerURL(param.type), { type: 'module' });
    worker.onerror = e => console.error("Worker Error:", e);
    const workers = map.simultaneousTileLoading || navigator.hardwareConcurrency || 4;
    const threshold = map.threshold;
    return new Promise(resolve => {
        let ctxType = null;
        worker.onmessage = e => {
            const data = e.data;
            if (data.action !== "done") return;
            if (data.type === "init") {
                ctxType = data.ctx;
                console.log(layer.toString());
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
        Object.entries({ set, destroy, toString }).forEach(([name, func]) => layer[name] = func);
        map.dispatcher.on(`Drawing.${name}`, drawing);
        map.dispatcher.on(`Drawn.${name}`, drawn);
        map.dispatcher.on(`Resize.${name}`, resize);
        init(); resize();
        ////------------------------------------------------------------------------
        function init() { worker.postMessage({ type: "init", offscreen, dpr, workers, threshold }, [offscreen]); }
        function set(cmd, data, prop) {
            worker.postMessage({ type: "set", cmd, data, prop });
            (cmd === "base") && map.trigger("LoadStart", data);
        }
        function drawing() { worker.postMessage({ type: "drawing", scale: proj.scale(), rotate: proj.rotate() }); }
        function drawn() { worker.postMessage({ type: "drawn", scale: proj.scale(), rotate: proj.rotate() }); }
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
        function toString() { return `Layer ("${layer.name}": ${ctxType} [ ${map.width} x ${map.height} ] x ${dpr}) is append to "${layer.parent().attr("name")}".`; }
    });
}