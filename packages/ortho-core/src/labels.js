// ラベル抽出（投影非依存）。style の symbol層から点・横書きラベルを取り出す。
// 描画は labels2d（Canvas2Dオーバーレイ）が担う。size/color/halo は式を評価。
import { evalExpr, truthy } from "./expr.js";
import { parseRGBA } from "./color.js";
import { tileLocalToLonLat } from "./tile.js";

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
			out.push({ anchor: [lon, lat], text, size, font: M1_FONT, color, halo, haloW, sort, code: num(f.props.vt_code, 0) });
		}
	}
	return { labels: out, codepoints, font: M1_FONT };
}
