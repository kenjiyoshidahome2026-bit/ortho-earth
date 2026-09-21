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
//   home      … 「その地域の全体へ戻る」の着地点 { view:[lon,lat,zoom] }（null＝戻りボタンを出さない）
//   search    … 地名検索の供給元（jp/search-gsi.js の形・null＝検索窓を出さない）
//   poi       … 施設の点の台帳の在り処 { base, overrides, api }（null＝台帳を読まない）
//   rail      … 路線オーバーレイの生成関数 createXxx(env)（jp/n02.js の形・null＝作らない）
// 後ろ 4 つは 2026-09-22 に app.js の直書きから宣言へ移した（宣言しない地域では生成もしない）。
import { JP_DTM } from "./dtm.js";
import { gsiSearch } from "./search-gsi.js";
import { createN02Overlay } from "./n02.js";

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
	// 画像タイル（メルカトル XYZ ラスタ）のカタログ＝この国が持つ公共のサーバーレス源（本人裁定 2026-09-21：地理院を持つ・
	// Google 直/Bing 代理/8192 下地画像は捨てる）。エンジンはカタログを知らない（外から定義できる口の一つ＝地域パック）。
	//   id … ?r= と map.raster.select() の鍵／key … i18n の英語キー／url … {z}/{x}/{y} テンプレ／order … "under"＝基図（塗りを伏せる・
	//   線と注記は残す）・"over"＝重ね（塗りの後・線の前・opacity 可）／minZoom-maxZoom … 配信域（表示は 1.5 段下から）／bbox … 配信圏。
	// 出典は各タイルの一次資料ページへ（地理院タイル一覧・ハザードマップポータル）。
	rasters: [
		{ id: "gsi-std", key: "GSI Standard Map", url: "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", minZoom: 5, maxZoom: 18, bbox: [122, 20, 154, 46], order: "under",
			attribution: { href: "https://maps.gsi.go.jp/development/ichiran.html#std", key: "GSI Tiles (Standard Map)" } },
		{ id: "gsi-pale", key: "GSI Pale Map", url: "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", minZoom: 5, maxZoom: 18, bbox: [122, 20, 154, 46], order: "under",
			attribution: { href: "https://maps.gsi.go.jp/development/ichiran.html#pale", key: "GSI Tiles (Pale Map)" } },
		{ id: "gsi-photo", key: "GSI Aerial Photo", url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", minZoom: 2, maxZoom: 18, bbox: [122, 20, 154, 46], order: "under",
			attribution: { href: "https://maps.gsi.go.jp/development/ichiran.html#seamlessphoto", key: "GSI Tiles (Seamless Photo)" } },
		{ id: "gsi-relief", key: "GSI Relief Map", url: "https://cyberjapandata.gsi.go.jp/xyz/relief/{z}/{x}/{y}.png", minZoom: 5, maxZoom: 15, bbox: [122, 20, 154, 46], order: "under",
			attribution: { href: "https://maps.gsi.go.jp/development/ichiran.html#relief", key: "GSI Tiles (Relief Map)" } },
		{ id: "gsi-hillshade", key: "GSI Hillshade", url: "https://cyberjapandata.gsi.go.jp/xyz/hillshademap/{z}/{x}/{y}.png", minZoom: 2, maxZoom: 16, bbox: [122, 20, 154, 46], order: "over", opacity: 0.45,
			attribution: { href: "https://maps.gsi.go.jp/development/ichiran.html#hillshademap", key: "GSI Tiles (Hillshade Map)" } },
		{ id: "flood-max", key: "Flood inundation (maximum assumed)", url: "https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png", minZoom: 2, maxZoom: 17, bbox: [122, 20, 154, 46], order: "over", opacity: 0.7,
			attribution: { href: "https://disaportal.gsi.go.jp/hazardmap/copyright/opendata.html", key: "Hazard Map Portal Site (MLIT)" } },
	],
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
	home: { view: [137, 37, 6.6] },   // 列島ビュー（真俯瞰）＝既定起動＆「日本全体」ガジェットの着地点（z6.6＝デモ初景と同値）
	search: gsiSearch,
	poi: {
		api: "https://api.ortho-earth.com",                       // bucket API 基底（poiedit の書込は native-bucket がこの面へ）
		base: "https://api.ortho-earth.com/bucket/GIS/pbf/",      // POIタイル/マニフェストのバケツ基底（自前fetch＝geopbf名前解決を通さない）
		overrides: "poi/overrides.json",                          // 手差分の器（正典名＝uploader schema.OVR_NAME と同値・境界規約で複製）
	},
	rail: createN02Overlay,
};
