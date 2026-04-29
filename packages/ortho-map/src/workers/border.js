import { geoPath, geoOrthographic, geoGraticule10 } from 'd3-geo';
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
    const maxZoom = data.maxZoom || 7, minZoom = data.minZoom || 2;
	const pbfs = await Promise.all([
		"ne_50m_admin_0_boundary_lines_land",
        "ne_50m_admin_0_boundary_lines_maritime_indicator",
        "ne_50m_geographic_lines"].map(geopbf));
 	jsons.push([{ type: "Sphere" }, { maxZoom, minZoom, stroke: "rgba(200,200,200,0.8)", width: 0.8 }]);
	jsons.push([geoGraticule10(), { maxZoom, minZoom, stroke: "rgba(255, 255, 255, 0.5)", width: 0.5 }]);
	jsons.push([pbfs[0].geojson, { maxZoom, minZoom, stroke: "rgba(255,255,255,0.8)", width: 1, dash: [3, 1] }]);
	jsons.push([pbfs[1].geojson, { maxZoom, minZoom, stroke: "rgba(128,128,255,0.8)", width: 0.8, dash: [3, 1] }]);
	jsons.push([pbfs[2].geojson, { maxZoom, minZoom, stroke: "rgba(255,255,255,1)", width: 0.5, dash: [4, 2] }]);
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
