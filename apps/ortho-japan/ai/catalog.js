// AIガジェット「描画スペック」語彙の単一情報源（台帳）。
// schema.js（LLMの出力拘束）も interpret.js（検証・修復）もここから生成する —
// 台帳とスキーマが別管理だとズレた瞬間に堀が決壊するため、正本はこのファイルだけ。
// ready:false は配信経路が未整備のデータセット（語彙には出さず、整備TODOとして台帳に残す）。

// ja＝表示名（普通の漢字表記）。alt＝入力解釈用のゆらぎ語彙（ひらがな等）＝表示には使わない。
export const COLORS = {
	red:    { ja: "赤",       alt: ["あか"],           css: "#d94040" },
	orange: { ja: "オレンジ", alt: ["だいだい", "橙"], css: "#e08030" },
	yellow: { ja: "黄色",     alt: ["きいろ", "黄"],   css: "#c9a227" },
	green:  { ja: "緑",       alt: ["みどり"],         css: "#3f9e4d" },
	cyan:   { ja: "水色",     alt: ["みずいろ"],       css: "#2fa8c5" },
	blue:   { ja: "青",       alt: ["あお"],           css: "#2f6bc5" },
	purple: { ja: "紫",       alt: ["むらさき"],       css: "#8a5fc0" },
	pink:   { ja: "ピンク",   alt: ["桃色", "ももいろ"], css: "#d977a8" },
	brown:  { ja: "茶色",     alt: ["ちゃいろ"],       css: "#8a6a4f" },
	gray:   { ja: "灰色",     alt: ["はいいろ", "グレー"], css: "#777777" },
	black:  { ja: "黒",       alt: ["くろ"],           css: "#333333" },
};

export const WIDTHS = { thin: 0.75, normal: 1.5, thick: 3.0 };
export const WIDTH_JA = { thin: "細く", normal: "普通の太さで", thick: "太く" };

export const FILTER_OPS = ["eq", "ne", "lt", "gt", "contains"];

export const DATASETS = {
	rail: {
		label: "鉄道路線",
		kw: ["鉄道", "てつどう", "電車", "でんしゃ", "線路", "railway"],
		target: "N02-25_RailroadSection",
		route: "overlay", geometry: "line",
		defaults: { color: "cyan", width: "normal" },
		attrs: {
			N02_003: { label: "路線名", type: "string" },
			N02_004: { label: "会社名", type: "string" },
		},
		attribution: "国土数値情報 N02",
		ready: true,
	},
	coastline: {
		label: "世界の海岸線",
		kw: ["海岸", "かいがん", "海"],
		target: "ne_10m_coastline",
		route: "overlay", geometry: "line",
		defaults: { color: "blue", width: "normal" },
		attrs: {},
		attribution: "Natural Earth",
		ready: true,
	},
	park: {
		label: "国立公園",
		kw: ["公園", "こうえん"],
		target: "nps_all",
		// 頂点451万・overlay経路だとmain約2.7秒凍結＋fan103MB（Node実測2026-07）＝大規模データはgint（worker+GPU LOD）へ
		route: "gint", geometry: "polygon",
		defaults: { color: "green", width: "normal" },
		attrs: {},
		attribution: "環境省 環境ジオポータル",
		ready: true,
	},
	smallarea: {
		label: "町丁目の境界（国勢調査）",
		kw: ["町丁目", "小地域", "国勢調査", "さかいめ", "境界"],
		route: "estat", geometry: "polygon",
		needsArea: true,   // 市区町村単位配信のため area（地名）必須
		defaults: { color: "orange", width: "thin" },
		attrs: {},
		attribution: "総務省 e-Stat 国勢調査2020",
		ready: true,
	},
	amedas: {
		label: "アメダス観測所",
		route: "gint", geometry: "point",
		defaults: { color: "red", width: "normal" },
		attrs: {},
		attribution: "気象庁",
		ready: false,   // gishub-jp public の静的配信のみ。bucket 移設後に開放
	},
	seismic: {
		label: "地震の観測施設",
		route: "gint", geometry: "point",
		defaults: { color: "purple", width: "normal" },
		attrs: {},
		attribution: "地震調査研究推進本部",
		ready: false,   // 同上
	},
};

export function readyDatasets() {
	return Object.fromEntries(Object.entries(DATASETS).filter(([, d]) => d.ready));
}
