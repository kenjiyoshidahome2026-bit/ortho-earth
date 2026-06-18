import { geoPath, geoOrthographic, geoGraticule10 } from 'd3-geo';
import { comma, dateArray, timeArray, L2, isObject } from "common";
import { geopbf } from "geopbf";

const accessories = {
	borders: { minZoom: 2, maxZoom: 7, graticule: true, border: true, maritime: true, geolines: true },
	globe: { maxZoom: 8, size: 125, bottom: 30, right: 20, land: "rgb(160,200,160)", sea: "rgb(200,240,255)", line: "rgb(150,0,0)" },
	stars: { maxZoom: 2, maxCount: Infinity },
	night: { maxZoom: 2 },
	clock: { maxZoom: 2 },
	latlng: { minZoom: 2, color: "white" },
	scale: { minZoom: 2, color: "white", unit: "metric" },
	credit: { minZoom: 2, color: "white" },
};
const { sin, cos, asin, hypot, atan2, log2, log10, floor, PI } = Math, rad = PI / 180;
const getSidereal = d => ((18.697374 + 24.0657098 * ((d.getTime() + d.getTimezoneOffset() * 60000) / 864e5 + 2440587.5 - 2451545.0)) * 15) % 360;

let canvas, layer, width, height, dpr, path, zoom, attribution;
let active = false, noCircle = 3, isNarrow = false, timer = null;
let jsons = null;
const proj = geoOrthographic();
const sphere = { type: "Sphere" };
const graticule = geoGraticule10();

const funcs = { init, set, drawing, drawn, move, leave, resize, destroy, click:(()=>{}) };
onmessage = e => funcs[e.data.type](e.data);

function init(data) {
	canvas = data.offscreen, dpr = data.dpr;
	layer =  canvas.getContext("2d"); if (!layer) console.error('Context取得失敗 - Safariのバージョン確認');
	path = geoPath(proj, layer);
	postMessage({ type: data.type, action: "done", ctx: layer.constructor.name });
}
async function set(data) {
	if (data.data != "options") return postMessage({ type: data.type, action: "failed" });
	if (data.rawBuffers && !jsons) jsons = await Promise.all(data.rawBuffers.map(async t=>(await geopbf(t,{gint:false})).geojson));
	const opts = data.prop || {};
	const lang = opts.lang || "en";
	for (let i in accessories) {
		if (opts[i] === false) {
			accessories[i] = null;
		} else if (isObject(opts[i])) {
			for (let j in accessories[i]) accessories[i][j] = opts[i][j];
		}
	}
	accessories.latlng.names = [
		{ en: "LAT", ja: "緯度", zh: "纬度", ko: "위도" }[lang],
		{ en: "LNG", ja: "経度", zh: "经度", ko: "경도" }[lang],
		{ en: "ALT", ja: "標高", zh: "海拔", ko: "고도" }[lang]
	];
	const q = accessories.borders;
	if (q) {
		const borders = q.jsons = [[sphere, { stroke: "rgba(200,200,200,0.8)", width: 0.8 }]];
		q.graticule === false || borders.push([graticule, { stroke: "rgba(255, 255, 255, 0.5)", width: 0.5 }]);
		q.border === false || borders.push([jsons[0], { stroke: "rgba(255,255,255,0.8)", width: 1, dash: [3, 1] }]);
		q.maritime === false || borders.push([jsons[1], { stroke: "rgba(128,128,255,0.8)", width: 0.8, dash: [3, 1] }]);
		q.geolines === false || borders.push([jsons[2], { stroke: "rgba(255,255,255,1)", width: 0.5, dash: [4, 2] }]);
	}
	accessories.globe.json = jsons[3];
	accessories.stars.data = jsons[4].features.map(f => {
		const c = f.geometry.coordinates, p = f.properties;
		const bv = (v => v < -0.3 ? "#b2c8ff" : v < 0.0 ? "#d9e2ff" : v < 0.3 ? "#f8faff" : v < 0.6 ? "#fff8f0" :
			v < 0.8 ? "#fff2c8" : v < 1.1 ? "#ffe0b5" : v < 1.4 ? "#ffcc99" : "#ffab91")(p.bv);
		return { x: c[0] * rad, y: c[1] * rad, mag: p.mag, bv };
	}).sort((p, q) => p.mag > q.mag ? 1 : -1).slice(0, accessories.stars.maxCount);
	active = true;
	if (timer) clearInterval(timer);
	timer = setInterval(() => {
		if (!layer) return;
		draw_night();
		draw_stars();
	}, 1000);

	postMessage({ type: data.type, action: "done" });
}
function resize(data) {
	width = data.width; height = data.height;
	canvas.width = ~~(width * dpr); canvas.height = ~~(height * dpr);
	proj.fitExtent([[1, 1], [width - 1, height - 1]], { type: "Sphere" });
	layer.scale(dpr, dpr);
	noCircle = log2(hypot(width, height) * PI / 256);
	isNarrow = width < 1000;
	postMessage({ type: data.type, action: "done" });
}
function drawing(data) {
	if (!active) return;
	layer.clearRect(0, 0, width, height);
	proj.rotate(data.rotate).scale(data.scale);
	zoom = log2(data.scale * PI * 2 / 256);
	attribution = data.attr;
	draw_border();
	draw_globe();
	draw_night();
	draw_stars();
	draw_latlng();
	draw_scale();
	draw_credit();
}
function move(data) {
	if (!active) return;
	const q = accessories.latlng, names = q.names;
	q.string = data.lat ? `${names[0]}: ${data.lat.toFixed(6)} ${names[1]}: ${data.lng.toFixed(6)}${data.alt ? ` ${names[2]}: ${data.alt.toFixed(1)}[m]` : ""}` : "";
	draw_latlng();
}
function leave() {
	if (!active) return;
	const w = 350, h = 25;
	isNarrow ? layer.clearRect((width - w) / 2, 0, w, h) : layer.clearRect(0, height - h, w, h);
}
function drawn() { }

