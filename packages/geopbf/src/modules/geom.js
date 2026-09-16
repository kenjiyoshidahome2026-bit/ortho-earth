// 平面幾何の小道具（重複の一本化・2026-09-16）。座標は [x, y] の配列列。
// 点の内外（偶奇則・射線は +x）。n＝使う頂点数（閉環なら ring.length-1、開環なら ring.length）。
export function pointInRing(x, y, ring, n = ring.length) {
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
		if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
