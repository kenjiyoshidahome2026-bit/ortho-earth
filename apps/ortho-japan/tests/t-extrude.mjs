#!/usr/bin/env node
// 押し出し（extrude.js＋gadgets/model.js の値の解決）の常設検定。幾何は Node で回る（earcut と finishMesh だけ）。
// 見るもの：①高さの鍵の自動判定（height/階数×3/"12m"/min_height/色の優先）②三角形数（屋根＋壁・穴つき）
// ③法線＝屋根は鉛直・外周の壁は外向き・穴の壁は穴の中心向き（環の巻きが CW でも CCW でも）④高さの無い面は立てない。
import { extrudeMesh } from "@ortho-earth/globe/extrude.js";
import { extrudePolys, heightOf, isMapLibreLayer } from "@ortho-earth/globe/gadgets/model.js";
import { hasHeightKey } from "@ortho-earth/globe/extrude-keys.js";

let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const sq = (lon, lat, d, cw) => { const r = [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]; return cw ? r.reverse() : r; };
const F = (properties, geometry) => ({ type: "Feature", properties, geometry });

t("鍵：height", heightOf({ height: 30 }) === 30);
t("鍵：'12m' の文字列", heightOf({ height: "12m" }) === 12);
t("鍵：階数×3m", heightOf({ "building:levels": 10 }) === 30);
t("鍵：日本語の列", heightOf({ 高さ: 8.5 }) === 8.5);
t("鍵：関数と定数", heightOf({ a: 2 }, p => p.a * 10) === 20 && heightOf({}, 7) === 7);
t("鍵の表：自動判定", hasHeightKey(["name", "measuredHeight"]) && !hasHeightKey(["name", "@fill"]));

const polys = extrudePolys([
	F({ height: 30, "@fill": "#ff000080" }, { type: "Polygon", coordinates: [sq(139.76, 35.68, 0.001), sq(139.7603, 35.6803, 0.0003, true)] }),
	F({ height: 90, min_height: 40, color: "#00ff00" }, { type: "MultiPolygon", coordinates: [[sq(139.77, 35.68, 0.0005)], [sq(139.772, 35.68, 0.0005)]] }),
	F({ name: "flat" }, { type: "Polygon", coordinates: [sq(139.78, 35.68, 0.0005)] }),
	F({ height: 10 }, { type: "LineString", coordinates: [[139.79, 35.68], [139.8, 35.68]] }),
]);
t("面の列：高さ無し・線は落ちる／MultiPolygon は面ごと", polys.length === 3, String(polys.length));
t("色：@fill（α は捨てる）", polys[0].rgba.join() === "255,0,0,255");
t("下端：min_height", polys[1].base === 40 && polys[1].h === 90 && polys[1].rgba.join() === "0,255,0,255");

for (const cw of [false, true]) {
	const p = extrudePolys([F({ height: 30 }, { type: "Polygon", coordinates: [sq(139.76, 35.68, 0.001, cw), sq(139.7603, 35.6803, 0.0003, !cw)] })]);
	const r = extrudeMesh(p, { mask: true });
	t(`${cw ? "CW" : "CCW"}：三角形＝屋根 8＋壁 16`, r.stats.triangles === 24 && r.mesh.idx.length === 72, JSON.stringify(r.stats));
	t(`${cw ? "CW" : "CCW"}：マスク枠が出る`, !!r.mask?.bbox && r.mesh.maskCells?.length > 0);
	const P = r.mesh.pos, N = r.mesh.nrm, n = P.length / 3, o = r.mesh.origin, ol = Math.hypot(...o), up = o.map(v => v / ol);
	let cx = 0, cy = 0, cz = 0; for (let i = 0; i < n; i++) { cx += P[i*3]; cy += P[i*3+1]; cz += P[i*3+2]; } cx /= n; cy /= n; cz /= n;
	let roof = 0, outer = 0, hole = 0, bad = 0;
	for (let i = 0; i < n; i++) {
		const nx = N[i*4], ny = N[i*4+1], nz = N[i*4+2];
		if ((nx * up[0] + ny * up[1] + nz * up[2]) / 127 > 0.99) { roof++; continue; }
		const dx = P[i*3] - cx, dy = P[i*3+1] - cy, dz = P[i*3+2] - cz, d = dx * nx + dy * ny + dz * nz;
		if (Math.hypot(dx, dy, dz) * 6371000 < 40) (d < 0 ? hole++ : bad++); else (d > 0 ? outer++ : bad++);
	}
	t(`${cw ? "CW" : "CCW"}：法線＝屋根は鉛直・外周は外・穴は内`, roof === 10 && outer === 16 && hole === 16 && bad === 0, JSON.stringify({ roof, outer, hole, bad }));
}
t("立つ面が無ければ null", extrudeMesh([]) === null);

// ---- MapLibre の fill-extrusion をそのまま（paint 式・filter・色の interpolate・既定値・opacity）----
{
	const fc = [
		F({ h: 100, kind: "office" }, { type: "Polygon", coordinates: [sq(139.76, 35.68, 0.001)] }),
		F({ h: 20, kind: "house", minh: 5 }, { type: "Polygon", coordinates: [sq(139.77, 35.68, 0.001)] }),
		F({ h: 50, kind: "shrine" }, { type: "MultiPolygon", coordinates: [[sq(139.78, 35.68, 0.001)]] }),
	];
	const layer = { type: "fill-extrusion", filter: ["!=", ["get", "kind"], "shrine"], paint: {
		"fill-extrusion-height": ["get", "h"], "fill-extrusion-base": ["coalesce", ["get", "minh"], 0],
		"fill-extrusion-color": ["interpolate", ["linear"], ["get", "h"], 0, "#000000", 100, "#ff0000"], "fill-extrusion-opacity": 0.5 } };
	t("MapLibre：層の見分け", isMapLibreLayer(layer) && !isMapLibreLayer({ height: "h" }));
	const ps = extrudePolys(fc, layer);
	t("MapLibre：filter で shrine が落ちる", ps.length === 2, String(ps.length));
	t("MapLibre：height/base の式", ps[0].h === 100 && ps[0].base === 0 && ps[1].h === 20 && ps[1].base === 5);
	t("MapLibre：色の interpolate（100m＝赤・20m＝暗い赤）", ps[0].rgba[0] === 255 && ps[1].rgba[0] === 51 && ps[1].rgba[1] === 0, JSON.stringify(ps.map(p => p.rgba)));
	t("MapLibre：opacity 0.5 が α へ", ps[0].rgba[3] === 128);
	const def = extrudePolys(fc, { type: "fill-extrusion", paint: { "fill-extrusion-height": ["*", ["get", "h"], ["zoom"]] }, zoom: 2 });
	t("MapLibre：既定色 #000000・zoom 式", def.length === 3 && def[0].h === 200 && def[0].rgba.join() === "0,0,0,255");
	t("MapLibre：height を書かない層は立たない（既定 0）", extrudePolys(fc, { type: "fill-extrusion", paint: { "fill-extrusion-color": "#fff" } }).length === 0);
}

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok}`);
process.exit(ng ? 1 : 0);
