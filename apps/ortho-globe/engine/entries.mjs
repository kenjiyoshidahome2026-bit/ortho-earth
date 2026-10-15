// 共有エンジン（/globe/engine/<版>/）の入口の一覧＝vite.engine.config.js（lib の entry）と scripts/build-engine.mjs（current.json の imports）の正本。
// imports＝アプリの import の名前 → 入口の出力（各アプリの build の sharedEngine が external にして URL で読む）。
// 2 つ以上のアプリが使う物は各アプリに焼かず、ここに入口として足す（本人 2026-10-14「各アプリに焼くのは問題」・LAYERS.md 掟 6）。
// 地域パック（jp・nl）の入口は地域を知らない globe・core のコードに入らない＝別の入口・読まないアプリには 0 バイト。
import { resolve } from "node:path";
const ROOT = resolve(import.meta.dirname, "../../..");
const P = p => resolve(ROOT, p);
// [import の名前, 入口の名（出力＝<名>.js）, ソース]
export const ENTRIES = [
	["@ortho-earth/globe", "globe", resolve(import.meta.dirname, "globe.js")],
	["@ortho-earth/globe/i18n.js", "i18n", P("packages/globe/src/i18n.js")],
	["@ortho-earth/core", "core", P("packages/ortho-core/src/index.js")],
	["geopbf", "geopbf", P("packages/geopbf/src/index.js")],
	["@ortho-earth/h3/core", "h3", P("packages/h3/src/core.js")],
	// 日本の地域パック（packages/jp）＝japan・census2020・choju・ortho-nl・gishub-jp が共に読む（2026-10-14）
	["@ortho-earth/jp/app", "jp/app", resolve(import.meta.dirname, "jp-app.js")],
	["@ortho-earth/jp", "jp/index", P("packages/jp/src/index.js")],
	["@ortho-earth/jp/region", "jp/region", P("packages/jp/src/region.js")],
	["@ortho-earth/jp/codes", "jp/codes", P("packages/jp/src/codes.js")],
	["@ortho-earth/jp/shared-data", "jp/shared-data", P("packages/jp/shared-data/index.js")],
	["@ortho-earth/nl", "nl/index", P("packages/nl/src/region.js")],
];
// 入口の隣に複写する実行時データ（orthoJapan の assetBase の既定＝<版>/assets/）。
// koppen-clim.png＝assetBase を指した頁は気候場もそこから読む（globe.js の CLIM_URL）＝jp の頁が読む 1 枚（読まない頁は従来のハッシュ名の同梱を読む＝どちらか 1 枚だけ）
export const DATA = [["packages/jp/assets", "assets"], ["packages/globe/src/assets/koppen-clim.png", "assets/koppen-clim.png"]].map(([from, to]) => [P(from), to]);
export const libEntry = () => Object.fromEntries(ENTRIES.map(([, name, src]) => [name, src]));
export const importsMap = () => Object.fromEntries(ENTRIES.map(([spec, name]) => [spec, `${name}.js`]));
