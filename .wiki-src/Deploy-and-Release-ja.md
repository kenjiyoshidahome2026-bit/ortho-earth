> [English](Deploy-and-Release) · **日本語**

# 配布とリリース

## 本番への配布（workflow `deploy`）

- **merge で自動。** `main` への push のうち配る物（`apps/**`・`packages/**`・`sdk/**`・`package-lock.json`・配布の台本）が変わった時、target `engine-and-apps` で `deploy` が走ります。`www`・`docs`・`gishub-jp`・`geopbf-demo`・`*.md` だけの merge は走りません（Cloudflare Pages が組みます）。
- **走る場所は Kenji さんの Mac**（self-hosted runner・label `ortho-deploy`）。関門に本物の GPU（WebGPU の画素検定）が要るためです。Cloudflare へは Mac でログイン済みの `wrangler` で出すので、GitHub に鍵は置きません。Mac が眠っていると runner を待ちます（24 時間で GitHub が捨てます）。
- **1 本ずつ。** 走っている 1 本と、待っている最新の 1 本だけが残ります。古い待ちは「cancelled」になりますが失敗ではありません。
- **順番：** globe の関門（新しいエンジンに対する `globe-host` の `verify:prod`）→ エンジン（`ortho-engine`）→ globe のホスト → エンジンを読む全アプリ。最初に落ちた関門で止まります。全体で 5〜11 分ほど。
- **手動のボタン：** Actions → deploy → `main` で Run workflow。target は `engine-and-apps`（アプリ名を並べればそれだけ）・`engine-only`・`gate-only`（関門だけで何も配らない）・`native-bucket`・`quakes-mirror`・`sats-mirror`。
- 配り終えると tag `japan-deployed` を push します（次の日本のエディタ関門の範囲）。
- `wrangler` のある手元からも同じことができます：repo 直下で `npm run deploy:engine`、Worker 1 つなら `npm run deploy -w <app>`。

## サイト（`www`）

`www.ortho-earth.com`（トップ・`/maplibre/`・`/sandcastle/`・`/docs/`・`/geopbf/`・`/gishub-jp/`）は Cloudflare Pages で、`main` が変わると自動で公開されます。Claude のブランチの PR には `https://claude-project-thread-<id>.www-ortho-earth.pages.dev` のプレビューが付きます。

## npm への公開（workflow `publish`）

- Actions → publish → Run workflow。パッケージ名を空にすると npm にまだ無い版をすべて出し、名前を書けばそれだけ出します（例 `@ortho-earth/core`）。本当に出す時は **dry run をオフ**に。
- オプションで、ミラーのある物（`geopbf`・`altpbf`・`geoedit`・`native-bucket`・`ortho-world`・`himekuri`）を単独リポジトリへ写します（workflow `mirror`）。
- 公開後の確認は Mac で走ります。そこが赤くても公開されていないとは限らないので、まず npm を確かめます。
- 版は公開の前に PR で `package.json` を上げておきます。

## データ

- **R2 バケット：** 大きなデータは `apps/uploader` の画面からだけ上げます。身軽に保ちます。
- **デモのデータ：** `ortho-data/japan/**` と `ortho-data/us/**` は `main` への push で workflow `pages` が GitHub Pages に出します。

## その他の workflow

- `test`：PR と `main` への push ごとに `npm ci`、root の `npm test`（Node だけ・ブラウザ不要）、i18n の門。
- CodeQL のコードスキャン（JavaScript/TypeScript・Rust・Actions）。

## 害の無い既知のメッセージ

`ENOENT /tmp/oe-bucket-cache`、一時的な「world のカードが出ない」、runner での `vite: command not found`（直し方：`npm rebuild vite`）。
