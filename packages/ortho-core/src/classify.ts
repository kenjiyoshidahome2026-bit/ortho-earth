// 面の貼り付け（分類・2026-10-25）の set("classify")／set("classifyStyle") の形＝gl/classify.ts と gpu/classify.ts が共有する（gl/ と gpu/ は互いを読まない）
/** set("classify", data, key) の data＝柱一式（原点相対の三角形・全体で閉じていること）。色は 0..1 の直の α（前乗算しない） */
export interface ClassifyIn {
	pos: Float32Array; idx: Uint32Array; origin: ArrayLike<number>;
	color: ArrayLike<number>;
	/** 0＝両方（既定）・1＝地形だけ（建物・メッシュの画素を除く）・2＝建物・メッシュ（3D Tiles・模型）だけ */
	type?: number;
}
/** set("classifyStyle", { color, type }, key)＝塗りだけの差し替え（柱は据置） */
export interface ClassifyStyle { color?: ArrayLike<number>; type?: number }
/**
 * 真俯瞰の平ら化（renderer の pf＝標高を pitch で 0..1 に縮める）に柱を合わせる：原点の高さ h0 の flat 割を法線方向に下げる。
 * 地面は高さ h×pf に描かれる＝柱 [lo, hi]（lo ≤ h ≤ hi）を一様に −(1−pf)·h0（h0＝原点の高さ・柱の中ほど）ずらすと
 * [lo−(1−pf)h0, hi−(1−pf)h0] ∋ pf·h（線形で端点 pf＝0・1 とも成り立つ）＝真俯瞰（pf＝0）でも柱は 0 m の地面を挟む（Cesium は均さないので不要）。
 * flat＝1−pf（地形が無い・切ってある時は 0＝そのまま）。β 単位球の原点（|o|≈1）。原点が地表から 64 km 以上離れる柱（全球など）は動かさない。
 */
export function flatOrigin(o: ArrayLike<number>, flat: number): number[] {
	const r = Math.hypot(o[0], o[1], o[2]), h0 = r - 1;
	if (!(flat > 0) || !(Math.abs(h0) < 0.01)) return [o[0], o[1], o[2]];
	const k = (r - flat * h0) / r;
	return [o[0] * k, o[1] * k, o[2] * k];
}
