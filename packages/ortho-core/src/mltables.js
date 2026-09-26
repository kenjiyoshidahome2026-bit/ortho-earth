// MapLibre 形の fill / line / circle の層 → gint の地物ごとの表（2026-09-26・MapLibre 互換の台帳 maplibre-compat.md 段 4・約束 4/6）。
// ネイティブの buildFidStyle（gl/gint/style.js＝map.paint・addGint の意味）は触らない＝MapLibre の意味はここで組む。純関数＝node で検定。
//
// 詰め方（packMLLayers）：同じ source で MapLibre の重ね順に連続する層だけを 1 枚の gint 層（pass）へ詰める。
//   1 枚の gint 層は下から 塗り → 線 → 点 の順に描く＝層の型の順（fill < line < circle）を崩さない間だけ同じ pass に入れる。
//   同じ型がもう一度来たら（縁取りの線 2 本・同じ source のハイライト層）・順が戻ったら（line の上に fill）新しい pass。
//   fill-outline-color を持つ fill は線の欄も使う（輪郭 1px）。
// 表（buildMLTable）：地物ごとに、その pass の層を「層の filter・zoom 域・ジオメトリの型」で当てて欄を埋める。
//   塗り＝面だけ・線＝線と面の輪郭・点＝点だけ（MapLibre の層の型の約束）。当たらない欄は描かない（塗り α0・線幅 0・半径 0）。
//   ⚠線/点の色の α0 はエンジンでは「既定色」＝消す時は必ず幅/半径 0（台帳 R16）。値は MapLibre の既定（黒・線 1px・点 5px・不透明度 1）。
//   式は MapLibre の出自（ctx.origin "ml"）で評価＝評価エラーはその性質の既定値。
// 表のレコード（buildFidStyle と同じ・gint draw spec §7.1）：R＝塗り RGBA8／G＝線または点の色 RGBA8／B＝線幅 u8(1/8px)<<24 | dash<<16 | 半径 u8(1/4px)<<8 | flags／A＝0
import { evalExpr, truthy } from "./expr.js";
import { parseRGBA } from "./color.js";

// MapLibre の feature の id を焼く前に地物へ写す隠しの属性（globe の ML アダプタ・段 6）：ML_ID＝id（Feature.id／promoteId／並び順）・ML_IX＝元の並び（同じ属性の地物を 1 つの fid に束ねさせない）
export const ML_ID_KEY = "ortho:mlid", ML_IX_KEY = "ortho:mlix";
export const ML_DEFAULTS = {
	"fill-color": "#000000", "fill-opacity": 1,
	"line-color": "#000000", "line-width": 1, "line-opacity": 1,
	"circle-color": "#000000", "circle-radius": 5, "circle-opacity": 1,
};
const RANK = { fill: 0, line: 1, circle: 2 };
const hasOutline = L => L.type === "fill" && L.paint?.["fill-outline-color"] != null;

// 層の列（同じ source・MapLibre の重ね順で連続・正規化済み＝エンジンの目盛り）→ pass の列
export function packMLLayers(layers) {
	const passes = [];
	let cur = null, last = -1;
	for (const L of layers) {
		const r = RANK[L.type];
		if (r == null) continue;
		const lo = hasOutline(L) ? RANK.line : r;   // 輪郭つきの fill は線の欄まで使う
		if (!cur || r <= last || (r === RANK.line && cur.outline)) { cur = { layers: [], fill: null, line: null, circle: null, outline: false }; passes.push(cur); last = -1; }
		cur.layers.push(L);
		cur[L.type] = L;
		if (hasOutline(L)) cur.outline = true;
		last = lo;
	}
	return passes;
}

const inZoom = (L, z) => (L.minzoom == null || z >= L.minzoom) && (L.maxzoom == null || z < L.maxzoom);   // MapLibre＝minzoom 包含・maxzoom 排他
const kindOf = t => t === "Point" || t === "MultiPoint" ? "pt" : t === "LineString" || t === "MultiLineString" ? "ln" : t === "Polygon" || t === "MultiPolygon" ? "pg" : null;
const clampU8 = v => Math.max(0, Math.min(255, Math.round(v)));
function packColor(c, opacity) {
	const a = Math.round(Math.max(0, Math.min(1, (c[3] ?? 1) * opacity)) * 255);
	if (a === 0) return 0;
	const u = x => Math.round(Math.max(0, Math.min(1, x)) * 255);
	return ((u(c[0]) << 24) | (u(c[1]) << 16) | (u(c[2]) << 8) | a) >>> 0;
}
// 性質の値（評価エラー・欠損＝MapLibre の既定値）
function prop(L, key, ctx) {
	const e = L.paint?.[key];
	if (e == null) return ML_DEFAULTS[key];
	const v = evalExpr(e, ctx);
	return v == null || (typeof v === "number" && Number.isNaN(v)) ? ML_DEFAULTS[key] : v;
}
const num = (L, key, ctx) => { const v = +prop(L, key, ctx); return Number.isFinite(v) ? v : ML_DEFAULTS[key]; };
const color = (L, key, ctx) => { const v = prop(L, key, ctx); return parseRGBA(typeof v === "string" || Array.isArray(v) ? v : ML_DEFAULTS[key]); };

