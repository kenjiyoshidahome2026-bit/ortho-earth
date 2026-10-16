// 当たり判定の格子索引（geopbf 改良点 ⑧・2026-10-12）── findPolygon／findMortonNear の O(地物数) 全走査を、
// 一様格子（cell → その cell に bbox が掛かる地物）＋地物ごとの流れ（polyStream／lineStream）の位置で候補だけの照合にする。
// 索引は流れ（配列の identity）ごとに一度だけ遅延で組み、WeakMap に持つ＝geopbf の unPackGint と ortho-core の gintData（同じ配列を共有）の両方で効く。
// 格子: 層の bbox を G×G（G＝clamp(ceil(sqrt(地物数)), 1, 1024)）に割る。bbox が多くの cell に掛かる大物（> BIG_CELLS）は「常に見る」側（big）に入れて
// cell の表を膨らませない。縫い目跨ぎ（bbox の x > 360e7＝ortho-core bake の周期対応）の地物も big へ。
// 面の smallest-wins（流れは weight 降順＝後ろほど小さい）は候補のうち流れの位置が最大の物を返す＝全走査と同じ答え。
/** 線・面の当たり判定の格子索引（stream ごとに 1 つ・WeakMap で控える） */
export interface HitGrid {
	G: number; x0: number; y0: number; cw: number; ch: number;
	cellOff: Int32Array; cellFid: Int32Array; big: Int32Array;
	/** fid → 流れの最初の位置（無い fid は -1）・fid → bbox（4 個ずつ） */
	off: Int32Array; bb: Float64Array;
	n: number; cells: number;
	offOf(fid: number): number;
	/** 読むだけの窓（新しい配列を作らない） */
	bboxOf(fid: number): Float64Array | null;
}
const CACHE = new WeakMap<Int32Array, HitGrid | null>();   // stream → grid
const BIG_CELLS = 256;
const P360 = 3600000000;

