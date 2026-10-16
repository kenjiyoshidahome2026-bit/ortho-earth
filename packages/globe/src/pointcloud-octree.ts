// 普通の LAS/LAZ（COPC でない）を丸ごと読んだ点から、その場で八分木を作る（点群計画 段 3-3・2026-10-15）。node で検定できる純関数（tests/t-pointcloud-octree.mjs）。
//   作った節は COPC と同じ形（key＝[d, x, y, z]・立方体＝center・halfsize・spacing＝根の点の間隔）＝選び（gadgets/copc.js）と描き（copc-gl.js）はそのまま。
//   作り方＝根から順に「節を G×G×G の升に割り、空いている升に入る点はこの節・入れない点は子へ」（足し算＝COPC と同じ・Potree の作り方）。
//     1 節の点はおよそ升の数まで（面なら G² 程度）。升の印は 1 枚を使い回す（節を 1 つ済ませてから子へ降りる）。同じ所に重なった点は MAX_DEPTH で止める。余りが MIN_SPLIT 点に満たない節は子を作らない。
//   速さ（node・1,000 万点）＝走査の順の物 1.4 秒・ばらばらの順 4.3 秒（点を引く時の記憶の飛び）。点は動かさない＝idx（点の番号の並び替え）を持ち、節を出す時に集める（gatherNode）。
//   上限（本人裁定 2026-10-15）＝手元のファイル 2,000 万点・URL 500 MB（URL も 2,000 万点まで＝それ以上は端末が固まる）。超えたら COPC への変換を案内する。

export const G = 128, MAX_DEPTH = 20, MIN_SPLIT = 256;
export const LIMIT_POINTS = 20e6, LIMIT_URL_BYTES = 500 * 1024 * 1024;
/** 全点の入れ物（位置は記録のままの整数・scale/offset は LAS のヘッダ） */
export interface PointStore {
	n: number; at: number; scale: ArrayLike<number>; offset: ArrayLike<number>;
	X: Int32Array; Y: Int32Array; Z: Int32Array; intensity: Uint16Array; classification: Uint8Array; rgb: Uint8Array | null;
	min: number[]; max: number[];
}
/** readRecordsRaw の列（@ortho-earth/tile-formats/las の LasRecordsRaw） */
export interface RawRecords { X: Int32Array; Y: Int32Array; Z: Int32Array; intensity: Uint16Array; classification: Uint8Array; rgb: Uint8Array | null }
/** 八分木の節（key＝[d, x, y, z]・start／count＝idx の範囲） */
export interface OctNode { key: number[]; start: number; count: number }

/** 丸ごと読みの上限を超えたら理由（英語・利用者に見える）・超えなければ null */
export function wholeFileLimit({ count, size, local }: { count: number; size: number; local: boolean }): string | null {
	const fmt = (v: number) => Math.round(v).toLocaleString("en-US");
	if (count > LIMIT_POINTS) return `pointcloud: ${fmt(count)} points is over the ${fmt(LIMIT_POINTS)} limit for a plain LAS/LAZ file — convert it to COPC (.copc.laz, e.g. with PDAL or untwine) to stream it`;
	if (!local && size > LIMIT_URL_BYTES) return `pointcloud: ${fmt(size / 1048576)} MB is over the ${fmt(LIMIT_URL_BYTES / 1048576)} MB limit for a plain LAS/LAZ URL — convert it to COPC (.copc.laz, e.g. with PDAL or untwine) to stream it`;
	return null;
}

