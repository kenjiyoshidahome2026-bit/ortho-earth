// メッシュ（建物・模型）の束の選び（改善計画の段階 3・2026-11-01）＝両 renderer が同式で持っていた純関数の正本。
// 「画面上 ~1px 未満の建物は描かない」の LOD 打ち切り・基図建物を伏せるマスクの選抜・マスクの OR＝GPU API を読まない。
import { worldRadiusM } from "./camera.ts";

/** LOD 打ち切りを持つ束＝index は建物高さ降順・lodCounts[k] で「高さ lodH[k] 以上だけ」を先頭打ち切り */
export interface LodBatch { bbox: ArrayLike<number>; count: number; lodH: ArrayLike<number> | null; lodCounts: ArrayLike<number> | null; two: number | boolean; keep2d: boolean }

/** 描く index の数。建物だけ＝橋梁（two＝両面）は「高さ 3〜5m×長さ数百 m」で小物と誤判定され桁が歯抜けになる（横浜ベイブリッジ実測）・
 *  keep2d（統計の押し出し）は低い値にも意味がある＝間引かない。遠方の束は距離で緩やかに閾値を上げる（チルト時の遠景は透視で 1px がもっと大きい＝控えめ側の近似） */
export function meshLodCount(p: LodBatch, center: ArrayLike<number>, cosLat: number, mppx: number): number {
	if (!p.lodH || p.two || p.keep2d) return p.count;
	const dm = Math.hypot(((p.bbox[0] + p.bbox[2]) / 2 - center[0]) * 111320 * cosLat, ((p.bbox[1] + p.bbox[3]) / 2 - center[1]) * 111320);
	const minH = mppx * (1 + dm / 4000);
	let li = 0;
	for (let i = p.lodH.length - 1; i > 0; i--) if (p.lodH[i] <= minH) { li = i; break; }
	return p.lodCounts![li];
}
/** 注視点の地面の高さ（持ち上げる束の間引きの第 2 候補・camera.ts liftedBboxVisible） */
export const liftGroundROf = (centerAlt: number | undefined): number => 1 + Math.max(0, centerAlt || 0) / worldRadiusM();

/** 基図建物を伏せるマスクの選抜＝注視点に近い bbox 順に max 個（同率は sort 安定性で Map 挿入順＝フレーム間で選抜が揺れない）。非表示区のマスクは載せない＝基図建物が戻る */
export function pickMeshMasks<M extends { bbox: ArrayLike<number> }>(masks: Map<string, M>, hidden: Set<string>, center: ArrayLike<number>, max: number): M[] {
	const mcx = center[0], mcy = center[1], mcw = Math.cos(mcy * Math.PI / 180);
	const mdist = (m: M): number => { const bb = m.bbox; const dx = Math.max(bb[0] - mcx, 0, mcx - bb[2]) * mcw, dy = Math.max(bb[1] - mcy, 0, mcy - bb[3]); return dx * dx + dy * dy; };
	return [...masks.entries()].filter(([w]) => !hidden.has(w)).map(([, m]) => m).sort((a, b) => mdist(a) - mdist(b)).slice(0, max);
}
/** マスクの OR（単調＝破壊しない）：maskCells＝立てる格子の番号（新 worker）・mask＝全量（旧 worker 互換） */
export function orMaskBytes(bytes: Uint8Array, maskCells: ArrayLike<number> | null | undefined, mask: ArrayLike<number> | null | undefined): void {
	if (maskCells) { for (let i = 0; i < maskCells.length; i++) { const c = maskCells[i]; if (c < bytes.length) bytes[c] = 255; } }
	else if (mask) for (let i = 0; i < mask.length && i < bytes.length; i++) if (mask[i]) bytes[i] = 255;
}
