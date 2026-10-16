// mesh-features.js（JS のまま）の型。gadgets の model・tiles3d が読む分だけ（TS 化 段 4・batch 2）＝mesh-features.js が TS になれば消える。

/** property table（EXT_structural_metadata）か batch table の 1 枚＝列の名前 → 行ごとの値 */
export interface PropertyTable { name: string | null; class: string | null; count: number; columns: Record<string, unknown[]> }
/** 束の地物の番号（worker の答え）＝ids＝頂点ごとの番号・tblV＝頂点ごとの property table の番号（無ければ table＝束で 1 つ） */
export interface MeshFeatures { ids: Uint32Array; tblV?: ArrayLike<number> | null; table?: number | null; tables?: PropertyTable[] | null }
/** 行（地物の番号）→ 属性の素のオブジェクト（表が無い・範囲外＝{}） */
export function featureProperties(table: PropertyTable | null | undefined, id: number): Record<string, unknown>;
