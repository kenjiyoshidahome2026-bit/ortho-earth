// 点の集約（クラスタ）＝canvas2D のオーバーレイ（レンダーワーカー内で地球と同じフレーム・同じカメラ・MapLibre の cluster 相当・2026-09-21）。
// main（gadgets/aggregate.js）がズームの段ごとに集約済みの丸（経緯度・半径・色・件数の文字）を渡す。ここは今のズームの段を選んで描くだけ。
// 段の選び方＝MapLibre と同じ floor(zoom)（maxLevel より上は最後の段＝ばらした点）。地球の裏側（投影の front<0）は描かない。
// 契約（app.js の map.overlay）：init(canvas) / message(data) / frame(cam, camState, size, api) / destroy()。依存ゼロ。

let ctx = null, levels = [], minLevel = 0, maxLevel = 0, range = { clusters: [-Infinity, Infinity], unclustered: [-Infinity, Infinity] };   // range＝層ごとの出しズーム（MapLibre の minzoom 包含・maxzoom 排他）
export function init(canvas) { ctx = canvas.getContext("2d"); }
// data＝{ type:"levels", minLevel, maxLevel, levels:[[{ lon, lat, r, fill, stroke, sw, text, tc, ts, op }…] …] } | { type:"clear" }
export function message(d) {
	if (d.type === "clear") { levels = []; return; }
	if (d.type === "levels") { levels = d.levels; minLevel = d.minLevel; maxLevel = d.maxLevel; }
	if (d.type === "range") range = { clusters: d.clusters, unclustered: d.unclustered };
}
export function frame(cam, s, { w, h }, api) {
	if (!ctx) return false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, w, h);
	if (!levels.length || !api) return false;
	const dpr = api.dpr || 1, L = levels[Math.max(0, Math.min(levels.length - 1, Math.floor(cam.zoom || 0) - minLevel))] || [];
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	const W = w / dpr, H = h / dpr;
	ctx.textAlign = "center"; ctx.textBaseline = "middle";
	const z = cam.zoom || 0, inR = r => z >= r[0] && z < r[1], showC = inR(range.clusters), showU = inR(range.unclustered);
	for (const c of L) {
		if (!(c.u ? showU : showC)) continue;
		const [x, y, f] = api.project(c.lon, c.lat);
		if (f < 0 || x < -c.r || y < -c.r || x > W + c.r || y > H + c.r) continue;
		ctx.globalAlpha = c.op ?? 1;
		ctx.beginPath(); ctx.arc(x, y, c.r, 0, Math.PI * 2);
		ctx.fillStyle = c.fill; ctx.fill();
		if (c.sw > 0) { ctx.lineWidth = c.sw; ctx.strokeStyle = c.stroke; ctx.stroke(); }
		if (c.text) { ctx.font = `600 ${c.ts || 12}px "Noto Sans JP",system-ui,sans-serif`; ctx.fillStyle = c.tc || "#222"; ctx.fillText(c.text, x, y + 0.5); }
	}
	ctx.globalAlpha = 1;
	return false;
}
export function destroy() { ctx = null; levels = []; }
