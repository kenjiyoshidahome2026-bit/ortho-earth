// Cesium の CustomShader（利用者の GLSL＝vertexMain／fragmentMain）を模型・3D Tiles の描き手へ差し込む（2026-10-29）。
// GL＝利用者の GLSL を前置き（czm_modelMaterial・FragmentInput・uniform）付きでそのまま差し込む（名前の衝突を避けて uniform だけ cu_ に改名）。
// WebGPU＝同じ GLSL を字句→構文木→型付け→WGSL へ写す（GLSL ES 3.00 の部分集合＝Cesium の公式例のシェーダが通る範囲）。写せない物は throw＝描き手は
// その模型を利用者のシェーダ無しで描く（白くも消えもしない）。
// 型の付け方：GLSL は暗黙の変換をしない（ES 3.00）＝型は字面から決まる。WGSL との差だけ埋める：vec3(int)→vec3f(f32(…))・clamp(vec, s, s)→スカラーの複製・
// 三項→select・ベクトルの ==→all()・複数成分の swizzle への代入→成分ごと・inout の引数→ポインタ・texture()→textureSample（分岐の中は textureSampleLevel 0＝一様制御フローの掟）。

/** 利用者の uniform の型（Cesium の UniformType の GLSL 名） */
export type CsUType = "float" | "int" | "uint" | "bool" | "vec2" | "vec3" | "vec4" | "ivec2" | "ivec3" | "ivec4" | "bvec2" | "bvec3" | "bvec4" | "mat2" | "mat3" | "mat4" | "sampler2D";
/** 差し込む利用者のシェーダ（描き手の set("customShader") の data） */
export interface CsSpec {
	vs?: string | null;
	fs?: string | null;
	uniforms?: Record<string, CsUType>;
	/** fsInput.metadata の性質＝名 → GLSL の型、または property texture（EXT_structural_metadata）から読む物（CsMeta） */
	metadata?: Record<string, string | CsMeta> | null;
}
/** property texture の性質 1 つ＝tex 枚目（csmt_k）の channels を小さい桁から bytes 毎に組んだ整数（norm＝0..1・float＝float32 のビット）・offset/scale は Cesium と同じ後掛け */
export interface CsMeta { type: string; tex: number; ch: number[]; bytes: number; norm?: boolean; float?: boolean; offset?: number | null; scale?: number | null }
const metaType = (m: string | CsMeta): string => typeof m === "string" ? m : m.type;
/** property texture の枚数（csmt_0..） */
export const csMetaTexN = (spec: CsSpec): number => Math.max(0, ...Object.values(spec.metadata || {}).map(m => typeof m === "string" ? -1 : m.tex)) + 1;
/** csMetaOf の 1 性質の式（GLSL・WGSL 共通の形を w で切替）：成分ごとに channels を bytes 個ずつ取り整数へ */
function metaExpr(m: CsMeta, w: boolean): string {
	const t = m.type, n = /vec([234])/.test(t) ? +RegExp.$1 : 1, base = t.startsWith("u") ? "u" : t.startsWith("i") ? "i" : "f";
	const comp = (c: number): string => {
		const parts: string[] = [];
		for (let b = 0; b < m.bytes; b++) { const ch = m.ch[c * m.bytes + b] ?? 0; parts.push(`${w ? "u32" : "uint"}(px[${ch}] * 255.0 + 0.5)${b ? ` << ${8 * b}u` : ""}`); }
		const raw = parts.length > 1 ? `(${parts.join(" | ")})` : parts[0];
		let v: string;
		if (m.float) v = w ? `bitcast<f32>(${raw})` : `uintBitsToFloat(${raw})`;
		else if (m.norm) v = `${w ? "f32" : "float"}(${raw}) / ${(2 ** (8 * m.bytes) - 1).toFixed(1)}`;
		else if (base === "f") v = `${w ? "f32" : "float"}(${raw})`;
		else if (base === "i") v = w ? `bitcast<i32>(${raw} << ${32 - 8 * m.bytes}u) >> ${32 - 8 * m.bytes}u` : `(int(${raw} << ${32 - 8 * m.bytes}u) >> ${32 - 8 * m.bytes})`;   // 符号を伸ばす
		else v = raw;
		if (base === "f" && (m.scale != null || m.offset != null)) v = `(${v}) * ${(m.scale ?? 1).toFixed(9)} + ${(m.offset ?? 0).toFixed(9)}`;
		return v;
	};
	const comps = Array.from({ length: n }, (_, c) => comp(c));
	return n === 1 ? comps[0] : w ? `${wgslType(t)}(${comps.join(", ")})` : `${t}(${comps.join(", ")})`;
}

// ── 字句 ───────────────────────────────────────────────────────────────
interface Tok { t: "id" | "num" | "op" | "pp"; v: string }
const OPS = ["<<=", ">>=", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "==", "!=", "<=", ">=", "&&", "||", "^^", "<<", ">>"];
export function csLex(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0, bol = true;
	while (i < src.length) {
		const c = src[i];
		if (c === "\n") { bol = true; i++; continue; }
		if (c === " " || c === "\t" || c === "\r") { i++; continue; }
		if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
		if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? src.length : j + 2; continue; }
		if (c === "#" && bol) { let j = i; while (j < src.length && src[j] !== "\n") { if (src[j] === "\\" && src[j + 1] === "\n") j++; j++; } out.push({ t: "pp", v: src.slice(i, j) }); i = j; continue; }
		bol = false;
		if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++; out.push({ t: "id", v: src.slice(i, j) }); i = j; continue; }
		if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) {
			const m = /^(0[xX][0-9a-fA-F]+[uU]?|(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?[fFuU]?)/.exec(src.slice(i));
			out.push({ t: "num", v: m![0] }); i += m![0].length; continue;
		}
		const op = OPS.find(o => src.startsWith(o, i)) || c;
		out.push({ t: "op", v: op }); i += op.length;
	}
	return out;
}

// ── 構文木 ─────────────────────────────────────────────────────────────
type Expr =
	| { k: "num"; v: string }
	| { k: "id"; name: string }
	| { k: "call"; fn: string; args: Expr[] }
	| { k: "mem"; o: Expr; name: string }
	| { k: "idx"; o: Expr; i: Expr }
	| { k: "un"; op: string; e: Expr }
	| { k: "post"; op: string; e: Expr }
	| { k: "bin"; op: string; a: Expr; b: Expr }
	| { k: "tern"; c: Expr; a: Expr; b: Expr }
	| { k: "asg"; op: string; l: Expr; r: Expr };
interface VarDecl { name: string; init: Expr | null }
type Stmt =
	| { k: "decl"; type: string; vars: VarDecl[]; isConst: boolean }
	| { k: "expr"; e: Expr }
	| { k: "if"; c: Expr; t: Stmt; f: Stmt | null }
	| { k: "for"; init: Stmt | null; cond: Expr | null; step: Expr | null; body: Stmt }
	| { k: "while"; c: Expr; body: Stmt }
	| { k: "ret"; e: Expr | null }
	| { k: "break" } | { k: "cont" } | { k: "discard" } | { k: "empty" }
	| { k: "block"; body: Stmt[] };
interface Param { q: string; type: string; name: string }
type Top =
	| { k: "struct"; name: string; fields: { type: string; name: string }[] }
	| { k: "fn"; ret: string; name: string; params: Param[]; body: Stmt[] }
	| { k: "gdecl"; d: Extract<Stmt, { k: "decl" }> }
	| { k: "pp"; v: string };

