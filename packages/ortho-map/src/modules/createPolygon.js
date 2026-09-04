// フルd3バレルは未使用の d3-zoom/brush/drag/transition 一式まで芋づるで初期バンドルに載る。
// 実際に使うのは d3-geo の5関数と d3-selection の select のみ＝個別importに絞って重い連鎖を断つ。
import { select } from "d3-selection";
import { geoArea, geoCentroid, geoInterpolate, geoPath } from "d3-geo";
// 計測値は WGS84（Vincenty 距離＋authalic 面積）＝ortho-japan measure ガジェットと同じ台帳。
// サブパス import＝geodesic.js は依存ゼロの純関数のみ（index.js 経由だと GL エンジン一式が芋づる）。
import { geodesicDistance, geodesicArea } from "ortho-core/geodesic";
// common（MIT）は ortho-core（GPL）を取り込めない＝この道具は GPL の ortho-map 側に置く（gadget1 の measure 専用）。
import { comma, antimeridianCut } from "common";

export function createPolygon(layer, opts = {}) {
	const map = layer.base, { dispatcher, proj, layers, cursor, isTouchDevice, isEditable } = map;
	const ctx = layer.context;
	let points = [], cpos, isGenerating = true;
	const { color, width, dash, radius, measure } = Object.assign({ color: "#880000", width: 2, dash: [], radius: [4, 2], measure: false }, opts);
	const fill = `rgba(${[1, 3, 5].map(i => parseInt("0x" + color.substring(i, i + 2))).concat([0.1]).join(",")})`;

	cursor("crosshair");
	dispatcher.on("Drawing.polygon", render);
	isTouchDevice || dispatcher.on("Move.polygon", render);
	const reciever = map.overlays.style("pointer-events", "auto");
	const nearDef = ([px, py], err) => { const err2 = err * err; return ([x, y]) => ((px - x) * (px - x) + (py - y) * (py - y) < err2); }
	reciever.on((isTouchDevice ? "touchstart" : "mousedown") + ".generate", generate);

	layer.get = () => isGenerating ? null : antimeridianCut(points);

	layer.exit = () => {
		layer.clear();
		dispatcher.on(".polygon", null);
		reciever.on(".generate .editcoords", null).style("pointer-events", "none");
		return points;
	};
	return layer;
	function generate(e) {
		if (!e) return;
		const xy = map.pointer(e), pt = proj.invert(xy), near = nearDef(xy, 4);
		if (isTouchDevice && points.length == 2) {
			points.push(pt);
			return edit();
		}
		if (points.length > 2) {
			const p1 = proj(points[points.length - 1]), p0 = proj(points[0]);
			if ((p1 && near(p1)) || (p0 && near(p0))) return edit();
		}
		points.push(pt);
		render();
	}
	function edit() {
		isGenerating = false; cursor("grab");
		points.push(points[0]);
		reciever.on(".generate", null).on((isTouchDevice ? "touchstart" : "mousedown") + ".editcoords", move);
		function move(e) {
			if (!e) return;
			isTouchDevice || e.stopPropagation();
			const num = search(); if (num < 0) return;
			const doc = select(document)
				.on("mouseup.point mouseleave.point touchend.point", () => { cursor("grab"); doc.on(".point", null); })
				.on("mousemove.point touchmove.point", e => {
					cursor("grabbing");
					points[num] = proj.invert(map.pointer(e));
					num == 0 && (points[points.length - 1] = points[0]);
					render();
				});
			function search() {
				const near = nearDef(map.pointer(e), isTouchDevice ? 12 : 6);
				for (let i = 0; i < points.length - 1; i++) {
					const p = proj(points[i]);
					if (p && near(p)) return i;
				}
				for (let i = 0; i < points.length - 1; i++) {
					const p = proj(geoInterpolate(points[i], points[i + 1])(0.5));
					if (p && near(p)) { points.splice(i + 1, 0, p); return i + 1; }
				}
				return -1;
			}
		}
	}
	function render(e) {
		layer.clear();
		if (!points.length || !isEditable()) return;
		var p = [].concat(points);
		isGenerating && onGenerating();
		isGenerating && isTouchDevice && points.length == 1 && mark(p[0], radius[0]);
		var f = pts2feature(); if (!f) return null;
		draw();
		p.forEach(t => mark(t, radius[0]));
		p.map((t, i) => i ? geoInterpolate(p[i - 1], t)(0.5) : null).slice(1).forEach(t => mark(t, radius[1]));
		measure && distance();

		function onGenerating() {
			cpos = (e && e.lng && e.lat) ? [e.lng, e.lat] : cpos;
			cpos && p.length >= 1 && (p = p.concat([cpos]));
			cpos && p.length >= 3 && (p = p.concat([p[0]]));
		}
		function draw() {
			const path = geoPath(proj, ctx);
			ctx.beginPath(); path(f);
			ctx.fillStyle = fill; p.length > 3 && ctx.fill();
			ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash.map(t => t * width / 2)); ctx.stroke();
		}
		function mark(pos, r) {
			const projected = proj(pos);
			if (!projected) return;
			const [x, y] = projected;
			ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
			ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
		}
		function pts2feature() {
			if (p.length > 3 && p[0] == p[p.length - 1]) {
				const coords = antimeridianCut(p);

				// Always structure as independent rings (MultiPolygon), never as a polygon-with-holes.
				const isFlat = typeof coords[0][0] === 'number';
				let multiCoords = isFlat ? [[coords]] : coords.map(ring => [ring]);

				const f = { type: "Feature", geometry: { type: "MultiPolygon", coordinates: multiCoords } };

				// Prevent D3 from filling the entire globe: if area >= hemisphere, reverse winding to flip inside/outside.
				if (geoArea(f) > 2 * Math.PI) {
					multiCoords = multiCoords.map(poly => poly.map(ring => [...ring].reverse()));
					f.geometry.coordinates = multiCoords;
				}

				return f;
			} else if (p.length > 1) {
				return { type: "Feature", geometry: { type: "LineString", coordinates: p } };
			}
			return null;
		}
		function distance() {
			let sum = 0;
			const fix = (m, n = 0) => comma(m.toFixed(n));
			const FIX = d => d < 0.1 ? fix(d * 1000, 1) + " m" : d < 1 ? fix(d * 1000, 0) + " m" : d < 10 ? fix(d, 2) + " km" : d < 100 ? fix(d, 1) + " km" : fix(d, 0) + " km";
			const FIXA = d => d < 1e6 ? fix(d) + " m2" : d < 1e9 ? fix(d / 1e6, 3) + " km2" : fix(d / 1e6) + " km2";
			ctx.save();
			ctx.fillStyle = "#fff"; ctx.font = "12px Arial"; ctx.shadowColor = "#000"; ctx.shadowBlur = 5;
			ctx.textAlign = "center"; ctx.textBaseline = "middle";

			for (let i = 0; i < p.length - 1; i++) {
				const d = geodesicDistance(p[i], p[i + 1]) / 1000; sum += d;   // WGS84（旧・球面 geoDistance×6371）
				const mid = proj(geoInterpolate(p[i], p[i + 1])(0.5));
				if (mid) ctx.fillText(FIX(d), ...mid);
			}

			if (p.length > 3) {
				// WGS84 authalic（旧・geoArea×球6371000²）。p は閉リング（末尾=先頭）＝重複閉点は無害。
				const areaSqMeters = geodesicArea(p);

				let center = geoCentroid(f);
				let projected = proj(center);
				if (!projected) {
					let lon = 0, lat = 0;
					for (let i = 0; i < p.length - 1; i++) { lon += p[i][0]; lat += p[i][1]; }
					center = [lon / (p.length - 1), lat / (p.length - 1)];
					projected = proj(center);
				}

				if (projected) {
					const [x, y] = projected;
					ctx.fillText("L= " + FIX(sum), x, y - 8);
					ctx.fillText("S= " + FIXA(areaSqMeters), x, y + 8);
				}
			}
			ctx.restore();
		}
	}
}