// 1 つの pass の表。features＝fid 整列（geopbf の fid と同じ並び）。opts＝{ zoom, states: Map<fid, state> }
// 戻り＝{ u32, count, drawn: { [layerId]: Uint8Array（その層がその地物を描くか＝queryRenderedFeatures の層ごとの当たり） }, active: 今の zoom で効いている層の id }
export function buildMLTable(pass, features = [], { zoom = 0, states = null } = {}) {
	const count = features.length, u32 = new Uint32Array(count * 4), drawn = {};
	const act = pass.layers.filter(L => inZoom(L, zoom) && L.layout?.visibility !== "none");   // 隠した層は詰め方に残して表で効かせない（出し入れで焼き直さない）
	for (const L of pass.layers) drawn[L.id] = new Uint8Array(count);
	const F = act.includes(pass.fill) ? pass.fill : null, Ln = act.includes(pass.line) ? pass.line : null, C = act.includes(pass.circle) ? pass.circle : null;
	for (let fid = 0; fid < count; fid++) {
		const f = features[fid], gt = f?.geometry?.type ?? "", k = kindOf(gt);
		const ctx = { zoom, props: f?.properties ?? {}, geom: gt, vars: {}, state: states?.get(fid), origin: "ml", id: f?.properties?.[ML_ID_KEY] ?? fid };   // ["id"]＝MapLibre の id
		const pass_ = L => L && (L.filter == null || truthy(evalExpr(L.filter, ctx)));
		let fill = 0, line = 0, w8 = 0, r8 = 0;
		if (F && k === "pg" && pass_(F)) {
			fill = packColor(color(F, "fill-color", ctx), num(F, "fill-opacity", ctx));
			if (pass.outline) {   // 輪郭＝fill-outline-color・1px・不透明度は塗りと同じ
				const ov = evalExpr(F.paint["fill-outline-color"], ctx);
				const oc = packColor(parseRGBA(typeof ov === "string" || Array.isArray(ov) ? ov : "#000000"), num(F, "fill-opacity", ctx));
				if (oc) { line = oc; w8 = 8; }
			}
			if (fill || w8) drawn[F.id][fid] = 1;
		}
		if (Ln && (k === "ln" || k === "pg") && pass_(Ln)) {
			const c = packColor(color(Ln, "line-color", ctx), num(Ln, "line-opacity", ctx)), w = num(Ln, "line-width", ctx);
			if (c && w > 0) { line = c; w8 = Math.max(1, clampU8(w * 8)); drawn[Ln.id][fid] = 1; }
		}
		if (C && k === "pt" && pass_(C)) {
			const c = packColor(color(C, "circle-color", ctx), num(C, "circle-opacity", ctx)), r = num(C, "circle-radius", ctx);
			if (c && r > 0) { line = c; r8 = Math.max(1, clampU8(r * 4)); drawn[C.id][fid] = 1; }
		}
		const vis = fill || w8 || r8 ? 1 : 0;   // 何も描かない地物は隠す（照会・ホバーにも出ない）
		const j = fid * 4;
		u32[j] = fill; u32[j + 1] = line; u32[j + 2] = ((w8 << 24) | (0 << 16) | (r8 << 8) | vis) >>> 0; u32[j + 3] = 0;
	}
	return { u32, count, drawn, active: act.map(L => L.id) };
}

// その pass の表が zoom で変わるか（settle で作り直す判断）：層の zoom 域の境か、式に ["zoom"] がある
export function zoomSensitivity(pass) {
	const bounds = new Set();
	let expr = false;
	for (const L of pass.layers) {
		if (L.minzoom != null) bounds.add(L.minzoom);
		if (L.maxzoom != null) bounds.add(L.maxzoom);
		if (JSON.stringify([L.filter ?? null, L.paint ?? null]).includes('["zoom"')) expr = true;
	}
	return { bounds: [...bounds].sort((a, b) => a - b), expr };
}
