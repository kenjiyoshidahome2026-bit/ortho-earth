// geopbf/edit/imagequad ── 画像を四隅で地面に貼る（MapLibre の image source 相当・2026-09-21）の正典。
// 表し方＝**4 頂点の Polygon ＋ @image（画像の Blob）**。環の順＝左上 → 右上 → 右下 → 左下（画像の向き）。
// 面なので geoedit の頂点ドラッグ・移動・回転がそのまま四隅の編集になる。geopbf は @icon と同じく Blob を BUFS プールに 1 回だけ持つ。
// 写像＝画像の単位正方形 (u,v)∈[0,1]² → Web メルカトル平面の射影変換（ホモグラフィ）。平行四辺形なら affine に一致・台形も歪まず貼れる。
// 使う側：geoedit（編集中の見本＝canvas2D）・ortho-japan（ビューア＝画像タイル層へ焼く）。DOM なし・worker 安全・依存ゼロ。

export const IMAGE_KEY = "@image";

const D2R = Math.PI / 180;
export const mercX = lon => (lon + 180) / 360;
export const mercY = lat => { const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
export const unMercY = y => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;

// 地物が「貼った画像」か＝Polygon・外環が 4 頂点（閉じ点は数えない）・@image を持つ
export function isImageFeature(f) {
	const g = f?.geometry, p = f?.properties;
	if (!g || g.type !== "Polygon" || !p || p[IMAGE_KEY] == null) return false;
	return cornersOf(g) !== null;
}
// 外環から四隅 [左上, 右上, 右下, 左下]（[lon,lat]）。環の巻きが逆（反時計回り＝どこかで巻き直された）なら先頭を保ったまま戻す
export function cornersOf(geometry) {
	let r = geometry?.coordinates?.[0];
	if (!r) return null;
	if (r.length === 5 && r[0][0] === r[4][0] && r[0][1] === r[4][1]) r = r.slice(0, 4);
	if (r.length !== 4) return null;
	let a = 0;
	for (let i = 0; i < 4; i++) { const p = r[i], q = r[(i + 1) % 4]; a += dlon(p[0], q[0]) * (p[1] + q[1]); }
	return a < 0 ? [r[0], r[3], r[2], r[1]].map(c => [c[0], c[1]]) : r.map(c => [c[0], c[1]]);   // shoelace（lon 右・lat 上）：時計回り＝a>0
}
const dlon = (a, b) => { const d = b - a; return d - Math.round(d / 360) * 360; };
// 四隅 → 閉じた Polygon（時計回り＝左上から）
export const quadPolygon = c => ({ type: "Polygon", coordinates: [[...c.map(p => [p[0], p[1]]), [c[0][0], c[0][1]]]] });
// 画像を中心 [lon,lat] に横幅 widthM メートルで、縦横比を保って北向きに置いた四隅
export function placeCorners(center, widthM, aspect /* h/w */) {
	const [lon, lat] = center, hw = widthM / 2, hh = widthM * aspect / 2;
	const dLa = hh / 111320, dLo = hw / (111320 * Math.max(0.01, Math.cos(lat * D2R)));
	return [[lon - dLo, lat + dLa], [lon + dLo, lat + dLa], [lon + dLo, lat - dLa], [lon - dLo, lat - dLa]];
}

// 3×3 射影変換：単位正方形 (0,0)(1,0)(1,1)(0,1) → 4 点 p[0..3]（平面座標）。戻り＝行優先 [a,b,c,d,e,f,g,h,1]（x=(a u+b v+c)/(g u+h v+1)）
export function squareToQuad(p) {
	const [x0, y0] = p[0], [x1, y1] = p[1], [x2, y2] = p[2], [x3, y3] = p[3];
	const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
	let g = 0, h = 0;
	if (Math.abs(sx) > 1e-15 || Math.abs(sy) > 1e-15) {
		const den = dx1 * dy2 - dx2 * dy1;
		g = (sx * dy2 - dx2 * sy) / den; h = (dx1 * sy - sx * dy1) / den;
	}
	return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
export function invert3(m) {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
	if (!det) return null;
	const k = 1 / det;
	return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}
export const apply3 = (m, x, y) => { const w = m[6] * x + m[7] * y + m[8]; return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]; };

// 四隅（経緯度）→ 画像 uv ⇄ メルカトル平面の写像一式。経度は左上を基準に最短差で連ねる（日付変更線を跨いでも一続き）
export function quadMapping(corners) {
	const lon0 = corners[0][0];
	const mp = corners.map(c => [mercX(lon0 + dlon(lon0, c[0])), mercY(c[1])]);
	const H = squareToQuad(mp), Hi = invert3(H);
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [x, y] of mp) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
	return {
		H, Hi, merc: mp, mercBox: [x0, y0, x1, y1],
		bbox: [x0 * 360 - 180, unMercY(y1), x1 * 360 - 180, unMercY(y0)],   // [W,S,E,N]（度）
		uvToLonLat: (u, v) => { const [x, y] = apply3(H, u, v); return [x * 360 - 180, unMercY(y)]; },
	};
}

