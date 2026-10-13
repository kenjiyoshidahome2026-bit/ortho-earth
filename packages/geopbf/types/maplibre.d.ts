// "geopbf/maplibre"（§8）＝addProtocol へ渡すハンドラ。maplibre-gl は import しない（型も自前の最小形）
import type { GeoPBF } from "./geopbf.js";
import type { LoadOptions } from "./load.js";
export { sanitizeProperties, loadGeopbf } from "./load.js";
export interface ProtocolRequest { url: string; type?: "string" | "json" | "arrayBuffer" | string; [key: string]: any }
export interface ProtocolResponse { data: any; cacheControl?: string; expires?: string }
export type ProtocolHandler = (params: ProtocolRequest, abortController?: AbortController) => Promise<ProtocolResponse>;
/** geopbf://…/{z}/{x}/{y} を MVT に組むタイル源（geopbf/tilesource の createTileSource） */
export interface TileSource { tile(z: number, x: number, y: number): Promise<Uint8Array | null>; destroy(): void; [key: string]: any }
export function createTileSource(pbf: GeoPBF, options?: Record<string, any>): Promise<TileSource>;
export interface TileProtocolOptions extends Pick<LoadOptions, "fetch"> {
	/** createTileSource の options（既定 {}） */
	tiler?: Record<string, any>;
	/** 内側 URL ごとの options */
	tilerOf?: (innerUrl: string) => Record<string, any> | null | undefined;
	/** Gint を焼く手（既定 pbf.gint()） */
	bake?: (pbf: GeoPBF) => Promise<unknown>;
	onSource?: (innerUrl: string, source: TileSource) => void;
}
export interface TileProtocolHandler extends ProtocolHandler { sources: Map<string, Promise<TileSource>>; dispose(innerUrl: string): Promise<void> }
export interface GeopbfProtocolOptions extends TileProtocolOptions { sanitize?: boolean; onMeta?: (innerUrl: string, meta: Record<string, any>) => void }
export interface GeopbfProtocolHandler extends ProtocolHandler { tiles: TileProtocolHandler }
/** "…/a.geopbf/3/7/3" → { inner, z, x, y }・タイル形でなければ null */
export function parseTileUrl(url: string): { inner: string; z: number; x: number; y: number } | null;
export function makeGeopbfTileProtocol(options?: TileProtocolOptions): TileProtocolHandler;
export const geopbfTileProtocol: TileProtocolHandler;
/** GeoJSON ソース（丸ごと）とベクタタイル（末尾 /z/x/y）の両方を捌く */
export function makeGeopbfProtocol(options?: GeopbfProtocolOptions): GeopbfProtocolHandler;
export const geopbfProtocol: GeopbfProtocolHandler;
