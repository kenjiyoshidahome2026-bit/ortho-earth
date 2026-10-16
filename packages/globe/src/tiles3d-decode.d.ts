// tiles3d-decode.js（JS のまま＝group M）の型。sunshadow.ts が読む分だけ（TS 化 段 4・batch 3）＝tiles3d-decode.js が TS になれば消える。

/** 焼いた 1 バッチのメッシュ（原点＝RTE・pos は原点相対・idx は三角形） */
export interface Tile3DBatch { mesh: { origin: ArrayLike<number>; pos: ArrayLike<number>; idx: ArrayLike<number>; [k: string]: unknown }; [k: string]: unknown }
export function decodeTile3D(ab: ArrayBuffer, opts?: {
	transform?: ArrayLike<number> | null; baseUri?: string; baseH?: number; textures?: boolean; maxInstances?: number;
	ground?: "absolute" | "terrain"; featureIdSet?: number;
}): Promise<{ batches: Tile3DBatch[]; points: unknown[]; stats: { triangles: number; points: number } } | null>;
