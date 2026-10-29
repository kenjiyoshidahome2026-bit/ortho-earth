# Cesium examples gate (CesiumJS 1.146.0) — 2026-10-29T18:54:33.632Z

15 examples · not graded (real Cesium does not run it here, it starts in 2D, or it is the Moon / Mars): 0 · ours does not run: 0 · runs: 4 · same answers: 8 · same picture: 3

## Blockers

| n | blocker | examples |
|---|---|---|
| 8 | picture differs | 3d-tiles-feature-picking, 3d-tiles-gaussian-splatting-comparison, cesium-osm-buildings, clamp-entities-to-ground, classification-types, drawing-on-terrain … |
| 2 | drawn camera differs | czml-polyline, polyline |
| 1 | camera differs | 3d-tiles-1.1-photogrammetry |
| 1 | unsupported: material PolylineDash (drawn in its colour) | ground-polyline-material-dev |
| 1 | unsupported: material PolylineGlow (drawn in its colour) | ground-polyline-material-dev |
| 1 | unsupported: material PolylineOutline (drawn in its colour) | ground-polyline-material-dev |

## Examples

| example | level | why |
|---|---|---|
| 3d-tiles-1.1-photogrammetry | 1 | camera (Δ 316 m · Δangle 0.0°) |
| 3d-tiles-compare | 3 |  |
| 3d-tiles-feature-picking | 2 | picture: colour 85% · edges 87% of the cells match · a patch of 40 cells differs |
| 3d-tiles-gaussian-splatting-comparison | 2 | picture: colour 89% · edges 83% of the cells match · a patch of 65 cells differs |
| cesium-osm-buildings | 2 | picture: colour 79% · edges 91% of the cells match · a patch of 335 cells differs |
| clamp-entities-to-ground | 2 | picture: colour 81% · edges 88% of the cells match · a patch of 127 cells differs |
| classification-types | 2 | picture: colour 93% · edges 97% of the cells match · a patch of 172 cells differs |
| czml-polyline | 1 | drawn camera (Δangle 21.9° from the Cesium pose) |
| drawing-on-terrain | 2 | picture: colour 86% · edges 85% of the cells match · a patch of 22 cells differs |
| ground-polyline-material-dev (dev) | 1 | unsupported: material PolylineGlow (drawn in its colour), material PolylineDash (drawn in its colour), material PolylineOutline (drawn in its colour) |
| high-dynamic-range | 2 | picture: colour 70% · edges 67% of the cells match · a patch of 228 cells differs |
| montreal-point-cloud | 3 |  |
| polyline | 1 | drawn camera (Δangle 21.9° from the Cesium pose) |
| polylines-on-terrain-dev (dev) | 3 |  |
| terrain | 2 | picture: colour 93% · edges 95% of the cells match · a patch of 136 cells differs |
