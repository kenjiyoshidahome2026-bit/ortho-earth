import { geoPath, geoOrthographic, geoGraticule10 } from 'd3-geo';
import { geopbf } from "geopbf";
let canvas, ctx, width, height, dpr, path, maxZoom, minZoom;
let proj = geoOrthographic();
let figs = [];
const funcs = { init, set, drawing, drawn, resize, destroy };
onmessage = e => funcs[e.data.type](e.data);
function init(data) {
	canvas = data.offscreen, dpr = data.dpr;
	path = geoPath(proj, ctx = canvas.getContext("2d"));
 	postMessage({ type: data.type, action: "done", ctx: ctx.constructor.name });
}
async function set(data) {
    maxZoom = data.maxZoom || 7, minZoom = data.minZoom || 2;
	const pbfs = await Promise.all([
		"ne_50m_admin_0_boundary_lines_land",
        "ne_50m_admin_0_boundary_lines_maritime_indicator",
        "ne_50m_geographic_lines"].map(geopbf));
 	figs.push([{ type: "Sphere" }, { stroke: "rgba(200,200,200,0.8)", width: 0.8 }]);
	figs.push([geoGraticule10(), { stroke: "rgba(255, 255, 255, 0.5)", width: 0.5 }]);
	figs.push([pbfs[0].geojson, { stroke: "rgba(255,255,255,0.8)", width: 1, dash: [3, 1] }]);
	figs.push([pbfs[1].geojson, { stroke: "rgba(128,128,255,0.8)", width: 0.8, dash: [3, 1] }]);
	figs.push([pbfs[2].geojson, { stroke: "rgba(255,255,255,1)", width: 0.5, dash: [4, 2] }]);
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
    const stroke = (style, width = 1, dash = []) => style && (ctx.strokeStyle = style, ctx.lineWidth = width, ctx.setLineDash(dash), ctx.stroke());
	requestAnimationFrame(() => {
		ctx.clearRect(0, 0, width, height);
		const zoom = Math.log2(data.scale * Math.PI * 2 / 256); if (zoom < minZoom || zoom > maxZoom) return;
		proj.rotate(data.rotate).scale(data.scale);
		figs.forEach(([json, prop]) => {
            ctx.beginPath(); path(json); stroke(prop.stroke, prop.width, prop.dash);
		});
	});
}
function drawn() {}

function destroy(data) {
	canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
	figs.forEach(t => t = null); figs.length = 0; figs = null;
	ctx = path = proj = null;
	postMessage({ type: data.type, action: "done" });
}
