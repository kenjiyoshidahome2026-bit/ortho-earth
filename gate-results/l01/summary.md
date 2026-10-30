# Cesium examples gate (CesiumJS 1.146.0) — 2026-10-30T02:09:28.333Z

63 examples · not graded (real Cesium does not run it here, it starts in 2D, or it is the Moon / Mars): 0 · ours does not run: 0 · runs: 31 · same answers: 13 · same picture: 19

## Blockers

| n | blocker | examples |
|---|---|---|
| 13 | picture differs | aerometrex-san-francisco, classification, clipping-regions, ground-polyline-material-dev, headingpitchroll, high-dynamic-range … |
| 6 | camera differs | callback-position-property, callback-property, constant-lod-dev, czml-custom-properties, khr-mesh-primitive-restart-dev, particle-system |
| 4 | 3D Tiles draw nothing | drape-imagery-on-3d-tiles, google-streetview-panorama, imodel-mesh-export-service, itwin-gaussian-splats |
| 3 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) | i3s-3d-object-layer, i3s-feature-picking, i3s-integratedmesh-layer |
| 2 | entities differ | 3d-tiles-nga-gpm-visualization, pick-from-ray-dev |
| 2 | unsupported: material PolylineGlow (drawn in its colour) | geometry-and-appearances-dev, polyline-material-dev |
| 2 | unsupported: terrain provider CesiumTerrainProvider | arcticdem, pamap-terrain |
| 1 | render error: julianDate is required. | scene-rendering-performance |
| 1 | unsupported: I3SDataProvider.filterByAttributes | i3s-building-scene-layer |
| 1 | unsupported: material CustomBoxShader (drawn white) | material-with-custom-glsl |
| 1 | unsupported: material Dot (drawn in its colour) | ellipsoid-surface-dev |
| 1 | unsupported: material PolylineArrow (drawn in its colour) | polyline-material-dev |
| 1 | unsupported: material PolylineOutline (drawn in its colour) | polyline-material-dev |
| 1 | unsupported: material RimLighting (drawn in its colour) | volumes-dev |
| 1 | unsupported: model animation animationTime (a time function) | manually-controlled-animation |
| 1 | unsupported: orthographic frustum (ProjectionPicker) | projection |
| 1 | unsupported: polyline material Fade (drawn in its colour) | polylines-dev |
| 1 | unsupported: polyline material PolylineArrow (drawn in its colour) | polylines-dev |
| 1 | unsupported: scene.pickFromRay | pick-from-ray-dev |
| 1 | unsupported: terrain provider ArcGISTiledElevationTerrainProvider | arcgis-tiled-elevation-terrain |
| 1 | unsupported: terrain provider CustomHeightmapTerrainProvider | procedural-terrain |
| 1 | unsupported: Viewer option vrButton | cardboard |
| 1 | unsupported: WebMapTileServiceImageryProvider in KVP encoding | web-map-tile-service-picking |

## Examples

