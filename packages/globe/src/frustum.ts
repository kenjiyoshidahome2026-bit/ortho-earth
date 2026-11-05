// mvp（列優先）から視錐台の 6 面（法線は内向き・正規化）。gadgets/tiles3d と gadgets/copc が同じ物を持っていた＝一本化（2026-11-05）。
// 面は [a, b, c, d]（a·x + b·y + c·z + d ≥ 0 が内側）。順は 左・右・下・上・近・遠。

export function planesOf(m: ArrayLike<number>): number[][] {
	const row = (i: number) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
	const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3), out: number[][] = [];
	for (const [a, sg] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]] as Array<[number[], number]>) {
		const p = [r3[0] + sg * a[0], r3[1] + sg * a[1], r3[2] + sg * a[2], r3[3] + sg * a[3]], l = Math.hypot(p[0], p[1], p[2]) || 1;
		out.push([p[0] / l, p[1] / l, p[2] / l, p[3] / l]);
	}
	return out;
}
