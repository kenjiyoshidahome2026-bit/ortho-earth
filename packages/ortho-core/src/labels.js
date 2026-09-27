// ラベル抽出（投影非依存）。style の symbol層から点・横書きラベルを取り出す。
// 描画は labels2d（Canvas2Dオーバーレイ）が担う。size/color/halo は式を評価。
import { evalExpr, truthy, originOfLayer } from "./expr.js";
import { parseRGBA } from "./color.js";
import { tileLocalToLonLat } from "./tile.js";

const M1_FONT = "NotoSansJP-Regular";

const num = (v, d) => (typeof v === "number" && !isNaN(v)) ? v : d;

// 配置の layout（MapLibre の symbol の layout＝段 1・2026-09-28）＝labels2d が箱を作る材料。式は評価してから運ぶ（worker は式を持たない）。
// text-anchor/offset/radial-offset/variable-anchor・max-width（em・折り返し）・letter-spacing（em）・line-height（em）・justify・transform・padding（px・重なり判定だけ）・
// allow-overlap／ignore-placement・text-opacity・halo-blur。既定＝MapLibre（padding 2・max-width 10・line-height 1.2）。ネイティブ層（origin ml でない）は padding 5＝従来の間合い
const ANCHORS = new Set(["center", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"]);
function layoutOf(L, lo, ctx, ml) {
	const ev = (e, d) => { if (e == null) return d; const v = evalExpr(e, ctx); return v == null ? d : v; };
	const anchor = String(ev(lo["text-anchor"], "center")), off = ev(lo["text-offset"], [0, 0]);
	const va = lo["text-variable-anchor"], vaList = Array.isArray(va) && va.length && va.every(x => typeof x === "string" && ANCHORS.has(x)) ? va : (v => Array.isArray(v) ? v.filter(x => ANCHORS.has(x)) : null)(va == null ? null : evalExpr(va, ctx));
	const rec = {
		an: ANCHORS.has(anchor) ? anchor : "center", off: Array.isArray(off) && off.length === 2 ? [num(off[0], 0), num(off[1], 0)] : [0, 0],
		mw: num(ev(lo["text-max-width"], ml ? 10 : 0), ml ? 10 : 0), ls: num(ev(lo["text-letter-spacing"], 0), 0), lh: num(ev(lo["text-line-height"], ml ? 1.2 : 1), ml ? 1.2 : 1),   // ネイティブ層＝折り返し無し・行高 1（従来の箱）
		just: String(ev(lo["text-justify"], "center")), pad: num(ev(lo["text-padding"], ml ? 2 : 5), ml ? 2 : 5), mlp: ml,
		ov: !!ev(lo["text-allow-overlap"], false), ig: !!ev(lo["text-ignore-placement"], false),
		op: num(ev(L.paint?.["text-opacity"], 1), 1), blur: num(ev(L.paint?.["text-halo-blur"], 0), 0),
		...(vaList?.length ? { va: vaList, ro: lo["text-radial-offset"] != null ? num(ev(lo["text-radial-offset"], 0), 0) : null } : {}),
	};
	return { rec, transform: String(ev(lo["text-transform"], "none")) };
}
// style の symbol層から点・横書きラベルを抽出。anchor は絶対経緯度[lon,lat]（タイル跨ぎ共通原点）。
export function buildLabels({ layers, z, x, y }, style) {
	const codeKey = style.schema && style.schema.labelCode;   // 注記の分類コードの属性名＝style の申告（themes の絞り込みと路線記号がこれを見る）
	const out = [];
	const codepoints = new Set();
	const seen = new Set();   // 同一地物が複数層に出るため (text+anchor) で重複排除
	for (let li = 0; li < style.layers.length; li++) {
		const L = style.layers[li];
		if (L.type !== "symbol") continue;
		const lo = L.layout || {};
		if (lo["text-field"] == null) continue;                 // アイコンのみは M2
		if ((lo["symbol-placement"] || "point") !== "point") continue;   // 線ラベルは M2
		// 層の zoom 域（MapLibre の layer.minzoom ≤ 地図の z < layer.maxzoom）＝ラベルに style の z で焼き込み（minZ/maxZ）、描く側（labels2d の collide）が地図の z で裁く。
		// タイルの z で裁くと粗いタイルの時に全滅する（demotiles の countries-label＝o16s で 46→0）。旧＝見ていなかった＝OpenFreeMap の label_state（minzoom 5）が z3 で 53 個出て city 名を押し出していた（2026-09-28）
		const minZ = L.minzoom ?? null, maxZ = L.maxzoom != null ? L.maxzoom - 1e-6 : null;   // maxzoom は排他
		// M1.2: 縦書き層も一旦「横書き」で描く（全ラベル可視化）。正しい縦書きは M2。
		const src = layers[L["source-layer"]]; if (!src) continue;
		const ml = originOfLayer(L) === "ml";   // MapLibre の文書から来た層＝padding の既定 2（MapLibre）・ネイティブの層＝従来の 5（この地図の注記の間合い）

		for (const f of src.features) {
			if (f.type !== "Point") continue;
			const ctx = { zoom: z, props: f.props, geom: f.type, vars: {}, origin: originOfLayer(L) };   // MapLibre の文書から来た層＝MapLibre の意味（2026-09-26）
			if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
			const text = String(evalExpr(lo["text-field"], ctx) ?? "").trim();
			if (!text) continue;
			const g = f.geom; if (!g || !g.coords.length) continue;   // フラットgeom：先頭点＝coords[0,1]
			const px = g.coords[0], py = g.coords[1];
			const [lon, lat] = tileLocalToLonLat(x, y, z, px, py, src.extent);
			const dkey = text + "@" + Math.round(px) + "," + Math.round(py);
			if (seen.has(dkey)) continue; seen.add(dkey);
			const size = num(evalExpr(lo["text-size"] ?? 16, ctx), 16);
			const color = parseRGBA(evalExpr(L.paint?.["text-color"] ?? "#000", ctx));
			const halo = parseRGBA(evalExpr(L.paint?.["text-halo-color"] ?? "rgba(255,255,255,1)", ctx));
			const haloW = num(evalExpr(L.paint?.["text-halo-width"] ?? 0, ctx), 0);
			const sort = num(evalExpr(lo["symbol-sort-key"] ?? 0, ctx), 0);
			for (const ch of text) codepoints.add(ch.codePointAt(0));
			const lay = layoutOf(L, lo, ctx, ml);
			out.push({ anchor: [lon, lat], text: lay.transform === "uppercase" ? text.toUpperCase() : lay.transform === "lowercase" ? text.toLowerCase() : text, size, font: M1_FONT, color, halo, haloW, sort, code: codeKey ? num(f.props[codeKey], 0) : 0, li, minZ, maxZ, ...lay.rec });   // minZ/maxZ＝style の z（main が地図の z の目盛りへ寄せる）・lay＝配置の layout（labels2d の箱）   // li＝層の添字（基図の層の出し入れ＝main が外す・段 7）   // 分類コードの属性名は style の申告（無ければ 0＝分類なし）
		}
	}
	return { labels: out, codepoints, font: M1_FONT };
}
