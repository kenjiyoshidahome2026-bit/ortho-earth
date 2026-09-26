// MapLibre GL style 式インタプリタ（地理院 optimal_bvmap std.json が使う部分集合＋外来 style.json の常用分＝#33 2026-09-23）。
// node で実タイル/実スタイルに対し検証済み（全123層のfilter・paintが未知opゼロで評価される）。
// filter も paint も同一の評価器で処理する（std.json は全て現代式＝レガシーfilter無し）。
//
// 評価はツリーウォークでなくプリコンパイル方式：各式ノードを一度だけクロージャ木へコンパイルし
// （WeakMap でノード単位にキャッシュ）、以後の評価は switch ディスパッチ・slice・毎回のクロージャ生成
// なしの直接関数呼び出しになる。style オブジェクトは全タイルで同一identity＝初回コンパイルのみ、
// 以後は feature 毎にコンパイル済み関数を呼ぶだけ。意味論は旧インタプリタと完全一致（node で全出力突合済み）。

import { parseRGBA, isColor } from "./color.js";

// 色の補間（interpolate の出力が色文字列の時・#33）＝rgba の各成分を線形に。出力は "rgba(r,g,b,a)"（parseRGBA が読む形）
const lerpColor = (a, b, t) => { const p = parseRGBA(a), q = parseRGBA(b); const c = i => p[i] + t * (q[i] - p[i]); return `rgba(${Math.round(c(0) * 255)},${Math.round(c(1) * 255)},${Math.round(c(2) * 255)},${+c(3).toFixed(4)})`; };
const lerpAny = (y0, y1, t) => typeof y0 === "number" && typeof y1 === "number" ? y0 + t * (y1 - y0)
	: typeof y0 === "string" && typeof y1 === "string" ? lerpColor(y0, y1, t)
	: Array.isArray(y0) && Array.isArray(y1) && y0.length === y1.length ? y0.map((v, i) => lerpAny(v, y1[i], t))
	: t < 0.5 ? y0 : y1;
const TYPE_OF = v => v == null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v;
// 1 引数の数学関数（abs…atan）＝名前で引く表（switch の case と同じ名前だけ・動的な Math[op] を使わない＝CodeQL js/unvalidated-dynamic-method-call）
const MATH1 = new Map([["abs", Math.abs], ["floor", Math.floor], ["ceil", Math.ceil], ["round", Math.round], ["sqrt", Math.sqrt], ["log10", Math.log10], ["log2", Math.log2], ["sin", Math.sin], ["cos", Math.cos], ["tan", Math.tan], ["asin", Math.asin], ["acos", Math.acos], ["atan", Math.atan]]);

export function truthy(v) {
	return v !== false && v != null && v !== 0 && v !== "" && !(typeof v === "number" && isNaN(v));
}

// ── 出自（2026-09-26・MapLibre 互換の台帳 maplibre-compat.md の約束 4）────────────────────────
// ctx.origin === "ml"＝MapLibre の文書から来た式（style.json・addLayer・ML 形 gadget＝normalizeMLLayer が層に印 metadata["ortho:origin"]:"ml"）。
// ML の出自だけ MapLibre の型の約束で評価する：型の合わない大小比較・真偽でない条件（! all any case）・数でない interpolate/step の入力・
// 型の表明（number/string/boolean/object/array/to-color）が外れた時は「評価エラー」＝evalExpr が undefined を返す（filter＝偽・paint＝既定値）。
// get は欠損を null で返す（MapLibre と同じ）。to-number は予備の引数へ落ちる。
// ネイティブ（map.paint・addGint・内蔵の基図 style）は従来の寛容な意味のまま＝tests/gint-expr.mjs の契約・globe の expr-golden が見張る。
// 新しい演算子（at・三角関数・to-rgba・cubic-bezier・index-of の開始位置・get/has の object）は両方に足した（足し算は衝突しない）。
// コンパイルの cache は出自ごと＝同じ配列が両方の評価器に入っても混ざらない。
const caches = { native: new WeakMap(), ml: new WeakMap() };   // 式ノード(配列) → コンパイル済み fn(ctx)
const ML_ERR = { mlEvalError: true };   // ML の評価エラー（評価の外へは出さない＝evalExpr が undefined に畳む）
const mlFail = () => { throw ML_ERR; };
const bool = v => typeof v === "boolean" ? v : mlFail();   // ML：条件（! all any case）は真偽だけ
const ord = (x, y) => { if (!((typeof x === "number" && typeof y === "number") || (typeof x === "string" && typeof y === "string"))) mlFail(); };   // ML：大小比較は数どうし・文字列どうしだけ
export const originOfCtx = ctx => ctx?.origin === "ml" ? "ml" : "native";
// 層の出自の印（平の性質＝postMessage で worker へ渡っても残る）。normalizeMLLayer が付ける。評価する所は ctx.origin = originOfLayer(L)
export const ORIGIN_KEY = "ortho:origin";
export const originOfLayer = L => L?.metadata?.[ORIGIN_KEY] === "ml" ? "ml" : undefined;

