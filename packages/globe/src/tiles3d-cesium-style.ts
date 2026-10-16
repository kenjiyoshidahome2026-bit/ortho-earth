// Cesium の 3D Tiles Styling（文字列の式・conditions・defines）を MapLibre の式（tiles3d-style の StyleSpec・origin "native"）に訳す（2026-10-16・DOM なし）。
//   例：{ color: "${height} > 50 ? color('red') : color('white', 0.5)", show: "${kind} !== 'tree'", defines: { tall: "${height} * 2" } }
//       color: { conditions: [["${height} >= 100", "color('purple')"], ["true", "color('#ccc')"]] }
//   式＝JavaScript の部分集合：${名}（${feature.名}・${feature['名']}・defines の名）・数・文字列・true／false／null／undefined・
//   単項 ! - +・二項 * / % + - < <= > >= == != === !== && ||・三項 ?:・関数 color／rgb／rgba／hsl／hsla と Math 系（abs sqrt … clamp mix pow atan2）・
//   Boolean／Number／String・isNaN／isFinite。訳せない物（正規表現・vecN・メンバー参照・未知の関数）は例外（setStyle が受け付けない）。
import { parseRGBA } from "@ortho-earth/core";
import type { StyleSpec } from "./tiles3d-style.ts";

/** Cesium 形のスタイル（読む欄） */
export interface CesiumStyle { color?: string | { conditions?: Array<[string, string]> }; show?: string | boolean | { conditions?: Array<[string, string]> }; defines?: Record<string, string>; meta?: unknown }
type Ex = unknown;

/** Cesium 形か（color／show が文字列・conditions・defines がある） */
export function isCesiumStyle(s: unknown): s is CesiumStyle {
	if (!s || typeof s !== "object" || Array.isArray(s)) return false;
	const o = s as Record<string, unknown>, cesiumish = (v: unknown) => typeof v === "string" || (!!v && typeof v === "object" && !Array.isArray(v) && "conditions" in v);
	return "defines" in o || cesiumish(o.color) || cesiumish(o.show);
}

/** Cesium 形 → StyleSpec（origin "native"＝JS に近い寛容な比較・真偽） */
export function cesiumToSpec(s: CesiumStyle): StyleSpec {
	const defs = new Map<string, Ex>(), defSrc = s.defines || {}, busy = new Set<string>();
	const varOf = (name: string): Ex => {   // defines は使う時に訳す（defines から defines を引いてよい・循環は例外）
		if (!Object.prototype.hasOwnProperty.call(defSrc, name)) return ["get", name];
		if (defs.has(name)) return defs.get(name);
		if (busy.has(name)) throw new Error(`defines: cycle at ${name}`);
		busy.add(name); const e = parseExpr(String(defSrc[name]), varOf); busy.delete(name); defs.set(name, e); return e;
	};
	const one = (v: unknown, what: string): Ex => {
		if (typeof v === "boolean") return v;
		if (typeof v === "string") return parseExpr(v, varOf);
		if (v && typeof v === "object" && Array.isArray((v as { conditions?: unknown }).conditions)) {
			const out: Ex[] = ["case"];
			for (const c of (v as { conditions: unknown[] }).conditions) {
				if (!Array.isArray(c) || c.length !== 2) throw new Error(`${what}.conditions: bad shape`);
				out.push(parseExpr(String(c[0]), varOf), parseExpr(String(c[1]), varOf));
			}
			out.push(null);   // どれにも当たらない＝元のまま（Cesium は既定の色・見せる）
			return out;
		}
		throw new Error(`${what}: bad shape`);
	};
	const spec: StyleSpec = { origin: "native" };
	if (s.color != null) spec.color = one(s.color, "color");
	if (s.show != null) spec.show = one(s.show, "show");
	return spec;
}

