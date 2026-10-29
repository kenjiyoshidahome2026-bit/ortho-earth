# Cesium examples gate (CesiumJS 1.146.0) — 2026-10-29T18:29:25.582Z

39 examples · not graded (real Cesium does not run it here, it starts in 2D, or it is the Moon / Mars): 0 · ours does not run: 0 · runs: 4 · same answers: 20 · same picture: 15

## Blockers

| n | blocker | examples |
|---|---|---|
| 20 | picture differs | 3d-tiles-1.1-cdb-yemen, 3d-tiles-1.1-photogrammetry-classification, 3d-tiles-compare, 3d-tiles-edge-visibility, 3d-tiles-feature-picking, 3d-tiles-gaussian-splats-with-lod … |
| 3 | 3D Tiles draw nothing | 3d-tiles-terrain-classification, czml-3d-tiles, drape-imagery-on-3d-tiles |
| 1 | camera differs | 3d-tiles-1.1-photogrammetry |
| 1 | unsupported: scene.primitives.add(Cesium3DTileset) | drape-imagery-on-3d-tiles |

## Examples

| example | level | why |
|---|---|---|
| 3d-tiles-1.1-cdb-yemen | 2 | picture: colour 83% · edges 74% of the cells match · a patch of 70 cells differs |
| 3d-tiles-1.1-photogrammetry | 1 | camera (Δ 318 m · Δangle 0.0°) |
| 3d-tiles-1.1-photogrammetry-classification | 2 | picture: colour 61% · edges 75% of the cells match · a patch of 403 cells differs |
| 3d-tiles-1.1-s2-globe | 3 |  |
| 3d-tiles-adjust-height | 3 |  |
| 3d-tiles-batch-table-hierarchy | 3 |  |
| 3d-tiles-bim | 3 |  |
| 3d-tiles-clipping-planes | 3 |  |
| 3d-tiles-compare | 2 | picture: colour 77% · edges 92% of the cells match · a patch of 491 cells differs |
| 3d-tiles-edge-visibility | 2 | picture: colour 93% · edges 96% of the cells match · a patch of 190 cells differs |
| 3d-tiles-feature-picking | 2 | picture: colour 85% · edges 87% of the cells match · a patch of 40 cells differs |
| 3d-tiles-feature-styling | 3 |  |
| 3d-tiles-formats | 3 |  |
| 3d-tiles-gaussian-splats-with-lod | 2 | picture: colour 52% · edges 54% of the cells match · a patch of 230 cells differs |
| 3d-tiles-gaussian-splatting | 2 | picture: colour 75% · edges 78% of the cells match · a patch of 70 cells differs |
| 3d-tiles-interactivity | 3 |  |
| 3d-tiles-interior | 3 |  |
| 3d-tiles-photogrammetry | 3 |  |
| 3d-tiles-photogrammetry-classification | 2 | picture: colour 94% · edges 93% of the cells match · a patch of 61 cells differs |
| 3d-tiles-point-cloud | 2 | picture: colour 94% · edges 95% of the cells match · a patch of 39 cells differs |
| 3d-tiles-point-cloud-classification | 2 | picture: colour 93% · edges 95% of the cells match · a patch of 39 cells differs |
| 3d-tiles-point-cloud-shading | 2 | picture: colour 89% · edges 95% of the cells match · a patch of 240 cells differs |
| 3d-tiles-point-cloud-styling | 3 |  |
| 3d-tiles-property-lod-river | 2 | picture: colour 77% · edges 70% of the cells match |
| 3d-tiles-terrain-classification | 1 | 3D Tiles drawn 4/0 |
| 3d-tiles-vertical-exaggeration | 2 | picture: colour 88% · edges 91% of the cells match · a patch of 30 cells differs |
| aec-tileset-metadata-filtering | 3 |  |
| cesium-osm-buildings | 2 | picture: colour 77% · edges 91% of the cells match · a patch of 335 cells differs |
| custom-shaders-3d-tiles | 3 |  |
| czml-3d-tiles | 1 | 3D Tiles drawn 1/0 |
| drape-imagery-on-3d-tiles | 1 | unsupported: scene.primitives.add(Cesium3DTileset); 3D Tiles drawn 11/0 |
| globe-materials-3d-tiles-terrain | 3 |  |
| google-photorealistic-3d-tiles | 2 | picture: colour 95% · edges 97% of the cells match · a patch of 89 cells differs |
| google-photorealistic-3d-tiles-with-building-insert | 2 | picture: colour 99% · edges 98% of the cells match · a patch of 24 cells differs |
| japan-buildings | 2 | picture: colour 54% · edges 78% of the cells match · a patch of 796 cells differs |
| montreal-point-cloud | 3 |  |
| polylines-on-3d-tiles | 2 | picture: colour 71% · edges 86% of the cells match · a patch of 200 cells differs |
| sample-height-from-3d-tiles | 2 | picture: colour 42% · edges 50% of the cells match · a patch of 534 cells differs |
| voxels-in-3d-tiles | 2 | picture: colour 57% · edges 98% of the cells match · a patch of 1246 cells differs |
