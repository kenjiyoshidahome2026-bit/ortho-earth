# デモ頁の品質台帳（2026-10-04）

www のデモ一覧（`demos.json`・21 枚・入口 HTML 17 頁）を横並びで検めた台帳。棚卸し＝2026-10-03〜04（スレッド「デモアプリの品質を揃える」）。
**揃えた物差し**（＝`tests/t-demo-pages.mjs` が `npm test -w www` で毎回見る）と、**まだ揃っていない物**（裁定待ち・実機待ち）を分けて書く。

## 1. 揃えた（この段で直した）

| 物差し | 内容 | 当てた頁 |
|---|---|---|
| 共通の器 | `@ortho-earth/globe/page.js`：`startPage()`＝言語（`setLang` → `<html lang/dir>`）・起動画面の退場・**起動失敗を画面に言葉で**（紙色の面＋再読み込み・26 言語）。旧＝各頁が同じ 10 行を複製し、失敗は console だけ（japan・nl は catch 無し＝起動画面が永久に残った） | parks・models・fireworks・scene・geoedit・tellus・quakes・sats・clouds・physical（器ごと）／japan 本体・census2020・nl（catch だけ） |
| 言語切替 | `map.gadget.lang()`（34px 規格・透明な `<select>`＝OS 標準の一覧・`?lang=` を書いて読み直す）。旧＝parks・physical・geopbf-demo が各自の select、他は URL を手で直すしかなかった | models・fireworks・scene・geoedit・quakes・sats・clouds（parks・physical は従来の select を残す） |
| 言語（html） | scene・geoedit・tellus は `lang="ja"` だけ特別扱い（24 言語で `lang=en`・`dir` 無し）→ 26 言語とも `<html lang/dir>` を書く | scene・geoedit・tellus |
| 起動画面 | `aria-label` を "Loading" に統一（旧＝英語 head の頁に「起動中」「census2020 起動中」…）・`prefers-reduced-motion` で止める | japan・census2020・nl・parks・models・fireworks・geoedit・tellus・quakes・sats・clouds |
| head | `theme-color`（全頁。physical は紙色 `#f6f6f4` に訂正＝旧は暗色の値）・`canonical`（world・equal・geopbf・gishub-jp・census2020・nl に追加）・japan の頁に manifest／apple-touch-icon | 全 17 頁 |
| 共有カード | og:image の欠落（fireworks・clouds・geopbf・world・equal・gishub-jp）→ www のサムネイル／壊れた参照（census2020・nl の `ogp.png`＝実体なし）→ サムネイル／scene の汎用 ogp → 自分のサムネイル／twitter:card の欠落と `summary`（clouds）→ `summary_large_image` | 同上 |
| a11y | geopbf-demo の `user-scalable=no, maximum-scale=1` を撤去（japan・nl の 2026-08-04 の判断と同じ）・viewport-fit=cover に統一 | geopbf・world・gishub-jp・scene |
| 検定 | `tests/t-demo-pages.mjs`＝demos.json の全カード → 入口 HTML を解き、上の物差し（lang・title・description・viewport・theme-color・canonical・favicon・og:*・画像の実在・twitter:card・boot の label と reduced-motion）を静的に検める。頁を足したら demos.json にカードを足せば自動で門に入る | 21 枚／17 頁 |
| 文書 | README の無かった 6 アプリ（equal・solar・geopbf-demo・gishub-jp・census2020・ortho-nl）に 1 枚ずつ。ortho-globe の表に physical。ortho-japan に showcase 7 頁の表 | — |

## 2. 揃っていない（裁定待ち・実機待ち）

