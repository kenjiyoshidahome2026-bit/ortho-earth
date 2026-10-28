# Cesium examples gate (CesiumJS 1.146.0) — 2026-10-28T03:37:58.206Z

309 examples · not graded (real Cesium does not run it here, it starts in 2D, or it is the Moon / Mars): 12 · ours does not run: 9 · runs: 43 · same answers: 121 · same picture: 124

## Blockers

| n | blocker | examples |
|---|---|---|
| 121 | picture differs | 3d-models, 3d-models-coloring, 3d-models-node-explorer-dev, 3d-tiles-1.1-cdb-yemen, 3d-tiles-1.1-photogrammetry, 3d-tiles-1.1-photogrammetry-classification … |
| 7 | never finished loading | billboardclamptoground-dev, elevation-band-material, ground-polyline-material-dev, high-dynamic-range, polylines-on-terrain-dev, terrain-exaggeration … |
| 6 | camera differs | callback-property, clipping-regions, constant-lod-dev, czml-custom-properties, khr-mesh-primitive-restart-dev, time-dynamic-point-cloud |
| 4 | unsupported: scene.primitives.add(ParticleSystem) | particle-system, particle-system-fireworks, particle-system-tails, particle-system-weather |
| 3 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) | i3s-3d-object-layer, i3s-feature-picking, i3s-integratedmesh-layer |
| 3 | unsupported: model animation multiplier | 3d-models-dev, headingpitchroll, manually-controlled-animation |
| 3 | unsupported: scene.primitives.add(Cesium3DTileset) | drape-imagery-on-3d-tiles, imodel-mesh-export-service, itwin-gaussian-splats |
| 2 | entities differ | 3d-tiles-nga-gpm-visualization, pick-from-ray-dev |
| 2 | unsupported: entity.plane | 3d-tiles-clipping-planes, plane |
| 2 | unsupported: material PolylineGlow (drawn in its colour) | geometry-and-appearances-dev, polyline-material-dev |
| 2 | unsupported: scene.primitives.add(CloudCollection) | cloud-parameters, clouds |
| 2 | unsupported: terrain provider CesiumTerrainProvider | arcticdem, pamap-terrain |
| 1 | exception: DeveloperError | shadows-dev |
| 1 | exception: tileset.metadata.getProperty is not a function | aec-tileset-metadata-filtering |
| 1 | render error: julianDate is required. | scene-rendering-performance |
| 1 | unsupported: Cesium3DTileset option clippingPlanes | 3d-tiles-clipping-planes |
| 1 | unsupported: Cesium3DTileset option customShader | custom-shaders-3d-tiles |
| 1 | unsupported: I3SDataProvider.filterByAttributes | i3s-building-scene-layer |
| 1 | unsupported: material CustomBoxShader (drawn white) | material-with-custom-glsl |
| 1 | unsupported: material Dot (drawn in its colour) | ellipsoid-surface-dev |
| 1 | unsupported: material PolylineArrow (drawn in its colour) | polyline-material-dev |
| 1 | unsupported: material PolylineOutline (drawn in its colour) | polyline-material-dev |
| 1 | unsupported: orthographic frustum (ProjectionPicker) | projection |
| 1 | unsupported: polyline material Fade (drawn in its colour) | polylines-dev |
| 1 | unsupported: polyline material PolylineArrow (drawn in its colour) | polylines-dev |
| 1 | unsupported: scene.pickFromRay | pick-from-ray-dev |
| 1 | unsupported: scene.primitives.add(DebugModelMatrixPrimitive) | localtofixedframe |
| 1 | unsupported: scene.primitives.add(EllipsoidPrimitive) | volumes-dev |
| 1 | unsupported: scene.primitives.add(EquirectangularPanorama) | panorama |
| 1 | unsupported: scene.primitives.add(TimeDynamicPointCloud) | time-dynamic-point-cloud |
| 1 | unsupported: terrain provider ArcGISTiledElevationTerrainProvider | arcgis-tiled-elevation-terrain |
| 1 | unsupported: terrain provider CustomHeightmapTerrainProvider | procedural-terrain |
| 1 | unsupported: Viewer option vrButton | cardboard |
| 1 | unsupported: WebMapTileServiceImageryProvider in KVP encoding | web-map-tile-service-picking |

## Examples

