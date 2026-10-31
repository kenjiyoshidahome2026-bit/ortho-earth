> [English](Development-and-Tests) · **日本語**

# 開発とテスト

## 準備

- Node 22.18 以上（テストは Node 組み込みの型除去で `.ts` を直接読みます）と npm。
- repo 直下で `npm install` すると全 workspace（`packages/*`・`sdk/*`・`apps/*`）が入ります。

## 動かす・組む

- `npm run dev:www`：デモのカードが並ぶトップ頁。
- `npm run dev -w <app>`：アプリ 1 つ（例 `-w japan-map`・`-w globe-map`）。dev では共有エンジンもソースから直接読みます。
- `npm run build:all`：www・geopbf-demo・gishub-jp・world を組み、`apps/www/dist`（docs・geopbf・gishub-jp・world・共有エンジン）にまとめます。
- `node scripts/size-report.mjs --compare`：配布物の大きさを基準と比べます。
- エンジンの API は [`packages/globe/README.md`](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/globe/README.md)、プラグインは [`PLUGINS.md`](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/globe/PLUGINS.md)、データ層は [`packages/geopbf/README.md`](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/packages/geopbf/README.md) から。

## テスト

| コマンド | 何を走らせるか |
|---|---|
| `npm test` | モノレポの Node だけのテストを並列で全部（`scripts/test-all.mjs`・約 200 ファイル）。`npm run test:list` で一覧、`npm test -- geopbf` で一部、`TEST_JOBS=1` で 1 本ずつ |
| `npm run verify:i18n` | 全アプリの i18n の門（同じ言い回しは 1 つの辞書にだけ） |
| `npm run verify:app-imports` | アプリが他のアプリを読んでいないか（爪車・`npm test` に含む） |
| `npm run verify:regionless -w @ortho-earth/globe` | globe／core のコードに地域名が無いか（爪車） |
| `packages/globe` の `verify:ui`・`verify:webgpu`・`verify:nocoi`・`verify:examples` | エンジンのブラウザ検査 |
| `apps/japan-map` の `verify:ui`・`verify:webgpu`・`verify:prod`、`apps/japan-host` の `verify:prod` | 日本の地図のブラウザ検査 |
| `packages/geopbf` の `verify:pages`、`apps/equal` の `verify:gpu` | その他のブラウザ検査 |

ブラウザ検査は版を固定した headless の Chrome for Testing を使います（約 150 MB・`~/.cache/ortho-earth/chrome-for-testing` に保存・`packages/globe` で `npm run chrome:install` すると先に取得・`CHROME=<path>` で差し替え）。WebGPU の検査には本物の GPU が要るので、WebGPU だけの回帰は Mac で確かめます。

## コツ

- エンジンの変更で UI が動く時は、同じ PR で `verify:ui` のテストも直します。
- WGSL の uniform の並びは CPU 側の詰め方と同じ順に（`frame-layout.mjs` のテスト）。
- アプリからは公開 API（`globe.d.ts`）だけを使い、`dbgHost` や `__*` は使いません。
