// 日本の地域宣言＝この国の知識をここに集める（第一段：標高と建物。基図は当面 app.js の記述子のまま）。
//
// 地域宣言は「データの記述子」であってクラスではない。エンジンも altpbf も地域を知らず、
// アプリが起動時にこの宣言を渡す（標高＝2026-09-17・建物＝同日）。
//   dtm       … 裸地標高の申告（jp/dtm.js が正本）。null＝焼き直した裸地が無い＝接地リフトしない
//   buildings … 建物台帳の在り処。catalog は assetBase 相対の JSON（336 市区町村）。
//               sets を持つ地域はカタログを取らず、その場の配列を台帳へ足す（オランダ側を見よ）
//   basemap   … ベクタ基図のソース記述子（null＝基図を持たない地域＝タイルを要求せず図郭外と同じ扱い）
//   attribution … 出典（表示義務）。行ごとの [{href,key}] ＋ 末尾の加工注記。key は i18n の英語キー
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
	// 地理院 optimal_bvmap。配信圏の外接矩形＝これと全く重ならないタイルは常に 404 が返る提供圏外＝
	// pipeline が fetch を省いて空タイル（標高ゲート付き全面水域）扱いにする（無駄な 404 を断つ）。
	// 保守的に本土＋離島（南鳥島 154E / 沖ノ鳥島 20.4N / 与那国 123E / 宗谷 45.5N）を余裕で内包。
	// lodFloor は bvmap 固有の装置（z8 から海が全面 WA）＝他人のアーカイブには当てはまらない。
	basemap: {
		kind: "gsi",
		tileUrl: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`,
		coverage: [121, 19, 155, 46],
		tileMinZoom: null,                      // null＝アプリの既定（日本の基図を出す圏）に従う
		lodFloor: { minViewZoom: 9, z: 8 },
		minZ: undefined,
	},
	// 出典（表示義務）。1 行目＝長い正式名称を単独で／2 行目＝残りのデータ源／3 行目＝加工注記＋©。
	// 行割りは iPhone 幅（375px・11px 字）で折り返さないことを基準にした 3 行固定。
	attribution: {
		lines: [
			[{ href: "https://maps.gsi.go.jp/development/ichiran.html#optbv", key: "Optimized Vector Tiles (experimental), Geospatial Information Authority of Japan (GSI)" }],
			[{ href: "https://maps.gsi.go.jp/development/ichiran.html#dem", key: "Elevation Tiles (DEM10B)" },
			 { href: "https://www.mlit.go.jp/plateau/", key: "MLIT PLATEAU" },
			 { href: "https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm", text: "JAXA AW3D30" }],
		],
		note: "(Created by processing these data sources)",
	},
	view: null,
};
