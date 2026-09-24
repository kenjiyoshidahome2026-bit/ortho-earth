# www（www.ortho-earth.com のトップ）

キャッチ＝**Equal to all, fair to the Earth / This is the project for all people on the earth. The earth is round.**（本人の文のまま・訳さない・英語以外では下に小さく訳を添える）

## サンプル（デモ）を足す

1. `demos.json` の `demos` に 1 件足す（`href`・`group`・`icon`・`title`・`desc`）。`group` は `groups` の id（earth / japan / space / tools）。新しい棚が要るなら `groups` にも足す
2. 訳は任意：`i18n/ui.json` に `desc`（と英語の普通名詞の `title`）の訳を足して `npm run i18n:build -w www`。無ければその言語でも英語で出る（`verify:i18n` は警告だけ）。固有名詞の題（`ortho-solar` 等・`proper`）は訳したい言語だけ足す（例：ja だけ「太陽系」）＝足さない言語は英語名のまま（門は咎めない）
3. 画像：`npm run thumbs -w www`（画像がまだ無いデモだけ本番の頁から撮る・640×400 の webp＝`public/thumbs/<id>.webp`）。撮り直しは `--only=<id>`・待ち時間や撮る前の操作は `demos.json` の `shot`（`wait`・`eval`・`after`・`from`）。GPU で描く頁があるのでサンドボックスの外で走らせる
4. `npm run build:all` → 公開（下記）

カードはビルド時に静的 HTML へ焼かれる（`cards.js`・`vite.config.js` の transformIndexHtml）＝JS なしでも実リンク。`llms.txt` の Apps 節も同じ一覧から生成される。

## 言語

英語キー・26 言語（`packages/world/i18n/langs.json`）。頁の文言は `index.html` の `data-t` / `data-t-<attr>`、正本は `i18n/ui.json`→`i18n/lang/*.json`（言語ごとに遅延 import）。頁の UI の訳が欠けると `npm run build -w www` の門（`verify:i18n`）が落ちる。選んだ言語（`?lang=` か右上）はデモへのリンクへ `?lang=` で伝搬する。

## 公開

`npm run build:all` のあと、**git の外を cwd にして** wrangler を実行（worktree の中だとブランチ名を拾って Preview に落ちる）：

```
<repo>/node_modules/.bin/wrangler pages deploy <repo>/apps/www/dist --project-name=www-ortho-earth --branch=main --commit-hash=<sha> --commit-dirty=true
```

⚠ `public/` のアセット名は `/japan*`・`/ortho-japan*`・`/world*` で始めない（Worker ルートに横取りされる）。
