// 配色テーマの台帳（equal 版）。ortho-japan の palettes.js と同じ考え方・同じテーマ名・同じ URL トークン（c=<name>）。
//
// 分担：
//   ・全球ハイプソの色＝ortho-core worldpal の WORLD_PAL_THEMES（japan と共有の正本＝色は二度書かない）。
//   ・地図面の色の表そのもの＝ortho-core worldstyle の WORLD_STYLE_THEMES（2026-09-23 段階 3＝world の国の地図・globe の世界線も同じ表を引く）。ここは equal の口（同じ名前で再輸出）。
//   ・地図面のそれ以外（紙・海・外形・境界・水系・市街地・道路・鉄道・点・レチクル・ラベル）＝ここ。
//     japan では同じ役目を MVT の style-<name>.js が担うが、equal は MVT を描かない（NE を gint で直描き）＝
//     層が違うので写しではなく equal 用に持つ。世界の見え方（ハイプソ）だけは共有＝「同じ顔」の芯はそこ。
//   ・UI 家具＝quiet-mono の #map.ui-dark は常時 ON（japan の「白抜き家具＝常時ON」裁定に揃える）。テーマが動かすのは
//     「紙の色を映す家具」だけ＝--eq-paper/--eq-ink（凡例の『データなし』見本・主題なしのスウォッチ）。
//
// テーマを足す＝ここに 1 エントリ。equal 単独でも japan のガジェットとしても同じ台帳を使う
//（ガジェット時はホストがテーマ名を渡す＝equal.theme("dark")）。
import { WORLD_STYLE_THEMES, hex as hexOf, normWorldTheme } from "@ortho-earth/core/worldstyle";

export const hex = hexOf;
export const THEMES = WORLD_STYLE_THEMES;

export const THEME_NAMES = Object.keys(THEMES);
export const normTheme = normWorldTheme;
