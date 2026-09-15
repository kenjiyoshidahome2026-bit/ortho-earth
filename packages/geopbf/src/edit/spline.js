// @spline（滑らか曲線）＝制御点列→Catmull-Rom 細分。純幾何（DOM/描画なし）＝フォーマット水準の正典。
// 8/29 に ortho-japan/gadgets/anno.js から昇格（sanitize と同じ型＝描画側 anno は再輸出で追従）。
// エディタ（geopbf/edit/model）と再生（anno の @spline 描画）が同じ一本を使う＝WYSIWYG の担保。
// 球面版（本人裁定 2026-09-15「@spline も球面で」）：制御点を単位ベクトルにして 3D で Catmull-Rom（一様・tension 0.5）を
// 回し、正規化して球へ戻す。線形結合と正規化は回転と可換＝曲線は球の回転で不変（極でも縫い目でも同じ形）。
// 経緯度で回すと「メルカトルの曲線を球に貼った」形（東西が cos(lat) で潰れ・縫い目/極で破綻）になる。
// 標本点同士は呼び手が大円で結ぶ（overlay/anno の seg・gint の度アンカー）。制御点は標本点にそのまま含まれる（t=0 は原値）。
// unwrapLons/wrapLon は経緯度の平行移動（model の tr）等の別用途で残す（球面版の補間には不要）。
import { toVec, toLL } from "./sphere.js";
export const wrapLon = x => (x >= -180 && x < 180) ? x : ((x + 180) % 360 + 360) % 360 - 180;
export const unwrapLons = pts => {
	const out = new Array(pts.length);
	for (let i = 0, prev = 0; i < pts.length; i++) {
		let x = pts[i][0];
		if (i) { const k = Math.round((x - prev) / 360); if (k) x -= k * 360; }   // 前点から最短側へ（k=0 は無変換）
		out[i] = [x, pts[i][1]]; prev = x;
	}
	return out;
};
export function smoothRing(coords, closed, steps = 12) {
	let pts = coords;
	if (closed && pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
	const n = pts.length;
	if (n < 3) return coords.slice();   // 少なすぎ＝そのまま
	const V = pts.map(p => toVec(p[0], p[1]));
	const idx = i => closed ? (i % n + n) % n : Math.max(0, Math.min(n - 1, i));
	const out = [];
	const segEnd = closed ? n : n - 1;
	for (let i = 0; i < segEnd; i++) {
		const p0 = V[idx(i - 1)], p1 = V[idx(i)], p2 = V[idx(i + 1)], p3 = V[idx(i + 2)];
		out.push([wrapLon(pts[idx(i)][0]), pts[idx(i)][1]]);   // t=0＝制御点そのもの（範囲内は wrapLon が素通し＝1ulp 動かさない・出力は [-180,180)）
		for (let j = 1; j < steps; j++) {
			const t = j / steps, t2 = t * t, t3 = t2 * t;   // Catmull-Rom（一様・tension 0.5）を単位ベクトルの各成分で
			const c0 = -t + 2 * t2 - t3, c1 = 2 - 5 * t2 + 3 * t3, c2 = t + 4 * t2 - 3 * t3, c3 = -t2 + t3;
			const x = c0 * p0[0] + c1 * p1[0] + c2 * p2[0] + c3 * p3[0];
			const y = c0 * p0[1] + c1 * p1[1] + c2 * p2[1] + c3 * p3[1];
			const z = c0 * p0[2] + c1 * p1[2] + c2 * p2[2] + c3 * p3[2];
			const l = Math.hypot(x, y, z);
			out.push(l > 1e-12 ? toLL([x / l, y / l, z / l]) : [pts[idx(i)][0], pts[idx(i)][1]]);   // 退化（対蹠の打ち消し）は制御点に留める
		}
	}
	out.push(closed ? [out[0][0], out[0][1]] : [wrapLon(pts[n - 1][0]), pts[n - 1][1]]);   // 閉じ or 終端
	return out;
}
export function smoothGeom(g) {   // 線/面のジオメトリを曲線化（点系はそのまま）
	if (g.type === "LineString") return { type: g.type, coordinates: smoothRing(g.coordinates, false) };
	if (g.type === "MultiLineString") return { type: g.type, coordinates: g.coordinates.map(l => smoothRing(l, false)) };
	if (g.type === "Polygon") return { type: g.type, coordinates: g.coordinates.map(r => smoothRing(r, true)) };
	if (g.type === "MultiPolygon") return { type: g.type, coordinates: g.coordinates.map(p => p.map(r => smoothRing(r, true))) };
	return g;
}
