# 国別データベース（world）v2

世界の国・地域 262 件の基礎データ（首都・ISO/IOC・国連加盟・面積・人口・経済統計・言語・通貨・国歌・国旗・係争地）と地形約 900 件（大陸・海洋・海・湾・海峡・島・半島・岬・山脈・山・高原・平原・盆地・砂漠・デルタ・湖・川・海溝・海嶺など 31 分類）、
それらの 26 言語の名前テーブル。ビューアは `apps/world`（http://localhost:5174/world/）、配信は bucket `GIS/world/`。

**設計（2026-09-11・v2）**: 英語と ID を基軸にする。国は `key`（ISO 3166-1 alpha-2、非 ISO 主体は Natural Earth 系の B コード、クリッパートンは FR-CP）と
Wikidata の QID、都市は QID、言語は ISO 639、通貨は ISO 4217。日本語名での名寄せ・ja.wikipedia のスクレイピングは廃止した（v1 の経緯は `legacy/README-v1.md`）。

## 構成

```
seed/            正本（人が手で持つ・PR の対象）
  nations.csv      key, qid, name_en, official_en（"Republic of _" 型）, region(1..6), territory(key), conflict(key), capital(都市 QID・空なら Wikidata P36)
  cities.csv       qid, nation(key・複数は |), capital(1)          … 首都は build が自動で加える
  terrains.csv     **生成物**（scripts/terrains-from-ne.py が書く・手で編集しない）。qid, category, name_en(enwiki 記事名), ne_extra, axis, rank(NE scalerank), lon, lat(NE の代表点)
  terrains-manual.json 地形の手動層（人が持つ）: add（閾値外でも入れる・QID 基軸）/ drop（QID・NE 名・記事名）/ category（分類の上書き）/ merge（形状を結合する NE 側の QID か "~NE 名"）/ axis（山脈の手書き軸線）/ alias（NE の壊れた wikidataid → 正規 QID）/ allow_nation / add_ne
  conflicts.json   係争地（key・qid・type・region・name_en・exist・sovereignt・territory・claim）
  overrides.json   例外＝key → { 項目: 値, _why: {項目: 理由} }（最優先。無人地の人口・本土面積・非 ISO 主体の通貨・実効支配域…）
  capital-notes.json 首都の注記（defacto / changed=[年, 都市QID] / multi={legislative,judicial,executive} / text=国key か翻訳キー）
  aliases.json     Wikidata にコードが無い項目のキー（Greek → el）
  ja.json          日本語固有: 国の official（"_国" 型）と読み・都市の読みと名前の上書き
i18n/ui.json      UI 文言（英語キー → 25 言語）と言語一覧（langs.json）
build/            組み立て（Node CLI と uploader で共用・依存なし）
  index.js         buildAll(seed, env) → { NationDB, CityDB, TerrainDB, LanguageDB, CurrencyDB, Conflicts, i18n, rivers, ranges, report }
  geom.js          山脈ポリゴン → 2〜4 点の軸線（内部を格子標本化 → 主成分軸 → 軸に沿った窓の重心。幅＝垂直方向の p10〜p90 の中央値 km）
  wikidata.js      wbgetentities（50 件束）と「現在の値」の取り出し（preferred > 終了日なし normal・P518/P1001＝部分適用の除外）
  stats.js         World Bank（主）/ IMF WEO（穴埋め）/ UNDP HDR / GPI と国連加盟日（en.wikipedia の表）＝すべて ISO3・QID で結合
  validate.js      保存前の機械検札（キー重複・参照切れ・首都の収蔵・キー未収蔵…）errors があれば保存しない
  i18n.js          言語別テーブル（英語以外）
  env.js / seed.js / csv.js   実行環境の差の吸収・seed 読み・CSV
  cli.js           node build/cli.js [--fresh] [--out DIR] → out/
scripts/          terrains-from-ne.py＝地形 seed の生成器（Natural Earth 10m v5.1.2 を .cache/ne/ に取得・Wikidata で記事の有無を確認）
legacy/           README-v1.md＝v1 の経緯と移植台帳のみ。原典と v1 seed（create*.js・geometryISO.js・draw.js・国名一覧.csv・国旗.zip…）は削除済み＝git 履歴 e544907 に残る（2026-09-11）
```

## 組み立てと公開

- ローカル: `npm run build -w world-data`（`packages/world/out/` へ。取得結果は `.cache/` に残る＝`--fresh` で捨てる）
- uploader（DB Updater の「国別DB (world)」節）の **「全部作る」**: 同じ build をブラウザで回して bucket `GIS/world/` に保存（取得キャッシュは IDB `worldBuild`）。
  HDR の CSV だけ CORS が無いので api.ortho-earth.com の proxy 経由（allowlist に hdr.undp.org）。
- 旗（flags.zip → flags/<key>.svg）・音源（音源.zip）・地形 PNG（geoPNG 作成 → geoms/<key>.png）は資産として別に置く。
- ビューアは起動時に IDB の写しで即描画し、裏で一覧（ETag）を突合して変わったファイルだけ取り直す（`apps/world/src/data.js`）。

## 出力の形（要点）

