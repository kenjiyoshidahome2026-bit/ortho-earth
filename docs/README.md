# docs — 開発者向けの文書

利用者向けの説明はサイトの [/docs](https://www.ortho-earth.com/docs/)（`apps/docs/`）、各 package の使い方はその package の README。
ここは**リポジトリを触る人向け**の文書の置き場。

| 場所 | 中身 |
| --- | --- |
| `architecture.md` | 層・共有エンジン・ホスト・アプリ間の掟 |
| `apps.md` | 各アプリの URL と担当の Worker |
| `development.md` | 開発・テスト・デプロイ・npm 公開の手順 |
| `design/` | 今も生きている設計・台帳（変えたら更新する） |
| `notes/` | 計画・調査のメモ（起案日つき・済んだ物も記録として残す） |

## design/

- [fallback-ladder.md](design/fallback-ladder.md) — バックエンド選択・端末ティア・jetsam 防衛の台帳（ノブを変えたら更新）
- [gint-draw-spec.md](design/gint-draw-spec.md) — Gint 描画定義仕様
- [webgpu-port.md](design/webgpu-port.md) — WebGPU バックエンド移植の設計
- [projector.md](design/projector.md) — 投影 seam（Projector）の叩き台

## notes/

- [improvement-plan.md](notes/improvement-plan.md) — 2.2 以後の改善計画（順番の正本）
- [render-roadmap.md](notes/render-roadmap.md) — 描画の統合ロードマップ
- [perf-survey.md](notes/perf-survey.md) / [perf-plan.md](notes/perf-plan.md) — 描画の速さの俯瞰と実施計画
- [vt-perf-plan.md](notes/vt-perf-plan.md) — ベクタータイル描画の高速化
- [text-gpu-plan.md](notes/text-gpu-plan.md) — テキスト描画の WebGPU 化
- [geojson-vt-plan.md](notes/geojson-vt-plan.md) — geojson の層を vector の描き方へ
- [raster-tiles.md](notes/raster-tiles.md) — メルカトル・ラスタタイルの v2 移植
- [unity-roundtrip.md](notes/unity-roundtrip.md) — ortho-earth ⇄ Unity 6 のデータ往復（錨・GLB・ortho-export・見本プロジェクト）
- [unreal-roundtrip.md](notes/unreal-roundtrip.md) — ortho-earth ⇄ Unreal Engine 5.6 のデータ往復（軸と cm・Interchange・LAS・プラグイン）
- [minecraft.md](notes/minecraft.md) — ortho-earth ⇄ Minecraft（Java 版・統合版）：ボクセル化・色→ブロック・Anvil／.schem／.mcworld・ブロック→GLB の取り込み

## ここ以外に置く文書（置き場が決まっている物）

外からのリンクや npm の都合で動かさない物。正本はそれぞれ 1 か所だけ。

| 文書 | 置き場 | 動かさない理由 |
| --- | --- | --- |
| 入口・何か・始め方 | `README.md` | GitHub の顔 |
| ゲームエンジンのプラグイン（Unity・Unreal・共通の約束） | `plugins/README.md`・`plugins/unity/README.md`・`plugins/unreal/README.md` | npm の workspace の外＝エンジンが読む場所（Unity の Add package from disk・Unreal の `Plugins/`） |
| リリースノート | `CHANGELOG.md` | GitHub Releases とサイトの記事はここを引く |
| 1.x → 2.0 の移行 | `MIGRATION.md` | npm の README・サイトの頁・llms.txt から絶対 URL で張られている |
| 層の掟 | `LAYERS.md` | コードの注記が「LAYERS.md 掟 3」の形で多数参照 |
| データの出所と許諾 | `DATA.md` | 同上 |
| 脆弱性の報告 | `SECURITY.md`・`SECURITY.ja.md` | GitHub が root を読む |
| package ごとの使い方 | `packages/*/README.md`・`sdk/*/README.md` | npm に載る |
| MapLibre との差の台帳 | `packages/globe/maplibre-compat.md`・`maplibre-coverage.md` | globe の README とサイトの移行ガイドから参照 |
| プラグイン・three.js | `packages/globe/PLUGINS.md`・`THREE.md` | THREE.md は npm に同梱 |
| GeoPBF の書式 | `packages/geopbf/pbf spec.md`・`reference.md` | 公開ミラーと npm の README から相対リンク |
| 利用者向けの解説・記事 | `apps/docs/`（サイトの /docs） | サイトの見た目を変えない |
| アプリ固有の記録 | `apps/<app>/README.md` など | そのアプリの中で閉じる |

design/ と notes/ の文書は 2026-11-02 に `packages/ortho-core/` から移した（名前の空白は `-` に）。
本文中の package 名の無い `src/…`・`tests/…` は `packages/ortho-core/` からの相対。
architecture.md・apps.md・development.md は 2026-11-02 に GitHub wiki の下書き（`.wiki-src/`）から移した（英語版だけ残し、日本語版と README・CHANGELOG と重なる頁は削除）。
