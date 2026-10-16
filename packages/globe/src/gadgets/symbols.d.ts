// gadgets/symbols.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝symbols.js が TS になれば消える。
import type { MLLayer } from "@ortho-earth/core";
import type { GlobeMap } from "../types/map.ts";

/** 記号帳の 1 枚（伸びる記号＝stretchX／stretchY／content は元の px） */
export interface SymbolImage {
	bitmap: ImageBitmap; pixelRatio: number; sdf: boolean;
	stretchX: Array<[number, number]> | null; stretchY: Array<[number, number]> | null; content: [number, number, number, number] | null;
}
export type SymbolImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | ImageData | Blob | string | { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
export interface SymbolFeature {
	type: "Feature"; properties: Record<string, unknown>; geometry: { type: "Point"; coordinates: [number, number] }; layer: { id: string; type: "symbol" }; source: "symbols";
}
/** 記号帳（sprite）と記号の層 */
export interface Symbols {
	addImage(name: string, src: SymbolImageSource, o?: { pixelRatio?: number; sdf?: boolean; stretchX?: Array<[number, number]> | null; stretchY?: Array<[number, number]> | null; content?: [number, number, number, number] | null }): Promise<SymbolImage>;
	updateImage(name: string, src: SymbolImageSource): Promise<SymbolImage>;
	removeImage(name: string): void;
	hasImage(name: string): boolean;
	getImage(name: string): SymbolImage | null;
	listImages(): string[];
	/** MapLibre の sprite（base.json＋base.png・@2x）。prefix＝複数の sprite の id。戻り値＝足した名前の数 */
	loadSprite(base: string, prefix?: string): Promise<number>;
	addLayer(id: string, src: unknown, layer: Partial<MLLayer>): { features: number };
	removeLayer(id: string): void;
	setOrder(id: string, n: number): void;
	readonly layerIds: string[];
	symbolsAt(x: number, y: number): SymbolFeature[];
	destroy(): void;
}
export function createSymbols(map: GlobeMap, o?: {
	signal?: AbortSignal; onImage?: ((name: string, e: SymbolImage) => unknown) | null; onImageRemoved?: ((name: string) => void) | null; onMissing?: ((name: string) => void) | null;
}): Symbols;
