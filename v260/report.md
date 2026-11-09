# Cesium 門 v260（claude/project-thread-mir9bm 785868a7d・--only 6 例）

条件：v250 と同じ（--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2・ref は v242）。比較の元＝v250。pair＝左 Cesium・右 ortho（1920×720）。

## 段か colour が 2 ポイント以上変わった例

| 例 | v250 | v260 | v250 colour / edges / blob | v260 colour / edges / blob |
|---|---|---|---|---|
| 3d-tiles-point-cloud | 2 | **2** | 92.0 / 91.3 / 38 | 91.7 / 91.4 / 38 |
| 3d-tiles-point-cloud-shading | 3 | **2** | 91.9 / 94.7 / 12 | 84.1 / 96.1 / 131 |
| arcticdem | 3 | **3** | 91.7 / 82.3 / 19 | 91.7 / 82.3 / 19 |
| fog | 2 | **2** | 95.1 / 48.8 / 7 | 95.0 / 49.4 / 7 |
| geometry-height-reference | 2 | **3** | 99.4 / 37.0 / 2 | 99.3 / 91.7 / 4 |
| gpx | 3 | **3** | 97.1 / 94.1 / 11 | 97.1 / 94.1 / 11 |

## 撮った全例

| 例 | v250 | v260 | v250 | v260 |
|---|---|---|---|---|
| 3d-tiles-point-cloud | 2 | 2 | 92.0 / 91.3 / 38 | 91.7 / 91.4 / 38 |
| 3d-tiles-point-cloud-shading | 3 | 2 | 91.9 / 94.7 / 12 | 84.1 / 96.1 / 131 |
| arcticdem | 3 | 3 | 91.7 / 82.3 / 19 | 91.7 / 82.3 / 19 |
| fog | 2 | 2 | 95.1 / 48.8 / 7 | 95.0 / 49.4 / 7 |
| geometry-height-reference | 2 | 3 | 99.4 / 37.0 / 2 | 99.3 / 91.7 / 4 |
| gpx | 3 | 3 | 97.1 / 94.1 / 11 | 97.1 / 94.1 / 11 |

- fog: the first shot had the example's camera race (distance 13.8 km instead of 3.0 km); re-shot alone (v260b) and copied in.
