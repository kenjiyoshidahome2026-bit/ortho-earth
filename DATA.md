# データの置き場の台帳（ortho-data）

デモが読むデータファイルを、bucket（`api.ortho-earth.com`・置くのに X-API-Key が要る）から
GitHub Pages（リポ `ortho-data`）へ移している途中の記録。2026-10-13 に始めた。
決まり・いまの配置・出ている版・**次にやること**をここに 1 本でまとめる（置く手順の細部は `packages/world/README.md`）。

## 1. 決まり（本人裁定 2026-10-13）

- **置き場**：公開リポ `kenjiyoshidahome2026-bit/ortho-data` の `gh-pages` 枝（唯一の枝）。
  配信＝`https://kenjiyoshidahome2026-bit.github.io/ortho-data/<path>`。置くのは git push だけ＝**鍵が要らない**。
- **フォルダは「読むアプリ」でなく「データの範囲」で分ける**。
  - `globe/` … 全世界のデータ。**宇宙（`globe/sky/`）もここ**（japan から読んでいても範囲は全世界）。
  - `japan/` … 日本のデータ（頁の台帳と gishub-jp の地震・アメダス＝2026-10-13 に置いた）。
  - `us/` … アメリカのデータ（国立公園＝同日）。`nl/` は置く物が出来た時に作る（フォルダ名は頁の URL に揃える・本人裁定 10/13）。
