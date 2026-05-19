import * as d3 from 'd3';
import "common/d3/selection.js";
import { drawJSON } from "./modules/drawJSON.js";
import { Layers } from "./modules/layers.js";

import base from './workers/base.js?worker&url';
import border from './workers/border.js?worker&url';
import image from './workers/image.js?worker&url';
import standard from './workers/standard.js?worker&url';
const workerURL = s => ({ base, border, image }[s] || standard);

export async function createLayers(map, opts) {
    const layers = map.layers = {};
    map.createLayer = opts => createLayer.call(map, opts);
    map.createRemoteLayer = opts => createRemoteLayer.call(map, opts);
    map.getLayer = name => layers[name] || map.createLayer({ name });
    map.removeLayer = name => (layers[name] && layers[name].destroy(), map);
    map.listOfLayers = () => Object.values(map.layers).map(layer => (layer.toString())).join("\n");
    map.setBase = name => setBase(map, name);
////--------------------------------------------------------------------------
    const baseLayer = (await createRemoteLayer.call(map, { name: "OrthoMapGL", append: map.mapFrame, type: "base" }));
    await map.setBase(map.baseName);
////--------------------------------------------------------------------------
    if (opts.accessories === false) return;
    const borderLayer = (await createRemoteLayer.call(map, { name: "Accessories", append: map.mapFrame, type: "border" }));
    const param = opts.accessories ||{}; param.lang = map.lang;
    await borderLayer.set("set", "options", param);
    ////--------------------------------------------------------------------------
    async function setBase(map, name) {
        baseLayer.set("base", name, map.threshold);
        const { maxZoom, attr } = Layers[name];
        map.attribution = attr;
        map.setRange(map.minZoom, Math.min(maxZoom, map.maxZoom));
        (map.zoom > maxZoom) && map.setZoom(maxZoom);
        map.stat("base", map.baseName = name);
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
    console.log(`[ortho-earth] 🗺️ Layer ("${layer.name}": ${ctx.constructor.name} [ ${map.width} x ${map.height} ] x ${dpr}) is append to "${layer.parent().attr("name")}".`);
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
 }
////=====================================================================================
async function createRemoteLayer(param = {}) {
    const map = this;

    // 【最重要・防波堤】すでに同じベース名のレイヤーが存在する場合は、新しく作らずに既存のものを返す！
    const baseName = param.name || "Layer";
    if (map.layers && map.layers[baseName]) {
        console.log(`[ortho-earth] ♻️ レイヤー "${baseName}" は既に存在するため再利用します（二重起動ブロック）`);
        return Promise.resolve(map.layers[baseName]);
    }

    const layer = initLayer(map, param).hide(), { canvas, name, proj, dpr } = layer;

    // 【Safari対策 1】 転送前にキャンバスの初期サイズを確定させる（0x0だとSafariが転送に失敗するバグを回避）
    canvas.width = map.width * dpr || 1;
    canvas.height = map.height * dpr || 1;

    let offscreen;
    try {
        // 【Safari対策 2】 すでに転送済みのCanvasを再転送しようとする InvalidStateError をキャッチする
        offscreen = canvas.transferControlToOffscreen();
    } catch (e) {
        console.error(`🚨 [${name}] CanvasのOffscreen化に失敗しました。すでに転送済みの可能性があります:`, e);
        return Promise.reject(e); // 失敗したらここで安全に処理を止める
    }

    const worker = new Worker(workerURL(param.type), { type: 'module' });
    worker.onerror = e => console.error(`🚨 [${name}] Worker Error:`, e);

    const workers = map.simultaneousTileLoading || navigator.hardwareConcurrency || 4;
    const threshold = map.threshold;

    return new Promise((resolve, reject) => {
        let ctxType = null;
        worker.onmessage = e => {
            const data = e.data;
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

        map.dispatcher.on(`Drawing.${name}`, drawing);
        map.dispatcher.on(`Drawn.${name}`, drawn);
        map.dispatcher.on(`Move.${name}`, move);
        map.dispatcher.on(`Leave.${name}`, leave);
        map.dispatcher.on(`Resize.${name}`, resize);

        init();
        resize();

        ////------------------------------------------------------------------------
        function init() {
            try {
                // 【Safari対策 3】 転送エラー(DataCloneError)をキャッチして、原因を可視化する
                worker.postMessage({ type: "init", offscreen, dpr, workers, threshold }, [offscreen]);
            } catch (err) {
                console.error(`🚨 [${name}] WorkerへのCanvas転送に失敗しました:`, err);
                reject(err);
            }
        }
        function set(cmd, data, prop) {
            worker.postMessage({ type: "set", cmd, data, prop });
            (cmd === "base") && map.trigger("LoadStart", data);
        }
        function drawing() {
            // 【Safari対策 4】 初期化が成功(ctxType取得)するまでは描画命令を送らない
            if (!ctxType) return;
            worker.postMessage({ type: "drawing", scale: proj.scale(), rotate: proj.rotate(), attr: map.attribution });
        }
        function drawn() { worker.postMessage({ type: "drawn", scale: proj.scale(), rotate: proj.rotate() }); }
        function move(e = {}) { worker.postMessage({ type: "move", ...e }); }
        function leave() { worker.postMessage({ type: "leave" }); }
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