// @ortho-earth/core — 球面ベクタタイル描画エンジンの核（MVT を球面に直描き・WebGPU/GL2・地域を知らない層）。
// この地図は常に地球儀（平面メルカトルの描画は無い）。z の目盛りは 256px 世界＝MapLibre の z＋1。
// 2.0（TS 化 段 2）：純粋な部品は src/*.ts が型そのもの＝ここは src/index.js（根の口）の宣言として、.ts の口を同じ名で束ねるだけ。
// 手書きの型が残るのは renderer（gl/gpu）・2D 注記（labels2d）・後処理・worker の入口＝JS のまま置く側（gl.d.ts・gpu.d.ts・labels.d.ts…）。

export * from "../src/camera.ts";
export { createFlight, shortBearingOf, easePlan } from "../src/flight.ts";
export type { FlightController, CreateFlightOptions } from "../src/flight.ts";
export { createInput, isTypingTarget, INERTIA, INERTIA_WINDOW_MS, HANDLER_NAMES, bezierEase, inertiaOf, inertiaOf2, snapZoom } from "../src/input.ts";
export type { HandlerName, InertiaOptions, InputOptions, InputController } from "../src/input.ts";
export { evalExpr, truthy, originOfLayer, KNOWN_OPS, unknownOps, setGlobalState, getGlobalState, usesGlobalState } from "../src/expr.ts";
export type { Expression, ExprContext, FormatSection } from "../src/expr.ts";
export { parseRGBA, isColor } from "../src/color.ts";
export type { RGBA } from "../src/color.ts";
export { geodesicDistance, geodesicArea, primeVerticalRadius, meridionalRadius, AUTHALIC_R, WGS84 } from "../src/geodesic.ts";
export { parseViewHash, buildViewHash, wrapLon } from "../src/viewurl.ts";
export { fetchMVT, decodeTile, loadTileFormat, registerTileFormat } from "../src/decode.ts";
export type { TileFormat, DecodedTile, DecodedLayer } from "../src/tileformat.ts";
export { splitMapLibreStyle, loadMapLibreStyle, resolveVectorSource, tileUrlOf, convertLayer, convertFilter, convertValue, isExpressionFilter, shiftLayerZoom, shiftZoomExpr, normalizeMLLayer, layerDzOf, rescaleZoomExpr, rescaleZoomNum, DZ_KEY, mlUnknownOps } from "../src/mlstyle.ts";
export type { MLLayer } from "../src/mlstyle.ts";
export { buildGeoJSONOverlay, pointInFeature } from "../src/geojson.ts";
export { createLabelLayer } from "./labels.js";
export type { LabelLayer } from "./labels.js";
export { buildLabels } from "../src/labels.ts";
export { buildTileDrawList } from "../src/build.ts";
export { createTerrain } from "../src/terrain.ts";
export type { Terrain, TerrainOptions } from "../src/terrain.ts";
export { createRaster } from "../src/raster.ts";
export type { Raster, RasterOptions } from "../src/raster.ts";
export { createRasterSource, expandTemplate, normalizeSpec, wmsTemplate, wmtsFromCapabilities } from "../src/raster-src.ts";
export type { RasterSpec, RasterSource } from "../src/raster-src.ts";
export { WORLD_PAL_DEFAULT } from "../src/worldpal.ts";
export { createRenderer, createGintLayer } from "./gl.js";
export type { Renderer } from "./gpu.js";
export { buildFidStyle } from "../src/gint/style.ts";

// ── MapLibre 形の層 → gint の表（互換の段 4）
export { packMLLayers, buildMLTable, zoomSensitivity, ML_ID_KEY, ML_IX_KEY } from "../src/mltables.ts";

// ── タイル座標・問い合わせ・選抜
export { lonLatToTile, tileLocalToLonLat, tileBounds } from "../src/tile.ts";
export type { TileXYZ } from "../src/tile.ts";
export { queryTiles, sourceFeatures } from "../src/query.ts";
export type { QueryFeature, QueryOptions, SourceFeaturesOptions } from "../src/query.ts";
export { selectLOD } from "../src/tilecover.ts";
export type { SelectLODOptions } from "../src/tilecover.ts";
export { mlTileZoomOf, mlCalculateTileZoom, ML_FOV_DEG } from "../src/mlcover.ts";

// ── 書体（text-font → CSS）
export { parseFontStack, fontCss } from "../src/fontstack.ts";
export type { FontStack } from "../src/fontstack.ts";

// ── 建物・標高
export { buildBuildings, buildDrapedGeometry } from "../src/buildings.ts";
export { downsampleFlipped } from "../src/elevation.ts";
export type { ElevGrid, ElevTileGrid } from "../src/elevation.ts";

// ── 工場（render worker・main の配管）
export { createPipeline } from "../src/pipeline.ts";
export type { Pipeline, PipelineOptions } from "../src/pipeline.ts";
export { setWorkerFactory } from "../src/workerFactory.ts";
export type { WorkerRole, WorkerFactory } from "../src/workerFactory.ts";

// ── PMTiles
export { pmtilesInfo, isRasterTileType, fetchPMTilesRaw } from "../src/pmtiles-src.ts";
export type { PMTilesInfo } from "../src/pmtiles-src.ts";

// ── 外来の標高タイル（raster-dem）
export { createDemSource, decodeDEM, normalizeDemSpec } from "../src/dem-src.ts";
export type { DemEncoding, DemSpec, DemSpecInput, DemSource } from "../src/dem-src.ts";

// ── ジオイド高（EGM96）
export { loadGeoid, geoidHeight } from "../src/geoid.ts";
