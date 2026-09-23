// 「地理院配色（標準地図）」── style-mono.js を地理院地図（標準地図）に full で寄せた版。
// 二段構え：
//  1) 非道路レイヤ（水・建物・鉄道・境界・注記…）は色対応表 MAP で mono を機械変換＝mono の改修に自動追従・drift しない。
//  2) 道路だけは地理院の作り（灰の縁取り casing ＋ 格ごとの色帯 fill・都道府県道=黄まで）が mono と構造から違うので、
//     道路レイヤ一式を専用サブシステムに差し替える。土台(灰)＝casing／点火(色)＝fill に写す＝mono の「土台＋点火」に一致。
//
// 拡張点はただ一つ、道路の格→色の表 ROAD。塗り・縁・太さを格ごとに持つ＝他の格・他の色を足すのは1行。
// fire の layer id（road-hi / road-hi-face / road-hi-tn）は保つ＝themes.js の road チップ配線（liOf）を壊さない：
//   road チップOFF＝灰の土台(casing)だけ＝静かな灰道路／ON＝色帯(fill)が乗る＝地理院フル配色。
//
// 色は推測せず一次資料：地理院地図Vector 公式 data/std.json（gsi-cyberjapan/gsimaps-vector-experiment）の実色。
import mono from "./style-mono.js";

// --- 1) 非道路の色対応表（mono の実色 → 地理院の実色）。道路の格色(下段)は差し替え後は未使用だが、
//        swap の番犬（対応表に無い色を warn）を黙らせるため mono の全色を網羅しておく。
const MAP = {
	"#f6f6f4": "#fefeff",   // 紙（bg・注記ハロー）→ 地理院の陸（ほぼ白 rgb254,254,255）
	"#e2e6ea": "#bed2ff",   // 海（z8+ 一律水色）→ 地理院 水域 rgb(190,210,255)
	"#aecbe6": "#00b0ec",   // 水系点火（WA面・河川中心線）→ 地理院 河川/水涯線のシアン rgb(0,176,236)
	"#ececea": "#ffe6be",   // 建築物 → 地理院 建物 rgb(255,230,190)（淡橙）
	"#c9c9c7": "#c8c8c8",   // 鉄道 土台 → 中間灰（点火の紺 JR がこの上に乗る）
	"#bdbdba": "#b4b4b4",   // （道路 高速 土台）→ 道路サブシステムで差し替え＝未使用
	"#c6c6c3": "#b4b4b4",   // （道路 国道 土台＋道路縁）→ 同上・未使用
	"#d2d2cf": "#bcbcbc",   // （道路 都道府県道 土台）→ 同上・未使用
	"#e0e0dd": "#c4c4c4",   // （道路 市区町村道 土台）→ 同上・未使用
	"#dcdcda": "#c4c4c4",   // （道路 その他 土台）→ 同上・未使用
	"#cececb": "#c9c9c9",   // 行政界 土台 → 淡灰（点火の紫がこの上に乗る）
	"#aa7878": "#440080",   // 行政界 点火 → 地理院 都府県界の紫 rgb(68,0,128)
	"#4b9e6a": "#2b3489",   // 鉄道点火 JR → 地理院 JR 紺 rgb(43,52,137)
	"#8eb43e": "#7c91c4",   // 鉄道点火 私鉄等 → 地理院 私鉄 青灰 rgb(124,145,196)
	"#2f6cad": "#3d9738",   // （道路点火 高速）→ 道路サブシステムで差し替え＝未使用
	"#8fb2d6": "#e69212",   // （道路点火 国道）→ 同上・未使用
	"#7aa8cf": "#e72741",   // 航路 → 地理院 航路 赤 rgb(231,39,65)
	"#86867f": "#333333",   // 注記の文字 → 地理院の黒に近い灰（ハローは陸色 #fefeff が受ける）
};

