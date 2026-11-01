// 描き手の共通の小物（改善計画の段階 3・2026-11-01）＝gl/renderer.ts と gpu/renderer.ts が字句まで同じに持っていた純関数の正本。
// 破線の uniform・利用者の層の差し込みの計画・強調 overlay の塗り・世界扇（wdepr）の可視レンジ＝GPU API を読まない。
import { dashIntervals } from "./scene.ts";

/** 破線（S-P1-3）の uniform の中身＝周期・区間の数・丸い端・区間 [a, b]×4（scene.ts の dashIntervals） */
export interface DashU { P: number; n: number; round: number; iv: Float32Array }
export function dashU(dash: readonly number[] | undefined, cj: number): DashU | null {
	if (!dash) return null;
	const round = !(cj & 3), { P, iv } = dashIntervals(dash, round), a = new Float32Array(8);
	a.set(iv.length ? iv.slice(0, 8) : [-2 * P, -2 * P]);   // 線が無い（butt の [0, 2]）＝どの画素も届かない区間（区間の数 0 は「破線でない」＝実線になる）
	return { P, n: Math.max(1, Math.min(4, iv.length >> 1)), round: round ? 1 : 0, iv: a };
}

/** 利用者の vector の層の差し込み（#123）の計画：host＝差し込む基図の枠（無ければ null＝全部最後）・anchors＝境の li（昇順・重なりなし）・anchorOf(user の li)＝境か Infinity */
export interface UserAnchorPlan { host: string | null; anchors: number[]; anchorOf: (li: number) => number }
/** ranges＝[[liLo, liHi, anchor]…]：user の枠の li がその範囲の op は、基図の li が anchor 以上の項の前に描く（表に無い＝今どおり基図の上） */
export function userAnchorPlan(ranges: number[][], host: string | null | undefined): UserAnchorPlan {
	const R = ranges;
	const anchorOf = (li: number): number => { for (const r of R) if (li >= r[0] && li <= r[1]) return r[2]; return Infinity; };
	if (!host || !R.length) return { host: null, anchors: [], anchorOf };
	return { host, anchors: [...new Set(R.map(r => r[2]))].sort((x, y) => x - y), anchorOf };
}

/** 強調 overlay（setHighlight）の塗り：色の配列か { color, mask }（mask＝基図建物を伏せる）。既定＝橙 60%・mask の既定＝黒 15% */
export type HiFill = ArrayLike<number> | { color?: number[] | null; mask?: boolean } | null | undefined;
export function hiFillOf(fill: HiFill): { color: ArrayLike<number>; mask: boolean } {
	const isMask = !!fill && !Array.isArray(fill) && !ArrayBuffer.isView(fill);
	return isMask ? { color: (fill as { color?: number[] | null }).color || [0, 0, 0, 0.15], mask: !!(fill as { mask?: boolean }).mask } : { color: (fill as ArrayLike<number> | null | undefined) || [0.95, 0.55, 0.15, 0.6], mask: false };
}

/** 世界扇（wdepr の stencil 扇）の feature 毎レンジ＋外接円：C＝中心方向（単位）・cosR/sinR＝角半径・start/count＝扇の頂点範囲 */
export interface OverlayFeat { C: ArrayLike<number>; cosR: number; sinR: number; start: number; count: number }
/** 球体カリング①：完全裏側の feature は CPU でレンジごと描かない（対蹠点付近は VS クランプがリング一周巻き＝全面 +1 化する実測 2026-09-02）。
 *  可視判定＝中心方向と視線の角 − 角半径 < 地平角 ⇔ dot(C,Ê) > cos(hor+rad)（cos 加法・全て事前計算値）。連続レンジは結合して draw(first, count) へ */
export function worldFanRuns(feats: readonly OverlayFeat[], eye: ArrayLike<number>, draw: (first: number, count: number) => void): void {
	const eLen = Math.hypot(eye[0], eye[1], eye[2]) || 1;
	const cosH = Math.min(1, 1 / eLen), sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH));
	const ex = eye[0] / eLen, ey = eye[1] / eLen, ez = eye[2] / eLen;
	let run0 = -1, runN = 0;
	for (const f of feats) {
		const vis = f.C[0] * ex + f.C[1] * ey + f.C[2] * ez > f.cosR * cosH - f.sinR * sinH;
		if (vis && run0 >= 0 && f.start === run0 + runN) { runN += f.count; continue; }   // 連続レンジは結合
		if (runN) draw(run0, runN);
		run0 = vis ? f.start : -1; runN = vis ? f.count : 0;
	}
	if (runN) draw(run0, runN);
}
