// geojson の押し出し（MapLibre の fill-extrusion・model.js の経路）の約束のうち、描画から切り離せる純関数（globe.js が使う・node の爪車 tests/mlcompat.mjs が確かめる）。
//   ① 描き直しの鍵（curveZoomKey）：押し出しは一度きりの評価＝止まるたびに鍵を見て、変わった時だけ評価し直して上げ直す（台帳 R22）。
//   ② 立体の当たり（hitExtrusion）：屋根と壁で当てる（MapLibre の queryIntersectsFeature／checkIntersection と同じ考え・台帳 R23）。
// vector の押し出し（段 8①）も同じ物を使う（vtmesh.paintZoomKey は exprZoomKey・vtextrude の query は hitExtrusion）＝二つの押し出しは同じ規則・同じ奥行きの物差し。

// ── ① 描き直しの鍵 ──────────────────────────────────────────────────────────────
// 一番外の interpolate（-hcl・-lab も）／step の入力が ["zoom"] 由来（正規化で ["-",["zoom"],k] もある）なら、止まりの外は "lo"/"hi"（値が一定）・
// 中は interpolate＝0.25 刻み／step＝段の番号。["zoom"] がそれ以外の所にある時は 0.25 刻み（段 5 の規則のまま）。["zoom"] の無い式は鍵に入れない。
// evalIn(e, z)＝入力式を zoom z で評価する関数（core evalExpr を包んで渡す＝ここは純関数のまま）
export const hasZoom = e => Array.isArray(e) && (e[0] === "zoom" || e.some(hasZoom));
const INTERP = new Set(["interpolate", "interpolate-hcl", "interpolate-lab"]);
const q4 = z => String(Math.round(z * 4) / 4);
export function exprZoomKey(e, z, evalIn) {   // → null（zoom に依らない）| "lo" | "hi" | "s<段>" | "<0.25 刻みの z>"
	if (!hasZoom(e)) return null;
	if (INTERP.has(e[0]) && hasZoom(e[2]) && !e.slice(3).some(hasZoom)) {
		const x = +evalIn(e[2], z);
		if (Number.isFinite(x)) return x <= e[3] ? "lo" : x >= e[e.length - 2] ? "hi" : q4(z);
	} else if (e[0] === "step" && hasZoom(e[1]) && !e.slice(2).some(hasZoom)) {
		const x = +evalIn(e[1], z);
		if (Number.isFinite(x)) { let seg = 0; for (let i = 3; i < e.length; i += 2) if (x >= e[i]) seg++; return "s" + seg; }
	}
	return q4(z);
}
// 層の鍵＝filter・paint・layout の式ごとの鍵をつないだもの（"" ＝どれも zoom に依らない）。書式は vtmesh.paintZoomKey と同じ（"名前:鍵"）
export function curveZoomKey(L, z, evalIn) {
	const parts = [];
	const add = (k, e) => { const s = exprZoomKey(e, z, evalIn); if (s != null) parts.push(k + ":" + s); };
	add("filter", L.filter);
	for (const g of ["paint", "layout"]) for (const k of Object.keys(L[g] || {}).sort()) add(k, L[g][k]);
	return parts.join("|");
}

