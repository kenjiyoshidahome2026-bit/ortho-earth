# Cesium examples gate (CesiumJS 1.146.0) — 2026-10-29T02:24:22.935Z

16 examples · not graded (real Cesium does not run it here, it starts in 2D, or it is the Moon / Mars): 0 · ours does not run: 0 · runs: 7 · same answers: 6 · same picture: 3

## Blockers

| n | blocker | examples |
|---|---|---|
| 6 | picture differs | 3d-models, 3d-tiles-point-cloud-styling, labels, localtofixedframe, many-clipping-planes-dev, terrain-clipping-planes |
| 3 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) | i3s-3d-object-layer, i3s-feature-picking, i3s-integratedmesh-layer |
| 1 | 3D Tiles draw nothing | 3d-tiles-point-cloud |
| 1 | drawn camera differs | plane |
| 1 | unsupported: I3SDataProvider.filterByAttributes | i3s-building-scene-layer |
| 1 | unsupported: material RimLighting (drawn in its colour) | volumes-dev |

## Examples

| example | level | why |
|---|---|---|
| 3d-models | 2 | picture: colour 92% · edges 94% of the cells match · a patch of 155 cells differs |
| 3d-tiles-clipping-planes | 3 |  |
| 3d-tiles-point-cloud | 1 | 3D Tiles drawn 1/0 |
| 3d-tiles-point-cloud-styling | 2 | picture: colour 98% · edges 99% of the cells match · a patch of 48 cells differs |
| i3s-3d-object-layer | 1 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) |
| i3s-building-scene-layer | 1 | unsupported: I3SDataProvider.filterByAttributes |
| i3s-feature-picking | 1 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) |
| i3s-integratedmesh-layer | 1 | unsupported: I3SDataProvider geoidTiledTerrainProvider (the globe places I3S heights itself) |
| labels | 2 | picture: colour 98% · edges 99% of the cells match · a patch of 27 cells differs |
| localtofixedframe | 2 | picture: colour 92% · edges 88% of the cells match · a patch of 65 cells differs |
| many-clipping-planes-dev (dev) | 2 | picture: colour 92% · edges 95% of the cells match · a patch of 64 cells differs |
| panorama | 3 |  |
| plane | 1 | drawn camera (Δangle 15.2° from the Cesium pose) |
| terrain-clipping-planes | 2 | picture: colour 92% · edges 84% of the cells match · a patch of 134 cells differs |
| time-dynamic-point-cloud | 3 |  |
| volumes-dev (dev) | 1 | unsupported: material RimLighting (drawn in its colour) |
