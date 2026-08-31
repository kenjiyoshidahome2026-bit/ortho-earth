# 国別DB（world）移植台帳

旧システム（bucket プロジェクト `b1qEpPlw`）の国別データベース作成ツールを ortho-earth へ移植する記録。
このディレクトリの [create.js](create.js) は**旧システムの原典**（`#inline` スニペット参照付き・そのままでは動かない）＝読み取り専用の設計図。

## 新しい住まい

| もの | 場所 |
|---|---|
| 作成ツール UI（ボタン・ドロップ投入） | `apps/uploader/src/world/index.js`（DB Updater の「国別DB (world)」節） |
| 置き場・共有ロジック（renames / wiki 連携 / Conflicts） | `apps/uploader/src/world/db.js` |
| wiki API（旧 d3.wiki） | `packages/common/src/wiki.js`（移植済み・export 済み） |
| データの置き場 | bucket `GIS/world/`（NationDB.json / 国旗.zip / …） |

## 旧 API → 新 API 対応

| 旧 | 新 |
|---|---|
| `bucket.loadObject(name, {project})` | `Bucket("GIS/world")` → `get(name + ".json", "json")` |
| `bucket.saveObject(name, a)` | `put(new File([JSON.stringify(a)], name + ".json"))` |
| `bucket.loadFiles / saveFiles`（zip 束） | `gets(name)` / `puts(name + ".zip", files)` |
| `bucket.blob2csv` | `d3.csvParseRows`（配列行）/ `d3.csvParse`(ヘッダ行) — 旧挙動の検証待ち |
| `bucket.readZIP` | `decodeZIP`（native-bucket 再輸出） |
| `bucket.download` | `download`（common） |
| `d3.wiki.*` | `wiki.*`（common/wiki.js） |
| `d3.thenEach / thenMap` | `thenEach / thenMap`（common） |

## 旧システムから取り出すもの（Kenji の作業）

### ① スニペット原典 → このディレクトリへ `.js` で置く（→ Claude が移植）

| #inline ID | 内容 | 状態 |
|---|---|---|
| `UEVbTZC1` | wiki API（d3.wiki） | ✅ 済み＝common/wiki.js |
| `qjpQx44Y` | createNationDB | ✅ 済み＝uploader/src/world/createNationDB.js（原典 createNationalDB.js） |
| `RVkHIUhP` | createCityDB | ✅ 済み＝uploader/src/world/createCityDB.js |
| `r14WZUyG` | createLanguageDB / createCurrencyDB | ✅ 済み＝uploader/src/world/createLanguageDB.js |
| `7SzWe6GP` | geometryISO（createGeometryPNG） | ✅ 済み＝uploader/src/world/createGeometryPNG.js（**現代化**＝下記） |
| — | FlagSVG クラス（svg の clean） | 実質不要＝手元の 国旗.zip は clean 済みと実測（2026-08-31・下記）。新規 svg 差し込み時に必要になったら現代版を書く |
| `H3hXwiKH` | setupWhiteEarth / setupMapGeometories | 不要＝旧ビューア用（ortho-earth は自前エンジン） |

**国旗.zip の実測**（2026-08-31・このディレクトリに収蔵＝266旗/1.38MB）: 全 svg が clean 済み＝
XML宣言/DOCTYPE/コメント/metadata なし・全266に viewBox・width/height なし（CSSで自由に伸縮）。
残渣は2点のみ＝①ハイチ.svg に `-inkscape-font-specification` のstyle文字列（紋章のモットー文字用・無害）
②ジャージー.svg のファイル名が NFD（ジ=シ+濁点）→ uploader の zip 取り込みで NFC に正規化して収蔵（対処済み）。
NATO.svg 等の国以外の旗も収録（旧ガジェットの流儀のまま保持）。

**geometryISO.js の扱い**（Kenji 裁定=改良歓迎 2026-08-31）: 1022行の幾何ツール群のうち移植したのは
createGeometryPNG + upload_admin の iso 割替え表のみ。理由＝
- antimeridian 切断 → common/antimeridianCut.js に既存
- mergeFeatures（polygonClipping）→ 不要化＝FeatureCollection のまま d3.geoCentroid/fitExtent に食わせる
  （回転後に投影＝antimeridian 跨ぎ国も bbox 細工なし）
