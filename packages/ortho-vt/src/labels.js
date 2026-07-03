// ラベル抽出とテキストレイアウト（投影非依存）。
// M1.2 スコープ: 点(point)配置・横書きのみ。size/color/halo は std の式を評価。
// フォントは NotoSansJP-Regular 固定（Serif/縦書き/線ラベル/アイコン/vt_dsppos詳細アンカーは M2）。
import { evalExpr, truthy } from "./expr.js";
import { parseRGBA } from "./color.js";
import { tileLocalToLonLat } from "./tile.js";
import { SDF_BUFFER } from "./glyphs.js";

const GLYPH_EM = 24;                       // グリフの基準em（advance等の単位）
const M1_FONT = "NotoSansJP-Regular";

const num = (v, d) => (typeof v === "number" && !isNaN(v)) ? v : d;

// style の symbol層から点・横書きラベルを抽出。anchor は絶対経緯度[lon,lat]（タイル跨ぎ共通原点）。
export function buildLabels({ layers, z, x, y }, style) {
	const out = [];
	const codepoints = new Set();
	const seen = new Set();   // 同一地物が複数層に出るため (text+anchor) で重複排除
	for (const L of style.layers) {
		if (L.type !== "symbol") continue;
		const lo = L.layout || {};
		if (lo["text-field"] == null) continue;                 // アイコンのみは M2
		if ((lo["symbol-placement"] || "point") !== "point") continue;   // 線ラベルは M2
		// M1.2: 縦書き層も一旦「横書き」で描く（全ラベル可視化）。正しい縦書きは M2。
		const src = layers[L["source-layer"]]; if (!src) continue;

		for (const f of src.features) {
			if (f.type !== "Point") continue;
			const ctx = { zoom: z, props: f.props, geom: f.type, vars: {} };
			if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
			const text = String(evalExpr(lo["text-field"], ctx) ?? "").trim();
			if (!text) continue;
			const p = f.geom[0] && f.geom[0][0]; if (!p) continue;
			const [lon, lat] = tileLocalToLonLat(x, y, z, p.x, p.y, src.extent);
			const dkey = text + "@" + Math.round(p.x) + "," + Math.round(p.y);
			if (seen.has(dkey)) continue; seen.add(dkey);
			const size = num(evalExpr(lo["text-size"] ?? 16, ctx), 16);
			const color = parseRGBA(evalExpr(L.paint?.["text-color"] ?? "#000", ctx));
			const halo = parseRGBA(evalExpr(L.paint?.["text-halo-color"] ?? "rgba(255,255,255,1)", ctx));
			const haloW = num(evalExpr(L.paint?.["text-halo-width"] ?? 0, ctx), 0);
			const sort = num(evalExpr(lo["symbol-sort-key"] ?? 0, ctx), 0);
			for (const ch of text) codepoints.add(ch.codePointAt(0));
			out.push({ anchor: [lon, lat], text, size, font: M1_FONT, color, halo, haloW, sort });
		}
	}
	return { labels: out, codepoints, font: M1_FONT };
}

// テキストをグリフ矩形列にレイアウト（スクリーンpxのアンカー相対、中央アンカー）。
// atlas に該当グリフが梱包済みであること。戻り値: { quads:[{x0,y0,x1,y1,u0,v0,u1,v1}], w, h }
export function layoutText(atlas, font, text, size) {
	const scale = size / GLYPH_EM;
	const em = [];   // em空間の矩形
	let penX = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		const g = atlas.get(font, cp);
		if (!g) { penX += GLYPH_EM; continue; }
		if (g.w > 0) {
			const ex0 = penX + g.left - SDF_BUFFER;
			const ey0 = -g.top - SDF_BUFFER;      // baseline基準・y下向き
			em.push({ ex0, ey0, ex1: ex0 + g.w, ey1: ey0 + g.h, u0: g.u0, v0: g.v0, u1: g.u1, v1: g.v1 });
		}
		penX += g.advance;
	}
	const width = penX;
	const dx = -width / 2;             // 水平中央
	const dy = GLYPH_EM * 0.38;        // 垂直中央のためのbaselineシフト（em, 目視で微調整）
	const quads = em.map(q => ({
		x0: (q.ex0 + dx) * scale, y0: (q.ey0 + dy) * scale,
		x1: (q.ex1 + dx) * scale, y1: (q.ey1 + dy) * scale,
		u0: q.u0, v0: q.v0, u1: q.u1, v1: q.v1,
	}));
	return { quads, w: width * scale, h: GLYPH_EM * scale };
}
