// paint 表の (b) 類（vt perf plan §5「(b) 類の段取り」・2026-10-22）：地物に依る色・不透明度を、焼いた頂点の色でなく表の行から読む。
// 行の鍵＝層の式が読む属性の組（評価した値でなく入力）＝同じ組の地物は同じ行。同じ属性を読む新しい式は行を評価し直すだけで済む（段 2）。
// 形（統合ロードマップのスレッドと合意）：語は足さない。表を読む列では色の語（線＝語 4・塗り＝頂点の 3 語目）が行番号（下位 16bit）。描く列ごとに旗 pt。
// tile worker（build.ts）＝タイルの中の行（rows＝鍵の組）と地物ごとの行（rid）を op に添える・焼いた色（col）も残す（表を読めない描き手の分）。
// scene worker＝md の常駐の時に層 id＋鍵の名＋組 → 通しの行（全層で 1 枚の表）に付け替える。描き手（GL2）＝行の組を属性に戻し、main から配られた層の式で評価して表に書く。
// 対象：外来の層（eo）の塗りと線で、色か不透明度（か線の線幅＝段 2b）の式が地物に依り（kind が data）、色・不透明度は zoom・feature-state・global-state・カメラ・描く所の値を読まず、
// 属性を名前で読むだけ（get／has の名前が文字列・geometry-type）。properties・id を読む式は行が地物の数になる＝焼くまま（zoom×data も焼くまま＝裁定）。
import { evalExpr, exprDeps } from "./expr.ts";
import { parseRGBA } from "./color.ts";
import type { ExprContext, ExprOrigin } from "./expr.ts";

/** 鍵の中の geometry-type（属性の名と混ざらない名） */
export const PT_GEOM = "\u0000type";
/** 行の上限（色の語の下位 16bit） */
export const PT_MAX_ROWS = 65536;
/** 表の 1 行の texel 数（0＝RGBA・1＝線の半幅（x・段 2b）） */
export const PT_TEXELS = 2;
/** シェーダで描く破線の模様の数の上限（build.ts の DASH_GPU_MAX はこれ）＝これを超える z がある層の線幅は CPU で刻む片の長さ＝表に置かない */
export const DASH_GPU_MAX = 8;

// 式が読む属性の名（鍵）を集める。名前で読めない読み方（properties・id・名前が式の get 等）は null
function readKeys(e: unknown, out: Set<string>): boolean {
	if (e && typeof e === "object" && !Array.isArray(e)) { for (const x of Object.values(e)) if (!readKeys(x, out)) return false; return true; }
	if (!Array.isArray(e) || typeof e[0] !== "string") return true;
	const op = e[0];
	switch (op) {
		case "literal": return true;
		case "properties": case "id": case "feature-state": case "within": case "distance": return false;
		case "geometry-type": out.add(PT_GEOM); return true;
		case "get": case "has":
			if (e.length === 2) { if (typeof e[1] !== "string") return false; out.add(e[1]); return true; }
			break;   // 3 引数＝物から読む（地物でない）＝中を見る
	}
	for (let i = 1; i < e.length; i++) if (!readKeys(e[i], out)) return false;
	return true;
}

/** 表を読む層の式（鍵の名・色・不透明度・線幅＝w がある層は線の半幅も表から＝段 2b） */
export interface PtLayer { keys: string[]; c: unknown; a?: unknown; w?: unknown; o: ExprOrigin }

const plain = (d: ReturnType<typeof exprDeps>): boolean => !(d.state || d.global || d.camera || d.vertex);
// 線幅を表に置けるか（段 2b）：地物に依り（kind data）、属性を名前で読むだけで、焼いた線幅が絵の形を決めない（line-gap-width＝両脇のずらし・CPU で刻む破線の片の長さ）。
// 破線はずらさない層で、どの z でも模様が DASH_GPU_MAX 個まで（build.ts の gpuDash＝シェーダが線幅で模様を当てる）
function widthTable(P: Record<string, unknown>, eo: ExprOrigin, keys: Set<string>): boolean {
	const w = P["line-width"];
	if (w == null || P["line-gap-width"] != null) return false;
	const d = exprDeps(w);
	if (d.kind !== "data" || !plain(d)) return false;
	const dash = P["line-dasharray"];
	if (dash != null) {
		if (P["line-offset"] != null && P["line-offset"] !== 0) return false;
		for (let z = 0; z <= 24; z++) { const v = evalExpr(dash, { zoom: z, props: {}, geom: null, vars: {}, origin: eo }); if (Array.isArray(v) && v.length > DASH_GPU_MAX) return false; }
	}
	const k = new Set<string>();
	if (!readKeys(w, k)) return false;
	for (const x of k) keys.add(x);
	return true;
}

