// CESIUM_primitive_outline: the edges a glTF primitive wants outlined, turned into per-vertex outline coordinates the way CesiumJS does it
// (Scene/Model/PrimitiveOutlineGenerator). Each triangle gives its three corners a coordinate triple of 0/1 values in a shared edge order, so that
// the interpolated component reaches 1 along the outlined edges; a vertex whose triple cannot agree with a new triangle is copied. The renderer
// draws the outline where a component is within a pixel of 1 (the mip-mapped lookup texture of the original).

export interface OutlineOut {
	/** the triangle indices, with copied vertices substituted */
	idx: Uint32Array;
	/** the source vertex of each copied vertex (appended after the original n) */
	extra: number[];
	/** 3 bits per vertex (n + extra.length): bit k = outline coordinate k is 1 */
	bits: Uint8Array;
}

/** idx = triangle indices (0..n-1, local), edges = the extension's line indices (pairs), n = vertex count */
export function primitiveOutline(idx: ArrayLike<number>, edges: ArrayLike<number>, n: number): OutlineOut {
	const set = new Set<number>();
	for (let i = 0; i + 1 < edges.length; i += 2) { const a = edges[i], b = edges[i + 1]; set.add(Math.min(a, b) * n + Math.max(a, b)); }
	const has = (a: number, b: number) => set.has(Math.min(a, b) * n + Math.max(a, b));
	const tri = Uint32Array.from(idx), extra: number[] = [], copies = new Map<number, number>();
	const coords: number[] = [];   // 3 per vertex; undefined = not yet constrained
	const mask = (v: number, a: number, b: number, c: number): number => {
		const f = coords[v * 3], s = coords[v * 3 + 1], t = coords[v * 3 + 2];
		if (f === undefined) return 0b111111;
		return +(f === a && s === b && t === c) | +(f === a && s === c && t === b) << 1 | +(f === b && s === a && t === c) << 2
			| +(f === b && s === c && t === a) << 3 | +(f === c && s === a && t === b) << 4 | +(f === c && s === b && t === a) << 5;
	};
	const pop = (m: number) => { let k = 0; for (let i = 0; i < 6; i++) k += (m >> i) & 1; return k; };
	const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [2, 0, 1], [1, 2, 0], [2, 1, 0]];   // [slot of a, slot of b, slot of c]: abc, acb, bac, bca, cab, cba
	const match = (i0: number, i1: number, i2: number, e01: boolean, e12: boolean, e20: boolean): number | null => {
		const v = [[e20 ? 1 : 0, e01 ? 1 : 0, 0], [0, e01 ? 1 : 0, e12 ? 1 : 0], [e20 ? 1 : 0, 0, e12 ? 1 : 0]], ids = [i0, i1, i2];
		const m = ids.map((id, k) => mask(id, v[k][0], v[k][1], v[k][2]));
		for (let k = 0; k < 3; k++) if (m[k] === 0) return ids[k];
		const ok = m[0] & m[1] & m[2];
		const o = ORDERS.findIndex((_, k) => ok & (1 << k));
		if (o < 0) { const p = m.map(pop); return p[0] < p[1] && p[0] < p[2] ? i0 : p[1] < p[2] ? i1 : i2; }
		const [sa, sb, sc] = ORDERS[o];
		for (let k = 0; k < 3; k++) { const s = ids[k] * 3; coords[s + sa] = v[k][0]; coords[s + sb] = v[k][1]; coords[s + sc] = v[k][2]; }
		return null;
	};
	for (let i = 0; i + 2 < tri.length; i += 3) {
		let i0 = tri[i], i1 = tri[i + 1], i2 = tri[i + 2];
		const e01 = has(i0, i1), e12 = has(i1, i2), e20 = has(i2, i0);
		let bad = match(i0, i1, i2, e01, e12, e20);
		while (bad !== null) {
			let copy = copies.get(bad);
			if (copy === undefined) {
				copy = n + extra.length;
				let orig = bad;
				while (orig >= n) orig = extra[orig - n];
				extra.push(orig);
				copies.set(bad, copy);
			}
			if (bad === i0) { i0 = copy; tri[i] = copy; } else if (bad === i1) { i1 = copy; tri[i + 1] = copy; } else { i2 = copy; tri[i + 2] = copy; }
			bad = match(i0, i1, i2, e01, e12, e20);
		}
	}
	const total = n + extra.length, bits = new Uint8Array(total);
	for (let v = 0; v < total; v++) bits[v] = (coords[v * 3] === 1 ? 1 : 0) | (coords[v * 3 + 1] === 1 ? 2 : 0) | (coords[v * 3 + 2] === 1 ? 4 : 0);
	return { idx: tri, extra, bits };
}
