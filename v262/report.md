# Cesium 門 v262m（claude/project-thread-mir9bm 7908c78f8・--only 5 例）

条件：v250 と同じ（--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2・ref は v242）。比較の元＝v250。pair＝左 Cesium・右 ortho（1920×720）。

## 段か colour が 2 ポイント以上変わった例

| 例 | v250 | v262m | v250 colour / edges / blob | v262m colour / edges / blob |
|---|---|---|---|---|
| classification | 2 | **2** | 92.3 / 93.4 / 37 | 95.5 / 95.4 / 37 |
| classification-types | 2 | **3** | 95.5 / 93.7 / 77 | 99.7 / 93.7 / 1 |
| ground-primitive-dev | 2 | **2** | 69.2 / 83.7 / 301 | 89.6 / 88.0 / 47 |
| rectangle | 2 | **3** | 95.3 / 95.1 / 85 | 99.0 / 96.4 / 3 |
| web-map-tile-service-picking | 3 | **3** | 96.3 / 99.5 / 9 | 99.9 / 99.4 / 0 |

## 撮った全例

| 例 | v250 | v262m | v250 | v262m |
|---|---|---|---|---|
| classification | 2 | 2 | 92.3 / 93.4 / 37 | 95.5 / 95.4 / 37 |
| classification-types | 2 | 3 | 95.5 / 93.7 / 77 | 99.7 / 93.7 / 1 |
| ground-primitive-dev | 2 | 2 | 69.2 / 83.7 / 301 | 89.6 / 88.0 / 47 |
| rectangle | 2 | 3 | 95.3 / 95.1 / 85 | 99.0 / 96.4 / 3 |
| web-map-tile-service-picking | 3 | 3 | 96.3 / 99.5 / 9 | 99.9 / 99.4 / 0 |