- **正本の在り処は範囲で違う**。`globe/`＝`packages/world/out/`（作り直せる生成物・git に入らない）。
  `us/`・`japan/`＝リポの根の `ortho-data/<範囲>/`（**git で追う**＝配信先と同じ形。台帳は Wikidata などから組むので
  作り直しても同じ物にならない＝機械ごとに違わせない）。各アプリの `public/` には置かない＝出荷物に入らない。
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
npm run publish:pages -w world-data -- --scope=us       # us/・japan/＝リポの根の ortho-data/<範囲>/ を丸ごと（同じく予行→ --write）
npm run publish:pages -w world-data -- --scope=japan --write
```

- `us/`・`japan/` の読み手＝本番は Pages、**dev は手元の正本**（`/@fs`）＝置く前に見られる。各 `vite.config.js` の define
  （`__DATA_US__`・`__DATA_JAPAN__`）が `packages/globe/scripts/lib/vite-app.mjs` の `orthoData()` から値をもらう。
  台帳を組むスクリプト（`scripts/*-ledger`・gishub-jp の `*-to-geopbf.mjs`）は `ortho-data/<範囲>/` へ直に書く。

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
| 世界の人口（Kontur Population・H3 の r4 と r6・計 7.6MB）`h3/kontur-20231101/` | `globe/h3/`（10/14 に置いた・焼く＝`apps/ortho-globe/scripts/kontur-h3.mjs`→`--only=h3`） | /globe/hex |
| アメリカの国立公園：`parks-us.json`・`parks-us.geopbf`・`nps-units.geopbf` | `us/` | /globe/parks |
| 日本の頁の台帳：`parks.*`・`terrain.*`・`terrain.i18n/`・`onsen.json`・`models.json` | `japan/` | /japan/parks・terrain・onsen・models（uploader も `models.json` を直読み） |
| 横浜市デジタルツインの台帳：`yokohama/`（`wards`・`rail`・`bus`・`facilities`・`photos`＝.json・2026-10-21） | `japan/`（git で追う・組む＝`apps/yokohama/scripts/bake-yokohama.mjs`） | /yokohama/。国土数値情報（N03・N02・P11・P05・P29・P27・P28・P17・P18・P04）・写真は Wikimedia Commons（作者と使用許諾を台帳に持つ） |
| 観測点：`jishin/seismic`・`jishin/fault`・`jma/amedas`（.geopbf） | `japan/` | gishub-jp |
| 点群の見本：`pointcloud/atami-08NF2392.copc.laz`（熱海 951 万点・77 MB・JGD2011 平面直角 VIII 系＋標高・COPC＝**gzip しない**＝範囲読みするので生のまま）＋出典の `README.md` | `japan/`（**正本は git に入れない**＝大きすぎる。置く元は作業場所・`--scope=japan --from=<作業場所> --only=pointcloud`・2026-10-15・gh-pages 239ed08＝鉛直付き EPSG:6676+6695 で作り直し） | /japan/pointcloud の見本・t-copcbench（点群の計測・`packages/globe/scripts/copc-bench.mjs`）。VIRTUAL SHIZUOKA（静岡県）CC BY 4.0 |
| 静岡県の点群（VIRTUAL SHIZUOKA・図郭ごとの `.zip` に `.las`・CC BY 4.0／ODbL） | **自前で持たない**＝静岡県の S3（`s3://virtual-shizuoka`・Open Data on AWS・CORS 可・範囲読み可）を頁が直に一覧して読む（2026-10-18） | /japan/pointcloud（apps/ortho-japan/pointcloud.ts）・エンジンの ZIP の口（packages/globe/src/pointcloud-zip.ts） |
| 見本 `showcase/*`（人口密度の 3D・江戸の古地図） | **japan の `public/` に残す**（下の 5） | www のデモ（`?g=showcase/…`・`?iiif=/japan/showcase/…`） |
| エンジンの実行時アセット：`plateau-sets`・`airports`・`plateau-landmarks`・`plateau-exclude` | **japan の `public/` に残す**（npm の SDK に同梱＝`assetBase` の契約） | エンジン |
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

`us/`・`japan/` の切替（10/13 午後）は**まだどのアプリにも出ていない**＝本番の ortho-globe・japan・gishub-jp は今も自分の
`public/` の写し（/globe/parks-us.json・/japan/terrain.json…）を読んでいる。出し直すと読み先が Pages になり、同時に www から
その写しが消える（census2020・nl も japan の `public/` を共有していた＝出し直すと 2MB ほど軽くなる）。
出し直しの前から開いていたタブが、後から読む物（他の NPS ユニット・地形の名前表）で 404 になり得る＝再読み込みで直る。

未 deploy のアプリが読むので、bucket の旧い物（DB・`i18n/`・`GIS/space`・`GIS/pbf` の星）は**消さずに凍結**してある。

同じ日に入れた、データ移行とは別の直し（japan などは次の deploy で入る）：
- geopbf の wasm：線の purifier の格子をデータに合わせる（世界規模の線の焼きが 100 倍以上速い・結果は同じ）。
- エンジン：geojson source の `cacheKey`（焼いた結果を IDB に控える）。`globe.d.ts`・`llms.txt` 更新済。
- 地形の頁：初回 18 秒 → 約 7 秒・2 回目以降 約 1.7 秒。

## 5. 次にやること

1. **出し直す**：ortho-globe（/globe/parks）・japan・gishub-jp＝`us/`・`japan/` の読み先が入る（データは Pages に置いてある＝
   順番はどれからでもよい）。japan は下の 3 と同じ出し直しで済む。
2. **人工衛星のミラーが止まっている**：`/sats/status` が「10/5 に 503 を受けて停止」の札を返し、8 日前の軌道要素を
   配っている。原因を確かめてから `apps/sats-mirror` で `wrangler kv key delete halt`（手順は worker.js の冒頭）。
3. **japan・nl・census2020 を出し直す**：新しい読み先・wasm の直し・`llms.txt` が入る。
4. **`japan/` の残り**：bucket `GIS/pbf/nps_all`（日本の自然公園 10MB・/japan/parks の地種区分）。鍵が要る置き場に
   残っているのはこれ＝移す値打ちがある。
5. **`terrain.geopbf` の川の線**：国土数値情報 W05（河川）は「非商用」（複製物の再配布不可）と 10/13 に一次資料で確認 →
   同日 **OpenStreetMap の川の関係で組み直した**（本人裁定＝別の出所で組み直す・`scripts/terrain-ledger/shapes-osm.mjs`・
   関係の wikidata タグ＝台帳の qid で結ぶ・298 本中 297 本）。川の線は © OpenStreetMap contributors・**ODbL**＝頁の出典と
   ortho-data の README に書いた。W05 で組んだ前の版は `apps/ortho-japan/scripts/terrain-ledger/keep/terrain.w05.geopbf` に
   残してある（本人の指示・見比べと差し戻し用＝配らない）。**本番の japan は出し直すまで www の旧い写し（W05 の川）を読む**。
   未確認＝地震本部と環境省（nps_all）の利用規約の名前（README には出所だけ書いた）。気象庁は公共データ利用規約 1.0。湖（W09）は「商用可」。
   `showcase/` は japan の `public/` に残す（本人裁定 10/13＝www のデモの `?g=showcase/…` は公開済みの URL・移すと切れる）。
6. **地震の archive**：移すなら 1 ファイル置いて読み先 1 行。ただし初回 1 人 23MB＝月 4,300 人ほどで帯域の目安。
   Claude の見立ては「R2 に残す」（wrangler で置ける＝鍵は元々不要）。本人の判断待ち。
7. **uploader → ortho-data の道**：国旗・国の形・音・ne-cities を作り直した時に置く手順。宇宙（星表・星座線・メシエ・月の地名・名前）は済（2026-10-15）＝`npm run sky -w world-data` → `publish:pages -- --only=sky --write`＝uploader の宇宙のボタンは外した。
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
