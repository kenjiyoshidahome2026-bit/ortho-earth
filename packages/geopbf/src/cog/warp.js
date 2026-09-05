// 再標本化＝「デコード直後に worker 内で1回だけ」の CPU warp（本計画 §4）。
// 目標グリッドの各ピクセルを 目標座標 → 経緯度 → 源 CRS → 源ピクセル と逆引きし bilinear。
// タイル跨ぎの 4 近傍は都度タイルを引く（Map 参照＝安価）。fragment シェーダから三角関数を
// 追放する代わりにここで払う（256² で ~1ms 級・pool worker 上）。範囲外/欠タイル/nodata は透明。

const D2R = Math.PI / 180, R2D = 180 / Math.PI, RM = 6378137;

// 源 CRS ピクセル系（overview 段に合わせて縮尺補正した geo）を作る
export function geoAtLevel(geo, full, lv) {
	return {
		originX: geo.originX, originY: geo.originY,
		scaleX: geo.scaleX * full.width / lv.width,
		scaleY: geo.scaleY * full.height / lv.height,
	};
}

// 目標: XYZ(3857) タイル。mapPx(i,j) → [lon,lat]
export function xyzTarget(z, x, y, size = 256) {
	const n = 1 << z;
	return {
		w: size, h: size,
		mapLL: (i, j) => {
			const wx = (x + (i + 0.5) / size) / n, wy = (y + (j + 0.5) / size) / n;
			return [wx * 360 - 180, R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * wy))) - Math.PI / 2)];
		},
	};
}

// 目標: 経緯度等間隔グリッド（エンジンの等経緯度アトラスセル用）。bboxLL=[w,s,e,n]
export function lonlatTarget(bboxLL, w, h) {
	const [W, S, E, N] = bboxLL;
	return {
		w, h,
		mapLL: (i, j) => [W + (E - W) * (i + 0.5) / w, N - (N - S) * (j + 0.5) / h],
	};
}

// 本体。lv={width,height,tileW,tileH,tilesX,tilesY}・geoL=geoAtLevel 済・
// getTileRGBA(tx,ty)→Uint8ClampedArray(tileW*tileH*4)|null（同期＝呼び出し側がデコード済みを Map で持つ）・
// forward=[lon,lat]→[X,Y]（proj.js projFor(epsg).forward）
export function warpRGBA({ lv, geoL, getTileRGBA, forward }, tgt, { nearest = false } = {}) {
	const { w, h, mapLL } = tgt;
	const out = new Uint8ClampedArray(w * h * 4);
	const { tileW, tileH, tilesX, tilesY } = lv;
	const px4 = (px, py) => {   // 源ピクセル（整数）→ RGBA 4値（欠タイル/範囲外は null）
		if (px < 0 || py < 0 || px >= lv.width || py >= lv.height) return null;
		const tx = (px / tileW) | 0, ty = (py / tileH) | 0;
		if (tx >= tilesX || ty >= tilesY) return null;
		const t = getTileRGBA(tx, ty);
		if (!t) return null;
		const o = ((py - ty * tileH) * tileW + (px - tx * tileW)) * 4;
		return [t[o], t[o + 1], t[o + 2], t[o + 3]];
	};
	for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
		const [lon, lat] = mapLL(i, j);
		const [X, Y] = forward([lon, lat]);
		const fx = (X - geoL.originX) / geoL.scaleX - 0.5;   // ピクセル中心基準
		const fy = (geoL.originY - Y) / geoL.scaleY - 0.5;
		const o = (j * w + i) * 4;
		if (nearest) {
			const p = px4(Math.round(fx), Math.round(fy));
			if (p) { out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2]; out[o + 3] = p[3]; }
			continue;
		}
		const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
		const p00 = px4(x0, y0), p10 = px4(x0 + 1, y0), p01 = px4(x0, y0 + 1), p11 = px4(x0 + 1, y0 + 1);
		if (!p00 && !p10 && !p01 && !p11) continue;
		// 欠けは最近傍で補う（境界1pxの品質より穴なしを優先）
		const q = p00 || p10 || p01 || p11;
		const a = p00 || q, b = p10 || q, c = p01 || q, d = p11 || q;
		for (let k = 0; k < 4; k++) {
			out[o + k] = (a[k] * (1 - ax) + b[k] * ax) * (1 - ay) + (c[k] * (1 - ax) + d[k] * ax) * ay;
		}
	}
	return out;
}

// 3857 の forward（xyzTarget の逆算に使う場面向け・proj.js と同式の複製を避けるための再輸出はしない）
export const mercForward = ([lon, lat]) => [lon * D2R * RM, Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)) * RM];
