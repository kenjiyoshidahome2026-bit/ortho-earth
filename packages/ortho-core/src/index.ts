// @ortho-earth/core: 球面ベクタタイル描画エンジン（MVT を正射の球面に直描き・WebGPU/GL2）。地域を知らない硬い層（LAYERS.md）。
// 地球儀のホストは @ortho-earth/globe、日本の地図は @ortho-earth/japan（SDK）がこれを包む。v1 の ortho-map とは無関係。
// TS 化 段 3（batch G2）：根の口そのもの（旧 types/index.d.ts を畳んだ）。段 4 で renderer（gl/**・gpu/**）と 2D 注記（labels2d）も .ts になった。
export { evalExpr, truthy, originOfLayer, KNOWN_OPS, unknownOps, setGlobalState, getGlobalState, usesGlobalState, exprDeps, exprKind } from "./expr.ts";
export type { Expression, ExprContext, FormatSection, ExprKind, ExprDeps } from "./expr.ts";
export { packMLLayers, buildMLTable, zoomSensitivity, ML_ID_KEY, ML_IX_KEY } from "./mltables.ts";   // MapLibre 形の fill/line/circle → gint の表（互換の段 4）
export { parseRGBA, isColor } from "./color.ts";
export type { RGBA } from "./color.ts";
export { fetchMVT, decodeTile, loadTileFormat, registerTileFormat } from "./decode.ts";   // タイル形式の登録簿（MVT 既定・MLT は @ortho-earth/tile-formats・#88）
export type { TileFormat, DecodedTile, DecodedLayer } from "./tileformat.ts";
export { queryTiles, sourceFeatures } from "./query.ts";   // 描画結果への問い合わせ（queryRenderedFeatures 相当＝描いているタイルを取り直して今のスタイルで当てる）
export type { QueryFeature, QueryOptions, SourceFeaturesOptions } from "./query.ts";
export { lonLatToTile, tileLocalToLonLat, tileBounds } from "./tile.ts";
export type { TileXYZ } from "./tile.ts";
export { buildTileDrawList } from "./build.ts";
export { createRenderer } from "./gl/renderer.ts";
export type { Renderer } from "./gl/renderer.ts";
export { createGintLayer } from "./gl/gint/embed.ts";
export { buildFidStyle } from "./gint/style.ts";
export { buildLabels } from "./labels.ts";
export { parseFontStack, fontCss } from "./fontstack.ts";   // text-font → CSS の書体（段 2）
export type { FontStack } from "./fontstack.ts";
export { buildGeoJSONOverlay, pointInFeature } from "./geojson.ts";
export { buildBuildings, buildDrapedGeometry } from "./buildings.ts";
export { downsampleFlipped } from "./elevation.ts";
export type { ElevGrid, ElevTileGrid } from "./elevation.ts";
export { createLabelLayer } from "./labels2d.ts";
export type { LabelLayer } from "./labels2d.ts";
export * from "./camera.ts";   // カメラは全部（@ortho-earth/core/camera と同じ口＝projectClip・viewRays・sphereRayUniforms・anchorUV・ellAxisRatio も根から読める・2.0）
export { createFlight, shortBearingOf, easePlan } from "./flight.ts";
export type { FlightController, CreateFlightOptions } from "./flight.ts";
export { createInput, isTypingTarget, INERTIA, INERTIA_WINDOW_MS, HANDLER_NAMES, bezierEase, inertiaOf, inertiaOf2, snapZoom } from "./input.ts";
export type { HandlerName, InertiaOptions, InputOptions, InputController } from "./input.ts";
export { parseViewHash, buildViewHash, wrapLon } from "./viewurl.ts";
export { selectLOD } from "./tilecover.ts";
export type { SelectLODOptions } from "./tilecover.ts";
export { mlTileZoomOf, mlCalculateTileZoom, ML_FOV_DEG } from "./mlcover.ts";   // MapLibre のタイルの z の選び方（目盛り mercator／maplibre）
export { createPipeline } from "./pipeline.ts";
export type { Pipeline, PipelineOptions } from "./pipeline.ts";
export { setWorkerFactory } from "./workerFactory.ts";   // worker の入口を差し替える（役割 "ortho:scene" / "ortho:tile" / "ortho:height"・createPipeline の workerFactory でも可・2026-09-22）
export type { WorkerRole, WorkerFactory } from "./workerFactory.ts";
export { createTerrain } from "./terrain.ts";
export type { Terrain, TerrainOptions } from "./terrain.ts";
export { geodesicDistance, geodesicArea, primeVerticalRadius, meridionalRadius, AUTHALIC_R, WGS84 } from "./geodesic.ts";
export { WORLD_PAL_DEFAULT } from "./worldpal.ts";
export { pmtilesInfo, isRasterTileType, fetchPMTilesRaw } from "./pmtiles-src.ts";   // isRasterTileType＝?pm= のアーカイブがラスタ（png/jpeg/webp/avif）か＝画像タイル層へ回す判定   // PMTiles アーカイブの自己申告（bbox/ズーム域/層名）＝範囲制御の正本。消費者が bbox を手で持たないための口
export type { PMTilesInfo } from "./pmtiles-src.ts";
export { createRaster } from "./raster.ts";   // 画像タイル層（メルカトル XYZ ラスタ・render worker 常駐）
export type { Raster, RasterOptions } from "./raster.ts";
export { createRasterSource, expandTemplate, normalizeSpec, wmsTemplate, wmtsFromCapabilities } from "./raster-src.ts";   // z/x/y→ImageBitmap のプロバイダ契約（xyz/pmtiles/port）
export type { RasterSpec, RasterSource } from "./raster-src.ts";
export { splitMapLibreStyle, loadMapLibreStyle, resolveVectorSource, tileUrlOf, convertLayer, convertFilter, convertValue, isExpressionFilter, shiftLayerZoom, shiftZoomExpr, normalizeMLLayer, layerDzOf, rescaleZoomExpr, rescaleZoomNum, DZ_KEY, mlUnknownOps } from "./mlstyle.ts";   // 外来の MapLibre style.json を基図 style へ（#33）
export type { MLLayer } from "./mlstyle.ts";
export { createDemSource, decodeDEM, normalizeDemSpec } from "./dem-src.ts";   // 外来の標高タイル（raster-dem・#36）
export type { DemEncoding, DemSpec, DemSpecInput, DemSource } from "./dem-src.ts";
export { loadGeoid, geoidHeight } from "./geoid.ts";   // ジオイド高（EGM96 30 分・楕円体高 → 標高）