// ── 字句
type Tok = { t: "num"; v: number } | { t: "str"; v: string } | { t: "var"; v: string } | { t: "id"; v: string } | { t: "op"; v: string };
const OPS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<", ">", "+", "-", "*", "/", "%", "!", "?", ":", "(", ")", ",", "."];
function lex(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
		if (c === "$" && src[i + 1] === "{") {   // ${名}・${feature.名}・${feature['名']}
			const e = src.indexOf("}", i + 2); if (e < 0) throw new Error("expr: unclosed ${");
			let name = src.slice(i + 2, e).trim();
			const m = /^feature(?:\.(.+)|\[\s*(['"])(.*)\2\s*\])$/.exec(name); if (m) name = m[1] ?? m[3];
			out.push({ t: "var", v: name }); i = e + 1; continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1, s = "";
			while (j < src.length && src[j] !== c) { if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; } else s += src[j++]; }
			if (j >= src.length) throw new Error("expr: unclosed string");
			out.push({ t: "str", v: s }); i = j + 1; continue;
		}
		if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
			const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))!;
			out.push({ t: "num", v: +m[0] }); i += m[0].length; continue;
		}
		if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++; out.push({ t: "id", v: src.slice(i, j) }); i = j; continue; }
		const op = OPS.find(o => src.startsWith(o, i));
		if (!op) throw new Error(`expr: unexpected character ${c}`);
		out.push({ t: "op", v: op }); i += op.length;
	}
	return out;
}

