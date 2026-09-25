// 外来の MapLibre style.json を、このエンジンの基図 style（build.js / labels.js が食べる形）へ読み替える（#33・2026-09-23）。
// エンジンの基図はもともと MapLibre の style の部分集合（fill / line / symbol の点ラベル / background・式）で動いている。
// ここで足すのは「外で書かれた style」に普通に出てくる古い書き方を、評価器（expr.js）が読む現代の式へ直すことだけ：
//   ① 旧式フィルタ（["==", "class", "x"]・["in", "class", …]・["has", k]・"$type"・"$id"・"none"）→ 式
//   ② 旧式の関数（{ stops, base, property, type, default }）→ interpolate / step / match / get
//   ③ 文字の差し込み記法（"{name}"・"{name:latin}"）→ concat
// 読み替えは純関数（worker にも main にも置ける）。取得（fetch）は loadMapLibreStyle に分けた。
//
// 描けない物（このエンジンの基図の外）＝fill-extrusion・raster・hillshade・circle・heatmap・線に沿うラベル・アイコン。
// それらは基図に入れず、呼び手（globe）が「画像層」「利用者の層」へ振り分けるか、捨てて数える（splitMapLibreStyle の戻り値）。

// ── ① 旧式フィルタ ───────────────────────────────────────────────
// MapLibre の isExpressionFilter と同じ判定（両方の書き方が混ざった style もある）
export function isExpressionFilter(f) {
	if (f === true || f === false) return true;
	if (!Array.isArray(f) || f.length === 0) return false;
	switch (f[0]) {
		case "has": return f.length >= 2 && f[1] !== "$id" && f[1] !== "$type";
		case "in": return f.length >= 3 && (typeof f[1] !== "string" || Array.isArray(f[2]));
		case "!in": case "!has": case "none": return false;
		case "==": case "!=": case ">": case ">=": case "<": case "<=": return f.length !== 3 || Array.isArray(f[1]) || Array.isArray(f[2]);
		case "any": case "all": for (const c of f.slice(1)) if (!isExpressionFilter(c) && typeof c !== "boolean") return false; return true;
		default: return true;
	}
}
const getter = k => k === "$type" ? ["geometry-type"] : k === "$id" ? ["id"] : ["get", k];
const lit = v => Array.isArray(v) ? ["literal", v] : v;
function legacyFilter(f) {
	if (!Array.isArray(f) || !f.length) return true;
	const [op, k, ...vs] = f;
	switch (op) {
		case "all": return ["all", ...f.slice(1).map(legacyFilter)];
		case "any": return ["any", ...f.slice(1).map(legacyFilter)];
		case "none": return ["!", ["any", ...f.slice(1).map(legacyFilter)]];
		case "has": return k === "$type" ? true : k === "$id" ? ["!=", ["id"], null] : ["has", k];
		case "!has": return ["!", legacyFilter(["has", k])];
		case "in": return vs.length ? ["any", ...vs.map(v => ["==", getter(k), v])] : false;
		case "!in": return ["!", legacyFilter(["in", k, ...vs])];
		case "==": case "!=": case ">": case ">=": case "<": case "<=": {
			const g = getter(k), v = vs[0];
			if (op === "==" && k === "$type") return ["==", g, v];
			if (op === "==" || op === "!=") return [op, g, v];
			return ["all", ["!=", g, null], [op, g, v]];   // 旧式の大小比較は属性が無い地物を落とす
		}
		default: return f;
	}
}
export function convertFilter(f) {
	if (f == null) return undefined;
	return isExpressionFilter(f) ? f : legacyFilter(f);
}