const QUALS = new Set(["highp", "mediump", "lowp", "in", "out", "inout", "const", "flat", "smooth", "uniform", "precise", "invariant"]);
const BASIC = /^(void|float|int|uint|bool|[biu]?vec[234]|mat[234](x[234])?|sampler2D)$/;
export function csParse(src: string): Top[] {
	const T = csLex(src);
	let p = 0;
	const structs = new Set<string>(["czm_modelMaterial", "czm_modelVertexOutput", "FragmentInput", "VertexInput", "Attributes", "FeatureIds", "Metadata"]);
	const peek = (o = 0) => T[p + o];
	const is = (v: string, o = 0) => T[p + o]?.v === v && T[p + o].t !== "num";
	const eat = (v: string) => { if (!is(v)) throw new Error(`csshader: expected '${v}' near '${T.slice(p, p + 6).map(t => t.v).join(" ")}'`); p++; };
	const isType = (o = 0) => { const t = T[p + o]; return !!t && t.t === "id" && (BASIC.test(t.v) || structs.has(t.v)); };
	const skipQ = () => { const q: string[] = []; while (T[p]?.t === "id" && QUALS.has(T[p].v)) q.push(T[p++].v); return q; };
	const typeName = () => { const t = T[p]; if (!t || t.t !== "id") throw new Error("csshader: type expected"); p++; return t.v; };
	const ident = () => { const t = T[p]; if (!t || t.t !== "id") throw new Error(`csshader: identifier expected near '${t?.v}'`); p++; return t.v; };
	// 式（優先順位の昇り）
	const BIN: [string[], number][] = [[["||"], 1], [["^^"], 2], [["&&"], 3], [["|"], 4], [["^"], 5], [["&"], 6], [["==", "!="], 7], [["<", ">", "<=", ">="], 8], [["<<", ">>"], 9], [["+", "-"], 10], [["*", "/", "%"], 11]];
	const prec = (t: Tok | undefined) => { if (!t || t.t !== "op") return -1; for (const [ops, pr] of BIN) if (ops.includes(t.v)) return pr; return -1; };
	const ASG = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);
	function expr(): Expr { return assign(); }
	function assign(): Expr {
		const l = ternary();
		const t = peek();
		if (t && t.t === "op" && ASG.has(t.v)) { p++; return { k: "asg", op: t.v, l, r: assign() }; }
		return l;
	}
	function ternary(): Expr {
		const c = binary(0);
		if (is("?")) { p++; const a = assign(); eat(":"); const b = assign(); return { k: "tern", c, a, b }; }
		return c;
	}
	function binary(min: number): Expr {
		let a = unary();
		for (;;) {
			const pr = prec(peek());
			if (pr < 0 || pr < min) break;
			const op = T[p++].v;
			const b = binary(pr + 1);
			a = { k: "bin", op, a, b };
		}
		return a;
	}
	function unary(): Expr {
		const t = peek();
		if (t && t.t === "op" && ["-", "+", "!", "~", "++", "--"].includes(t.v)) { p++; return { k: "un", op: t.v, e: unary() }; }
		return postfix(primary());
	}
	function primary(): Expr {
		const t = T[p++];
		if (!t) throw new Error("csshader: unexpected end");
		if (t.t === "num") return { k: "num", v: t.v };
		if (t.v === "(") { const e = expr(); eat(")"); return e; }
		if (t.t === "id") {
			if (is("(")) { p++; const args: Expr[] = []; if (is("void") && is(")", 1)) p++; while (!is(")")) { args.push(assign()); if (is(",")) p++; else break; } eat(")"); return { k: "call", fn: t.v, args }; }
			return { k: "id", name: t.v };
		}
		throw new Error(`csshader: unexpected '${t.v}'`);
	}
	function postfix(e: Expr): Expr {
		for (;;) {
			if (is(".")) { p++; e = { k: "mem", o: e, name: ident() }; }
			else if (is("[")) { p++; const i = expr(); eat("]"); e = { k: "idx", o: e, i }; }
			else if (is("++") || is("--")) { e = { k: "post", op: T[p++].v, e }; }
			else return e;
		}
	}
	function declRest(type: string, isConst: boolean): Extract<Stmt, { k: "decl" }> {
		const vars: VarDecl[] = [];
		for (;;) {
			const name = ident();
			if (is("[")) throw new Error("csshader: arrays are not supported");
			let init: Expr | null = null;
			if (is("=")) { p++; init = assign(); }
			vars.push({ name, init });
			if (is(",")) { p++; continue; }
			break;
		}
		eat(";");
		return { k: "decl", type, vars, isConst };
	}
	function stmt(): Stmt {
		if (is("{")) { p++; const body: Stmt[] = []; while (!is("}")) body.push(stmt()); eat("}"); return { k: "block", body }; }
		if (is(";")) { p++; return { k: "empty" }; }
		if (is("if")) { p++; eat("("); const c = expr(); eat(")"); const t = stmt(); let f: Stmt | null = null; if (is("else")) { p++; f = stmt(); } return { k: "if", c, t, f }; }
		if (is("for")) {
			p++; eat("(");
			let init: Stmt | null = null;
			if (is(";")) p++; else init = simple();
			const cond = is(";") ? null : expr(); eat(";");
			const step = is(")") ? null : expr(); eat(")");
			return { k: "for", init, cond, step, body: stmt() };
		}
		if (is("while")) { p++; eat("("); const c = expr(); eat(")"); return { k: "while", c, body: stmt() }; }
		if (is("return")) { p++; const e = is(";") ? null : expr(); eat(";"); return { k: "ret", e }; }
		if (is("break")) { p++; eat(";"); return { k: "break" }; }
		if (is("continue")) { p++; eat(";"); return { k: "cont" }; }
		if (is("discard")) { p++; eat(";"); return { k: "discard" }; }
		if (is("do") || is("switch")) throw new Error(`csshader: '${peek().v}' is not supported`);
		return simple();
	}
	function simple(): Stmt {   // 宣言か式（for の初期化にも）
		const save = p;
		const q = skipQ();
		if (isType() && peek(1)?.t === "id") { const type = typeName(); return declRest(type, q.includes("const")); }
		p = save;
		const e = expr(); eat(";");
		return { k: "expr", e };
	}
	const tops: Top[] = [];
	while (p < T.length) {
		const t = peek();
		if (t.t === "pp") { tops.push({ k: "pp", v: t.v }); p++; continue; }
		if (is(";")) { p++; continue; }
		if (is("precision")) { while (!is(";")) p++; p++; continue; }
		if (is("struct")) {
			p++; const name = ident(); structs.add(name); eat("{");
			const fields: { type: string; name: string }[] = [];
			while (!is("}")) { skipQ(); const type = typeName(); for (;;) { fields.push({ type, name: ident() }); if (is(",")) { p++; continue; } break; } eat(";"); }
			eat("}"); eat(";");
			tops.push({ k: "struct", name, fields });
			continue;
		}
		const q = skipQ();
		if (q.includes("uniform")) { while (!is(";")) p++; p++; continue; }   // 利用者が書いた uniform 宣言＝uniforms から作る物と重なる＝読み捨て
		const type = typeName();
		const name = ident();
		if (is("(")) {
			p++;
			const params: Param[] = [];
			if (is("void") && is(")", 1)) p++;
			while (!is(")")) {
				const pq = skipQ();
				const ptype = typeName();
				const pname = T[p]?.t === "id" ? ident() : `_p${params.length}`;
				params.push({ q: pq.includes("inout") ? "inout" : pq.includes("out") ? "out" : "in", type: ptype, name: pname });
				if (is(",")) p++; else break;
			}
			eat(")");
			if (is(";")) { p++; continue; }   // 前方宣言＝WGSL は要らない
			eat("{");
			const body: Stmt[] = [];
			while (!is("}")) body.push(stmt());
			eat("}");
			tops.push({ k: "fn", ret: type, name, params, body });
			continue;
		}
		p -= 1;
		tops.push({ k: "gdecl", d: declRest(type, q.includes("const")) });
	}
	return tops;
}

