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
// 面の到達不能極（polylabel と同じ考え方＝格子を細かくしながら「縁から一番遠い点」を探す・経緯度の平面で近似・精度は外接の 1/100・試行は 3000 まで）
export function poleOf(rings) {
	const outer = rings?.[0]; if (!outer?.length) return null;
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
	for (const [x, y] of outer) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
	const w = x1 - x0, h = y1 - y0, cell = Math.min(w, h);
	if (!(cell > 0)) return [x0, y0];
	const prec = Math.max(w, h) / 100;
	const seg2 = (px, py, a, b) => { let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y; if (dx || dy) { const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy); if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; } } dx = px - x; dy = py - y; return dx * dx + dy * dy; };
	const sd = (x, y) => { let inside = false, m = Infinity; for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside; m = Math.min(m, seg2(x, y, a, b)); } return (inside ? 1 : -1) * Math.sqrt(m); };
	const mk = (x, y, hh) => { const d = sd(x, y); return { x, y, h: hh, d, max: d + hh * Math.SQRT2 }; };
	const q = [], h2 = cell / 2;
	for (let x = x0; x < x1; x += cell) for (let y = y0; y < y1; y += cell) q.push(mk(x + h2, y + h2, h2));
	let best = mk((x0 + x1) / 2, (y0 + y1) / 2, 0);
	for (let it = 0; q.length && it < 3000; it++) {
		let k = 0; for (let i = 1; i < q.length; i++) if (q[i].max > q[k].max) k = i;
		const c = q.splice(k, 1)[0];
		if (c.d > best.d) best = c;
		if (c.max - best.d <= prec) continue;
		const hh = c.h / 2;
		q.push(mk(c.x - hh, c.y - hh, hh), mk(c.x + hh, c.y - hh, hh), mk(c.x - hh, c.y + hh, hh), mk(c.x + hh, c.y + hh, hh));
	}
	return [best.x, best.y];
}

export function symbolItems(src, layer = {}, zoom = 10, images = null) {
	const origin = originOfLayer(layer);   // MapLibre の層（normalizeMLLayer の印）＝MapLibre の意味で評価
	const feats = Array.isArray(src) ? src : src?.type === "FeatureCollection" ? src.features : src?.type === "Feature" ? [src] : src?.features || [];
	if ((layer.minzoom != null && zoom < layer.minzoom) || (layer.maxzoom != null && zoom >= layer.maxzoom)) return [];
	const Ly = layer.layout || {}, Pt = layer.paint || {}, out = [];
	for (const f of feats) {
		const g = f?.geometry; if (!g) continue;
		// 錨（MapLibre の点置き）：点＝その点・線＝各部分の最初の頂点・面＝各部分の到達不能極（段 6・旧＝点だけ）
		const pts = g.type === "Point" ? [g.coordinates] : g.type === "MultiPoint" ? g.coordinates
			: g.type === "LineString" ? [g.coordinates[0]] : g.type === "MultiLineString" ? g.coordinates.map(l => l[0])
			: g.type === "Polygon" ? [poleOf(g.coordinates)] : g.type === "MultiPolygon" ? g.coordinates.map(poleOf) : null;
		if (!pts?.length || pts.some(p => !p)) continue;
		const props = f.properties || {}, ctx = { zoom, props, geom: g.type, vars: {}, origin };
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
