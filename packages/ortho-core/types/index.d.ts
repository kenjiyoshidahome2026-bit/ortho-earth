// @ortho-earth/core — 球面ベクタタイル描画エンジンの核（MVT を球面に直描き・WebGPU/GL2・地域を知らない層）。
// この地図は常に地球儀（平面メルカトルの描画は無い）。z の目盛りは 256px 世界＝MapLibre の z＋1。
// 型は手書き（1.15.0〜）：利用者が呼ぶ口（カメラ・式・測地・色・URL・タイル形式・MapLibre style の読み替え）は厳密、
// render worker の内側で組む工場（renderer・pipeline・terrain・raster…）は形だけ。globe の口は @ortho-earth/globe の globe.d.ts。

export * from "./camera.js";
export { createFlight, shortBearingOf, flyPlan, glidePlan, glidePathPlan, easePlan } from "./flight.js";
export { createInput, isTypingTarget, INERTIA, INERTIA_WINDOW_MS, HANDLER_NAMES, bezierEase, inertiaOf, inertiaOf2, snapZoom } from "./input.js";
export type { HandlerName, InertiaOptions } from "./input.js";
export { evalExpr, truthy, originOfLayer, ORIGIN_KEY, KNOWN_OPS, unknownOps, setGlobalState, getGlobalState, usesGlobalState } from "./expr.js";
export type { Expression, ExprContext, FormatSection } from "./expr.js";
import type { ExprContext } from "./expr.js";
export { parseRGBA, isColor } from "./color.js";
export { geodesicDistance, geodesicArea, primeVerticalRadius, meridionalRadius, AUTHALIC_R, WGS84 } from "./geodesic.js";
export { parseViewHash, buildViewHash, wrapLon } from "./viewurl.js";
export { fetchMVT } from "./decode.js";
export { decodeTile, loadTileFormat, registerTileFormat } from "./tileformat.js";
export type { TileFormat, DecodedTile, DecodedLayer } from "./tileformat.js";
export { splitMapLibreStyle, loadMapLibreStyle, resolveVectorSource, vectorLayersOf, tileUrlOf, convertLayer, convertFilter, convertValue, isExpressionFilter, shiftLayerZoom, shiftZoomExpr, normalizeMLLayer, layerDzOf, rescaleZoomExpr, rescaleZoomNum, DZ_KEY, mlUnknownOps } from "./mlstyle.js";
export type { MLLayer } from "./mlstyle.js";
export { buildGeoJSONOverlay, pointInFeature } from "./geojson.js";
export { createLabelLayer } from "./labels.js";
export type { LabelLayer } from "./labels.js";
export { buildLabels } from "./tilelabels.js";
export { buildTileDrawList } from "./build.js";
export { createTerrain } from "./terrain.js";
export { createRaster } from "./raster.js";
export { createRasterSource, expandTemplate, normalizeSpec, wmsTemplate, wmtsTemplate, wmtsFromCapabilities } from "./raster-src.js";
export type { RasterSpec, RasterSource } from "./raster-src.js";
export { WORLD_PAL_DEFAULT } from "./worldpal.js";
export { createRenderer, createGintLayer } from "./gl.js";
export type { Renderer } from "./gpu.js";
export { buildFidStyle } from "./fidstyle.js";

// ── MapLibre 形の層 → gint の表（互換の段 4）
export const ML_ID_KEY: "ortho:mlid";
export const ML_IX_KEY: "ortho:mlix";
export const ML_DEFAULTS: Record<string, unknown>;
export function packMLLayers(layers: unknown[]): unknown[];
export function buildMLTable(pass: unknown, features?: unknown[], opts?: { zoom?: number; states?: unknown }): unknown;
export function zoomSensitivity(pass: unknown): unknown;

// ── タイル座標
export function lonLatToTile(lon: number, lat: number, z: number): [number, number];
export function tileLocalToLonLat(x: number, y: number, z: number, px: number, py: number, extent: number): [number, number];
/** [w, s, e, n]（度） */
export function tileBounds(x: number, y: number, z: number): number[];
/** 描いているタイルへの問い合わせ（queryRenderedFeatures 相当・非同期）。 */
export function queryTiles(opts: Record<string, unknown>): Promise<unknown[]>;
/** 解読済みタイル 1 枚の source-layer の地物を全部 GeoJSON で（querySourceFeatures 相当・同期・C7）。 */
export function sourceFeatures(data: Record<string, unknown>, tile: { z: number; x: number; y: number; key?: string }, opts: { sourceLayer: string; filter?: unknown; zoom?: number; gs?: unknown; promoteId?: unknown; source?: string; pitch?: number }): unknown[];
export function selectLOD(cam: import("./camera.js").CameraPose, W: number, H: number, opts?: Record<string, unknown>): unknown;
/** MapLibre の既定の縦の視野角（2·atan(3/4)）≈ 36.87°。 */
export const ML_FOV_DEG: number;
export function mlCalculateTileZoom(centerZ: number, dist2D: number, distZ: number, dist3DCenter: number, fovDeg: number, maxLevels?: number, maxMinRatio?: number): number;
export function mlTileZoomOf(cam: import("./camera.js").CameraPose, Hcss: number, cover: unknown, opts?: { tileSize?: number; round?: boolean }): number;