// ── 構文（優先順位つきの再帰下降）→ MapLibre の式
const BIN: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, "===": 3, "!==": 3, "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6 };
const isStr = (e: Ex) => typeof e === "string" || (Array.isArray(e) && (e[0] === "concat" || e[0] === "to-string"));
export function parseExpr(src: string, varOf: (name: string) => Ex = n => ["get", n]): Ex {
	const toks = lex(src);
	let p = 0;
	const peek = () => toks[p], isOp = (v: string) => toks[p]?.t === "op" && toks[p].v === v;
	const expect = (v: string) => { if (!isOp(v)) throw new Error(`expr: expected ${v} (${src})`); p++; };
	const ternary = (): Ex => {
		const c = binary(0);
		if (!isOp("?")) return c;
		p++; const a = ternary(); expect(":"); const b = ternary();
		return ["case", c, a, b];
	};
	const binary = (min: number): Ex => {
		let l = unary();
		for (;;) {
			const t = peek(); if (t?.t !== "op" || !(t.v in BIN) || BIN[t.v] <= min) return l;
			p++; const r = binary(BIN[t.v]);
			l = t.v === "||" ? ["any", l, r] : t.v === "&&" ? ["all", l, r] : t.v === "===" || t.v === "==" ? ["==", l, r] : t.v === "!==" || t.v === "!=" ? ["!=", l, r]
				: t.v === "+" && (isStr(l) || isStr(r)) ? ["concat", l, r] : [t.v, l, r];
		}
	};
	const unary = (): Ex => {
		if (isOp("!")) { p++; return ["!", unary()]; }
		if (isOp("-")) { p++; const a = unary(); return typeof a === "number" ? -a : ["-", 0, a]; }
		if (isOp("+")) { p++; return ["to-number", unary()]; }
		return primary();
	};
	const args = (): Ex[] => { expect("("); const a: Ex[] = []; if (!isOp(")")) { a.push(ternary()); while (isOp(",")) { p++; a.push(ternary()); } } expect(")"); return a; };
	const primary = (): Ex => {
		const t = toks[p++];
		if (!t) throw new Error(`expr: unexpected end (${src})`);
		if (t.t === "num" || t.t === "str") return t.v;
		if (t.t === "var") return varOf(t.v);
		if (t.t === "op" && t.v === "(") { const e = ternary(); expect(")"); return e; }
		if (t.t === "id") {
			switch (t.v) {
				case "true": return true; case "false": return false; case "null": case "undefined": return null;
				case "NaN": return NaN; case "Infinity": return Infinity;
				case "Math": { expect("."); const k = toks[p++]; if (k?.t !== "id") throw new Error("expr: Math."); return call(k.v, isOp("(") ? args() : null); }
			}
			if (isOp("(")) return call(t.v, args());
		}
		throw new Error(`expr: unsupported ${t.v} (${src})`);
	};
	const e = ternary();
	if (p < toks.length) throw new Error(`expr: trailing input (${src})`);
	return e;
}
// 関数・定数 → MapLibre の式
function call(name: string, a: Ex[] | null): Ex {
	const n = (k: number) => { if (!a || a.length < k) throw new Error(`expr: arguments of ${name}`); return a; };
	switch (name) {
		case "PI": return ["pi"]; case "E": return ["e"];
		case "color": {   // color()＝白・color(名か #hex[, α])
			if (!a || !a.length) return "#ffffff";
			const [c, al] = a;
			if (typeof c === "string") { const v = parseRGBA(c); return al == null ? c : ["rgba", Math.round(v[0] * 255), Math.round(v[1] * 255), Math.round(v[2] * 255), al]; }
			return al == null ? ["to-color", c] : ["let", "c", ["to-rgba", ["to-color", c]], ["rgba", ["at", 0, ["var", "c"]], ["at", 1, ["var", "c"]], ["at", 2, ["var", "c"]], al]];
		}
		case "rgb": { n(3); return ["rgb", a![0], a![1], a![2]]; }
		case "rgba": { n(4); return ["rgba", a![0], a![1], a![2], a![3]]; }
		case "hsl": case "hsla": {   // h・s・l は 0..1（Cesium）→ CSS の hsl() 文字列を to-color
			n(name === "hsl" ? 3 : 4);
			const pct = (x: Ex) => ["*", x, 100];
			return ["to-color", ["concat", "hsla(", ["*", a![0], 360], ",", pct(a![1]), "%,", pct(a![2]), "%,", name === "hsl" ? 1 : a![3], ")"]];
		}
		case "abs": case "floor": case "ceil": case "round": case "sqrt": case "sin": case "cos": case "tan": case "asin": case "acos": case "atan": case "log2": { n(1); return [name, a![0]]; }
		case "log": { n(1); return ["ln", a![0]]; }
		case "exp": { n(1); return ["^", ["e"], a![0]]; }
		case "exp2": { n(1); return ["^", 2, a![0]]; }
		case "pow": { n(2); return ["^", a![0], a![1]]; }
		case "min": case "max": { n(2); return [name, ...a!]; }
		case "clamp": { n(3); return ["max", a![1], ["min", a![2], a![0]]]; }
		case "mix": { n(3); return ["+", a![0], ["*", ["-", a![1], a![0]], a![2]]]; }
		case "sign": { n(1); return ["case", [">", a![0], 0], 1, ["<", a![0], 0], -1, 0]; }
		case "fract": { n(1); return ["-", a![0], ["floor", a![0]]]; }
		case "radians": { n(1); return ["*", a![0], Math.PI / 180]; }
		case "degrees": { n(1); return ["*", a![0], 180 / Math.PI]; }
		case "atan2": { n(2); return ["let", "y", a![0], "x", a![1], ["case", [">", ["var", "x"], 0], ["atan", ["/", ["var", "y"], ["var", "x"]]],
			["all", ["<", ["var", "x"], 0], [">=", ["var", "y"], 0]], ["+", ["atan", ["/", ["var", "y"], ["var", "x"]]], ["pi"]],
			["<", ["var", "x"], 0], ["-", ["atan", ["/", ["var", "y"], ["var", "x"]]], ["pi"]],
			[">", ["var", "y"], 0], ["/", ["pi"], 2], ["<", ["var", "y"], 0], ["-", 0, ["/", ["pi"], 2]], 0]]; }
		case "Boolean": { n(1); return ["to-boolean", a![0]]; }
		case "Number": { n(1); return ["to-number", a![0]]; }
		case "String": { n(1); return ["to-string", a![0]]; }
		case "isNaN": { n(1); return ["let", "v", ["to-number", a![0]], ["!=", ["var", "v"], ["var", "v"]]]; }
		case "isFinite": { n(1); return ["let", "v", ["to-number", a![0]], ["all", ["==", ["var", "v"], ["var", "v"]], ["<", ["abs", ["var", "v"]], Infinity]]]; }
	}
	throw new Error(`expr: unsupported function ${name}`);
}