/** 全点の入れ物（位置は記録のままの整数）。append で読んだ順に詰める */
export function createStore(n: number, { rgb, scale, offset }: { rgb: boolean; scale: ArrayLike<number>; offset: ArrayLike<number> }): PointStore {
	return { n, at: 0, scale, offset, X: new Int32Array(n), Y: new Int32Array(n), Z: new Int32Array(n), intensity: new Uint16Array(n), classification: new Uint8Array(n), rgb: rgb ? new Uint8Array(n * 3) : null,
		min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}
/** readRecordsRaw の列を足す（範囲＝本物の点から取る＝ヘッダの min/max が誤っている物もある） */
export function appendRaw(s: PointStore, r: RawRecords, k: number): number {
	k = Math.min(k, s.n - s.at);
	const a = s.at, { X, Y, Z } = r;
	s.X.set(X.subarray(0, k), a); s.Y.set(Y.subarray(0, k), a); s.Z.set(Z.subarray(0, k), a);
	s.intensity.set(r.intensity.subarray(0, k), a); s.classification.set(r.classification.subarray(0, k), a);
	if (s.rgb && r.rgb) s.rgb.set(r.rgb.subarray(0, k * 3), a * 3);
	let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
	for (let i = 0; i < k; i++) {
		const x = X[i], y = Y[i], z = Z[i];
		if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
	}
	const [sx, sy, sz] = s.scale as number[], [ox, oy, oz] = s.offset as number[], lo = [x0 * sx + ox, y0 * sy + oy, z0 * sz + oz], hi = [x1 * sx + ox, y1 * sy + oy, z1 * sz + oz];
	for (let j = 0; j < 3; j++) { const a0 = Math.min(lo[j], hi[j]), a1 = Math.max(lo[j], hi[j]); if (a0 < s.min[j]) s.min[j] = a0; if (a1 > s.max[j]) s.max[j] = a1; }   // scale が負の物にも
	s.at += k;
	return k;
}

/**
 * 八分木を作る。random＝先に混ぜる（既定＝混ぜない＝読んだ順のまま。LAS は走査の順＝近い点が近くに並ぶので読みが速い・升に 1 点ずつなので混ぜなくても見本は全体に散る）
 * @returns {{ info: { center: number[], halfsize: number, spacing: number }, nodes: Array<{ key: number[], start: number, count: number }>, idx: Uint32Array }}
 */
export function buildOctree(s: PointStore, { random = null }: { random?: (() => number) | null } = {}): { info: { center: number[]; halfsize: number; spacing: number }; nodes: OctNode[]; idx: Uint32Array } {
	const n = s.at;
	const center = [0, 1, 2].map(j => (s.min[j] + s.max[j]) / 2);
	const ext = Math.max(s.max[0] - s.min[0], s.max[1] - s.min[1], s.max[2] - s.min[2]);
	const halfsize = Math.max(ext / 2 * (1 + 1e-6), 1e-3), side = halfsize * 2;
	const [sx, sy, sz] = s.scale as number[], [ox, oy, oz] = s.offset as number[], x0 = center[0] - halfsize, y0 = center[1] - halfsize, z0 = center[2] - halfsize;
	const X = s.X, Y = s.Y, Z = s.Z, idx = new Uint32Array(n);
	for (let i = 0; i < n; i++) idx[i] = i;
	if (random) for (let i = n - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)), t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
	const tmp = new Uint32Array(n), bits = new Uint32Array(G * G * G / 32), oct = new Uint8Array(n), nodes: OctNode[] = [], G1 = G - 1, H = G / 2;
	const stack = [{ key: [0, 0, 0, 0], a: 0, b: n }];
	while (stack.length) {
		const { key, a, b } = stack.pop()!, [d, nx, ny, nz] = key;
		if (d >= MAX_DEPTH) { nodes.push({ key, start: a, count: b - a }); continue; }
		// 節の升の番号＝記録の整数 × A ＋ B（節ごとに一次式を作っておく＝点ごとの割り算を省く）
		const k0 = 2 ** d * G / side, ax = sx * k0, bx = (ox - x0) * k0 - nx * G, ay = sy * k0, by = (oy - y0) * k0 - ny * G, az = sz * k0, bz = (oz - z0) * k0 - nz * G;
		let k = 0, m = 0;
		for (let i = a; i < b; i++) {
			const p = idx[i], fx = X[p] * ax + bx, fy = Y[p] * ay + by, fz = Z[p] * az + bz;
			const cx = fx <= 0 ? 0 : fx >= G1 ? G1 : fx | 0, cy = fy <= 0 ? 0 : fy >= G1 ? G1 : fy | 0, cz = fz <= 0 ? 0 : fz >= G1 ? G1 : fz | 0;
			const c = (cz * G + cy) * G + cx, w = c >>> 5, bit = 1 << (c & 31);
			if (!(bits[w] & bit)) { bits[w] |= bit; idx[a + k++] = p; }
			else { tmp[a + m++] = p; oct[p] = (cx >= H ? 1 : 0) | (cy >= H ? 2 : 0) | (cz >= H ? 4 : 0); }
		}
		if (k > 4096) bits.fill(0);   // 印を消す（使い回し）＝多ければ全部・少なければ点ごと
		else for (let i = a; i < a + k; i++) {
			const p = idx[i], fx = X[p] * ax + bx, fy = Y[p] * ay + by, fz = Z[p] * az + bz;
			const cx = fx <= 0 ? 0 : fx >= G1 ? G1 : fx | 0, cy = fy <= 0 ? 0 : fy >= G1 ? G1 : fy | 0, cz = fz <= 0 ? 0 : fz >= G1 ? G1 : fz | 0;
			bits[((cz * G + cy) * G + cx) >>> 5] = 0;
		}
		if (m < MIN_SPLIT) {   // 余りが少ない＝子を作らずこの節に入れる（点の少ない節を山ほど作らない）
			for (let i = 0; i < m; i++) idx[a + k + i] = tmp[a + i];
			nodes.push({ key, start: a, count: b - a }); continue;
		}
		nodes.push({ key, start: a, count: k });
		// 入れなかった点を子の順（0〜7）に並べて idx[a+k, b) へ戻す（数え分け・並びは保つ）
		const cnt = new Uint32Array(9);
		for (let i = 0; i < m; i++) cnt[oct[tmp[a + i]] + 1]++;
		for (let c = 1; c < 9; c++) cnt[c] += cnt[c - 1];
		const at = cnt.slice(0, 8);
		for (let i = 0; i < m; i++) { const p = tmp[a + i]; idx[a + k + at[oct[p]]++] = p; }
		for (let c = 7; c >= 0; c--) if (cnt[c + 1] > cnt[c])
			stack.push({ key: [d + 1, 2 * nx + (c & 1), 2 * ny + ((c >> 1) & 1), 2 * nz + ((c >> 2) & 1)], a: a + k + cnt[c], b: a + k + cnt[c + 1] });
	}
	return { info: { center, halfsize, spacing: side / G }, nodes, idx };
}

