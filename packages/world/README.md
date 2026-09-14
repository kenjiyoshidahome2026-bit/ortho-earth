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
  terrains.csv     **生成物**（scripts/terrains-from-ne.mjs が書く・手で編集しない）。qid, category, name_en(enwiki 記事名), ne_extra, axis, rank(NE scalerank), lon, lat(NE の代表点)
  terrains-manual.json 地形の手動層（人が持つ）: add（閾値外でも入れる・QID 基軸）/ drop（QID・NE 名・記事名）/ category（分類の上書き）/ merge（形状を結合する NE 側の QID か "~NE 名"）/ axis（山脈の手書き軸線）/ alias（NE の壊れた wikidataid → 正規 QID）/ allow_nation / add_ne
  conflicts.csv    係争地（key, qid, type, region, name_en, exist(true/false), sovereignt(key), territory(key), claim(key・複数は |)）
  overrides.json   例外＝key → { 項目: 値, _why: {項目: 理由} }（最優先。無人地の人口・本土面積・非 ISO 主体の通貨・実効支配域…）
  capital-notes.json 首都の注記（defacto / changed=[年, 都市QID] / multi={legislative,judicial,executive} / text=国key か翻訳キー）
  aliases.json     Wikidata にコードが無い項目のキー（Greek → el）
  ja.json          日本語固有: 国の official（"_国" 型）と読み・都市の読みと名前の上書き・terrains＝Wikidata に日本語ラベルの無い地形の名前（22 件・2026-09-15）
i18n/ui.json      UI 文言（英語キー → 25 言語）と言語一覧（langs.json）。categories（地形 35 分類）と plateBoundaries（PB2002 の 7 種別）は Wikidata のクラス項目のラベル＝scripts/i18n-classes.mjs が埋める（2026-09-15）
build/            組み立て（Node CLI と uploader で共用・依存なし）
  index.js         buildAll(seed, env) → { NationDB, CityDB, TerrainDB, LanguageDB, CurrencyDB, Conflicts, i18n, rivers, ranges, report }
  geom.js          山脈ポリゴン → 軸線（内部を格子標本化 → 格子グラフの測地距離で最遠の 2 端 → 一端からの距離の等値帯ごとの重心＝弧や鉤に追従・約 120 km 間隔・3〜40 点。幅＝帯ごとの直交方向 p10〜p90 の中央値 km）
  wikidata.js      wbgetentities（50 件束）と「現在の値」の取り出し（preferred > 終了日なし normal・P518/P1001＝部分適用の除外）
  stats.js         World Bank（主）/ IMF WEO（穴埋め）/ UNDP HDR / GPI と国連加盟日（en.wikipedia の表）＝すべて ISO3・QID で結合
  validate.js      保存前の機械検札（キー重複・参照切れ・首都の収蔵・キー未収蔵…）errors があれば保存しない
  i18n.js          言語別テーブル（英語以外）
  env.js / seed.js / csv.js   実行環境の差の吸収・seed 読み・CSV
  cli.js           node build/cli.js [--fresh] [--out DIR] → out/
scripts/          terrains-from-ne.mjs＝地形 seed の生成器（Natural Earth 10m v5.1.2 を .cache/ne/ に取得・Wikidata で記事の有無を確認・Python 版から 2026-09-15 移植＝出力バイト一致）
                  i18n-classes.mjs＝分類名・境界種別・気候区分の多言語名を Wikidata のクラスから ui.json と .cache へ（npm run i18n:classes）
                  ne-cultural.mjs＝Natural Earth Cultural＝鉄道・道路・市街地・湖・人口密集地・admin1 を key ごとに切り分ける（→ out/ne-cultural.geopbf・--split で国別ファイル）
                  ne-physical.mjs＝Natural Earth Physical＝地形の形状台帳（→ out/ne-physical.geopbf＋ne-physical-lines.geopbf・NE の面/線/点＋Wikidata 位置＋山脈軸線・地理線）
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
| TerrainDB | qid | category(35 分類), rank(NE scalerank・手動追加は無し), name.en, coord[lon,lat], area(km²), elevation(m), length(km), wiki.en |
| range.geojson | qid | 山脈の軸線＝FeatureCollection（properties: qid, name, width(km), length(km), source=ne/seed / LineString 3〜40 点（約 120 km 間隔）・小数 3 桁）。表示側で spline を通し width でポリゴン化する前提（Kenji 2026-09-11）|
| rivers.geojson | qid | 川の形状＝FeatureCollection（properties: qid, name, scalerank / MultiLineString・小数 4 桁）。Natural Earth 10m rivers_lake_centerlines_scale_rank v5.1.2 を wikidataid で結合 |
| LanguageDB / CurrencyDB | ISO 639 / 4217 | qid, name.en, wiki.en |
| Conflicts | key | qid, type, region, name.en, exist, sovereignt, territory, claim, wiki.en |
| i18n/<lang>.json | — | nations/cities/terrains/languages/currencies/conflicts の { name, wiki[, official, yomi] } と ui。英語は DB 側が基軸＝テーブル無し |

