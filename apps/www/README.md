# www（www.ortho-earth.com のトップ）

キャッチ＝**Equal to all, fair to the Earth / This is the project for all people on the earth. The earth is round.**（本人の文のまま・訳さない・英語以外では下に小さく訳を添える）

## サンプル（デモ）を足す

1. `demos.json` の `demos` に 1 件足す（`href`・`group`・`icon`・`title`・`desc`）。`group` は `groups` の id（earth / japan / space / tools）。新しい棚が要るなら `groups` にも足す
2. 訳は任意：`i18n/ui.json` に `desc`（と英語の普通名詞の `title`）の訳を足して `npm run i18n:build -w www`。無ければその言語でも英語で出る（`verify:i18n` は警告だけ）。固有名詞の題（`ortho-solar` 等・`proper`）は訳したい言語だけ足す（例：ja だけ「太陽系」）＝足さない言語は英語名のまま（門は咎めない）
3. 画像：`npm run thumbs -w www`（画像がまだ無いデモだけ本番の頁から撮る・640×400 の webp＝`public/thumbs/<id>.webp`）。撮り直しは `--only=<id>`・待ち時間や撮る前の操作は `demos.json` の `shot`（`wait`・`eval`・`after`・`from`）。GPU で描く頁があるのでサンドボックスの外で走らせる
4. PR を main にマージ → 公開（下記）。手元の確認は `npm run build:all`

カードはビルド時に静的 HTML へ焼かれる（`cards.js`・`vite.config.js` の transformIndexHtml）＝JS なしでも実リンク。`llms.txt` の Apps 節も同じ一覧から生成される。

## Stories（記事）を足す

1. 記事の頁を `apps/docs/` に置く（build:all が `/docs/` へ写す）
2. `stories.json` の `stories` の先頭に 1 件足す（`id`・`date`・`ja` と `en` の `title`・`desc`・`href`。片方の言語だけでも可）
3. カードはビルド時に `<!--STORIES-->` へ焼かれ、押すとデモと同じくナビの下の iframe で開く。記事の文言は訳さない（日本語の頁では `ja`、他の言語では `en` を出す）

## 言語

英語キー・26 言語（`packages/world/i18n/langs.json`）。頁の文言は `index.html` の `data-t` / `data-t-<attr>`、正本は `i18n/ui.json`→`i18n/lang/*.json`（言語ごとに遅延 import）。頁の UI の訳が欠けると `npm run build -w www` の門（`verify:i18n`）が落ちる。選んだ言語（`?lang=` か右上）はデモへのリンクへ `?lang=` で伝搬する。

## 公開

**main にマージすると Cloudflare Pages（プロジェクト `www-ortho-earth`）の Git 連携が自動で build して公開する**。手で `wrangler pages deploy` を回す必要は無い。
PR の枝もそのたびに Preview が作られ、URL は PR に付く bot のコメント（`<枝名>.www-ortho-earth.pages.dev`）に出る。

- **Worker を先に配る**：トップはマージした瞬間に本番へ出るので、新しい頁のカードが先に出て Worker 側がまだだとリンク切れになる。
  新しい app や頁を足した時は、その app の Worker（`npm run deploy -w <app>`・手元の wrangler）を先に配ってからマージする。
- 共有エンジン（`/globe/engine/<版>/`）を読む頁は ortho-globe の Worker を先に配る（順は root の README の「Deploying」）。
- 非常時に手で出す時だけ：`npm run build:all` のあと、**git の外を cwd にして**（worktree の中だとブランチ名を拾って Preview に落ちる）

```
<repo>/node_modules/.bin/wrangler pages deploy <repo>/apps/www/dist --project-name=www-ortho-earth --branch=main --commit-hash=<sha> --commit-dirty=true
```

⚠ `public/` のアセット名は `/japan*`・`/ortho-japan*`・`/world*` で始めない（Worker ルートに横取りされる）。
