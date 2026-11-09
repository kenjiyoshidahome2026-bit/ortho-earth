# Cesium 門 v258（claude/project-thread-mir9bm e623f0d95・--only 4 例）

条件：v250 と同じ（--side ortho --gpu --hide-ui --time-from v242 --wait 20000 --jobs 2・ref は v242）。比較の元＝v250。pair＝左 Cesium・右 ortho（1920×720）。

## 段か colour が 2 ポイント以上変わった例

| 例 | v250 | v258 | v250 colour / edges / blob | v258 colour / edges / blob |
|---|---|---|---|---|
| classification | 2 | **2** | 92.3 / 93.4 / 37 | 95.6 / 95.9 / 37 |
| classification-types | 2 | **3** | 95.5 / 93.7 / 77 | 99.7 / 93.7 / 1 |

## 撮った全例

| 例 | v250 | v258 | v250 | v258 |
|---|---|---|---|---|
| 3d-tiles-photogrammetry-classification | 2 | 2 | 93.9 / 96.5 / 34 | 93.9 / 96.4 / 34 |
| classification | 2 | 2 | 92.3 / 93.4 / 37 | 95.6 / 95.9 / 37 |
| classification-types | 2 | 3 | 95.5 / 93.7 / 77 | 99.7 / 93.7 / 1 |
| google-photorealistic-3d-tiles-with-building-insert | 3 | 3 | 98.8 / 97.4 / 3 | 98.8 / 97.4 / 3 |

## Notes

- e623f0d95: cssColor (packages/globe/src/hillshade.ts) divided getImageData's bytes by alpha, but ImageData is not premultiplied, so translucent colours came out as rgb / a. Tree pixel (red tree): before (255,87,95), now (167,58,60); Cesium (168,59,60).
- WebGL2 (?gl2=1) draws no classification on 3D Tiles at all (type both and tiles3d, polygon or mesh): a separate bug, not fixed here.
