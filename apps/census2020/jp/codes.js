// 都道府県・市区町村コードの知識は apps/gishub-jp/jp/codes.js が正本（1か所・複製禁止の掟）。
// census2020 は同じ相対階層（jp/codes.js）に置いた此の1行で正本へ委譲＝移植ファイル群の
// `../jp/codes.js` import が無改変で通る。dev/build とも vite の fs.allow(../..) で解決する。
export * from "../../gishub-jp/jp/codes.js";
