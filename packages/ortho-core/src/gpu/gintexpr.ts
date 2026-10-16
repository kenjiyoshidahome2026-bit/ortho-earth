// gint の paint/filter 式 → WGSL compute（geopbf 改良点 ⑦・2026-10-12）── fid 表（gint/style.js buildFidStyle）を GPU で組む。
// 入力＝属性列（gint/attrcols.js：鍵ごとの vec2u 列・辞書・geometry-type 列）、出力＝fid ごとの vec4u レコード（R fill RGBA8・G line RGBA8・
// B width<<24|radius<<8|flags・A 0）＝buildFidStyle と同じ並び。意味論はネイティブ出自（expr.js の寛容な JS 流儀）を写す：
//   値 V{t,p}: t 0 undefined・1 number（p＝f32 ビット）・2 string（p＝辞書 id）・3 boolean・4 null・5 NaN（number だが NaN）・6 補間で出来た色文字列（p＝slot）・7 NaN の色文字列
//   数への強制（単項 +／比較／算術）＝JS の ToNumber：undefined→NaN・null→0・bool→0/1・string→Number(s)（辞書ごとに CPU で引いた表 dnum）
//   色＝string→parseRGBA（辞書ごとに CPU で引いた表 dcol）・number/bool→黒・undefined/null→色なし（既定値のまま）
// 載せない物（compile が { error } を返す＝呼び手は CPU の buildFidStyle へ）: MapLibre 出自（origin "ml"）、文字列どうしの大小比較、文字列を足す "+"、
// 配列・オブジェクトの値、get/has の 2 引数形、let/var 以外の動的な鍵、f32 で表せない整数リテラル（|x| > 2^24）、未対応の演算子。
// 数は f32（JS は f64）＝.5 の丸めの境で ±1/255 の差が出うる（検定は ±1 の許容）。
import { paintKeys } from "../gint/attrcols.ts";
import type { Dict, Kinds } from "../gint/attrcols.ts";
export type { Kinds as ColumnKinds, ExprKeys, AttrFeature as FeatureLike } from "../gint/attrcols.ts";   // @ortho-earth/core/fidexpr の型の名（旧 types/fidexpr.d.ts）
export { Dict, paintKeys, buildPropColumns, buildStateColumns, buildGeomColumn, encodeStateRow } from "../gint/attrcols.ts";   // 呼び手（globe の層）が列を組む道具も同じ入口から
import { parseRGBA } from "../color.ts";

const T_NAN = 5, T_LERP = 6;
class Unsupported extends Error {}
const no: (m: string) => never = m => { throw new Unsupported(m); };
const f32bits = (() => { const f = new Float32Array(1), u = new Uint32Array(f.buffer); return (v: number): number => { f[0] = v; return u[0]; }; })();
/** 式の演算子の形 [op, ...引数]。 */
type OpExpr = [string, ...unknown[]];
const isOp = (e: unknown): e is OpExpr => Array.isArray(e) && typeof e[0] === "string";
const ALL = new Set(["num", "str", "bool", "null", "undef"]);
const hexU = (u: number): string => "0x" + (u >>> 0).toString(16) + "u";
const fstr = (x: number): string => { const s = String(x); return /[.e]/i.test(s) || /inf|nan/i.test(s) ? s : s + ".0"; };   // WGSL の f32 リテラル

// 辞書の表（gpu/gint.js が上げる）: dnum＝Number(s) の f32 ビットと NaN 旗、dcol＝parseRGBA(s)
export function dictTables(dict: Dict): { dnum: Uint32Array; dcol: Float32Array } {
	const n = dict.size, dnum = new Uint32Array(n * 2), dcol = new Float32Array(n * 4);
	for (let i = 0; i < n; i++) {
		const s = dict.list[i], x = Number(s);
		dnum[i * 2] = Number.isNaN(x) ? 0 : f32bits(x); dnum[i * 2 + 1] = Number.isNaN(x) ? 1 : 0;
		const c = parseRGBA(s); dcol[i * 4] = c[0]; dcol[i * 4 + 1] = c[1]; dcol[i * 4 + 2] = c[2]; dcol[i * 4 + 3] = c[3];
	}
	return { dnum, dcol };
}

