// 世界の地図面の配色＝正本 1 本（2026-09-23 段階 3・本人裁定「equal の palette/labels を globe と一本化」）。
// 引く側：apps/equal（themes.js＝この表そのもの）・apps/world（国の地図パネルの線/塗り/ラベル）・packages/globe（世界帯の河川/海洋境界線・テーマ列の名札）。
// 全球ハイプソの色は worldpal.js（WORLD_PAL_THEMES）＝ここは「それ以外」＝紙・海・外形・境界・水系・市街地・道路・鉄道・点・レチクル・ラベル。
// 値の形：GL 用は "#rrggbb" か ["#rrggbb", α]（hex() で [r,g,b,a] へ）・labelColor と capital は CSS 色（canvas2D）。テーマ名と c= トークンは japan と同じ綴り。
// 【掟】地図面に出る色をアプリの層へリテラルで書かない＝ここへキーを作る（equal の掟を全員の掟に）。
import { WORLD_PAL_THEMES } from "./worldpal.js";

export const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a];
/** "#rrggbb" / ["#rrggbb", α] → CSS 色文字列（canvas2D・gint の paint 式）。α を渡すと上書き */
export const css = (v, alpha) => {
	const h = Array.isArray(v) ? v[0] : v, a = alpha ?? (Array.isArray(v) ? v[1] : 1);
	if (a >= 1) return h;
	return `rgba(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)},${a})`;
};

export const WORLD_STYLE_THEMES = {
	// mono＝白地図（既定）＝従来の equal の顔そのもの。world 省略＝worldpal の自然色（NE 風）。
	mono: {
		label: "Blank map", swatch: "#f7f7f6", dark: false, world: WORLD_PAL_THEMES.mono,
		capital: "#c8443c",   // 首都の点（world の国の地図＝本人 2026-09-23「赤っぽく・少し大きく」）
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
		capital: "#e26a60",   // 首都の点（world の国の地図＝本人 2026-09-23「赤っぽく・少し大きく」）
		sea: "#0a0d12", land: "#171b23", bg: "#05070a", edge: ["#3a4452", 0.8],
		coast: "#5b6878", border: "#7b6f88", admin1: ["#5a5266", 0.5],
		maritime: ["#42556a", 0.9],   // 海洋境界線＝海の上の細い線
		lakeShore: "#3c4a58", river: "#3f6f92", urban: ["#7a4a44", 0.55],
		disputed: ["#7a4f70", 0.30], disputedLine: ["#9a6f90", 0.9],
		road: "#8a6a44", rail: "#5a5c62", port: "#4a86a8", airport: "#a98bd0",
		grat: ["#8ea0bd", 0.34], grat10: ["#8ea0bd", 0.18],
		labelColor: { country: "#cfd6e2", city: "#aebdd6", halo: "rgba(8,11,17,.86)" },
	},
	// topo＝地形図（紙の地形図の顔）。陸は自然色のまま（world は海だけ差し替え）＝紙と線だけ地形図へ寄せる。
	// 実色の出所は日本の標準地図（一次資料 std.json）だが、名前は顔で呼ぶ＝core は機関名を名乗らない（2026-09-24 改名・旧 gsi）。
	topo: {
		label: "Topographic", swatch: "#fdfdf9", dark: false, world: WORLD_PAL_THEMES.topo,
		capital: "#c8443c",   // 首都の点（world の国の地図＝本人 2026-09-23「赤っぽく・少し大きく」）
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
		capital: "#a9563e",   // 首都の点（world の国の地図＝本人 2026-09-23「赤っぽく・少し大きく」）
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

export const WORLD_THEME_NAMES = Object.keys(WORLD_STYLE_THEMES);
// japan と同じ綴りを正とし、口語の別名だけ受ける（?c=night → dark）。未知の名前は null（呼び手が既定へ）。
// gsi＝旧名（2026-09-24 改名前に配った共有 URL・名刺 QR・台本の c=gsi を殺さない＝別名は永久に残す）
const ALIAS = { night: "dark", light: "mono", blank: "mono", white: "mono", default: "mono", gsi: "topo" };
export const normWorldTheme = name => {
	const s = String(name || "").trim().toLowerCase();
	return WORLD_STYLE_THEMES[s] ? s : (WORLD_STYLE_THEMES[ALIAS[s]] ? ALIAS[s] : null);
};
