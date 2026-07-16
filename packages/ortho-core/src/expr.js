// MapLibre GL style 式インタプリタ（地理院 optimal_bvmap std.json が使う部分集合）。
// node で実タイル/実スタイルに対し検証済み（全123層のfilter・paintが未知opゼロで評価される）。
// filter も paint も同一の評価器で処理する（std.json は全て現代式＝レガシーfilter無し）。
//
// 評価はツリーウォークでなくプリコンパイル方式：各式ノードを一度だけクロージャ木へコンパイルし
// （WeakMap でノード単位にキャッシュ）、以後の評価は switch ディスパッチ・slice・毎回のクロージャ生成
// なしの直接関数呼び出しになる。style オブジェクトは全タイルで同一identity＝初回コンパイルのみ、
// 以後は feature 毎にコンパイル済み関数を呼ぶだけ。意味論は旧インタプリタと完全一致（node で全出力突合済み）。

export function truthy(v) {
	return v !== false && v != null && v !== 0 && v !== "" && !(typeof v === "number" && isNaN(v));
}

const cache = new WeakMap();   // 式ノード(配列) → コンパイル済み fn(ctx)

// 式 e を fn(ctx)=>value にコンパイル。リテラル（非配列 or 先頭が文字列でない＝タプル）は定数関数。
function compile(e) {
	if (!Array.isArray(e) || typeof e[0] !== "string") return () => e;
	let fn = cache.get(e);
	if (fn === undefined) { fn = build(e); cache.set(e, fn); }
	return fn;
}

// e: 式（配列 or リテラル）, ctx: { zoom, props, geom, vars }
// リテラルは即返し（クロージャ生成なし）＝呼び出し側が直接リテラルを渡す場合のアロケーションを避ける。
export function evalExpr(e, ctx) {
	if (!Array.isArray(e) || typeof e[0] !== "string") return e;
	let fn = cache.get(e);
	if (fn === undefined) { fn = build(e); cache.set(e, fn); }
	return fn(ctx);
}

