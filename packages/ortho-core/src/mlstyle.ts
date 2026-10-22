// 外来の MapLibre style.json を、このエンジンの基図 style（build.js / labels.js が食べる形）へ読み替える（#33・2026-09-23）。
// エンジンの基図はもともと MapLibre の style の部分集合（fill / line / symbol の点ラベル / background・式）で動いている。
// ここで足すのは「外で書かれた style」に普通に出てくる古い書き方を、評価器（expr.js）が読む現代の式へ直すことだけ：
//   ① 旧式フィルタ（["==", "class", "x"]・["in", "class", …]・["has", k]・"$type"・"$id"・"none"）→ 式
//   ② 旧式の関数（{ stops, base, property, type, default }）→ interpolate / step / match / get
//   ③ 文字の差し込み記法（"{name}"・"{name:latin}"）→ concat
// 読み替えは純関数（worker にも main にも置ける）。取得（fetch）は loadMapLibreStyle に分けた。
//
// 描けない物（このエンジンの基図の外）＝fill-extrusion・raster・hillshade・color-relief・circle・heatmap（線に沿うラベルは段 4・アイコンは段 3 から基図で描く）。
// それらは基図に入れず、呼び手（globe）が「画像層」「利用者の層」へ振り分けるか、捨てて数える（splitMapLibreStyle の戻り値）。

import { ORIGIN_KEY, unknownOps } from "./expr.ts";
import { ML_LAYER_PROPS, ML_SOURCE_TYPES, ML_LAYER_KEYS } from "./mlspec.ts";

