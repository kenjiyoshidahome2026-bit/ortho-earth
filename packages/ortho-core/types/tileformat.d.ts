// @ortho-earth/core/tileformat — タイル形式の登録簿（MVT 既定・MLT は @ortho-earth/tile-formats）。
export interface DecodedLayer { name: string; features: unknown[]; extent: number }
export type DecodedTile = Record<string, DecodedLayer | unknown>;
export interface TileFormat {
	name: string;
	/** PMTiles の tile_type（MVT=1・MLT=6）。 */
	pmtilesType?: number | null;
	decode?: ((bytes: ArrayBuffer | Uint8Array, need?: Set<string> | null) => DecodedTile) | null;
	/** 解読器を遅延で読む。 */
	load?: (() => Promise<unknown>) | null;
}
export function registerTileFormat(f: TileFormat): void;
export const hasTileFormat: (name: string) => boolean;
export const tileFormatNames: () => string[];
export const tileFormatOfPmtilesType: (code: number) => string | null;
export const tileFormatReady: (name: string) => boolean;
export function loadTileFormat(name?: string): Promise<void>;
export function decodeTile(bytes: ArrayBuffer | Uint8Array, need?: Set<string> | null, encoding?: string): DecodedTile;
