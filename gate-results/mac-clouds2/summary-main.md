# Cesium examples gate (CesiumJS 1.146.0) — 2026-10-28T21:47:34.789Z

5 examples · not graded (real Cesium does not run it here, it starts in 2D, or it is the Moon / Mars): 0 · ours does not run: 0 · runs: 2 · same answers: 3 · same picture: 0

## Blockers

| n | blocker | examples |
|---|---|---|
| 3 | picture differs | 3d-tiles-compare, 3d-tiles-feature-styling, cesium-osm-buildings |
| 2 | unsupported: scene.primitives.add(CloudCollection) | cloud-parameters, clouds |
| 1 | 3D Tiles draw nothing | clouds |

## Examples

| example | level | why |
|---|---|---|
| 3d-tiles-compare | 2 | picture: colour 79% · edges 91% of the cells match · a patch of 452 cells differs |
| 3d-tiles-feature-styling | 2 | picture: colour 83% · edges 88% of the cells match · a patch of 77 cells differs |
| cesium-osm-buildings | 2 | picture: colour 80% · edges 93% of the cells match · a patch of 161 cells differs |
| cloud-parameters | 1 | unsupported: scene.primitives.add(CloudCollection) |
| clouds | 1 | unsupported: scene.primitives.add(CloudCollection); 3D Tiles drawn 21/0 |
