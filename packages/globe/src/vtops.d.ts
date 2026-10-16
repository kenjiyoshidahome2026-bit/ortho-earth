// vtops.js（JS のまま）の型。gadgets/gjlabels.ts が読む分だけ（TS 化 段 4・batch 2）＝vtops.js が TS になれば消える。

/** 式の ["zoom"] を数へ（深い写し・["literal", …] の中は触らない） */
export function substituteZoom<T>(e: T, z: number): T;
/** 線をタイルの枠 [0,E]² で切る（戻り＝枠の中の連なり・全部が枠の外なら null） */
export function clipLineGeom(geom: { coords: ArrayLike<number>; ends: number[] }, E: number, opts?: { skipBoundary?: boolean }): { coords: Float64Array; ends: number[] } | null;
/** ["zoom"] の値の量子化（1/4 段） */
export const quantZoom: (z: number) => number;