| example | level | why |
|---|---|---|
| 3d-models | 2 | picture: colour 91% · edges 95% of the cells match · a patch of 211 cells differs |
| 3d-models-articulations-dev (dev) | 3 |  |
| 3d-models-coloring | 2 | picture: colour 90% · edges 94% of the cells match · a patch of 289 cells differs |
| 3d-models-dev (dev) | 1 | unsupported: model animation multiplier |
| 3d-models-node-explorer-dev (dev) | 2 | picture: colour 96% · edges 99% of the cells match · a patch of 70 cells differs |
| 3d-tiles-1.1-cdb-yemen | 2 | picture: colour 8% · edges 60% of the cells match · a patch of 2657 cells differs |
| 3d-tiles-1.1-photogrammetry | 2 | picture: colour 41% · edges 55% of the cells match · a patch of 1595 cells differs |
| 3d-tiles-1.1-photogrammetry-classification | 2 | picture: colour 55% · edges 75% of the cells match · a patch of 684 cells differs |
| 3d-tiles-1.1-s2-globe | 3 |  |
| 3d-tiles-3d-native-vector | 2 | picture: colour 49% · edges 60% of the cells match · a patch of 577 cells differs |
| 3d-tiles-adjust-height | 3 |  |
| 3d-tiles-batch-table-hierarchy | 3 |  |
| 3d-tiles-bim | 3 |  |
| 3d-tiles-clipping-planes | 1 | unsupported: Cesium3DTileset option clippingPlanes, entity.plane |
| 3d-tiles-compare | 2 | picture: colour 81% · edges 91% of the cells match · a patch of 191 cells differs |
| 3d-tiles-edge-visibility | 2 | picture: colour 93% · edges 95% of the cells match · a patch of 173 cells differs |
| 3d-tiles-feature-picking | 2 | picture: colour 60% · edges 90% of the cells match · a patch of 206 cells differs |
| 3d-tiles-feature-styling | 2 | picture: colour 92% · edges 93% of the cells match · a patch of 21 cells differs |
| 3d-tiles-formats | 3 |  |
| 3d-tiles-gaussian-splats-with-lod | – | harness error: page.screenshot: Timeout 120000ms exceeded. |
| 3d-tiles-gaussian-splatting | 2 | picture: colour 70% · edges 75% of the cells match · a patch of 109 cells differs |
| 3d-tiles-gaussian-splatting-comparison | 2 | picture: colour 42% · edges 58% of the cells match · a patch of 604 cells differs |
| 3d-tiles-inspector | 2 | picture: colour 83% · edges 89% of the cells match · a patch of 33 cells differs |
| 3d-tiles-interactivity | 2 | picture: colour 92% · edges 91% of the cells match · a patch of 27 cells differs |
| 3d-tiles-interior | 3 |  |
| 3d-tiles-nga-gpm-visualization | 1 | entities 10/0 |
| 3d-tiles-performance-testing-dev (dev) | 3 |  |
| 3d-tiles-photogrammetry | 2 | picture: colour 92% · edges 93% of the cells match · a patch of 64 cells differs |
| 3d-tiles-photogrammetry-classification | 2 | picture: colour 87% · edges 89% of the cells match · a patch of 63 cells differs |
| 3d-tiles-picking-dev (dev) | 2 | picture: colour 93% · edges 90% of the cells match · a patch of 131 cells differs |
| 3d-tiles-point-cloud | 2 | picture: colour 60% · edges 70% of the cells match · a patch of 162 cells differs |
| 3d-tiles-point-cloud-classification | 2 | picture: colour 59% · edges 70% of the cells match · a patch of 176 cells differs |
| 3d-tiles-point-cloud-shading | 2 | picture: colour 61% · edges 74% of the cells match · a patch of 795 cells differs |
| 3d-tiles-point-cloud-styling | 2 | picture: colour 98% · edges 99% of the cells match · a patch of 48 cells differs |
| 3d-tiles-property-lod-river | 2 | picture: colour 70% · edges 73% of the cells match · a patch of 33 cells differs |
| 3d-tiles-split-dev (dev) | 3 |  |
| 3d-tiles-terrain-classification | 2 | picture: colour 69% · edges 80% of the cells match · a patch of 938 cells differs |
| 3d-tiles-vertical-exaggeration | 2 | picture: colour 88% · edges 91% of the cells match · a patch of 30 cells differs |
| aec-architectural-design | 2 | picture: colour 32% · edges 65% of the cells match · a patch of 1789 cells differs |
| aec-clipping | 3 |  |
| aec-elements-api-query | 2 | picture: colour 50% · edges 54% of the cells match · a patch of 916 cells differs |
| aec-isolate-by-category | 2 | picture: colour 32% · edges 68% of the cells match · a patch of 1736 cells differs |
| aec-metadata-styling | 2 | picture: colour 39% · edges 75% of the cells match · a patch of 960 cells differs |
| aec-snapping | 2 | picture: colour 74% · edges 80% of the cells match · a patch of 48 cells differs |
| aec-tileset-metadata-filtering | 0 | exception: tileset.metadata.getProperty is not a function |
| aerometrex-san-francisco | 2 | picture: colour 50% · edges 59% of the cells match · a patch of 1475 cells differs |
| ambient-occlusion | 2 | picture: colour 76% · edges 85% of the cells match · a patch of 247 cells differs |
| arcgis-mapserver | 3 |  |
| arcgis-tiled-elevation-terrain | 1 | unsupported: terrain provider ArcGISTiledElevationTerrainProvider |
| arcticdem | 1 | unsupported: terrain provider CesiumTerrainProvider |
| atmosphere | 2 | picture: colour 91% · edges 98% of the cells match · a patch of 163 cells differs |
| azure-2d-tiles | 2 | picture: colour 85% · edges 80% of the cells match · a patch of 33 cells differs |
| bathymetry | 2 | picture: colour 29% · edges 68% of the cells match · a patch of 1719 cells differs |
| billboardclamptoground-dev (dev) | 0 | never finished loading |
| billboards | 3 |  |
| billboards-dev (dev) | 3 |  |
| billboards-instancing-dev (dev) | 2 | picture: colour 83% · edges 89% of the cells match · a patch of 494 cells differs |
| bing-maps-labels-only | 3 |  |
| bloom | 2 | picture: colour 62% · edges 84% of the cells match · a patch of 853 cells differs |
| blue-marble | 3 |  |
| box | 3 |  |
| box-dev (dev) | 3 |  |
| box-outline-dev (dev) | 3 |  |
| callback-position-property | 2 | picture: colour 21% · edges 51% of the cells match · a patch of 2107 cells differs |
| callback-property | 1 | camera (Δ 151 m · Δangle 0.0°) |
| camera | 3 |  |
| camera-controllers | 3 |  |
| camera-tutorial | 3 |  |
| cardboard | 1 | unsupported: Viewer option vrButton |
| cartographic-limit-rectangle | 2 | picture: colour 83% · edges 92% of the cells match · a patch of 441 cells differs |
| cesium-inspector | 3 |  |
| cesium-osm-buildings | 2 | picture: colour 88% · edges 86% of the cells match · a patch of 26 cells differs |
| cesium-widget | 2 | picture: colour 86% · edges 84% of the cells match · a patch of 270 cells differs |
| cesium-world-terrain | 2 | picture: colour 46% · edges 62% of the cells match · a patch of 577 cells differs |
| circle-dev (dev) | 3 |  |
| circle-outline-dev (dev) | 3 |  |
| circles-and-ellipses | 3 |  |
| clamp-entities-to-ground | 2 | picture: colour 77% · edges 32% of the cells match · a patch of 136 cells differs |
| clamp-model-to-ground | 2 | picture: colour 95% · edges 97% of the cells match · a patch of 49 cells differs |
| clamp-to-3d-model | 2 | picture: colour 78% · edges 86% of the cells match · a patch of 224 cells differs |
| classification | 2 | picture: colour 40% · edges 44% of the cells match · a patch of 1338 cells differs |
| classification-types | 2 | picture: colour 86% · edges 94% of the cells match · a patch of 336 cells differs |
| client-side-snapping-dev (dev) | 2 | picture: colour 93% · edges 95% of the cells match · a patch of 173 cells differs |
| clipping-performance-dev (dev) | 2 | picture: colour 83% · edges 82% of the cells match · a patch of 492 cells differs |
| clipping-regions | 1 | camera (Δ 1043 m · Δangle 0.0°) |
| clock | 3 |  |
| cloud-parameters | 1 | unsupported: scene.primitives.add(CloudCollection) |
| clouds | 1 | unsupported: scene.primitives.add(CloudCollection) |
| clustering | 2 | picture: colour 70% · edges 70% of the cells match · a patch of 704 cells differs |
| constant-lod-dev (dev) | 1 | camera (Δ 14814 m · Δangle 100.9°) |
| coplanar-polygon-dev (dev) | 3 |  |
| coplanar-polygon-outline-dev (dev) | 3 |  |
| corridor | 3 |  |
| corridor-dev (dev) | 3 |  |
| corridor-outline-dev (dev) | 3 |  |
| custom-datasource | 2 | picture: colour 97% · edges 96% of the cells match · a patch of 27 cells differs |
| custom-geocoder | 3 |  |
| custom-per-feature-post-process | 2 | picture: colour 94% · edges 95% of the cells match · a patch of 85 cells differs |
| custom-post-process | 2 | picture: colour 93% · edges 96% of the cells match · a patch of 85 cells differs |
| custom-primitive-dev (dev) | – | never finished loading |
| custom-shaders-3d-tiles | 1 | unsupported: Cesium3DTileset option customShader |
| custom-shaders-models | 2 | picture: colour 79% · edges 97% of the cells match · a patch of 513 cells differs |
| custom-shaders-property-textures | 2 | picture: colour 66% · edges 80% of the cells match · a patch of 191 cells differs |
| cylinder-dev (dev) | 3 |  |
| cylinder-outline-dev (dev) | 3 |  |
| cylinders-and-cones | 2 | picture: colour 94% · edges 99% of the cells match · a patch of 59 cells differs |
| czml | 3 |  |
| czml-3d-tiles | 3 |  |
| czml-billboard-and-label | 3 |  |
| czml-box | 3 |  |
| czml-circles-and-ellipses | 3 |  |
| czml-colors | 3 |  |
| czml-cones-and-cylinders | 2 | picture: colour 94% · edges 98% of the cells match · a patch of 59 cells differs |
| czml-corridor | 3 |  |
| czml-custom-properties | 1 | camera (Δ 27636 m · Δangle 0.0°) |
| czml-model | 2 | picture: colour 79% · edges 78% of the cells match · a patch of 124 cells differs |
| czml-model-articulations | 2 | picture: colour 81% · edges 78% of the cells match · a patch of 36 cells differs |
| czml-model-data-url | 2 | picture: colour 84% · edges 82% of the cells match · a patch of 227 cells differs |
| czml-model-node-transformations | 3 |  |
| czml-path | 2 | picture: colour 65% · edges 35% of the cells match · a patch of 114 cells differs |
| czml-point | 3 |  |
| czml-point-time-dynamic | 3 |  |
| czml-polygon | 2 | picture: colour 98% · edges 99% of the cells match · a patch of 23 cells differs |
| czml-polygon-interpolating-references | 2 | picture: colour 95% · edges 99% of the cells match · a patch of 51 cells differs |
| czml-polygon-intervals-availability | 3 |  |
| czml-polyline | 3 |  |
| czml-polyline-volume | 2 | picture: colour 94% · edges 99% of the cells match · a patch of 29 cells differs |
| czml-position-definitions | 3 |  |
| czml-rectangle | 2 | picture: colour 98% · edges 99% of the cells match · a patch of 24 cells differs |
| czml-reference-properties | 3 |  |
| czml-spheres-and-ellipsoids | 3 |  |
| czml-wall | 3 |  |
| czml-zindex | 2 | picture: colour 92% · edges 96% of the cells match · a patch of 208 cells differs |
| datasource-ordering | 3 |  |
| depth-of-field | 2 | picture: colour 77% · edges 60% of the cells match · a patch of 346 cells differs |
| display-conditions-dev (dev) | 3 |  |
| distance-display-conditions | 3 |  |
| drape-imagery-on-3d-tiles | 1 | unsupported: scene.primitives.add(Cesium3DTileset) |
| drawing-on-terrain | 2 | picture: colour 86% · edges 85% of the cells match · a patch of 23 cells differs |
| earth-at-night | 3 |  |
| edge-visibility-dev (dev) | 3 |  |
| elevation-band-material | 0 | never finished loading |
| ellipse-dev (dev) | 3 |  |
| ellipse-outline-dev (dev) | 3 |  |
| ellipsoid-dev (dev) | 3 |  |
| ellipsoid-outline-dev (dev) | 3 |  |
| ellipsoid-surface-dev (dev) | 1 | unsupported: material Dot (drawn in its colour) |
| entity-tracking | 3 |  |
| export-kml | 3 |  |
| fog | 2 | picture: colour 64% · edges 85% of the cells match · a patch of 532 cells differs |
| fog-post-process | 2 | picture: colour 36% · edges 86% of the cells match · a patch of 1553 cells differs |
| frustum-dev (dev) | 3 |  |
| fxaa | 2 | picture: colour 75% · edges 84% of the cells match · a patch of 297 cells differs |
| geojson-and-topojson | 3 |  |
| geojson-simplestyle | – | starts in 2D / Columbus view: not graded (the globe is 3D only) |
| geometry-and-appearances | 2 | picture: colour 93% · edges 94% of the cells match · a patch of 24 cells differs |
| geometry-and-appearances-dev (dev) | 1 | unsupported: material PolylineGlow (drawn in its colour) |
| geometry-height-reference | 2 | picture: colour 78% · edges 67% of the cells match · a patch of 178 cells differs |
| geometry-offset-attribute-box-cylinder-ellipsoid-dev (dev) | 3 |  |
| geometry-offset-attribute-dev (dev) | 3 |  |
| globe-interior | 2 | picture: colour 70% · edges 82% of the cells match · a patch of 841 cells differs |
| globe-materials | 2 | picture: colour 21% · edges 46% of the cells match · a patch of 2181 cells differs |
| globe-materials-3d-tiles-terrain | 2 | picture: colour 94% · edges 95% of the cells match · a patch of 49 cells differs |
| globe-materials-water-mask-elevation-map | 2 | picture: colour 95% · edges 95% of the cells match · a patch of 30 cells differs |
| globe-translucency | 2 | picture: colour 83% · edges 95% of the cells match |
| gltf-pbr-extensions | 2 | picture: colour 72% · edges 80% of the cells match · a patch of 505 cells differs |
| gltf-planar-fill-dev (dev) | 3 |  |
| google-2d-tiles | 2 | picture: colour 91% · edges 72% of the cells match · a patch of 29 cells differs |
| google-2d-tiles-with-custom-styles | 3 |  |
| google-earth-enterprise | 3 |  |
| google-photorealistic-3d-tiles | 2 | picture: colour 93% · edges 88% of the cells match · a patch of 94 cells differs |
| google-photorealistic-3d-tiles-with-building-insert | 2 | picture: colour 53% · edges 56% of the cells match · a patch of 1189 cells differs |
| google-streetview-panorama | 2 | picture: colour 22% · edges 92% of the cells match · a patch of 2171 cells differs |
| gpx | 2 | picture: colour 93% · edges 95% of the cells match · a patch of 33 cells differs |
| ground-polyline-material-dev (dev) | 0 | never finished loading |
| ground-primitive-dev (dev) | 2 | picture: colour 65% · edges 88% of the cells match · a patch of 501 cells differs |
| ground-primitive-materials-dev (dev) | 2 | picture: colour 87% · edges 93% of the cells match · a patch of 51 cells differs |
| headingpitchroll | 1 | unsupported: model animation multiplier |
| hello-world | 3 |  |
| high-dynamic-range | 0 | never finished loading |
| html-overlays | 3 |  |
| hybrid-snapping-dev (dev) | 2 | picture: colour 75% · edges 79% of the cells match · a patch of 47 cells differs |
| i3s-3d-object-layer | 1 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) |
| i3s-building-scene-layer | 1 | unsupported: I3SDataProvider.filterByAttributes |
| i3s-feature-picking | 1 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) |
| i3s-integratedmesh-layer | 1 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) |
| image-based-lighting | 2 | picture: colour 90% · edges 91% of the cells match · a patch of 148 cells differs |
| imagery-adjustment | 3 |  |
| imagery-assets-available-from-ion | 2 | picture: colour 99% · edges 99% of the cells match · a patch of 32 cells differs |
| imagery-color-to-alpha | 3 |  |
| imagery-cutout | 3 |  |
| imagery-layers | 3 |  |
| imagery-layers-manipulation | 3 |  |
| imagery-layers-split | 2 | picture: colour 82% · edges 92% of the cells match · a patch of 375 cells differs |
| imagery-layers-texture-filters | 3 |  |
| imodel-mesh-export-service | 1 | unsupported: scene.primitives.add(Cesium3DTileset) |
| interpolation | 2 | picture: colour 69% · edges 83% of the cells match · a patch of 57 cells differs |
| ion-snapping-dev (dev) | 2 | picture: colour 74% · edges 81% of the cells match · a patch of 47 cells differs |
| itwin-feature-service | – | never finished loading |
| itwin-gaussian-splats | 1 | unsupported: scene.primitives.add(Cesium3DTileset) |
| japan-buildings | 2 | picture: colour 49% · edges 71% of the cells match · a patch of 473 cells differs |
| khr-mesh-primitive-restart-dev (dev) | 1 | camera (Δ 17210790 m · Δangle 44.9°) |
| kml | 2 | picture: colour 66% · edges 68% of the cells match · a patch of 774 cells differs |
| kml-tours | 3 |  |
| labels | 2 | picture: colour 98% · edges 99% of the cells match · a patch of 27 cells differs |
| labels-dev (dev) | 3 |  |
| lensflare | 2 | picture: colour 54% · edges 95% of the cells match · a patch of 1260 cells differs |
| lighting | 2 | picture: colour 60% · edges 83% of the cells match · a patch of 899 cells differs |
| localtofixedframe | 1 | unsupported: scene.primitives.add(DebugModelMatrixPrimitive) |
| manually-controlled-animation | 1 | unsupported: model animation multiplier |
| many-clipping-planes-dev (dev) | 2 | picture: colour 92% · edges 95% of the cells match · a patch of 76 cells differs |
| map-pins | 2 | picture: colour 82% · edges 90% of the cells match |
| mars | – | another body than the Earth: not graded (separate work) |
| material-dev (dev) | 3 |  |
| material-with-custom-glsl | 1 | unsupported: material CustomBoxShader (drawn white) |
| materials | 3 |  |
| montreal-point-cloud | 2 | picture: colour 79% · edges 78% of the cells match · a patch of 508 cells differs |
| moon | – | another body than the Earth: not graded (separate work) |
| msaa | 2 | picture: colour 65% · edges 77% of the cells match · a patch of 523 cells differs |
| multi-part-czml | 3 |  |
| multifrustum-snapping-dev (dev) | – | never finished loading |
| multiple-shadows-dev (dev) | – | never finished loading |
| multiple-synced-views | – | starts in 2D / Columbus view: not graded (the globe is 3D only) |
| natural-earth-ii | 3 |  |
| offline | 3 |  |
| pamap-terrain | 1 | unsupported: terrain provider CesiumTerrainProvider |
| panorama | 1 | unsupported: scene.primitives.add(EquirectangularPanorama) |
| parallels-and-meridians | 3 |  |
| partial-ellipsoids | 3 |  |
| particle-system | 1 | unsupported: scene.primitives.add(ParticleSystem) |
| particle-system-fireworks | 1 | unsupported: scene.primitives.add(ParticleSystem) |
| particle-system-tails | 1 | unsupported: scene.primitives.add(ParticleSystem) |
| particle-system-weather | 1 | unsupported: scene.primitives.add(ParticleSystem) |
| pbr-lighting-dev (dev) | 2 | picture: colour 80% · edges 87% of the cells match · a patch of 27 cells differs |
| per-feature-post-processing | 2 | picture: colour 37% · edges 93% of the cells match · a patch of 190 cells differs |
| per-instance-color-dev (dev) | 2 | picture: colour 98% · edges 100% of the cells match · a patch of 34 cells differs |
| physically-based-materials | 2 | picture: colour 72% · edges 63% of the cells match · a patch of 170 cells differs |
| pick-from-ray-dev (dev) | 1 | unsupported: scene.pickFromRay; entities 4/3 |
| picking | 3 |  |
| picking-dev (dev) | 3 |  |
| plane | 1 | unsupported: entity.plane |
| pointprimitives-dev (dev) | 3 |  |
| points | 3 |  |
| polygon | 3 |  |
| polygon-dev (dev) | 3 |  |
| polygon-outline-dev (dev) | 3 |  |
| polygon-texture-coordinates-dev (dev) | 3 |  |
| polyline | 3 |  |
| polyline-color-dev (dev) | 3 |  |
| polyline-dash | 3 |  |
| polyline-dev (dev) | 3 |  |
| polyline-material-dev (dev) | 1 | unsupported: material PolylineGlow (drawn in its colour), material PolylineArrow (drawn in its colour), material PolylineOutline (drawn in its colour) |
| polyline-volume | 3 |  |
| polyline-volume-dev (dev) | 3 |  |
| polyline-volume-outline-dev (dev) | 3 |  |
| polylines-dev (dev) | 1 | unsupported: polyline material Fade (drawn in its colour), polyline material PolylineArrow (drawn in its colour) |
| polylines-on-3d-tiles | 2 | picture: colour 66% · edges 79% of the cells match · a patch of 113 cells differs |
| polylines-on-terrain-dev (dev) | 0 | never finished loading |
| post-processing | 2 | picture: colour 93% · edges 93% of the cells match · a patch of 75 cells differs |
| procedural-terrain | 1 | unsupported: terrain provider CustomHeightmapTerrainProvider |
| projection | 1 | unsupported: orthographic frustum (ProjectionPicker) |
| rectangle | 2 | picture: colour 97% · edges 97% of the cells match · a patch of 89 cells differs |
| rectangle-dev (dev) | 3 |  |
| rectangle-outline-dev (dev) | 3 |  |
| relative-paths | 3 |  |
| resolution-scaling | 3 |  |
| rotatable-2d-map | – | starts in 2D / Columbus view: not graded (the globe is 3D only) |
| sample-height-from-3d-tiles | 2 | picture: colour 42% · edges 50% of the cells match · a patch of 534 cells differs |
| scene-rendering-performance | 1 | render error: julianDate is required. |
| sentinel-2 | 3 |  |
| shadows | 2 | picture: colour 89% · edges 92% of the cells match · a patch of 196 cells differs |
| shadows-dev (dev) | 0 | exception: DeveloperError |
| shared-context | 3 |  |
| show-or-hide-entities | 3 |  |
| simple-polyline-dev (dev) | 3 |  |
| sphere-dev (dev) | 3 |  |
| sphere-outline-dev (dev) | 3 |  |
| spheres-and-ellipsoids | 3 |  |
| splitdirection | 3 |  |
| star-burst | 3 |  |
| styled-gltf-lines-dev (dev) | 3 |  |
| styled-gltf-points-dev (dev) | 3 |  |
| terrain | 2 | picture: colour 30% · edges 72% of the cells match · a patch of 1383 cells differs |
| terrain-clipping-planes | 2 | picture: colour 84% · edges 80% of the cells match · a patch of 111 cells differs |
| terrain-entity-batching-dev (dev) | 2 | picture: colour 91% · edges 91% of the cells match · a patch of 233 cells differs |
| terrain-exaggeration | 0 | never finished loading |
| terrain-performance-dev (dev) | 3 |  |
| terrain-tweaks-dev (dev) | 3 |  |
| time-dependent-path-graphics | 3 |  |
| time-dynamic-point-cloud | 1 | unsupported: scene.primitives.add(TimeDynamicPointCloud); camera (Δ 17209685 m · Δangle 61.2°) |
| time-dynamic-wheels | 2 | picture: colour 86% · edges 86% of the cells match · a patch of 181 cells differs |
| timeline | – | no viewer |
| underground-color | 2 | picture: colour 25% · edges 52% of the cells match · a patch of 1853 cells differs |
| vector-3d-tiles | 3 |  |
| video | 2 | picture: colour 50% · edges 93% of the cells match · a patch of 1386 cells differs |
| viewerless | – | no viewer |
| volumecloud | 0 | never finished loading |
| volumes-dev (dev) | 1 | unsupported: scene.primitives.add(EllipsoidPrimitive) |
| voxel-picking | 2 | picture: colour 95% · edges 96% of the cells match · a patch of 22 cells differs |
| voxels | 2 | picture: colour 80% · edges 96% of the cells match · a patch of 116 cells differs |
| voxels-in-3d-tiles | 2 | picture: colour 57% · edges 98% of the cells match · a patch of 1246 cells differs |
| wall | 3 |  |
| wall-dev (dev) | 3 |  |
| wall-outline-dev (dev) | 3 |  |
| washington-dc-2017 | 3 |  |
| web-map-service-wms | 3 |  |
| web-map-tile-service-picking | 1 | unsupported: WebMapTileServiceImageryProvider in KVP encoding |
| web-map-tile-service-with-time | 2 | picture: colour 82% · edges 89% of the cells match · a patch of 295 cells differs |
| z-indexing-geometry | 2 | picture: colour 91% · edges 96% of the cells match · a patch of 228 cells differs |
