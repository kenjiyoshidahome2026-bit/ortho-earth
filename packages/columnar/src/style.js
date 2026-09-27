// style.js ── paint / filter（gint と同じ語彙＝gint draw spec §6.1）→ チャンクの fid 表（#90）。
// 表の形は gint と同じ（core の buildFidStyle＝1 texel / feature：R＝fill RGBA8・G＝line/circle RGBA8・B＝幅(1/8px)<<24|dash<<16|半径(1/4px)<<8|flags・bit0＝visible）。
// 違いは評価の入力＝gint は「fid → properties の配列」、こちらは「チャンクごとの列」＝paint が参照する列だけ読んで行ごとの小さな props を組む。
// 色の切り替えで幾何は作り直さない＝表（テクスチャ）だけ差し替える。
import { buildFidStyle } from "@ortho-earth/core/fidstyle";
import { TYPE_NAMES } from "./flat.js";

// 既定の見た目（paint 未設定）＝gint の既定色（面 #FF6B35・線 #00B4D8）に寄せる。塗りは薄く（境界を 2 回描く層なので濃いと重なりが目立つ）
export const DEFAULT_PAINT = {
	"fill-color": "rgba(255,107,53,0.22)",
	"line-color": ["match", ["geometry-type"], ["LineString", "MultiLineString"], "#00B4D8", "#FF6B35"],
	"line-width": 1,
	"circle-color": "#FF6B35",
	"circle-radius": 2,
};

// 式が参照する列名（["get", name]・["has", name]・["get", name, obj] の name が文字列の時）
export function paintColumns(paint, filter, out = new Set()) {
	const walk = e => {
		if (!Array.isArray(e)) return;
		if ((e[0] === "get" || e[0] === "has") && typeof e[1] === "string" && e.length === 2) out.add(e[1]);
		for (let i = 1; i < e.length; i++) walk(e[i]);
	};
	if (paint && typeof paint === "object") for (const v of Object.values(paint)) walk(v);
	walk(filter);
	return out;
}

// cols＝{ 列名: 値[]（チャンク順）}・types＝Uint8Array（チャンク順）→ Uint32Array(n*4)
export function tableFor({ paint, filter = null, zoom = 0, cols = {}, types, n, origin }) {
	const names = Object.keys(cols), feats = new Array(n);
	for (let i = 0; i < n; i++) {
		const p = {};
		for (const nm of names) { const v = cols[nm][i]; if (v !== null && v !== undefined) p[nm] = v; }
		feats[i] = { properties: p, geometry: { type: TYPE_NAMES[types[i]] ?? "" } };
	}
	return buildFidStyle(paint ?? DEFAULT_PAINT, feats, { filter, zoom, origin }).u32;
}