| 項目 | 現状 | 案 |
|---|---|---|
| /nl/ の head | 題・説明・出典が日本語（エンジン UI は 26 言語・demos.json は "26"） | 英語 head に揃える（本人裁定）。検定は当面 nl だけ `lang=ja` を例外扱い |
| census2020・nl の言語の食い違い | 頁は日本語固定、エンジンの UI（ガジェットの文言）はブラウザ言語に従う＝英語ブラウザで日本語の頁に英語のボタン | `lang: "ja"` を渡して頁ごと日本語に揃えるか、頁を 26 言語にするか |
| tellus の長文 | 「仕組み」「次の一手」の案内が ja/en の 2 本（`tellus.js` BACK/NEXT）＝他 24 言語は ja に落ちる。言語切替ガジェットは載せていない | 26 言語に訳すか、en へ落とすか |
| 戻り口（サイトへの導線） | どの頁にも www（デモ一覧）へ戻るリンクが無い（census2020 のブランドのみ）。www の一覧は iframe で開くので、そこでは不要 | 出典行（instruments の attr）に「Ortho Earth」を足すか、hint カードに置くか |
| 共有ボタン | QR＝japan・census2020・nl／リンク複写＝tellus／無し＝他 | `map.gadget.qr()` を showcase にも載せるか |
| solar の言語切替 | 26 言語の辞書はあるが選ぶ UI が無い（`?lang=` のみ）。エンジン非依存の頁なので `map.gadget.lang()` は使えない | solar 自前の select（equal の `.eq-select` と同型） |
| 読み込み中の表示 | physical は台帳が届くまで案内板が出ない（無言）／solar は模様無し／geopbf は変換前は無し | 共通の読込トースト（dock の `#net-toast` 相当）を器に足す |
| RTL | `dir` は書くが、quakes・sats・clouds・physical の案内板は `right:12px` の物理値（鏡像にならない） | `inset-inline-end` に置換（各 .js の CSS） |
| 共有カードの画像 | fireworks・clouds・scene・geopbf・world・equal・gishub-jp・census2020・nl は www のサムネイル（800 幅 webp）。1200×630 の `og/*.jpg` は未撮影 | 手元 Mac で `og-shot.mjs`（japan・solar と同じ手順）＝実 GPU が要る |
| ブラウザ検定 | verify:ui＝fireworks・scene のみ／verify:prod＝japan・globe 5 頁・world・census2020。parks・models・tellus・equal・solar・geopbf・gishub-jp・nl は静的検査のみ | 各頁の `t-*.html` を増やすか、verify:prod に頁を足す |
| 実機の目視 | 言語切替ガジェット（透明 select の当たり判定・iOS の車輪）・起動失敗の面・言語を変えた後の案内板は器（SwiftShader）で見ただけ | 帰国後に手元 Mac／iPad で |

## 3. 頁ごとの現状（棚卸しの要約）

| 頁 | 言語 | 切替 UI | ? help | 全画面 | 共有 | 起動失敗の表示 | ブラウザ検定 | README |
|---|---|---|---|---|---|---|---|---|
| /japan/（japan・japan-demo・pop-density・edo-map） | 26 | — | ✓ | ✓ | QR | ✓（この段） | verify:ui 22 頁・verify:prod | ✓ |
| /japan/parks | 26 | select（頁） | ✓ | ✓ | URL | ✓ | — | ✓（この段） |
| /japan/models | 26 | gadget | ✓ | ✓ | URL | ✓ | — | ✓ |
| /japan/fireworks | 26 | gadget | ✓ | ✓ | URL | ✓ | t-fireworks | ✓ |
| /japan/scene | 26 | gadget | — | — | — | ✓ | t-scene・verify:prod | ✓ |
| /japan/geoedit | 26 | gadget | — | ✓ | — | ✓ | verify:editor・verify:prod | ✓ |
| /japan/tellus | UI 26／長文 ja·en | — | — | ✓ | リンク複写 | ✓ | — | ✓ |
| /japan/census2020/ | ja | — | ✓ | ✓ | QR | ✓ | verify:prod | ✓ |
| /globe/（equal 入口） | 26 | — | — | — | — | console のみ（script は PR #218 の持ち物＝head だけ直した） | verify:prod | ✓ |
| /globe/physical | 26 | select（頁） | ✓ | ✓ | URL | ✓ | verify:prod | ✓ |
| /globe/parks | 26 | select（頁） | ✓ | ✓ | URL | ✓ | — | ✓（2026-10-07・/japan/parks と同型＝器ごと startPage） |
| /globe/quakes・sats・clouds | 26 | gadget | ✓ | ✓ | URL | ✓ | verify:prod | ✓ |
| /world/ | 26 | 自前 | — | — | URL | 文言あり | verify:prod | ✓ |
| /equal/ | 26 | select（パネル） | — | — | URL | トースト（WebGL2 無し） | — | ✓ |
| /solar/ | 26 | — | 常時ヒント | — | URL | 文言あり（WebGL2 無し） | — | ✓ |
| /geopbf/ | 26 | select | 手順表示 | ✓ | URL | エンジンの面 | — | ✓ |
| /gishub-jp/ | ja | — | ヒント行 | ✓ | — | 一覧に文言 | — | ✓ |
| /nl/ | UI 26／head ja | — | ✓ | ✓ | QR | ✓（この段） | — | ✓ |
