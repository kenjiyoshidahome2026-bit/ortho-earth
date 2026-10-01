// 標高タイル（altpbf 復号済み {data,width,height,...}）の再標本化。取得・復号は altpbf 側。

// タイルを N×N の Float32 にダウンサンプル。行は南→北（row0=南）で格納＝アトラス配置用。海は0クランプ。
// M＝読まない最外周の画素数（既定 2＝ALOS の縁の fill 対策）。fill を持たないタイル（GEBCO の R10/R90・DEM10B 焼きの R01）は 0 を渡す＝
// 2026-10-02：一律 M=2 だと 10° の境で両側 2 画素（R10 で約 1km）がクランプされ、継ぎ目の帯になっていた（東北 140°E・本人発見）。呼び手（terrain.js edgeOf）が決める
export function downsampleFlipped(tile, N, M = 2) {
	const { data, width: w, height: h } = tile;
	const out = new Float32Array(N * N);
	// y: 0=南 の地理座標 → データ行(北上げ)へ。異常値(int16巨大値/-9999)は0に（旧 H() 閉包＝下の内側ループへ展開済み）。
	// 標本はtexel中心 (i+0.5)/N に置く＝シェーダの uv=(ll-origin)/span 直サンプルと規約が一致。
	// 旧実装の角合わせ i/(N-1) はGLのtexel中心と±0.5texel（R90@1024で最大4.9km）伸縮し、
	// land10m海岸線と陰影がズレて見えた。
	// 入力側も画素中心＝タイルの画素 c は lng0+(c+0.5)/w（GEBCO は pixel-registered・AW3D30 は pixel-is-area・自前の DEM10B 焼き直しも (c+0.5)/W）。
	// 旧＝(w-1) 等分（両端の画素をタイルの縁に貼る）は半画素の伸縮＝西端で +0.5・東端で −0.5 画素ずれ、隣のタイルと合わせると境界で丸 1 画素
	// （R10 で約 460m・R01 で約 30m）の段差＝10° ごとの縦横の継ぎ目（2026-10-02 本人が東北 140°E で発見）。→ gx=(u·w−0.5)（u＝タイル内の位置 0..1）。
	// ALOSタイルの最外周画素は縁の fill/no-data(値は中途半端で絶対値クランプをすり抜ける)。
	// これを読むとセル境界(整数緯度)に非実在のタワーが全経度に並ぶ。読み位置を内側[M, end-M]へ
	// クランプ＝縁2px帯だけ平坦化・内側は無歪み（旧実装の全域線形リマップはセル端で±Mpx＝R90で
	// ±7.4kmの伸縮を全体に配っていた＝ズレのもう一因）。
	// 速さ（perf plan P1 step 0・2026-09-27）：列ごとの x0/fx は行に依らない＝先に 1 回だけ計算し、内側は配列の直読みだけにする。
	// 閉包 H() と毎 texel の clamp を消した＝算術は旧式と同じ式・同じ順（規約の写しと bit 一致＝tests/elevation-resample.mjs）。1024² で 3〜4 倍速。
	const x0s = new Int32Array(N), fxs = new Float64Array(N);
	for (let i = 0; i < N; i++) {
		const gx = Math.min(Math.max((i + 0.5) / N * w - 0.5, M), w - 1 - M), x0 = Math.min(gx | 0, w - 2);
		x0s[i] = x0; fxs[i] = gx - x0;
	}
	for (let j = 0; j < N; j++) {
		const gy = Math.min(Math.max((j + 0.5) / N * h - 0.5, M), h - 1 - M), y0 = Math.min(gy | 0, h - 2), fy = gy - y0;
		const r0 = (h - 1 - y0) * w, r1 = r0 - w, o = j * N;   // データ行（北上げ）：y0 の行と y0+1（1 行北＝添字は 1 行前）
		for (let i = 0; i < N; i++) {
			const x0 = x0s[i], fx = fxs[i];
			let a = data[r0 + x0], b = data[r0 + x0 + 1], c = data[r1 + x0], d = data[r1 + x0 + 1];
			if (a < -420 || a > 9000) a = 0; if (b < -420 || b > 9000) b = 0; if (c < -420 || c > 9000) c = 0; if (d < -420 || d > 9000) d = 0;   // 異常値（int16 巨大値/-9999）は 0
			const t = a + (b - a) * fx;
			const v = t + ((c + (d - c) * fx) - t) * fy;
			out[o + i] = v < 0 ? 0 : v;              // row0=南
		}
	}
	return out;
}

// R10 親タイルから 1°セル（lng0,lat0・幅 span deg）を切り出して N² に再標本化（downsampleFlipped と同じ南上げ・texel 中心 (i+0.5)/N 規約）。
// 混成アトラスの遠方セル用＝R01 の大量フェッチ（1 セル数秒×数十）を避けつつ遠景の起伏を出す。tile＝{data,width,height,lng,lat,range}（altpbf 復号済み）。
// 2026-09-27 に terrain.js から移設（純関数＝門 tests/elevation-resample.mjs で規約の写しと bit 一致を見る）。速さの手は downsampleFlipped と同じ＝列の x0/fx を先に・内側は配列の直読み。
export function cropResample(tile, lng0, lat0, span, N) {
	const { data, width: w, height: h, lng: lo, lat: la, range: r } = tile;
	const out = new Float32Array(N * N);
	const x0s = new Int32Array(N), fxs = new Float64Array(N);
	for (let i = 0; i < N; i++) {
		const gx = ((lng0 - lo) + span * (i + 0.5) / N) / r * w - 0.5;   // 入力は画素中心（downsampleFlipped と同じ規約・縁は隣タイルが無いので最外画素でクランプ）
		const x0 = Math.max(0, Math.min(w - 2, gx | 0));
		x0s[i] = x0; fxs[i] = Math.min(1, Math.max(0, gx - x0));
	}
	for (let j = 0; j < N; j++) {
		const gy = ((lat0 - la) + span * (j + 0.5) / N) / r * h - 0.5;
		const y0 = Math.max(0, Math.min(h - 2, gy | 0)), fy = Math.min(1, Math.max(0, gy - y0));
		const r0 = (h - 1 - y0) * w, r1 = r0 - w, o = j * N;   // y:0=南
		for (let i = 0; i < N; i++) {
			const x0 = x0s[i], fx = fxs[i];
			let a = data[r0 + x0], b = data[r0 + x0 + 1], c = data[r1 + x0], d = data[r1 + x0 + 1];
			if (a < -420 || a > 9000) a = 0; if (b < -420 || b > 9000) b = 0; if (c < -420 || c > 9000) c = 0; if (d < -420 || d > 9000) d = 0;
			const t = a + (b - a) * fx;
			const v = t + ((c + (d - c) * fx) - t) * fy;
			out[o + i] = v < 0 ? 0 : v;   // row0=南
		}
	}
	return out;
}