// ── ② 旧式の関数 ─────────────────────────────────────────────────
const isFunction = v => v && typeof v === "object" && !Array.isArray(v) && (Array.isArray(v.stops) || v.type === "identity");
const isColorish = v => typeof v === "string" && /^(#|rgb|hsl)|^[a-z]+$/i.test(v.trim());
function convertFunction(fn, prop) {
	let stops = fn.stops || [];
	if (stops.length && stops[0][0] && typeof stops[0][0] === "object") {   // zoom-and-property＝最初のズームの段だけ（近似）
		const z0 = stops[0][0].zoom;
		return convertFunction({ ...fn, stops: stops.filter(s => s[0].zoom === z0).map(s => [s[0].value, s[1]]) }, prop);
	}
	// 既定の type＝補間できる値（数・色・数の配列）なら exponential、それ以外は interval（MapLibre の仕様どおり）
	const interp = stops.length > 0 && stops.every(s => typeof s[1] === "number" || isColorish(s[1]) || (Array.isArray(s[1]) && s[1].every(n => typeof n === "number")))
		&& !/(pattern|image|field|font|anchor|justify|transform|placement|cap|join|visibility|align|mode)$/.test(prop);
	const type = fn.type || (interp ? "exponential" : "interval");
	const lit = v => (prop === "text-field" || prop === "icon-image") && typeof v === "string" ? convertTokens(v) : Array.isArray(v) ? ["literal", v] : v;   // 段の値にも "{name}" 記法
	const input = fn.property == null ? ["zoom"] : ["get", fn.property];
	if (type === "identity") return fn.default !== undefined ? ["coalesce", ["get", fn.property], lit(fn.default)] : ["get", fn.property];
	if (!stops.length) return lit(fn.default);
	if (type === "categorical") {
		const out = ["match", input];
		for (const [k, v] of stops) out.push(k, lit(v));
		out.push(fn.default !== undefined ? lit(fn.default) : null);
		return out;
	}
	if (type === "interval") {
		const out = ["step", input, lit(stops[0][1])];
		for (let i = 1; i < stops.length; i++) out.push(stops[i][0], lit(stops[i][1]));
		return out;
	}
	if (stops.length === 1) return lit(stops[0][1]);
	const out = ["interpolate", (fn.base ?? 1) === 1 ? ["linear"] : ["exponential", fn.base], input];
	for (const [k, v] of stops) out.push(k, lit(v));
	return out;
}

// ── ③ 文字の差し込み記法 ─────────────────────────────────────────
function convertTokens(s) {
	if (typeof s !== "string" || !/\{[^{}]+\}/.test(s)) return s;
	const parts = [], re = /\{([^{}]+)\}/g;
	let last = 0, m;
	while ((m = re.exec(s))) {
		if (m.index > last) parts.push(s.slice(last, m.index));
		parts.push(["to-string", ["coalesce", ["get", m[1]], ""]]);
		last = re.lastIndex;
	}
	if (last < s.length) parts.push(s.slice(last));
	return parts.length === 1 ? parts[0] : ["concat", ...parts];
}

// 値一つを式へ（関数・差し込み記法・文字列から始まる配列リテラル）
export function convertValue(v, prop = "") {
	if (isFunction(v)) return convertFunction(v, prop);
	if ((prop === "text-field" || prop === "icon-image") && typeof v === "string") return convertTokens(v);
	// 文字列の配列リテラル（フォント名・アンカー名）は式と見分けがつかない＝literal に包む。line-dasharray は数の配列＝そのままで
	// リテラル、先頭が文字列なら式（step/interpolate/literal）＝包むと式が「中身の配列」として読まれ線ごと消えた（2026-09-25）
	if (Array.isArray(v) && v.length && typeof v[0] === "string" && (prop === "text-font" || prop === "text-variable-anchor")) return ["literal", v];
	return v;
}

// 層一つを読み替え（元は壊さない）
export function convertLayer(L) {
	const out = { ...L };
	if (L.filter != null) out.filter = convertFilter(L.filter);
	for (const k of ["paint", "layout"]) if (L[k]) { out[k] = {}; for (const [p, v] of Object.entries(L[k])) out[k][p] = convertValue(v, p); }
	// MapLibre の line-dasharray は線幅の倍数。内蔵 style（style-gsi/mono）は px（タイル基準ズームの見かけ）＝build.js へ単位を申告する
	if (out.paint?.["line-dasharray"] != null) out.dashInLineWidths = true;
	return out;
}

// ── ズームの読み替え ─────────────────────────────────────────────
// このエンジンの z は 256px 世界（z が同じなら MapLibre より 1 段寄った縮尺＝MapLibre の z＋1 と同じ見た目）。
// 外来 style のズーム（["zoom"]・minzoom・maxzoom）は MapLibre の z で書かれている＝dz だけずらして同じ縮尺で同じ見た目にする。
const shiftExpr = (e, dz) => {
	if (!Array.isArray(e)) return e;
	if (e.length === 1 && e[0] === "zoom") return ["-", ["zoom"], dz];
	if (e[0] === "literal") return e;
	return e.map(x => shiftExpr(x, dz));
};
export function shiftLayerZoom(L, dz) {
	if (!dz) return L;
	const out = { ...L };
	if (L.minzoom != null) out.minzoom = L.minzoom + dz;
	if (L.maxzoom != null) out.maxzoom = L.maxzoom + dz;
	if (L.filter != null) out.filter = shiftExpr(L.filter, dz);
	for (const k of ["paint", "layout"]) if (L[k]) { out[k] = {}; for (const [p, v] of Object.entries(L[k])) out[k][p] = shiftExpr(v, dz); }
	return out;
}

// ── 振り分け ─────────────────────────────────────────────────────
// style を「基図に入る層（ひとつのベクタ source）」と「それ以外」へ分ける。
// 戻り＝{ vectorSource: id|null, base: 基図の層（読み替え済み・background を含む）, raster: 画像の層, geojson: 利用者の層, skipped: [{ id, type, why }] }
const BASE_TYPES = new Set(["fill", "line", "symbol", "background"]);
// zoomOffset＝このエンジンの z と style の z の差（既定 1＝上の「ズームの読み替え」）。基図と画像層の層に掛ける（geojson の層は addLayer 側の決まりに任せる）
export function splitMapLibreStyle(style, { zoomOffset = 1 } = {}) {
	const sources = style.sources || {};
	const vecIds = Object.keys(sources).filter(k => sources[k]?.type === "vector");
	// 基図＝層を一番多く持つベクタ source（style は普通 1 本）
	const count = id => (style.layers || []).filter(L => L.source === id).length;
	const vectorSource = vecIds.sort((a, b) => count(b) - count(a))[0] ?? null;
	const base = [], raster = [], geojson = [], skipped = [];
	for (const L0 of style.layers || []) {
		const L1 = convertLayer(L0), sp = sources[L1.source];
		if (sp?.type === "geojson" || sp?.type === "image") { geojson.push(L1); continue; }
		const L = shiftLayerZoom(L1, zoomOffset);
		if (L.type === "background") { base.push(L); continue; }
		if (sp?.type === "raster") { raster.push(L); continue; }
		if (L.source !== vectorSource) { skipped.push({ id: L.id, type: L.type, why: sp ? `source "${L.source}" (${sp.type}) is not the basemap` : `source "${L.source}" missing` }); continue; }
		if (!BASE_TYPES.has(L.type)) { skipped.push({ id: L.id, type: L.type, why: "not drawn in the basemap" }); continue; }
		if (L.type === "symbol" && (L.layout?.["symbol-placement"] ?? "point") !== "point") { skipped.push({ id: L.id, type: L.type, why: "line labels" }); continue; }
		if (L.type === "fill" && L.paint?.["fill-pattern"] != null) { skipped.push({ id: L.id, type: L.type, why: "fill-pattern" }); continue; }
		base.push(L);
	}
	return { vectorSource, base, raster, geojson, skipped };
}

// ── 取得 ─────────────────────────────────────────────────────────
// style（URL か object）を取り、相対 URL（sprite・tiles・TileJSON）を style の置き場から解決して返す。
// 戻り＝{ style, baseUrl }。mapbox:// など取れない書き方は投げる。
export async function loadMapLibreStyle(src, { fetchFn = fetch } = {}) {
	let style = src, baseUrl = typeof location !== "undefined" ? location.href : undefined;
	if (typeof src === "string") {
		if (/^mapbox:/.test(src)) throw new Error("mapbox:// styles need a Mapbox access token (not supported)");
		baseUrl = new URL(src, baseUrl).href;
		const r = await fetchFn(baseUrl, { credentials: "omit" });
		if (!r.ok) throw new Error(`style HTTP ${r.status}`);
		style = await r.json();
	}
	if (!style || !Array.isArray(style.layers)) throw new Error("not a MapLibre style (no layers)");
	return { style, baseUrl };
}
// ベクタ source の実体（タイルの URL 型紙・ズーム範囲・範囲・出典）。url が TileJSON なら取りに行く・pmtiles:// はそのまま
export async function resolveVectorSource(sp, baseUrl, { fetchFn = fetch } = {}) {
	const abs = u => /^pmtiles:\/\//.test(u) ? "pmtiles://" + new URL(u.slice(10), baseUrl).href : /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, baseUrl).href;
	if (sp.url && /^pmtiles:\/\//.test(sp.url)) return { pmtiles: abs(sp.url), minzoom: sp.minzoom, maxzoom: sp.maxzoom, attribution: sp.attribution ?? null };
	let tj = sp;
	if (!sp.tiles && sp.url) {
		if (/^mapbox:/.test(sp.url)) throw new Error("mapbox:// sources need a Mapbox access token (not supported)");
		const u = abs(sp.url), r = await fetchFn(u, { credentials: "omit" });
		if (!r.ok) throw new Error(`TileJSON HTTP ${r.status}`);
		tj = { ...(await r.json()), ...Object.fromEntries(Object.entries(sp).filter(([k]) => k !== "url")) };
		baseUrl = u;
	}
	if (!tj.tiles?.length) throw new Error("vector source has no tiles");
	return { tiles: tj.tiles.map(t => /^[a-z][\w+.-]*:/i.test(t) ? t : new URL(t, baseUrl).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}")),
		scheme: tj.scheme || "xyz", minzoom: tj.minzoom ?? 0, maxzoom: tj.maxzoom ?? 14, bounds: tj.bounds ?? null, attribution: tj.attribution ?? null };   // tiles：スキーム付き（https・pmtiles・addProtocol の独自スキーム）はそのまま＝{z} を符号化しない
}
// タイルの URL 型紙 → (z,x,y)=>URL（{z}{x}{y}・{s}（a/b/c）・scheme:"tms"＝y 反転・{ratio}/{prefix} は外す）
export function tileUrlOf(src) {
	if (src.pmtiles) return () => src.pmtiles;
	const tpl = src.tiles;
	let i = 0;
	return (z, x, y) => {
		const t = tpl[(i++) % tpl.length];
		const yy = src.scheme === "tms" ? (1 << z) - 1 - y : y;
		return t.replace("{z}", z).replace("{x}", x).replace("{y}", yy).replace("{s}", "abc"[(x + y) % 3]).replace("{ratio}", "").replace("{prefix}", ((x % 16).toString(16) + (y % 16).toString(16)));
	};
}