// ── ② 立体の当たり ──────────────────────────────────────────────────────────────
// polys＝その地物の面の列（面＝[環…]・環＝[[lon,lat]…]・先頭が外周・以降は穴）。bottom/top＝下端と上端の高さ[m]（床の平面の持ち上げ込み）。
// q＝{ pt:[x,y] }（点・CSS px）か { box:[x0,y0,x1,y1] }（箱・x0≤x1・y0≤y1）。env＝今の視点の口（globe.js が作る）：
//   env.vtx(lon, lat, hM)＝その地点の地面から hM[m] の点の画面 [x, y, w]（w＝目からの奥行き＝clip の w）。見えない（目の後ろ・球の陰）は null
//   env.roof(x, y, hM, lon0, lat0)＝画面の点の光線が高さ hM の屋根の面を通る所 { ll:[lon,lat], w }。屋根を上から見ていない・外れ＝null（lon0/lat0＝地面の見当）
// 戻り＝当たった所の奥行き w（小さいほど手前＝MapLibre の intersectionZ と同じ使い方）か null。
//   屋根：点＝光線を屋根の高さで受けて経緯度で内外（平らな屋根は厳密。大きな面の頂点が目の後ろへ回っても当たる＝統計の押し出しに寄った時）。
//         箱＝屋根の頂点が箱に入る／箱の角と中心が屋根に当たる／屋根の縁が箱の縁と交わる。
//   壁：各辺の四角（下端→上端）を画面へ投影して内外（MapLibre と同じ。四隅のどれかが見えない壁は数えない）。
//   奥行き：点＝当たった所（壁は画面の重心座標で 1/w を補間＝透視で正しい）・箱＝当たった面の一番手前（MapLibre と同じ）。床（底面）は描かない＝当てない。
export function hitExtrusion(polys, bottom, top, q, env) {
	let best = Infinity;
	const pt = q.pt, box = q.box;
	for (const rings of polys) {
		if (!rings?.length || !(rings[0]?.length >= 3)) continue;
		const [lon0, lat0] = rings[0][0];
		const V = rings.map(r => r.map(([lon, lat]) => [env.vtx(lon, lat, bottom), env.vtx(lon, lat, top)]));   // 環の頂点ごとの [下端, 上端] の画面
		// 屋根
		if (pt) {
			const r = env.roof(pt[0], pt[1], top, lon0, lat0);
			if (r && inPolygonLL(rings, r.ll[0], r.ll[1])) best = Math.min(best, r.w);
		} else {
			const [x0, y0, x1, y1] = box;
			for (const ring of V) for (const [, t] of ring) if (t && t[0] >= x0 && t[0] <= x1 && t[1] >= y0 && t[1] <= y1) best = Math.min(best, t[2]);
			for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [(x0 + x1) / 2, (y0 + y1) / 2]]) {
				const r = env.roof(x, y, top, lon0, lat0);
				if (r && inPolygonLL(rings, r.ll[0], r.ll[1])) best = Math.min(best, r.w);
			}
			for (const ring of V) for (let i = 0; i < ring.length; i++) {
				const a = ring[i][1], b = ring[(i + 1) % ring.length][1];
				if (a && b && segHitsBox(a, b, box)) best = Math.min(best, a[2], b[2]);
			}
		}
		// 壁（環ごと・長さ 0 の辺＝閉じ点の重複は落とす＝extrude.js と同じ）
		for (let k = 0; k < rings.length; k++) {
			const R = rings[k], P = V[k], n = R.length;
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				if (R[i][0] === R[j][0] && R[i][1] === R[j][1]) continue;
				const [a0, a1] = P[i], [b0, b1] = P[j];
				if (!a0 || !a1 || !b0 || !b1) continue;
				const quad = [a0, b0, b1, a1];
				if (pt) { if (pipXY(pt[0], pt[1], quad)) best = Math.min(best, depthAt(quad, pt[0], pt[1])); }
				else if (quadHitsBox(quad, box)) best = Math.min(best, a0[2], b0[2], b1[2], a1[2]);
			}
		}
	}
	return best < Infinity ? best : null;
}

// 経緯度の面の内外（外周に入り・穴に入らない）
const inRing = (r, x, y) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
export const inPolygonLL = (rings, x, y) => inRing(rings[0], x, y) && !rings.slice(1).some(h => inRing(h, x, y));
// 画面の多角形（[x, y, …]）の内外・線分の交差
const pipXY = (x, y, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c; return c; };
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (b[0] - o[0]) * (a[1] - o[1]);
const segsCross = (a, b, c, d) => { const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d); return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)); };
const boxEdges = ([x0, y0, x1, y1]) => { const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; return c.map((p, i) => [p, c[(i + 1) % 4]]); };
const inBox = (p, [x0, y0, x1, y1]) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
const segHitsBox = (a, b, box) => inBox(a, box) || inBox(b, box) || boxEdges(box).some(([c, d]) => segsCross(a, b, c, d));
const quadHitsBox = (Q, box) => Q.some(p => inBox(p, box)) || boxEdges(box).some(([c]) => pipXY(c[0], c[1], Q)) || Q.some((p, i) => boxEdges(box).some(([c, d]) => segsCross(p, Q[(i + 1) % Q.length], c, d)));
// 平らな面の上の点 (x, y) の奥行き＝画面の重心座標で 1/w を補間（面の最初の退化していない三角形で・外でも同じ平面＝そのまま外挿）
export function depthAt(F, x, y) {
	const a = F[0];
	for (let k = 1; k + 1 < F.length; k++) {
		const b = F[k], c = F[k + 1], D = cross(a, b, c);
		if (Math.abs(D) < 1e-9) continue;
		const u = cross([x, y], b, c) / D, v = cross(a, [x, y], c) / D, iw = u / a[2] + v / b[2] + (1 - u - v) / c[2];
		if (iw > 0) return 1 / iw;
	}
	return Math.min(...F.map(p => p[2]));
}
