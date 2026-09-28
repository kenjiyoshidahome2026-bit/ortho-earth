// ラベル抽出（投影非依存）。style の symbol層から点・横書きラベルを取り出す。
// 描画は labels2d（Canvas2Dオーバーレイ）が担う。size/color/halo は式を評価。
import { evalExpr, truthy, originOfLayer } from "./expr.js";
import { parseRGBA } from "./color.js";
import { tileLocalToLonLat } from "./tile.js";
import { parseFontStack } from "./fontstack.js";

const M1_FONT = "NotoSansJP-Regular";

const num = (v, d) => (typeof v === "number" && !isNaN(v)) ? v : d;

// 配置の layout（MapLibre の symbol の layout＝段 1・2026-09-28）＝labels2d が箱を作る材料。式は評価してから運ぶ（worker は式を持たない）。
// text-anchor/offset/radial-offset/variable-anchor・max-width（em・折り返し）・letter-spacing（em）・line-height（em）・justify・transform・padding（px・重なり判定だけ）・
// allow-overlap／ignore-placement・text-opacity・halo-blur。既定＝MapLibre（padding 2・max-width 10・line-height 1.2）。ネイティブ層（origin ml でない）は padding 5＝従来の間合い
// 線に沿う注記（段 4・2026-09-28）＝symbol-placement "line"／"line-center"：タイルで錨（symbol-spacing 間隔＝px×extent/512・中心）と、錨の前後の折れ線（経緯度・文字の長さ分の窓）を焼く。
// 字を線に沿わせる・max-angle・keep-upright・字ごとの衝突は描く側（labels2d）。線の記号（icon）は出さない・面の輪郭には置かない（記録）
// アイコン（段 3・2026-09-28）＝icon-image は名前だけ運ぶ（記号帳は labels2d が持つ＝sprite が後から届いても名前で引く）。icon-size/-anchor/-offset（px×size）/-rotate/-padding/
// -allow-overlap/-ignore-placement/-optional・text-optional・icon-text-fit（＋padding）・icon-color（SDF）・icon-opacity。既定は MapLibre（size 1・padding 2・fit none）
const ANCHORS = new Set(["center", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"]);
const FITS = new Set(["none", "width", "height", "both"]);
function iconOf(L, lo, ctx) {
	const ev = (e, d) => { if (e == null) return d; const v = evalExpr(e, ctx); return v == null ? d : v; };
	const an = String(ev(lo["icon-anchor"], "center")), off = ev(lo["icon-offset"], [0, 0]), fit = String(ev(lo["icon-text-fit"], "none")), fp = ev(lo["icon-text-fit-padding"], [0, 0, 0, 0]);
	const rec = {
		isz: num(ev(lo["icon-size"], 1), 1), ian: ANCHORS.has(an) ? an : "center", ioff: Array.isArray(off) && off.length === 2 ? [num(off[0], 0), num(off[1], 0)] : [0, 0],
		irot: num(ev(lo["icon-rotate"], 0), 0), ipad: num(ev(lo["icon-padding"], 2), 2),
		iov: !!ev(lo["icon-allow-overlap"], false), iig: !!ev(lo["icon-ignore-placement"], false), iopt: !!ev(lo["icon-optional"], false), topt: !!ev(lo["text-optional"], false),
		iop: num(ev(L.paint?.["icon-opacity"], 1), 1), ira: String(ev(lo["icon-rotation-alignment"], "auto")),   // ira＝線の記号を線の向きに回す（auto/map）か画面に正立（viewport）か
	};
	if (FITS.has(fit) && fit !== "none") { rec.ifit = fit; rec.ifp = Array.isArray(fp) && fp.length === 4 ? fp.map(v => num(v, 0)) : [0, 0, 0, 0]; }
	if (L.paint?.["icon-color"] != null) rec.icol = parseRGBA(evalExpr(L.paint["icon-color"], ctx));   // SDF の記号を塗る色（無ければ #000＝labels2d の既定）
	return rec;
}
// 線の各部分（flat coords＋ends）→ 錨の候補 [{ px, py, path:[px,py,…], ai }]（タイル単位）。
// step＝候補の間隔（0＝中心 1 つ＝line-center）・half＝文字の長さの半分・first＝最初の錨（MapLibre＝文字の半分＋2 字分）・win＝錨の前後に残す折れ線の長さ。
// 候補は文字が線に収まる範囲（first ≤ d ≤ len−half）だけ・錨はタイルの中だけ（隣のタイルのバッファと二重に出さない）。symbol-spacing（画面 px）は描く側（labels2d）が同じ文字の群に課す＝表示 z に追随
function lineAnchors(g, extent, { step, half, first, win }) {
	const c = g.coords, ends = g.ends?.length ? g.ends : [c.length], out = [];
	let s = 0;
	for (const e of ends) {
		const n = (e - s) / 2; if (n < 2) { s = e; continue; }
		const cum = new Float64Array(n); let len = 0;
		for (let i = 1; i < n; i++) { const dx = c[s + i * 2] - c[s + i * 2 - 2], dy = c[s + i * 2 + 1] - c[s + i * 2 - 1]; len += Math.hypot(dx, dy); cum[i] = len; }
		if (len <= 0) { s = e; continue; }
		const at = d => { let i = 1; while (i < n - 1 && cum[i] < d) i++; const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [c[s + i * 2 - 2] + (c[s + i * 2] - c[s + i * 2 - 2]) * t, c[s + i * 2 - 1] + (c[s + i * 2 + 1] - c[s + i * 2 - 1]) * t, i]; };
		const ds = [];
		if (step > 0) { for (let d = first; d <= len - half; d += step) ds.push(d); }
		if (!ds.length && len >= half) ds.push(len / 2);   // 最初の錨の余白（2 字分）が取れない短い部分（枠で切った線・過拡大）＝中心に 1 つ（収まるかは描く側が画面の字送りで裁く＝過拡大では見積もりより短い。MapLibre は過拡大のタイルで間隔が縮む＝その近似）
		for (const d of ds) {
			const [ax, ay, ai] = at(d);
			if (ax < 0 || ay < 0 || ax >= extent || ay >= extent) continue;
			const [bx, by, bi] = at(Math.max(0, d - win)), [ex, ey, ei] = at(Math.min(len, d + win));
			const path = [bx, by]; for (let i = bi; i < ai; i++) path.push(c[s + i * 2], c[s + i * 2 + 1]);
			const aidx = path.length / 2; path.push(ax, ay);
			for (let i = ai; i < ei; i++) path.push(c[s + i * 2], c[s + i * 2 + 1]); path.push(ex, ey);
			out.push({ px: ax, py: ay, path, ai: aidx });
		}
		s = e;
	}
	return out;
}
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
		...(ml && lo["text-font"] != null ? (f => f ? { fnt: f } : {})(parseFontStack(ev(lo["text-font"], null))) : {}),   // 書体（段 2）＝MapLibre 由来の層だけ（ネイティブは既定の束）
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
		if (lo["text-field"] == null && lo["icon-image"] == null) continue;   // 文字も記号も無い層（旧＝アイコンのみは M2＝段 3 で読む）
		const placeE = lo["symbol-placement"] ?? "point", traE = lo["text-rotation-alignment"] ?? "auto";   // symbol-placement は式のことがある（road_shield_us＝zoom で point/line）＝地物ごとに評価
		// 層の zoom 域（MapLibre の layer.minzoom ≤ 地図の z < layer.maxzoom）＝ラベルに style の z で焼き込み（minZ/maxZ）、描く側（labels2d の collide）が地図の z で裁く。
		// タイルの z で裁くと粗いタイルの時に全滅する（demotiles の countries-label＝o16s で 46→0）。旧＝見ていなかった＝OpenFreeMap の label_state（minzoom 5）が z3 で 53 個出て city 名を押し出していた（2026-09-28）
		const minZ = L.minzoom ?? null, maxZ = L.maxzoom != null ? L.maxzoom - 1e-6 : null;   // maxzoom は排他
		// M1.2: 縦書き層も一旦「横書き」で描く（全ラベル可視化）。正しい縦書きは M2。
		const src = layers[L["source-layer"]]; if (!src) continue;
		const ml = originOfLayer(L) === "ml";   // MapLibre の文書から来た層＝padding の既定 2（MapLibre）・ネイティブの層＝従来の 5（この地図の注記の間合い）

		for (const f of src.features) {
			const ctx = { zoom: z, props: f.props, geom: f.type, vars: {}, origin: originOfLayer(L) };   // MapLibre の文書から来た層＝MapLibre の意味（2026-09-26）
			const place = String(evalExpr(placeE, ctx) ?? "point"), onLine = place === "line" || place === "line-center";   // 線に沿う注記（段 4）
			if (onLine ? f.type !== "LineString" : f.type === "Polygon") continue;   // 線の注記は線だけ（面の輪郭は置かない・記録）。点の注記＝点と、線の各部分の先頭の頂点（MapLibre の点置き＝低 z の道路の盾）
			if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
			const text = lo["text-field"] == null ? "" : String(evalExpr(lo["text-field"], ctx) ?? "").trim();
			const icon = lo["icon-image"] == null ? "" : String(evalExpr(lo["icon-image"], ctx) ?? "").trim();   // 記号の名前（["image", …] は名前をそのまま返す・"{tok}" は mlstyle が式にしてある）
			if (!text && !icon) continue;
			const g = f.geom; if (!g || !g.coords.length) continue;   // フラットgeom：先頭点＝coords[0,1]
			const size = num(evalExpr(lo["text-size"] ?? 16, ctx), 16);
			// 線の錨に「回さず」置く＝text-rotation-alignment viewport（記号だけなら icon-rotation-alignment viewport）＝道路の盾（road_shield_us）。点の注記として錨に置く（記号も文字も回さない・spacing だけ課す）
			const upright = onLine && String(evalExpr(text ? traE : (lo["icon-rotation-alignment"] ?? "auto"), ctx) ?? "auto") === "viewport";
			// 線の錨：px→タイル単位は extent/256（このエンジンのタイルは 256px 世界＝タイル z＝エンジン z で 16 単位/px。MapLibre の 512px タイル z と同じ地面）。文字の長さは字数×size×0.7 の見積もり（本物の幅は描く側・記号だけなら 16px×icon-size）。候補の間隔＝max(文字の長さ/2, spacing/4)（曲がった線でも真っ直ぐな所を拾えるよう密に・spacing は描く側）・最初＝文字の半分＋2 字分（MapLibre）・窓＝文字の長さ＋余白
			const upp = src.extent / 256, tlen = Math.max(text.length * size * 0.7, text ? 0 : 16 * num(evalExpr(lo["icon-size"] ?? 1, ctx), 1)) * upp, spacingPx = place === "line" ? Math.max(1, num(evalExpr(lo["symbol-spacing"] ?? 250, ctx), 250)) : 0;
			const spots = onLine ? lineAnchors(g, src.extent, { step: place === "line" ? Math.max(tlen / 2, spacingPx * upp / 4) : 0, half: tlen / 2, first: tlen / 2 + size * 2 * upp, win: tlen * 0.75 + size * 2 * upp })
				: f.type === "LineString" ? (() => { const o = [], c = g.coords, ends = g.ends?.length ? g.ends : [c.length]; let st = 0; for (const e of ends) { if (e - st >= 4 && c[st] >= 0 && c[st + 1] >= 0 && c[st] < src.extent && c[st + 1] < src.extent) o.push({ px: c[st], py: c[st + 1] }); st = e; } return o; })()   // 線の各部分の先頭（タイルの中だけ）
				: [{ px: g.coords[0], py: g.coords[1] }];
			for (const sp of spots) {
			const px = sp.px, py = sp.py;
			const [lon, lat] = tileLocalToLonLat(x, y, z, px, py, src.extent);
			const dkey = text + "\u0001" + icon + "@" + Math.round(px) + "," + Math.round(py);
			if (seen.has(dkey)) continue; seen.add(dkey);
			const color = parseRGBA(evalExpr(L.paint?.["text-color"] ?? "#000", ctx));
			const halo = parseRGBA(evalExpr(L.paint?.["text-halo-color"] ?? "rgba(255,255,255,1)", ctx));
			const haloW = num(evalExpr(L.paint?.["text-halo-width"] ?? 0, ctx), 0);
			const sort = num(evalExpr(lo["symbol-sort-key"] ?? 0, ctx), 0);
			for (const ch of text) codepoints.add(ch.codePointAt(0));
			const lay = layoutOf(L, lo, ctx, ml);
			const line = !onLine ? {} : upright ? { mw: 0, ...(spacingPx ? { sp: spacingPx } : {}) } : (() => { const path = new Float64Array(sp.path.length); for (let i = 0; i < sp.path.length; i += 2) { const q = tileLocalToLonLat(x, y, z, sp.path[i], sp.path[i + 1], src.extent); path[i] = q[0]; path[i + 1] = q[1]; } return { lp: 1, path, ai: sp.ai, mw: 0, ...(spacingPx ? { sp: spacingPx } : {}), ma: num(evalExpr(lo["text-max-angle"] ?? 45, ctx), 45), ku: evalExpr(lo["text-keep-upright"] ?? true, ctx) !== false }; })();   // 線の注記＝折れ線（経緯度）・錨の添字・折り返し無し・max-angle（度）・keep-upright。upright＝点として錨に（sp だけ）
			out.push({ anchor: [lon, lat], text: lay.transform === "uppercase" ? text.toUpperCase() : lay.transform === "lowercase" ? text.toLowerCase() : text, size, font: M1_FONT, color, halo, haloW, sort, code: codeKey ? num(f.props[codeKey], 0) : 0, li, minZ, maxZ, ...lay.rec, ...(icon ? { icon, ...iconOf(L, lo, ctx) } : {}), ...line });   // minZ/maxZ＝style の z（main が地図の z の目盛りへ寄せる）・lay＝配置の layout（labels2d の箱）・icon＝記号（段 3）   // li＝層の添字（基図の層の出し入れ＝main が外す・段 7）   // 分類コードの属性名は style の申告（無ければ 0＝分類なし）
			}
		}
	}
	return { labels: out, codepoints, font: M1_FONT };
}