## Natural Earth Cultural＝国別切り分け（out/ne-cultural.geopbf）

`node scripts/ne-cultural.mjs`（`npm run ne:cultural -w world-data`）で、Natural Earth 10m v5.1.2 の 6 層を key ごとに切り分け、**全部を平らに 1 層にした `out/ne-cultural.geopbf`**（gzip・precision 6・属性 `key` / `layer`・混在ジオメトリ）に書く。
`out/ne-cultural.json` に key ごとの地物数・頂点数、出力できなかった key（`missingKeys`＝geoms と同じ辿り方の `fallback`。AFX なら [AF]）、処理の要約。
`--split` を付けると等価な内容を `out/ne-cultural/<key>/<layer>.geopbf` にも分割して書く（`--only JP,FR` で一部だけ・`--geojson` で GeoJSON も併記）。

| layer | 中身 | 形 |
|---|---|---|
| railroads / roads | ne_10m_railroads / ne_10m_roads を領域の境界で切ったもの | **属性なし・key ごとに 1 地物**（MultiLineString。1 本なら LineString で戻る） |
| urban_areas | ne_10m_urban_areas（境界を跨ぐ面だけ polygon-clipping で交差） | 属性なし・key ごとに 1 地物（MultiPolygon） |
| lakes | ne_10m_lakes（同上。五大湖などは国境で分かれる） | 属性なし・key ごとに 1 地物（MultiPolygon） |
| populated_places | ne_10m_populated_places（点・内外判定。沿岸で外れた点は最寄りの領域へ＝`ne_clip:"nearest"`）。小属領 23 件は NE に点が無い＝CityDB で補う | 属性そのまま＋`key` |
| admin_1 | ne_10m_admin_1_states_provinces を属性で束ねたもの | 属性そのまま＋`key` |
| admin_0 | 重ね切り主体（B20 など 10 件）だけ: 切り抜きに使った ne_10m_admin_0_disputed_areas のポリゴン＝領域の輪郭 | 属性そのまま＋`key` |
| routes | 航路＝フェリー（featurecla か type が Ferry・丸ごと）と、それ以外の線が領域の外を通る区間（`ne_clip`＝ferry / sea / sea-whole）。国のデータには入れない | 属性そのまま＋`source`（roads / railroads）・`key` なし |

領域の定義は `createGeometryPNG`（geoms/<key>.png）と同じ: admin1 を fixISO（iso_a2＋名前の割替え＋FR/NL の海外県）で key に束ねたものが主（互いに重ならない）。
admin1 に形の無い係争主体（B20 北キプロス・B28 SADR・B30 ソマリランド・B35/B37・B36・B38・B89 クリミア・C02/C03）は disputed_areas の BRK_A3 で独立に切り出す＝主の分割と**重複する**（world の geo_tub と同じ）。
B45 シアチェン・B46 南沙は nations.csv に無いので落とす。AFX は形が無いので出力しない。
1 km 未満の短い海上の外れは海岸線の丸めとみなして隣の key に繋ぐ。当面はローカル（out/）に置く＝bucket には上げない（Kenji 2026-09-14/15）。

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

