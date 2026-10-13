// @ortho-earth/core/raster-src — z/x/y → ImageBitmap のプロバイダ契約（xyz・pmtiles・WMS・WMTS・MessagePort）。
export interface RasterSpec {
	type?: "raster";
	tiles?: string[];
	url?: string;
	tileSize?: number;
	minzoom?: number;
	maxzoom?: number;
	scheme?: "xyz" | "tms";
	subdomains?: string[];
	headers?: Record<string, string>;
	bounds?: number[];
	attribution?: string;
	[k: string]: unknown;
}
export interface RasterSource {
	fetchTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<ImageBitmap | null>;
	spec: RasterSpec;
	[k: string]: unknown;
}
export function expandTemplate(tpl: string, z: number, x: number, y: number, subdomains?: string[] | null, tms?: boolean, matrixIds?: string[] | null, tileSize?: number): string;
export function normalizeSpec(spec: RasterSpec | string): RasterSpec;
export function wmsTemplate(w: Record<string, unknown>): string;
export function wmtsTemplate(w: Record<string, unknown>): string;
export function wmtsFromCapabilities(xml: string, opts?: { layer?: string; style?: string; format?: string; capabilitiesUrl?: string }): RasterSpec;
export function adjustRGBA(px: Uint8ClampedArray, adj: Record<string, number>): void;
export function createRasterSource(spec: RasterSpec | string): Promise<RasterSource>;
