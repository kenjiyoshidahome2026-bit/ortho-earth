// Esri の環の約束（FileGDB の幾何・ArcGIS REST の Esri JSON が同じ）＝外環は時計回り・穴は反時計回り・1 地物の環が平たく並ぶ。
// filegdb.js（2026-09-12）から切り出し（#176 フィーチャーサービスの f=json と共用）。依存なし。
/** Esri の平坦な環の列 → Polygon / MultiPolygon（外環=時計回り・穴=反時計回り。GeoJSON 流に外環を反時計回りへ揃える）。
 *  ctx.empty＝形にならなかった数（数えるだけ）。 */
export function assemblePolygons(rings, ctx = { empty: 0 }) {
	if (!rings.length) { ctx.empty++; return null; }
	const area = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; };   // <0 = 時計回り（y 上向き）
	const outers = [], holes = [];
	for (const r of rings) { const a = area(r); if (a === 0) continue; if (a < 0) outers.push([r.slice().reverse()]); else holes.push(r.slice().reverse()); }
	if (!outers.length) { if (!holes.length) { ctx.empty++; return null; } outers.push([holes.shift().reverse()]); }   // 向きが逆に書かれた単独環
	for (const h of holes) {
		let host = outers.length === 1 ? outers[0] : outers.find(o => inside(h[0], o[0])) ?? outers.find(o => h.some(p => inside(p, o[0])));
		if (!host) host = outers[0];
		host.push(h);
	}
	return outers.length === 1 ? { type: "Polygon", coordinates: outers[0] } : { type: "MultiPolygon", coordinates: outers };
}
export function inside(p, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }

