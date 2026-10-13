# データの置き場の台帳（ortho-data）

デモが読むデータファイルを、bucket（`api.ortho-earth.com`・置くのに X-API-Key が要る）から
GitHub Pages（リポ `ortho-data`）へ移している途中の記録。2026-10-13 に始めた。
決まり・いまの配置・出ている版・**次にやること**をここに 1 本でまとめる（置く手順の細部は `packages/world/README.md`）。

## 1. 決まり（本人裁定 2026-10-13）

- **置き場**：公開リポ `kenjiyoshidahome2026-bit/ortho-data` の `gh-pages` 枝（唯一の枝）。
  配信＝`https://kenjiyoshidahome2026-bit.github.io/ortho-data/<path>`。置くのは git push だけ＝**鍵が要らない**。
- **フォルダは「読むアプリ」でなく「データの範囲」で分ける**。
  - `globe/` … 全世界のデータ。**宇宙（`globe/sky/`）もここ**（japan から読んでいても範囲は全世界）。
  - `japan/` … 日本のデータ（未着手）。
  - `us/`・`nl/` … アメリカ・オランダ（**提案中＝本人の返事待ち**。フォルダ名は頁の URL に揃える案）。
- **名前はデータ、文言はプログラム**。
  - データに結びつく名前（国・都市・地形…＝DB の ID が鍵）＝DB の隣に `<DB>.i18n/<lang>.json`・DB と同じ push で置く。
  - 画面の文言（ui・categories・plateBoundaries）＝配信しない。`packages/world/i18n/ui.json` を頁が直に読む（`ui-table.js`）。
- **帯域の重い物は bucket に残す**。Pages の目安は月 100GB。全アプリが初回に読む `ne-cultural`（16MB）は載せない。
- **目録**：`globe/manifest.json`＝`{ files: { パス: 中身の sha1 の頭 12 桁 } }`。Pages に一覧 API は無い＝
  world の頁はこれ 1 本で「変わったファイル」と「在る国旗」を知る。置くたびに作り直す。

## 2. 置き方

```
npm run publish:pages -w world-data                 # 予行：今の Pages と比べて 新規／変更／同じ
npm run publish:pages -w world-data -- --write      # commit して push（反映＝30 秒ほど＋キャッシュ 10 分）
#   --from=DIR（既定 packages/world/out）  --only=NationDB.json,NationDB.i18n  --allow-older
```

- 置く元は `packages/world/out/`（git に入らない＝**機械ごとに中身が違う**）。手元の JSON の `updated` が
  Pages より古いと止まる（古い版で上書きしない）。会社の機械の `out/` は 10/13 に本番の 10/11 版へ揃えた。
- DB と名前＝`npm run build -w world-data`／検索の索引＝`node packages/world/scripts/search-index.mjs`。
- **国旗・国の形・音・ne-cities・宇宙の名前**は uploader が作る物で、ortho-data へ置く道はまだ無い
  （10/13 は本番 bucket の写しをそのまま置いた）。uploader の「全部作る」は今も bucket に置く＝新しい読み手には届かない。
- Pages の素性（実測）：全ファイルに `access-control-allow-origin: *`・ETag・Range は 206・キャッシュ 10 分固定・
  ヘッダは変えられない。1 ファイル 100MB・サイト 1GB まで。

## 3. いま何がどこにあるか

| 物 | 置き場 | 読み手 |
|---|---|---|
| 国の台帳 5 本（NationDB・CityDB・LanguageDB・CurrencyDB・Conflicts）と名前 | `globe/` | world・world-quiz・equal・エンジンの世界帯 |
| 地形（TerrainDB と名前・ne-physical・plates・回帰線・気候区分） | `globe/` | /globe/physical・japan の地形（plates） |
| 国旗 267・国の形 262・`sfx.zip`・ne-cities | `globe/` | world・world-quiz・世界帯 |
| 地名検索の索引 `search/`（13,154 件） | `globe/` | エンジンの検索窓（10/13 まで本番は 404 だった） |
| 宇宙：stars.6・星座線・メシエ・月の地名（.geopbf）と名前 | `globe/sky/` | solar・エンジンの星空・www の先読み |
| 形状 `ne-cultural-base`／`-detail`・`rivers.json` | **bucket GIS/world に残す** | 全アプリ |
| 地震の `archive.geopbf`（23MB） | R2 `ortho-quakes`（/quakes/） | /globe/quakes |
| 人工衛星 `active.csv`（毎時ミラー） | Worker＋KV（/sats/） | /globe/sats |
| 雲 | 自前のデータなし（NASA GIBS・EUMETView 直読み） | /globe/clouds |

読み先の正本＝`packages/ortho-core/src/worldcontent.js` の `WORLD_DATA`（Pages）と `WORLD_GIS`（bucket＝形状だけ）。
宇宙＝`packages/globe/src/sky/data.js`（solar は同じ URL を自前の数行で読む＝コードを共有しない掟）。

## 4. 出ている版（2026-10-13 夕方）

| アプリ | 状態 |
|---|---|
| ortho-globe（共有エンジン） | 全部入り（Worker `fcb13b71`） |
| world・world-quiz・equal | world のデータ切替まで入り（宇宙の変更は equal に無関係） |
| solar | 宇宙の切替入り（Worker `06024ae8`） |
| www（Pages） | main に入った分まで。**先読みの変更（星表）は PR のマージで出る** |
| GeoPBF デモ・world | 共有エンジンを読む＝旧版の入口が今の版へ 302（出し直し不要） |
| **japan・nl・census2020** | **未 deploy**＝世界帯の国名・星空・plates を bucket から読み続ける |

未 deploy のアプリが読むので、bucket の旧い物（DB・`i18n/`・`GIS/space`・`GIS/pbf` の星）は**消さずに凍結**してある。

同じ日に入れた、データ移行とは別の直し（japan などは次の deploy で入る）：
- geopbf の wasm：線の purifier の格子をデータに合わせる（世界規模の線の焼きが 100 倍以上速い・結果は同じ）。
- エンジン：geojson source の `cacheKey`（焼いた結果を IDB に控える）。`globe.d.ts`・`llms.txt` 更新済。
- 地形の頁：初回 18 秒 → 約 7 秒・2 回目以降 約 1.7 秒。

## 5. 次にやること

1. **PR をマージ**：枝 `claude/sky-data-pages`（宇宙の切替＋この台帳）。本番の ortho-globe と solar はこの枝から出してある。
2. **人工衛星のミラーが止まっている**：`/sats/status` が「10/5 に 503 を受けて停止」の札を返し、8 日前の軌道要素を
   配っている。原因を確かめてから `apps/sats-mirror` で `wrangler kv key delete halt`（手順は worker.js の冒頭）。
3. **japan・nl・census2020 を出し直す**：新しい読み先・wasm の直し・`llms.txt` が入る。
4. **`us/`・`nl/` を決める**（上の提案でよいか）。アメリカの公園＝`apps/ortho-globe/public/` の
   `parks-us.geopbf`・`nps-units.geopbf`・`parks-us.json`（今は Worker の deploy で出ている＝鍵は元々不要）。
5. **`japan/`**：`apps/ortho-japan/public/` の `parks.geopbf`・`terrain.geopbf`・`showcase/*.geopbf`、
   gishub-jp の `jishin/fault`・`jishin/seismic`・`jma/amedas`、bucket `GIS/pbf/nps_all`（日本の自然公園 10MB）。
   public の物は鍵なしで出ている＝急がない。移す値打ちがあるのは bucket にある物。
6. **地震の archive**：移すなら 1 ファイル置いて読み先 1 行。ただし初回 1 人 23MB＝月 4,300 人ほどで帯域の目安。
   Claude の見立ては「R2 に残す」（wrangler で置ける＝鍵は元々不要）。本人の判断待ち。
7. **uploader → ortho-data の道**：国旗・国の形・音・ne-cities・宇宙の名前（正本 `packages/space`）を作り直した時に置く手順。
8. **bucket の掃除**（3 が済んでから）：読み手なしの `ne-cultural.geopbf`（19MB）・`国旗.zip`・`国名一覧.json`・`range.json`、
   旧い DB・`i18n/`・`flags/`・`geoms/`・`音源.zip`・`GIS/space/`・`GIS/pbf` の星 4 本。**消す前に本人に確かめる**。
9. **npm publish**：geopbf（wasm の直し）と `@ortho-earth/globe`（`cacheKey`・`WORLD_DATA`）。
10. **性能の残り**：初回起動の 0〜3 秒（JS・エンジンの読み込み）と、届いた形状の復号待ち 1.5 秒
    （10/13 に地形の台帳を `gint:false` にした＝効果は未計測）。purifier の二段格子（密な線＋長い線の同居は遅いまま）。

## 6. 機械ごとの注意

- **`out/` は機械ごと**。家の機械の `out/` が本番より新しいか古いかは `publish:pages`（予行）が教える。
- **wasm の再ビルド**（`bash packages/geopbf/wasm/build.sh`）には wasm-bindgen CLI 0.2.122 と binaryen 132 が要る。
  会社の機械には無く、作業用の場所に入れて PATH で渡した（消える）。変更なしの再ビルドは機械ごとに数 bytes 違う（結果は同じ）。
- **`gh` は会社の機械で未ログイン**＝PR は本人がブラウザで作る。git の push と wrangler は通る。

## 7. 確かめ方（スクリプトは作業用の場所に置いた＝残っていない）

- 読み先：Playwright（`channel: "chrome"`）で本番を開き、応答の URL を `ortho-data/globe/` と `bucket/GIS/` に振り分けて数える。
  同じプロファイルで 2 回開けば、2 回目の通信が目録 1 本になることも見える。
- 置いた物の中身：bucket の現行版とバイト比較（JSON は gzip を解いてから）。
- 遅さの切り分け：CDP の Network で到着時刻 → 主スレッドの CPU プロファイル（idle が大半なら worker の待ち）→
  console の `[geopbf] 📥 <名前> … msec`。
- 公開サイトから localhost の差し替え先を読む時は `--disable-features=LocalNetworkAccessChecks`。