/** 節の点を集める → placeNode に渡す形（x,y,z は原座標＝scale・offset を掛けた値）＋強度・分類・RGB（8bit） */
export function gatherNode(s: PointStore, idx: Uint32Array, start: number, count: number): { x: Float64Array; y: Float64Array; z: Float64Array; intensity: Uint16Array; classification: Uint8Array; rgb: Uint8Array | null } {
	const x = new Float64Array(count), y = new Float64Array(count), z = new Float64Array(count), intensity = new Uint16Array(count), classification = new Uint8Array(count), rgb = s.rgb ? new Uint8Array(count * 3) : null;
	const [sx, sy, sz] = s.scale as number[], [ox, oy, oz] = s.offset as number[];
	for (let i = 0; i < count; i++) {
		const p = idx[start + i];
		x[i] = s.X[p] * sx + ox; y[i] = s.Y[p] * sy + oy; z[i] = s.Z[p] * sz + oz; intensity[i] = s.intensity[p]; classification[i] = s.classification[p];
		if (rgb) { rgb[i * 3] = s.rgb![p * 3]; rgb[i * 3 + 1] = s.rgb![p * 3 + 1]; rgb[i * 3 + 2] = s.rgb![p * 3 + 2]; }
	}
	return { x, y, z, intensity, classification, rgb };
}
