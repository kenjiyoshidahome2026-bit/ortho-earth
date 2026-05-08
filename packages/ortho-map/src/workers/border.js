import { geoPath, geoOrthographic, geoGraticule10 } from 'd3-geo';
import { geopbf } from "geopbf";
//import { createGetHeight } from "altpbf";

let canvas, ctx, width, height, dpr, path, zoom, maxZoom, minZoom, attribution;
let displayBorders = {}, displayLnglat = true, displayScale = true, displayCredit = true, displayGlobe = {size:128};

let proj = geoOrthographic();
let borders = [], latlngalt = null, latlngString;
let scaleCanvas = null, scaleCtx = null;
let globeCanvas = null, globeCtx = null;
let noCircle = 1;
let land110, stars;
const funcs = { init, set, drawing, drawn, move, leave, resize, destroy };
const isNarrow = () => width < 1000;
const isEditable = () => zoom > 2;
const sphere = { type: "Sphere" };
const graticule = geoGraticule10();
onmessage = e => funcs[e.data.type](e.data);
function init(data) {
	canvas = data.offscreen, dpr = data.dpr;
	path = geoPath(proj, ctx = canvas.getContext("2d"));
 	postMessage({ type: data.type, action: "done", ctx: ctx.constructor.name });
}
async function set(data) {
	displayBorders = data.data.borders !== false ? data.data.borders || displayBorders : false;
	displayLnglat = data.data.latlng !== false;
	displayScale = data.data.scale !== false;
	displayCredit = data.data.credit !== false;
	displayGlobe = data.data.globe !== false ? data.data.globe || displayGlobe : false;
	let lang = data.prop.lang;
	latlngalt = [
		{ en: "LAT", ja: "緯度", zh: "纬度", ko: "위도" }[lang],
		{ en: "LNG", ja: "経度", zh: "经度", ko: "경도" }[lang],
		{ en: "ALT", ja: "標高", zh: "海拔", ko: "고도" }[lang]
	];
	borders = [[sphere, { stroke: "rgba(200,200,200,0.8)", width: 0.8 }]];
	if (displayBorders) {
		maxZoom = displayBorders.maxZoom || 7, minZoom = displayBorders.minZoom || 2;
		const jsons = (await Promise.all([
			"ne_50m_admin_0_boundary_lines_land",
			"ne_50m_admin_0_boundary_lines_maritime_indicator",
			"ne_50m_geographic_lines",
			"ne_110m_land", "stars.6"].map(geopbf))).map(t=>t.geojson);
		displayBorders.graticule === false || borders.push([graticule, { stroke: "rgba(255, 255, 255, 0.5)", width: 0.5 }]);
		displayBorders.boundary_lines === false || borders.push([jsons[0], { stroke: "rgba(255,255,255,0.8)", width: 1, dash: [3, 1] }]);
		displayBorders.boundary_maritime === false || borders.push([jsons[1], { stroke: "rgba(128,128,255,0.8)", width: 0.8, dash: [3, 1] }]);
		displayBorders.geographic_lines === false || borders.push([jsons[2], { stroke: "rgba(255,255,255,1)", width: 0.5, dash: [4, 2] }]);
		land110 = jsons[3];
		stars = jsons[4];
		
	}
	scaleCanvas = new OffscreenCanvas(600, 60);//debugger;
	scaleCtx = scaleCanvas.getContext("2d"); scaleCtx.scale(dpr, dpr);
	globeCanvas = new OffscreenCanvas(128, 128);//debugger;
	globeCtx = globeCanvas.getContext("2d"); scaleCtx.scale(dpr, dpr);
	postMessage({ type: data.type, action: "done" });
}
function resize(data) {
	width = data.width; height = data.height;
	canvas.width = width * dpr; canvas.height = height * dpr;
	proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
	ctx.scale(dpr, dpr);
	noCircle = Math.log2(Math.hypot(width, height) / 2 / 256);
	postMessage({ type: data.type, action: "done" });
}
function drawing(data) { console.log(data)
	requestAnimationFrame(() => {
		ctx.clearRect(0, 0, width, height);
		proj.rotate(data.rotate).scale(data.scale);
		zoom = Math.log2(data.scale * Math.PI * 2 / 256);
		attribution = data.attr;
		displayBorders && draw_border();
		displayLnglat && draw_latlng();
		displayScale && draw_scale();
		displayCredit && draw_credit();
		
	});
}
function move(data) {
	if (!latlngalt || !data.lat || !isEditable()) return leave();
	latlngString = `${latlngalt[0]}: ${data.lat.toFixed(6)} ${latlngalt[1]}: ${data.lng.toFixed(6)}${data.alt ? ` ${latlngalt[2]}: ${data.alt.toFixed(1)}[m]` : ""}`;
	draw_latlng();
}
function leave() { const w = 350, h = 25;
	isNarrow() ? ctx.clearRect((width - w) / 2, 0, w, h) : ctx.clearRect(0, height - h, w, h);
}
function drawn() {}

