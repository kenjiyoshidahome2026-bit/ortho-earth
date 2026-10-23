// 写真の画素座標 → 実寸（cm）の算術。DOM に依らない純関数（tests/t-sokutei.mjs で検定）。
//
// 基準物の 2 つの方式：
//   "a4"   ＝ 基準物（A4 用紙など既知の縦横の長方形）の 4 隅をタップ。4 点から射影変換（ホモグラフィ）を解き、
//            写真の任意の点を「基準物が置かれた平面上の mm 座標」へ写す。斜めから撮っても、個体が基準物と同じ地面に
//            横たわっている限り遠近の歪みが打ち消される（推奨）。
//   "line" ＝ 既知の長さの 2 点（メジャーの両端など）をタップ。画素あたりの長さ 1 つで割るだけ＝真上から撮った時だけ正しい。
//
// 個体は 鼻先 と 尾の付け根 の 2 点（体長＝鼻先〜尾の付け根。捕獲報告の「体長」の慣用に合わせる）。
// 任意で中間点を足して折れ線にできる（体が曲がっている個体＝折れ線の長さの和）。

/** 4 組の対応点 src[i] → dst[i] から 3x3 のホモグラフィ H（行優先・h33=1）を解く。DLT の 8x8 を消去法で。 */
export function solveHomography(src, dst) {
	if (src.length !== 4 || dst.length !== 4) throw new Error("4 点が要る");
	const A = [], b = [];
	for (let i = 0; i < 4; i++) {
		const [x, y] = src[i], [u, v] = dst[i];
		A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
		A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
	}
	const h = solve(A, b);
	if (!h) return null;   // 4 点のうち 3 点が一直線など＝解けない
	return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 部分ピボット付きガウス消去（n×n）。特異なら null。 */
function solve(A, b) {
	const n = b.length, M = A.map((r, i) => [...r, b[i]]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
		if (Math.abs(M[p][c]) < 1e-12) return null;
		[M[c], M[p]] = [M[p], M[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = M[r][c] / M[c][c];
			if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
		}
	}
	return M.map((r, i) => r[n] / r[i]);
}

/** H で点を写す。 */
export function applyH(H, [x, y]) {
	const w = H[6] * x + H[7] * y + H[8];
	return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** 折れ線の長さ。 */
export const polylineLength = pts => pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);

/**
 * 基準物の 4 隅（画素）を、幅 w・高さ h（mm）の長方形へ写すホモグラフィ。
 * 隅の順は周りに沿って 1→2→3→4 で、**1→2 が長さ w の辺**（UI は「長い辺の端から」と案内する）。
 * ※ 写真の上の画素の長さから長辺を当てるのは不可。斜め撮りでは奥行き方向の辺が縮んで、長辺が短辺より短く写ることがある（検定で確認）。
 */
export function homographyFromQuad(quad, w, h) {
	return solveHomography(quad, [[0, 0], [w, 0], [w, h], [0, h]]);
}

/**
 * 体長（cm）を出す。
 * @param {{mode:"a4"|"line", ref:number[][], refSize:{w:number,h:number}|{len:number}, body:number[][]}} m
 *   ref：基準物の点（画素）。a4 なら 4 点、line なら 2 点。refSize：a4 なら {w,h}（mm）、line なら {len}（mm）。body：個体の点（画素・2 点以上）。
 * @returns {{cm:number|null, scale:number|null, warn?:string}} cm＝体長、scale＝画素あたり mm（line の時・a4 の時は基準物の中心付近の目安）
 */
export function measure(m) {
	const { mode, ref, refSize, body } = m;
	if (!body || body.length < 2) return { cm: null, scale: null };
	if (mode === "line") {
		if (ref.length < 2 || !(refSize.len > 0)) return { cm: null, scale: null };
		const px = dist(ref[0], ref[1]);
		if (px < 1) return { cm: null, scale: null, warn: "基準の 2 点が重なっている" };
		const scale = refSize.len / px;
		return { cm: polylineLength(body) * scale / 10, scale };
	}
	if (ref.length < 4 || !(refSize.w > 0 && refSize.h > 0)) return { cm: null, scale: null };
	const H = homographyFromQuad(ref, refSize.w, refSize.h);
	if (!H) return { cm: null, scale: null, warn: "基準物の 4 隅が長方形になっていない" };
	const plane = body.map(p => applyH(H, p));
	// 画素あたり mm の目安＝基準物の対角の実長／画素長
	const scale = Math.hypot(refSize.w, refSize.h) / dist(ref[0], ref[2]);
	const out = { cm: polylineLength(plane) / 10, scale };
	// 個体の点が基準物の遥か遠く（基準物の対角の 8 倍超）＝遠近の外挿が大きい＝精度が落ちる旨の注意
	const far = plane.some(p => Math.hypot(p[0] - refSize.w / 2, p[1] - refSize.h / 2) > 8 * Math.hypot(refSize.w, refSize.h));
	if (far) out.warn = "個体が基準物から遠い（基準物を個体の近くに置くと精度が上がる）";
	if (!(out.cm > 0) || !isFinite(out.cm)) return { cm: null, scale: null, warn: "基準物の 4 隅が長方形になっていない" };
	return out;
}

/** 基準物の既製サイズ（mm）。 */
export const REF_PRESETS = [
	{ id: "a4", name: "A4 用紙", w: 297, h: 210 },
	{ id: "a3", name: "A3 用紙", w: 420, h: 297 },
	{ id: "b4", name: "B4 用紙", w: 364, h: 257 },
	{ id: "custom", name: "その他（縦横を入力）", w: 0, h: 0 },
];
