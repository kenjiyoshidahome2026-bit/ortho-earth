// 基準点（GCP）からの当てはめ（#177・自前＝本人裁定 2026-09-30「依存を増やさない」）。Allmaps と同じ型の変換：
//   polynomial（1〜3 次・最小二乗）・thinPlateSpline（補間＝基準点を必ず通る・曲げの小さい面）・projective（8 変数の射影・最小二乗）・helmert（相似＝移動・回転・一様な拡大）
// どの型も「source → destination」の 1 方向の関数を当てはめる。逆向きが要る時は向きを入れ替えてもう 1 本当てはめる（TPS に閉じた逆は無い＝Allmaps と同じ）。
// 数値の安定＝両側の座標を当てはめの前に中心と大きさで正規化する（画像の画素とメルカトルの 0..1 は桁が違う）。依存なし。

// 連立一次方程式 A x = b（部分ピボットつきガウス消去）。A は行の配列（書き換える）・b は列（複数列可＝[[b0, b1]...]）
function solve(A, B) {
	const n = A.length, m = B[0].length;
	for (let c = 0; c < n; c++) {
		let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
		if (Math.abs(A[p][c]) < 1e-12) throw new Error("georef: degenerate control points (not enough independent points for this transformation)");
		[A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
		for (let r = c + 1; r < n; r++) {
			const f = A[r][c] / A[c][c]; if (!f) continue;
			for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
			for (let k = 0; k < m; k++) B[r][k] -= f * B[c][k];
		}
	}
	const X = Array.from({ length: n }, () => new Array(m).fill(0));
	for (let r = n - 1; r >= 0; r--) for (let k = 0; k < m; k++) {
		let s = B[r][k]; for (let c = r + 1; c < n; c++) s -= A[r][c] * X[c][k];
		X[r][k] = s / A[r][r];
	}
	return X;
}
// 最小二乗（正規方程式）：各行の基底 f(p) と目標 t → 係数
function leastSquares(rows, targets) {
	const q = rows[0].length, AtA = Array.from({ length: q }, () => new Array(q).fill(0)), AtB = Array.from({ length: q }, () => [0, 0]);
	rows.forEach((f, i) => { for (let a = 0; a < q; a++) { AtB[a][0] += f[a] * targets[i][0]; AtB[a][1] += f[a] * targets[i][1]; for (let b = 0; b < q; b++) AtA[a][b] += f[a] * f[b]; } });
	return solve(AtA, AtB);
}
// 正規化（中心と平均距離）＝[順, 逆]
function normalizer(pts) {
	const n = pts.length; let cx = 0, cy = 0; for (const [x, y] of pts) { cx += x; cy += y; } cx /= n; cy /= n;
	let s = 0; for (const [x, y] of pts) s += Math.hypot(x - cx, y - cy); s = s / n || 1;
	return { f: ([x, y]) => [(x - cx) / s, (y - cy) / s], b: ([x, y]) => [x * s + cx, y * s + cy] };
}
const polyBasis = order => order === 1 ? ([x, y]) => [1, x, y]
	: order === 2 ? ([x, y]) => [1, x, y, x * x, x * y, y * y]
	: ([x, y]) => [1, x, y, x * x, x * y, y * y, x * x * x, x * x * y, x * y * y, y * y * y];
export const minPoints = (type, order = 1) => type === "thinPlateSpline" ? 3 : type === "projective" ? 4 : type === "helmert" ? 2 : order === 1 ? 3 : order === 2 ? 6 : 10;
const tpsU = r2 => r2 > 0 ? r2 * Math.log(r2) / 2 : 0;   // U(r) = r² log r（r² を受ける）

/**
 * 当てはめ：src[i] → dst[i] の関数を返す（fn([x, y]) → [x', y']）。
 * @param {Array<[number, number]>} src
 * @param {Array<[number, number]>} dst
 * @param {{ type?: "polynomial" | "thinPlateSpline" | "projective" | "helmert", order?: 1 | 2 | 3 }} [t]
 */
export function fitTransform(src, dst, t = {}) {
	const type = t.type || "polynomial", order = Math.max(1, Math.min(3, +t.order || +t.options?.order || 1));
	if (src.length !== dst.length) throw new Error("georef: src and dst differ in length");
	if (src.length < minPoints(type, order)) throw new Error(`georef: ${type}${type === "polynomial" ? " order " + order : ""} needs at least ${minPoints(type, order)} control points (got ${src.length})`);
	const ns = normalizer(src), nd = normalizer(dst), S = src.map(ns.f), D = dst.map(nd.f);
	let g;
	if (type === "polynomial") {
		const basis = polyBasis(order), C = leastSquares(S.map(basis), D);
		g = p => { const f = basis(p); let x = 0, y = 0; for (let i = 0; i < f.length; i++) { x += C[i][0] * f[i]; y += C[i][1] * f[i]; } return [x, y]; };
	} else if (type === "helmert") {   // x' = a x − b y + tx・y' = b x + a y + ty
		const rows = [], tg = [];
		S.forEach(([x, y], i) => { rows.push([x, -y, 1, 0]); tg.push([D[i][0], 0]); rows.push([y, x, 0, 1]); tg.push([D[i][1], 0]); });
		const C = leastSquares(rows, tg).map(r => r[0]);
		g = ([x, y]) => [C[0] * x - C[1] * y + C[2], C[1] * x + C[0] * y + C[3]];
	} else if (type === "projective") {   // DLT（h8 = 1）：x' = (h0 x + h1 y + h2)/(h6 x + h7 y + 1)
		const rows = [], tg = [];
		S.forEach(([x, y], i) => { const [u, v] = D[i]; rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); tg.push([u, 0]); rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]); tg.push([v, 0]); });
		const h = leastSquares(rows, tg).map(r => r[0]);
		g = ([x, y]) => { const w = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
	} else if (type === "thinPlateSpline") {   // [K P; Pᵀ 0][w; a] = [D; 0]
		const n = S.length, A = Array.from({ length: n + 3 }, () => new Array(n + 3).fill(0)), B = Array.from({ length: n + 3 }, () => [0, 0]);
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) A[i][j] = tpsU((S[i][0] - S[j][0]) ** 2 + (S[i][1] - S[j][1]) ** 2);
			A[i][n] = A[n][i] = 1; A[i][n + 1] = A[n + 1][i] = S[i][0]; A[i][n + 2] = A[n + 2][i] = S[i][1];
			B[i] = [D[i][0], D[i][1]];
		}
		const W = solve(A, B);
		g = ([x, y]) => {
			let u = W[n][0] + W[n + 1][0] * x + W[n + 2][0] * y, v = W[n][1] + W[n + 1][1] * x + W[n + 2][1] * y;
			for (let i = 0; i < n; i++) { const k = tpsU((x - S[i][0]) ** 2 + (y - S[i][1]) ** 2); u += W[i][0] * k; v += W[i][1] * k; }
			return [u, v];
		};
	} else throw new Error(`georef: unknown transformation type "${type}"`);
	const fn = p => nd.b(g(ns.f(p)));
	fn.type = type; fn.order = type === "polynomial" ? order : null;
	return fn;
}

/** 残差（当てはめた関数で src を写して dst との距離）＝[各点の距離…] */
export const residuals = (fn, src, dst) => src.map((p, i) => { const q = fn(p); return Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]); });

// 経緯度 ⇄ メルカトルの世界座標（0..1・y 下向き＝画像タイルの z/x/y と同じ）
const D2R = Math.PI / 180;
export const lonLatToWorld = ([lon, lat]) => { const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * D2R); return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]; };
export const worldToLonLat = ([x, y]) => [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R];
