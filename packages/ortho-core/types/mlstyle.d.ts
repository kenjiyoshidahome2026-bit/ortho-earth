// MapLibre style.json の読み替え（旧式フィルタ・stops・{token}・z のずらし）。
export type MLLayer = { id: string; type: string; source?: string; "source-layer"?: string; filter?: unknown; layout?: Record<string, unknown>; paint?: Record<string, unknown>; minzoom?: number; maxzoom?: number; metadata?: Record<string, unknown> };
export function isExpressionFilter(f: unknown): boolean;
export function convertFilter(f: unknown): unknown;
export function convertValue(v: unknown, prop?: string): unknown;
export function convertLayer(L: MLLayer): MLLayer;
export function shiftZoomExpr<T>(e: T, dz: number): T;
export function shiftLayerZoom(L: MLLayer, dz: number): MLLayer;
export const DZ_KEY: "ortho:dz";
export function layerDzOf(L: MLLayer, dflt?: number): number;
/** 入口 1 本＝旧式を式へ・z を dz だけずらし metadata["ortho:dz"] で冪等。 */
export function normalizeMLLayer(L: Partial<MLLayer>, dz?: number): MLLayer;
export const rescaleZoomExpr: <T>(e: T, fromDz: number, toDz: number) => T;
export const rescaleZoomNum: (x: number | null | undefined, fromDz: number, toDz: number) => number | null | undefined;
export function mlUnknownOps(L: MLLayer): Set<string>;
export function splitMapLibreStyle(style: Record<string, unknown>, opts?: { zoomOffset?: number }): Record<string, unknown>;
export function loadMapLibreStyle(src: string | Record<string, unknown>, opts?: { fetchFn?: typeof fetch }): Promise<Record<string, unknown>>;
export function resolveVectorSource(sp: Record<string, unknown>, baseUrl: string, opts?: { fetchFn?: typeof fetch }): Promise<Record<string, unknown>>;
export function tileUrlOf(src: Record<string, unknown>): ((z: number, x: number, y: number) => string) | string | null;
