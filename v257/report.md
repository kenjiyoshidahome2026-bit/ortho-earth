# Cesium 門 v257（claude/project-thread-mir9bm eb8dff14f・--only 21 例）

条件：v250 と同じ（--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2・ref は v242）。比較の元＝v250。pair＝左 Cesium・右 ortho（1920×720）。

## 段か colour が 2 ポイント以上変わった例

| 例 | v250 | v257 | v250 colour / edges / blob | v257 colour / edges / blob |
|---|---|---|---|---|
| classification | 2 | **2** | 92.3 / 93.4 / 37 | 88.8 / 85.5 / 70 |
| classification-types | 2 | **3** | 95.5 / 93.7 / 77 | 99.7 / 93.7 / 1 |
| drawing-on-terrain | 2 | **2** | 83.5 / 84.5 / 23 | 86.3 / 89.3 / 29 |
| geometry-height-reference | 2 | **3** | 99.4 / 37.0 / 2 | 99.3 / 91.7 / 4 |
| gpx | 3 | **3** | 97.1 / 94.1 / 11 | 97.1 / 94.1 / 11 |
| ground-primitive-dev | 2 | **2** | 69.2 / 83.7 / 301 | 82.1 / 86.9 / 95 |
| physically-based-materials | 2 | **2** | 87.3 / 37.2 / 36 | 85.5 / 65.9 / 40 |
| terrain-entity-batching-dev | 3 | **3** | 98.4 / 92.1 / 5 | 98.4 / 90.1 / 5 |

## 撮った全例

| 例 | v250 | v257 | v250 | v257 |
|---|---|---|---|---|
| 3d-tiles-photogrammetry-classification | 2 | 2 | 93.9 / 96.5 / 34 | 93.9 / 96.4 / 34 |
| 3d-tiles-point-cloud-classification | 2 | 2 | 90.9 / 91.3 / 38 | 91.5 / 92.8 / 38 |
| billboardclamptoground-dev | 3 | 3 | 99.0 / 99.7 / 2 | 99.0 / 99.7 / 2 |
| clamp-entities-to-ground | 2 | 2 | 76.5 / 86.6 / 128 | 77.0 / 87.0 / 128 |
| classification | 2 | 2 | 92.3 / 93.4 / 37 | 88.8 / 85.5 / 70 |
| classification-types | 2 | 3 | 95.5 / 93.7 / 77 | 99.7 / 93.7 / 1 |
| drawing-on-terrain | 2 | 2 | 83.5 / 84.5 / 23 | 86.3 / 89.3 / 29 |
| geometry-height-reference | 2 | 3 | 99.4 / 37.0 / 2 | 99.3 / 91.7 / 4 |
| globe-translucency | 3 | 3 | 88.5 / 96.6 / 6 | 88.1 / 96.9 / 6 |
| gpx | 3 | 3 | 97.1 / 94.1 / 11 | 97.1 / 94.1 / 11 |
| ground-primitive-dev | 2 | 2 | 69.2 / 83.7 / 301 | 82.1 / 86.9 / 95 |
| ground-primitive-materials-dev | 2 | 2 | 90.6 / 93.3 / 58 | 88.8 / 93.8 / 21 |
| physically-based-materials | 2 | 2 | 87.3 / 37.2 / 36 | 85.5 / 65.9 / 40 |
| picking-dev | 3 | 3 | 99.0 / 99.8 / 2 | 99.0 / 99.8 / 2 |
| polygon-texture-coordinates-dev | 3 | 3 | 99.0 / 99.7 / 2 | 99.0 / 99.7 / 2 |
| polyline | 3 | 3 | 99.4 / 99.5 / 3 | 99.4 / 99.5 / 3 |
| polylines-on-terrain-dev | 3 | 3 | 95.8 / 98.1 / 3 | 96.9 / 98.2 / 3 |
| shadows | 2 | 2 | 73.0 / 96.6 / 309 | 73.2 / 96.3 / 309 |
| terrain-entity-batching-dev | 3 | 3 | 98.4 / 92.1 / 5 | 98.4 / 90.1 / 5 |
| terrain-exaggeration | 2 | 2 | 79.7 / 89.6 / 55 | 79.5 / 88.3 / 53 |
| z-indexing-geometry | 3 | 3 | 97.2 / 98.6 / 9 | 97.2 / 98.7 / 9 |

## Notes

- Commit eb8dff14f (on f8731a3): the ground atlas bakes gint faces (GeoJSON fills: the Cesium facade's ground polygons and clamped entity polygons) after the "over" rasters, in both WebGPU and GL2. Before, the Cesium imagery ("over") covered them once the terrain turned on (tilt ≥ ~25°), so they showed only top-down.
- Re-shot alone (v257b, copied over v257 and regraded): ground-primitive-dev (the first shot had another camera, a race in the example's lookAt), 3d-tiles-photogrammetry-classification (back to v254), 3d-tiles-point-cloud-classification (blank imagery the first time), classification.
- classification 92.3 → 88.8 is f8731a3's: shot on f8731a3 without eb8dff14f (v257c) it gives 89.5.