const HELPERS = /* wgsl */`
struct Uni { count: u32, zoom: f32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var<storage, read> props: array<vec2u>;
@group(0) @binding(2) var<storage, read> states: array<vec2u>;
@group(0) @binding(3) var<storage, read> geom: array<u32>;
@group(0) @binding(4) var<storage, read> dnum: array<vec2u>;
@group(0) @binding(5) var<storage, read> dcol: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> outR: array<vec4u>;
struct V { t: u32, p: u32 };
struct N { x: f32, nan: bool };
struct C { ok: bool, c: vec4f, nan: bool };   // nan＝入れ子の補間が NaN で作った色文字列（JS の "rgba(NaN,…)"＝詰めると 0）
fn P(ki: u32, fid: u32) -> V { let c = props[ki * U.count + fid]; return V(c.x, c.y); }
fn S(ki: u32, fid: u32) -> V { let c = states[ki * U.count + fid]; return V(c.x, c.y); }
fn vnum(v: V) -> N {
	switch (v.t) {
		case 1u: { return N(bitcast<f32>(v.p), false); }
		case 2u: { let d = dnum[v.p]; return N(bitcast<f32>(d.x), d.y != 0u); }
		case 3u: { return N(f32(v.p), false); }
		case 4u: { return N(0.0, false); }
		default: { return N(0.0, true); }
	}
}
fn mkn(n: N) -> V { if (n.nan) { return V(5u, 0u); } return V(1u, bitcast<u32>(n.x)); }
fn vb(b: bool) -> V { return V(3u, u32(b)); }
fn vtruthy(v: V) -> bool {
	switch (v.t) {
		case 1u: { return bitcast<f32>(v.p) != 0.0; }
		case 2u, 3u: { return v.p != 0u; }
		case 6u, 7u: { return true; }
		default: { return false; }
	}
}
fn veq(a: V, b: V) -> bool {
	if (a.t != b.t) { return false; }
	if (a.t == 1u) { return bitcast<f32>(a.p) == bitcast<f32>(b.p); }
	if (a.t == 0u || a.t == 4u) { return true; }
	if (a.t == 5u) { return false; }
	return a.p == b.p;
}
fn vlt(a: V, b: V) -> bool { let x = vnum(a); let y = vnum(b); return !x.nan && !y.nan && x.x < y.x; }
fn vle(a: V, b: V) -> bool { let x = vnum(a); let y = vnum(b); return !x.nan && !y.nan && x.x <= y.x; }
fn nnull(v: V) -> bool { return v.t != 0u && v.t != 4u; }
const BIG: f32 = bitcast<f32>(0x7f7fffffu);   // JS の ±Infinity の代わり（f32 の最大値＝閾値の比較では無限と同じに振る舞い・finite() は偽）
fn finite(n: N) -> bool { return !n.nan && abs(n.x) < BIG; }
fn isinf_(x: f32) -> bool { return abs(x) >= BIG; }
fn infs(neg: bool) -> N { return N(select(BIG, -BIG, neg), false); }
// 算術＝JS の ±Infinity の規則を BIG で写す（inf+(-inf)=NaN・inf*0=NaN・inf/inf=NaN・x/inf=0）。NaN は伝播
fn nadd(a: N, b: N) -> N { if (a.nan || b.nan) { return N(0.0, true); } if (isinf_(a.x) || isinf_(b.x)) { if (isinf_(a.x) && isinf_(b.x) && (a.x < 0.0) != (b.x < 0.0)) { return N(0.0, true); } return infs(select(a.x, b.x, isinf_(b.x)) < 0.0); } return N(a.x + b.x, false); }
fn nsub(a: N, b: N) -> N { return nadd(a, N(-b.x, b.nan)); }
fn nmul(a: N, b: N) -> N { if (a.nan || b.nan) { return N(0.0, true); } if (isinf_(a.x) || isinf_(b.x)) { if (a.x == 0.0 || b.x == 0.0) { return N(0.0, true); } return infs((a.x < 0.0) != (b.x < 0.0)); } return N(a.x * b.x, false); }
fn ndiv(a: N, b: N) -> N { if (a.nan || b.nan) { return N(0.0, true); } if (isinf_(a.x) && isinf_(b.x)) { return N(0.0, true); } if (isinf_(b.x)) { return N(select(0.0, -0.0, (a.x < 0.0) != (b.x < 0.0)), false); } if (b.x == 0.0) { if (a.x == 0.0) { return N(0.0, true); } return infs((a.x < 0.0) != ((bitcast<u32>(b.x) & 0x80000000u) != 0u)); } if (isinf_(a.x)) { return infs((a.x < 0.0) != (b.x < 0.0)); } return N(a.x / b.x, false); }   // 0 で割る＝JS は ±Infinity（-0 の符号も効く＝interpolate/step の端へ寄る）
fn nmod(a: N, b: N) -> N { if (b.x == 0.0 || a.nan || b.nan || isinf_(a.x)) { return N(0.0, true); } if (isinf_(b.x)) { return a; } return N(a.x % b.x, false); }
fn npow(a: N, b: N) -> N { if (a.nan || b.nan) { return N(0.0, true); } if (b.x == 0.0) { return N(1.0, false); } if (isinf_(a.x) || isinf_(b.x)) { if (abs(a.x) == 1.0) { return N(0.0, true); } let big = select(abs(a.x) > 1.0, isinf_(a.x), isinf_(a.x)) == (b.x > 0.0); if (!big) { return N(0.0, false); } let neg = a.x < 0.0 && isinf_(a.x) && !isinf_(b.x) && (i32(b.x) & 1) != 0; return infs(neg); } if (a.x < 0.0) { let i = round(b.x); if (i != b.x) { return N(0.0, true); } let m = pow(-a.x, b.x); return N(select(m, -m, (i32(i) & 1) != 0), false); } return N(pow(a.x, b.x), false); }
fn nabs(a: N) -> N { return N(abs(a.x), a.nan); }
fn nfloor(a: N) -> N { return N(floor(a.x), a.nan); }
fn nceil(a: N) -> N { return N(ceil(a.x), a.nan); }
fn nround(a: N) -> N { return N(floor(a.x + 0.5), a.nan); }
fn nsqrt(a: N) -> N { if (a.nan || a.x < 0.0) { return N(0.0, true); } if (isinf_(a.x)) { return a; } return N(sqrt(a.x), false); }
fn vcol(v: V) -> C {
	switch (v.t) {
		case 2u: { return C(true, dcol[v.p], false); }
		case 6u: { return C(true, cols[v.p], false); }
		case 7u: { return C(true, vec4f(0.0), true); }
		case 0u, 4u: { return C(false, vec4f(0.0), false); }
		default: { return C(true, vec4f(0.0, 0.0, 0.0, 1.0), false); }
	}
}
fn clamp01(x: f32) -> f32 { return clamp(x, 0.0, 1.0); }
fn r255(x: f32) -> u32 { return u32(floor(clamp01(x) * 255.0 + 0.5)); }
fn packColor(C_: C, op: f32) -> u32 { if (C_.nan) { return 0u; } let c = C_.c; let a = r255(c.w * op); if (a == 0u) { return 0u; } return (r255(c.x) << 24u) | (r255(c.y) << 16u) | (r255(c.z) << 8u) | a; }
fn u8(x: f32) -> u32 { return u32(clamp(floor(x + 0.5), 0.0, 255.0)); }
fn lerpT(input: f32, x0: f32, x1: f32, base: f32) -> f32 { let t = (input - x0) / (x1 - x0); if (base != 1.0) { return (pow(base, input - x0) - 1.0) / (pow(base, x1 - x0) - 1.0); } return t; }
fn lerpV(a: V, b: V, t: f32, tnan: bool, slot: u32) -> V {
	let an = a.t == 1u || a.t == 5u; let bn = b.t == 1u || b.t == 5u;
	if (an && bn) { if (tnan || a.t == 5u || b.t == 5u) { return V(5u, 0u); } let y0 = N(bitcast<f32>(a.p), false); let y1 = N(bitcast<f32>(b.p), false); return mkn(nadd(y0, nmul(N(t, false), nsub(y1, y0)))); }   // ±Infinity の停留も JS と同じ（inf の算術の規則）
	let as_ = a.t == 2u || a.t == 6u; let bs = b.t == 2u || b.t == 6u;
	if (as_ && bs) {
		if (tnan) { return V(7u, 0u); }
		let p = vcol(a).c; let q = vcol(b).c; let c = p + t * (q - p);
		cols[slot] = vec4f(floor(c.x * 255.0 + 0.5) / 255.0, floor(c.y * 255.0 + 0.5) / 255.0, floor(c.z * 255.0 + 0.5) / 255.0, floor(c.w * 10000.0 + 0.5) / 10000.0);
		return V(6u, slot);
	}
	if (!tnan && t < 0.5) { return a; }
	return b;
}
`;