| example | level | why |
|---|---|---|
| 3d-models-dev (dev) | 3 |  |
| 3d-tiles-1.1-photogrammetry | 3 |  |
| 3d-tiles-3d-native-vector | 3 |  |
| 3d-tiles-clipping-planes | 3 |  |
| 3d-tiles-nga-gpm-visualization | 1 | entities 10/0 |
| aec-tileset-metadata-filtering | 3 |  |
| aerometrex-san-francisco | 2 | picture: colour 51% · edges 78% of the cells match · a patch of 909 cells differs |
| arcgis-tiled-elevation-terrain | 1 | unsupported: terrain provider ArcGISTiledElevationTerrainProvider |
| arcticdem | 1 | unsupported: terrain provider CesiumTerrainProvider |
| billboardclamptoground-dev (dev) | 3 |  |
| callback-position-property | 1 | camera (Δ 1152 m · Δangle 60.4°) |
| callback-property | 1 | camera (Δ 1340 m · Δangle 0.0°) |
| cardboard | 1 | unsupported: Viewer option vrButton |
| classification | 2 | picture: colour 22% · edges 16% of the cells match · a patch of 1040 cells differs |
| clipping-regions | 2 | picture: colour 94% · edges 98% of the cells match · a patch of 118 cells differs |
| cloud-parameters | 3 |  |
| clouds | 3 |  |
| constant-lod-dev (dev) | 1 | camera (Δ 14814 m · Δangle 100.9°) |
| custom-shaders-3d-tiles | 3 |  |
| czml-custom-properties | 1 | camera (Δ 27636 m · Δangle 0.0°) |
| drape-imagery-on-3d-tiles | 1 | 3D Tiles drawn 11/0 |
| elevation-band-material | 3 |  |
| ellipsoid-surface-dev (dev) | 1 | unsupported: material Dot (drawn in its colour) |
| geometry-and-appearances-dev (dev) | 1 | unsupported: material PolylineGlow (drawn in its colour) |
| google-streetview-panorama | 1 | 3D Tiles drawn 31/0 |
| ground-polyline-material-dev (dev) | 2 | picture: colour 77% · edges 74% of the cells match · a patch of 22 cells differs |
| headingpitchroll | 2 | picture: colour 86% · edges 95% of the cells match · a patch of 108 cells differs |
| high-dynamic-range | 2 | picture: colour 67% · edges 64% of the cells match · a patch of 155 cells differs |
| i3s-3d-object-layer | 1 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) |
| i3s-building-scene-layer | 1 | unsupported: I3SDataProvider.filterByAttributes |
| i3s-feature-picking | 1 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) |
| i3s-integratedmesh-layer | 1 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) |
| imodel-mesh-export-service | 1 | 3D Tiles drawn 74/0 |
| itwin-gaussian-splats | 1 | 3D Tiles drawn 1/0 |
| japan-buildings | 2 | picture: colour 84% · edges 93% of the cells match · a patch of 32 cells differs |
| khr-mesh-primitive-restart-dev (dev) | 1 | camera (Δ 17210790 m · Δangle 44.9°) |
| localtofixedframe | 3 |  |
| manually-controlled-animation | 1 | unsupported: model animation animationTime (a time function) |
| material-with-custom-glsl | 1 | unsupported: material CustomBoxShader (drawn white) |
| pamap-terrain | 1 | unsupported: terrain provider CesiumTerrainProvider |
| panorama | 3 |  |
| particle-system | 1 | camera (Δ 125 m · Δangle 0.0°) |
| particle-system-fireworks | 3 |  |
| particle-system-tails | 3 |  |
| particle-system-weather | 2 | picture: colour 61% · edges 88% of the cells match · a patch of 423 cells differs |
| per-feature-post-processing | 3 |  |
| pick-from-ray-dev (dev) | 1 | unsupported: scene.pickFromRay; entities 4/3 |
| plane | 3 |  |
| polyline-material-dev (dev) | 1 | unsupported: material PolylineGlow (drawn in its colour), material PolylineArrow (drawn in its colour), material PolylineOutline (drawn in its colour) |
| polylines-dev (dev) | 1 | unsupported: polyline material Fade (drawn in its colour), polyline material PolylineArrow (drawn in its colour) |
| polylines-on-terrain-dev (dev) | 3 |  |
| procedural-terrain | 1 | unsupported: terrain provider CustomHeightmapTerrainProvider |
| projection | 1 | unsupported: orthographic frustum (ProjectionPicker) |
| sample-height-from-3d-tiles | 2 | picture: colour 28% · edges 34% of the cells match · a patch of 502 cells differs |
| scene-rendering-performance | 1 | render error: julianDate is required. |
| shadows-dev (dev) | 2 | picture: colour 4% · edges 71% of the cells match · a patch of 401 cells differs |
| terrain-exaggeration | 2 | picture: colour 80% · edges 90% of the cells match · a patch of 56 cells differs |
| time-dynamic-point-cloud | 3 |  |
| video | 2 | picture: colour 54% · edges 91% of the cells match · a patch of 376 cells differs |
| volumecloud | 3 |  |
| volumes-dev (dev) | 1 | unsupported: material RimLighting (drawn in its colour) |
| voxels-in-3d-tiles | 2 | picture: colour 48% · edges 99% of the cells match · a patch of 1236 cells differs |
| web-map-tile-service-picking | 1 | unsupported: WebMapTileServiceImageryProvider in KVP encoding |
