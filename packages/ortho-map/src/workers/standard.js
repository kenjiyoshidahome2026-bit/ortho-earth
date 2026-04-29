import { geoPath, geoOrthographic } from 'd3-geo';
import { geopbf } from "geopbf";
import  { drawJSON } from "../modules/drawJSON.js"
let canvas, ctx, width, height, dpr, path;
let proj = geoOrthographic(), zoom;
let jsons = [];
const funcs = { init, set, drawing, drawn, resize, destroy };
onmessage = e => funcs[e.data.type](e.data);
function init(data) {
    canvas = data.offscreen, dpr = data.dpr;
    path = geoPath(proj, ctx = canvas.getContext("2d"));
    postMessage({ type: data.type, action: "done", ctx: ctx.constructor.name });
}
async function set(data) {
    const toFeatures = json => (json ? json.features ? json.features : Array.isArray(json) ? json : [json] : []);
    data.cmd == "geojson" && jsons.push([toFeatures(data.data), data.prop]);
    postMessage({ type: data.type, action: "done" });
}
function resize(data) {
    width = data.width; height = data.height;
    canvas.width = width * dpr; canvas.height = height * dpr;
    proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
    ctx.scale(dpr, dpr);
    postMessage({ type: data.type, action: "done" });
}
function drawing(data) {
    requestAnimationFrame(() => {
        proj.rotate(data.rotate).scale(data.scale);
        zoom = Math.log2(data.scale * Math.PI * 2 / 256);
        ctx.clearRect(0, 0, width, height);
        jsons.forEach(t => drawJSON.call({ ctx, proj, zoom, path, width, height }, ...t))
    });
}
function drawn() {}

function destroy(data) {
    canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
    jsons.forEach(t => t = null); jsons.length = 0; jsons = null;
    ctx = path = proj = null;
    postMessage({ type: data.type, action: "done" });
}
