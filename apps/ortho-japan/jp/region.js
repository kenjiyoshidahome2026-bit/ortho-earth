// 日本の地域宣言＝この国の知識をここに集める（第一段：標高と建物。基図は当面 app.js の記述子のまま）。
//
// 地域宣言は「データの記述子」であってクラスではない。エンジンも altpbf も地域を知らず、
// アプリが起動時にこの宣言を渡す（標高＝2026-09-17・建物＝同日）。
//   dtm       … 裸地標高の申告（jp/dtm.js が正本）。null＝焼き直した裸地が無い＝接地リフトしない
//   buildings … 建物台帳の在り処。catalog は assetBase 相対の JSON（336 市区町村）。
//               sets を持つ地域はカタログを取らず、その場の配列を台帳へ足す（オランダ側を見よ）
//   view      … その地域を裸で開いた時の初期視点（null＝アプリ既定＝日本）
import { JP_DTM } from "./dtm.js";

export { JP_DTM };

export const JP_REGION = {
	code: "jp",
	dtm: JP_DTM,
	buildings: {
		catalog: "plateau-sets.json",       // scripts/plateau-catalog-build.mjs が datacatalog API から生成
		exclude: "plateau-exclude.json",    // 区ごとの除外タイル（decode 側へ配る）
		landmarks: "plateau-landmarks.json",// ランドマークの名札（施設チップ ON の時だけ）
	},
	view: null,
};
