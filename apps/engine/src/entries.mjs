// 共有エンジン（/globe/engine/<版>/）の入口の一覧＝apps/engine の vite.config.js（lib の entry）と scripts/build.mjs（current.json の imports）の正本。
// imports＝アプリの import の名前 → 入口の出力（各アプリの build の sharedEngine が external にして URL で読む）。
// 2 つ以上のアプリが使う物は各アプリに焼かず、ここに入口として足す（本人 2026-10-14「各アプリに焼くのは問題」・LAYERS.md 掟 6）。
// 地域パック（jp・nl）の入口は地域を知らない globe・core のコードに入らない＝別の入口・読まないアプリには 0 バイト。
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const sub = spec => { const n = spec.replace(/^@ortho-earth\//, "").replace(/\.m?js$/, ""); return n.includes("/") ? n : `${n}/index`; };   // ephem → ephem/index（入口が下の階にある物と揃える）
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
	// Equal Earth の部品（packages/equal）＝ortho-globe・ortho-japan（div で重ねる）・equal の頁が共に読む（2026-10-15）。言語の状態は equal 自前（globe の i18n とは別の口）
	["@ortho-earth/equal", "equal", resolve(import.meta.dirname, "equal.js")],
	["@ortho-earth/equal/i18n.js", "equal-i18n", P("packages/equal/src/i18n.js")],
	// 部品の入口（2026-10-15・二重焼きの門番 packages/globe/scripts/lib/engine-modules.mjs が見つけた物）＝アプリがパッケージの
	// サブパスを直に import していて、そのソースがエンジンにも入っている物。アプリの束に焼くと同じコードを 2 か所で配り、
	// 状態を持つ部品（globe の i18n 等）は実体が 2 つに割れる。入口の名＝import の名から @ortho-earth/ と拡張子を外した物。
	...[
		"native-bucket",
		"geopbf/gzip", "geopbf/decodeZIP", "geopbf/pbf", "geopbf/pbf-base", "geopbf/geoparquet", "geopbf/cog/core", "geopbf/edit/sphere", "geopbf/pmtiles",
		"@ortho-earth/core/worldcontent", "@ortho-earth/core/worldpal", "@ortho-earth/core/worldstyle", "@ortho-earth/core/viewurl",
		"@ortho-earth/ephem", "@ortho-earth/ephem/sgp4", "@ortho-earth/ephem/sun",
		"@ortho-earth/globe/i18n/core.js", "@ortho-earth/globe/i18n/langs.js", "@ortho-earth/globe/demo/scene-adapter.js",
		"@ortho-earth/globe/gadgets/cloud.js", "@ortho-earth/globe/gadgets/compose.js", "@ortho-earth/globe/gadgets/dropfile.js",
		"@ortho-earth/globe/gadgets/footprint.js", "@ortho-earth/globe/gadgets/tellus-api.js",
		"world-data/i18n/ui-table.js",
	].map(spec => [spec, sub(spec), fileURLToPath(import.meta.resolve(spec))]),
];
// 入口の隣に複写する実行時データ（orthoJapan の assetBase の既定＝<版>/assets/）。
// koppen-clim.png（packages/jp/assets の symlink＝dev でも同じ置き場から引ける・2026-10-15）＝assetBase を指した頁は気候場もそこから読む（globe.js の CLIM_URL）＝jp の頁が読む 1 枚（読まない頁は従来のハッシュ名の同梱を読む＝どちらか 1 枚だけ）
export const DATA = [["packages/jp/assets", "assets"]].map(([from, to]) => [P(from), to]);
export const libEntry = () => Object.fromEntries(ENTRIES.map(([, name, src]) => [name, src]));
export const importsMap = () => Object.fromEntries(ENTRIES.map(([spec, name]) => [spec, `${name}.js`]));