// ── 型 ─────────────────────────────────────────────────────────────────
// 型は GLSL の名（"float"・"vec3"・"mat3"・構造体名）。字面の数は "afloat"/"aint"（WGSL の抽象数＝変換を噛ませなくてよい）
const baseOf = (t: string): string => t === "float" || t === "afloat" || /^vec|^mat/.test(t) ? "f" : t === "int" || t === "aint" || t.startsWith("ivec") ? "i" : t === "uint" || t.startsWith("uvec") ? "u" : t === "bool" || t.startsWith("bvec") ? "b" : "?";
const nOf = (t: string): number => { const m = /vec([234])$/.exec(t); return m ? +m[1] : /^(float|int|uint|bool|afloat|aint)$/.test(t) ? 1 : 0; };
const isScalar = (t: string) => nOf(t) === 1;
const isVec = (t: string) => /vec[234]$/.test(t);
const isMat = (t: string) => /^mat/.test(t);
const isAbstract = (t: string) => t === "afloat" || t === "aint";
const vecOf = (b: string, n: number): string => n === 1 ? ({ f: "float", i: "int", u: "uint", b: "bool" } as Record<string, string>)[b] : ({ f: "", i: "i", u: "u", b: "b" } as Record<string, string>)[b] + "vec" + n;
const concrete = (t: string) => t === "afloat" ? "float" : t === "aint" ? "int" : t;
const matDims = (t: string): [number, number] => { const m = /^mat([234])(?:x([234]))?$/.exec(t)!; return [+m[1], +(m[2] || m[1])]; };   // [列, 行]
export function wgslType(t: string): string {
	t = concrete(t);
	if (t === "float") return "f32"; if (t === "int") return "i32"; if (t === "uint") return "u32"; if (t === "bool") return "bool";
	if (isVec(t)) { const b = baseOf(t), n = nOf(t); return b === "b" ? `vec${n}<bool>` : `vec${n}${b}`; }
	if (isMat(t)) { const [c, r] = matDims(t); return `mat${c}x${r}f`; }
	return t;   // 構造体
}
const SWZ = /^([xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/;
const STPQ: Record<string, string> = { s: "x", t: "y", p: "z", q: "w" };

// 利用者のシェーダに見せる構造体（Cesium の CustomShaderPipelineStage が作る物の和集合＝使わない欄も持つ）
export const CS_ATTRS: [string, string][] = [["positionMC", "vec3"], ["positionWC", "vec3"], ["positionEC", "vec3"], ["normalMC", "vec3"], ["normalEC", "vec3"], ["tangentMC", "vec3"], ["tangentEC", "vec3"], ["bitangentMC", "vec3"], ["bitangentEC", "vec3"], ["texCoord_0", "vec2"], ["texCoord_1", "vec2"], ["color_0", "vec4"], ["featureId_0", "float"]];
const MATERIAL: [string, string][] = [["baseColor", "vec4"], ["diffuse", "vec3"], ["alpha", "float"], ["specular", "vec3"], ["roughness", "float"], ["normalEC", "vec3"], ["occlusion", "float"], ["emissive", "vec3"]];
const VSOUT: [string, string][] = [["positionMC", "vec3"], ["pointSize", "float"]];
const FIDS: [string, string][] = [["featureId_0", "int"], ["featureId_1", "int"]];
// 定数（Cesium の czm_ の一部）
const CZM_CONST: Record<string, [string, string]> = {
	czm_pi: ["float", "3.141592653589793"], czm_twoPi: ["float", "6.283185307179586"], czm_piOverTwo: ["float", "1.5707963267948966"], czm_piOverFour: ["float", "0.7853981633974483"],
	czm_oneOverPi: ["float", "0.3183098861837907"], czm_radiansPerDegree: ["float", "0.017453292519943295"], czm_degreesPerRadian: ["float", "57.29577951308232"],
	czm_epsilon1: ["float", "0.1"], czm_epsilon2: ["float", "0.01"], czm_epsilon3: ["float", "0.001"], czm_epsilon4: ["float", "0.0001"], czm_epsilon5: ["float", "0.00001"], czm_epsilon6: ["float", "0.000001"], czm_epsilon7: ["float", "0.0000001"],
};
const structFieldsOf = (spec: CsSpec): Record<string, [string, string][]> => {
	const meta = Object.entries(spec.metadata || {}).map(([n, t]) => [n, metaType(t)] as [string, string]);
	return {
		Attributes: CS_ATTRS, czm_modelMaterial: MATERIAL, czm_modelVertexOutput: VSOUT, FeatureIds: FIDS, Metadata: meta.length ? meta : [["_none", "float"]],
		FragmentInput: [["attributes", "Attributes"], ["featureIds", "FeatureIds"], ["metadata", "Metadata"]],
		VertexInput: [["attributes", "Attributes"], ["featureIds", "FeatureIds"], ["metadata", "Metadata"]],
	};
};
// Cesium の czm_ の色の関数（Cesium 1.146 の Shaders/Builtin/Functions の写し・内部の補助は czm_ を冠して衝突を避ける）＝利用者のシェーダが使う物だけ前置きに入れる（WGSL へは同じ変換器で写す）
const CZM_LIB: { name: string; deps: string[]; src: string }[] = [
	{ name: "czm_HSBToRGB", deps: [], src: "const vec4 czm_K_HSB2RGB = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);\nvec3 czm_HSBToRGB(vec3 hsb) {\n\tvec3 p = abs(fract(hsb.xxx + czm_K_HSB2RGB.xyz) * 6.0 - czm_K_HSB2RGB.www);\n\treturn hsb.z * mix(czm_K_HSB2RGB.xxx, clamp(p - czm_K_HSB2RGB.xxx, 0.0, 1.0), hsb.y);\n}\n" },
	{ name: "czm_HSLToRGB", deps: [], src: "vec3 czm_hueToRGB(float hue) {\n\tfloat r = abs(hue * 6.0 - 3.0) - 1.0;\n\tfloat g = 2.0 - abs(hue * 6.0 - 2.0);\n\tfloat b = 2.0 - abs(hue * 6.0 - 4.0);\n\treturn clamp(vec3(r, g, b), 0.0, 1.0);\n}\nvec3 czm_HSLToRGB(vec3 hsl) {\n\tvec3 rgb = czm_hueToRGB(hsl.x);\n\tfloat c = (1.0 - abs(2.0 * hsl.z - 1.0)) * hsl.y;\n\treturn (rgb - 0.5) * c + hsl.z;\n}\n" },
	{ name: "czm_RGBToHSB", deps: [], src: "const vec4 czm_K_RGB2HSB = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);\nvec3 czm_RGBToHSB(vec3 rgb) {\n\tvec4 p = mix(vec4(rgb.bg, czm_K_RGB2HSB.wz), vec4(rgb.gb, czm_K_RGB2HSB.xy), step(rgb.b, rgb.g));\n\tvec4 q = mix(vec4(p.xyw, rgb.r), vec4(rgb.r, p.yzx), step(p.x, rgb.r));\n\tfloat d = q.x - min(q.w, q.y);\n\treturn vec3(abs(q.z + (q.w - q.y) / (6.0 * d + czm_epsilon7)), d / (q.x + czm_epsilon7), q.x);\n}\n" },
	{ name: "czm_RGBToHSL", deps: [], src: "vec3 czm_RGBtoHCV(vec3 rgb) {\n\tvec4 p = (rgb.g < rgb.b) ? vec4(rgb.bg, -1.0, 2.0 / 3.0) : vec4(rgb.gb, 0.0, -1.0 / 3.0);\n\tvec4 q = (rgb.r < p.x) ? vec4(p.xyw, rgb.r) : vec4(rgb.r, p.yzx);\n\tfloat c = q.x - min(q.w, q.y);\n\tfloat h = abs((q.w - q.y) / (6.0 * c + czm_epsilon7) + q.z);\n\treturn vec3(h, c, q.x);\n}\nvec3 czm_RGBToHSL(vec3 rgb) {\n\tvec3 hcv = czm_RGBtoHCV(rgb);\n\tfloat l = hcv.z - hcv.y * 0.5;\n\tfloat s = hcv.y / (1.0 - abs(l * 2.0 - 1.0) + czm_epsilon7);\n\treturn vec3(hcv.x, s, l);\n}\n" },
];
/** 利用者のシェーダが名指す czm_ の関数の GLSL（依存込み・重複なし） */
function czmLibFor(spec: CsSpec): string {
	const ids = new Set([spec.vs, spec.fs].flatMap(s => s ? csLex(s).filter(t => t.t === "id").map(t => t.v) : []));
	return CZM_LIB.filter(l => ids.has(l.name)).map(l => l.src).join("");
}
const csName = (name: string) => `cu_${name}`;   // 利用者の uniform の GL での名＝描き手の u_* と衝突しない

// ── GL：前置き＋利用者の GLSL（uniform を改名して字句から書き戻す） ─────────────────────────────
/** GL の前置き（構造体・uniform・czm_ の定数と関数）。stage＝"vs"|"fs" */
export function csGlslPrelude(spec: CsSpec, stage: "vs" | "fs"): string {
	const S = structFieldsOf(spec);
	const st = (n: string) => `struct ${n} {\n${S[n].map(([f, t]) => `\t${t} ${f};`).join("\n")}\n};\n`;
	let s = "";
	for (const [n, [t, v]] of Object.entries(CZM_CONST)) s += `const ${t} ${n} = ${v};\n`;
	s += "uniform float u_czmFrame;\n#define czm_frameNumber u_czmFrame\n";
	s += "vec3 czm_srgbToLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }\nvec4 czm_srgbToLinear(vec4 c) { return vec4(czm_srgbToLinear(c.rgb), c.a); }\n";
	s += "vec3 czm_linearToSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }\nvec4 czm_linearToSrgb(vec4 c) { return vec4(czm_linearToSrgb(c.rgb), c.a); }\n";
	s += "float czm_luminance(vec3 rgb) { return dot(rgb, vec3(0.2125, 0.7154, 0.0721)); }\n";
	s += st("Attributes") + st("FeatureIds") + st("Metadata") + (stage === "vs" ? st("czm_modelVertexOutput") + st("VertexInput") : st("czm_modelMaterial") + st("FragmentInput"));
	for (const [n, t] of Object.entries(spec.uniforms || {})) s += `uniform ${t} ${csName(n)};\n`;
	// 属性の組み立て（描き手の main が呼ぶ）：mc＝positionMC・pw＝世界座標（単位球）・ec＝目の座標（m）・nw＝世界の法線・J＝MC → 世界の線形部・V＝世界 → 目の回転
	s += `Attributes csAttrsOf(vec3 mc, vec3 pw, vec3 ec, vec3 nw, vec2 uv, vec4 col, float fid, mat3 J, mat3 V) {\n\tAttributes a;\n${CS_ATTRS.map(([f, t]) => `\ta.${f} = ${t === "float" ? "0.0" : `${t}(0.0)`};\n`).join("")}`
		+ "\ta.positionMC = mc; a.positionWC = vec3(pw.x, pw.z, pw.y) * 6378137.0; a.positionEC = ec;\n\tvec3 nm = transpose(J) * nw; a.normalMC = dot(nm, nm) > 0.0 ? normalize(nm) : vec3(0.0, 0.0, 1.0);\n"
		+ "\ta.normalEC = normalize(V * nw); a.texCoord_0 = uv; a.texCoord_1 = uv; a.color_0 = col; a.featureId_0 = fid;\n\treturn a;\n}\n";
	// fsInput.metadata＝property texture（FS だけ・VS は 0）を uvm（その texCoord）で読む
	const MT = stage === "fs" ? csMetaTexN(spec) : 0;
	for (let k = 0; k < MT; k++) s += `uniform sampler2D csmt_${k};\n`;
	s += `Metadata csMetaOf(vec2 uvm) {\n\tMetadata m;\n${MT ? "\tvec4 px;\n" : ""}${structFieldsOf(spec).Metadata.map(([f, t]) => { const m = spec.metadata?.[f]; return MT && m && typeof m !== "string" ? `\tpx = texture(csmt_${m.tex}, uvm);\n\tm.${f} = ${metaExpr(m, false)};\n` : `\tm.${f} = ${t}(0);\n`; }).join("")}\treturn m;\n}\n`;
	return s + czmLibFor(spec);
}
/** 利用者の GLSL を GL へ（uniform の名だけ改名・字句を書き戻す） */
export function csGlslUser(src: string, spec: CsSpec): string {
	const U = new Set(Object.keys(spec.uniforms || {}));
	let s = "", prev: Tok | null = null;
	for (const t of csLex(src)) {
		if (t.t === "pp") { s += `\n${t.v}\n`; prev = null; continue; }
		const v = t.t === "id" && U.has(t.v) && prev?.v !== "." ? csName(t.v) : t.v;
		const sp = prev && (prev.t !== "op" || t.t !== "op") && !(t.v === "." || prev.v === "." || t.v === "(" || t.v === ")" || t.v === "," || t.v === ";" || t.v === "[" || t.v === "]") ? " " : "";
		s += sp + v + (t.v === ";" || t.v === "{" || t.v === "}" ? "\n" : "");
		prev = t.v === ";" || t.v === "{" || t.v === "}" ? null : t;
	}
	return s;
}

// ── WebGPU：WGSL へ写す ────────────────────────────────────────────────────
/** CU（利用者の uniform の束）の並び：描き手が先頭に置く欄（J・V・misc）の後ろに 16 B 揃えで 1 つずつ */
export interface CsLayoutField { name: string; type: CsUType; off: number }
export const CS_CU_HEAD = 7;   // vec4 の数：J（mat3＝3）・V（mat3＝3）・misc（frame, R, 0, 0）
export function csLayout(spec: CsSpec): { fields: CsLayoutField[]; textures: string[]; size: number } {
	const fields: CsLayoutField[] = [], textures: string[] = [];
	let off = CS_CU_HEAD * 16;
	for (const [name, type] of Object.entries(spec.uniforms || {})) {
		if (type === "sampler2D") { textures.push(name); continue; }
		fields.push({ name, type, off });
		off += type === "mat3" ? 48 : type === "mat4" ? 64 : type === "mat2" ? 32 : 16;
	}
	return { fields, textures, size: Math.max(off, 16) };
}
const cuWgslType = (t: CsUType) => t === "bool" ? "u32" : t.startsWith("bvec") ? `vec${t[4]}u` : t === "mat2" ? "mat2x2f" : wgslType(t);
/** CU を詰める（ArrayBuffer に・値は Cesium の Cartesian／Matrix を平らにした数列）。mat は列優先（Cesium の Matrix の toArray と同じ） */
export function csPackUniforms(spec: CsSpec, values: Record<string, unknown>, buf: ArrayBuffer): void {
	const f = new Float32Array(buf), i = new Int32Array(buf), u = new Uint32Array(buf);
	for (const fd of csLayout(spec).fields) {
		const v = values[fd.name], a = typeof v === "number" || typeof v === "boolean" ? [Number(v)] : Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<number>) : [];
		const o = fd.off / 4, b = baseOf(fd.type);
		if (isMat(fd.type)) {   // 列ごとに 16 B（mat2 は WGSL の mat2x2f＝8 B の列＝CPU も 8 B・ここでは @align(16) の 32 B に列 2 本×vec4 で置く）
			const n = +fd.type[3];
			for (let c = 0; c < n; c++) for (let r = 0; r < n; r++) f[o + c * 4 + r] = a[c * n + r] ?? 0;
		} else for (let k = 0; k < nOf(fd.type); k++) { const x = a[k] ?? 0; if (b === "f") f[o + k] = x; else if (b === "i") i[o + k] = x | 0; else u[o + k] = b === "b" ? (x ? 1 : 0) : x >>> 0; }
	}
}

interface Scope { vars: Map<string, string>; parent: Scope | null }
const lookup = (s: Scope | null, n: string): string | null => { for (; s; s = s.parent) { const t = s.vars.get(n); if (t) return t; } return null; };

/** WGSL への変換結果。decl＝構造体・CU・テクスチャ・利用者の関数（private の大域の宣言込み）、fsCall／vsCall＝呼び出しの 1 文 */
export interface CsWgsl { decl: string; hasVs: boolean; hasFs: boolean; textures: string[]; layout: ReturnType<typeof csLayout> }
/** group/binding：CU の束（uniform）と利用者のテクスチャ（各 sampler+texture）の始まり */
export function csWgsl(spec: CsSpec, group: number, binding0: number): CsWgsl {
	const layout = csLayout(spec);
	const S = structFieldsOf(spec);
	const structs: Record<string, [string, string][]> = { ...S };
	const funcs = new Map<string, { ret: string; params: Param[] }>();
	const globals: Scope = { vars: new Map(), parent: null };
	for (const [n, [t]] of Object.entries(CZM_CONST)) globals.vars.set(n, t);
	globals.vars.set("czm_frameNumber", "float");
	const U = spec.uniforms || {};
	for (const [n, t] of Object.entries(U)) globals.vars.set(n, t);
	let out = "";
	const st = (n: string) => `struct ${n} {\n${structs[n].map(([f, t]) => `\t${f}: ${wgslType(t)},`).join("\n")}\n};\n`;
	out += st("Attributes") + st("FeatureIds") + st("Metadata") + st("czm_modelVertexOutput") + st("VertexInput") + st("czm_modelMaterial") + st("FragmentInput");
	out += `struct CsU {\n\tJ: mat3x3f,\n\tV: mat3x3f,\n\tmisc: vec4f,\n${layout.fields.map(f => `\t@align(16) ${f.name}: ${cuWgslType(f.type)},`).join("\n")}${layout.fields.length ? "" : "\t_pad: vec4f,"}\n};\n`;
	out += `@group(${group}) @binding(${binding0}) var<uniform> CU: CsU;\n`;
	layout.textures.forEach((n, k) => { out += `@group(${group}) @binding(${binding0 + 1 + k * 2}) var css_${n}: sampler;\n@group(${group}) @binding(${binding0 + 2 + k * 2}) var cst_${n}: texture_2d<f32>;\n`; });
	for (const [n, [t, v]] of Object.entries(CZM_CONST)) out += `const ${n}: ${wgslType(t)} = ${v};\n`;
	out += "fn czm_srgbToLinear3(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)); }\nfn czm_srgbToLinear4(c: vec4f) -> vec4f { return vec4f(czm_srgbToLinear3(c.rgb), c.a); }\n";
	out += "fn czm_linearToSrgb3(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2)); }\nfn czm_linearToSrgb4(c: vec4f) -> vec4f { return vec4f(czm_linearToSrgb3(c.rgb), c.a); }\n";
	out += "fn czm_luminance(rgb: vec3f) -> f32 { return dot(rgb, vec3f(0.2125, 0.7154, 0.0721)); }\n";
	out += "var<private> csFi: FragmentInput;\nvar<private> csM: czm_modelMaterial;\nvar<private> csVi: VertexInput;\nvar<private> csVo: czm_modelVertexOutput;\n";
	out += `fn csAttrsOf(mc: vec3f, pw: vec3f, ec: vec3f, nw: vec3f, uv: vec2f, col: vec4f, fid: f32) -> Attributes {\n\tvar a: Attributes;\n`
		+ "\ta.positionMC = mc; a.positionWC = vec3f(pw.x, pw.z, pw.y) * 6378137.0; a.positionEC = ec;\n\tlet nm = transpose(CU.J) * nw; a.normalMC = select(vec3f(0.0, 0.0, 1.0), normalize(nm), dot(nm, nm) > 0.0);\n"
		+ "\ta.normalEC = normalize(CU.V * nw); a.texCoord_0 = uv; a.texCoord_1 = uv; a.color_0 = col; a.featureId_0 = fid;\n\treturn a;\n}\n";
	const MT = csMetaTexN(spec), mb0 = binding0 + 1 + layout.textures.length * 2;   // property texture＝利用者のテクスチャの後ろに sampler＋texture の組
	for (let k = 0; k < MT; k++) out += `@group(${group}) @binding(${mb0 + k * 2}) var css_csmt_${k}: sampler;\n@group(${group}) @binding(${mb0 + 1 + k * 2}) var cst_csmt_${k}: texture_2d<f32>;\n`;
	out += `fn csMetaOf(uvm: vec2f) -> Metadata {\n\tvar m: Metadata;\n${MT ? "\tvar px: vec4f;\n" : ""}${Object.entries(spec.metadata || {}).map(([f, m]) => typeof m === "string" || !MT ? "" : `\tpx = textureSampleLevel(cst_csmt_${m.tex}, css_csmt_${m.tex}, uvm, 0.0);\n\tm.${f} = ${metaExpr(m, true)};\n`).join("")}\treturn m;\n}\n`;
	let hasVs = false, hasFs = false;
	const srcs = [czmLibFor(spec), spec.vs, spec.fs].filter(Boolean) as string[];
	let tmpN = 0;
	for (const src of srcs) {
		const tops = csParse(src);
		for (const t of tops) if (t.k === "fn") funcs.set(t.name, { ret: t.ret, params: t.params });
		for (const t of tops) {
			if (t.k === "pp") throw new Error(`csshader: preprocessor is not supported in WGSL: ${t.v}`);
			if (t.k === "struct") { structs[t.name] = t.fields.map(f => [f.name, f.type]); out += st(t.name); continue; }
			if (t.k === "gdecl") {
				for (const v of t.d.vars) {
					globals.vars.set(v.name, t.d.type);
					out += t.d.isConst ? `const ${v.name}: ${wgslType(t.d.type)} = ${conv(ex(v.init!, globals, null).s, typeOfE(v.init!, globals), t.d.type)};\n` : `var<private> ${v.name}: ${wgslType(t.d.type)}${v.init ? ` = ${conv(ex(v.init, globals, null).s, typeOfE(v.init, globals), t.d.type)}` : ""};\n`;
				}
				continue;
			}
			// 関数
			const isFs = t.name === "fragmentMain", isVsMain = t.name === "vertexMain";
			if (isFs) hasFs = true; if (isVsMain) hasVs = true;
			const scope: Scope = { vars: new Map(), parent: globals };
			const ren = new Map<string, string>();   // 引数の名 → 大域（fragmentMain／vertexMain）・ポインタの参照（inout）
			const ptrs = new Set<string>();
			let sig = "";
			if (isFs || isVsMain) {
				const [a, b] = t.params;
				if (a) { ren.set(a.name, isFs ? "csFi" : "csVi"); scope.vars.set(a.name, a.type); }
				if (b) { ren.set(b.name, isFs ? "csM" : "csVo"); scope.vars.set(b.name, b.type); }
			} else {
				sig = t.params.map(pa => { scope.vars.set(pa.name, pa.type); if (pa.q !== "in") { ptrs.add(pa.name); return `${pa.name}: ptr<function, ${wgslType(pa.type)}>`; } return `${pa.name}: ${wgslType(pa.type)}`; }).join(", ");
			}
			const ctx: FnCtx = { ren, ptrs, depth: isFs || isVsMain ? 0 : 1, ret: t.ret };
			out += `fn ${t.name}(${sig})${t.ret === "void" ? "" : ` -> ${wgslType(t.ret)}`} {\n${t.body.map(s => stm(s, scope, ctx, "\t")).join("")}}\n`;
		}
	}
	return { decl: out, hasVs, hasFs, textures: layout.textures, layout };

	interface FnCtx { ren: Map<string, string>; ptrs: Set<string>; depth: number; ret: string }
	function conv(s: string, from: string, to: string): string {   // 値 s（型 from）を型 to へ（GLSL の初期化・代入・return は同じ型＝抽象数と同じ型は素通し）
		if (from === to || isAbstract(from) || !to || to === "void") return s;
		if (nOf(from) === nOf(to) && baseOf(from) !== baseOf(to) && nOf(to) > 0) return `${wgslType(to)}(${s})`;
		return s;
	}
	function typeOfE(e: Expr, sc: Scope): string { return ex(e, sc, null).t; }
	function stm(s: Stmt, sc: Scope, c: FnCtx, ind: string): string {
		switch (s.k) {
			case "empty": return "";
			case "block": { const inner: Scope = { vars: new Map(), parent: sc }; return `${ind}{\n${s.body.map(x => stm(x, inner, c, ind + "\t")).join("")}${ind}}\n`; }
			case "decl": return s.vars.map(v => {
				const init = v.init ? ex(v.init, sc, c) : null;
				sc.vars.set(v.name, s.type);
				const kw = s.isConst ? "let" : "var";
				if (s.isConst && !init) throw new Error("csshader: const without initializer");
				return `${ind}${kw} ${v.name}: ${wgslType(s.type)}${init ? ` = ${conv(init.s, init.t, s.type)}` : ""};\n`;
			}).join("");
			case "expr": return exprStmt(s.e, sc, c, ind);
			case "if": {
				const cc = ex(s.c, sc, c);
				c.depth++;
				const t = blockOf(s.t, sc, c, ind), f = s.f ? (s.f.k === "if" ? ` else ${stm(s.f, sc, c, ind).trimStart()}` : ` else ${blockOf(s.f, sc, c, ind)}\n`) : "\n";
				c.depth--;
				return `${ind}if (${cc.s}) ${t}${f.endsWith("\n") ? f : f + "\n"}`;
			}
			case "for": {
				const inner: Scope = { vars: new Map(), parent: sc };
				const init = s.init ? stm(s.init, inner, c, "").trim().replace(/;$/, "") : "";
				const cond = s.cond ? ex(s.cond, inner, c).s : "";
				const step = s.step ? exprStmt(s.step, inner, c, "").trim().replace(/;$/, "") : "";
				c.depth++; const body = blockOf(s.body, inner, c, ind); c.depth--;
				return `${ind}for (${init}; ${cond}; ${step}) ${body}\n`;
			}
			case "while": { const cc = ex(s.c, sc, c); c.depth++; const body = blockOf(s.body, sc, c, ind); c.depth--; return `${ind}while (${cc.s}) ${body}\n`; }
			case "ret": return s.e ? `${ind}return ${((r) => conv(r.s, r.t, c.ret))(ex(s.e, sc, c))};\n` : `${ind}return;\n`;
			case "break": return `${ind}break;\n`;
			case "cont": return `${ind}continue;\n`;
			case "discard": return `${ind}discard;\n`;
		}
	}
	function blockOf(s: Stmt, sc: Scope, c: FnCtx, ind: string): string {
		const inner: Scope = { vars: new Map(), parent: sc };
		const body = s.k === "block" ? s.body : [s];
		return `{\n${body.map(x => stm(x, inner, c, ind + "\t")).join("")}${ind}}`;
	}
	function exprStmt(e: Expr, sc: Scope, c: FnCtx, ind: string): string {
		if (e.k === "asg") {
			// 複数成分の swizzle への代入＝WGSL に無い＝一時の値から成分ごと
			if (e.l.k === "mem" && SWZ.test(e.l.name) && e.l.name.length > 1) {
				const base = ex(e.l.o, sc, c), r = ex(e.r, sc, c), tmp = `_sw${tmpN++}`;
				const comps = e.l.name.split("").map(ch => STPQ[ch] || ch);
				const rhs = e.op === "=" ? r.s : `${ex(e.l, sc, c).s} ${e.op.slice(0, -1)} (${r.s})`;
				const xyzw = "xyzw";
				return `${ind}let ${tmp} = ${rhs};\n` + comps.map((ch, k) => `${ind}${base.s}.${ch} = ${tmp}${isScalar(r.t) && e.op === "=" ? "" : "." + xyzw[k]};\n`).join("");
			}
			const l = ex(e.l, sc, c), r = ex(e.r, sc, c);
			return `${ind}${l.s} ${e.op} ${e.op === "=" ? conv(r.s, r.t, l.t) : r.s};\n`;
		}
		if ((e.k === "post" || e.k === "un") && (e.op === "++" || e.op === "--")) return `${ind}${ex(e.e, sc, c).s}${e.op};\n`;
		if (e.k === "call") return `${ind}${ex(e, sc, c).s};\n`;
		throw new Error("csshader: expression statement without effect");
	}
	// 式 → { s: WGSL の字面, t: GLSL の型 }
	function ex(e: Expr, sc: Scope, c: FnCtx | null): { s: string; t: string } {
		switch (e.k) {
			case "num": {
				const v = e.v;
				if (/^0[xX]/.test(v)) return v.endsWith("u") || v.endsWith("U") ? { s: v.replace(/U$/, "u"), t: "uint" } : { s: v, t: "aint" };
				if (/[uU]$/.test(v)) return { s: v.replace(/U$/, "u"), t: "uint" };
				if (/[.eE]/.test(v) || /[fF]$/.test(v)) return { s: v.replace(/[fF]$/, ""), t: "afloat" };
				return { s: v, t: "aint" };
			}
			case "id": {
				const n = e.name;
				if (c?.ren.has(n)) return { s: c.ren.get(n)!, t: lookup(sc, n)! };
				const t = lookup(sc, n);
				if (!t) throw new Error(`csshader: unknown identifier '${n}'`);
				if (c?.ptrs.has(n) && sc.vars.get(n) === undefined && lookup(sc, n)) return { s: `(*${n})`, t };
				if (c?.ptrs.has(n)) return { s: `(*${n})`, t };
				if (n === "czm_frameNumber") return { s: "CU.misc.x", t: "float" };
				if (Object.prototype.hasOwnProperty.call(U, n) && !isLocal(sc, n)) {
					if (U[n] === "sampler2D") return { s: n, t: "sampler2D" };
					if (U[n] === "bool") return { s: `(CU.${n} != 0u)`, t: "bool" };
					if (U[n].startsWith("bvec")) return { s: `(CU.${n} != vec${U[n][4]}u(0u))`, t: U[n] };
					return { s: `CU.${n}`, t: U[n] };
				}
				return { s: n, t };
			}
			case "mem": {
				const o = ex(e.o, sc, c);
				if (isVec(o.t) || isScalar(o.t)) {
					if (!SWZ.test(e.name)) throw new Error(`csshader: bad swizzle .${e.name}`);
					const sw = e.name.split("").map(ch => STPQ[ch] || ch).join("");
					return { s: `${o.s}.${sw}`, t: vecOf(baseOf(o.t), sw.length) };
				}
				const f = structs[o.t]?.find(([fn]) => fn === e.name);
				if (!f) throw new Error(`csshader: ${o.t} has no field '${e.name}'`);
				return { s: `${o.s}.${e.name}`, t: f[1] };
			}
			case "idx": {
				const o = ex(e.o, sc, c), i = ex(e.i, sc, c);
				const t = isMat(o.t) ? `vec${matDims(o.t)[1]}` : isVec(o.t) ? vecOf(baseOf(o.t), 1) : o.t;
				return { s: `${o.s}[${i.s}]`, t };
			}
			case "un": {
				const a = ex(e.e, sc, c);
				if (e.op === "++" || e.op === "--") throw new Error("csshader: ++/-- inside an expression");
				return { s: `(${e.op}${a.s})`, t: a.t };
			}
			case "post": throw new Error("csshader: ++/-- inside an expression");
			case "bin": {
				const a = ex(e.a, sc, c), b = ex(e.b, sc, c);
				if (e.op === "^^") return { s: `(${a.s} != ${b.s})`, t: "bool" };
				if (e.op === "==" || e.op === "!=") {
					if (isVec(a.t) || isVec(b.t)) return { s: e.op === "==" ? `all(${a.s} == ${b.s})` : `any(${a.s} != ${b.s})`, t: "bool" };
					return { s: `(${a.s} ${e.op} ${b.s})`, t: "bool" };
				}
				if (["<", ">", "<=", ">=", "&&", "||"].includes(e.op)) return { s: `(${a.s} ${e.op} ${b.s})`, t: "bool" };
				let t: string;
				if (e.op === "*" && isMat(a.t) && isVec(b.t)) t = `vec${matDims(a.t)[1]}`;
				else if (e.op === "*" && isVec(a.t) && isMat(b.t)) t = `vec${matDims(b.t)[0]}`;
				else if (isMat(a.t)) t = a.t; else if (isMat(b.t)) t = b.t;
				else if (nOf(a.t) >= nOf(b.t)) t = isAbstract(a.t) && !isAbstract(b.t) ? b.t : a.t; else t = b.t;
				if (isAbstract(a.t) && !isAbstract(b.t) && nOf(b.t) > 1) t = b.t;
				return { s: `(${a.s} ${e.op} ${b.s})`, t };
			}
			case "tern": {
				const cc = ex(e.c, sc, c), a = ex(e.a, sc, c), b = ex(e.b, sc, c);
				const t = isAbstract(a.t) ? b.t : a.t;
				return { s: `select(${conv(b.s, b.t, t)}, ${conv(a.s, a.t, t)}, ${cc.s})`, t };
			}
			case "asg": throw new Error("csshader: assignment inside an expression");
			case "call": return call(e, sc, c);
		}
	}
	function isLocal(sc: Scope, n: string): boolean { for (let s: Scope | null = sc; s && s !== globals; s = s.parent) if (s.vars.has(n)) return true; return false; }
	function splat(s: { s: string; t: string }, like: string): string { return nOf(like) > 1 && isScalar(s.t) ? `${wgslType(vecOf(baseOf(like), nOf(like)))}(${s.s})` : s.s; }
	function call(e: Extract<Expr, { k: "call" }>, sc: Scope, c: FnCtx | null): { s: string; t: string } {
		const fn = e.fn;
		// 型の構築子
		if (BASIC.test(fn) && fn !== "void" && fn !== "sampler2D") {
			const args = e.args.map(a => ex(a, sc, c));
			if (isMat(fn)) {
				const [C, R] = matDims(fn);
				if (args.length === 1 && isScalar(args[0].t)) { const z = "0.0", d = args[0].s; return { s: `${wgslType(fn)}(${Array.from({ length: C * R }, (_, k) => k % R === (k / R | 0) ? d : z).join(", ")})`, t: fn }; }
				if (args.length === 1 && isMat(args[0].t)) { const [c2, r2] = matDims(args[0].t); if (c2 >= C && r2 >= R) return { s: `${wgslType(fn)}(${Array.from({ length: C }, (_, k) => `${args[0].s}[${k}]${r2 > R ? "." + "xyzw".slice(0, R) : ""}`).join(", ")})`, t: fn }; }
				return { s: `${wgslType(fn)}(${args.map(a => a.s).join(", ")})`, t: fn };
			}
			const n = nOf(fn), b = baseOf(fn);
			if (args.length === 1 && nOf(args[0].t) > n) { const sw = "xyzw".slice(0, n); const a = `${args[0].s}.${sw}`; return { s: baseOf(args[0].t) === b ? (n === 1 ? a : `${wgslType(fn)}(${a})`) : `${wgslType(fn)}(${a})`, t: fn }; }
			const parts = args.map(a => isAbstract(a.t) || baseOf(a.t) === b ? a.s : `${wgslType(vecOf(b, nOf(a.t)))}(${a.s})`);
			return { s: `${wgslType(fn)}(${parts.join(", ")})`, t: fn };
		}
		if (structs[fn] && !funcs.has(fn)) { const args = e.args.map(a => ex(a, sc, c)); return { s: `${fn}(${args.map(a => a.s).join(", ")})`, t: fn }; }
		// 利用者の関数
		const uf = funcs.get(fn);
		if (uf) {
			const args = e.args.map((a, k) => {
				const pa = uf.params[k];
				if (pa && pa.q !== "in") {
					if (a.k !== "id") throw new Error(`csshader: out/inout argument must be a variable (${fn})`);
					const r = ex(a, sc, c);
					if (r.s.startsWith("(*")) return r.s.slice(2, -1);
					if (!isLocal(sc, a.name)) throw new Error(`csshader: out/inout argument must be a local variable (${fn})`);
					return `&${r.s}`;
				}
				const r = ex(a, sc, c); return pa ? conv(r.s, r.t, pa.type) : r.s;
			});
			return { s: `${fn}(${args.join(", ")})`, t: uf.ret };
		}
		const args = e.args.map(a => ex(a, sc, c));
		const A = args.map(a => a.s), t0 = args[0]?.t ?? "float";
		const T0 = isAbstract(t0) && args[1] && !isAbstract(args[1].t) ? args[1].t : t0;
		const same = (s: string) => ({ s, t: concrete(T0) });
		const flt = (s: string) => ({ s, t: "float" });
		const branch = !c || c.depth > 0;
		const tex = (n: string) => { const m = /^\w+$/.test(n) ? n : null; if (!m || U[m] !== "sampler2D") throw new Error("csshader: texture() needs a sampler2D uniform"); return m; };
		switch (fn) {
			case "texture": case "texture2D": {
				const n = tex(args[0].s);
				return { s: branch ? `textureSampleLevel(cst_${n}, css_${n}, ${A[1]}, 0.0)` : `textureSample(cst_${n}, css_${n}, ${A[1]})`, t: "vec4" };
			}
			case "textureLod": { const n = tex(args[0].s); return { s: `textureSampleLevel(cst_${n}, css_${n}, ${A[1]}, f32(${A[2]}))`, t: "vec4" }; }
			case "texelFetch": { const n = tex(args[0].s); return { s: `textureLoad(cst_${n}, ${A[1]}, ${A[2]})`, t: "vec4" }; }
			case "textureSize": { const n = tex(args[0].s); return { s: `vec2i(textureDimensions(cst_${n}, ${A[1]}))`, t: "ivec2" }; }
			case "abs": case "sign": case "floor": case "ceil": case "fract": case "sin": case "cos": case "tan": case "asin": case "acos": case "exp": case "exp2": case "log": case "log2": case "sqrt":
			case "normalize": case "radians": case "degrees": case "trunc": case "sinh": case "cosh": case "tanh": case "transpose":
				return same(`${fn}(${A[0]})`);
			case "round": case "roundEven": return same(`round(${A[0]})`);
			case "inversesqrt": return same(`inverseSqrt(${A[0]})`);
			case "dFdx": return same(`dpdx(${A[0]})`);
			case "dFdy": return same(`dpdy(${A[0]})`);
			case "fwidth": return same(`fwidth(${A[0]})`);
			case "atan": return args.length === 2 ? same(`atan2(${A[0]}, ${A[1]})`) : same(`atan(${A[0]})`);
			case "pow": return same(`pow(${A[0]}, ${splat(args[1], T0)})`);
			case "mod": return same(`(${A[0]} - ${A[1]} * floor(${A[0]} / ${A[1]}))`);
			case "min": case "max": return nOf(args[1].t) > nOf(args[0].t) ? { s: `${fn}(${splat(args[0], args[1].t)}, ${A[1]})`, t: concrete(args[1].t) } : same(`${fn}(${A[0]}, ${splat(args[1], T0)})`);
			case "clamp": return same(`clamp(${A[0]}, ${splat(args[1], t0)}, ${splat(args[2], t0)})`);
			case "mix": {
				if (baseOf(args[2].t) === "b") return same(`select(${A[0]}, ${A[1]}, ${A[2]})`);
				const T = nOf(args[0].t) >= nOf(args[1].t) ? (isAbstract(args[0].t) ? args[1].t : args[0].t) : args[1].t;
				return { s: `mix(${splat(args[0], T)}, ${splat(args[1], T)}, ${A[2]})`, t: concrete(T) };
			}
			case "step": return { s: `step(${splat(args[0], args[1].t)}, ${A[1]})`, t: concrete(args[1].t) };
			case "smoothstep": return { s: `smoothstep(${splat(args[0], args[2].t)}, ${splat(args[1], args[2].t)}, ${A[2]})`, t: concrete(args[2].t) };
			case "length": return flt(`length(${A[0]})`);
			case "distance": return flt(`distance(${A[0]}, ${A[1]})`);
			case "dot": return flt(`dot(${A[0]}, ${A[1]})`);
			case "determinant": return flt(`determinant(${A[0]})`);
			case "cross": return { s: `cross(${A[0]}, ${A[1]})`, t: "vec3" };
			case "reflect": return same(`reflect(${A[0]}, ${A[1]})`);
			case "refract": return same(`refract(${A[0]}, ${A[1]}, ${A[2]})`);
			case "faceforward": return same(`faceForward(${A[0]}, ${A[1]}, ${A[2]})`);
			case "lessThan": case "lessThanEqual": case "greaterThan": case "greaterThanEqual": case "equal": case "notEqual": {
				const op = { lessThan: "<", lessThanEqual: "<=", greaterThan: ">", greaterThanEqual: ">=", equal: "==", notEqual: "!=" }[fn];
				return { s: `(${A[0]} ${op} ${A[1]})`, t: vecOf("b", nOf(t0)) };
			}
			case "not": return { s: `(!${A[0]})`, t: t0 };
			case "any": case "all": return { s: `${fn}(${A[0]})`, t: "bool" };
			case "czm_srgbToLinear": case "czm_linearToSrgb": return same(`${fn}${nOf(t0)}(${A[0]})`);
			case "czm_luminance": return flt(`czm_luminance(${A[0]})`);
		}
		throw new Error(`csshader: unsupported function '${fn}'`);
	}
}

/** 世界（単位球）→ 目の座標（Cesium の EC＝x 右・y 上・z 後ろ）の回転＝列優先 3x3（u_csV／CU.V）。F・X・Y＝camera.ts viewRays（前・画面の右・画面の上）を直交化 */
export function csViewMat(F: ArrayLike<number>, X: ArrayLike<number>, Y: ArrayLike<number>): Float32Array {
	const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const nrm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return a.map(v => v / l); };
	const f = nrm([F[0], F[1], F[2]]);
	const kx = dot(X, f), r = nrm([X[0] - f[0] * kx, X[1] - f[1] * kx, X[2] - f[2] * kx]);
	const ky = dot(Y, f), kr = dot(Y, r), u = nrm([Y[0] - f[0] * ky - r[0] * kr, Y[1] - f[1] * ky - r[1] * kr, Y[2] - f[2] * ky - r[2] * kr]);
	return Float32Array.of(r[0], u[0], -f[0], r[1], u[1], -f[1], r[2], u[2], -f[2]);
}
/** GL の uniform を型ごとに入れる（値は csPackUniforms と同じ形＝数・数の列・bool） */
export function csGlUniform(gl: WebGL2RenderingContext, l: WebGLUniformLocation | null, t: CsUType, v: unknown): void {
	if (!l) return;
	const a = typeof v === "number" || typeof v === "boolean" ? [Number(v)] : Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v as ArrayLike<number>) : [];
	const n = nOf(t), b = baseOf(t);
	if (isMat(t)) { const k = +t[3]; const m = new Float32Array(k * k); for (let i = 0; i < k * k; i++) m[i] = a[i] ?? 0; (k === 2 ? gl.uniformMatrix2fv : k === 3 ? gl.uniformMatrix3fv : gl.uniformMatrix4fv).call(gl, l, false, m); return; }
	const pad = Array.from({ length: n }, (_, i) => a[i] ?? 0);
	if (b === "f") (gl as unknown as Record<string, (l: WebGLUniformLocation, v: Float32Array) => void>)[`uniform${n}fv`].call(gl, l, Float32Array.from(pad));
	else if (b === "u") (gl as unknown as Record<string, (l: WebGLUniformLocation, v: Uint32Array) => void>)[`uniform${n}uiv`].call(gl, l, Uint32Array.from(pad));
	else (gl as unknown as Record<string, (l: WebGLUniformLocation, v: Int32Array) => void>)[`uniform${n}iv`].call(gl, l, Int32Array.from(pad.map(x => b === "b" ? (x ? 1 : 0) : x | 0)));
}