// stream＝polyStream（fid, nRings, [arcCount, arcs…]…）または lineStream（fid, nSets, [arcCount, arcs…]…）＝同じ形。
// 戻り値 { G, x0, y0, cw, ch, cellOff(Int32Array G*G+1), cellFid(Int32Array), big(Int32Array), fidOff(Map fid→流れの最初の位置), fidBbox(Map), n }
export function buildHitGrid(stream: Int32Array | null, arcMeta: Uint32Array | null): HitGrid | null {
	if (!stream || !arcMeta || !stream.length) return null;
	// 1) 地物ごとの bbox と流れの最初の位置（fid で引く typed array＝Map より軽い。fid は 0 始まりの添字＝maxFid+1 本）
	let p = 0, maxFid = -1;
	while (p < stream.length) { const fid = stream[p++]; if (fid > maxFid) maxFid = fid; const numGroups = stream[p++]; for (let g = 0; g < numGroups; g++) p += 1 + stream[p]; }
	const NF = maxFid + 1, off = new Int32Array(NF).fill(-1), bb = new Float64Array(NF * 4);
	for (let f = 0; f < NF; f++) { bb[f * 4] = 0xFFFFFFFF; bb[f * 4 + 1] = 0xFFFFFFFF; }
	p = 0; let n = 0;
	while (p < stream.length) {
		const at = p, fid = stream[p++], numGroups = stream[p++], b = fid * 4;
		if (off[fid] < 0) { off[fid] = at; n++; }
		for (let g = 0; g < numGroups; g++) {
			const arcCount = stream[p++];
			for (let a = 0; a < arcCount; a++) {
				const arcIdx = stream[p++], aid = arcIdx < 0 ? ~arcIdx : arcIdx, m = aid * 8;
				if (arcMeta[m + 4] < bb[b]) bb[b] = arcMeta[m + 4]; if (arcMeta[m + 5] < bb[b + 1]) bb[b + 1] = arcMeta[m + 5];
				if (arcMeta[m + 6] > bb[b + 2]) bb[b + 2] = arcMeta[m + 6]; if (arcMeta[m + 7] > bb[b + 3]) bb[b + 3] = arcMeta[m + 7];
			}
		}
	}
	let X0 = 0xFFFFFFFF, Y0 = 0xFFFFFFFF, X1 = 0, Y1 = 0;
	for (let f = 0; f < NF; f++) { if (off[f] < 0 || bb[f * 4 + 2] > P360) continue; const b = f * 4; if (bb[b] < X0) X0 = bb[b]; if (bb[b + 1] < Y0) Y0 = bb[b + 1]; if (bb[b + 2] > X1) X1 = bb[b + 2]; if (bb[b + 3] > Y1) Y1 = bb[b + 3]; }
	if (X0 > X1) { X0 = 0; X1 = P360; Y0 = 0; Y1 = 1800000000; }
	const G = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(n))));
	const cw = Math.max(1, (X1 - X0 + 1) / G), ch = Math.max(1, (Y1 - Y0 + 1) / G);
	const cx = (x: number): number => Math.max(0, Math.min(G - 1, Math.floor((x - X0) / cw))), cy = (y: number): number => Math.max(0, Math.min(G - 1, Math.floor((y - Y0) / ch)));
	// 2) cell ごとの地物（CSR）＝数えて→詰める。大物（多くの cell に掛かる・縫い目跨ぎ）は big
	const counts = new Int32Array(G * G + 1), big: number[] = [], span = new Int32Array(NF * 4).fill(-1);
	for (let f = 0; f < NF; f++) {
		if (off[f] < 0) continue;
		const b = f * 4;
		if (bb[b + 2] > P360) { big.push(f); continue; }
		const i0 = cx(bb[b]), i1 = cx(bb[b + 2]), j0 = cy(bb[b + 1]), j1 = cy(bb[b + 3]);
		if ((i1 - i0 + 1) * (j1 - j0 + 1) > BIG_CELLS) { big.push(f); continue; }
		span[b] = i0; span[b + 1] = i1; span[b + 2] = j0; span[b + 3] = j1;
		for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * G + i + 1]++;
	}
	for (let c = 1; c <= G * G; c++) counts[c] += counts[c - 1];
	const cellOff = counts, cellFid = new Int32Array(cellOff[G * G]), fill = cellOff.slice(0, G * G);
	for (let f = 0; f < NF; f++) {
		const b = f * 4; if (span[b] < 0) continue;
		for (let j = span[b + 2]; j <= span[b + 3]; j++) for (let i = span[b]; i <= span[b + 1]; i++) cellFid[fill[j * G + i]++] = f;
	}
	return { G, x0: X0, y0: Y0, cw, ch, cellOff, cellFid, big: Int32Array.from(big), off, bb, n, cells: cellFid.length,
		offOf: (fid: number) => off[fid] ?? -1, bboxOf: (fid: number) => off[fid] >= 0 ? bb.subarray(fid * 4, fid * 4 + 4) : null };   // bboxOf＝読むだけの窓（新しい配列を作らない）
}
export function hitGridOf(stream: Int32Array | null, arcMeta: Uint32Array | null): HitGrid | null {
	if (!stream || !stream.length) return null;
	let g = CACHE.get(stream);
	if (g === undefined) { g = buildHitGrid(stream, arcMeta); CACHE.set(stream, g); }
	return g;
}
// 点 (mix, miy)（許容 error＝線は半径・面は 0）に bbox が掛かる候補 fid を列挙（big を含む）。visit(fid, streamOffset)＝真を返したら打ち切り
export function hitCandidates(grid: HitGrid, mix: number, miy: number, error: number, visit: (fid: number, streamOffset: number) => boolean): boolean {
	const { G, x0, y0, cw, ch, cellOff, cellFid, big, off, bb } = grid;
	const test = (fid: number): boolean => {
		const b = fid * 4, wrap = bb[b + 2] > P360;
		const inX = wrap ? (mix <= bb[b + 2] - P360 + error || mix >= bb[b] - error) : (mix >= bb[b] - error && mix <= bb[b + 2] + error);
		return inX && miy >= bb[b + 1] - error && miy <= bb[b + 3] + error && visit(fid, off[fid]);
	};
	for (let k = 0; k < big.length; k++) if (test(big[k])) return true;
	const i0 = Math.floor((mix - error - x0) / cw), i1 = Math.floor((mix + error - x0) / cw), j0 = Math.floor((miy - error - y0) / ch), j1 = Math.floor((miy + error - y0) / ch);
	if (i1 < 0 || j1 < 0 || i0 >= G || j0 >= G) return false;
	const I0 = Math.max(0, i0), J0 = Math.max(0, j0), multi = i0 < i1 || j0 < j1;
	for (let j = J0; j <= Math.min(G - 1, j1); j++) for (let i = I0; i <= Math.min(G - 1, i1); i++) {
		const c = j * G + i;
		for (let q = cellOff[c]; q < cellOff[c + 1]; q++) {
			const fid = cellFid[q];
			if (multi) {   // 窓が複数 cell に跨る＝同じ fid を 2 度見ない（窓の中で bbox が最初に掛かる cell だけで扱う）
				const b = fid * 4, ci = Math.max(I0, Math.floor((bb[b] - x0) / cw)), cj = Math.max(J0, Math.floor((bb[b + 1] - y0) / ch));
				if (ci !== i || cj !== j) continue;
			}
			if (test(fid)) return true;
		}
	}
	return false;
}