// 式 e を fn(ctx)=>value にコンパイル。リテラル（非配列 or 先頭が文字列でない＝タプル）は定数関数。
function compile(e, o = "native") {
	if (!Array.isArray(e) || typeof e[0] !== "string") return () => e;
	const cache = caches[o];
	let fn = cache.get(e);
	if (fn === undefined) { fn = build(e, o); cache.set(e, fn); }
	return fn;
}

// e: 式（配列 or リテラル）, ctx: { zoom, props, geom, vars, origin? }
// リテラルは即返し（クロージャ生成なし）＝呼び出し側が直接リテラルを渡す場合のアロケーションを避ける。
export function evalExpr(e, ctx) {
	if (!Array.isArray(e) || typeof e[0] !== "string") return e;
	const o = originOfCtx(ctx), cache = caches[o];
	let fn = cache.get(e);
	if (fn === undefined) { fn = build(e, o); cache.set(e, fn); }
	if (o === "native") return fn(ctx);
	try { return fn(ctx); } catch (err) { if (err === ML_ERR) return undefined; throw err; }
}

// 評価器が知っている演算子（build の case と同じ顔ぶれ＝tests/mlcompat.mjs の op-known-matches-build が突き合わせる）
export const KNOWN_OPS = new Set(["literal", "get", "has", "!", "all", "any", "==", "!=", ">", ">=", "<", "<=", "in", "geometry-type", "zoom", "match", "step", "case", "let", "var", "interpolate", "+", "-", "*", "/", "%", "^", "min", "max", "to-number", "coalesce", "feature-state", "concat", "to-string", "interpolate-hcl", "interpolate-lab", "id", "properties", "to-boolean", "to-color", "string", "number", "boolean", "object", "array", "rgb", "rgba", "typeof", "downcase", "upcase", "length", "slice", "index-of", "abs", "floor", "ceil", "round", "sqrt", "log10", "log2", "sin", "cos", "tan", "asin", "acos", "atan", "at", "to-rgba", "ln", "e", "pi", "image", "format", "number-format", "is-supported-script", "resolved-locale", "collator", "accumulated", "line-progress", "heatmap-density"]);

// MapLibre 形の式の検査＝知らない演算子を集める（MapLibre は addLayer でその名を挙げて層を足さない・2026-09-26 段 5）。
// 式の位置だけを見る：literal の中・match のラベル・interpolate の補間型と停留値・step の閾値・let の名前・var・format/number-format/collator の設定は式でない。
// 先頭が文字列でない配列（[2, 2] など）はデータ＝中を見ない
export function unknownOps(e, out = new Set()) {
	if (!Array.isArray(e) || typeof e[0] !== "string") return out;
	const op = e[0], x = v => unknownOps(v, out);
	if (!KNOWN_OPS.has(op)) out.add(op);
	switch (op) {
		case "literal": case "var": case "collator": return out;
		case "match": { x(e[1]); for (let i = 3; i < e.length - 1; i += 2) x(e[i]); x(e[e.length - 1]); return out; }
		case "interpolate": case "interpolate-hcl": case "interpolate-lab": { x(e[2]); for (let i = 4; i < e.length; i += 2) x(e[i]); return out; }
		case "step": { x(e[1]); x(e[2]); for (let i = 4; i < e.length; i += 2) x(e[i]); return out; }
		case "let": { for (let i = 2; i < e.length - 1; i += 2) x(e[i]); x(e[e.length - 1]); return out; }
		case "format": { for (let i = 1; i < e.length; i++) if (!(e[i] && typeof e[i] === "object" && !Array.isArray(e[i]))) x(e[i]); return out; }
		case "number-format": { x(e[1]); return out; }
		default: for (let i = 1; i < e.length; i++) x(e[i]); return out;
	}
}

