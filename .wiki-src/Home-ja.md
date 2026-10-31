> [English](Home) · **日本語**

# Ortho Earth wiki

**maplibre + cesium − mercator = ortho-earth。** サーバー不要の WebGPU / WebGL2 正射図法の地図エンジンと GIS ワークステーション。実行時の依存はゼロで、すべてブラウザの中で動きます。常に地球儀で、平らなメルカトルはありません（平らな世界地図は Equal Earth）。

- サイト：[www.ortho-earth.com](https://www.ortho-earth.com) ・ 日本の 3D 地図：[/japan/](https://www.ortho-earth.com/japan/) ・ 世界の地球儀：[/globe/](https://www.ortho-earth.com/globe/) ・ MapLibre の例：[/maplibre/](https://www.ortho-earth.com/maplibre/) ・ Cesium Sandcastle：[/sandcastle/](https://www.ortho-earth.com/sandcastle/)
- すぐ使う：`npm i @ortho-earth/globe` して `createGlobe({ target: "#map" })`。MapLibre のコードは `@ortho-earth/globe/maplibre`、Cesium のコードは `@ortho-earth/cesium` でそのまま動きます。

## ページ一覧

| ページ | 内容 |
|---|---|
| [構成](Architecture-ja) | 層、`/globe/engine/<版>/` の共有エンジン、頁の殻、アプリ間の掟 |
| [アプリと URL](Apps-and-URLs-ja) | 公開中の頁と、それを出す `apps/<name>`、内部の Worker |
| [パッケージ](Packages-ja) | npm パッケージと SDK の現在の版とライセンス |
| [配布とリリース](Deploy-and-Release-ja) | merge で自動配布、関門、npm 公開、ミラー、データ |
| [開発とテスト](Development-and-Tests-ja) | 準備、ビルド、テストと関門 |
| [セキュリティ](Security-ja) | サポート版、脆弱性の報告方法、コードスキャン |
| [最近の変更](Recent-Changes-ja) | 最近の変更（2026 年 10 月） |
| [今後の計画](Roadmap-ja) | 2.2 の後：計測・高速化・重複の削除 |

正本はリポジトリです：[README](https://github.com/kenjiyoshidahome2026-bit/ortho-earth#readme)・[LAYERS.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/LAYERS.md)・[MIGRATION.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/MIGRATION.md)・[DATA.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/DATA.md)・[SECURITY.ja.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/SECURITY.ja.md)。この wiki は概要で、食い違う時はリポジトリが正しい方です。

_最終更新：2026-10-31_