/** MapLibre 形の層（読み替えの入出力・他の欄は素通り） */
export interface MLLayer { id: string; type: string; source?: string; "source-layer"?: string; filter?: unknown; layout?: Record<string, unknown>; paint?: Record<string, unknown>; minzoom?: number; maxzoom?: number; metadata?: Record<string, unknown>; dashInLineWidths?: boolean; [k: string]: unknown }
/** MapLibre 形の source（vector・raster・raster-dem・geojson・image・video） */
export interface MLSource { type?: string; url?: string; tiles?: string[]; scheme?: string; minzoom?: number; maxzoom?: number; bounds?: number[] | null; attribution?: string | null; encoding?: string; tileSize?: number | null; [k: string]: unknown }
/** MapLibre の style.json */
export interface MLStyle { sources?: Record<string, MLSource>; layers?: MLLayer[]; [k: string]: unknown }
/** 旧式の関数（{ stops, base, property, type, default }） */
interface LegacyFunction { stops?: unknown[][]; base?: number; property?: string; type?: string; default?: unknown }
// ── ① 旧式フィルタ ───────────────────────────────────────────────
// MapLibre の isExpressionFilter と同じ判定（両方の書き方が混ざった style もある）
export function isExpressionFilter(f: unknown): boolean {
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
const getter = (k: unknown): unknown[] => k === "$type" ? ["geometry-type"] : k === "$id" ? ["id"] : ["get", k];
const lit = (v: unknown): unknown => Array.isArray(v) ? ["literal", v] : v;
function legacyFilter(f: unknown): unknown {
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
export function convertFilter(f: unknown): unknown {
	if (f == null) return undefined;
	return isExpressionFilter(f) ? f : legacyFilter(f);
}

// ── ② 旧式の関数 ─────────────────────────────────────────────────
const isFunction = (v: unknown): v is LegacyFunction => !!v && typeof v === "object" && !Array.isArray(v) && (Array.isArray((v as LegacyFunction).stops) || (v as LegacyFunction).type === "identity");
const isColorish = (v: unknown): boolean => typeof v === "string" && /^(#|rgb|hsl)|^[a-z]+$/i.test(v.trim());
function convertFunction(fn: LegacyFunction, prop: string): unknown {
	let stops = fn.stops || [];
	if (stops.length && stops[0][0] && typeof stops[0][0] === "object") {   // zoom-and-property＝最初のズームの段だけ（近似）
		const z0 = (stops[0][0] as { zoom?: unknown }).zoom;
		return convertFunction({ ...fn, stops: stops.filter(s => (s[0] as { zoom?: unknown }).zoom === z0).map(s => [(s[0] as { value?: unknown }).value, s[1]]) }, prop);
	}
	// 既定の type＝補間できる値（数・色・数の配列）なら exponential、それ以外は interval（MapLibre の仕様どおり）
	const interp = stops.length > 0 && stops.every(s => typeof s[1] === "number" || isColorish(s[1]) || (Array.isArray(s[1]) && s[1].every(n => typeof n === "number")))
		&& !/(pattern|image|field|font|anchor|justify|transform|placement|cap|join|visibility|align|mode)$/.test(prop);
	const type = fn.type || (interp ? "exponential" : "interval");
	const lit = (v: unknown): unknown => (prop === "text-field" || prop === "icon-image") && typeof v === "string" ? convertTokens(v) : Array.isArray(v) ? ["literal", v] : v;   // 段の値にも "{name}" 記法
	const input = fn.property == null ? ["zoom"] : ["get", fn.property];
	// 属性の関数の default＝属性が無い地物の値（MapLibre・台帳 R19）。無ければ評価エラー＝性質の既定値（ML の出自で評価）
	const withDefault = (e: unknown): unknown => fn.property != null && fn.default !== undefined ? ["case", ["has", fn.property], e, lit(fn.default)] : e;
	if (type === "identity") return fn.default !== undefined ? ["coalesce", ["get", fn.property], lit(fn.default)] : ["get", fn.property];
	if (!stops.length) return lit(fn.default);
	if (type === "categorical") {
		const out: unknown[] = ["match", input];
		for (const [k, v] of stops) out.push(k, lit(v));
		out.push(fn.default !== undefined ? lit(fn.default) : null);
		return out;
	}
	if (type === "interval") {
		const out: unknown[] = ["step", input, lit(stops[0][1])];
		for (let i = 1; i < stops.length; i++) out.push(stops[i][0], lit(stops[i][1]));
		return withDefault(out);
	}
	if (stops.length === 1) return withDefault(lit(stops[0][1]));
	const out: unknown[] = ["interpolate", (fn.base ?? 1) === 1 ? ["linear"] : ["exponential", fn.base], input];
	for (const [k, v] of stops) out.push(k, lit(v));
	return withDefault(out);
}

// ── ③ 文字の差し込み記法 ─────────────────────────────────────────
function convertTokens(s: unknown): unknown {
	if (typeof s !== "string" || !/\{[^{}]+\}/.test(s)) return s;
	const parts: unknown[] = [], re = /\{([^{}]+)\}/g;
	let last = 0, m: RegExpExecArray | null;
	while ((m = re.exec(s))) {
		if (m.index > last) parts.push(s.slice(last, m.index));
		parts.push(["to-string", ["coalesce", ["get", m[1]], ""]]);
		last = re.lastIndex;
	}
	if (last < s.length) parts.push(s.slice(last));
	return parts.length === 1 ? parts[0] : ["concat", ...parts];
}

const ANCHORS = new Set(["center", "left", "right", "top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"]);
const KNOWN_OPS_FOR_LITERAL = new Set(["literal", "get", "has", "case", "match", "step", "interpolate", "let", "var", "to-color", "rgb", "rgba", "hsl", "hsla", "concat", "coalesce", "zoom"]);   // 色の名前と見分ける（式の頭になり得る語）
const isAnchorOffsets = (v: unknown): boolean => Array.isArray(v) && v.length >= 2 && v.length % 2 === 0 && v.every((x, i) => i % 2 === 0 ? ANCHORS.has(x) : Array.isArray(x) && x.length === 2 && x.every(Number.isFinite));
// 値一つを式へ（関数・差し込み記法・文字列から始まる配列リテラル）
export function convertValue(v: unknown, prop = ""): unknown {
	if (isFunction(v)) return convertFunction(v, prop);
	if ((prop === "text-field" || prop === "icon-image") && typeof v === "string") return convertTokens(v);
	// 文字列の配列リテラル（フォント名・アンカー名）は式と見分けがつかない＝literal に包む。line-dasharray は数の配列＝そのままで
	// リテラル、先頭が文字列なら式（step/interpolate/literal）＝包むと式が「中身の配列」として読まれ線ごと消えた（2026-09-25）
	if (Array.isArray(v) && v.length && typeof v[0] === "string" && (prop === "text-font" || prop === "text-variable-anchor")) return ["literal", v];
	// text-writing-mode のリテラル＝["horizontal"]・["vertical", "horizontal"]（向きの名前の並び）。式と読み違えて「知らない演算子 horizontal」で層を落としていた（地理院 optimal_bvmap の注記 7 層・実在 style の集計 2026-10-22）
	if (prop === "text-writing-mode" && Array.isArray(v) && v.length && v.every(x => x === "horizontal" || x === "vertical")) return ["literal", v];
	// text-variable-anchor-offset のリテラル＝["top", [0, 1], "bottom", [0, -1]]（アンカー名と 2 数の組の並び）。式（match/step…）と読み違えて「知らない演算子 top」で層を落としていた（公式例の門 2 巡目）
	if (prop === "text-variable-anchor-offset" && isAnchorOffsets(v)) return ["literal", v];
	// hillshade の multidirectional＝色・向きの配列（["#FF4000", "#FFFF00", …]・[270, 315, 0, 45]）＝式ではない（先頭が色の文字列＝「知らない演算子 #FF4000」で層を落としていた）
	if (/^hillshade-/.test(prop) && Array.isArray(v) && v.length && v.every(x => typeof x === "number" || (typeof x === "string" && /^(#|rgb|hsl|[a-z]+$)/i.test(x) && !KNOWN_OPS_FOR_LITERAL.has(x)))) return ["literal", v];
	return v;
}

// 層一つを読み替え（元は壊さない）
export function convertLayer(L: MLLayer): MLLayer {
	const out: MLLayer = { ...L };
	if (L.filter != null) out.filter = convertFilter(L.filter);
	for (const k of ["paint", "layout"] as const) if (L[k]) { const o: Record<string, unknown> = {}; out[k] = o; for (const [p, v] of Object.entries(L[k])) o[p] = convertValue(v, p); }
	// MapLibre の line-dasharray は線幅の倍数。内蔵 style（style-gsi/mono）は px（タイル基準ズームの見かけ）＝build.js へ単位を申告する
	if (out.paint?.["line-dasharray"] != null) out.dashInLineWidths = true;
	return out;
}

// ── ズームの読み替え ─────────────────────────────────────────────
// このエンジンの z は 256px 世界（z が同じなら MapLibre より 1 段寄った縮尺＝MapLibre の z＋1 と同じ見た目）。
// 外来 style のズーム（["zoom"]・minzoom・maxzoom）は MapLibre の z で書かれている＝dz だけずらして同じ縮尺で同じ見た目にする。
// dz＝「その層の数が書かれた目盛り」−「エンジンの目盛り」（MapLibre の z で書かれた層＝1・エンジンの z＝0）。
// ["zoom"] は ["-", ["zoom"], dz] に置き換え、既に ["-", ["zoom"], k] の形なら k に畳む（二度ずらしても入れ子が育たない・0 なら ["zoom"] へ戻す）。
export function shiftZoomExpr<T>(e: T, dz: number): T {
	if (!Array.isArray(e) || !dz) return e;
	if (e.length === 1 && e[0] === "zoom") return ["-", ["zoom"], dz] as T;
	if (e.length === 3 && e[0] === "-" && Array.isArray(e[1]) && e[1].length === 1 && e[1][0] === "zoom" && typeof e[2] === "number") {
		const k = e[2] + dz;
		return (k === 0 ? ["zoom"] : ["-", ["zoom"], k]) as T;
	}
	if (e[0] === "literal") return e;
	return e.map(x => shiftZoomExpr(x, dz)) as T;
}
export function shiftLayerZoom(L: MLLayer, dz: number): MLLayer {
	if (!dz) return L;
	const out: MLLayer = { ...L };
	if (L.minzoom != null) out.minzoom = L.minzoom + dz;
	if (L.maxzoom != null) out.maxzoom = L.maxzoom + dz;
	if (L.filter != null) out.filter = shiftZoomExpr(L.filter, dz);
	for (const k of ["paint", "layout"] as const) if (L[k]) { const o: Record<string, unknown> = {}; out[k] = o; for (const [p, v] of Object.entries(L[k])) o[p] = shiftZoomExpr(v, dz); }
	return out;
}

// ── MapLibre 形の層の入口（2026-09-26・互換の台帳 maplibre-compat.md の約束 5）────────────────
// style.json・addLayer・setPaintProperty…・ML 形 gadget の層 object は全部ここを通る＝経路ごとの読み替えを作らない。
// 層の目盛りは metadata["ortho:dz"] で申告できる（getStyle が付けて返す＝setStyle(getStyle()) で二重にずれない）。無ければ入口の既定 dz。
// 出力は「エンジンの目盛りに直した層」＝metadata["ortho:dz"] を 0 にして返す＝もう一度通しても何も変わらない（冪等）。
export const DZ_KEY = "ortho:dz";
export function layerDzOf(L: MLLayer | null | undefined, dflt = 0): number {
	const v = L?.metadata?.[DZ_KEY];
	return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
export function normalizeMLLayer(L: MLLayer, dz = 0): MLLayer {
	const out = shiftLayerZoom(convertLayer(L), layerDzOf(L, dz));
	return { ...out, metadata: { ...(L.metadata || {}), [DZ_KEY]: 0, [ORIGIN_KEY]: "ml" } };   // 出自の印＝評価器が MapLibre の意味で評価する（expr.js・約束 4）
}
// 目盛りの付け替え（fromDz の目盛りで書かれた値 → toDz の目盛り）。setter/getter が呼び手と層の目盛りの差を埋めるのに使う
export const rescaleZoomExpr = <T>(e: T, fromDz: number, toDz: number): T => shiftZoomExpr(e, fromDz - toDz);
// 層の式の検査（旧書式を読み替えた後の filter・paint・layout）＝知らない演算子の名前の配列（空＝よし）。MapLibre は addLayer で投げて層を足さない
export function mlUnknownOps(L: MLLayer): string[] {
	const C = convertLayer(L), out = new Set<string>();
	unknownOps(C.filter, out);
	for (const k of ["paint", "layout"] as const) for (const v of Object.values(C[k] || {})) unknownOps(v, out);
	return [...out];
}
export const rescaleZoomNum = (x: number | null | undefined, fromDz: number, toDz: number): number | null | undefined => x == null ? x : x + fromDz - toDz;

// ── 振り分け ─────────────────────────────────────────────────────
// style を「基図に入る層（ひとつのベクタ source）」と「それ以外」へ分ける。
// 戻り＝{ vectorSource: id|null, base: 基図の層（読み替え済み・background を含む）, raster: 画像の層, geojson: 利用者の層, skipped: [{ id, type, why }] }
const BASE_TYPES = new Set(["fill", "line", "symbol", "background"]);
export interface SkippedLayer { id: string; type: string; why: string }
export interface SplitStyle { vectorSource: string | null; base: MLLayer[]; raster: MLLayer[]; geojson: MLLayer[]; skipped: SkippedLayer[] }
// zoomOffset＝このエンジンの z と style の z の差（既定 1＝上の「ズームの読み替え」）。基図と画像層の層は normalizeMLLayer で換算済みにして返す。
// geojson の層は読み替えずに返す＝受け手（globe の利用者の層）が dz＝layerDzOf(L, zoomOffset) を層に登録し、描き出す時に 1 回だけ normalizeMLLayer
export function splitMapLibreStyle(style: MLStyle, { zoomOffset = 1 }: { zoomOffset?: number } = {}): SplitStyle {
	const sources = style.sources || {};
	const vecIds = Object.keys(sources).filter(k => sources[k]?.type === "vector");
	// 基図＝層を一番多く持つベクタ source（style は普通 1 本）
	const count = (id: string): number => (style.layers || []).filter(L => L.source === id).length;
	const vectorSource = vecIds.sort((a, b) => count(b) - count(a))[0] ?? null;
	const base: MLLayer[] = [], raster: MLLayer[] = [], geojson: MLLayer[] = [], skipped: SkippedLayer[] = [];
	for (const L0 of style.layers || []) {
		const sp = sources[L0.source as string];
		// geojson / image / video の層＝利用者の層の口へ「そのまま」渡す（読み替えと目盛りの換算は受け手が normalizeMLLayer で 1 回＝dz は受け手が layerDzOf(L, zoomOffset) で決める）
		if (sp?.type === "geojson" || sp?.type === "image" || sp?.type === "video") { geojson.push(L0); continue; }   // video＝四隅の動画（#49）も利用者の層の口へ
		if ((L0.type === "hillshade" || L0.type === "color-relief") && sp?.type === "raster-dem") { geojson.push(L0); continue; }   // hillshade・color-relief（#114）＝利用者の層の口（globe が raster-dem から画像タイルを作る・公式例の門 3 巡目）
		const bad = mlUnknownOps(L0);
		if (bad.length) { skipped.push({ id: L0.id, type: L0.type, why: `unknown expression operator ${bad.map(o => `"${o}"`).join(", ")}` }); continue; }   // MapLibre は層を足さない
		const L = normalizeMLLayer(L0, zoomOffset);
		if (L.type === "background") { base.push(L); continue; }
		if (sp?.type === "raster") { raster.push(L); continue; }
		if (L.source !== vectorSource) { skipped.push({ id: L.id, type: L.type, why: sp ? `source "${L.source}" (${sp.type}) is not the basemap` : `source "${L.source}" missing` }); continue; }
		if (!BASE_TYPES.has(L.type)) { skipped.push({ id: L.id, type: L.type, why: "not drawn in the basemap" }); continue; }
		// 線に沿う注記（symbol-placement line/line-center）も基図へ（段 4・旧＝"line labels" として描かない層）
		base.push(L);
	}
	return { vectorSource, base, raster, geojson, skipped };
}

// ── 入口の検査（互換の計画 P0-5・2026-10-22）────────────────────────────
// MapLibre は style の検査で誤りを error 事象にして style を読まない。ここは読んだ上で「何が spec の外か」を返すだけ（呼び手が警告に出す）。
// 見る物＝source の型・層の id の重複・層の型・source の有無・layout／paint の名前（型ごと・置き場の取り違え）・層の鍵。
// root の知らない鍵は見ない（MapLibre の検査も root は '*' で通す）。名前の表は spec の写し（mlspec.ts・scripts/mlspec-gen.mjs）。canvas source は JS の口だけの型（spec の外だが MapLibre が受ける）
export interface StyleIssue { layer?: string; message: string }
export function validateMLStyle(style: MLStyle): StyleIssue[] {
	const out: StyleIssue[] = [], sources = style.sources || {}, seen = new Set<string>();
	for (const [id, sp] of Object.entries(sources)) if (!sp || (!ML_SOURCE_TYPES.includes(sp.type as string) && sp.type !== "canvas")) out.push({ message: `source "${id}": unknown type "${sp?.type}"` });
	for (const L of style.layers || []) {
		const id = L?.id, spec = ML_LAYER_PROPS[L?.type];
		if (typeof id !== "string") { out.push({ message: "layer without an id" }); continue; }
		if (seen.has(id)) out.push({ layer: id, message: "duplicate layer id" });
		seen.add(id);
		if (!spec) { out.push({ layer: id, message: `unknown layer type "${L.type}"` }); continue; }
		if (L.type !== "background" && !L.source) out.push({ layer: id, message: "missing source" });
		else if (L.source && !(L.source in sources)) out.push({ layer: id, message: `source "${L.source}" not found` });
		for (const k of Object.keys(L)) if (!ML_LAYER_KEYS.includes(k)) out.push({ layer: id, message: `unknown layer property "${k}"` });
		for (const part of ["layout", "paint"] as const) for (const k of Object.keys(L[part] || {})) {
			if (spec[part].includes(k)) continue;
			const other = part === "layout" ? "paint" : "layout";
			out.push({ layer: id, message: spec[other].includes(k) ? `"${k}" is a ${other} property, not ${part}` : `unknown ${part} property "${k}" for ${L.type}` });
		}
	}
	return out;
}

// ── 取得 ─────────────────────────────────────────────────────────
// style（URL か object）を取り、相対 URL（sprite・tiles・TileJSON）を style の置き場から解決して返す。
// 戻り＝{ style, baseUrl }。mapbox:// など取れない書き方は投げる。
export interface FetchOptions { fetchFn?: typeof fetch }
export async function loadMapLibreStyle(src: string | MLStyle, { fetchFn = fetch }: FetchOptions = {}): Promise<{ style: MLStyle; baseUrl: string | undefined }> {
	let style = src as MLStyle, baseUrl: string | undefined = typeof location !== "undefined" ? location.href : undefined;
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
/** TileJSON の vector_layers の 1 件（素の形） */
export interface VectorLayerInfo { id: string; fields: Record<string, string>; minzoom?: number; maxzoom?: number; description?: string }
// TileJSON の vector_layers（層の一覧＝id・fields・minzoom・maxzoom・description）を素の形へ（検査表示 #174 の層の台帳が読む）。
// 外のデータ＝id が文字列でない物は捨て、fields は「名前→説明の文字列」だけ写す。無い・配列でない＝null（呼び手がタイルを解いて集める）
export function vectorLayersOf(tj: unknown): VectorLayerInfo[] | null {
	const vl = (tj as { vector_layers?: unknown } | null | undefined)?.vector_layers;
	if (!Array.isArray(vl)) return null;
	return vl.filter(l => l && typeof l.id === "string" && l.id).map((l): VectorLayerInfo => ({
		id: l.id,
		fields: l.fields && typeof l.fields === "object" && !Array.isArray(l.fields) ? Object.fromEntries(Object.entries(l.fields as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : String(v ?? "")])) : {},
		...(Number.isFinite(l.minzoom) ? { minzoom: l.minzoom } : {}), ...(Number.isFinite(l.maxzoom) ? { maxzoom: l.maxzoom } : {}),
		...(typeof l.description === "string" && l.description ? { description: l.description } : {}),
	}));
}
/** resolveVectorSource の戻り＝タイルの URL 型紙（pmtiles か tiles）と申告 */
export interface ResolvedVectorSource { pmtiles?: string; tiles?: string[]; scheme?: string; minzoom?: number; maxzoom?: number; bounds?: number[] | null; attribution?: string | null; encoding?: string; vectorLayers?: VectorLayerInfo[] | null; demEncoding?: string | null; tileSize?: number | null }
// ベクタ source の実体（タイルの URL 型紙・ズーム範囲・範囲・出典・形式・層の一覧）。url が TileJSON なら取りに行く・pmtiles:// はそのまま。
// encoding＝タイルの形式（MapLibre の vector source と同じ語＝"mvt"（既定）｜"mlt"・#88）。PMTiles はアーカイブのヘッダ（tileType）が決めるので申告は参考まで。
// vectorLayers＝TileJSON の vector_layers（vectorLayersOf・無ければ null）。PMTiles はアーカイブの metadata が持つ＝pmtilesInfo の vectorLayers
export async function resolveVectorSource(sp: MLSource, baseUrl: string | undefined, { fetchFn = fetch }: FetchOptions = {}): Promise<ResolvedVectorSource> {
	const abs = (u: string): string => /^pmtiles:\/\//.test(u) ? "pmtiles://" + new URL(u.slice(10), baseUrl).href : /^[a-z][\w+.-]*:/i.test(u) ? u : new URL(u, baseUrl).href;
	if (sp.url && /^pmtiles:\/\//.test(sp.url)) return { pmtiles: abs(sp.url), minzoom: sp.minzoom, maxzoom: sp.maxzoom, attribution: sp.attribution ?? null, encoding: sp.encoding || "mvt", vectorLayers: vectorLayersOf(sp) };
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
		scheme: tj.scheme || "xyz", minzoom: tj.minzoom ?? 0, maxzoom: tj.maxzoom ?? 22, bounds: tj.bounds ?? null, attribution: tj.attribution ?? null, encoding: tj.encoding || "mvt", vectorLayers: vectorLayersOf(tj),
		demEncoding: tj.encoding ?? null, tileSize: tj.tileSize ?? null };   // demEncoding/tileSize＝raster-dem 用の申告そのまま（無ければ null＝呼び手の既定・source の指定が TileJSON に勝つ＝MapLibre の load_tilejson と同じ・2026-09-30）   // maxzoom の既定＝MapLibre と同じ 22（2026-09-26・旧 14）   // tiles：スキーム付き（https・pmtiles・addProtocol の独自スキーム）はそのまま＝{z} を符号化しない
}
// タイルの URL 型紙 → (z,x,y)=>URL（{z}{x}{y}・{s}（a/b/c）・scheme:"tms"＝y 反転・{ratio}/{prefix} は外す）
export function tileUrlOf(src: { pmtiles?: string | null; tiles?: string[]; scheme?: string }): (z: number, x: number, y: number) => string {
	if (src.pmtiles) return () => src.pmtiles!;
	const tpl = src.tiles!;
	return (z, x, y) => {
		const t = tpl[(x + y) % tpl.length];   // 型紙が複数＝MapLibre の tile_id url() と同じ選び方（同じタイルはいつも同じ URL＝HTTP キャッシュが効く・2026-09-30・旧＝呼んだ順に回す）
		const yy = src.scheme === "tms" ? (1 << z) - 1 - y : y;
		let u = t.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(yy)).replace("{s}", "abc"[(x + y) % 3]).replace("{ratio}", "").replace("{prefix}", ((x % 16).toString(16) + (y % 16).toString(16)));
		if (u.includes("{quadkey}")) { let q = ""; for (let i = z - 1; i >= 0; i--) q += ((y >> i & 1) << 1 | (x >> i & 1)); u = u.split("{quadkey}").join(q || "0"); }   // MapLibre の記法（2026-09-26）
		return u;
	};
}
