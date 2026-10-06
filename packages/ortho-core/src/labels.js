// ラベル抽出（投影非依存）。style の symbol層から点・横書きラベルを取り出す。
// 描画は labels2d（Canvas2Dオーバーレイ）が担う。size/color/halo は式を評価。
import { evalExpr, truthy, originOfLayer, formatSections } from "./expr.js";
import { allowsVertical } from "./vertical.js";
import { parseRGBA } from "./color.js";
import { tileLocalToLonLat } from "./tile.js";
import { parseFontStack } from "./fontstack.js";
import { labelKey } from "./labelkey.js";   // 注記の鍵＝ここで一度焼く（main の重複排除・labels2d の当選集合が同じ鍵を読む）

const M1_FONT = "NotoSansJP-Regular";

const num = (v, d) => (typeof v === "number" && !isNaN(v)) ? v : d;
// 式が ["zoom"] を読むか（literal の中は見ない）
const usesZoom = e => Array.isArray(e) && (e[0] === "zoom" ? true : e[0] === "literal" ? false : e.some(usesZoom));

// 配置の layout（MapLibre の symbol の layout＝段 1・2026-09-28）＝labels2d が箱を作る材料。式は評価してから運ぶ（worker は式を持たない）。
// text-anchor/offset/radial-offset/variable-anchor・max-width（em・折り返し）・letter-spacing（em）・line-height（em）・justify・transform・padding（px・重なり判定だけ）・
// allow-overlap／ignore-placement・text-opacity・halo-blur。既定＝MapLibre（padding 2・max-width 10・line-height 1.2）。ネイティブ層（origin ml でない）は padding 5＝従来の間合い
// 向き（段 5・2026-09-28）＝text-rotate・text/icon-rotation-alignment・text/icon-pitch-alignment を焼く（描く側 labels2d の orient が地面の基底から transform を組む）
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
		iov: lo["icon-overlap"] != null ? String(ev(lo["icon-overlap"], "never")) !== "never" : !!ev(lo["icon-allow-overlap"], false), iig: !!ev(lo["icon-ignore-placement"], false), iopt: !!ev(lo["icon-optional"], false), topt: !!ev(lo["text-optional"], false),
		iop: num(ev(L.paint?.["icon-opacity"], 1), 1), ira: String(ev(lo["icon-rotation-alignment"], "auto")),   // ira＝線の記号を線の向きに回す（auto/map）か画面に正立（viewport）か・点では map＝地図の回転に追随
	};
	const ipa = String(ev(lo["icon-pitch-alignment"], "auto")); if (ipa !== "auto") rec.ipa = ipa;   // icon-pitch-alignment（段 5）
	if (FITS.has(fit) && fit !== "none") { rec.ifit = fit; rec.ifp = Array.isArray(fp) && fp.length === 4 ? fp.map(v => num(v, 0)) : [0, 0, 0, 0]; }
	if (L.paint?.["icon-color"] != null) rec.icol = parseRGBA(evalExpr(L.paint["icon-color"], ctx));   // SDF の記号を塗る色（無ければ #000＝labels2d の既定）
	const it = ev(L.paint?.["icon-translate"], null); if (Array.isArray(it) && it.length === 2 && (num(it[0], 0) || num(it[1], 0))) { rec.itt = [num(it[0], 0), num(it[1], 0)]; if (String(ev(L.paint?.["icon-translate-anchor"], "map")) === "viewport") rec.itta = "viewport"; }   // icon-translate（px）＋anchor（2026-10-03）
	return rec;
}
// 線の各部分（flat coords＋ends）→ 錨の候補 [{ px, py, path:[px,py,…], ai }]（タイル単位）。
// step＝候補の間隔（0＝中心 1 つ＝line-center）・half＝文字の長さの半分・first＝最初の錨（MapLibre＝文字の半分＋2 字分）・win＝錨の前後に残す折れ線の長さ。
// 候補は文字が線に収まる範囲（first ≤ d ≤ len−half）だけ・錨はタイルの中だけ（隣のタイルのバッファと二重に出さない）。symbol-spacing（画面 px）は描く側（labels2d）が同じ文字の群に課す＝表示 z に追随
function lineAnchors(g, extent, { step, half, first, win }) {
	const c = g.coords, ends = g.ends?.length ? g.ends : [c.length], out = [];
	let s = 0, pi = 0;
	for (const e of ends) {
		const n = (e - s) / 2; if (n < 2) { s = e; pi++; continue; }
		const cum = new Float64Array(n); let len = 0;
		for (let i = 1; i < n; i++) { const dx = c[s + i * 2] - c[s + i * 2 - 2], dy = c[s + i * 2 + 1] - c[s + i * 2 - 1]; len += Math.hypot(dx, dy); cum[i] = len; }
		if (len <= 0) { s = e; pi++; continue; }
		const at = d => { let i = 1; while (i < n - 1 && cum[i] < d) i++; const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1); return [c[s + i * 2 - 2] + (c[s + i * 2] - c[s + i * 2 - 2]) * t, c[s + i * 2 - 1] + (c[s + i * 2 + 1] - c[s + i * 2 - 1]) * t, i]; };
		const ds = [];
		if (step > 0) { for (let d = first; d <= len - half; d += step) ds.push(d); }
		if (!ds.length && len >= half / 2) ds.push(len / 2);   // 最初の錨の余白が取れない短い部分（枠で切った線・過拡大）＝文字の 1/4 以上なら中心に 1 つ（収まるかは描く側が画面の字送りで裁く＝過拡大 2〜3 倍では見積もりの 1/2〜1/3 で収まる。MapLibre は過拡大のタイルで間隔が縮む＝その近似・2026-09-28 highway-name-minor 11/24 の手当て）
		for (const d of ds) {
			const [ax, ay, ai] = at(d);
			if (ax < 0 || ay < 0 || ax >= extent || ay >= extent) continue;
			const [bx, by, bi] = at(Math.max(0, d - win)), [ex, ey, ei] = at(Math.min(len, d + win));
			const path = [bx, by]; for (let i = bi; i < ai; i++) path.push(c[s + i * 2], c[s + i * 2 + 1]);
			const aidx = path.length / 2; path.push(ax, ay);
			for (let i = ai; i < ei; i++) path.push(c[s + i * 2], c[s + i * 2 + 1]); path.push(ex, ey);
			out.push({ px: ax, py: ay, path, ai: aidx, part: pi });
		}
		s = e;
		pi++;
	}
	return out;
}
// format の区間（expr.js formatSections）→ 焼く形 [{ t, fs?, col?（[r,g,b,a]）, fnt?（parseFontStack の形） }]。書式の付く区間が 1 つも無ければ null（従来の 1 本の文字で描く）。
// 記号の区間（["image"]）は文字 ""（記号の差し込みは未・記録）。両端の空白は text（trim 済み）と揃える
function sectionsOf(tf, ctx) {
	const raw = Array.isArray(tf) && tf[0] === "format" ? formatSections(tf, ctx) : null;
	if (!raw || !raw.some(q => q.fs != null || q.col != null || q.fnt)) return null;
	const out = [];
	for (const q of raw) {
		if (!q.t) continue;
		const r = { t: q.t };
		if (q.fs != null && q.fs !== 1) r.fs = q.fs;
		if (q.col != null) { const c = parseRGBA(q.col); if (c) r.col = c; }
		if (q.fnt) { const f = parseFontStack(q.fnt); if (f) r.fnt = f; }
		out.push(r);
	}
	if (!out.length) return null;
	out[0].t = out[0].t.trimStart(); out[out.length - 1].t = out[out.length - 1].t.trimEnd();
	return out.filter(r => r.t);
}
// 線の各部分（flat coords＋ends）を丸ごと＝symbol-placement "line" の注記 1 本分（2026-10-07）。錨は描く側（labels2d）が表示の整数 z で symbol-spacing の間隔に置く
// （MapLibre の getAnchors＝過拡大のタイルごとに組み直すのと同じ答え＝旧＝タイルの z の目盛りで候補を焼いていた＝z14 のタイルを z17 で見ると候補が 8 倍疎・最初の余白が 8 倍）。
// 記録＝path（経緯度）・cum（タイル単位の弧長）・lc（枠に続く＝1 始まり・2 終わり＝MapLibre の isLineContinued）・mid（弧長の中心＝錨＝鍵・標高・並べ替えの代表点）
function lineParts(g, extent) {
	const c = g.coords, ends = g.ends?.length ? g.ends : [c.length], out = [];
	let s = 0, pi = 0;
	for (const e of ends) {
		const n = (e - s) / 2; if (n < 2) { s = e; pi++; continue; }
		const cum = new Float32Array(n); let len = 0;
		for (let i = 1; i < n; i++) { len += Math.hypot(c[s + i * 2] - c[s + i * 2 - 2], c[s + i * 2 + 1] - c[s + i * 2 - 1]); cum[i] = len; }
		if (len <= 0) { s = e; pi++; continue; }
		const onEdge = (x, y) => x <= 0 || y <= 0 || x >= extent || y >= extent;
		const lc = (onEdge(c[s], c[s + 1]) ? 1 : 0) | (onEdge(c[e - 2], c[e - 1]) ? 2 : 0);
		let i = 1; const d = len / 2; while (i < n - 1 && cum[i] < d) i++; const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
		out.push({ px: c[s + i * 2 - 2] + (c[s + i * 2] - c[s + i * 2 - 2]) * t, py: c[s + i * 2 - 1] + (c[s + i * 2 + 1] - c[s + i * 2 - 1]) * t, s, n, cum, lc, part: pi });
		s = e; pi++;
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
		ov: lo["text-overlap"] != null ? String(ev(lo["text-overlap"], "never")) !== "never" : !!ev(lo["text-allow-overlap"], false), ig: !!ev(lo["text-ignore-placement"], false),   // text-overlap（MapLibre 新）が allow-overlap に勝つ・cooperative は always 扱い（近似）
		op: num(ev(L.paint?.["text-opacity"], 1), 1), blur: num(ev(L.paint?.["text-halo-blur"], 0), 0),
		...(ml && lo["text-font"] != null ? (f => f ? { fnt: f } : {})(parseFontStack(ev(lo["text-font"], null))) : {}),   // 書体（段 2）＝MapLibre 由来の層だけ（ネイティブは既定の束）
		...(vaList?.length ? { va: vaList, ro: lo["text-radial-offset"] != null ? num(ev(lo["text-radial-offset"], 0), 0) : null } : {}),
	};
	// text-writing-mode（["horizontal"|"vertical", …]・2026-10-03）＝縦書きにできる文字（漢字・かな・ハングル…を含む）の注記だけ焼く。点の注記＝並びの順に試す（MapLibre の placementModes）・線の注記＝線が縦に近い所で縦
	const wmRaw = lo["text-writing-mode"], wm = Array.isArray(wmRaw) && wmRaw.every(x => typeof x === "string") ? wmRaw : (v => Array.isArray(v) ? v : null)(wmRaw == null ? null : evalExpr(wmRaw, ctx));
	if (wm && wm.includes("vertical")) rec.wm = wm.filter(x => x === "vertical" || x === "horizontal").map(x => x[0]).filter((x, i, a) => a.indexOf(x) === i).join("");   // "v"・"hv"・"vh"
	// 向き（段 5）＝text-rotate（度・時計回り）・text-rotation-alignment（map＝地図の回転に追随／viewport＝画面／viewport-glyph＝線の上で字だけ正立）・text-pitch-alignment（map＝傾けた地面に寝かせる）。既定（auto・0）は焼かない
	const rot = num(ev(lo["text-rotate"], 0), 0), ra = String(ev(lo["text-rotation-alignment"], "auto")), pa = String(ev(lo["text-pitch-alignment"], "auto"));
	if (rot) rec.rot = rot; if (ra !== "auto") rec.ra = ra; if (pa !== "auto") rec.pa = pa;
	// text-translate（px・[x, y]・右と下が正）＋ text-translate-anchor（map＝地図の回転に追随（既定）／viewport＝画面）＝描く側が錨の画面位置に足す（2026-10-03）
	const tt = ev(L.paint?.["text-translate"], null); if (Array.isArray(tt) && tt.length === 2 && (num(tt[0], 0) || num(tt[1], 0))) { rec.tt = [num(tt[0], 0), num(tt[1], 0)]; if (String(ev(L.paint?.["text-translate-anchor"], "map")) === "viewport") rec.tta = "viewport"; }
	// text-variable-anchor-offset（[錨, [x, y], 錨, [x, y], …]・em）＝錨ごとのずらし（text-offset と同じ向き）。あれば text-variable-anchor／radial-offset に勝つ（MapLibre と同じ）
	const vao = ev(lo["text-variable-anchor-offset"], null);
	if (Array.isArray(vao) && vao.length >= 2 && vao.length % 2 === 0) {
		const va = [], vo = {};
		for (let i = 0; i < vao.length; i += 2) { const an = String(vao[i]), o = vao[i + 1]; if (!ANCHORS.has(an) || !Array.isArray(o) || o.length !== 2) continue; va.push(an); vo[an] = [num(o[0], 0), num(o[1], 0)]; }
		if (va.length) { rec.va = va; rec.vao = vo; delete rec.ro; }
	}
	return { rec, transform: String(ev(lo["text-transform"], "none")) };
}
// style の symbol層から点・横書きラベルを抽出。anchor は絶対経緯度[lon,lat]（タイル跨ぎ共通原点）。
// stateOf＝地物 → その feature-state（#109・省略可＝build.js と同じ口）。filter の後に ctx へ＝paint（text-color・halo・text-opacity・icon-color…）が読む。基図は渡さない
export function buildLabels({ layers, z, x, y, stateOf = null }, style) {
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

		const sizeZ = lo["text-size"] != null && usesZoom(lo["text-size"]);   // text-size が zoom を読む（連続な大きさの材料を焼く）
		let fi = 0;
		for (const f of src.features) {
			fi++;
			const ctx = { zoom: z, props: f.props, geom: f.type, vars: {}, origin: originOfLayer(L), state: undefined };   // MapLibre の文書から来た層＝MapLibre の意味（2026-09-26）
			const place = String(evalExpr(placeE, ctx) ?? "point"), onLine = place === "line" || place === "line-center";   // 線に沿う注記（段 4）
			if (onLine ? f.type !== "LineString" : f.type === "Polygon") continue;   // 線の注記は線だけ（面の輪郭は置かない・記録）。点の注記＝点と、線の各部分の先頭の頂点（MapLibre の点置き＝低 z の道路の盾）
			if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
			if (stateOf) ctx.state = stateOf(f);   // filter の後（#109）
			const text = lo["text-field"] == null ? "" : String(evalExpr(lo["text-field"], ctx) ?? "").trim();
			const sec = text ? sectionsOf(lo["text-field"], ctx) : null;   // format の区間（書式が付く時だけ・2026-10-03）
			const icon = lo["icon-image"] == null ? "" : String(evalExpr(lo["icon-image"], ctx) ?? "").trim();   // 記号の名前（["image", …] は名前をそのまま返す・"{tok}" は mlstyle が式にしてある）
			if (!text && !icon) continue;
			const g = f.geom; if (!g || !g.coords.length) continue;   // フラットgeom：先頭点＝coords[0,1]
			const size = num(evalExpr(lo["text-size"] ?? 16, ctx), 16);
			// ズームに連続な文字の大きさ（MapLibre は text-size を表示の z で評価＝タイルの z で焼くと段が替わる時に跳ぶ）：式が zoom を読む層は z−1・z+1 の値も焼き、
			// 描く側（labels2d）が表示の z で線形に補間する（錨・鍵・size（タイルの z の値）は不変＝差分配達の鍵も不変）。ハロー幅は文字と同じ倍率で伸びる
			let szn = null;
			if (sizeZ) { ctx.zoom = z - 1; const a = num(evalExpr(lo["text-size"], ctx), size); ctx.zoom = z + 1; const b = num(evalExpr(lo["text-size"], ctx), size); ctx.zoom = z; if (a !== size || b !== size) szn = [a, b]; }
			// 線の錨に「回さず」置く＝text-rotation-alignment viewport（記号だけなら icon-rotation-alignment viewport）＝道路の盾（road_shield_us）。点の注記として錨に置く（記号も文字も回さない・spacing だけ課す）
			const upright = onLine && String(evalExpr(text ? traE : (lo["icon-rotation-alignment"] ?? "auto"), ctx) ?? "auto") === "viewport";
			// 線の錨：px→タイル単位は extent/256（このエンジンのタイルは 256px 世界＝タイル z＝エンジン z で 16 単位/px。MapLibre の 512px タイル z と同じ地面）。文字の長さは字数×size×0.7 の見積もり（本物の幅は描く側・記号だけなら 16px×icon-size）。候補の間隔＝max(文字の長さ/2, spacing/4)（曲がった線でも真っ直ぐな所を拾えるよう密に・spacing は描く側）・最初＝文字の半分＋1 字分（MapLibre は 2 字分＝過拡大で厳しすぎるので 1 字）・窓＝文字の長さ＋余白
			const upp = src.extent / 256, tlen = Math.max(text.length * size * 0.7, text ? 0 : 16 * num(evalExpr(lo["icon-size"] ?? 1, ctx), 1)) * upp, spacingPx = place === "line" ? Math.max(1, num(evalExpr(lo["symbol-spacing"] ?? 250, ctx), 250)) : 0;
			const whole = onLine && !upright && place === "line";   // 線に沿って回す "line"＝部分を丸ごと 1 本（錨は描く側が表示 z で置く）。line-center＝中心 1 つ・upright（盾）＝タイルの目盛りの候補（従来）
			const spots = whole ? lineParts(g, src.extent)
				: onLine ? lineAnchors(g, src.extent, { step: place === "line" ? Math.max(tlen / 2, spacingPx * upp / 4) : 0, half: tlen / 2, first: tlen / 2 + size * upp, win: tlen * 0.75 + size * 2 * upp })
				: f.type === "LineString" ? (() => { const o = [], c = g.coords, ends = g.ends?.length ? g.ends : [c.length]; let st = 0; for (const e of ends) { if (e - st >= 4 && c[st] >= 0 && c[st + 1] >= 0 && c[st] < src.extent && c[st + 1] < src.extent) o.push({ px: c[st], py: c[st + 1] }); st = e; } return o; })()   // 線の各部分の先頭（タイルの中だけ）
				: [{ px: g.coords[0], py: g.coords[1] }];
			for (const sp of spots) {
			const px = sp.px, py = sp.py;
			const [lon, lat] = tileLocalToLonLat(x, y, z, px, py, src.extent);
			const dkey = (ml ? li + "\u0001" : "") + (whole ? "~" : "") + text + "\u0001" + icon + "@" + Math.round(px) + "," + Math.round(py);   // 丸ごとの線（~）は点・中心の注記と畳まない   // MapLibre 由来の層は層ごとに（同じ点・同じ文字でも別の層なら両方置いて後の層が勝つ＝poi_transit が poi_r1 に消されていた）・ネイティブは従来どおり層またぎで 1 つ
			if (seen.has(dkey)) continue; seen.add(dkey);
			const color = parseRGBA(evalExpr(L.paint?.["text-color"] ?? "#000", ctx));
			const halo = parseRGBA(evalExpr(L.paint?.["text-halo-color"] ?? "rgba(255,255,255,1)", ctx));
			const haloW = num(evalExpr(L.paint?.["text-halo-width"] ?? 0, ctx), 0);
			const sort = num(evalExpr(lo["symbol-sort-key"] ?? 0, ctx), 0);
			for (const ch of text) codepoints.add(ch.codePointAt(0));
			const lay = layoutOf(L, lo, ctx, ml);
			const lg = spacingPx ? `${z}/${x}/${y}/${li}/${fi}/${sp.part ?? 0}` : null;   // symbol-spacing の群＝1 本の線（タイル・層・地物・部分）の中だけ（MapLibre と同じ＝隣の区間の同名の道は両方出る）
			const line = !onLine ? {} : upright ? { mw: 0, ...(spacingPx ? { sp: spacingPx, lg } : {}) } : whole ? (() => {
				const path = new Float64Array(sp.n * 2); for (let i = 0; i < sp.n; i++) { const q = tileLocalToLonLat(x, y, z, g.coords[sp.s + i * 2], g.coords[sp.s + i * 2 + 1], src.extent); path[i * 2] = q[0]; path[i * 2 + 1] = q[1]; }
				const w = tileLocalToLonLat(x, y, z, 0, 0, src.extent), e2 = tileLocalToLonLat(x, y, z, src.extent, src.extent, src.extent);
				return { lp: 2, path, cum: sp.cum, lc: sp.lc, tz: z, upp, tbx: [w[0], e2[1], e2[0], w[1]], mw: 0, sp: spacingPx, lg, ma: num(evalExpr(lo["text-max-angle"] ?? 45, ctx), 45), ku: evalExpr(lo["text-keep-upright"] ?? true, ctx) !== false };   // lp 2＝部分を丸ごと（錨は描く側）・tbx＝タイルの枠（西・南・東・北＝錨はこの中だけ）
			})() : (() => { const path = new Float64Array(sp.path.length); for (let i = 0; i < sp.path.length; i += 2) { const q = tileLocalToLonLat(x, y, z, sp.path[i], sp.path[i + 1], src.extent); path[i] = q[0]; path[i + 1] = q[1]; } return { lp: 1, path, ai: sp.ai, mw: 0, ...(spacingPx ? { sp: spacingPx, lg } : {}), ma: num(evalExpr(lo["text-max-angle"] ?? 45, ctx), 45), ku: evalExpr(lo["text-keep-upright"] ?? true, ctx) !== false }; })();   // 線の注記＝折れ線（経緯度）・錨の添字・折り返し無し・max-angle（度）・keep-upright。upright＝点として錨に（sp だけ）
			const tx = s => lay.transform === "uppercase" ? s.toUpperCase() : lay.transform === "lowercase" ? s.toLowerCase() : s;
			const rec = { anchor: [lon, lat], text: tx(text), size, font: M1_FONT, color, halo, haloW, sort, code: codeKey ? num(f.props[codeKey], 0) : 0, li, minZ, maxZ, ...(szn ? { szn, tz: z } : {}), ...lay.rec, ...(sec ? { sec: sec.map(q => ({ ...q, t: tx(q.t) })) } : {}), ...(icon ? { icon, ...iconOf(L, lo, ctx) } : {}), ...line };
			if (rec.wm && !allowsVertical(rec.text)) delete rec.wm;   // 縦書きにできない文字（ラテンだけ）＝横書き
			rec.key = labelKey(rec);   // 鍵＝文字・記号・錨（ML の層は li も）。文字や錨を変える写しは付け直す
			out.push(rec);   // minZ/maxZ＝style の z（main が地図の z の目盛りへ寄せる）・lay＝配置の layout（labels2d の箱）・icon＝記号（段 3）   // li＝層の添字（基図の層の出し入れ＝main が外す・段 7）   // 分類コードの属性名は style の申告（無ければ 0＝分類なし）
			}
		}
	}
	return { labels: out, codepoints, font: M1_FONT };
}