| DB | キー | 主な項目 |
|---|---|---|
| NationDB | key | qid, name.en, official, region, iso[2,3,num], ioc, un(加盟日), capital(都市 QID), territory/conflict(key), sovereignt/claim(係争地 key), coord, area, population/gni/gnipc/gdp/gdppc/ppp/ppppc/hdi/homicide(=[最新年, 値…]), gpi(=[年, 値]), languages(ISO 639), currency(ISO 4217), anthem(URL), flag(Commons ファイル名), wiki.en(記事名), capitalNote, `_src`(項目ごとの出所) |
| CityDB | qid | name.en, nation[key], capital, coords[lon,lat,標高], population[年,値], wiki.en |
| TerrainDB | qid | category(31 分類), rank(NE scalerank・手動追加は無し), name.en, coord[lon,lat], area(km²), elevation(m), length(km), wiki.en |
| range.geojson | qid | 山脈の軸線＝FeatureCollection（properties: qid, name, width(km), length(km), source=ne/seed / LineString 2〜4 点・小数 3 桁）。表示側で spline を通し width でポリゴン化する前提（Kenji 2026-09-11）|
| rivers.geojson | qid | 川の形状＝FeatureCollection（properties: qid, name, scalerank / MultiLineString・小数 4 桁）。Natural Earth 10m rivers_lake_centerlines_scale_rank v5.1.2 を wikidataid で結合 |
| LanguageDB / CurrencyDB | ISO 639 / 4217 | qid, name.en, wiki.en |
| Conflicts | key | qid, type, region, name.en, exist, sovereignt, territory, claim, wiki.en |
| i18n/<lang>.json | — | nations/cities/terrains/languages/currencies/conflicts の { name, wiki[, official, yomi] } と ui。英語は DB 側が基軸＝テーブル無し |

## 判断の記録

- **西サハラ**: ISO 準拠で key=EH（地理的実体）。領域は B19（モロッコ実効支配）+B28（自由地帯）。SADR は B28。主張は EH に帰属させない（2026-08-31）。
- **GPI/PSI**: IEP のスコアは非商用ライセンスのみ → GPI は英語版 Wikipedia の順位表（1 年分）、PSI は廃止して World Bank の殺人率（2026-09-10）。
- **Wikidata の値の選び方**: preferred rank > 終了日（P582）の無い normal。公用語・面積は「部分に適用」（P518/P1001）の claim を除き、無ければ全体から。
  首都が複数のとき（BO/SZ/YE…）は seed の capital 列で明示。国連加盟日は Wikidata の P463 が継承国で揺れるので en.wikipedia の表から。
- **言語キー**: ISO 639-1 > 639-3。同じコードを持つ複数項目（Greek / Modern Greek）は同じキーに寄せる。海外領土で言語・通貨が空なら領有国から継承（`_src`=territory）。
- **効果音**: OtoLogic 9 本（CC BY 4.0・クレジットはビューアの地球アイコン）。出所不明の 2 本は撤去（2026-09-10）。
- ライセンス: データ CC BY-SA 4.0・スクリプト MIT（`LICENSE`）。出所一覧は `SOURCES.md`。

## 地形（地図用）

**基準＝「世界の優秀な高校生が知っている地形」（Kenji 2026-09-11）。** 手作業の名前リストではなく Natural Earth 10m（v5.1.2 固定）の scalerank（地図帳での目立ち度）で機械的に選び、NE の wikidataid で Wikidata に結ぶ。
英語版 Wikipedia の記事が無いものと位置が特定できないものは入れない（Wikidata P625 → 無ければ NE の代表点）。国そのもの（Japan・Cuba…）は NationDB 側＝島は島の項目で入る（グリーンランドだけ国と同じ QID を許す）。

- 生成: `python3 scripts/terrains-from-ne.py [--review]` → `seed/terrains.csv`（--review で分類別の全名を出す）。NE は `.cache/ne/` に落として再利用
- 閾値（NE featurecla → 分類・scalerank 上限）: Range/mtn 4・Plateau 4・Desert 4・Pen/cape 4・Island 4・Island group 3・Geoarea 2・Plain/Lowland 3・Delta/Basin/Valley/Isthmus/Wetlands ほぼ全部・海域＝sea 5／gulf・bay 4／strait 5・湖 3・山（elevation points）3・岬 3・川＝QID ごとの最小 scalerank 4（5 は手動層で名指し）。南極は主要なもの以外除外
- 手動層 `seed/terrains-manual.json`: 閾値外の追加（8000m 峰・各国の象徴的な山・有名湖・海溝/海嶺・海峡・運河・氷床など）、僻地の除外、分類の上書き、形状の結合、手書き軸線、NE の壊れた QID の読み替え
- 途中で名前が変わる川は有名な名前の項目に上流区間を merge で結合して全長を取る（ナイル←白ナイル・カゲラ、長江←金沙江・通天河・沱沱河、ライン←ワール/レク/ネーデルライン/エイセル、西江←南盤江/紅水河/黔江/潯江 など）。結合先は単独では収蔵しない
- 形状: 川＝`rivers.geojson`（NE の線分を wikidataid で束ねた MultiLineString・小数 4 桁）、山脈＝`range.geojson`（NE ポリゴンから geom.js で 2〜4 点の軸線＋幅・表示側で spline＋ポリゴン化）。NE に無い川（信濃川・パラグアイ川など）は形状なし＝warn
- 分類（31）: continent ocean region shield sea bay strait reef island islands peninsula cape isthmus range peak pass plateau plain basin valley desert delta wetland ice lake river waterfall canal trench ridge pole
