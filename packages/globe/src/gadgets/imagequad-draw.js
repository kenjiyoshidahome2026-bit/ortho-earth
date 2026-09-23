// 四隅で貼った画像を「覆う」描き方（2026-09-21・本人裁定「画像で覆いましょう」）＝render worker の組み込みオーバーレイ。
// 画像タイル層（地面アトラス）は塗りと同じ合成で、道路・建物・注記はその後に描かれる＝上に乗られてしまう。ここは同一フレームの
// オーバーレイ（注記の後）に、geoedit の編集中と同じ drawImageQuad（geopbf/edit/imagequad）で描く＝道路も注記も覆い、編集中と見え方が一致する。
// 投影は地形の持ち上げ込み（api.project）＝格子の頂点ごとに地形へ沿う。⚠傾けた時の遮蔽（手前の山・建物の陰）は無い＝常に一番上。
// 契約（app.js map.overlay）：init(canvas) / message(data) / frame(cam, camState, size, api) / destroy()。
import { drawImageQuad } from "geopbf/edit/imagequad";

let ctx = null;
const quads = new Map();   // id → { bm, corners, opacity }
export function init(canvas) { ctx = canvas.getContext("2d"); }
// data＝{ type:"set", id, bitmap, corners, opacity } | { type:"opacity", id, opacity } | { type:"remove", id } | { type:"clear" }
export function message(d) {
	if (d.type === "set") { quads.get(d.id)?.bm?.close?.(); quads.set(d.id, { bm: d.bitmap, corners: d.corners, opacity: d.opacity ?? 1 }); }
	else if (d.type === "opacity") { const q = quads.get(d.id); if (q) q.opacity = d.opacity; }
	else if (d.type === "remove") { quads.get(d.id)?.bm?.close?.(); quads.delete(d.id); }
	else if (d.type === "clear") { for (const q of quads.values()) q.bm?.close?.(); quads.clear(); }
}
export function frame(cam, s, { w, h }, api) {
	if (!ctx) return false;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.clearRect(0, 0, w, h);
	if (!quads.size || !api) return false;
	const dpr = api.dpr || 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.imageSmoothingQuality = "high";
	const proj = (lo, la) => { const q = api.project(lo, la); return q[2] < 0 ? null : [q[0], q[1]]; };
	for (const q of quads.values()) drawImageQuad(ctx, q.bm, q.corners, proj, { grid: 16, alpha: q.opacity });
	return false;
}
export function destroy() { message({ type: "clear" }); ctx = null; }
