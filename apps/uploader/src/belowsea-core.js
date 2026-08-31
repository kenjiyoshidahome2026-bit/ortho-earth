// 海面下の陸地焼きの純関数部（I/O なし＝node で単体検定できる臓器）。呼び出しと保存は belowsea.js。
// 1タイル（west,south の 90°角・GEBCO R90 ラスタ）を受け、
//   陸マスク（リング列の非ゼロ巻き数スキャンライン）∧ 標高≤THRESH → 侵食内陸帯で偽帯除去 → 連結成分選別
//   → 0.5 等値線（d3-contour）→ 経緯度ポリゴン（直線ラン間引き）
// までを返す。座標規約：d3-contour はサンプル (i,j) の中心を座標 (i+0.5, j+0.5) に置く（単セル実験で確認済
// 2026-09-01）＝ lon = west + x*CELL / lat = latTop − y*CELL が正確（セル中心＝(i+0.5)*CELL と一致）。
import { contours as d3contours } from "d3-contour";

// rings＝[{pts:[[lon,lat]...], bbox:[minX,minY,maxX,maxY]}...]（陸ポリゴンの全リング・非ゼロ巻き数で塗る）
// tile＝{data:Int16Array, width, height}（row0=北・gebco.js create90 の格納順）
// growM＝海面下シードから「陸∧e≤growM」の低平地へ成長させる上限(m)（2026-09-01 本人設計「陸側は広く荒く」）：
//   塗り色は描画側が画素単位でハイプソ本体に計算させる（landK=1 強制）ので、ポリゴンは「ここは海でなく陸」の
//   粗い印でよい。成長が閾値ゆらぎの虫食い・ポルダー間の分断を吸収し、境界が e≳4m（landK≈1）の土地に
//   落ちれば外側の通常ハイプソと同色＝継ぎ目も消える。海側だけは admin0 陸マスクが正確に切る。
export function bakeTile({ west, south, tile, rings, F = 2, threshM = -1, erode = 2, minCells = 8, growM = 3 }) {
	const latTop = south + 90;
	const { data, width: tw, height: th } = tile;
	const W = tw * F, H = th * F, CELL = 90 / W;
	// --- 陸マスク：非ゼロ巻き数のスキャンライン（行中心の緯度で交点を集め、巻き数≠0 の区間を塗る）---
	const land = new Uint8Array(W * H);
	const rows = new Array(H);   // 行ごとの交点 [x, dir, x, dir, ...]
	for (const { pts, bbox } of rings) {
		if (bbox[0] > west + 90 || bbox[2] < west || bbox[1] > latTop || bbox[3] < south) continue;
		for (let k = 0; k + 1 < pts.length; k++) {
			const y1 = pts[k][1], y2 = pts[k + 1][1];
			if (y1 === y2) continue;
			const x1 = pts[k][0], dxdy = (pts[k + 1][0] - x1) / (y2 - y1);
			const yMin = Math.min(y1, y2), yMax = Math.max(y1, y2);   // 行中心 latC∈[yMin,yMax) が交差（半開＝頂点の二重数え無し）
			let r0 = Math.floor((latTop - yMax) / CELL - 0.5) + 1, r1 = Math.floor((latTop - yMin) / CELL - 0.5);
			if (r0 < 0) r0 = 0; if (r1 > H - 1) r1 = H - 1;
			const dir = y2 > y1 ? 1 : -1;
			for (let r = r0; r <= r1; r++) {
				const latC = latTop - (r + 0.5) * CELL;
				(rows[r] ??= []).push(x1 + (latC - y1) * dxdy, dir);
			}
		}
	}
	for (let r = 0; r < H; r++) {
		const cr = rows[r]; if (!cr) continue;
		const n = cr.length / 2, idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => cr[a * 2] - cr[b * 2]);
		let wind = 0;
		for (let s = 0; s < n - 1; s++) {
			wind += cr[idx[s] * 2 + 1];
			if (!wind) continue;
			const xa = cr[idx[s] * 2], xb = cr[idx[s + 1] * 2];
			let i0 = Math.ceil((xa - west) / CELL - 0.5), i1 = Math.floor((xb - west) / CELL - 0.5 - 1e-9);
			if (i0 < 0) i0 = 0; if (i1 > W - 1) i1 = W - 1;
			if (i1 >= i0) land.fill(1, r * W + i0, r * W + i1 + 1);
		}
	}
	// --- 海面下マスク：陸 ∧ GEBCO(バイリニア) ≤ threshM（負値は本物＝深海も通す・>9000 だけ異常値0扱い）。
	//     low＝成長の通り道（陸∧e≤growM の低平地）も同じ走査で作る ---
	const depr = new Uint8Array(W * H);
	const low = new Uint8Array(W * H);
	const S = (x, y) => { const v = data[y * tw + x]; return v > 9000 ? 0 : v; };
	for (let r = 0; r < H; r++) {
		const fy = (r + 0.5) / F - 0.5;   // 行中心の R90 格子座標（texel中心規約：サンプル j の中心＝latTop−(j+0.5)·90/th）
		const y0 = Math.max(0, Math.min(th - 2, fy | 0)), ty = Math.min(1, Math.max(0, fy - y0));
		for (let i = r * W, c = 0; c < W; c++, i++) {
			if (!land[i]) continue;
			const fx = (c + 0.5) / F - 0.5;
			const x0 = Math.max(0, Math.min(tw - 2, fx | 0)), tx = Math.min(1, Math.max(0, fx - x0));
			const top = S(x0, y0) + (S(x0 + 1, y0) - S(x0, y0)) * tx;
			const bot = S(x0, y0 + 1) + (S(x0 + 1, y0 + 1) - S(x0, y0 + 1)) * tx;
			const e = top + (bot - top) * ty;
			if (e <= threshM) depr[i] = 1;
			if (e <= growM) low[i] = 1;
		}
	}
	// --- 内陸帯＝陸マスクを erode 回侵食（タイル縁は「外は陸」扱い＝90°継ぎ目で成分を殺さない）---
	let inner = land;
	for (let e = 0; e < erode; e++) {
		const src = inner, out = new Uint8Array(W * H);
		for (let r = 0; r < H; r++) for (let i = r * W, c = 0; c < W; c++, i++)
			out[i] = src[i] && (r === 0 || src[i - W]) && (r === H - 1 || src[i + W]) && (c === 0 || src[i - 1]) && (c === W - 1 || src[i + 1]) ? 1 : 0;
		inner = out;
	}
	// --- 連結成分（4連結）：小粒と「内陸帯に触れない海岸擦り付き帯」（R90 の海跨ぎ平均の偽陽性）を落とす ---
	const keep = new Uint8Array(W * H);
	const seen = new Uint8Array(W * H);
	const stack = new Int32Array(W * H);
	let compKept = 0;
	for (let start = 0; start < W * H; start++) {
		if (!depr[start] || seen[start]) continue;
		let sp = 0, hasInner = 0;
		stack[sp++] = start; seen[start] = 1;
		const cells = [];
		while (sp) {
			const i = stack[--sp]; cells.push(i);
			if (inner[i]) hasInner = 1;
			const r = (i / W) | 0, c = i - r * W;
			if (r > 0 && depr[i - W] && !seen[i - W]) { seen[i - W] = 1; stack[sp++] = i - W; }
			if (r < H - 1 && depr[i + W] && !seen[i + W]) { seen[i + W] = 1; stack[sp++] = i + W; }
			if (c > 0 && depr[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
			if (c < W - 1 && depr[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
		}
		if (cells.length < minCells || !hasInner) continue;
		for (const i of cells) keep[i] = 1;
		compKept++;
	}
	// --- 成長：シード(keep)から低平地(low)へ BFS ＝虫食い・分断の吸収と「陸側を広く荒く」。
	//     海跨ぎ平均の偽帯（棄却済）も、本物のシードに low で繋がる分は復活する＝陸の中は landK=1 塗りで常に正しい ---
	{
		let sp = 0;
		for (let i = 0; i < W * H; i++) if (keep[i]) stack[sp++] = i;
		while (sp) {
			const i = stack[--sp];
			const r = (i / W) | 0, c = i - r * W;
			if (r > 0 && low[i - W] && !keep[i - W]) { keep[i - W] = 1; stack[sp++] = i - W; }
			if (r < H - 1 && low[i + W] && !keep[i + W]) { keep[i + W] = 1; stack[sp++] = i + W; }
			if (c > 0 && low[i - 1] && !keep[i - 1]) { keep[i - 1] = 1; stack[sp++] = i - 1; }
			if (c < W - 1 && low[i + 1] && !keep[i + 1]) { keep[i + 1] = 1; stack[sp++] = i + 1; }
		}
	}
	// --- 0.5 等値線 → 経緯度ポリゴン（d3-contour＝穴の向きも GeoJSON 準拠。軸沿いの直線ランは間引き）---
	const mp = d3contours().size([W, H]).thresholds([0.5])(keep)[0];
	const features = [];
	let verts = 0;
	for (const poly of mp.coordinates) {
		const rings2 = poly.map(ring => {
			const pts = ring.map(([x, y]) => [+(west + x * CELL).toFixed(4), +(latTop - y * CELL).toFixed(4)]);
			const out = [pts[0]];
			for (let k = 1; k + 1 < pts.length; k++) {
				const a = out[out.length - 1], b = pts[k], c = pts[k + 1];
				if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-9) continue;
				out.push(b);
			}
			out.push(pts[pts.length - 1]);
			return out;
		}).filter(r => r.length >= 4);
		if (!rings2.length) continue;
		verts += rings2.reduce((s, r) => s + r.length, 0);
		features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: rings2 } });
	}
	return { features, compKept, verts };
}
