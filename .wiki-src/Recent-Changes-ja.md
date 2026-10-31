> [English](Recent-Changes) · **日本語**

# 最近の変更（2026 年 10 月）

新しい順。番号は PR です。

## 2026-10-31

- **セキュリティ：** CodeQL の警告 26 件を仕分け（7 件修正・#821）。`c8` の `glob`／`minimatch` を差し替えて `npm audit` を中程度 4 件 → 0 件に（#822）。
- **地球儀：** 世界の河川と海洋境界線を海岸線と同じ z9 で止める（#823）。
- **重複の削除：** 殻アプリの i18n の門を共通の 1 本に（#813）、GL のオーバーレイの program 作成を共通化（#814）、gishub-jp の census の写しを消して `/japan/census2020/` へ案内（#816）。
- **高速化：** Cesium の層と 3D Tiles の選びの毎フレームの処理をキャッシュ、`?perf=1` の計器（#815）。Mac で測ると CPU は既に 1 フレーム 1 ms 前後以下で、残りは GPU。
- **決定：** WebGL2 は 2.x の間は維持（#817）。
- **文書：** 2.2 のリリースノートと Stories、Sandcastle のギャラリー、Leaflet と Google Maps の手引き（#809〜#812）。

## リリース 2.2.0（10 月下旬）

- `@ortho-earth/core` と `@ortho-earth/globe` が 2.2.0 に。
- 新しい **`@ortho-earth/cesium`** 0.1.0：ortho-earth の上で動く CesiumJS の API。描かない部分は Cesium のコードをそのまま使い、描く所だけを置き換えます。Cesium の Sandcastle が [/sandcastle/](https://www.ortho-earth.com/sandcastle/) で動きます。
- 新しい `@ortho-earth/leaflet` と `@ortho-earth/gmaps`。`scene` 0.2.0・`splat` 0.6.0・`voxel` 0.6.0・`google3d` 0.2.0。
- Cesium と揃えるための描画：模型と 3D Tiles の CustomShader（GLSL と WGSL）、3D Tiles への画像の貼り付け、切り抜きの多角形、tileset の輪郭線、点群の分類、鏡面 IBL、レンズフレア、被写界深度、ブルーム、海底（水深）表示、地形プロバイダ、3D Tiles の `sampleHeight`。

## 10 月中旬〜下旬

- **アプリの組み替え（2026-10-24）：** 頁ごとに `apps/<name>` と `servedAt`、起動は `@ortho-earth/globe/page.js`。ホストは `globe-host` と `japan-host`。URL は変わらず。
- **自動配布（2026-10-23）：** `main` への merge で Mac の runner から配布。[配布とリリース](Deploy-and-Release-ja) を参照。
- **セキュリティの強化（2026-10-24）：** 応答ヘッダー、`security.txt`、待ち日数つきの Dependabot、旧 Pages の削除。
- **アプリ：** 横浜デジタルツイン（`/yokohama/`）、MP4 に書き出す scenes エディタ（`/japan/scene`）、見どころと前後比較つきの Tellus（`/japan/tellus`）、地球儀のボクセルとスプラット、点群、温泉、雲。
- **修正：** WebGPU の太陽の uniform の並び（#719）、地球儀の WebGPU の深度と切り抜き（#737）、gishub-jp の d3 の複製と Shift_JIS の ZIP 名（#688・#691・#692・#707）。

すべての履歴は [main のコミット](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commits/main) と [merge 済みの PR](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/pulls?q=is%3Apr+is%3Amerged) にあります。