// paint/filter → WGSL。opts: { propKeys, stateKeys, kinds（Map 鍵→attrcols の統計）, dict, origin }
// 戻り値 { wgsl, slots, propKeys, stateKeys, usesZoom, usesState, filterUsesState, filterUsesZoom, usesGeom } か { error }
/** compileFidStyleWGSL の戻り（載せられた時）。 */
export interface FidStyleWGSL { wgsl: string; slots: number; propKeys: string[]; stateKeys: string[]; usesZoom: boolean; usesState: boolean; filterUsesState: boolean; filterUsesZoom: boolean; usesGeom: boolean }
export interface FidStyleWGSLOptions { propKeys?: string[]; stateKeys?: string[]; kinds?: Map<string, Kinds>; dict?: Dict; origin?: "ml" | "native" }
/** let の束縛（名前 → { v＝WGSL の変数名, ty＝静的な型集合 }）。ty だけの段（型を引く時）は v を持たない。 */
type Env = Map<unknown, { v?: string; ty: Set<string> }>;
export function compileFidStyleWGSL(paint: Record<string, unknown> = {}, filter: unknown = null, opts: FidStyleWGSLOptions = {}): FidStyleWGSL | { error: string } {
	try {
		if (opts.origin === "ml") no("origin ml");
		const dict = opts.dict!, kinds = opts.kinds ?? new Map<string, Kinds>();
		const keys = paintKeys(paint, filter);
		if (keys.dyn) no("dynamic key");
		const propKeys = opts.propKeys ?? [...keys.props], stateKeys = opts.stateKeys ?? [...keys.states];
		for (const k of keys.props) if (!propKeys.includes(k)) no("missing column " + k);
		for (const k of keys.states) if (!stateKeys.includes(k)) no("missing state column " + k);
		for (const k of propKeys) { const K = kinds.get(k); if (K?.other) no("non-scalar column " + k); }
		const st: string[] = [];                       // 文の列
		let nv = 0, slots = 0, usesZoom = false, usesState = false, usesGeom = false, filterUsesState = false, filterUsesZoom = false, inFilter = false;
		const fresh = () => "v" + (nv++);
		const emit = (s: string) => st.push("\t" + s);
		// 静的な型集合（文字列どうしの比較・文字列の足し算を断る為）
		const tyLit = (v: unknown): string => v === undefined ? "undef" : v === null ? "null" : typeof v === "number" ? "num" : typeof v === "boolean" ? "bool" : typeof v === "string" ? "str" : no("literal " + typeof v);
		const tyCol = (k: unknown): Set<string> => { const K = kinds.get(k as string); const s = new Set<string>(); if (!K) return new Set(ALL); if (K.num) s.add("num"); if (K.str) s.add("str"); if (K.bool) s.add("bool"); if (K.nul) s.add("null"); if (K.undef) s.add("undef"); return s; };
		const union = (...xs: Set<string>[]): Set<string> => { const s = new Set<string>(); for (const x of xs) for (const t of x) s.add(t); return s; };
		const ty = (e: unknown, env: Env): Set<string> => {
			if (!isOp(e)) return new Set([tyLit(e)]);
			switch (e[0]) {
				case "literal": return new Set([tyLit(e[1])]);
				case "get": return union(tyCol(e[1]), new Set(["undef"]));
				case "feature-state": return new Set(ALL);
				case "var": return env.get(e[1])?.ty ?? no("var " + e[1]);
				case "min": case "max": return union(...e.slice(1).map(x => ty(x, env)), new Set(["num"]));   // 選んだ値をそのまま返す
				case "zoom": case "+": case "-": case "*": case "/": case "%": case "^": case "to-number":
				case "abs": case "floor": case "ceil": case "round": case "sqrt": return new Set(["num"]);
				case "has": case "!": case "all": case "any": case "==": case "!=": case ">": case ">=": case "<": case "<=": case "in": case "to-boolean": return new Set(["bool"]);
				case "geometry-type": return new Set(["str"]);
				case "coalesce": return union(...e.slice(1).map(x => ty(x, env)), new Set(["null"]));
				case "match": { const o: Set<string>[] = []; for (let i = 3; i < e.length - 1; i += 2) o.push(ty(e[i], env)); o.push(ty(e[e.length - 1], env)); return union(...o); }
				case "case": { const o: Set<string>[] = []; for (let i = 2; i < e.length - 1; i += 2) o.push(ty(e[i], env)); o.push(ty(e[e.length - 1], env)); return union(...o); }
				case "step": { const o = [ty(e[2], env)]; for (let i = 4; i < e.length; i += 2) o.push(ty(e[i], env)); return union(...o); }
				case "interpolate": { const o: Set<string>[] = []; for (let i = 4; i < e.length; i += 2) o.push(ty(e[i], env)); return union(...o); }
				case "let": { const env2 = new Map(env); for (let i = 1; i < e.length - 1; i += 2) env2.set(e[i], { ty: ty(e[i + 1], env2) }); return ty(e[e.length - 1], env2); }
				default: no("op " + e[0]);
			}
		};
		const litV = (v: unknown): string => {
			if (v === undefined) return "V(0u, 0u)";
			if (v === null) return "V(4u, 0u)";
			if (typeof v === "boolean") return `V(3u, ${v ? 1 : 0}u)`;
			if (typeof v === "number") { if (Number.isNaN(v)) return "V(5u, 0u)"; if (Number.isInteger(v) && Math.abs(v) > 16777216) no("integer beyond f32 " + v); return `V(1u, ${hexU(f32bits(v))})`; }
			if (typeof v === "string") return `V(2u, ${dict.intern(v)}u)`;
			return no("literal " + typeof v);
		};
		const numLit = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : no("stop must be a number");
		// 式 → V の変数名（文を積む）。env＝let の束縛（名前 → { v, ty }）
		const gen = (e: unknown, env: Env): string => {
			if (!isOp(e)) { const v = fresh(); emit(`let ${v} = ${litV(e)};`); return v; }
			const op = e[0], v = fresh();
			const sub = (x: unknown) => gen(x, env), nm = (x: unknown) => { const a = sub(x); return `vnum(${a})`; };
			switch (op) {
				case "literal": emit(`let ${v} = ${litV(e[1])};`); return v;
				case "get": { if (e.length !== 2 || typeof e[1] !== "string") no("get form"); emit(`let ${v} = P(${propKeys.indexOf(e[1])}u, fid);`); return v; }
				case "has": { if (e.length !== 2 || typeof e[1] !== "string") no("has form"); emit(`let ${v} = vb(P(${propKeys.indexOf(e[1])}u, fid).t != 0u);`); return v; }
				case "feature-state": { if (typeof e[1] !== "string") no("feature-state form"); usesState = true; if (inFilter) filterUsesState = true; emit(`let ${v} = S(${stateKeys.indexOf(e[1])}u, fid);`); return v; }
				case "zoom": usesZoom = true; if (inFilter) filterUsesZoom = true; emit(`let ${v} = V(1u, bitcast<u32>(U.zoom));`); return v;
				case "geometry-type": usesGeom = true; emit(`let ${v} = V(2u, geom[fid]);`); return v;
				case "var": { const b = env.get(e[1]) ?? no("var " + e[1]); emit(`let ${v} = ${b.v};`); return v; }
				case "let": { const env2 = new Map(env); for (let i = 1; i < e.length - 1; i += 2) { const t = ty(e[i + 1], env2); env2.set(e[i], { v: gen(e[i + 1], env2), ty: t }); } const r = gen(e[e.length - 1], env2); emit(`let ${v} = ${r};`); return v; }
				case "!": emit(`let ${v} = vb(!vtruthy(${sub(e[1])}));`); return v;
				case "to-boolean": emit(`let ${v} = vb(vtruthy(${sub(e[1])}));`); return v;
				case "all": case "any": { const xs = e.slice(1).map(sub); emit(`let ${v} = vb(${xs.length ? xs.map(x => `vtruthy(${x})`).join(op === "all" ? " && " : " || ") : (op === "all")});`); return v; }
				case "==": emit(`let ${v} = vb(veq(${sub(e[1])}, ${sub(e[2])}));`); return v;
				case "!=": emit(`let ${v} = vb(!veq(${sub(e[1])}, ${sub(e[2])}));`); return v;
				case "<": case "<=": case ">": case ">=": {
					if (ty(e[1], env).has("str") && ty(e[2], env).has("str")) no("string ordering");
					const a = sub(e[1]), b = sub(e[2]);
					emit(`let ${v} = vb(${op === "<" ? `vlt(${a}, ${b})` : op === "<=" ? `vle(${a}, ${b})` : op === ">" ? `vlt(${b}, ${a})` : `vle(${b}, ${a})`});`); return v;
				}
				case "in": {
					const hay = isOp(e[2]) ? (e[2][0] === "literal" ? e[2][1] : no("in haystack")) : e[2];
					if (!Array.isArray(hay)) no("in haystack");
					const a = sub(e[1]);
					emit(`let ${v} = vb(${hay.length ? hay.map(x => `veq(${a}, ${litV(x)})`).join(" || ") : "false"});`); return v;
				}
				case "coalesce": {
					const xs = e.slice(1).map(sub);
					emit(`var ${v} = V(4u, 0u);`);
					for (let i = xs.length - 1; i >= 0; i--) emit(`if (nnull(${xs[i]})) { ${v} = ${xs[i]}; }`);
					// 最初に null でない物＝後ろから上書きして最後に残るのが先頭（順に if を逆順で積む）
					return v;
				}
				case "case": {
					const conds: string[] = [], vals: string[] = [];
					for (let i = 1; i < e.length - 1; i += 2) { conds.push(sub(e[i])); vals.push(sub(e[i + 1])); }
					const def = sub(e[e.length - 1]);
					emit(`var ${v} = ${def};`);
					for (let i = conds.length - 1; i >= 0; i--) emit(`if (vtruthy(${conds[i]})) { ${v} = ${vals[i]}; }`);
					return v;
				}
				case "match": {
					const x = sub(e[1]), labs: unknown[] = [], outs: string[] = [];
					for (let i = 2; i < e.length - 1; i += 2) { labs.push(e[i]); outs.push(sub(e[i + 1])); }
					const def = sub(e[e.length - 1]);
					emit(`var ${v} = ${def};`);
					for (let i = labs.length - 1; i >= 0; i--) {
						const L = Array.isArray(labs[i]) ? labs[i] as unknown[] : [labs[i]];
						for (const l of L) if (typeof l !== "number" && typeof l !== "string" && typeof l !== "boolean") no("match label");
						emit(`if (${L.length ? L.map(l => `veq(${x}, ${litV(l)})`).join(" || ") : "false"}) { ${v} = ${outs[i]}; }`);
					}
					return v;
				}
				case "step": {
					const x = nm(e[1]), outs = [sub(e[2])], ths: number[] = [];
					for (let i = 3; i < e.length; i += 2) { ths.push(numLit(e[i])); outs.push(sub(e[i + 1])); }
					const n = fresh(); emit(`let ${n} = ${x};`);
					emit(`var ${v} = ${outs[0]};`);
					for (let i = 0; i < ths.length; i++) emit(`if (!${n}.nan && ${n}.x >= ${fstr(ths[i])}) { ${v} = ${outs[i + 1]}; }`);   // 昇順の閾値＝最後に通った物が勝つ（JS の break と同値）
					return v;
				}
				case "interpolate": {
					const type = e[1]; if (!Array.isArray(type) || !(type[0] === "linear" || type[0] === "exponential")) no("interpolate type");
					const base = type[0] === "exponential" ? numLit(type[1]) : 1;
					const x = nm(e[2]), sk: number[] = [], sv: string[] = [];
					for (let i = 3; i < e.length; i += 2) { sk.push(numLit(e[i])); sv.push(sub(e[i + 1])); }
					const n = sk.length; if (!n) no("interpolate stops");
					const slot = slots++;
					const nn = fresh(); emit(`let ${nn} = ${x};`);
					emit(`var ${v} = ${sv[n - 1]};`);   // input >= 最後／NaN＝k=0 で lerpV に任せる（下で上書き）
					if (n === 1) { emit(`if (${nn}.nan) { ${v} = lerpV(${sv[0]}, ${sv[0]}, 0.0, true, ${slot}u); }`); return v; }
					emit(`if (${nn}.nan) { ${v} = lerpV(${sv[0]}, ${sv[1]}, 0.0, true, ${slot}u); } else if (${nn}.x <= ${fstr(sk[0])}) { ${v} = ${sv[0]}; } else if (${nn}.x < ${fstr(sk[n - 1])}) {`);
					for (let k = 0; k < n - 1; k++) emit(`\t${k ? "else " : ""}if (${nn}.x < ${fstr(sk[k + 1])}) { ${v} = lerpV(${sv[k]}, ${sv[k + 1]}, lerpT(${nn}.x, ${fstr(sk[k])}, ${fstr(sk[k + 1])}, ${fstr(base)}), false, ${slot}u); }`);
					emit(`}`);
					return v;
				}
				case "+": case "*": {
					const xs = e.slice(1); if (op === "+") for (const x of xs) if (ty(x, env).has("str")) no("string +");
					let acc = `N(${op === "+" ? "0.0" : "1.0"}, false)`;
					for (const x of xs) acc = `${op === "+" ? "nadd" : "nmul"}(${acc}, ${nm(x)})`;
					emit(`let ${v} = mkn(${acc});`); return v;
				}
				case "-": { if (e.length === 2) emit(`let ${v} = mkn(nsub(N(0.0, false), ${nm(e[1])}));`); else emit(`let ${v} = mkn(nsub(${nm(e[1])}, ${nm(e[2])}));`); return v; }
				case "/": emit(`let ${v} = mkn(ndiv(${nm(e[1])}, ${nm(e[2])}));`); return v;
				case "%": emit(`let ${v} = mkn(nmod(${nm(e[1])}, ${nm(e[2])}));`); return v;
				case "^": emit(`let ${v} = mkn(npow(${nm(e[1])}, ${nm(e[2])}));`); return v;
				case "min": case "max": {   // JS は選んだ値をそのまま返す（文字列 "7" なら文字列のまま）＝V を保つ。空＝±Infinity（既定値へ・truthy は真）
					const xs = e.slice(1).map(sub), m = fresh(), mv = fresh();
					emit(`var ${m} = N(${op === "min" ? "BIG" : "-BIG"}, false); var ${mv} = V(0u, 0u); var ${mv}p = false;`);
					for (const x of xs) { const t = fresh(); emit(`let ${t} = vnum(${x}); if (!${t}.nan && ${t}.x ${op === "min" ? "<" : ">"} ${m}.x) { ${m} = ${t}; ${mv} = ${x}; ${mv}p = true; }`); }
					emit(`var ${v} = mkn(${m}); if (${mv}p) { ${v} = ${mv}; }`); return v;
				}
				case "to-number": emit(`let ${v} = mkn(${nm(e[1])});`); return v;
				case "abs": case "floor": case "ceil": case "round": case "sqrt": emit(`let ${v} = mkn(n${op}(${nm(e[1])}));`); return v;
				default: no("op " + op);
			}
		};
		// 色の評価（style.js evalColor）：根が interpolate なら色の lerp（丸め無し）、それ以外は V → 色
		const genColor = (e: unknown, env: Env): string => {
			const c = fresh();
			if (isOp(e) && e[0] === "interpolate") {
				const type = e[1]; if (!Array.isArray(type) || !(type[0] === "linear" || type[0] === "exponential")) no("interpolate type");
				const base = type[0] === "exponential" ? numLit(type[1]) : 1;
				const x = `vnum(${gen(e[2], env)})`, sk: number[] = [], sv: string[] = [];
				for (let i = 3; i < e.length; i += 2) { sk.push(numLit(e[i])); sv.push(genColor(e[i + 1], env)); }
				const n = sk.length; if (!n) no("interpolate stops");
				const nn = fresh(); emit(`let ${nn} = ${x};`);
				emit(`var ${c} = C(true, vec4f(0.0), false);`);
				emit(`if (finite(${nn})) {`);
				emit(`\tif (${nn}.x <= ${fstr(sk[0])}) { ${c} = ${sv[0]}; } else if (${nn}.x >= ${fstr(sk[n - 1])}) { ${c} = ${sv[n - 1]}; }`);
				for (let k = 0; k < n - 1; k++) emit(`\telse if (${nn}.x < ${fstr(sk[k + 1])}) { let t = lerpT(${nn}.x, ${fstr(sk[k])}, ${fstr(sk[k + 1])}, ${fstr(base)}); ${c} = C(${sv[k]}.ok && ${sv[k + 1]}.ok, ${sv[k]}.c + t * (${sv[k + 1]}.c - ${sv[k]}.c), ${sv[k]}.nan || ${sv[k + 1]}.nan); }`);
				emit(`}`);
				return c;
			}
			emit(`let ${c} = vcol(${gen(e, env)});`);
			return c;
		};
		const genNum = (e: unknown, dflt: number, env: Env) => { const n = fresh(); emit(`let ${n} = vnum(${gen(e, env)});`); return `select(${fstr(dflt)}, ${n}.x, finite(${n}))`; };
		const env0: Env = new Map();
		if (filter != null) { inFilter = true; const f = gen(filter, env0); inFilter = false; emit(`if (!vtruthy(${f})) { flags = 0u; }`); }
		const pFillC = paint["fill-color"], pFillO = paint["fill-opacity"], pLineC = paint["line-color"], pCircC = paint["circle-color"], pLineO = paint["line-opacity"], pWidth = paint["line-width"], pRadius = paint["circle-radius"];
		if (pFillC != null) { const c = genColor(pFillC, env0); const o = pFillO != null ? genNum(pFillO, 1, env0) : "1.0"; emit(`if (${c}.ok) { fill = packColor(${c}, ${o}); }`); }
		if (pLineC != null || pCircC != null) {
			const o = pLineO != null ? genNum(pLineO, 1, env0) : "1.0";
			const paintG = (e: unknown, cond: string) => { const c = genColor(e, env0); emit(`if (${cond} && ${c}.ok) { line = packColor(${c}, ${o}); }`); };
			if (pLineC != null && pCircC != null) {
				usesGeom = true;
				emit(`let isPt = geom[fid] == ${dict.intern("Point")}u || geom[fid] == ${dict.intern("MultiPoint")}u;`);
				paintG(pCircC, "isPt"); paintG(pLineC, "!isPt");
			} else paintG(pLineC ?? pCircC, "true");
		}
		if (pWidth != null) { const n = fresh(); emit(`let ${n} = vnum(${gen(pWidth, env0)}); if (finite(${n})) { w8 = u8(${n}.x * 8.0); }`); }
		if (pRadius != null) { const n = fresh(); emit(`let ${n} = vnum(${gen(pRadius, env0)}); if (finite(${n})) { r8 = u8(${n}.x * 4.0); }`); }
		const wgsl = `${HELPERS.replace("fn vcol(", `var<private> cols: array<vec4f, ${Math.max(1, slots)}>;\nfn vcol(`)}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) {
	let fid = g.x; if (fid >= U.count) { return; }
	var fill = 0u; var line = 0u; var w8 = 8u; var r8 = 6u; var flags = 1u;
${st.join("\n")}
	outR[fid] = vec4u(fill, line, (w8 << 24u) | (r8 << 8u) | flags, 0u);
}
`;
		return { wgsl, slots, propKeys, stateKeys, usesZoom, usesState, filterUsesState, filterUsesZoom, usesGeom };
	} catch (err) {
		if (err instanceof Unsupported) return { error: err.message };
		throw err;
	}
}