// cubic-bezier の緩急（x1,y1,x2,y2）＝t（x）→ y。Newton＋二分で x を解く（CSS の cubic-bezier と同じ）
function cubicBezier(x1, y1, x2, y2) {
	const bx = t => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3, by = t => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
	const dx = t => 3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
	return x => {
		if (x <= 0) return 0; if (x >= 1) return 1;
		let t = x;
		for (let i = 0; i < 8; i++) { const d = dx(t), f = bx(t) - x; if (Math.abs(f) < 1e-7) return by(t); if (Math.abs(d) < 1e-6) break; t -= f / d; }
		let lo = 0, hi = 1; t = x;
		for (let i = 0; i < 40; i++) { const f = bx(t); if (Math.abs(f - x) < 1e-7) break; if (f < x) lo = t; else hi = t; t = (lo + hi) / 2; }
		return by(t);
	};
}

// 式ノード → クロージャ。子式は compile() で一度だけ関数化して捕獲する（switch は compile 時に1回だけ通る）。
function build(e, o = "native") {
	const op = e[0], ML = o === "ml";
	const compile_ = x => compile(x, o);
	switch (op) {
		case "literal": { const v = e[1]; return () => v; }
		case "get": {
			const k = compile_(e[1]), ob = e.length > 2 ? compile_(e[2]) : null;   // ["get", key, object]（両方・2026-09-26）
			if (ML) return ctx => { const src = ob ? ob(ctx) : ctx.props; const v = src == null ? undefined : src[k(ctx)]; return v === undefined ? null : v; };   // MapLibre＝欠損は null
			return ob ? ctx => { const src = ob(ctx); return src == null ? undefined : src[k(ctx)]; } : ctx => ctx.props[k(ctx)];
		}
		case "has": {
			const k = compile_(e[1]), ob = e.length > 2 ? compile_(e[2]) : null;
			return ob ? ctx => { const src = ob(ctx); return src != null && typeof src === "object" && k(ctx) in src; } : ctx => k(ctx) in ctx.props;
		}
		case "!": { const a = compile_(e[1]); return ML ? ctx => !bool(a(ctx)) : ctx => !truthy(a(ctx)); }
		case "all": { const xs = e.slice(1).map(compile_); return ML ? ctx => { for (const f of xs) if (!bool(f(ctx))) return false; return true; } : ctx => { for (const f of xs) if (!truthy(f(ctx))) return false; return true; }; }
		case "any": { const xs = e.slice(1).map(compile_); return ML ? ctx => { for (const f of xs) if (bool(f(ctx))) return true; return false; } : ctx => { for (const f of xs) if (truthy(f(ctx))) return true; return false; }; }
		case "==": { const a = compile_(e[1]), b = compile_(e[2]); return ctx => a(ctx) === b(ctx); }
		case "!=": { const a = compile_(e[1]), b = compile_(e[2]); return ctx => a(ctx) !== b(ctx); }
		case ">": { const a = compile_(e[1]), b = compile_(e[2]); return ML ? ctx => { const x = a(ctx), y = b(ctx); ord(x, y); return x > y; } : ctx => a(ctx) > b(ctx); }
		case ">=": { const a = compile_(e[1]), b = compile_(e[2]); return ML ? ctx => { const x = a(ctx), y = b(ctx); ord(x, y); return x >= y; } : ctx => a(ctx) >= b(ctx); }
		case "<": { const a = compile_(e[1]), b = compile_(e[2]); return ML ? ctx => { const x = a(ctx), y = b(ctx); ord(x, y); return x < y; } : ctx => a(ctx) < b(ctx); }
		case "<=": { const a = compile_(e[1]), b = compile_(e[2]); return ML ? ctx => { const x = a(ctx), y = b(ctx); ord(x, y); return x <= y; } : ctx => a(ctx) <= b(ctx); }
		case "in": {
			const a = compile_(e[1]), b = compile_(e[2]);
			return ctx => { const v = a(ctx), c = b(ctx); return Array.isArray(c) ? c.includes(v) : typeof c === "string" ? c.includes(v) : false; };
		}
		case "geometry-type": return ctx => ctx.geom;
		case "zoom": return ctx => ctx.zoom;
		case "match": {
			const vf = compile_(e[1]), labs = [], outs = [];
			for (let i = 2; i < e.length - 1; i += 2) { labs.push(e[i]); outs.push(compile_(e[i + 1])); }
			const def = compile_(e[e.length - 1]);
			return ctx => {
				const v = vf(ctx);
				for (let i = 0; i < labs.length; i++) { const lab = labs[i]; if (Array.isArray(lab) ? lab.includes(v) : lab === v) return outs[i](ctx); }
				return def(ctx);
			};
		}
		case "step": {
			const vf = compile_(e[1]), outs = [compile_(e[2])], ths = [];
			for (let i = 3; i < e.length; i += 2) { ths.push(e[i]); outs.push(compile_(e[i + 1])); }
			return ctx => { const v = vf(ctx); if (ML && typeof v !== "number") mlFail(); let k = 0; for (let i = 0; i < ths.length; i++) { if (v >= ths[i]) k = i + 1; else break; } return outs[k](ctx); };
		}
		case "case": {
			const conds = [], vals = [];
			for (let i = 1; i < e.length - 1; i += 2) { conds.push(compile_(e[i])); vals.push(compile_(e[i + 1])); }
			const def = compile_(e[e.length - 1]);
			if (ML) return ctx => { for (let i = 0; i < conds.length; i++) if (bool(conds[i](ctx))) return vals[i](ctx); return def(ctx); };
			return ctx => { for (let i = 0; i < conds.length; i++) if (truthy(conds[i](ctx))) return vals[i](ctx); return def(ctx); };
		}
		case "let": {
			const names = [], vfs = [];
			for (let i = 1; i < e.length - 1; i += 2) { names.push(e[i]); vfs.push(compile_(e[i + 1])); }
			const body = compile_(e[e.length - 1]);
			return ctx => {
				const vars = Object.assign({}, ctx.vars), c2 = { ...ctx, vars };
				for (let i = 0; i < names.length; i++) vars[names[i]] = vfs[i](c2);
				return body(c2);
			};
		}
		case "var": { const name = e[1]; return ctx => ctx.vars[name]; }
		case "interpolate": {
			const type = e[1], inf = compile_(e[2]), sk = [], sv = [];
			for (let i = 3; i < e.length; i += 2) { sk.push(e[i]); sv.push(compile_(e[i + 1])); }
			const n = sk.length, expo = type[0] === "exponential", base = expo ? type[1] : 1;
			const bez = type[0] === "cubic-bezier" ? cubicBezier(type[1], type[2], type[3], type[4]) : null;   // 両方（2026-09-26・旧＝黙って線形）
			return ctx => {
				const input = inf(ctx);
				if (ML && typeof input !== "number") mlFail();
				if (input <= sk[0]) return sv[0](ctx);
				if (input >= sk[n - 1]) return sv[n - 1](ctx);
				let k = 0; while (k < n - 1 && sk[k + 1] <= input) k++;
				const x0 = sk[k], x1 = sk[k + 1], y0 = sv[k](ctx), y1 = sv[k + 1](ctx);
				let t = (input - x0) / (x1 - x0);
				if (expo && base !== 1) t = (Math.pow(base, input - x0) - 1) / (Math.pow(base, x1 - x0) - 1);
				else if (bez) t = bez(t);
				return typeof y0 === "number" && typeof y1 === "number" ? y0 + t * (y1 - y0) : lerpAny(y0, y1, t);   // 色（文字列）・配列も補間（#33）
			};
		}
		case "+": { const xs = e.slice(1).map(compile_); return ctx => { let s = 0; for (const f of xs) s += f(ctx); return s; }; }
		case "-": { if (e.length === 2) { const a = compile_(e[1]); return ctx => -a(ctx); } const a = compile_(e[1]), b = compile_(e[2]); return ctx => a(ctx) - b(ctx); }
		case "*": { const xs = e.slice(1).map(compile_); return ctx => { let s = 1; for (const f of xs) s *= f(ctx); return s; }; }
		case "/": { const a = compile_(e[1]), b = compile_(e[2]); return ctx => a(ctx) / b(ctx); }
		case "%": { const a = compile_(e[1]), b = compile_(e[2]); return ctx => a(ctx) % b(ctx); }
		case "^": { const a = compile_(e[1]), b = compile_(e[2]); return ctx => Math.pow(a(ctx), b(ctx)); }
		case "min": { const xs = e.slice(1).map(compile_); return ctx => { let m = Infinity; for (const f of xs) { const v = f(ctx); if (v < m) m = v; } return m; }; }
		case "max": { const xs = e.slice(1).map(compile_); return ctx => { let m = -Infinity; for (const f of xs) { const v = f(ctx); if (v > m) m = v; } return m; }; }
		case "to-number": {
			const xs = e.slice(1).map(compile_);
			// ML：null/false＝0・true＝1・文字列は数へ・読めなければ次の引数へ・どれも読めなければ評価エラー（予備の引数＝["to-number", x, 0]）
			if (ML) return ctx => { for (const f of xs) { const v = f(ctx); if (v == null || v === false) return 0; if (v === true) return 1; const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; if (!Number.isNaN(n)) return n; } return mlFail(); };
			const a = xs[0]; return ctx => Number(a(ctx));
		}
		case "coalesce": { const xs = e.slice(1).map(compile_); return ctx => { for (const f of xs) { const v = f(ctx); if (v != null) return v; } return null; }; }
		case "feature-state": { const k = compile_(e[1]); return ctx => ctx.state?.[k(ctx)]; }   // 層の一時状態（hover/選択…）＝gint layer.setFeatureState。基図 ctx は state 無し＝undefined（無害）
		case "concat": { const xs = e.slice(1).map(compile_); return ctx => xs.map(f => f(ctx) ?? "").join(""); }   // text-field 用（maplibre 同名）
		case "to-string": { const a = compile_(e[1]); return ctx => { const v = a(ctx); return v == null ? "" : String(v); }; }
		// ── 外来 style.json の常用分（#33・2026-09-23）──
		case "interpolate-hcl": case "interpolate-lab": return build(["interpolate", ...e.slice(1)], o);   // 色空間の違いは rgb の線形で近似
		case "id": return ctx => ctx.id;
		case "properties": return ctx => ctx.props;
		case "to-boolean": { const a = compile_(e[1]); return ctx => truthy(a(ctx)); }
		case "to-color": case "string": case "number": case "boolean": case "object": case "array": {
			const xs = op === "array" ? [compile_(e[e.length - 1])] : e.slice(1).map(compile_);   // array は ["array", 型?, 長さ?, 値]＝値だけ
			if (ML) {   // MapLibre：型が合う最初の引数・どれも合わなければ評価エラー（["number", ["get","x"], 0] の 0 が効く）
				const ok = op === "string" ? v => typeof v === "string" : op === "number" ? v => typeof v === "number" : op === "boolean" ? v => typeof v === "boolean"
					: op === "object" ? v => v != null && typeof v === "object" && !Array.isArray(v) : op === "array" ? Array.isArray : isColor;
				return ctx => { for (const f of xs) { const v = f(ctx); if (ok(v)) return v; } return mlFail(); };
			}
			return ctx => { for (const f of xs) { const v = f(ctx); if (v != null) return v; } return null; };   // ネイティブ＝最初に null でないもの（簡略）
		}
		case "rgb": case "rgba": { const xs = e.slice(1).map(compile_); return ctx => { const v = xs.map(f => f(ctx)); return `rgba(${v[0]},${v[1]},${v[2]},${v[3] ?? 1})`; }; }
		case "typeof": { const a = compile_(e[1]); return ctx => TYPE_OF(a(ctx)); }
		case "downcase": { const a = compile_(e[1]); return ctx => String(a(ctx) ?? "").toLowerCase(); }
		case "upcase": { const a = compile_(e[1]); return ctx => String(a(ctx) ?? "").toUpperCase(); }
		case "length": { const a = compile_(e[1]); return ctx => { const v = a(ctx); return v == null ? 0 : v.length ?? 0; }; }
		case "slice": { const a = compile_(e[1]), b = compile_(e[2]), c = e.length > 3 ? compile_(e[3]) : null; return ctx => { const v = a(ctx); return v == null ? v : v.slice(b(ctx), c ? c(ctx) : undefined); }; }
		case "index-of": { const a = compile_(e[1]), b = compile_(e[2]), c = e.length > 3 ? compile_(e[3]) : null; return ctx => { const h = b(ctx); return h == null ? -1 : h.indexOf(a(ctx), c ? c(ctx) : undefined); }; }   // 開始位置（2026-09-26）
		case "abs": case "floor": case "ceil": case "round": case "sqrt": case "log10": case "log2":
		case "sin": case "cos": case "tan": case "asin": case "acos": case "atan": { const a = compile_(e[1]), f = MATH1.get(op); if (typeof f !== "function") return () => undefined; return ctx => f(a(ctx)); }   // 三角関数（2026-09-26）・関数は名前で引く表（動的な Math[op] を使わない・呼ぶ前に関数か確かめる＝CodeQL）
		case "at": {   // ["at", 添字, 配列]（2026-09-26）
			const i = compile_(e[1]), a = compile_(e[2]);
			return ctx => { const arr = a(ctx), k = i(ctx); if (ML && (!Array.isArray(arr) || !Number.isInteger(k) || k < 0 || k >= arr.length)) mlFail(); return Array.isArray(arr) ? arr[k] : undefined; };
		}
		case "to-rgba": {   // 色 → [r, g, b(0-255), a(0-1)]（2026-09-26）
			const a = compile_(e[1]);
			return ctx => { const v = a(ctx); if (ML && !isColor(v)) mlFail(); const c = parseRGBA(v); return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255), c[3]]; };
		}
		case "ln": { const a = compile_(e[1]); return ctx => Math.log(a(ctx)); }
		case "e": return () => Math.E;
		case "pi": return () => Math.PI;
		case "image": { const a = compile_(e[1]); return ctx => a(ctx); }   // 記号の名前をそのまま（記号帳が引く）
		case "format": {   // 書式つき文字列＝文字だけを連結（書体・大きさの指定は捨てる）
			const parts = []; for (let i = 1; i < e.length; i++) { const x = e[i]; if (x && typeof x === "object" && !Array.isArray(x)) continue; parts.push(compile_(x)); }
			return ctx => parts.map(f => { const v = f(ctx); return v == null ? "" : String(v); }).join("");
		}
		case "number-format": { const a = compile_(e[1]), nf = e[2] || {}; return ctx => { const v = a(ctx); return v == null ? "" : Number(v).toLocaleString(nf.locale || undefined, { minimumFractionDigits: nf["min-fraction-digits"], maximumFractionDigits: nf["max-fraction-digits"] }); }; }
		case "is-supported-script": return () => true;
		case "resolved-locale": return () => (typeof navigator !== "undefined" && navigator.language) || "en";
		case "collator": return () => null;
		case "accumulated": case "line-progress": case "heatmap-density": return ctx => ctx.vars?.[op] ?? 0;
		default: (globalThis.__orthovtUnknownOps ||= new Set()).add(op); return () => undefined;
	}
}