// canvas2D に四隅で貼る（編集中の見本・ビューアの 2D 再生）。project(lon,lat)→[x,y]|null。格子 n×n の三角形ごとに affine で描く＝射影の近似。
// 見えない格子点を含む三角形は描かない。継ぎ目の隙間を消すため三角形の clip を 0.6px 外へ膨らませる。
export function drawImageQuad(ctx, img, corners, project, { grid = 8, alpha = 1 } = {}) {
	const W = img.width, Hh = img.height;
	if (!W || !Hh) return;
	const m = quadMapping(corners);
	const P = [];
	for (let j = 0; j <= grid; j++) for (let i = 0; i <= grid; i++) { const ll = m.uvToLonLat(i / grid, j / grid); P.push(project(ll[0], ll[1])); }
	ctx.save();
	ctx.globalAlpha *= alpha;
	const tri = (a, b, c, ua, va, ub, vb, uc, vc) => {
		if (!a || !b || !c) return;
		const cx = (a[0] + b[0] + c[0]) / 3, cy = (a[1] + b[1] + c[1]) / 3;
		const grow = p => { const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1; return [p[0] + dx / l * 0.6, p[1] + dy / l * 0.6]; };
		const A = grow(a), B = grow(b), C = grow(c);
		// 画像座標 (ua*W, va*H) … を画面の a,b,c へ送る affine
		const x0 = ua * W, y0 = va * Hh, x1 = ub * W, y1 = vb * Hh, x2 = uc * W, y2 = vc * Hh;
		const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
		if (!den) return;
		const ta = ((b[0] - a[0]) * (y2 - y0) - (c[0] - a[0]) * (y1 - y0)) / den;   // 画面の辺 = M·画像の辺 を解く（M = S·D⁻¹）
		const tc = ((c[0] - a[0]) * (x1 - x0) - (b[0] - a[0]) * (x2 - x0)) / den;
		const tb = ((b[1] - a[1]) * (y2 - y0) - (c[1] - a[1]) * (y1 - y0)) / den;
		const td = ((c[1] - a[1]) * (x1 - x0) - (b[1] - a[1]) * (x2 - x0)) / den;
		ctx.save();
		ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.lineTo(C[0], C[1]); ctx.closePath(); ctx.clip();
		ctx.setTransform(ctx.getTransform().multiply(new DOMMatrix([ta, tb, tc, td, a[0] - ta * x0 - tc * y0, a[1] - tb * x0 - td * y0])));
		ctx.drawImage(img, 0, 0);
		ctx.restore();
	};
	for (let j = 0; j < grid; j++) for (let i = 0; i < grid; i++) {
		const k = j * (grid + 1) + i, p00 = P[k], p10 = P[k + 1], p01 = P[k + grid + 1], p11 = P[k + grid + 2];
		const u0 = i / grid, u1 = (i + 1) / grid, v0 = j / grid, v1 = (j + 1) / grid;
		tri(p00, p10, p11, u0, v0, u1, v0, u1, v1);
		tri(p00, p11, p01, u0, v0, u1, v1, u0, v1);
	}
	ctx.restore();
}