// 再帰置換：式言語（match/interpolate…の配列）の中の hex 文字列だけ差し替える（style-dark と同じ swap）。
function swap(v) {
	if (typeof v === "string") {
		if (MAP[v]) return MAP[v];
		if (/^#[0-9a-f]{3,8}$/i.test(v)) console.warn(`[style-gsi] color not in mapping table ${v} = kept as mono`);
		return v;
	}
	if (Array.isArray(v)) return v.map(swap);
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
	return v;
}

// --- 2) 道路サブシステム。地理院の道路＝灰の縁取り(casing)＋格ごとの色帯(fill)。
// ROAD＝道路の格(vt_rdctg)→ [塗り fill, 縁/OFF時の灰 casing, 太さ係数 mult]。★ここが唯一の拡張点：
// 格の追加・色替えは1行。塗りは地理院 std.json の実色（高速=緑・国道=橙・都道府県道=黄・市区町村道=白）。
// casing は地理院と同じ灰（road チップOFF時はこの灰だけが見える＝静かな灰道路＝mono/dark と同じ既定の作法）。
const ROAD = {
	//   格                     塗り fill    縁/灰 casing   太さ係数 mult
	"高速自動車国道等": ["#3d9738", "#9a9a9a", 1.00],   // 緑 rgb(61,151,56)
	"国道": ["#e69212", "#a6a6a6", 0.82],   // 橙 rgb(230,146,18)
	"都道府県道": ["#ffe200", "#b4b4b4", 0.60],   // 黄（地理院 rgb255,255,0＝白地で沈むので気持ち濃く／casingで縁取る）
	"市区町村道等": ["#ffffff", "#c4c4c4", 0.36],   // 白＋灰縁＝地理院の一般道
};
const ROAD_ETC = ["#f4f4f4", "#cccccc", 0.30];   // その他（既定）

const CLASSES = Object.keys(ROAD);
// 格→値の match 式を生む（col: 0=塗り 1=縁 2=太さ係数）。
const roadMatch = col => {
	const a = ["match", ["get", "vt_rdctg"]];
	for (const c of CLASSES) a.push(c, ROAD[c][col]);
	a.push(ROAD_ETC[col]);
	return a;
};
const ZW = ["interpolate", ["linear"], ["zoom"], 11, 1.6, 14, 4.0, 16, 8.0, 18, 13, 20, 20];   // casing の基準太さ（mult=1.0=高速）
const caseW = ["*", roadMatch(2), ZW];              // 縁（土台）幅＝格の太さ
const fillW = ["*", 0.68, ["*", roadMatch(2), ZW]]; // 塗り幅＝縁の68%＝両脇に灰縁が残る
const SORT = ["coalesce", ["get", "vt_drworder"], 0];
const NT = ["!=", ["get", "vt_code"], 2704];   // 通常（非トンネル）
const T = ["==", ["get", "vt_code"], 2704];    // トンネル（破線）

// 縁(casing)＝常時ON＝road OFF時の静かな灰道路。塗り(fill)＝点火＝road ONで乗る（road-hi* の id を保つ）。
// 塗りは縁の後に描く＝色帯が灰縁の内側に乗る。z<16/z16+ は road-hi / road-hi-face に分けて両 id を実働させる。
const roadLayers = () => [
	{
		id: "road", type: "line", "source-layer": "RdCL", filter: NT,
		layout: { "line-cap": "round", "line-join": "round", "line-sort-key": SORT },
		paint: { "line-color": roadMatch(1), "line-width": caseW },
	},
	{
		id: "road-tn", type: "line", "source-layer": "RdCL", filter: T,
		layout: { "line-sort-key": SORT },
		paint: { "line-color": roadMatch(1), "line-width": caseW, "line-dasharray": [5, 4] },
	},
	{
		id: "road-hi", type: "line", "source-layer": "RdCL", maxzoom: 16, filter: NT,
		layout: { "line-cap": "round", "line-join": "round", "line-sort-key": SORT },
		paint: { "line-color": roadMatch(0), "line-width": fillW },
	},
	{
		id: "road-hi-face", type: "line", "source-layer": "RdCL", minzoom: 16, filter: NT,
		layout: { "line-cap": "round", "line-join": "round", "line-sort-key": SORT },
		paint: { "line-color": roadMatch(0), "line-width": fillW },
	},
	{
		id: "road-hi-tn", type: "line", "source-layer": "RdCL", filter: T,
		layout: { "line-sort-key": SORT },
		paint: { "line-color": roadMatch(0), "line-width": fillW, "line-dasharray": [5, 4] },
	},
];

// mono の道路レイヤ群を撤去し、道路サブシステムを同じ位置（building の直後）へ差し込む。
const ROAD_IDS = new Set(["road-face", "road", "road-tn", "rdedg", "road-hi", "road-hi-face", "road-hi-tn"]);
const swapped = swap(mono);
const layers = [];
let inserted = false;
for (const L of swapped.layers) {
	if (ROAD_IDS.has(L.id)) { if (!inserted) { layers.push(...roadLayers()); inserted = true; } continue; }
	layers.push(L);
}

export default { ...swapped, layers, name: "地理院配色（標準地図）" };
