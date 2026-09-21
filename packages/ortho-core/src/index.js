// ortho-japan: 球面ベクタタイル描画エンジン（MLIT/地理院 optimal_bvmap 等のMVTを ortho 球面に直描き）。
// 本番 ortho-map からは独立。現行アプリのimportグラフには含めない。
export { evalExpr, truthy } from "./expr.js";
export { parseRGBA } from "./color.js";
export { fetchMVT } from "./decode.js";
export { queryTiles } from "./query.js";   // 描画結果への問い合わせ（queryRenderedFeatures 相当＝描いているタイルを取り直して今のスタイルで当てる）
export { lonLatToTile, tileLocalToLonLat, tileBounds } from "./tile.js";
export { buildTileDrawList } from "./build.js";
export { createRenderer } from "./gl/renderer.js";
export { createGintLayer } from "./gl/gint/embed.js";
export { buildFidStyle } from "./gl/gint/style.js";
export { buildLabels } from "./labels.js";
export { buildGeoJSONOverlay, pointInFeature } from "./geojson.js";
export { buildBuildings, buildExtrudedParcels, buildDrapedGeometry } from "./buildings.js";
export { downsampleFlipped } from "./elevation.js";
export { createLabelLayer } from "./labels2d.js";
export { cameraState, project, unproject, lonlatTo3D, WORLD_PX,
	setEllipsoid, ellipsoidOn, worldRadiusM, betaOf, geodeticOf, ellNormal3D, worldToLonLat, betaToLonLat } from "./camera.js";
export { createFlight, shortBearingOf, flyPlan, glidePlan, glidePathPlan } from "./flight.js";
export { createInput, isTypingTarget } from "./input.js";
export { parseViewHash, buildViewHash, wrapLon } from "./viewurl.js";
export { selectLOD } from "./tilecover.js";
export { createTileManager } from "./tilemanager.js";
export { createPipeline } from "./pipeline.js";
export { setWorkerFactory } from "./workerFactory.js";   // worker の入口を差し替える（役割 "ortho:scene" / "ortho:tile"・createPipeline の workerFactory でも可・2026-09-22）
export { createTerrain } from "./terrain.js";
export { mergeTiles } from "./scene.js";
export { geodesicDistance, geodesicArea, primeVerticalRadius, meridionalRadius, AUTHALIC_R, WGS84 } from "./geodesic.js";
export { WORLD_PAL_DEFAULT } from "./worldpal.js";
export { pmtilesInfo, isPMTiles, isRasterTileType } from "./pmtiles-src.js";   // isRasterTileType＝?pm= のアーカイブがラスタ（png/jpeg/webp/avif）か＝画像タイル層へ回す判定   // PMTiles アーカイブの自己申告（bbox/ズーム域/層名）＝範囲制御の正本。消費者が bbox を手で持たないための口
export { createRaster } from "./raster.js";   // 画像タイル層（メルカトル XYZ ラスタ・render worker 常駐）
export { createRasterSource, expandTemplate, normalizeSpec } from "./raster-src.js";   // z/x/y→ImageBitmap のプロバイダ契約（xyz/pmtiles/port）
