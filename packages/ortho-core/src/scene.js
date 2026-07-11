// タイル結合（merge）の純関数。worker でもメインでも使える。
// order の各タイルの geometry(ops/buildings) を style層(li)ごとに1バッファへ結合し、共通 origin へ再ベース。
// geomOf(key) → { ops, buildings } | null（geometry の供給元。cache でも worker の Map でも）。
export function mergeTiles(order, geomOf, opts = {}) {
	if (!order.length) return { origin: [0, 0], layers: [], buildings: null };
	const origin = opts.origin || order[0].origin;
	const hidden = opts.hidden || EMPTY;
	const tileOps = [];
	const size = new Map();
	for (const { key, origin: to } of order) {
		const g = geomOf(key); if (!g || !g.ops) continue;
		tileOps.push({ ox: to[0] - origin[0], oy: to[1] - origin[1], ops: g.ops });
		for (const op of g.ops) {
			if (hidden.has(op.li)) continue;
			let e = size.get(op.li); if (!e) { e = { kind: op.kind, fillN: 0, lineN: 0 }; size.set(op.li, e); }
			if (op.kind === "fill") e.fillN += op.pos.length / 2; else e.lineN += op.half.length;
		}
	}
	const buf = new Map();
	for (const [li, e] of size) {
		buf.set(li, e.kind === "fill"
			? { kind: "fill", li, pos: new Float32Array(e.fillN * 2), col: new Float32Array(e.fillN * 4), pi: 0, ci: 0 }
			: { kind: "line", li, P1: new Float32Array(e.lineN * 2), P2: new Float32Array(e.lineN * 2), col: new Float32Array(e.lineN * 4), half: new Float32Array(e.lineN), pi: 0, ci: 0, hi: 0 });
	}
	for (const { ox, oy, ops } of tileOps) {
		for (const op of ops) {
			if (hidden.has(op.li)) continue;
			const m = buf.get(op.li);
			if (op.kind === "fill") {
				const p = op.pos; let pi = m.pi; for (let i = 0; i < p.length; i += 2) { m.pos[pi++] = p[i] + ox; m.pos[pi++] = p[i + 1] + oy; } m.pi = pi;
				m.col.set(op.col, m.ci); m.ci += op.col.length;
			} else {
				const P1 = op.P1, P2 = op.P2; let pi = m.pi;
				for (let i = 0; i < P1.length; i += 2) { m.P1[pi] = P1[i] + ox; m.P1[pi + 1] = P1[i + 1] + oy; m.P2[pi] = P2[i] + ox; m.P2[pi + 1] = P2[i + 1] + oy; pi += 2; } m.pi = pi;
				m.col.set(op.col, m.ci); m.ci += op.col.length;
				m.half.set(op.half, m.hi); m.hi += op.half.length;
			}
		}
	}
	const layers = [...buf.values()].sort((a, b) => a.li - b.li).map(m => m.kind === "fill"
		? { kind: "fill", li: m.li, pos: m.pos, col: m.col }
		: { kind: "line", li: m.li, P1: m.P1, P2: m.P2, col: m.col, half: m.half });

	// 建物：全タイルから結合。xy を原点へ再ベース、z(高さ)はそのまま。
	let bN = 0;
	for (const { key } of order) { const g = geomOf(key); if (g && g.buildings) bN += g.buildings.pos.length; }
	let buildings = null;
	if (bN) {
		const pos = new Float32Array(bN), shade = new Float32Array(bN / 3), anchor = new Float32Array(bN / 3 * 2);
		let pi = 0, si = 0, ai = 0;
		for (const { key, origin: to } of order) {
			const g = geomOf(key); if (!g || !g.buildings) continue;
			const ox = to[0] - origin[0], oy = to[1] - origin[1], bp = g.buildings.pos, ba = g.buildings.anchor;
			for (let i = 0; i < bp.length; i += 3) { pos[pi++] = bp[i] + ox; pos[pi++] = bp[i + 1] + oy; pos[pi++] = bp[i + 2]; }
			for (let i = 0; i < ba.length; i += 2) { anchor[ai++] = ba[i] + ox; anchor[ai++] = ba[i + 1] + oy; }
			shade.set(g.buildings.shade, si); si += g.buildings.shade.length;
		}
		buildings = { pos, shade, anchor };
	}
	return { origin, layers, buildings };
}
const EMPTY = new Set();
