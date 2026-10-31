> [English](Roadmap) · **日本語**

# 2.2 の後の計画

リポジトリの正本は [`packages/ortho-core/improvement plan.md`](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/ortho-core/improvement%20plan.md) です。2026-10-31 時点の要約：

**大きな作り直しは要りません。** エンジンのコピペの重複は少なく（packages と sdk で約 2%、apps で 12.8%）、本当の重複は WebGL2 と WebGPU の二重実装（約 9,000 行と 10,500 行）です。速さの無駄はエンジンの芯よりも、2.2 で増えた Cesium の層と 3D Tiles の毎フレームの処理に集まっています。

| 段階 | 中身 | 状況 |
|---|---|---|
| 0. 測る（数日） | Cesium の層と 3D Tiles に `?perf=1` の計器、初期バンドルの大きさの関門、Mac と iPhone の基準値 | 計器は済み（#815）、iPhone の基準値はこれから |
| 1. 安い高速化（1 週） | Cesium の facade は比べてから作る、3D Tiles の境界をノードごとに持つ、点群のスタイルで点ごとの JSON 鍵をやめる、起動に要らない部品は後から読む | 主な物は済み（#815）。Mac で CPU は 1 フレーム 1 ms 前後以下 |
| 2. 速さの計画の残り（2〜3 週） | WebGPU の paint 表、文字の GPU 化（T-P1 の門）、render bundle（Mac で go/no-go）、`geopbf` の topology を uint32 の hash で 2 倍速 | 次。先に GPU 側を測る |
| 3. 重複の削除（並行） | i18n の門を 1 本に（#813）、GL の program 作成を共通化（#814）、census の写しを削除（#816）、自前の描画層の共通部品（voxel・splat・scene・copc…）、`gl/` と `gpu/` から純関数を抜き出す | 進行中 |
| 4. 構造（後回し） | `globe.ts` と `gpu/renderer.ts` の分割、facade の型（cesium・leaflet・gmaps の `any`） | 邪魔になった時に |

速さの PR は、絵が変わらず Sandcastle と MapLibre の門で段が下がらないことが条件で、URL の逃げ道（`?xxx=0`）を付けます。

**やらないこと：** 描画ループやタイル結合の WASM 化、multi-draw-indirect、GL と GPU のシェーダを 1 つのソースから生成する作り直し。

**決定済み：** WebGL2 は 2.x の間は維持します（#817）。古い iPhone や WebGPU の無い端末が使われている間は残します。
