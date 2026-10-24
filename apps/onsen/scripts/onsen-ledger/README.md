# onsen-ledger — 日本の温泉の台帳（`ortho-data/japan/onsen.json`）を組む

`/japan/onsen`（`onsen.html` + `onsen.js`）が読む台帳を、Wikipedia 日本語版を軸に集めて組む工程。依存パッケージは無い（Node 22 以上）。

```sh
sh run-all.sh             # 全工程。生応答は .cache/raw/ にキャッシュ＝2 回目からは数分
sh run-all.sh --refresh   # 取り直し（Wikimedia の 429 待ちで 3 時間前後）
sh test-mock.sh           # 網なしの検定（模擬サーバで全工程＋本文の解析）
node ledger-build.mjs --data DIR   # 既にある data/（onsen.csv ほか）から台帳だけ組み直す
node ledger-list.mjs               # 温泉一覧（source/onsen-list.csv）を台帳に重ねる（ledger-build の後に 1 回だけ）
```

作業場は既定で `.cache/`（git に入れない）。`ONSEN_ROOT` で差し替えられる。プロキシ環境では `run-all.sh` が `NODE_USE_ENV_PROXY=1` を立てる。

## 工程

| 工程 | 中身 |
| --- | --- |
| `01-pages.mjs` | ja.wikipedia の Category:日本の温泉地 の下位（深さ 3）と「日本の温泉地一覧」・都道府県別一覧から記事題名を集める |
| `02-fetch.mjs` | 主座標・Wikidata ID・カテゴリ（api.php）と本文（`action=raw`）。`parse.mjs` が Template:日本の温泉地（泉質・泉温・pH・液性…）・読み・`{{coord}}`・源泉の位置関係の文を抜く |
| `03-wikidata.mjs` | P625 座標・P131・P361/P527・ラベル・enwiki。SPARQL で記事の無い温泉も候補に |
| `05-geocode.mjs` | 座標の無い行を OSM（Nominatim）名称検索 → 地理院 住所検索 → 市町村の順に推定。精度と根拠を残す |
| `06-hitou.mjs` | 日本秘湯を守る会の会員宿一覧と各宿頁の JSON-LD（宿名・住所・座標）。紹介文は持たない |
| `04-build.mjs` | 突き合わせ・篩（駅・ダム・ホテル・概念記事などを落とす）・温泉郷の結び付けと面・源泉・会員宿の対応 → `data/` |
| `ledger-build.mjs` | `data/` → `ortho-data/japan/onsen.json`（短い鍵の台帳・形は先頭の註）。泉質を 10 分類の番号に、よみからローマ字の英語名を作る。後始末として、地域しか分からない推定は県の中心へ寄せ、郷から 25 km 超の所属は外し（推定の点は郷の位置へ置き直す）、郷の面を作り直す |
| `ledger-list.mjs` | 温泉一覧（`source/onsen-list.csv`＝Kenji の元データ 4,566 行・本人 2026-10-24）を台帳に重ねる。県＋名前（温泉・鉱泉・括弧を除く）か wiki の題で突き合わせ、当たった温泉の推定の点を一覧の座標へ置き直し、測定値（深度・湯量・泉温・pH・成分）を `x` に、江戸番付の位を `bz` に持つ。当たらない行は新しい温泉（id `k<行>`）。一覧の温泉郷の列を正として所属を置き換え（無い郷は `kg<n>`）、郷の面を作り直す。有名さの段 `f`（0＝現代番付・1＝英語版 Wikipedia か湯量 3,000 L/分・2＝日本語版 Wikipedia・秘湯の宿・湯量 300 L/分）＝頁の LOD。江戸番付は有名さに使わない |

## 決め事

- **温泉郷は温泉の集合体**＝郷の座標と構成する温泉の点を 1.5 km 太らせた凸包を面として持つ。
- **座標が無くても推定する**＝`a`（精度 m）と `e`（方法）を必ず残す。頁は推定の点を白抜きで出し、選ぶと誤差の円を出す。
- **源泉が温泉地から離れている物**（岳温泉＝8 km 上から引湯・宇奈月温泉＝黒薙温泉から 7 km）は本文の文を根拠として `s` に持つ。源泉の位置（座標か引湯元の温泉）が分かれば頁が線で結ぶ。
- **日本秘湯を守る会**の会員宿は名前・座標・URL だけ持ち、温泉に結ぶ。

## 出典とライセンス

温泉一覧（source/onsen-list.csv＝Wikipedia と、長年現地を巡った記録から編纂）・Wikipedia 日本語版（CC BY-SA 4.0）・Wikidata（CC0）・推定座標 © OpenStreetMap contributors（ODbL）／国土地理院 住所検索・会員宿 日本秘湯を守る会（https://www.hitou.or.jp/）。頁の案内板に同じ表記がある。

## 網の注意

クラウドの共有 IP では api.php が約 35 秒の窓に数件しか通らず 429 を返す。`lib.mjs` は `ONSEN_GAP`（既定 9 秒）で間を空け、Retry-After に従って再試行する。本文は `action=raw`（別の枡・`ONSEN_GAP_RAW`）から取る。Nominatim・地理院・秘湯を守る会は 1.1 秒に 1 件（`ONSEN_GAP_OTHER`）。User-Agent は repo の URL を名乗る。