- staticOrthoMap → OffscreenCanvas + d3.geoPath（clipAngle=90 が裏面を自動で落とす）
- 背景世界図は焼き済み ne_50m_admin_0_countries（256px に 10m は過剰）・対象国は NE 10m admin1 + disputed(B**)

### ② データ書き出し → uploader ページへドロップ（ファイル名で自動振り分け）

| 旧オブジェクト | 書き出しファイル名 | 保存先 |
|---|---|---|
| NationDB | `NationDB.json` | GIS/world/NationDB.json |
| CityDB | `CityDB.json`（または `CityDB.csv`＝downloadCityDB の逆変換・2026-08-31 取り込み対応） | 〃 |
| LanguageDB | `LanguageDB.json` | 〃 |
| CurrencyDB | `CurrencyDB.json` | 〃 |
| Conflicts | `Conflicts.json`（または `Conflicts.csv`＝再作成） | 〃 |
| 国名一覧 | `国名一覧.json`（または `.csv`） | 〃 |
| 国旗（svg 束） | `国旗.zip` | GIS/world/国旗.zip |
| 音源（mp3 束） | `音源.zip` | 〃 |
| geoms（png 束） | `geoms.zip` | 〃 |

ドロップ後は「一覧 (GIS/world)」ボタンで収蔵を検札。console からも旧ツール同様に
`loadNationDB()` / `saveNationDB(a)` / `createWiki(db, lang)` … が叩ける（window へ束ねて公開済み）。

## ビルドの正しい順序（依存があるので順番厳守）

1. `国名一覧.csv`（seed）と `Conflicts.json`（or `Conflicts.csv`）をドロップ ← **Conflicts が createNationDB の前提**
2. （年次更新なら）「wikiキャッシュ掃除」ボタン ← 押さないと前回取得の値が返り続ける
3. createNationDB → createLanguageDB → createCurrencyDB → createCityDB → createGeometryPNG

## 2026-08-31 の冪等化・整理（旧実装からの変更点）

- **保存形式は版スタンプ包み** `{ updated, count, items }`。読みは素の配列（旧書き出し）も両対応
- **NationDB のパッチ（例外5地域除去+クリッパートン追補）は load 側→ビルド側へ移動**（`finalizeNationDB`・冪等）。
  旧実装は createCurrencyDB の save 戻しでクリッパートンが増殖し、例外地域が保存から消えていた
- **年ガードを動的化**（旧: 2025 固定＝2026 年から今年の人口を全部弾くバグ）
- **統計を一次ソース API へ移行（2026-08-31）**: population/gni/gnipc=World Bank API（CORS開放＝ブラウザ直・ISO3結合）、
  gdp/gdppc/ppp/ppppc=IMF DataMapper API（予測年込み・proxy経由）。約140ページのスクレイピング→5リクエスト、
  統計の日本語名寄せが消滅。GPI/PSI のみ sekai-hub 継続（IEP に API なし・起点年自動プローブ・404 はキャッシュしない）
- wiki 表の隠しソートキー（display:none の読み仮名）は unhide() で除去してから読む（「カンコク 韓国」型の突合失敗の根治）
- CityDB の人口欠測 sentinel を `[-1, 0]` に統一（旧 `[0,0]`）・yomi 5文字規則にクリッパートンも準拠
- 首都なし国の TypeError 地雷・fixLanguage の対象消失即死・wiki.en 欠落都市の座標クラッシュ→ warn 縮退
- 作成系ボタンは実行中の console.warn を収集して終了時に一覧表示（検札の見落とし対策）

## キー台帳（2026-08-31 明確化・正本は uploader/src/world/db.js）

消費側 draw.js の分析で結合キーが3系統に散っていたため（draw.js の isox / setConflicts / fixISO）、
db.js の `NATION_KEYS` を唯一の正本にし、ビルド時に焼き込む。命名は全DB共通の `key`
（旧 seed の key 列＝無ければ英語名、と消費側の isox を統合＝Kenji 裁定。seed 8列目は読み飛ばし）。

