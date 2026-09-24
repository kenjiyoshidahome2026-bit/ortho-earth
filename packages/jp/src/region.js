// 日本の地域宣言＝この国の知識をここに集める（第一段：標高と建物。基図は当面 app.js の記述子のまま）。
//
// 地域宣言は「データの記述子」であってクラスではない。エンジンも altpbf も地域を知らず、
// アプリが起動時にこの宣言を渡す（標高＝2026-09-17・建物＝同日）。
//   dtm       … 裸地標高の申告（packages/jp/src/dtm.js が正本）。null＝焼き直した裸地が無い＝接地リフトしない
//   buildings … 建物台帳の在り処。catalog は assetBase 相対の JSON（336 市区町村）・bakeBase は R2 焼き（PLQ）の置き場（無宣言＝焼き無し＝生経路のみ）・
//               icon は建物データ管理ボタンの顔・group(set) はデータ管理モーダルの並び/見出し。
//               sets を持つ地域はカタログを取らず、その場の配列を台帳へ足す（オランダ側を見よ）
//   basemap   … ベクタ基図のソース記述子（null＝基図を持たない地域＝タイルを要求せず図郭外と同じ扱い）
//   attribution … 出典（表示義務）。行ごとの [{href,key}] ＋ 末尾の加工注記。key は i18n の英語キー
//   view      … その地域を裸で開いた時の初期視点（null＝アプリ既定＝日本）
//   home      … 「その地域の全体へ戻る」{ view:[lon,lat,zoom], label(t() の鍵), icon(SVG), id(ボタンの DOM id) }（null＝戻りボタンを出さない）
//   search    … 地名検索の供給元（packages/jp/src/search-gsi.js の形・null＝検索窓を出さない）
//   poi       … 施設の点の台帳の在り処 { base, overrides, api }（null＝台帳を読まない）
//   rail      … 路線オーバーレイの生成関数 createXxx(env)（packages/jp/src/n02.js の形・null＝作らない）
// 後ろ 4 つは 2026-09-22 に app.js の直書きから宣言へ移した（宣言しない地域では生成もしない）。
import { JP_DTM } from "./dtm.js";
import { gsiSearch, PREF } from "./search-gsi.js";
// 路線オーバーレイ（N02）は初めて load() された時に読む（鉄道チップ ON まで起動のバンドルに載せない・2026-09-22）。
// 形は createN02Overlay(env) と同じ＝{ load(), loaded }（テーマ切替が loaded=false に戻して load() し直す）。
const lazyRail = env => {
	let real = null, wake = null;
	return {
		load() { (wake ??= import("./n02.js").then(m => real = m.createN02Overlay(env))).then(r => r.load()); },
		get loaded() { return real?.loaded ?? false; },
		set loaded(v) { if (real) real.loaded = v; },
	};
};

export { JP_DTM };

