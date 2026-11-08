# Cesium 門 v253（claude/project-thread-mir9bm e089eb4・--only 29 例）

条件：v250 と同じ（--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2・ref は v242）。比較の元＝v250。pair＝左 Cesium・右 ortho（1920×720）。

## 段か colour が 2 ポイント以上変わった例

| 例 | v250 | v253 | v250 colour / edges / blob | v253 colour / edges / blob |
|---|---|---|---|---|
| 3d-tiles-nga-gpm-visualization | 2 | **2** | 90.8 / 95.3 / 74 | 93.8 / 96.8 / 29 |
| cartographic-limit-rectangle | 2 | **2** | 91.8 / 93.2 / 32 | 94.9 / 93.9 / 32 |
| geometry-and-appearances | 2 | **3** | 93.9 / 96.4 / 23 | 98.6 / 96.9 / 6 |

## 撮った全例

| 例 | v250 | v253 | v250 | v253 |
|---|---|---|---|---|
| 3d-tiles-clipping-planes | 2 | 2 | 97.8 / 92.5 / 30 | 97.8 / 95.8 / 30 |
| 3d-tiles-nga-gpm-visualization | 2 | 2 | 90.8 / 95.3 / 74 | 93.8 / 96.8 / 29 |
| box | 3 | 3 | 98.0 / 98.4 / 5 | 98.0 / 99.3 / 5 |
| camera | 3 | 3 | 99.0 / 99.8 / 2 | 99.0 / 99.8 / 2 |
| cartographic-limit-rectangle | 2 | 2 | 91.8 / 93.2 / 32 | 94.9 / 93.9 / 32 |
| circles-and-ellipses | 3 | 3 | 98.2 / 98.7 / 6 | 98.2 / 99.6 / 6 |
| corridor | 3 | 3 | 98.2 / 98.9 / 4 | 98.2 / 99.3 / 4 |
| cylinders-and-cones | 3 | 3 | 97.9 / 96.8 / 8 | 97.9 / 97.5 / 8 |
| czml-box | 3 | 3 | 98.0 / 98.5 / 5 | 98.0 / 99.3 / 5 |
| czml-circles-and-ellipses | 3 | 3 | 97.9 / 98.7 / 6 | 97.9 / 99.6 / 6 |
| czml-colors | 3 | 3 | 98.5 / 97.8 / 0 | 98.5 / 99.2 / 0 |
| czml-cones-and-cylinders | 3 | 3 | 97.7 / 95.9 / 8 | 97.7 / 96.5 / 8 |
| czml-corridor | 3 | 3 | 98.1 / 99.2 / 4 | 98.1 / 99.6 / 4 |
| czml-polygon | 3 | 3 | 98.8 / 98.4 / 3 | 98.8 / 98.4 / 3 |
| czml-polyline-volume | 3 | 3 | 98.0 / 98.8 / 14 | 98.0 / 99.0 / 14 |
| czml-rectangle | 3 | 3 | 99.4 / 99.7 / 3 | 99.6 / 96.1 / 2 |
| czml-spheres-and-ellipsoids | 3 | 3 | 97.8 / 98.7 / 4 | 97.8 / 99.5 / 4 |
| distance-display-conditions | 3 | 3 | 99.0 / 99.8 / 2 | 99.0 / 99.8 / 2 |
| geometry-and-appearances | 2 | 3 | 93.9 / 96.4 / 23 | 98.6 / 96.9 / 6 |
| partial-ellipsoids | 3 | 3 | 97.2 / 99.3 / 8 | 97.2 / 98.6 / 8 |
| plane | 3 | 3 | 98.3 / 98.4 / 1 | 98.3 / 99.3 / 1 |
| polygon | 3 | 3 | 98.8 / 98.4 / 2 | 98.8 / 98.4 / 2 |
| polyline-volume | 3 | 3 | 97.9 / 99.3 / 6 | 97.9 / 96.6 / 6 |
| rectangle | 2 | 2 | 95.3 / 95.1 / 85 | 95.5 / 95.4 / 80 |
| shadows | 2 | 2 | 73.0 / 96.6 / 309 | 72.8 / 96.6 / 309 |
| shared-context | 3 | 3 | 97.0 / 96.8 / 12 | 97.0 / 96.3 / 12 |
| spheres-and-ellipsoids | 3 | 3 | 97.6 / 97.6 / 4 | 97.5 / 98.4 / 4 |
| terrain-clipping-planes | 2 | 2 | 87.3 / 69.4 / 122 | 87.3 / 69.4 / 122 |
| wall | 3 | 3 | 98.3 / 97.2 / 0 | 98.3 / 96.3 / 0 |