- 生成: `node scripts/terrains-from-ne.mjs [--review]`（`npm run terrains -w world-data`）→ `seed/terrains.csv`（--review で分類別の全名を出す）。NE は `.cache/ne/` に落として再利用
- 閾値（NE featurecla → 分類・scalerank 上限）: Range/mtn 4・Plateau 4・Desert 4・Pen/cape 4・Island 4・Island group 3・Geoarea 2・Plain/Lowland 3・Delta/Basin/Valley/Isthmus/Wetlands ほぼ全部・海域＝sea 5／gulf・bay 4／strait 5・湖 3・山（elevation points）3・岬 3・塩原（playas）1・川＝QID ごとの最小 scalerank 4（5 は手動層で名指し）。南極は主要なもの以外除外
- 手動層 `seed/terrains-manual.json`: 閾値外の追加（8000m 峰・各国の象徴的な山・有名湖・海溝/海嶺・海峡・運河・氷床・2026-09-15 の穴埋め＝峠 12・滝 14・礁 7・氷河/氷帽/棚氷 23・塩原 6）、僻地の除外、分類の上書き、形状の結合、手書き軸線、NE の壊れた QID の読み替え（alias）、位置条件付きの読み替え（alias_geo＝米国コロラド川）、NE の形を使わない QID（noshape＝形状台帳では Wikidata の位置の点だけ。Cordillera Blanca は NE の同名ポリゴンが北部アンデス西縁全体を覆う誤り・2026-09-15）
- 途中で名前が変わる川は有名な名前の項目に上流区間を merge で結合して全長を取る（ナイル←白ナイル・カゲラ、長江←金沙江・通天河・沱沱河、ライン←ワール/レク/ネーデルライン/エイセル、西江←南盤江/紅水河/黔江/潯江 など）。結合先は単独では収蔵しない
- 形状: 川＝`rivers.geojson`（NE の線分を wikidataid で束ねた MultiLineString・小数 4 桁）、山脈＝`range.geojson`（NE ポリゴンから geom.js で軸線＋幅。9/15 から格子の測地距離の等値帯で中央を辿る方式＝約 120 km 間隔・3〜40 点・弧や鉤に追従。表示側で spline＋ポリゴン化）。NE に無い川（信濃川・パラグアイ川など）は形状なし＝warn
- **形状台帳 `out/ne-physical.geopbf`**（NE Physical・`node scripts/ne-physical.mjs`・`npm run ne:physical -w world-data`・2026-09-15）: 912 件全部に形を結んだ 1 本の GeoPBF（混在ジオメトリ・precision 5・1.3 MB）。
  結び方＝wikidataid（alias で正規化）＋ne_extra で NE 6 データセット（regions/marine/lakes の面・rivers の線・elevation/points の点）を引く。川・運河は線 > 面（河口の marine 面より線）、他は面 > 線 > 点。
  NE に形が無いもの（と noshape）→seed の lon/lat（NE 代表点）→Wikidata P625（`.cache/wikidata-p625.json`）の点。山脈は NE 面に加えて軸線（手書き > 自動）を `shape=axis` の別地物で持つ。手書き軸線（ペナイン・コルドバ）は Catmull-Rom で約 120 km 間隔に再標本化して自動軸線と密度を揃える。アペニンは NE の APPENNINI ポリゴン（wikidataid は Appennino Ligure）を merge で束ねて自動軸線に（9/15）。
  属性: qid / category / name / rank / shape（polygon・line・point・axis）/ source（ne・ne-eu/na/au・ne-point・wikidata・seed）/ scalerank / width・length（axis）。要約は `out/ne-physical.json`（分類×形×出所の表）。
  川の形（③ 2026-09-15）: 本体 rivers_lake_centerlines_scale_rank を既定に、地域別補完（rivers_europe / north_america / australia）は本体に無いか本体の 1.3 倍より長い時だけ差し替え（Cooper Creek・Murrumbidgee）。米国コロラド川は NE が本流にアルゼンチンの QID を付けているので alias_geo（北半球の Q270627 → Q1265）で直す。ヴォルタ←黒ヴォルタを merge。
  海流（current・26 本・2026-09-15）: 教科書の模式図の水準で seed の axis に手書き（向き＝流れ・"|" で複数の線・Catmull-Rom で約 250 km 間隔に再標本化・経度は unwrap して日付変更線越えを扱う）。flow（warm/cold）は手動層の flow。Wikidata の海流項目に結ぶ＝多言語名は TerrainDB 側。
  絵として収録（picture）: 英語記事が無い項目（対馬海流）は `seed/terrains-pictures.csv` に出て台帳にだけ載る（wiki:false・TerrainDB には入れない）。NE に線が無い川（信濃川・パラグアイ川・フーグリ川・イグアス川）は axis の手書き線（source=seed）。
  火山（volcano・27 件）: 手動層で追加。既に peak にある山（富士・ベスビオ・エトナ・クラカタウ…22 件）は peak のまま、台帳が Wikidata P31（volcano の下位クラス 41 種＝`.cache/wikidata-volcano-classes.json`）で `volcano:true` を付ける（46 地物）。
  プレート（plate・主要 16 枚）: 面は PB2002（Bird 2003）の "~PB2002:記号" を merge で結ぶ。位置＝面の頂点平均。全 52 枚と境界線（種別 OSR/OTF/OCB/CRB/CTF/CCB/SUB）は `scripts/plates.mjs` → `out/plates.geopbf`。
  気候（`scripts/koppen.mjs` → `out/climate-koppen.geopbf`）: Beck et al. 2023（CC BY 4.0）の 1991–2020・0.1° ラスタを区分ごとの面に（30 区分＝1 地物ずつ・属性 id/code/group/name/color・塗りは group）。境界セル辺を環に繋ぐ方式＝隣接区分と辺を共有（面積検算でセル数と完全一致）。TIFF は geopbf の COG 読み口で読む。
  地理線 `out/ne-physical-lines.geopbf`（⑤ 2026-09-15）: 赤道・回帰線・極圏は黄道傾斜角 ε（IAU 2006・2026 年評価）から計算（NE v5.1.2 は北回帰線 23.50°/南 −23.56° と不揃い）、日付変更線は NE。属性 name / kind / lat / epoch / wikidataid。
  NE に線が無い川＝Hooghly・Iguazu・Paraguay・Shinano は Wikidata の点のまま（NE 10m の範囲外＝他の出所が要る）。NE が短い川（Han 50 km・St. Lawrence 106 km・Huai・Liao・Tarim…）は NE の描き方の限界としてそのまま
  内訳（9/15）: 面 570・線 151・点 191（うち Wikidata 位置のみ 116）・軸線 85。rivers.geojson / range.geojson はこの台帳に吸収できる（build 側の撤去はビューアが台帳を読むようになってから）
- 分類（35）: continent plate ocean current region shield sea bay strait reef island islands peninsula cape isthmus range peak volcano pass plateau plain basin valley desert saltflat delta wetland ice lake river waterfall canal trench ridge pole