function destroy(data) {
	canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
	borders.forEach(t => t = null); borders.length = 0; borders = null;
	ctx = path = proj = null;
	postMessage({ type: data.type, action: "done" });
}
////--------------------------------------------------------------
async function draw_border() {
	if (zoom < minZoom || maxZoom < zoom) return;
	borders.forEach(([json, prop]) => {
		ctx.beginPath(); path(json);
		ctx.strokeStyle = prop.stroke;
		ctx.lineWidth = prop.width || 1;
		ctx.setLineDash(prop.dash ||[]);
		ctx.stroke();
	});
}
async function draw_latlng() { leave();
	if (!latlngString) return;
	ctx.save();
	ctx.font = "12px Verdana"; ctx.textBaseline = "middle"; ctx.fillStyle = "white";
	ctx.textAlign = isNarrow() ? "center" : "left";
	ctx.fillText(latlngString, isNarrow() ? width / 2 : 10, isNarrow() ? 10 : height - 10);
	ctx.restore();
}
function draw_scale() {
	if (!scaleCtx) return;
	const canvas = scaleCtx.canvas
	const W = canvas.width, H = canvas.height;
	draw(scaleCtx);
	ctx.drawImage(canvas, 0, 0, W, H, (width - W / dpr) / 2, height - H / dpr - (isNarrow() ? 20 : 0), W / dpr, H / dpr);
	function draw(ctx) {
		const w = W /dpr, h = H/dpr, M = w / 2, R = 6372000 * 2; // 地球の直径
		const { PI, floor, log10 } = Math;
		const [n, v] = (function () {
			const n = (R * PI) / 2 ** zoom; // 256ピクセルでの距離
			const r = 10 ** floor(log10(n));
			const m = n / r;
			const v = m > 5 ? 5 : m > 2 ? 2 : 1;
			return [256 * v / m, v * r];
		})();
		ctx.clearRect(0, 0, w, h);
		let str = (v < 1000 ? (v).toFixed(0) + "m" : (v / 1000).toFixed(0) + "km") + " (z=" + zoom.toFixed(2) + ")";
		ctx.save();
		ctx.font = "12px Verdana"; ctx.textBaseline = "bottom"; ctx.textAlign = "center";
		ctx.strokeStyle = ctx.fillStyle = "white";
		ctx.beginPath();
		ctx.moveTo(M - n / 2, 20); ctx.lineTo(M + n / 2, 20);
		ctx.lineWidth = 3; ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(M - n / 2, 10); ctx.lineTo(M - n / 2, 25);
		ctx.moveTo(M + n / 2, 10); ctx.lineTo(M + n / 2, 25);
		ctx.lineWidth = 1; ctx.stroke();
		ctx.fillText(str, M, 15);
		ctx.restore();
	}
}
function draw_credit() {
	ctx.save();
	ctx.font = "12px Verdana"; ctx.textBaseline = "middle"; ctx.fillStyle = "white";
	ctx.textAlign = isNarrow() ? "center" : "right";
	ctx.fillText(attribution, isNarrow() ? width / 2 : width - 10, height - 10);
	ctx.restore();
}
async function draw_globe() {
//	const name = "globe";
//	const sphere = { type: "Sphere" };
//	const graticule = geoGraticule10();
//	const land110 = (await geopbf("ne_110m_land")).geojson;
	const bottom = isNarrow() ? 55 : 30, right = 20;
	const size0 = 125, size = size0 * dpr;
	const maxZoom = 9;
//	const canvas = new OffscreenCanvas(size, size), ctx = canvas.getContext("2d");
	const project = geoOrthographic().fitExtent([[1, 1], [size - 1, size - 1]], sphere).precision(0.1);
	const path = geoPath(project, ctx);
	draw(globCtx);
	const [x, y] = [width - size0 - right, height - size0 - bottom];
	globCtx.drawImage(canvas, 0, 0, size, size, x, y, size0, size0);
	function draw(ctx) {
	//	const noCircle = map.scale2zval(Math.hypot(width, height) / 2);
		if (zoom > maxZoom || zoom < noCircle) return;
	//	const [w, h] = [map.width, map.height];
	//	const [x, y] = [w - size0 - right, h - size0 - bottom];
		const bounds = [[0, 0], [width, 0], [width, height], [0, height]].map(proj.invert);
		const r = proj.rotate(); project.rotate([r[0], r[1], 0]);
		ctx.clearRect(0, 0, size, size);
		ctx.beginPath(); path(sphere); ctx.fillStyle = "rgb(200,240,255)"; ctx.fill();
		ctx.beginPath(); path(land110); ctx.fillStyle = "rgb(160,200,160)"; ctx.fill();
		ctx.beginPath(); path(graticule); ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1; ctx.stroke();
		ctx.beginPath(); path(sphere); ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 2; ctx.stroke();
		ctx.beginPath(); bounds.map(project).forEach((t, i) => ctx[i ? "lineTo" : "moveTo"](t[0], t[1])); ctx.closePath();
		ctx.strokeStyle = "rgb(150,0,0)"; ctx.lineWidth = 1.5; ctx.stroke();
	}
}