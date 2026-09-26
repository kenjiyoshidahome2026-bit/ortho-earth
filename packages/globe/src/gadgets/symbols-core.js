// 記号の層の評価（MapLibre の symbol 層の layout/paint → 描く記号の列）。DOM なし＝検定 t-symbols が直接読む。
import { evalExpr, truthy, originOfLayer } from "@ortho-earth/core";
import { evalColor } from "./model.js";

const css = q => q ? `rgba(${Math.round(q[0])},${Math.round(q[1])},${Math.round(q[2])},${q[3] ?? 1})` : null;
// "{name}" の差し込み（MapLibre の旧来の文字列トークン）＋式＋ format（文字の部分だけ繋ぐ）
export function textOf(e, ctx) {
	if (e == null) return "";
	if (typeof e === "string") return e.replace(/\{([^}]+)\}/g, (_, k) => ctx.props[k] ?? "");
	if (Array.isArray(e) && e[0] === "format") { let s = ""; for (let i = 1; i < e.length; i++) if (typeof e[i] !== "object" || Array.isArray(e[i])) s += textOf(e[i], ctx); return s; }
	const v = evalExpr(e, ctx);
	return v == null ? "" : String(v);
}
export function symbolItems(src, layer = {}, zoom = 10, images = null) {
	const origin = originOfLayer(layer);   // MapLibre の層（normalizeMLLayer の印）＝MapLibre の意味で評価
	const feats = Array.isArray(src) ? src : src?.type === "FeatureCollection" ? src.features : src?.type === "Feature" ? [src] : src?.features || [];
	if ((layer.minzoom != null && zoom < layer.minzoom) || (layer.maxzoom != null && zoom >= layer.maxzoom)) return [];
	const Ly = layer.layout || {}, Pt = layer.paint || {}, out = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		const pts = g.type === "Point" ? [g.coordinates] : g.type === "MultiPoint" ? g.coordinates : null;
		if (!pts) continue;
		const props = f.properties || {}, ctx = { zoom, props, geom: "Point", vars: {}, origin };
		if (layer.filter != null && !truthy(evalExpr(layer.filter, ctx))) continue;
		const ev = (e, d) => e == null ? d : evalExpr(e, ctx);
		const strs = e => e == null ? null : Array.isArray(e) && e.length && e.every(x => typeof x === "string") && !["literal", "match", "case", "step", "get", "coalesce"].includes(e[0]) ? e : (v => Array.isArray(v) ? v : null)(evalExpr(e, ctx));   // 文字列の配列リテラル（["top","bottom"]）は式でない
		const icon = Ly["icon-image"] != null ? textOf(Ly["icon-image"], ctx) : null;
		const text = textOf(Ly["text-field"], ctx);
		if (!icon && !text) continue;
		const it = {
			icon: icon || null, size: +ev(Ly["icon-size"], 1), rotate: +ev(Ly["icon-rotate"], 0), anchor: ev(Ly["icon-anchor"], "center"), offset: ev(Ly["icon-offset"], [0, 0]),
			iconOverlap: !!ev(Ly["icon-allow-overlap"], false), iconIgnore: !!ev(Ly["icon-ignore-placement"], false),
			color: css(evalColor(Pt["icon-color"] ?? "#000000", ctx)), opacity: +ev(Pt["icon-opacity"] ?? Pt["text-opacity"], 1),
			text, textSize: +ev(Ly["text-size"], 16), textAnchor: ev(Ly["text-anchor"], "center"), textOffset: ev(Ly["text-offset"], [0, 0]),
			textOverlap: !!ev(Ly["text-allow-overlap"], false), textIgnore: !!ev(Ly["text-ignore-placement"], false), textPadding: +ev(Ly["text-padding"], 2),   // text-padding＝MapLibre の既定 2px（文字の周りの空き・重なり判定だけに効く）
			textColor: css(evalColor(Pt["text-color"] ?? "#000000", ctx)), haloColor: css(evalColor(Pt["text-halo-color"] ?? "rgba(0,0,0,0)", ctx)), haloWidth: +ev(Pt["text-halo-width"], 0),
			sort: +ev(Ly["symbol-sort-key"], 0) || 0, props,
			horizon: +layer.horizon || 0,   // 拡張（MapLibre に無い）：球の縁の近くは出さない＝視線と地面のなす角の余弦の下限（0＝従来どおり全部）
			// #39：text-variable-anchor（候補を順に試す・text-radial-offset か text-offset の大きさで離す）・icon-text-fit（記号を文字の箱へ伸ばす）
			textVariableAnchor: strs(Ly["text-variable-anchor"]), textRadialOffset: Ly["text-radial-offset"] != null ? +ev(Ly["text-radial-offset"], 0) : null,
			iconTextFit: ev(Ly["icon-text-fit"], "none"), iconTextFitPadding: ev(Ly["icon-text-fit-padding"], [0, 0, 0, 0]),
		};
		if (icon && images && !images.has(icon)) it.icon = null;   // 記号帳に無い名前＝記号は描かない（MapLibre は styleimagemissing を鳴らす）＝文字だけ残る
		if (!it.icon && !it.text) continue;
		for (const c of pts) out.push({ ...it, lon: c[0], lat: c[1] });
	}
	out.sort((a, b) => a.sort - b.sort);   // symbol-sort-key 昇順＝小さいほど先に置く（重なりで勝つ）
	return out;
}
