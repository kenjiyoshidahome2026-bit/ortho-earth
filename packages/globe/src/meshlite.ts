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

// 動いている間だけの軽量化（?meshlitemove=A・2026-11-08）＝index を「高さ段（lodCounts の区間）ごとに、残す三角形を先頭・落とす三角形を後ろ」に
// 並べ替えるだけ（GPU メモリは増えない・元の高さ段の prefix 意味は保つ）。renderer は止まっている時は従来どおり先頭 count を 1 回で描き、
// 動いている間は段ごとに liteCounts[k] だけを drawIndexed（段の数 ≤ 6 回）＝細部を落とした絵。止まると元の形に戻る。
// 実機（Mali-G615・2026-11-08）：静止の形で meshlite=4 は屋上の輪・小さな円筒が壊れるが、滑走中なら目立たず、解像度の床 0.4 と足し算で −19 ms。
export interface LiteReorder { liteCounts: number[]; dropped: number; tris: number }
/** idx をその場で並べ替え、段ごとの「残す index 数」を返す。lodCounts＝高さ段の先頭 index 数（降順）・null＝全体を 1 段。minArea ≤ 0＝何もしない（null） */
export function liteReorder(pos: ArrayLike<number>, idx: Uint32Array, lodCounts: ArrayLike<number> | null | undefined, minArea: number, scale: number): LiteReorder | null {
	const nIdx = idx.length, nTri = nIdx / 3 | 0;
	if (!(minArea > 0) || !nTri) return null;
	const thr2 = (2 * minArea / (scale * scale)) ** 2;
	const big = new Uint8Array(nTri);
	for (let t = 0; t < nTri; t++) {
		const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
		const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
		const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
		const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
		if (cx * cx + cy * cy + cz * cz >= thr2) big[t] = 1;
	}
	const lc = lodCounts && lodCounts.length ? Array.from(lodCounts, c => Math.min(nIdx, Math.max(0, c - c % 3))) : [nIdx];
	const n = lc.length, liteCounts = new Array<number>(n).fill(0);
	const tmp = new Uint32Array(nIdx);
	let dropped = 0;
	for (let k = 0; k < n; k++) {   // 段 k＝[lc[k+1], lc[k])（最後の段は [0, lc[n−1])）：残す三角形を先頭へ（安定）
		const s = k === n - 1 ? 0 : lc[k + 1], e = lc[k];
		if (e <= s) continue;
		let w = s;
		for (let i = s; i < e; i += 3) if (big[i / 3 | 0]) { tmp[w++] = idx[i]; tmp[w++] = idx[i + 1]; tmp[w++] = idx[i + 2]; }
		liteCounts[k] = w - s;
		for (let i = s; i < e; i += 3) if (!big[i / 3 | 0]) { tmp[w++] = idx[i]; tmp[w++] = idx[i + 1]; tmp[w++] = idx[i + 2]; dropped++; }
		idx.set(tmp.subarray(s, e), s);
	}
	return { liteCounts, dropped, tris: nTri };
}
