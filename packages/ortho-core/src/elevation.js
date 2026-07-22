// 標高タイル（altpbf 復号済み {data,width,height,...}）の再標本化。取得・復号は altpbf 側。

// タイルを N×N の Float32 にダウンサンプル。行は南→北（row0=南）で格納＝アトラス配置用。海は0クランプ。
export function downsampleFlipped(tile, N) {
	const { data, width: w, height: h } = tile;
	const out = new Float32Array(N * N);
	// y: 0=南 の地理座標 → データ行(北上げ)へ。異常値(int16巨大値/-9999)は0に。
	const H = (x, y) => { const v = data[(h - 1 - y) * w + x]; return (v < -420 || v > 9000) ? 0 : v; };
	// 標本はtexel中心 (i+0.5)/N に置く＝シェーダの uv=(ll-origin)/span 直サンプルと規約が一致。
	// 旧実装の角合わせ i/(N-1) はGLのtexel中心と±0.5texel（R90@1024で最大4.9km）伸縮し、
	// land10m海岸線と陰影がズレて見えた。
	// ALOSタイルの最外周画素は縁の fill/no-data(値は中途半端で絶対値クランプをすり抜ける)。
	// これを読むとセル境界(整数緯度)に非実在のタワーが全経度に並ぶ。読み位置を内側[M, end-M]へ
	// クランプ＝縁2px帯だけ平坦化・内側は無歪み（旧実装の全域線形リマップはセル端で±Mpx＝R90で
	// ±7.4kmの伸縮を全体に配っていた＝ズレのもう一因）。
	const M = 2;
	for (let j = 0; j < N; j++) {
		const gy = Math.min(Math.max((j + 0.5) / N * (h - 1), M), h - 1 - M), y0 = Math.min(gy | 0, h - 2), fy = gy - y0;
		for (let i = 0; i < N; i++) {
			const gx = Math.min(Math.max((i + 0.5) / N * (w - 1), M), w - 1 - M), x0 = Math.min(gx | 0, w - 2), fx = gx - x0;
			const a = H(x0, y0), b = H(x0 + 1, y0), c = H(x0, y0 + 1), d = H(x0 + 1, y0 + 1);
			const v = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
			out[j * N + i] = v < 0 ? 0 : v;              // row0=南
		}
	}
	return out;
}