function destroy(data) {
	if (timer) clearInterval(timer);
	canvas && (canvas.width = 0, canvas.height = 0); canvas = null;
	if (accessories.borders && accessories.borders.jsons) accessories.borders.jsons.length = 0;
	layer = path = proj = null;
	postMessage({ type: data.type, action: "done" });
}
////--------------------------------------------------------------
function draw_border() {
	const q = accessories.borders;
	if (!q || zoom < q.minZoom || q.maxZoom < zoom) return;
	q.jsons.forEach(([json, prop]) => {
		// 【修正】ETag/キャッシュ不整合等でjsonが空の場合はスキップ
		if (!json) return;
		layer.save();
		layer.beginPath(); path(json);
		layer.strokeStyle = prop.stroke;
		layer.lineWidth = prop.width || 1;
		layer.setLineDash(prop.dash || []);
		layer.stroke();
		layer.restore();
	});
}
function draw_latlng() {
	const q = accessories.latlng; leave()
	if (!q || zoom < q.minZoom || !q.string) return;
	layer.save();
	layer.font = "12px Verdana"; layer.textBaseline = "middle"; layer.fillStyle = q.color;
	layer.textAlign = isNarrow ? "center" : "left";
	layer.fillText(q.string, isNarrow ? width / 2 : 10, isNarrow ? 10 : height - 10);
	layer.restore();
}
function draw_scale() {
	const q = accessories.scale;
	if (!q || zoom < q.minZoom) return;
	const R = 6372000 * 2, M = width / 2, H = height - 30 - (isNarrow ? 20 : 0);
	const useImperial = q.unit === "imperial";
	const [n, v, unit] = (function () {
		const d256m = (R * PI) / 2 ** zoom; // 256pxあたりのメートル
		if (useImperial) {
			const d256mi = d256m / 1609.344;
			const r = 10 ** floor(log10(d256mi));
			const v_mi = (d256mi / r) > 5 ? 5 : (d256mi / r) > 2 ? 2 : 1;
			const val = v_mi * r;
			return val < 0.25
				? [256 * val / d256mi, val * 5280, "ft"]
				: [256 * val / d256mi, val, "mi"];
		} else {
			const r = 10 ** floor(log10(d256m));
			const v_m = (d256m / r) > 5 ? 5 : (d256m / r) > 2 ? 2 : 1;
			const val = v_m * r;
			return val >= 1000
				? [256 * val / d256m, val / 1000, "km"]
				: [256 * val / d256m, val, "m"];
		}
	})();
	const decimal = (v < 10 && unit !== "m" && unit !== "ft") ? 1 : 0;
	const str = `${comma(v.toFixed(decimal))}${unit} (z=${zoom.toFixed(2)})`;
	layer.save();
	layer.font = "12px Verdana"; layer.textBaseline = "bottom"; layer.textAlign = "center";
	layer.strokeStyle = layer.fillStyle = q.color;
	layer.beginPath();
	layer.moveTo(M - n / 2, H + 20); layer.lineTo(M + n / 2, H + 20);
	layer.lineWidth = 3; layer.stroke();
	layer.beginPath();
	layer.moveTo(M - n / 2, H + 10); layer.lineTo(M - n / 2, H + 25);
	layer.moveTo(M + n / 2, H + 10); layer.lineTo(M + n / 2, H + 25);
	layer.lineWidth = 1; layer.stroke();
	layer.fillText(str, M, H + 15);
	layer.restore();
}
function draw_credit() {
	const q = accessories.credit;
	if (!q || zoom < q.minZoom || !attribution) return;
	layer.save();
	layer.font = "12px Verdana"; layer.textBaseline = "middle"; layer.fillStyle = q.color;
	layer.textAlign = isNarrow ? "center" : "right";
	layer.fillText(attribution, isNarrow ? width / 2 : width - 10, height - 10);
	layer.restore();
}
function draw_globe() {
	const q = accessories.globe;
	if (!q || zoom > q.maxZoom || zoom < noCircle) return;
	const size = q.size || 125, gap = isNarrow ? 25 : 0;
	const x0 = q.left ? q.left : width - size - (q.bottom || 20);
	const y0 = q.top ? q.top + gap : height - size - (q.bottom || 30) - gap;
	const project = geoOrthographic().fitExtent([[x0, y0], [x0 + size, y0 + size]], sphere).precision(0.1);
	const r = proj.rotate(); project.rotate([r[0], r[1], 0]);
	const path = geoPath(project, layer);

	// 【修正】四隅が宇宙空間（null）になった場合のクラッシュを回避
	const bounds = [[0, 0], [width, 0], [width, height], [0, height]]
		.map(proj.invert)
		.map(p => p ? project(p) : null)
		.filter(p => p != null);

	layer.save();
	layer.clearRect(x0, y0, x0 + size, y0 + size);
	layer.beginPath(); path(sphere); layer.fillStyle = q.sea; layer.fill();
	layer.beginPath(); path(q.json); layer.fillStyle = q.land; layer.fill();
	layer.beginPath(); path(graticule); layer.strokeStyle = "rgba(255,255,255,0.5)"; layer.lineWidth = 1; layer.stroke();
	layer.beginPath(); path(sphere); layer.strokeStyle = "rgba(255,255,255,0.5)"; layer.lineWidth = 2; layer.stroke();

	// 【修正】有効な座標が残っている場合のみ線を描画
	if (bounds.length > 0) {
		layer.beginPath();
		bounds.forEach((t, i) => layer[i === 0 ? "moveTo" : "lineTo"](t[0], t[1]));
		layer.closePath();
		layer.strokeStyle = q.line; layer.lineWidth = 1.5; layer.stroke();
	}
	layer.restore();
}
function draw_stars() {
	const q = accessories.stars;
	if (!q || zoom > q.maxZoom) return;
	const dt = new Date();
	const cx = width / 2, cy = height / 2, er = proj.scale(), er2 = er * er;
	const sr = hypot(width, height) * (0.4 + zoom * 0.3);
	const r = proj?.rotate() || [0, 0, 0];
	const skyRot = (getSidereal(dt) - r[0]) * rad;
	const sφ = sin(r[1] * rad), cφ = cos(r[1] * rad), sγ = sin(r[2] * rad), cγ = cos(r[2] * rad);
	layer.save();
	for (let s of q.data) {
		const l = s.x - skyRot, cl = cos(l), sl = -sin(l);
		const cp = cos(s.y), sp = sin(s.y);
		const x = cp * sl, y = cφ * sp - sφ * cp * cl, z = sφ * sp + cφ * cp * cl; if (z < 0) continue;
		const px = cx + sr * (x * cγ - y * sγ), py = cy - sr * (x * sγ + y * cγ);
		const dx = px - cx, dy = py - cy;
		if (dx * dx + dy * dy < er2 || px < 0 || px > width || py < 0 || py > height) continue;
		layer.fillStyle = s.bv; layer.globalAlpha = 1 - s.mag / 15;
		layer.beginPath(); layer.arc(px, py, (9 - s.mag) * 0.20, 0, PI * 2); layer.fill();
	}
	layer.restore();
}
function draw_night() {
	let q = accessories.night;
	const dt = new Date();
	if (q && zoom < q.maxZoom) {
		const json = nightJSON(dt);
		const cx = width / 2, cy = height / 2, er = proj.scale(), er2 = er * er;
		const halo = layer.createRadialGradient(cx, cy, er, cx, cy, er + 15);
		halo.addColorStop(0, "rgba(100, 150, 255, 0.05)"); halo.addColorStop(1, "rgba(100, 150, 255, 0)");
		const path = geoPath(proj, layer);
		layer.save();
		layer.clearRect(0, 0, width, height);
		layer.fillStyle = halo;
		layer.beginPath(); layer.arc(cx, cy, er + 15, 0, PI * 2); layer.fill();
		layer.beginPath(); layer.arc(cx, cy, er, 0, PI * 2); layer.clip();
		layer.beginPath(); path(json); layer.fillStyle = "rgba(0, 5, 20, 0.5)"; layer.fill();
		layer.restore();
	}
	q = accessories.clock;
	if (q && zoom < q.maxZoom) {
		layer.save();
		layer.textAlign = "center"; layer.textBaseline = "middle"; layer.fillStyle = "#fff";
		layer.font = `${32 * (2 - zoom) + 16}px Verdana`;
		const [Y, M, D] = dateArray(), [h, m, s] = timeArray();
		layer.fillText(`${L2(h)}:${L2(m)}:${L2(s)}`, cx, height / 5);
		layer.font = `${12 * (2 - zoom) + 8}px Verdana`;
		layer.fillText(`${Y}/${L2(M)}/${L2(D)} (${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()]})`, cx, height * 0.85);
		layer.restore();
	}
}
function nightJSON(date, offset = 0) {
	const R = PI / 180, D = 180 / PI;
	const d = date.getTime() / 864e5, y = (d / 365.24 % 1 - 0.225) * PI * 2;
	const lat = 23.4 * sin(y), lng = ((d % 1 * -360 + 360) % 360) - 180;
	const ra = (90 + offset) * R, phi = lat * R, lam = lng * R;
	const sP = sin(phi), cP = cos(phi), sR = sin(ra), cR = cos(ra), sRcP = sR * cP;
	const coords = new Array(31);
	for (let i = 0; i <= 30; i++) {
		const a = (360 - i * 12) * R, sA = sin(a), cA = cos(a);
		const sLt = sP * cR + cP * sR * cA, lt = asin(sLt);
		const ln = lam + atan2(sA * sRcP, cR - sP * sLt);
		coords[i] = [((ln * D + 180) % 360 + 360) % 360 - 180, lt * D];
	}
	return { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] } };
}
