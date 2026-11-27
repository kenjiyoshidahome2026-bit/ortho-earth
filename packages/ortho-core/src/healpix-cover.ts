// HEALPix のタイル選び＝視野を覆うタイルを、画面上の大きさに合う段で重なりなく選ぶ（docs/design/healpix.md §6 の 4 段目・2026-11-27）。
// メルカトルの selectLOD（tilecover.ts）と同じ考え（画面の標本点 → 根 → 画面上で大きければ 4 分割）を、HEALPix の四分木でやり直したもの。tilecover.ts は触らない。
//   ・含む判定は経緯度の矩形ではなく番地で：標本点の最も細かい段の番号を取っておき、「その祖先か」で見る（タイルは菱形＝矩形の重なりでは見られない）
//   ・大きさは縁をなぞった長さ（表側に見えている辺）の最大＝画面上のタイルの 1 辺の px
// 地形のリフト球（groundR）・地平線ぎわの持ち上げ・地下の目はまだ見ない（基図の選び方の細かい手当ては、絵を見てから足す）。
import { cameraState, unproject, projectInto, type CameraPose, type CameraState } from "./camera.ts";
import { lonLatToNest, hpxBoundary, hpxId, HPX_MAX_ORDER, type HpxTile } from "./healpix.ts";

export interface SelectHpxOptions {
	/** 段の範囲（目録の minOrder／maxOrder） */
	minOrder?: number; maxOrder?: number;
	/** 画面上の 1 辺がこれより大きいタイルは割る（px） */
	tilePx?: number;
	/** 画面の標本の格子（grid+1 の 2 乗の点） */
	grid?: number;
	/** 前回割ったタイル（hpxId）。渡すと、一度割ったタイルは tilePx×stickyRatio まで縮むまで割ったまま＝境でのばたつきを止める */
	sticky?: Set<number> | null; stickyRatio?: number;
	/** 割ったタイルの hpxId をここへ書く（次回の sticky に渡す） */
	splitOut?: Set<number> | null;
	/** 選ぶ枚数の上限（越えたら、それ以上は割らない） */
	maxTiles?: number;
}
interface Node { order: number; npix: number; s: number[] | null }
const P = new Float64Array(3);

/** 視野を覆う HEALPix のタイル（重なりなし・近い所ほど細かい段）。地球が画面に無ければ [] */
export function selectHpxLOD(cam: CameraPose, W: number, H: number, { minOrder = 0, maxOrder = 12, tilePx = 560, grid = 10, sticky = null, stickyRatio = 0.8, splitOut = null, maxTiles = 400 }: SelectHpxOptions = {}): HpxTile[] {
	if (!(W > 0 && H > 0)) return [];
	const st = cameraState(cam, W, H), deep = Math.min(HPX_MAX_ORDER, Math.max(maxOrder, minOrder));
	// 標本：画面の格子の点を地球へ落とし、最も細かい段の番号にしておく（どのタイルの中か＝祖先かどうか、で分かる）
	const nest: number[] = [];
	for (let iy = 0; iy <= grid; iy++) for (let ix = 0; ix <= grid; ix++) { const ll = unproject(st, ix / grid * W, iy / grid * H); if (ll) nest.push(lonLatToNest(ll[0], ll[1], deep)); }
	nest.push(lonLatToNest(cam.center[0], cam.center[1], deep));   // 注視点は必ず覆う
	const up = (n: number, order: number): number => Math.floor(n / 4 ** (deep - order));
	// 根＝基底の 12 面ぜんぶ（標本が入らない面も、縁が画面に掛かれば拾う＝地球が画面に小さく映る時の縁の面）。minOrder より粗い段は必ず割る
	const roots: Node[] = []; for (let f = 0; f < 12; f++) roots.push({ order: 0, npix: f, s: [] });
	for (let i = 0; i < nest.length; i++) roots[up(nest[i], 0)].s!.push(i);
	const out: HpxTile[] = [], stack = roots;
	let guard = 0;
	while (stack.length && guard++ < 30000) {
		const t = stack.pop()!, size = sizeOf(st, t.order, t.npix, W, H);
		if (size < 0 && !t.s?.length) continue;   // 画面に掛からず、標本も入っていない
		const th = sticky?.has(hpxId(t.order, t.npix)) ? tilePx * stickyRatio : tilePx;
		// 縁が全部裏（size < 0）なのに標本が入っている＝画面より大きいタイル（地球全体を見ている時の粗い段）＝割る
		if (t.order < minOrder || (t.order < maxOrder && (size < 0 || size > th) && out.length + stack.length + 4 <= maxTiles)) {
			splitOut?.add(hpxId(t.order, t.npix));
			const kids: Node[] = [0, 1, 2, 3].map(k => ({ order: t.order + 1, npix: t.npix * 4 + k, s: [] as number[] }));
			if (t.s) for (const i of t.s) kids[up(nest[i], t.order + 1) - t.npix * 4].s!.push(i);
			stack.push(...kids);
		} else out.push({ order: t.order, npix: t.npix });
	}
	return out;
}

// 画面上の大きさ（1 辺の px）。縁をなぞり、表側で続いている点の間の長さを辺ごとに足して、最大の辺を返す。
// 画面の枠に掛からない＝-1（呼び手は標本の有無で残すか決める）。粗い段は縁を細かくなぞる（球の縁で隅が裏に回る）
function sizeOf(st: CameraState, order: number, npix: number, W: number, H: number): number {
	const K = order <= 4 ? 8 : order <= 7 ? 2 : 1, b = hpxBoundary(order, npix, K), n = b.length;
	let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, nf = 0, best = 0;
	const xs = new Float64Array(n), ys = new Float64Array(n), fr = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		projectInto(st, b[i][0], b[i][1], 1, P);
		xs[i] = P[0]; ys[i] = P[1]; fr[i] = P[2] >= 0 ? 1 : 0;
		if (fr[i]) { nf++; if (P[0] < minx) minx = P[0]; if (P[0] > maxx) maxx = P[0]; if (P[1] < miny) miny = P[1]; if (P[1] > maxy) maxy = P[1]; }
	}
	if (!nf || maxx < 0 || minx > W || maxy < 0 || miny > H) return -1;
	for (let side = 0; side < 4; side++) {
		let len = 0;
		for (let j = 0; j < K; j++) { const a = side * K + j, c = (a + 1) % n; if (fr[a] && fr[c]) len += Math.hypot(xs[c] - xs[a], ys[c] - ys[a]); }
		if (len > best) best = len;
	}
	return best;
}
