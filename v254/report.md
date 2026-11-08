# Cesium 門 v254（最終の全撮影）＋ MapLibre 門 o1108b — claude/project-thread-mir9bm e089eb4（= main 2c1addc06・PR #1035）

## 1. Cesium Sandcastle 門

条件：v250 と同じ（`--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2`・ref は v242）。Chrome for Testing 154.0.8037.92。309 例。
MapLibre 門と同時に回した。下がった例と colour が大きく下がった例は `v254b` で単独に撮り直し、数字は小数まで同じ＝揺れではない。

| 段 | v250 | v254 |
|---|---|---|
| 3 | 225 | **226** |
| 2 | 73 | **72** |
| 1 | 0 | 0 |
| 0 | 0 | 0 |
| null | 11 | 11 |

### 段が変わった例・colour が 2 ポイント以上動いた例（colour % / edges % / blob）

右端＝実験 v254e（下記・コミットしていない）。

| 例 | v250 | v254 | v250 picture | v254 picture | v254e（cos 修正＋nearEye） |
|---|---|---|---|---|---|
| 3d-models-dev | 2 | 2 | 94.7 / 96.1 / 44 | 90.5 / 91.7 / 42 | 2 · 90.5 / 91.7 / 42 |
| 3d-tiles-compare | 2 | 2 | 93.5 / 92.6 / 37 | 95.7 / 95.8 / 33 | – |
| 3d-tiles-nga-gpm-visualization | 2 | 2 | 90.8 / 95.3 / 74 | 93.8 / 96.8 / 29 | – |
| arcticdem | 3 | **2** ↓ | 91.7 / 82.3 / 19 | 53.7 / 73.8 / 501 | 3 · 91.7 / 82.3 / 19 |
| bing-maps-labels-only | 2 | **3** ↑ | 89.4 / 87.9 / 25 | 97.4 / 99.3 / 16 | 3 · 97.4 / 99.3 / 16 |
| cartographic-limit-rectangle | 2 | 2 | 91.8 / 93.2 / 32 | 94.9 / 93.9 / 32 | 2 · 94.9 / 93.9 / 32 |
| constant-lod-dev | 2 | 2 | 91.5 / 96.8 / 28 | 74.4 / 89.0 / 24 | 3 · 99.1 / 97.1 / 9 |
| czml-model | 3 | 3 | 86.5 / 82.6 / 13 | 99.9 / 91.3 / 1 | – |
| czml-model-articulations | 2 | 2 | 81.0 / 79.5 / 27 | 94.5 / 88.1 / 21 | – |
| czml-model-data-url | 3 | 3 | 94.9 / 88.0 / 9 | 100.0 / 91.4 / 1 | – |
| drawing-on-terrain | 2 | 2 | 83.5 / 84.5 / 23 | 64.4 / 83.8 / 362 | 2 · 86.3 / 89.3 / 29 |
| elevation-band-material | 3 | 3 | 90.8 / 93.6 / 15 | 87.7 / 92.8 / 15 | 3 · 90.7 / 94.2 / 15 |
| fog | 2 | 2 | 95.1 / 48.8 / 7 | 91.4 / 43.6 / 7 | 2 · 98.2 / 55.1 / 7 |
| geometry-and-appearances | 2 | **3** ↑ | 93.9 / 96.4 / 23 | 98.6 / 96.9 / 6 | – |
| gpx | 3 | **2** ↓ | 97.1 / 94.1 / 11 | 74.7 / 79.5 / 64 | 3 · 97.1 / 94.1 / 11 |
| ground-polyline-material-dev | 2 | 2 | 81.1 / 82.1 / 23 | 66.2 / 82.4 / 340 | 2 · 83.9 / 86.5 / 31 |
| ground-primitive-dev | 2 | 2 | 69.2 / 83.7 / 301 | 53.5 / 74.5 / 336 | 2 · 74.0 / 85.4 / 301 |
| headingpitchroll | 2 | **3** ↑ | 81.5 / 92.3 / 107 | 95.2 / 95.1 / 14 | – |
| labels | 2 | **3** ↑ | 97.4 / 98.0 / 27 | 98.9 / 99.5 / 2 | – |
| localtofixedframe | 3 | 3 | 93.7 / 84.6 / 19 | 97.6 / 90.4 / 19 | – |
| material-with-custom-glsl | 2 | 2 | 92.9 / 94.7 / 114 | 88.8 / 95.1 / 118 | – |
| physically-based-materials | 2 | 2 | 87.3 / 37.2 / 36 | 80.1 / 27.5 / 78 | 2 · 87.9 / 65.7 / 38 |
| terrain-entity-batching-dev | 3 | **2** ↓ | 98.4 / 92.1 / 5 | 98.5 / 60.9 / 5 | 3 · 98.4 / 90.1 / 5 |
| web-map-tile-service-picking | 3 | 3 | 96.3 / 99.5 / 9 | 99.0 / 99.4 / 1 | – |

### 下がった 3 例の切り分け

- arcticdem・gpx・terrain-entity-batching-dev（3→2）、ほか地形を斜めに見る例の colour 低下（drawing-on-terrain・ground-*-dev・constant-lod-dev 等）。
- 原因のコミット＝**0529399（raster-sse の cosφ 二重掛けの修正）**：0529399 だけで撮った v254c が v254 と小数まで同じ。v250 のコミット dd42329f1 で撮り直した v254d は v250 と小数まで同じ＝外部（画像配信）の変化ではない。
- 仕組み（見立て）：cos の誤りは画像の z を一段細かくしていた。真下見下ろし（bing-maps-labels-only）ではそれが余計だったが、斜めの地形では、こちらの距離の測り方（タイル内の「画面中心に近い点」まで＝手前のタイルは遠めに測る＝粗く出る）の偏りを打ち消していた。直したので手前が粗くなった（pair の手前の山肌がぼける）。
- 実験 v254e（作業場所でだけ・コミットしていない）：cos 修正のまま、sse 層だけ selectLOD に `nearEye: true`（Cesium と同じ「目からタイルの最も近い点まで」の距離）。結果：arcticdem・gpx・terrain-entity-batching-dev は v250 の数字に戻る。constant-lod-dev 2→3・geometry-height-reference 2→3・bing-maps-labels-only 3 のまま。**下がるのは 3d-tiles-point-cloud-shading 3→2**（手前の画像が細かくなり色味が本物とずれる・11/1 の nearEye 試行と同じ例）。

## 2. MapLibre 公式例の門（ref r7・ortho o1108b）

`verify-examples.mjs --side ortho --ref r7 --label o1108b` → `--grade --ref r7 --ortho o1108b`（--update なし）。結果：「known.json どおり（下がった例なし）」。
段：3＝91・2＝43・1＝3・0＝0・分母の外 2。o1108 とも o1102x＋o1102chk とも **139 例すべて同じ段**＝`ml/` に画像はない。
同時に回したことによる時間切れ・揺れは無し（例外1 の 2 件＝sync-movement-of-multiple-maps・toggle-deckgl-layer は従来どおり）。
