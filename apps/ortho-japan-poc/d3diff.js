// d3 突合ハーネス：pitch=0 で japan(mat4) と d3.geoOrthographic の一致を数値で検証（v1 oracle）。
// 中心スケールを japan に合わせ込んで zoom規約差(256/512, cosφ)を除去し、残差＝有限D透視 vs 無限D正射の
// "形の差"だけを測る。三方向：
//   逆(m)   japan unproject vs d3 invert
//   順(px)  japan project   vs d3 forward
//   往復(px) japan project∘unproject == 恒等（＝「正確な逆関数」＝整合性の定義の自己検証）
// zoom を掃引して高ズームでの収束を見る。
import { geoOrthographic } from "d3-geo";
import { cameraState, project, unproject } from "ortho-japan";

const D2R = Math.PI / 180, R2D = 180 / Math.PI, R = 6371000;

// 2点(lon/lat)間の大円距離(m)
function haversine(a, b) {
	const φ1 = a[1] * D2R, φ2 = b[1] * D2R, dφ = (b[1] - a[1]) * D2R, dλ = (b[0] - a[0]) * D2R;
	const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
	return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function diffAtZoom(cam, W, H, zoom) {
	const c = { ...cam, zoom, pitch: 0 };   // pitch=0 スライス（center/bearing は現状のまま）
	const [lon, lat] = c.center, dpr = c.dpr || 1;
	// japan の中心スケール(device px/radian) を測って d3.scale に入れる＝中心で一致を保証、規約差を除去
	const radPerDevPx = 2 * Math.PI / (Math.pow(2, zoom) * 512 * dpr) * Math.max(0.05, Math.cos(lat * D2R));
	const proj = geoOrthographic()
		.translate([W / 2, H / 2])
		.scale(1 / radPerDevPx)
		.rotate([-lon, -lat, (c.bearing || 0) * R2D]);   // d3 rotate = [-lon, -lat, bearing°]
	const st = cameraState(c, W, H);

	const acc = { inv: [0, 0, 0], fwd: [0, 0, 0], rt: [0, 0, 0] };   // [max, sum, n]
	const add = (a, v) => { a[0] = Math.max(a[0], v); a[1] += v; a[2]++; };
	for (let jy = 0; jy <= 6; jy++) for (let ix = 0; ix <= 6; ix++) {
		const px = W * ix / 6, py = H * jy / 6;
		const j = unproject(st, px, py);          // japan 逆：screen → lon/lat
		const d = proj.invert([px, py]);          // d3 逆
		if (j && d) add(acc.inv, haversine(j, d));                        // 逆(m)
		if (j) {
			const pj = project(st, j[0], j[1]);   // japan 順：lon/lat → screen
			if (pj[2] > 0) {
				add(acc.rt, Math.hypot(pj[0] - px, pj[1] - py));         // 往復(px) japan 自己逆関数
				const pd = proj([j[0], j[1]]);    // d3 順
				if (pd) add(acc.fwd, Math.hypot(pj[0] - pd[0], pj[1] - pd[1]));   // 順(px) japan vs d3
			}
		}
	}
	const mean = a => a[2] ? a[1] / a[2] : NaN;
	return {
		zoom,
		"逆_平均m": +mean(acc.inv).toFixed(2), "逆_最大m": Math.round(acc.inv[0]),
		"順_平均px": +mean(acc.fwd).toFixed(3), "順_最大px": +acc.fwd[0].toFixed(2),
		"往復_最大px": +acc.rt[0].toFixed(4),
	};
}

// window.__d3diff() で呼ぶ。現在の center を軸に zoom を掃引し、三方向の残差の収束を表で出す。
export function d3diff(cam, size) {
	const W = size.w, H = size.h;
	const rows = [4, 6, 8, 10, 12, 14, 16].map(z => diffAtZoom(cam, W, H, z));
	console.table(rows);
	console.log(
		"japan(mat4,pitch=0) vs d3.geoOrthographic（中心スケール合わせ込み後）:\n" +
		"　逆/順 → 高ズームで0へ収束＝有限D透視が正射に一致＝identify域で japan≡d3。低ズームの差は透視球vs正射円盤の意図的差。\n" +
		"　往復 → japan の project∘unproject 誤差（d3非依存の自己検証）。全ズームで≈0なら『正確な逆関数』＝整合性OK。"
	);
	return rows;
}
