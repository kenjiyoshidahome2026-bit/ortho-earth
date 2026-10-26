---
name: jp-open-data
description: 日本の公共 GIS データ（国土数値情報・登記所備付地図・筆ポリゴン・e-Stat 小地域・国勢調査・国立公園・地震・アメダス・市区町村のオープンデータ）を、普通の言葉の依頼（「横浜市青葉区の用途地域」「千葉県の土砂災害警戒区域」）から探して、ダウンロード URL・出典・ライセンスを答える。ダウンロードや変換はしない。
---

# 日本の公共データの在りか（URL）を答える

依頼を「データの種類・地域・年・形式」に読み解き、`find.mjs` で目録を引いて URL を答える。
目録は gishub-jp（`apps/gishub-jp`、www.ortho-earth.com/gishub-jp/）が使っている物と同じ＝アプリで開ける物と同じ URL が返る。
**ダウンロード・変換はしない**（Kenji 2026-10-26「URL まで」）。

## 手順

1. **地域をコードにする**：`node .claude/skills/jp-open-data/find.mjs place 横浜市青葉区` → 5 桁の行政区域コード（14117）。
   同名が複数（「府中市」等）なら候補を示して確かめる。都道府県は 2 桁（14）。
2. **どの目録か決める**（下の表）。迷ったら国土数値情報を `nlftp --q 語` で探す。
3. **URL を引く**：`find.mjs <目録> --city 14117` など。`--check` を付けると URL の生死（Range 1 バイト）も見る。
4. **答える**：データ名・年・形式・URL・出典・ライセンス・配布ページ。大きい物はサイズも。
   zip の中の 1 ファイルを指す URL は `…zip#中のファイル名`（gishub-jp と geopbf はこの形で直接読める）。素の zip の URL（`zip`）も添える。

| 依頼の例 | 目録 | 引き方 |
|---|---|---|
| 用途地域・土砂災害・浸水想定・学校・駅・行政区域・道路・河川・土地利用… | 国土数値情報（国交省・133 データセット） | `nlftp --q 浸水` で探す → `nlftp --code A31a-2025 --pref 14` |
| 地番・登記所備付地図（14 条地図）・筆界 | 法務省 | `moj --city 13118` |
| 農地・田畑の筆ポリゴン | 農林水産省 | `maff --city 浦安市`（都心の区はデータ無し） |
| 町丁・字の境界（小地域）| e-Stat 統計 GIS（2020 国勢調査） | `estat --city 14117` |
| 市区町村が自分で出しているデータ（避難所・AED・公園・地番図…） | 市区町村のオープンデータ（G空間情報センター横断検索） | `munic --city 14100 --q 避難` |
| 国立公園・地震観測施設・震源断層・アメダス・国勢調査の集計表 | 決まった URL | `fixed` |

### nlftp の絞り込み
- 既定は**最新年**。`--year 2020` で年を指定。`--fmt geojson|shp`（GeoJSON があれば SHP は出さない）。
- `--pref` で都道府県のファイル（目録に県が無い物は、ファイル名の `_13_`・`_13.geojson` から拾う）。県別が無いデータは全国版を返す。
- `--city` は市区町村別のファイル（`…_14100.geojson`）があれば絞る。政令市の区（14101）は市（14100）のファイルを返す。
- 1 次メッシュ単位のデータ（A31b 等）は県では絞れない（空を返して注記）＝`--mesh 5339` のようにメッシュで絞る。
- 目録は `https://api.ortho-earth.com/bucket/catalog/` から読む（R2）。

## 先に断っておくこと（2026-10-26 の全件点検で分かった物）
- **国土数値情報の SJIS 名 zip**：A09 都市地域・A53 2023 年版・A31a 2020 年版・A49 2022 年版は zip の中のファイル名が Shift_JIS。
  `#ファイル名` の形は geopbf（#691 以降）なら読めるが、ほかの道具で開く時は文字化けに注意と添える。
- **農水**：東京 12 区・千葉市美浜区・浦安・名古屋中・京都中京・大阪 4 区・神戸 2 区は筆ポリゴン無し（`maff/ui.ts` の MAFF_NO_DATA）。
- **市区町村**：配布元が消える事がある（点検時に千葉市・大津市・徳島市の一部が切れ）。答える前に `--check` を勧める。
- **A11 自然保全地域**：山口県分は配布元の zip が空。
- **S10a-2016・S05-d-2018・S05-b-2013**（OD の線）：以前は gishub-jp の変換が止まる・数分かかった（gint の交点探し）。2026-10-26 に直した。
- **e-Stat** は CORS 不可＝ブラウザからは api.ortho-earth.com/proxy 経由。

## 動く場所
- `find.mjs` は Node 22（fetch）だけで動く。`place`・`moj`・`maff`・`estat`・`munic`・`fixed` はリポジトリの目録だけで答える（ネットワーク不要）。
- `nlftp` と `--check` はネットワークが要る。クラウドの Claude Code の環境は *.ortho-earth.com や nlftp.mlit.go.jp に届かない事がある
  （proxy が 403）＝その時は Kenji の Mac（Remote Control）で走らせる。

## 目録の正本（直す時はこちら）
- 国土数値情報：R2 `catalog/index.json`・`catalog/<code>.json`（`apps/gishub-jp/scripts/make-catalog-json.js`・`nlftp-bump.mjs`）
- 法務省：`apps/gishub-jp/moj/{manifest,geojson,pbf-manifest}.json`
- 農水：`apps/gishub-jp/maff/manifest.json`（bucket `GIS/pbf/maff_<6 桁>.geopbf`）
- e-Stat：`apps/gishub-jp/estat/manifest.json`（調査 ID は `estat/ui.ts` の ESTAT_SURVEY）
- 市区町村：`apps/gishub-jp/munic/pref/<県>.json`
- 国勢調査の集計表：`packages/jp/shared-data/manifest.json`
- 地名→コード：`apps/gishub-jp/scripts/admin-boundary.csv`
