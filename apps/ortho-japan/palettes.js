// 地図の配色テーマ台帳 ── themes.js（チップ＝データの主題分類）とは別物：こちらは「同じデータの着せ替え」。
// 1テーマ＝style（式言語の色は全部そこ）＋style外の色ノブ（GL uniform・gint・ラベル再着色＝app.js が式言語の外で塗る色）。
// テーマ追加＝style-<name>.js を1枚書き、ここに1エントリ足すだけ。共有URLは c=<name>（mono は既定＝書かない）。
// 埋め込みは opts.theme="<name>"（焼き付け）または opts.theme={…}（この台帳と同じ形の部分上書き＝カスタムテーマ）。
import styleMono from "./style-mono.js";
import styleDark from "./style-dark.js";
import styleGsi from "./style-gsi.js";
import styleSepia from "./style-sepia.js";

export const MAP_THEMES = {
	// mono＝白地図（既定）。contourColor/distColor/hypso 省略＝renderer 既定（セピア・遠山ブルー・単色陰影）。
	// worldHypso（?world=1 の世界パレット）も省略＝worldpal.js の自然色（NE風）＝従来出力そのまま。
	// キーは sea/lowHumid/lowArid/midHumid/midArid/ramp1/ramp2/peak/snow/belowSea/grat（各任意＝per-keyマージ）。
	mono: {
		style: styleMono,
		bldColor: [0.83, 0.83, 0.82],           // 建物（静かなグレー）
		atmo: [0.5, 0.66, 0.96, 0.3],           // 大気色 rgb + 強さ（さりげなく）
		coastLine: [0.74, 0.77, 0.80, 1.0],     // 世界海岸線 gint＝薄い青灰 #bcc4cc
		facilityRGB: [0.416, 0.239, 0.604],     // 施設ラベル＝--qm-accent-facility #6a3d9a
		terrainRGB: [0.459, 0.298, 0.141],      // 地形名ラベル＝--qm-accent-terrain #754c24
	},
	// dark＝黒地図（Quiet Mono Dark）。夜は「濃い＝主役」が「明るい＝主役」に反転＝ノブも全て明度を持ち上げ直す。
	dark: {
		style: styleDark,
		bldColor: [0.30, 0.32, 0.37],           // 紙より一段明るい灰
		contourColor: [0.72, 0.58, 0.40],       // 既定セピアは夜の紙に沈む＝明るい砂色へ
		atmo: [0.30, 0.42, 0.68, 0.26],         // 大気も一段沈めた深青＝地平線・リムが夜に白く浮かない
		distColor: [0.13, 0.16, 0.23],          // 遠山の霞＝黒に近い青（既定の遠山ブルーは夜には白すぎる）
		hypso: { color: [0.33, 0.29, 0.24], max: 3000, amount: 0.5 },   // 標高ティント：高所ほど暖色の暗灰へ（3000mで寄せ切る・控えめ）
		coastLine: [0.42, 0.47, 0.55, 1.0],     // 夜は一段沈めた青灰 #6b7889
		facilityRGB: [0.71, 0.55, 0.88],        // 濃紫の明度上げ
		terrainRGB: [0.78, 0.63, 0.45],         // 濃茶の明度上げ（等高線の砂色の同族）
		// 世界パレット（?world=1 全球ハイプソ・未指定キー＝worldpal.js の自然色既定）：夜の地球儀＝
		// 海は style の海 #090c12 同族の深い青黒・陸は沈めた緑灰→暗砂→明るめの峰（「高いほど明るい」＝夜の反転則）
		worldHypso: {
			sea:      [0.035, 0.047, 0.071],
			lowHumid: [0.13, 0.17, 0.13], lowArid: [0.20, 0.18, 0.13],
			midHumid: [0.17, 0.19, 0.14], midArid: [0.21, 0.19, 0.14],
			ramp1: [0.24, 0.21, 0.16], ramp2: [0.29, 0.25, 0.20],
			peak: [0.44, 0.45, 0.50], snow: [0.55, 0.57, 0.62],
			belowSea: [0.78, 0.88, 0.84],       // 海面下の締め＝暗い地でも読めるよう僅かに強め
			grat: [0.55, 0.62, 0.75, 0.8],      // レチクル＝白は夜に眩しい＝沈めた青灰
		},
	},
	// gsi＝地理院配色（標準地図）。style-gsi が式言語の色を対応表で地理院色へ写す。ノブも一次資料 std.json の実色。
	// hypso/distColor 省略＝標準地図は標高ティント無し・遠山は既定ブルー（明るい紙なので ui-dark 家具も付かない）。
	gsi: {
		style: styleGsi,
		bldColor: [1.0, 0.90, 0.75],            // 建物＝地理院の淡橙 rgb(255,230,190)
		contourColor: [0.784, 0.627, 0.235],    // 等高線＝地理院の茶 rgb(200,160,60)
		atmo: [0.5, 0.66, 0.96, 0.3],           // 大気は mono と同じ淡さ（地理院に大気概念は無い＝素直な既定）
		coastLine: [0.0, 0.69, 0.925, 1.0],     // 世界海岸線 gint＝地理院の海岸線シアン rgb(0,176,236)
		facilityRGB: [0.376, 0.098, 0.525],     // 施設ラベル＝地理院の施設系注記の紫 rgb(96,25,134)
		terrainRGB: [0.459, 0.298, 0.141],      // 地形名ラベル＝mono の茶を踏襲（等高線の茶の同族）
		// 世界パレット：陸は自然色のまま（キー省略＝既定）・海だけ地理院の水色 #bed2ff 系へ＝per-key マージの実証
		worldHypso: { sea: [0.745, 0.824, 1.0] },
	},
	// sepia＝暖色・古地図（Quiet Mono Sepia）。style-sepia が式言語の色を対応表で暖色へ写す。明るい紙＝ui-dark 家具なし。
	// 地形を暖色で立てる＝contour/distColor/hypso を全部持たせる（mono/gsi は省略、dark は寒色版）＝古地図の主役は地形。
	sepia: {
		style: styleSepia,
		bldColor: [0.90, 0.82, 0.67],           // 建物＝warm tan
		contourColor: [0.55, 0.42, 0.27],       // 等高線＝深いセピア茶（古地図の主役＝はっきり立てる）
		atmo: [0.85, 0.68, 0.48, 0.27],         // 大気＝暖かい琥珀の霞（球のリムが夕陽色に）
		distColor: [0.72, 0.63, 0.50],          // 遠山の霞＝暖色（既定の遠山ブルーは暖色紙には冷たすぎ）
		hypso: { color: [0.64, 0.50, 0.34], max: 2500, amount: 0.35 },   // 標高ティント：高所ほど暖茶（2500mで寄せ・控えめ）
		coastLine: [0.70, 0.63, 0.52, 1.0],     // 世界海岸線 gint＝warm grey（陸の茶に馴染む）
		facilityRGB: [0.48, 0.35, 0.42],        // 施設ラベル＝muted plum（紫を暖色紙へ）
		terrainRGB: [0.45, 0.33, 0.20],         // 地形名ラベル＝warm brown（等高線の茶と同族）
		// 世界パレット：古地図の地球儀＝緑を捨て暖オリーブ→砂→焦茶→生成りの峰。海は style の海 #d6ddd7 同族
		worldHypso: {
			sea:      [0.839, 0.867, 0.843],
			lowHumid: [0.78, 0.76, 0.61], lowArid: [0.87, 0.80, 0.62],
			midHumid: [0.82, 0.77, 0.60], midArid: [0.86, 0.78, 0.60],
			ramp1: [0.85, 0.76, 0.57], ramp2: [0.75, 0.65, 0.51],
			peak: [0.92, 0.89, 0.83], snow: [0.95, 0.93, 0.88],
			belowSea: [0.86, 0.90, 0.82],
			grat: [0.55, 0.44, 0.30, 0.9],      // レチクル＝セピア茶（白は暖色紙に消える）
		},
	},
};
