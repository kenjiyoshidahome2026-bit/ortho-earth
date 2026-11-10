# Cesium 門 v270（claude/project-thread-7bmgob f6fd4b4a8・--only 6 例）

変更：sdk/cesium display.ts + materials.ts＝地面に塗る entity 形を czm_phong ×(0.5+0.5·diffuse) で照らす（Cesium の ShadowVolumeAppearance と同じ）。

条件：v262m と同じ（--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2）。ref＝v262m/ref（rectangle は PRE_SHOT 付きで撮り直した ref・他は v242 の ref）。pair＝左 Cesium・右 ortho（1920×720）。rectangle は 2 回撮った（2 回目＝v270-r2）。

選んだ例＝地面の形に塗り（Image / Stripe / Checkerboard / Grid）を使うもの：rectangle・clamp-entities-to-ground・geometry-and-appearances・ground-primitive-materials-dev・terrain-entity-batching-dev・z-indexing-geometry。外したもの：polygon（perPositionHeight＝地面でない）・shadows（box）・video（楕円体）・materials / material-dev / ellipsoid-surface-dev / coplanar-polygon-dev（Primitive＋EllipsoidSurfaceAppearance＝地面の primitive でない）・polyline 系（線）・bathymetry / globe-materials（地球の material）・mars（火星＝採点外）。

## 例ごと（colour / edges / blob）

| 例 | 前の run | 段 | 前 | v270 | 2 回目 |
|---|---|---|---|---|---|
| rectangle | v262m | 3 → **3** | 99.0 / 96.4 / 3 | 99.2 / 96.4 / 3 | 99.2 / 96.4 / 3 (L3) |
| clamp-entities-to-ground | v269 | 2 → **2** | 77.0 / 87.0 / 128 | 77.0 / 87.0 / 128 | – |
| geometry-and-appearances | v259 | 3 → **3** | 98.7 / 97.0 / 6 | 98.6 / 96.9 / 6 | – |
| ground-primitive-materials-dev | v266 | 2 → **2** | 87.3 / 93.7 / 21 | 87.3 / 93.7 / 21 | – |
| terrain-entity-batching-dev | v269 | 3 → **3** | 98.4 / 90.1 / 5 | 98.3 / 89.4 / 5 | – |
| z-indexing-geometry | v266 | 3 → **3** | 97.2 / 98.7 / 9 | 97.2 / 98.7 / 9 | – |

## rectangle のロゴ域（800×600 の x 410–600・y 240–350 の平均 RGB）

| 画像 | 全体 | 白 | 青 | 緑 |
|---|---|---|---|---|
| Cesium（ref） | 142,153,149 | 255,255,255 | 130,210,255 | 95,144,50 |
| ortho v262m（前） | 139,152,150 | 242,243,244 | 124,183,223 | 88,128,63 |
| ortho v270 | 141,154,152 | 243,243,244 | 142,209,247 | 101,146,70 |
| ortho v270 2 回目 | 141,154,152 | 243,243,244 | 142,209,247 | 101,146,70 |

白＝R,G,B すべて 170 超・青＝B が G より 25・R より 40 以上大きい・緑＝G が R より 30 以上大きく B 以上（−10 まで）。白・青・緑の画素数は ref 8977 / 548 / 699・v270 8905 / 519 / 746。注：ref の絵は四角の傾きが少し違い、右上に Cesium の選択表示の一片が入る（crop に入る）。


## rectangle の fps（ortho）

v270 の頁を headless・実 GPU（--ignore-gpu-blocklist）・800×600 で開き、20 s 待って 5 s の rAF を数えた（#1049 と同じ rAF カウンタ・?perf=1 は付けず）。

| 側 | rAF/s | 20 ms 超の frame | 最悪 |
|---|---|---|---|
| ortho 1 | 60.0 | 0 | 16.7 ms |
| ortho 2 | 60.0 | 0 | 16.7 ms |
| ortho 3 | 60.0 | 0 | 16.7 ms |
| Cesium 1 | 60.0 | 0 | 16.8 ms |
| Cesium 2 | 60.0 | 0 | 16.8 ms |

#1049 の後＝60.2/s・最悪 28.3 ms。照らしで frame は落ちていない。
