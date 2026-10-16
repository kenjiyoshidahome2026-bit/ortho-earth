// demtiles.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝demtiles.js が TS になれば消える。
/** raster-dem のタイルの在庫（hillshade と color-relief が共有） */
export interface DemTiles { spec: Record<string, unknown>; tile(z: number, x: number, y: number): Promise<{ h: Float32Array; n: number } | null>; size(): number }
/** fetchFn の答え（Response か、独自の読み口が画像で返した物＝bitmap） */
export interface DemTileResponse { ok: boolean; status: number; bitmap?: () => Promise<ImageBitmap>; blob?(): Promise<Blob> }
export function createDemTiles(dem: unknown, o?: { fetchFn?: (u: string, init?: RequestInit) => Promise<DemTileResponse>; cap?: number }): DemTiles;