// ── 式の地理（["within"]・["distance"] の中身・C2）
export interface GeoJSONGeometry { type: string; coordinates: unknown }
/** ctx（geojson か feat＋tile）→ 地物の形（経緯度）。無ければ null。 */
export function featureGeomLL(ctx: ExprContext): GeoJSONGeometry | null;
/** 地物が輪の列（面）の中か（MapLibre の within の約束＝境界の上は偽・面と Multi* は偽）。 */
export function withinGeom(g: GeoJSONGeometry | null | undefined, rings: number[][][]): boolean;
/** 地物と入力の GeoJSON の最短距離［m］。形が無ければ null。 */
export function distanceGeom(g: GeoJSONGeometry | null | undefined, target: unknown): number | null;

// ── 書体（text-font → CSS）
export interface FontStack { fa: string; w: number; st: string }
export function parseFontStack(names: string[] | string | null | undefined): FontStack;
export const fontCss: (f: FontStack | null | undefined, size: number, fallback?: string) => string;

// ── 建物・標高・場面
export function buildBuildings(tile: { layers: unknown; z: number; x: number; y: number }, origin: number[], schema?: unknown): unknown;
export function buildExtrudedParcels(features: unknown[], origin: number[], opts?: { heightM?: number; exag?: number }): unknown;
export function buildDrapedGeometry(features: unknown[], origin: number[], opts?: { liftM?: number; exag?: number }): unknown;
export function downsampleFlipped(tile: unknown, N: number, M?: number): unknown;
export function mergeTiles(order: unknown[], geomOf: (id: unknown) => unknown, opts?: Record<string, unknown>): unknown;

// ── 工場（render worker・main の配管。戻りの形は各モジュールの注記が正典）
export function createTileManager(opts: Record<string, unknown>): { [k: string]: unknown };
export function createPipeline(opts: Record<string, unknown>): { [k: string]: unknown };
export type WorkerRole = "ortho:scene" | "ortho:tile" | "ortho:height";
/** ホストの worker 工場。役割名だけを受け取る（fn(role)）。null／undefined を返せば組み込みの worker。 */
export type WorkerFactory = (role: WorkerRole) => Worker | null | undefined;
/** worker の入口を差し替える（役割 "ortho:scene" / "ortho:tile" / "ortho:height"）。null＝既定へ戻す。 */
export function setWorkerFactory(fn: WorkerFactory | null): void;

// ── PMTiles
export const isPMTiles: (url: string) => boolean;
export function pmtilesInfo(url: string): Promise<{ bounds?: number[]; minZoom?: number; maxZoom?: number; layers?: string[]; tileType?: string; [k: string]: unknown } | null>;
export const isRasterTileType: (t: unknown) => boolean;
export function fetchPMTilesRaw(url: string, z: number, x: number, y: number, signal?: AbortSignal | null): Promise<ArrayBuffer | null>;

// ── 外来の標高タイル（raster-dem）
export type DemEncoding = "terrarium" | "mapbox" | "gsi" | "custom";
export interface DemSpec { tiles?: string[]; url?: string; encoding?: DemEncoding; tileSize?: number; minzoom?: number; maxzoom?: number; redFactor?: number; greenFactor?: number; blueFactor?: number; baseShift?: number; [k: string]: unknown }
export function decodeDEM(rgba: Uint8ClampedArray | Uint8Array, encoding?: DemEncoding, f?: Partial<DemSpec> | null): Float32Array;
export function normalizeDemSpec(spec: DemSpec | string): DemSpec;
export function createDemSource(spec: DemSpec | string): { [k: string]: unknown };

// ── quantized-mesh（Cesium 地形）
export function decodeQuantizedMesh(buf: ArrayBuffer): { verts: Float32Array | number[]; tris: Uint32Array | Uint16Array | number[]; minH: number; maxH: number; [k: string]: unknown };
export function parseQuantizedMeshLayer(j: Record<string, unknown>, base: string): Record<string, unknown>;

// ── ジオイド高（EGM96）
export function loadGeoid(): Promise<void>;
export function geoidHeight(lon: number, lat: number): number;