/** 層 → (b) 類なら鍵と式・でなければ null。type＝"fill"｜"line"・eo＝式の出自（外来の層だけ）。線幅は地物に依って表に置ける時だけ w（それ以外の線幅は今まで通り焼く／pz） */
export function layerPaintTable(type: string, paint: Record<string, unknown> | null | undefined, eo: ExprOrigin): PtLayer | null {
	if (!eo || (type !== "fill" && type !== "line")) return null;
	const P = paint || {}, c = P[type === "fill" ? "fill-color" : "line-color"] ?? "#000", a = P[type === "fill" ? "fill-opacity" : "line-opacity"];
	let data = false;
	for (const e of [c, a]) {
		if (e == null) continue;
		const d = exprDeps(e);
		if (d.kind === "zoom" || d.kind === "zoom×data" || !plain(d)) return null;
		if (d.kind === "data") data = true;
	}
	const keys = new Set<string>(), w = type === "line" && widthTable(P, eo, keys);
	if (!data && !w) return null;
	if (!readKeys(c, keys) || (a != null && !readKeys(a, keys))) return null;
	return { keys: [...keys].sort(), c, ...(a != null ? { a } : {}), ...(w ? { w: P["line-width"] } : {}), o: eo };
}

/** 地物の鍵の組（無い属性は null・MVT の属性は null を持たない） */
export function ptTuple(keys: readonly string[], props: Record<string, unknown> | null | undefined, geomType: unknown): unknown[] {
	const t = new Array(keys.length);
	for (let i = 0; i < keys.length; i++) { const k = keys[i]; t[i] = k === PT_GEOM ? geomType : props?.[k] ?? null; }
	return t;
}

/** 組 → 鍵の文字列（1 つの鍵は値そのもの＝Map の鍵で文字列と数が混ざらない） */
export const ptKeyOf = (t: readonly unknown[]): unknown => t.length === 1 ? t[0] : JSON.stringify(t);

const b255 = (v: number): number => v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;   // build.ts と同じ量子化
/** 行の色（RGBA 0〜1・焼いた色と同じ量子化＝絵は bit 同値）。keys・t＝行の鍵と組 */
export function ptRowColor(L: PtLayer, keys: readonly string[], t: readonly unknown[], out: Float32Array | number[], o = 0): void {
	const props: Record<string, unknown> = {};
	let geom: unknown = null;
	for (let i = 0; i < keys.length; i++) { if (keys[i] === PT_GEOM) geom = t[i]; else if (t[i] != null) props[keys[i]] = t[i]; }
	const ctx: ExprContext = { zoom: 0, props, geom: geom as ExprContext["geom"], vars: {}, origin: L.o };
	const c = parseRGBA(evalExpr(L.c, ctx)), ov = L.a != null ? evalExpr(L.a, ctx) : 1, a = c[3] * ((ov === undefined && L.o ? 1 : ov) as number);   // ML の評価エラー＝既定 1（build.ts と同じ）
	out[o] = b255(c[0]) / 255; out[o + 1] = b255(c[1]) / 255; out[o + 2] = b255(c[2]) / 255; out[o + 3] = b255(a) / 255;
}

/** 行の線の半幅（px・焼いた半幅と同じ＝数でないは 1 の半分・0 以下は 0＝描かない・f32）。L.w がある層だけ（外来の層） */
export function ptRowHalf(L: PtLayer, keys: readonly string[], t: readonly unknown[]): number {
	const props: Record<string, unknown> = {};
	let geom: unknown = null;
	for (let i = 0; i < keys.length; i++) { if (keys[i] === PT_GEOM) geom = t[i]; else if (t[i] != null) props[keys[i]] = t[i]; }
	const w = evalExpr(L.w, { zoom: 0, props, geom: geom as ExprContext["geom"], vars: {}, origin: L.o });
	return Math.fround((typeof w !== "number" || isNaN(w) ? 1 : w <= 0 ? 0 : w) * 0.5);   // build.ts の線と同じ
}

// setPaintProperty の (b) 類（段 2・2026-10-22・GL2 の md）：変えた性質が塗りと線の色・不透明度で、前も後も (b) 類、後の式が読む属性が前の鍵に含まれる
// （作ったタイルの行の組が後の式を評価するのに足りる）なら組み直さない＝描き手が行を後の式で評価し直す（main の api/style.ts・renderer の ptOver）。
// 戻り＝後の層の式（速い道で足りる）｜null（組み直す）。行が PT_MAX_ROWS を超えて焼いた色で常駐したタイルの列は変わらない（実在の style では起きない数）
// 線幅（段 2b）は前も後も表に置ける時だけ（作ったタイルの描く列が表の半幅を読む旗を持つ）。表に置ける線幅を持つかは前と後で同じ（線幅を変えない変更では式が同じ）
const PT_KEYS = new Set(["fill-color", "fill-opacity", "line-color", "line-opacity", "line-width"]);
export function paintTableFast(type: string, prev: Record<string, unknown> | null | undefined, next: Record<string, unknown> | null | undefined, key: string, eo: ExprOrigin): PtLayer | null {
	if (!PT_KEYS.has(key) || !key.startsWith(type + "-")) return null;
	const a = layerPaintTable(type, prev, eo), b = layerPaintTable(type, next, eo);
	if (!a || !b || (a.w != null) !== (b.w != null) || (key === "line-width" && b.w == null)) return null;   // 表に置かない線幅は焼いた値（隙間つき等）＝組み直す
	return ptCovers(b, a.keys) ? b : null;
}
/** 行の鍵（keys）で後の式（L）を評価できる＝L が読む属性が全部ある */
export const ptCovers = (L: PtLayer, keys: readonly string[]): boolean => L.keys.every(k => keys.includes(k));
