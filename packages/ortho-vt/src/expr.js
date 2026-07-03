// MapLibre GL style 式インタプリタ（地理院 optimal_bvmap std.json が使う部分集合）。
// node で実タイル/実スタイルに対し検証済み（全123層のfilter・paintが未知opゼロで評価される）。
// filter も paint も同一の評価器で処理する（std.json は全て現代式＝レガシーfilter無し）。

export function truthy(v) {
	return v !== false && v != null && v !== 0 && v !== "" && !(typeof v === "number" && isNaN(v));
}

// e: 式（配列 or リテラル）, ctx: { zoom, props, geom, vars }
export function evalExpr(e, ctx) {
	if (!Array.isArray(e)) return e;
	if (typeof e[0] !== "string") return e;           // リテラルのタプル（例: dash [2,4]、match のラベル配列）
	const op = e[0], A = i => evalExpr(e[i], ctx);
	switch (op) {
		case "literal": return e[1];
		case "get": return ctx.props[evalExpr(e[1], ctx)];
		case "has": return evalExpr(e[1], ctx) in ctx.props;
		case "!": return !truthy(A(1));
		case "all": return e.slice(1).every(x => truthy(evalExpr(x, ctx)));
		case "any": return e.slice(1).some(x => truthy(evalExpr(x, ctx)));
		case "==": return A(1) === A(2);
		case "!=": return A(1) !== A(2);
		case ">": return A(1) > A(2);
		case ">=": return A(1) >= A(2);
		case "<": return A(1) < A(2);
		case "<=": return A(1) <= A(2);
		case "in": { const v = A(1), c = A(2); return Array.isArray(c) ? c.includes(v) : typeof c === "string" ? c.includes(v) : false; }
		case "geometry-type": return ctx.geom;
		case "zoom": return ctx.zoom;
		case "match": {
			const v = A(1);
			for (let i = 2; i < e.length - 1; i += 2) {
				const lab = e[i];
				if (Array.isArray(lab) ? lab.includes(v) : lab === v) return evalExpr(e[i + 1], ctx);
			}
			return evalExpr(e[e.length - 1], ctx);
		}
		case "step": {
			const v = A(1); let out = e[2];
			for (let i = 3; i < e.length; i += 2) { if (v >= e[i]) out = e[i + 1]; else break; }
			return evalExpr(out, ctx);
		}
		case "case": {
			for (let i = 1; i < e.length - 1; i += 2) if (truthy(evalExpr(e[i], ctx))) return evalExpr(e[i + 1], ctx);
			return evalExpr(e[e.length - 1], ctx);
		}
		case "let": {
			const vars = Object.assign({}, ctx.vars);
			for (let i = 1; i < e.length - 1; i += 2) vars[e[i]] = evalExpr(e[i + 1], { ...ctx, vars });
			return evalExpr(e[e.length - 1], { ...ctx, vars });
		}
		case "var": return ctx.vars[e[1]];
		case "interpolate": {
			const type = e[1], input = A(2), stops = [];
			for (let i = 3; i < e.length; i += 2) stops.push([e[i], evalExpr(e[i + 1], ctx)]);
			if (input <= stops[0][0]) return stops[0][1];
			if (input >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
			let k = 0; while (k < stops.length - 1 && stops[k + 1][0] <= input) k++;
			const [x0, y0] = stops[k], [x1, y1] = stops[k + 1];
			let t = (input - x0) / (x1 - x0);
			if (type[0] === "exponential") { const b = type[1]; if (b !== 1) t = (Math.pow(b, input - x0) - 1) / (Math.pow(b, x1 - x0) - 1); }
			return y0 + t * (y1 - y0);
		}
		case "+": return e.slice(1).reduce((s, x) => s + evalExpr(x, ctx), 0);
		case "-": return e.length === 2 ? -A(1) : A(1) - A(2);
		case "*": return e.slice(1).reduce((s, x) => s * evalExpr(x, ctx), 1);
		case "/": return A(1) / A(2);
		case "%": return A(1) % A(2);
		case "^": return Math.pow(A(1), A(2));
		case "min": return Math.min(...e.slice(1).map(x => evalExpr(x, ctx)));
		case "max": return Math.max(...e.slice(1).map(x => evalExpr(x, ctx)));
		case "to-number": return Number(A(1));
		case "coalesce": for (let i = 1; i < e.length; i++) { const v = A(i); if (v != null) return v; } return null;
		default: (globalThis.__orthovtUnknownOps ||= new Set()).add(op); return undefined;
	}
}
