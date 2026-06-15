import * as d3 from 'd3';
import { drawPBF } from "../modules/drawPBF.js"; // 🌟 drawPBFに変更
import { borderJSONs } from "../modules/borderJSONs.js";

let canvas, ctx, width, height, dpr, zoom;
const proj = d3.geoOrthographic();
const { PI, sin, cos, hypot } = Math, rad = PI / 180;
const getSidereal = d => ((18.697374 + 24.0657098 * ((d.getTime() + d.getTimezoneOffset() * 60000) / 864e5 + 2440587.5 - 2451545.0)) * 15) % 360;

const borders = await borderJSONs();
const { sphere, graticule, border, maritime, lines, stars } = borders;
console.log(borders)
const maxZoom = 7, minZoom = 2; 

// 🌟 .features を外して、GeoPBFをそのまま渡す
const jsons = [
	[ sphere, { maxZoom, minZoom, stroke: "rgba(255,255,255,0.8)", width: 0.8 }],
	[ graticule, { maxZoom, minZoom, stroke: "rgba(255,255,255,0.5)", width: 0.5 }],
	[ lines, { maxZoom, minZoom, stroke: "rgba(255,255,255,1)", width: 0.5, dash: [4, 2] }],
	[ border, { maxZoom, minZoom, stroke: "rgba(255,255,255,0.8)", width: 1, dash: [3, 1] }],
	[ maritime, { maxZoom, minZoom, stroke: "rgba(128,128,255,0.8)", width: 0.8, dash: [3, 1] }]
];

let _star = [];
if (stars && stars.features) {
    _star = stars.features.map(f => {
        const c = f.geometry.coordinates, p = f.properties;
        const bv = (v => v < -0.3 ? "#b2c8ff" : v < 0.0 ? "#d9e2ff" : v < 0.3 ? "#f8faff" : v < 0.6 ? "#fff8f0" :
            v < 0.8 ? "#fff2c8" : v < 1.1 ? "#ffe0b5" : v < 1.4 ? "#ffcc99" : "#ffab91")(p.bv);
        return { x: c[0] * rad, y: c[1] * rad, bv, a: 1 - p.mag / 8, mag: p.mag, r: (9 - p.mag) * 0.25 };
    });
}
postMessage({ type:"ready"});

const funcs = { init, drawing, resize, destroy };
onmessage = e => funcs[e.data.type] && funcs[e.data.type](e.data);

async function init(data) { 
	canvas = data.offscreen;
	dpr = data.dpr;
    // 🌟 path = d3.geoPath() が完全に消滅しました！
	ctx = canvas.getContext("2d");
	postMessage({ type: data.type, action: "done", ctx: ctx.constructor.name });
}

function resize(data) {
	width = data.width; height = data.height;
	canvas.width = width * dpr; canvas.height = height * dpr;
	proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
	ctx.scale(dpr, dpr);
}

function drawing(data) {
	requestAnimationFrame(() => {
		proj.rotate(data.rotate).scale(data.scale);
		zoom = Math.log2(data.scale * Math.PI * 2 / 256);
		if (!ctx) return;
		ctx.clearRect(0, 0, width, height);
		(zoom < 2 && _star.length) ? drawSky() :
		jsons.forEach(t => drawPBF.call({ ctx, proj, zoom, width, height }, ...t)); // 🌟 drawPBFに変更
	});
}

function destroy(data) {
	canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
	jsons.length = 0; _star = [];
	ctx = proj = null;
	postMessage({ type: data.type, action: "done" });
}

function drawSky() {
	const dt = new Date();
	const cx = width / 2, cy = height / 2;
	const er = proj.scale(), er2 = er * er;
	const sr = hypot(width, height) * (0.4 + zoom * 0.3);
	const r = proj.rotate() || [0, 0, 0];
	const skyRot = (getSidereal(dt) - r[0]) * rad;
	const sφ = sin(r[1] * rad), cφ = cos(r[1] * rad), sγ = sin(r[2] * rad), cγ = cos(r[2] * rad);
	ctx.save();
	for (let s of _star) {
		const l = s.x - skyRot, cl = cos(l), sl = -sin(l);
		const cp = cos(s.y), sp = sin(s.y);
		const x = cp * sl, y = cφ * sp - sφ * cp * cl, z = sφ * sp + cφ * cp * cl;
		if (z < 0) continue;
		const px = cx + sr * (x * cγ - y * sγ), py = cy - sr * (x * sγ + y * cγ);
		const dx = px - cx, dy = py - cy;
		if (dx * dx + dy * dy < er2 || px < 0 || px > width || py < 0 || py > height) continue;
		ctx.fillStyle = s.bv; ctx.globalAlpha = s.a;
		ctx.beginPath(); ctx.arc(px, py, s.r || 0.5, 0, PI * 2); ctx.fill();
	}
	ctx.restore();
	ctx.save();
	const halo = ctx.createRadialGradient(cx, cy, er, cx, cy, er + 15);
	halo.addColorStop(0, "rgba(100, 150, 255, 0.05)");
	halo.addColorStop(1, "rgba(100, 150, 255, 0)");
	ctx.fillStyle = halo;
	ctx.beginPath(); ctx.arc(cx, cy, er + 15, 0, PI * 2); ctx.fill();
	ctx.restore();
}