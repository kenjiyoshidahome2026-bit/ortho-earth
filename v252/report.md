# Cesium 門 v252（claude/project-thread-mir9bm 174e345・--only 22 例）

条件：v250 と同じ（--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2・ref は v242）。比較の元＝v250。pair＝左 Cesium・右 ortho（1920×720）。

## 段か colour が 2 ポイント以上変わった例

| 例 | v250 | v252 | v250 colour / edges / blob | v252 colour / edges / blob |
|---|---|---|---|---|
| headingpitchroll | 2 | **3** | 81.5 / 92.3 / 107 | 95.2 / 95.1 / 14 |
| labels | 2 | **3** | 97.4 / 98.0 / 27 | 98.9 / 99.5 / 2 |
| localtofixedframe | 3 | **3** | 93.7 / 84.6 / 19 | 97.6 / 90.4 / 19 |

## 撮った全例

| 例 | v250 | v252 | v250 | v252 |
|---|---|---|---|---|
| aec-elements-api-query | 2 | 2 | 87.8 / 93.4 / 69 | 87.8 / 93.4 / 69 |
| callback-position-property | 3 | 3 | 97.5 / 72.9 / 6 | 97.5 / 72.9 / 6 |
| callback-property | 3 | 3 | 90.5 / 87.7 / 7 | 90.9 / 88.1 / 4 |
| clamp-entities-to-ground | 2 | 2 | 76.5 / 86.6 / 128 | 77.0 / 87.0 / 128 |
| clamp-to-3d-model | 3 | 3 | 94.9 / 87.4 / 8 | 94.9 / 87.5 / 8 |
| czml | 3 | 3 | 99.0 / 98.1 / 2 | 99.0 / 98.1 / 2 |
| czml-billboard-and-label | 3 | 3 | 98.6 / 99.5 / 5 | 98.8 / 99.7 / 2 |
| czml-path | 2 | 2 | 96.3 / 6.6 / 20 | 97.7 / 6.2 / 1 |
| czml-reference-properties | 3 | 3 | 97.6 / 97.5 / 6 | 98.8 / 98.7 / 2 |
| headingpitchroll | 2 | 3 | 81.5 / 92.3 / 107 | 95.2 / 95.1 / 14 |
| interpolation | 2 | 2 | 60.2 / 75.9 / 58 | 60.2 / 75.9 / 58 |
| kml | 3 | 3 | 99.1 / 100.0 / 1 | 99.1 / 100.0 / 1 |
| labels | 2 | 3 | 97.4 / 98.0 / 27 | 98.9 / 99.5 / 2 |
| localtofixedframe | 3 | 3 | 93.7 / 84.6 / 19 | 97.6 / 90.4 / 19 |
| manually-controlled-animation | 3 | 3 | 95.3 / 94.7 / 3 | 95.3 / 94.4 / 3 |
| parallels-and-meridians | 3 | 3 | 99.2 / 100.0 / 2 | 99.2 / 100.0 / 2 |
| picking | 3 | 3 | 99.0 / 99.8 / 2 | 99.0 / 99.8 / 2 |
| picking-dev | 3 | 3 | 99.0 / 99.8 / 2 | 99.0 / 99.8 / 2 |
| star-burst | 3 | 3 | 99.0 / 99.7 / 2 | 99.0 / 99.7 / 2 |
| terrain | 3 | 3 | 96.8 / 92.2 / 5 | 96.8 / 92.2 / 5 |
| time-dependent-path-graphics | 3 | 3 | 97.6 / 98.2 / 3 | 97.6 / 98.2 / 3 |
| time-dynamic-wheels | 2 | 2 | 90.9 / 93.1 / 119 | 90.8 / 93.2 / 119 |
