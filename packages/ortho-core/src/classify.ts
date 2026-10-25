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
