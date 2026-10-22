# MapLibre style-spec の性質の網羅表（生成物）

`scripts/ml-coverage.mjs` が style-spec 26.4.4 の写し（core `src/mlspec.ts`）から作る。手で書き換えない＝状態を変えるときはスクリプトの `NOTES`（台帳 `maplibre-compat.md` の §3・§4 の写し）を直して書き出し直す。
「読む」は性質の名前を読む所がエンジンにあることだけを言う。絵が MapLibre と同じかは公式例の門（台帳 §8）と互換の爪車（§6）が見る。

計 136：読む 106・近似 5・一部 17・未 8

| 層 | 置き場 | 性質 | 状態 | 中身 |
|---|---|---|---|---|
| fill | layout | `fill-sort-key` | 読む |  |
| fill | paint | `fill-antialias` | 読む |  |
| fill | paint | `fill-opacity` | 読む |  |
| fill | paint | `fill-layer-opacity` | 近似 | vector の層だけ・地物の opacity に掛け合わせる（§4） |
| fill | paint | `fill-color` | 読む |  |
| fill | paint | `fill-outline-color` | 読む |  |
| fill | paint | `fill-translate` | 一部 | GL2 の基図と vector の層（S-P1-4/5・2026-10-22・層で一度＝zoom の式はタイルの z）・3D（地形あり）の塗り・WebGPU・geojson の層は読まない |
| fill | paint | `fill-translate-anchor` | 一部 | translate と同じ（viewport＝方位だけ回す） |
| fill | paint | `fill-pattern` | 一部 | GL2 の基図と vector の層（S-P1-4/5・2026-10-22・名前は層で一度・模様の大きさは cos φ 倍・3D の塗りと WebGPU は描かない）・geojson の層は canvas2D の模様 |
| line | layout | `line-cap` | 一部 | GL2 は MapLibre と同じ（S-P1-1・2026-10-22）・WebGPU と geojson の層は丸 |
| line | layout | `line-join` | 一部 | GL2 は MapLibre と同じ（属性の式は層で一度）・WebGPU と geojson の層は丸 |
| line | layout | `line-miter-limit` | 一部 | GL2 だけ（zoom の式も読む） |
| line | layout | `line-round-limit` | 近似 | 読まない＝丸い継ぎのまま（浅い角の見分けは付かない） |
| line | layout | `line-sort-key` | 読む |  |
| line | paint | `line-opacity` | 読む |  |
| line | paint | `line-layer-opacity` | 近似 | vector の層だけ・地物の opacity に掛け合わせる（§4） |
| line | paint | `line-color` | 読む |  |
| line | paint | `line-translate` | 一部 | GL2 の基図と vector の層（S-P1-4/5・2026-10-22）・WebGPU・geojson の層は読まない |
| line | paint | `line-translate-anchor` | 一部 | translate と同じ（viewport＝方位だけ回す） |
| line | paint | `line-width` | 近似 | 基図と vector の層は約 32px で頭打ち（表の u8・§4） |
| line | paint | `line-gap-width` | 読む | 基図・vector・geojson（2026-10-03） |
| line | paint | `line-offset` | 読む |  |
| line | paint | `line-blur` | 一部 | GL2 の基図と vector の層（S-P1-4/5・2026-10-22・属性の式は層で一度）・WebGPU・geojson の層は読まない |
| line | paint | `line-dasharray` | 一部 | GL2 の基図と vector の層は MapLibre と同じ（S-P1-3・2026-10-22）・WebGPU・ずらす層・9 個以上はタイルの z の尺で刻む・geojson の層は先頭の対だけ |
| line | paint | `line-pattern` | 一部 | geojson の層だけ（canvas2D の模様）。基図・vector の層は未 |
| line | paint | `line-gradient` | 一部 | geojson の層だけ（canvas2D の線の飾り）。vector の層は未 |
| symbol | layout | `symbol-placement` | 読む |  |
| symbol | layout | `symbol-spacing` | 読む |  |
| symbol | layout | `symbol-avoid-edges` | 未 |  |
| symbol | layout | `symbol-sort-key` | 読む | 衝突判定の順 |
| symbol | layout | `symbol-z-order` | 一部 | 基図・vector の注記だけ（geojson の点置きの symbol は読まない・§4） |
| symbol | layout | `icon-allow-overlap` | 読む |  |
| symbol | layout | `icon-overlap` | 読む |  |
| symbol | layout | `icon-ignore-placement` | 読む |  |
| symbol | layout | `icon-optional` | 読む |  |
| symbol | layout | `icon-rotation-alignment` | 読む |  |
| symbol | layout | `icon-size` | 読む |  |
| symbol | layout | `icon-text-fit` | 読む |  |
| symbol | layout | `icon-text-fit-padding` | 読む |  |
| symbol | layout | `icon-image` | 読む |  |
| symbol | layout | `icon-rotate` | 読む |  |
| symbol | layout | `icon-padding` | 読む |  |
| symbol | layout | `icon-keep-upright` | 未 |  |
| symbol | layout | `icon-offset` | 読む |  |
| symbol | layout | `icon-anchor` | 読む |  |
| symbol | layout | `icon-pitch-alignment` | 読む |  |
| symbol | layout | `text-pitch-alignment` | 読む |  |
| symbol | layout | `text-rotation-alignment` | 読む |  |
| symbol | layout | `text-field` | 読む |  |
| symbol | layout | `text-font` | 近似 | 端末のフォントで描く（glyphs は記録だけ）＝波 5 の T-P4 で PBF |
| symbol | layout | `text-size` | 読む |  |
| symbol | layout | `text-max-width` | 読む |  |
| symbol | layout | `text-line-height` | 読む |  |
| symbol | layout | `text-letter-spacing` | 読む |  |
| symbol | layout | `text-justify` | 読む |  |
| symbol | layout | `text-radial-offset` | 読む |  |
| symbol | layout | `text-variable-anchor` | 読む |  |
| symbol | layout | `text-variable-anchor-offset` | 読む |  |
| symbol | layout | `text-anchor` | 読む |  |
| symbol | layout | `text-max-angle` | 読む |  |
| symbol | layout | `text-writing-mode` | 読む |  |
| symbol | layout | `text-rotate` | 読む |  |
| symbol | layout | `text-padding` | 読む |  |
| symbol | layout | `text-keep-upright` | 読む |  |
| symbol | layout | `text-transform` | 読む |  |
| symbol | layout | `text-offset` | 読む |  |
| symbol | layout | `text-allow-overlap` | 読む |  |
| symbol | layout | `text-overlap` | 読む |  |
| symbol | layout | `text-ignore-placement` | 読む |  |
| symbol | layout | `text-optional` | 読む |  |
| symbol | layout | `symbol-height-offset` | 読む |  |
| symbol | layout | `symbol-height-anchor` | 読む |  |
| symbol | paint | `icon-opacity` | 読む |  |
| symbol | paint | `icon-color` | 読む |  |
| symbol | paint | `icon-halo-color` | 読む |  |
| symbol | paint | `icon-halo-width` | 読む |  |
| symbol | paint | `icon-halo-blur` | 読む |  |
| symbol | paint | `icon-translate` | 読む |  |
| symbol | paint | `icon-translate-anchor` | 読む |  |
| symbol | paint | `text-opacity` | 読む |  |
| symbol | paint | `text-color` | 読む |  |
| symbol | paint | `text-halo-color` | 読む |  |
| symbol | paint | `text-halo-width` | 読む |  |
| symbol | paint | `text-halo-blur` | 読む |  |
| symbol | paint | `text-translate` | 読む |  |
| symbol | paint | `text-translate-anchor` | 読む |  |
| circle | layout | `circle-sort-key` | 読む |  |
| circle | paint | `circle-radius` | 読む |  |
| circle | paint | `circle-color` | 読む |  |
| circle | paint | `circle-blur` | 一部 | GL2 の vector の層（S-P1-4/5・2026-10-22・層で一度・透ける円の縁の輪はぼかさない）・WebGPU・geojson の層は読まない |
| circle | paint | `circle-opacity` | 読む |  |
| circle | paint | `circle-translate` | 一部 | GL2 の vector の層（S-P1-4/5・2026-10-22）・WebGPU・geojson の層は読まない |
| circle | paint | `circle-translate-anchor` | 一部 | translate と同じ（viewport＝方位だけ回す） |
| circle | paint | `circle-pitch-scale` | 未 | 遠近の縮みは無い（§4） |
| circle | paint | `circle-pitch-alignment` | 一部 | "map" は警告して画面に向いた円で描く |
| circle | paint | `circle-stroke-width` | 読む |  |
| circle | paint | `circle-stroke-color` | 読む |  |
| circle | paint | `circle-stroke-opacity` | 読む |  |
| heatmap | paint | `heatmap-radius` | 読む |  |
| heatmap | paint | `heatmap-weight` | 読む |  |
| heatmap | paint | `heatmap-intensity` | 読む |  |
| heatmap | paint | `heatmap-color` | 読む |  |
| heatmap | paint | `heatmap-opacity` | 読む |  |
| fill-extrusion | layout | `fill-extrusion-rounded-corner-distance` | 読む |  |
| fill-extrusion | paint | `fill-extrusion-opacity` | 読む |  |
| fill-extrusion | paint | `fill-extrusion-color` | 読む |  |
| fill-extrusion | paint | `fill-extrusion-translate` | 未 | 警告して描く（§4） |
| fill-extrusion | paint | `fill-extrusion-translate-anchor` | 未 | translate が未 |
| fill-extrusion | paint | `fill-extrusion-pattern` | 未 | 警告して描く（§4） |
| fill-extrusion | paint | `fill-extrusion-height` | 読む |  |
| fill-extrusion | paint | `fill-extrusion-base` | 読む |  |
| fill-extrusion | paint | `fill-extrusion-vertical-gradient` | 読む |  |
| raster | paint | `raster-opacity` | 読む |  |
| raster | paint | `raster-hue-rotate` | 読む |  |
| raster | paint | `raster-brightness-min` | 読む |  |
| raster | paint | `raster-brightness-max` | 読む |  |
| raster | paint | `raster-saturation` | 読む |  |
| raster | paint | `raster-contrast` | 読む |  |
| raster | paint | `resampling` | 読む |  |
| raster | paint | `raster-resampling` | 読む |  |
| raster | paint | `raster-fade-duration` | 読む |  |
| hillshade | paint | `hillshade-illumination-direction` | 読む |  |
| hillshade | paint | `hillshade-illumination-altitude` | 読む |  |
| hillshade | paint | `hillshade-illumination-anchor` | 未 |  |
| hillshade | paint | `hillshade-exaggeration` | 読む |  |
| hillshade | paint | `hillshade-shadow-color` | 読む |  |
| hillshade | paint | `hillshade-highlight-color` | 読む |  |
| hillshade | paint | `hillshade-accent-color` | 読む |  |
| hillshade | paint | `hillshade-method` | 読む |  |
| hillshade | paint | `resampling` | 読む |  |
| color-relief | paint | `color-relief-opacity` | 読む |  |
| color-relief | paint | `color-relief-color` | 読む |  |
| color-relief | paint | `resampling` | 読む |  |
| background | paint | `background-color` | 読む |  |
| background | paint | `background-pattern` | 未 | §3 B5 |
| background | paint | `background-opacity` | 読む |  |
