// 全球ハイプソの正準パレット＝world色の単一の出所。GL/WGSL両レンダラの uniform 既定と、
// app 側の湖レイヤ(style-world)の塗りが全員ここから引く（海色が3箇所のリテラルで手動同期していた轍の根治）。
// テーマは view.worldHypso に同名キーで部分上書き（palettes.js の台帳）＝未指定キー＝この既定
// ＝mono(knob無し)は従来出力と一致・topo の「海だけ差し替え」も per-key マージで自動成立。
// 標高ブレークポイント(400/1300/2800/4800m)・脱彩度・snow/arid の式はテーマ対象外＝シェーダ側に残る。
export const WORLD_PAL_DEFAULT = {
	sea:      [0.757, 0.847, 0.891],   // #c1d8e3（GLOBE u_seaC と湖レイヤは常に同色＝面一の水面）
	lowHumid: [0.582, 0.716, 0.531],   // 低地・湿潤＝緑
	lowArid:  [0.839, 0.796, 0.639],   // 低地・乾燥＝砂（cross-blend先）
	midHumid: [0.752, 0.790, 0.578],   // 〜400m・湿潤＝黄緑
	midArid:  [0.855, 0.788, 0.612],   // 〜400m・乾燥
	ramp1:    [0.871, 0.831, 0.659],   // 400–1300m＝砂
	ramp2:    [0.788, 0.718, 0.635],   // 1300–2800m＝茶灰
	peak:     [0.925, 0.925, 0.937],   // 2800–4800m＝高峰
	snow:     [0.945, 0.953, 0.962],   // 氷床・雪
	belowSea: [0.84, 0.92, 0.82],      // wdepr 専用＝0→-60m の乗算ティント（globe との縫い目契約の外）
	grat:     [1, 1, 1, 1],            // レチクル rgb＋α係数（レンダラのz帯フェードに乗算）
};
// ── テーマ別の全球パレット（配色テーマ名 → WORLD_PAL_DEFAULT への部分上書き）──────────────
// 正本はここ 1 本＝ortho-japan（palettes.js MAP_THEMES[].worldHypso）と apps/equal（themes.js）が同じ値を引く。
// 「japan で定義した night/sepia を equal でも表現する」＝色の定義を二度書かないための引き上げ（2026-09-18 本人裁定）。
// 未指定キーは既定のまま＝mono は knob 無し（null）＝従来出力そのもの・topo は「海だけ差し替え」が per-key マージで成立。
export const WORLD_PAL_THEMES = {
	mono: null,   // 既定＝WORLD_PAL_DEFAULT（自然色・NE 風）
	// dark＝夜の地球儀：海は style の海 #090c12 同族の深い青黒・陸は沈めた緑灰→暗砂→明るめの峰（「高いほど明るい」＝夜の反転則）
	dark: {
		sea:      [0.035, 0.047, 0.071],
		lowHumid: [0.13, 0.17, 0.13], lowArid: [0.20, 0.18, 0.13],
		midHumid: [0.17, 0.19, 0.14], midArid: [0.21, 0.19, 0.14],
		ramp1: [0.24, 0.21, 0.16], ramp2: [0.29, 0.25, 0.20],
		peak: [0.44, 0.45, 0.50], snow: [0.55, 0.57, 0.62],
		belowSea: [0.78, 0.88, 0.84],       // 海面下の締め＝暗い地でも読めるよう僅かに強め
		grat: [0.55, 0.62, 0.75, 0.8],      // レチクル＝白は夜に眩しい＝沈めた青灰
	},
	// topo＝地形図配色（紙の地形図の顔）：陸は自然色のまま（キー省略＝既定）・海だけ地形図の水色 #bed2ff 系へ＝per-key マージの実証。
	// 実色の出所は日本の標準地図（std.json）だが、名前は顔で呼ぶ＝core は機関名を名乗らない（2026-09-24 改名・旧 gsi）。
	topo: { sea: [0.745, 0.824, 1.0] },
	// sepia＝古地図の地球儀：緑を捨て暖オリーブ→砂→焦茶→生成りの峰。海は style の海 #d6ddd7 同族
	sepia: {
		sea:      [0.839, 0.867, 0.843],
		lowHumid: [0.78, 0.76, 0.61], lowArid: [0.87, 0.80, 0.62],
		midHumid: [0.82, 0.77, 0.60], midArid: [0.86, 0.78, 0.60],
		ramp1: [0.85, 0.76, 0.57], ramp2: [0.75, 0.65, 0.51],
		peak: [0.92, 0.89, 0.83], snow: [0.95, 0.93, 0.88],
		belowSea: [0.86, 0.90, 0.82],
		grat: [0.55, 0.44, 0.30, 0.9],      // レチクル＝セピア茶（白は暖色紙に消える）
	},
};

export function resolveWorldPal(knob) {   // per-key マージ。knob=view.worldHypso（clim 等の異種キーは素通し無視）
	const p = {};
	for (const k in WORLD_PAL_DEFAULT) p[k] = (knob && knob[k]) || WORLD_PAL_DEFAULT[k];
	return p;
}
