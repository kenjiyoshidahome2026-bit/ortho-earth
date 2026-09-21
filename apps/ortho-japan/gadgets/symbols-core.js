// 記号の層の評価（MapLibre の symbol 層の layout/paint → 描く記号の列）。DOM なし＝検定 t-symbols が直接読む。
import { evalExpr, truthy } from "ortho-core";
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
	const feats = Array.isArray(src) ? src : src?.type === "FeatureCollection" ? src.features : src?.type === "Feature" ? [src] : src?.features || [];
	if ((layer.minzoom != null && zoom < layer.minzoom) || (layer.maxzoom != null && zoom >= layer.maxzoom)) return [];
	const Ly = layer.layout || {}, Pt = layer.paint || {}, out = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		const pts = g.type === "Point" ? [g.coordinates] : g.type === "MultiPoint" ? g.coordinates : null;
		if (!pts) continue;
		const props = f.properties || {}, ctx = { zoom, props, geom: "Point", vars: {} };
		if (layer.filter != null && !truthy(evalExpr(layer.filter, ctx))) continue;
		const ev = (e, d) => e == null ? d : evalExpr(e, ctx);
		const icon = Ly["icon-image"] != null ? textOf(Ly["icon-image"], ctx) : null;
		const text = textOf(Ly["text-field"], ctx);
		if (!icon && !text) continue;
		const it = {
			icon: icon || null, size: +ev(Ly["icon-size"], 1), rotate: +ev(Ly["icon-rotate"], 0), anchor: ev(Ly["icon-anchor"], "center"), offset: ev(Ly["icon-offset"], [0, 0]),
			iconOverlap: !!ev(Ly["icon-allow-overlap"], false), iconIgnore: !!ev(Ly["icon-ignore-placement"], false),
			color: css(evalColor(Pt["icon-color"] ?? "#000000", ctx)), opacity: +ev(Pt["icon-opacity"] ?? Pt["text-opacity"], 1),
			text, textSize: +ev(Ly["text-size"], 16), textAnchor: ev(Ly["text-anchor"], "center"), textOffset: ev(Ly["text-offset"], [0, 0]),
			textOverlap: !!ev(Ly["text-allow-overlap"], false), textIgnore: !!ev(Ly["text-ignore-placement"], false),
			textColor: css(evalColor(Pt["text-color"] ?? "#000000", ctx)), haloColor: css(evalColor(Pt["text-halo-color"] ?? "rgba(0,0,0,0)", ctx)), haloWidth: +ev(Pt["text-halo-width"], 0),
			sort: +ev(Ly["symbol-sort-key"], 0) || 0, props,
		};
		if (icon && images && !images.has(icon)) it.icon = null;   // 記号帳に無い名前＝記号は描かない（MapLibre は styleimagemissing を鳴らす）＝文字だけ残る
		if (!it.icon && !it.text) continue;
		for (const c of pts) out.push({ ...it, lon: c[0], lat: c[1] });
	}
	out.sort((a, b) => a.sort - b.sort);   // symbol-sort-key 昇順＝小さいほど先に置く（重なりで勝つ）
	return out;
}