import { installJapan } from "./install.js";
export const JP_REGION = {
	code: "jp",
	dtm: JP_DTM,
	buildings: {
		catalog: "plateau-sets.json",       // scripts/plateau-catalog-build.mjs が datacatalog API から生成
		// UI の文言（i18n の英語キー）＝建物データの出所の名（PLATEAU）を出す版。宣言しない地域は globe の汎用の文言（出所の名なし）
		labels: { manage: "Manage 3D buildings (PLATEAU) ($1)", aria: "Preload and delete 3D buildings (PLATEAU)", manager: "3D buildings (PLATEAU) — data manager", city: "3D city (PLATEAU)" },
		// R2 焼き（PLQ・scripts/bake-plateau.mjs が置いた GPU 直行形式）の置き場＝**この国の焼きの在り処**。
		// 宣言しない地域は焼きを引かない（生経路のみ）＝オランダ 3DBAG と同じ扱い（2026-09-23 申告化・旧＝worker に直書き）。
		bakeBase: "https://api.ortho-earth.com/bucket/GIS/plateau/",
		exclude: "plateau-exclude.json",    // 区ごとの除外タイル（decode 側へ配る）
		landmarks: "plateau-landmarks.json",// ランドマークの名札（施設チップ ON の時だけ）
		// データ管理モーダルの並びと見出し＝市区町村コード順（base URL の "39386-bldg-…" がコード＝地理院・e-Stat と同じ並び）・先頭2桁＝都道府県で見出し
		group(set) { const code = +(set.base.match(/\/(\d{5})-/)?.[1] || 99999), pn = Math.floor(code / 1000); return { order: code, key: pn, label: PREF[pn] || "" }; },
		// 建物データ管理ボタン（map.gadget.mesh）のアイコン＝Project PLATEAU（国土交通省）公式ロゴマーク
		//（plateau.mlit.go.jp の logo_min そのまま・色はブランド紫）。宣言しない地域は汎用の建物の形（2026-09-22 アプリから移設）。
		icon: `<svg viewBox="0 0 20 30" width="14" height="21" fill="#463C64" aria-hidden="true">
			<path d="M9.70269 11.7457L7.49993 10.452L0 6.04688V17.4448L20 29.1918V17.7939L16.0001 15.4446L14.8514 14.7698L12 13.0951L9.70269 11.7457Z"/>
			<path d="M9.69941 0L0.293945 5.52444L7.34804 9.66773L9.69941 11.0487V0Z"/>
			<path d="M14.851 14.0728V8.37378L19.7023 5.52444L10.2969 0V11.3979L12.1185 12.4679L14.851 14.0728Z"/>
			<path d="M19.9994 17.0956V6.04688L15.4453 8.72162V14.4207L16.3562 14.9556L19.9994 17.0956Z"/>
		</svg>`,
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
		// 印刷の出典（i18n の英語キー）＝地理院ベクトルタイルの一行のみ。真俯瞰(pitch0)は建物3D・地形サーフェスを描かない（elevScaleEff=0）。
		// 標高(AW3D30)は等高線のベクタ線としてだけ写る＝地理院の等高線と同じ位置づけで出典は基図一行に集約（PLATEAU/AW3D30 の陰影・立体は紙面に出ないので表記不要）
		printAttribution: "Source: adapted from GSI optimized vector tiles (experimental)",
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
	home: {   // 「日本全体へ」＝既定起動＆ home ガジェットの着地点（列島ビュー・真俯瞰・z6.6＝デモ初景と同値）。顔＝手描きの列島ブロック図（画素トレース）の塗り潰し版
		// 北海道=右上／本州=右柱＋南の足＋房の切り欠き＋左へ中国地方の帯／九州=左下／四国=中央下。各島は原図より一回り小さく＝海峡（白い隙間）を確保。細いstroke同色＝角の丸み用
		view: [137, 37, 6.6], label: "Show all of Japan", id: "japan-btn",   // id＝利用者 CSS が当てる公開面（quiet-mono #japan-btn）＝据え置き
		span: [17.4, 15.2],   // 全体の縦横の度幅＝デモの終演で画面に収める（列島の大づかみ [129..146.4]×[30.6..45.8]・沖縄本島は列島の画角を殺すので外＝台本の白地図と同じ構図）
		icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="#3f4757" stroke="#3f4757" stroke-width=".8" stroke-linejoin="round" aria-hidden="true">
			<rect x="17.2" y="1.6" width="5.8" height="5.2" rx="1"/>
			<path d="M17.2 8.8 H23 V22.4 H20.1 V20.5 H18.6 V22.4 H13 V18 H6.8 V14.6 H17.2 Z"/>
			<rect x="1" y="15" width="3.6" height="7.4" rx="1"/>
			<rect x="6.6" y="19.8" width="4.6" height="2.6" rx="0.9"/></svg>`,
	},
	airports: "airports.json",
	install: installJapan,   // 起動後に map へ足す物（e-Stat 小地域＝map.estat）。静的 import＝起動路に動的 import を置かない（仮想時間の関門は起動中の import() を解決できない・t-opts の轍 2026-09-23）。worker は従来どおり初回 loadEstat で遅延   // 低ズーム（z<13）の空港マーク台帳（scripts/airports-build.mjs・86 空港・assetBase 直下）＝タイル注記が無い帯を埋める（2026-09-23 申告化）
	search: gsiSearch,
	poi: {
		api: "https://api.ortho-earth.com",                       // bucket API 基底（poiedit の書込は native-bucket がこの面へ）
		base: "https://api.ortho-earth.com/bucket/GIS/pbf/",      // POIタイル/マニフェストのバケツ基底（自前fetch＝geopbf名前解決を通さない）
		overrides: "poi/overrides.json",                          // 手差分の器（正典名＝uploader schema.OVR_NAME と同値・境界規約で複製）
		// 実装の持参＝ホストは @ortho-earth/jp/poi を知らない（LAYERS.md 段階 2 S3d）。要った時（施設層 ON×z14+）に初めて読む＝起動のバンドルに載せない
		create(env) { return import("./poi.js").then(m => m.createPoiLedger(JP_REGION.poi, env)); },
	},
	rail: lazyRail,
};
