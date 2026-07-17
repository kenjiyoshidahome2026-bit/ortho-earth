// 「Quiet Mono Sepia」── style-mono.js の暖色・古地図版。style-dark と同じ純・色対応表方式：
// 構造（レイヤ・幅・フィルタ）は持たず色対応表だけで mono を機械変換＝mono の改修に自動追従・drift しない。
// 対応表に無い色は console.warn で番犬。明るい紙＝ui-dark 家具は付かない（land 輝度で自動判定）。
//
// 色決めの掟（mono と同じ・暖色版）：
//  - 薄さは opacity でなく実色で（重なりムラ防止）＝紙が暖かいクリームに変わるので全色を warm 側へ再計算。
//  - 全体を茶インクの階調でまとめ、水だけを唯一の「冷たい一音」に残す＝暖色の海に沈まず水と読める。
//  - 点火色（鉄道=緑/道路=青/境界=赤）は色相を保ったまま彩度を落とし紙へ馴染ませる＝チップの意味（色＝地図の色）を保つ。
//  - 地形（等高線・遠山の霞・標高ティント）は暖色で立てる＝古地図の主役は地形、という気分（ノブは palettes.js）。
import mono from "./style-mono.js";

const PAPER = "#f0e6d3";   // 暖かいクリームの紙（古地図の生成り。quiet-mono の寒色 tint を暖色へ振った同族）
const MAP = {
	"#f6f6f4": PAPER,       // 紙（bg・road-face の白帯・注記ハロー）
	"#e2e6ea": "#d6ddd7",   // 海（z8+ 一律水色）→ くすんだ青緑＝暖色の陸に対する唯一の冷たい一音
	"#aecbe6": "#b9c8c1",   // 水系点火（WA面・河川中心線）→ 一段深い muted teal＝川・湖が水と分かる濃さ
	"#ececea": "#e6d7bd",   // 建築物 → 紙より一段濃い warm tan（ほぼ気配）
	"#c9c9c7": "#c2b193",   // 鉄道 土台 → warm grey-brown
	"#bdbdba": "#bda683",   // 道路 高速 土台（最も濃い茶＝格が上）
	"#c6c6c3": "#c7b48f",   // 道路 国道 土台 ＋ 道路縁(RdEdg)
	"#d2d2cf": "#d0bd98",   // 道路 都道府県道
	"#e0e0dd": "#dccaa9",   // 道路 市区町村道
	"#dcdcda": "#d7c4a2",   // 道路 その他（既定）
	"#cececb": "#cab896",   // 行政界 土台
	"#aa7878": "#a4685a",   // 行政界 点火 → くすんだテラコッタ（赤系を保つ・古地図の界線）
	"#4b9e6a": "#6f8a5e",   // 鉄道点火 JR → muted sage green（チップの緑を保つ）
	"#8eb43e": "#97934a",   // 鉄道点火 私鉄等 → muted olive
	"#2f6cad": "#5f82a0",   // 道路点火 高速 → くすんだダスティブルー（チップの青を保つ・暖色紙に映える冷たい幹線）
	"#8fb2d6": "#93a8bd",   // 道路点火 国道 → 一段薄い muted blue
	"#7aa8cf": "#8ba2b5",   // 航路
	"#86867f": "#6a5c46",   // 注記の文字 → 深い warm brown のインク（ハローは紙色＝PAPER が受ける）
};

// 再帰置換：式言語（match/interpolate…の配列）の中の hex 文字列だけ差し替える（style-dark と同じ swap）。
function swap(v) {
	if (typeof v === "string") {
		if (MAP[v]) return MAP[v];
		if (/^#[0-9a-f]{3,8}$/i.test(v)) console.warn(`[style-sepia] 対応表に無い色 ${v}＝monoのまま`);
		return v;
	}
	if (Array.isArray(v)) return v.map(swap);
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
	return v;
}

export default { ...swap(mono), name: "Quiet Mono Sepia" };
