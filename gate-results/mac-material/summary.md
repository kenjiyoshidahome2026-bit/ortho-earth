# Cesium examples gate (CesiumJS 1.146.0) — 2026-10-28T04:17:05.830Z

6 examples · not graded (real Cesium does not run it here, it starts in 2D, or it is the Moon / Mars): 0 · ours does not run: 0 · runs: 2 · same answers: 3 · same picture: 1

## Blockers

| n | blocker | examples |
|---|---|---|
| 3 | picture differs | bathymetry, elevation-band-material, globe-materials |
| 2 | drawn camera differs | globe-materials-3d-tiles-terrain, globe-materials-water-mask-elevation-map |

## Examples

| example | level | why |
|---|---|---|
| 3d-tiles-1.1-cdb-yemen | 3 |  |
| bathymetry | 2 | picture: colour 40% · edges 65% of the cells match · a patch of 1575 cells differs |
| elevation-band-material | 2 | picture: colour 90% · edges 91% of the cells match · a patch of 55 cells differs |
| globe-materials | 2 | picture: colour 86% · edges 100% of the cells match · a patch of 95 cells differs |
| globe-materials-3d-tiles-terrain | 1 | drawn camera (Δangle 180.0° from the Cesium pose) |
| globe-materials-water-mask-elevation-map | 1 | drawn camera (Δangle 180.0° from the Cesium pose) |
