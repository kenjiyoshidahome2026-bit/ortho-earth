// 地図の配色テーマ台帳 ── themes.js（チップ＝データの主題分類）とは別物：こちらは「同じデータの着せ替え」。
// 1テーマ＝style（式言語の色は全部そこ）＋style外の色ノブ（GL uniform・gint・ラベル再着色＝app.js が式言語の外で塗る色）。
// テーマ追加＝style-<name>.js を1枚書き、ここに1エントリ足すだけ。共有URLは c=<name>（mono は既定＝書かない）。
// 埋め込みは opts.theme="<name>"（焼き付け）または opts.theme={…}（この台帳と同じ形の部分上書き＝カスタムテーマ）。
import styleMono from "./style-mono.js";
import styleDark from "./style-dark.js";
import styleGsi from "./style-gsi.js";
import styleSepia from "./style-sepia.js";
import { WORLD_PAL_THEMES } from "@ortho-earth/core/worldpal";   // 全球パレットの正本＝apps/equal と同じ値を引く（二度書かない・2026-09-18）

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
		// 世界パレット（?world=1 全球ハイプソ）＝ortho-core worldpal の正本（equal と共有）。未指定キーは既定（resolveWorldPal の per-key マージ）
		worldHypso: WORLD_PAL_THEMES.dark,
	},
	// topo＝地形図（紙の地形図の顔・旧 gsi＝2026-09-24 改名）。style-gsi が式言語の色を一次資料 std.json の実色へ写す
	// ＝配色の**出所**は地理院（相手の色）だが、テーマの**呼び名**は顔で言う（c=topo・別名 c=gsi は worldstyle の ALIAS が受ける）。
	// hypso/distColor 省略＝標準地図は標高ティント無し・遠山は既定ブルー（明るい紙なので ui-dark 家具も付かない）。
	topo: {
		style: styleGsi,
		bldColor: [1.0, 0.90, 0.75],            // 建物＝地理院の淡橙 rgb(255,230,190)
		contourColor: [0.784, 0.627, 0.235],    // 等高線＝地理院の茶 rgb(200,160,60)
		atmo: [0.5, 0.66, 0.96, 0.3],           // 大気は mono と同じ淡さ（地理院に大気概念は無い＝素直な既定）
		coastLine: [0.12, 0.55, 0.74, 1.0],     // admin0（海岸線+国境線）gint＝地理院シアンのトーンを落とした青 rgb(31,140,189)（原色 rgb(0,176,236) は基図の上で鳴きすぎ・本人裁定 2026-09-09）
		facilityRGB: [0.376, 0.098, 0.525],     // 施設ラベル＝地理院の施設系注記の紫 rgb(96,25,134)
		terrainRGB: [0.459, 0.298, 0.141],      // 地形名ラベル＝mono の茶を踏襲（等高線の茶の同族）
		// 世界パレット＝ortho-core worldpal の正本（equal と共有）：陸は自然色のまま・海だけ地理院の水色
		worldHypso: WORLD_PAL_THEMES.topo,
	},
	// sepia＝暖色・古地図（Quiet Mono Sepia）。style-sepia が式言語の色を対応表で暖色へ写す。明るい紙＝ui-dark 家具なし。
	// 地形を暖色で立てる＝contour/distColor/hypso を全部持たせる（mono/topo は省略、dark は寒色版）＝古地図の主役は地形。
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
		// 世界パレット＝ortho-core worldpal の正本（equal と共有）：古地図の地球儀（暖オリーブ→砂→焦茶）
		worldHypso: WORLD_PAL_THEMES.sepia,
	},
};
