// 建物メッシュの軽量 index（?meshlite=A・2026-11-08）＝面積 A m² 未満の三角形を index から落とす（純関数・worker で 1 回）。
// 実データ（千代田・中央・港の 40 葉ずつ・plateau-tri-stats）：0.25 m² 未満の三角形は枚数の 20〜60% を占めるのに面積では 0.06〜0.2%
// ＝z17.7（1 px ≈ 0.2 m）で 6 px² 未満の細部（天窓・庇・角の欠け）。高さで切る間引き（meshshed）は 24 m 未満を落としても
// 三角形の 66〜83% が残る（三角形の大半は高い建物の側）ので、止まっている時の重さ（丸の内 236 万三角形＝Mali 100 ms）にはこちら。
// 元の index は建物の高さ降順（meshdecode の LOD 焼き）＝順序を保ったまま抜く・lodCounts（高さ段の先頭 count）も抜いた分だけ詰める。
// pos は原点相対の世界単位（1 ＝ EARTH_W m）＝面積は scale² を掛けて m² に。
export interface LiteResult { idx: Uint32Array; lodCounts: number[] | null; dropped: number; tris: number }
/** 面積 minArea（m²）未満の三角形を落とした index と詰め直した lodCounts。scale＝世界単位→m（EARTH_W）。minArea ≤ 0＝そのまま */
export function liteIndex(pos: ArrayLike<number>, idx: Uint32Array, lodCounts: ArrayLike<number> | null | undefined, minArea: number, scale: number): LiteResult {
	const nTri = idx.length / 3 | 0;
	if (!(minArea > 0) || !nTri) return { idx, lodCounts: lodCounts ? Array.from(lodCounts) : null, dropped: 0, tris: nTri };
	const thr2 = (2 * minArea / (scale * scale)) ** 2;   // |u×v| = 2×面積（世界単位²）＝平方根を避けて比較
	const out = new Uint32Array(idx.length), keptAt = new Uint32Array(nTri + 1);   // keptAt[t]＝元の t 枚目までに残った枚数（lodCounts の詰め直し用）
	let k = 0;
	for (let t = 0; t < nTri; t++) {
		const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
		const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
		const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
		const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
		if (cx * cx + cy * cy + cz * cz >= thr2) { out[k * 3] = idx[t * 3]; out[k * 3 + 1] = idx[t * 3 + 1]; out[k * 3 + 2] = idx[t * 3 + 2]; k++; }
		keptAt[t + 1] = k;
	}
	const lc = lodCounts ? Array.from(lodCounts, c => keptAt[Math.min(nTri, c / 3 | 0)] * 3) : null;
	return { idx: out.slice(0, k * 3), lodCounts: lc, dropped: nTri - k, tris: nTri };
}
