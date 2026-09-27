// Node で @maplibre/mlt を読むための resolve フック（検定とスクリプト用・ブラウザ／vite には要らない）。
// @maplibre/mlt 1.3.0 の dist は拡張子なしの相対 import（"./mltDecoder"）で、package.json に "type":"module" も exports も無い＝
// バンドラは解決するが素の Node は ERR_MODULE_NOT_FOUND で止まる。そのパッケージの中の相対 import にだけ ".js" を足す。
// 使い方：脚本の先頭で  import { register } from "node:module"; register("@ortho-earth/tile-formats/node-hook", import.meta.url);
//         または  node --import @ortho-earth/tile-formats/node-register script.mjs
export async function resolve(specifier, context, next) {
	if (context.parentURL && context.parentURL.includes("/@maplibre/mlt/dist/") && /^\.\.?\//.test(specifier) && !/\.[cm]?js$/.test(specifier)) return next(specifier + ".js", context);
	return next(specifier, context);
}