// 式ノード → クロージャ。子式は compile() で一度だけ関数化して捕獲する（switch は compile 時に1回だけ通る）。
function build(e) {
	const op = e[0];
	switch (op) {
		case "literal": { const v = e[1]; return () => v; }
		case "get": { const k = compile(e[1]); return ctx => ctx.props[k(ctx)]; }
		case "has": { const k = compile(e[1]); return ctx => k(ctx) in ctx.props; }
		case "!": { const a = compile(e[1]); return ctx => !truthy(a(ctx)); }
		case "all": { const xs = e.slice(1).map(compile); return ctx => { for (const f of xs) if (!truthy(f(ctx))) return false; return true; }; }
		case "any": { const xs = e.slice(1).map(compile); return ctx => { for (const f of xs) if (truthy(f(ctx))) return true; return false; }; }
		case "==": { const a = compile(e[1]), b = compile(e[2]); return ctx => a(ctx) === b(ctx); }
		case "!=": { const a = compile(e[1]), b = compile(e[2]); return ctx => a(ctx) !== b(ctx); }
		case ">": { const a = compile(e[1]), b = compile(e[2]); return ctx => a(ctx) > b(ctx); }
		case ">=": { const a = compile(e[1]), b = compile(e[2]); return ctx => a(ctx) >= b(ctx); }
		case "<": { const a = compile(e[1]), b = compile(e[2]); return ctx => a(ctx) < b(ctx); }
		case "<=": { const a = compile(e[1]), b = compile(e[2]); return ctx => a(ctx) <= b(ctx); }
		case "in": {
			const a = compile(e[1]), b = compile(e[2]);
			return ctx => { const v = a(ctx), c = b(ctx); return Array.isArray(c) ? c.includes(v) : typeof c === "string" ? c.includes(v) : false; };
		}
		case "geometry-type": return ctx => ctx.geom;
		case "zoom": return ctx => ctx.zoom;
		case "match": {
			const vf = compile(e[1]), labs = [], outs = [];
			for (let i = 2; i < e.length - 1; i += 2) { labs.push(e[i]); outs.push(compile(e[i + 1])); }
			const def = compile(e[e.length - 1]);
			return ctx => {
				const v = vf(ctx);
				for (let i = 0; i < labs.length; i++) { const lab = labs[i]; if (Array.isArray(lab) ? lab.includes(v) : lab === v) return outs[i](ctx); }
				return def(ctx);
			};
		}
		case "step": {
			const vf = compile(e[1]), outs = [compile(e[2])], ths = [];
			for (let i = 3; i < e.length; i += 2) { ths.push(e[i]); outs.push(compile(e[i + 1])); }
			return ctx => { const v = vf(ctx); let k = 0; for (let i = 0; i < ths.length; i++) { if (v >= ths[i]) k = i + 1; else break; } return outs[k](ctx); };
		}
		case "case": {
			const conds = [], vals = [];
			for (let i = 1; i < e.length - 1; i += 2) { conds.push(compile(e[i])); vals.push(compile(e[i + 1])); }
			const def = compile(e[e.length - 1]);
			return ctx => { for (let i = 0; i < conds.length; i++) if (truthy(conds[i](ctx))) return vals[i](ctx); return def(ctx); };
		}
		case "let": {
			const names = [], vfs = [];
			for (let i = 1; i < e.length - 1; i += 2) { names.push(e[i]); vfs.push(compile(e[i + 1])); }
			const body = compile(e[e.length - 1]);
			return ctx => {
				const vars = Object.assign({}, ctx.vars), c2 = { ...ctx, vars };
				for (let i = 0; i < names.length; i++) vars[names[i]] = vfs[i](c2);
				return body(c2);
			};
		}
		case "var": { const name = e[1]; return ctx => ctx.vars[name]; }
		case "interpolate": {
			const type = e[1], inf = compile(e[2]), sk = [], sv = [];
			for (let i = 3; i < e.length; i += 2) { sk.push(e[i]); sv.push(compile(e[i + 1])); }
			const n = sk.length, expo = type[0] === "exponential", base = expo ? type[1] : 1;
			return ctx => {
				const input = inf(ctx);
				if (input <= sk[0]) return sv[0](ctx);
				if (input >= sk[n - 1]) return sv[n - 1](ctx);
				let k = 0; while (k < n - 1 && sk[k + 1] <= input) k++;
				const x0 = sk[k], x1 = sk[k + 1], y0 = sv[k](ctx), y1 = sv[k + 1](ctx);
				let t = (input - x0) / (x1 - x0);
				if (expo && base !== 1) t = (Math.pow(base, input - x0) - 1) / (Math.pow(base, x1 - x0) - 1);
				return y0 + t * (y1 - y0);
			};
		}
		case "+": { const xs = e.slice(1).map(compile); return ctx => { let s = 0; for (const f of xs) s += f(ctx); return s; }; }
		case "-": { if (e.length === 2) { const a = compile(e[1]); return ctx => -a(ctx); } const a = compile(e[1]), b = compile(e[2]); return ctx => a(ctx) - b(ctx); }
		case "*": { const xs = e.slice(1).map(compile); return ctx => { let s = 1; for (const f of xs) s *= f(ctx); return s; }; }
		case "/": { const a = compile(e[1]), b = compile(e[2]); return ctx => a(ctx) / b(ctx); }
		case "%": { const a = compile(e[1]), b = compile(e[2]); return ctx => a(ctx) % b(ctx); }
		case "^": { const a = compile(e[1]), b = compile(e[2]); return ctx => Math.pow(a(ctx), b(ctx)); }
		case "min": { const xs = e.slice(1).map(compile); return ctx => { let m = Infinity; for (const f of xs) { const v = f(ctx); if (v < m) m = v; } return m; }; }
		case "max": { const xs = e.slice(1).map(compile); return ctx => { let m = -Infinity; for (const f of xs) { const v = f(ctx); if (v > m) m = v; } return m; }; }
		case "to-number": { const a = compile(e[1]); return ctx => Number(a(ctx)); }
		case "coalesce": { const xs = e.slice(1).map(compile); return ctx => { for (const f of xs) { const v = f(ctx); if (v != null) return v; } return null; }; }
		default: (globalThis.__orthovtUnknownOps ||= new Set()).add(op); return () => undefined;
	}
}
