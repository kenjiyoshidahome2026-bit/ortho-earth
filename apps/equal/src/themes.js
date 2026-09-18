// 配色テーマの台帳（equal 版）。ortho-japan の palettes.js と同じ考え方・同じテーマ名・同じ URL トークン（c=<name>）。
//
// 分担：
//   ・全球ハイプソの色＝ortho-core worldpal の WORLD_PAL_THEMES（japan と共有の正本＝色は二度書かない）。
//   ・地図面のそれ以外（紙・海・外形・境界・水系・市街地・道路・鉄道・点・レチクル・ラベル）＝ここ。
//     japan では同じ役目を MVT の style-<name>.js が担うが、equal は MVT を描かない（NE を gint で直描き）＝
//     層が違うので写しではなく equal 用に持つ。世界の見え方（ハイプソ）だけは共有＝「同じ顔」の芯はそこ。
//   ・UI 家具＝quiet-mono の #map.ui-dark は常時 ON（japan の「白抜き家具＝常時ON」裁定に揃える）。テーマが動かすのは
//     「紙の色を映す家具」だけ＝--eq-paper/--eq-ink（凡例の『データなし』見本・主題なしのスウォッチ）。
//
// テーマを足す＝ここに 1 エントリ。equal 単独でも japan のガジェットとしても同じ台帳を使う
//（ガジェット時はホストがテーマ名を渡す＝equal.theme("dark")）。
import { WORLD_PAL_THEMES } from "ortho-core/worldpal";

export const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];

// labelColor＝地名ラベルの CSS 色（キャンバス 2D 描画）。label＝テーマの表示名（i18n キー）。他は GL 用の [r,g,b,a]。
// swatch＝テーマ選択の見本＝各テーマの紙色（japan の THEME_META と同値）。dark＝紙が暗いテーマか（見本・寄与色の判断用）。
export const THEMES = {
	// mono＝白地図（既定）＝従来の equal の顔そのもの。world 省略＝worldpal の自然色（NE 風）。
	mono: {
		label: "Blank map", swatch: "#f7f7f6", dark: false, world: WORLD_PAL_THEMES.mono,
		sea: "#c1d8e3", land: "#f6f6f4", bg: "#e4e8ec", edge: ["#9aa6b2", 0.8],
		coast: "#9aa6b2", border: "#a99cb2", admin1: ["#a99cb2", 0.45],
		maritime: ["#8fa9bb", 0.85],   // 海洋境界線＝海の上の細い線
		lakeShore: "#9fb4c2", river: "#86aecb", urban: ["#9a5a52", 0.5],
		disputed: ["#9a6e90", 0.28], disputedLine: ["#8a5f80", 0.9],
		road: "#d9a86c", rail: "#7d7f86", port: "#2b6e9e", airport: "#6a3d9a",
		grat: ["#ffffff", 0.45], grat10: ["#ffffff", 0.25],
		labelColor: { country: "#3a3f4a", city: "#2b3b57", halo: "rgba(255,255,255,.88)" },
	},
	// dark＝黒地図（夜）。japan dark と同じ反転則＝「濃い＝主役」が「明るい＝主役」に転ぶ＝線とラベルは明度を上げ直す。
	dark: {
		label: "Dark map", swatch: "#171b23", dark: true, world: WORLD_PAL_THEMES.dark,
		sea: "#0a0d12", land: "#171b23", bg: "#05070a", edge: ["#3a4452", 0.8],
		coast: "#5b6878", border: "#7b6f88", admin1: ["#5a5266", 0.5],
		maritime: ["#42556a", 0.9],   // 海洋境界線＝海の上の細い線
		lakeShore: "#3c4a58", river: "#3f6f92", urban: ["#7a4a44", 0.55],
		disputed: ["#7a4f70", 0.30], disputedLine: ["#9a6f90", 0.9],
		road: "#8a6a44", rail: "#5a5c62", port: "#4a86a8", airport: "#a98bd0",
		grat: ["#8ea0bd", 0.34], grat10: ["#8ea0bd", 0.18],
		labelColor: { country: "#cfd6e2", city: "#aebdd6", halo: "rgba(8,11,17,.86)" },
	},
	// gsi＝地理院配色。陸は自然色のまま（world は海だけ差し替え）＝紙と線だけ地理院の顔へ寄せる。
	gsi: {
		label: "GSI", swatch: "#fdfdf9", dark: false, world: WORLD_PAL_THEMES.gsi,
		sea: "#bed2ff", land: "#fdfdf9", bg: "#eaeade", edge: ["#9aa6b2", 0.8],
		coast: "#1f8cbd", border: "#b58ab0", admin1: ["#b58ab0", 0.45],
		maritime: ["#6f93c8", 0.85],   // 海洋境界線＝海の上の細い線
		lakeShore: "#7fa8d8", river: "#6fa8dc", urban: ["#c88c7c", 0.45],
		disputed: ["#9a6e90", 0.28], disputedLine: ["#8a5f80", 0.9],
		road: "#e0a86c", rail: "#7d7f86", port: "#2b6e9e", airport: "#601986",
		grat: ["#ffffff", 0.5], grat10: ["#ffffff", 0.28],
		labelColor: { country: "#333333", city: "#1f4e79", halo: "rgba(255,255,255,.9)" },
	},
	// sepia＝暖色・古地図。緑を捨てた暖オリーブの地に、茶の線＝地形が主役の顔（japan sepia と同じ狙い）。
	sepia: {
		label: "Sepia", swatch: "#efe6d4", dark: false, world: WORLD_PAL_THEMES.sepia,
		sea: "#d6ddd7", land: "#efe6d4", bg: "#ded3bd", edge: ["#9c8c72", 0.8],
		coast: "#b3a186", border: "#a98a72", admin1: ["#a98a72", 0.45],
		maritime: ["#9aa89c", 0.9],   // 海洋境界線＝海の上の細い線
		lakeShore: "#a8b0a0", river: "#8fa08c", urban: ["#9a6a4a", 0.45],
		disputed: ["#9a7a5a", 0.28], disputedLine: ["#8a6a48", 0.9],
		road: "#c08a4a", rail: "#8a7a62", port: "#5a7a8a", airport: "#7a5568",
		grat: ["#8c6f4a", 0.5], grat10: ["#8c6f4a", 0.28],
		labelColor: { country: "#4a3a24", city: "#5a4630", halo: "rgba(245,238,224,.9)" },
	},
};

export const THEME_NAMES = Object.keys(THEMES);
// japan と同じ綴りを正とし、口語の別名だけ受ける（?c=night → dark）。未知の名前は既定へ。
const ALIAS = { night: "dark", light: "mono", blank: "mono", white: "mono", default: "mono" };
export const normTheme = name => {
	const s = String(name || "").trim().toLowerCase();
	return THEMES[s] ? s : (THEMES[ALIAS[s]] ? ALIAS[s] : null);
};