| 対象 | 正キー | 備考 |
|---|---|---|
| 国 | `key` | ISO 3166-1 alpha-2。無い国は台帳（B\*\*・AFX/EHX・FR-CP)。**NationDB に焼き込み済みフィールド** |
| 都市 | `wiki.ja`（ja版 pageid） | 消費側の既存流儀を追認 |
| 通貨 | ISO 4217 | `NationDB.currency` は**キー配列**に正規化（旧: 単一 or "USD\|PAB" の二形） |
| 言語 | `LANG_KEYS` のキー（ISO 639 風） | `NationDB.languages` は**キー配列**に正規化（旧: 日本語名＝LanguageDB.key が未使用だった） |
| 紛争 | Conflicts の `key`（B\*\*） | NE disputed BRK_A3 系。列順: `key, type, region, title_en, name_en, title_ja, exist, iso, sovereignt, claim` |
| 内部参照 | `name.ja` | territory/conflict/旗/geoPNG/音源ファイル名＝renames の影響を受けない閉じた名前空間 |

- 外部ソースとの突合（UN/ISO/IOC/sekai-hub/HDI）だけが renames 表を通る＝ここが唯一の名寄せ点

### 西サハラの整理（ISO 準拠・主張しない＝Kenji 裁定 2026-08-31）

方針: **紛争地は政治的主張を避け、なるだけ ISO に従う**。ISO 3166-1 の EH は「地理的実体・西サハラ」であり、
どの政体に属するかを言っていない＝そこにそのまま乗る。

| | key | 正体 | 実効支配 | 主張 |
|---|---|---|---|---|
| 西サハラ | **EH**（ISO のまま） | 地理的実体・UN 非自治地域 | —（領域＝B19+B28 の全体） | しない |
| サハラ・アラブ民主共和国 | **B28** | 未承認国家（北キプロス B20 と同型） | B28（自由地帯） | B19 |
| モロッコ | MA | — | B19（Conflicts データ由来） | B28（同） |

- 旧実装は EH を SADR へ付け替えていた（`iso()` の swap）＝「ISO実体=SADR国家」という主張になっており、
  **UN 非自治地域フィルタ（EH を含む）が SADR にマッチする実バグ**もあった → swap 撤去で両方解消
- 「誰のものか」はどこにも書かず、実効支配(sovereignt)と主張(claim)を両方向の事実として持つだけ
- 旗: 国旗.zip の 西サハラ.svg（SADR 旗）を両者で共用（EH の絵文字旗も SADR 旗である国際慣例と同じ）＝消費側で alias
- **データ修正済み（2026-08-31）**: 手元の Conflicts.json は B19 の claim ["EH"]→["B28"] を修正済み
  （B28 の sovereignt は元から "B28" の Self 形だった）。旧表記のデータが来ても setConflicts の上書きが吸収する
- 実走確認: 西サハラの geoPNG が領域全体（B19+B28）で描かれるか（NE admin1 の EH 地物の範囲次第で調整）
- 消費側移植時: `is()` を key ベースにすれば AU リストへ "B28" を足すだけで SADR の AU 加盟の名前特例が消せる
- **クリッパートン島は普通の国に格下げ**（Kenji 裁定「浮かせない」）: finalize のハードコード撤去＝seed の1行として
  通常パイプラインで作る。**手元の 国名一覧.csv には行追加済み（2026-08-31・クリスマス島の次行）**。
  seed 未収録の古いデータでも careteList が既定行を補完。人口[-1,0]/面積6㎢ は他の無人島と同じ def/rep 表
- **実データ検分メモ（2026-08-31）**: 国名一覧.csv は **BOM 付き**（blob2rows で剥がす・d3-dsv は剥がさない）・
  ヘッダ行なし 267 行・key 列（8列目）は大半空で稀に NE 名（"W. Sahara" 等）＝読み飛ばしで正解。
  Conflicts.json は 99 件の完成形（wiki id・4言語名付き）。音源.zip はクイズ用 UI 効果音 11 本（出題/成功/達成…）
- 長期課題: wikidata QID の併記（`wiki.id2qid` 移植済み・NE admin1 に wikidataid あり）
