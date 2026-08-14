// 都道府県・市区町村コードの知識は apps/gishub-jp/jp/codes.js が正本（1か所・複製禁止の掟）。
// census2020 は同じ相対階層（jp/codes.js）に置いた此の1行で正本へ委譲＝移植ファイル群の
// `../jp/codes.js` import が無改変で通る。dev/build とも vite の fs.allow(../..) で解決する。
export * from "../../gishub-jp/jp/codes.js";
import { wardParent } from "../../gishub-jp/jp/codes.js";

// 集約コード c に子(市区町村5桁 k)が属すか。コード階層の知識＝ここ1か所（choropleth のクリップ・bind の estat 展開が共有）。
// 東京都区部 13100＝13101..23（wardParent は政令市専用でこれを写さない）／政令市＝区の親一致／都道府県＝2桁前方一致。
export const belongsTo = (k, c) => c === "13100" ? (+k >= 13101 && +k <= 13123) : c.length === 2 ? k.startsWith(c) : wardParent(k) === c;
