# 国別DB（world）移植台帳

> **2026-09-11**: 本文が指す原典（legacy/create.js・create*.js・geometryISO.js・draw.js・draw.scss）と v1 seed（国名一覧.csv・CityDB.csv・Conflicts.json・国旗.zip）は
> v2 完成に伴い削除した。必要なら git 履歴（コミット e544907 まで）から取り出す。この文書は経緯の記録として残す。

旧システム（bucket プロジェクト `b1qEpPlw`）の国別データベース作成ツールを ortho-earth へ移植する記録。
このディレクトリの [legacy/create.js](legacy/create.js) は**旧システムの原典**（`#inline` スニペット参照付き・そのままでは動かない）＝読み取り専用の設計図。
**移植済みの原典は `legacy/` へ退避（2026-09-09）**＝実行には不要だが、Wikipedia 側の変化を追うとき原典との差分が要る（面積0・infobox クラス消滅の調査で実際に読み返した）。
`draw.js` だけは据え置き＝消費側（ガジェット）は未移植で、次の移植対象の原典。

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
| `qjpQx44Y` | createNationDB | ✅ 済み＝uploader/src/world/createNationDB.js（原典 legacy/createNationalDB.js） |
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
| 国旗（svg 束） | `flags.zip`（<key>.svg）。旧 `国旗.zip`（国名.svg）をドロップすると key 名へ改名して flags.zip に収蔵 | GIS/world/flags.zip |
| 音源（mp3 束） | `音源.zip` | 〃 |
| geoms（png 束） | `geoms.zip` | 〃 |

ドロップ後は「一覧 (GIS/world)」ボタンで収蔵を検札。console からも旧ツール同様に
`loadNationDB()` / `saveNationDB(a)` / `createWiki(db, lang)` … が叩ける（window へ束ねて公開済み）。

## ビルドの正しい順序（依存があるので順番厳守）

1. `国名一覧.csv`（seed）と `Conflicts.json`（or `Conflicts.csv`）をドロップ ← **Conflicts が createNationDB の前提**
2. （年次更新なら）「wikiキャッシュ掃除」ボタン ← 押さないと前回取得の値が返り続ける
3. createNationDB → createLanguageDB → createCurrencyDB → createCityDB → createGeometryPNG → **createI18N（最後＝名前が変わったら再生成）**

## 2026-08-31 の冪等化・整理（旧実装からの変更点）

- **保存形式は版スタンプ包み** `{ updated, count, items }`。読みは素の配列（旧書き出し）も両対応
- **NationDB のパッチ（例外5地域除去+クリッパートン追補）は load 側→ビルド側へ移動**（`finalizeNationDB`・冪等）。
  旧実装は createCurrencyDB の save 戻しでクリッパートンが増殖し、例外地域が保存から消えていた
- **年ガードを動的化**（旧: 2025 固定＝2026 年から今年の人口を全部弾くバグ）
- **統計を一次ソース API へ移行（2026-08-31）**: population/gni/gnipc=World Bank API（CORS開放＝ブラウザ直・ISO3結合）、
  gdp/gdppc/ppp/ppppc=IMF DataMapper API（予測年込み・proxy経由）。約140ページのスクレイピング→5リクエスト、
  統計の日本語名寄せが消滅。**2026-09-10: GPI は en.wikipedia の順位表（最新年 1 本・wiki.en で結合）、PSI は World Bank の殺人率 `homicide` へ置換＝sekai-hub 依存は消滅**
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
| 旗 | `flags.zip/<key>.svg` | 2026-09-09 に 国旗.zip（国名.svg）から改名。国以外は FLAG_KEYS（UN/EU/NATO/DISPUTED・旧例外地域は X-TIBET 等）。SADR=B28.svg は EH と同じ旗の複製 |
| 内部参照 | `name.ja` | territory/conflict/geoPNG/音源ファイル名＝renames の影響を受けない閉じた名前空間 |

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
  Conflicts.json は 99 件の完成形（wiki id・4言語名付き）。音源.zip はクイズ用 UI 効果音 9 本（出題/成功/達成…・下記「素材の出所」）
- 長期課題: wikidata QID の併記（`wiki.id2qid` 移植済み・NE admin1 に wikidataid あり）

## 精査ログ（2026-09-09・bucket 実データ 262か国を機械検札）

直したもの: ①面積0の6か国（アルゼンチン/キプロス/セルビア/モロッコ/ジョージア/沿ドニエストル＝infobox 脚注の km² が
混ざり「1件だけなら採用」で落ちていた→「統計」行優先+先頭ヒット）②CityDB.csv 逆変換で首都共有国の nation 配列が壊れていた
（JSON 配列文字列をカンマ分割）→ JSON.parse・bucket の現物も修復済 ③ドネツク/ルガンスクの wiki.en/zh/ko 全欠（ja 記事に
言語間リンク無し）→ wikiPatch 表 ④首都記事名の改名（ヌクノノ→ヌクノノ島）→ 島/市 接尾辞で再試行 ⑤wikiName 上書きは
seed 名を含まない別名のときだけ（マニラ→マニラ首都圏 は seed 採用）+warn ⑥言語キー未定義 ha/mwl 追加・マレーシア英語→英語
⑦GDP 系は WB 主・IMF(DBnomics) は穴埋め（8/31 実走は DBnomics 停止で全て WB だった・DBnomics latest は WEO 2025-04 で1年遅れ）
+ISO3 別名（コソボ KSV→XKX/UVK）⑧国歌 62 か国欠＝ja 記事に音源無し→ Wikidata P85→P51 で部分補完 ⑨トケラウの人口/面積既定表
⑩bucket GET のキャッシュ（edge 1h/ブラウザ 4h）で保存直後の再読込が旧版＝loadJSON に ?_t=

**Kenji 裁定で反映済（2026-09-09）**: 赤道ギニアの首都を シウダ・デ・ラ・パス へ更新（seed・CityDB.csv・bucket とも。マラボは
capital=false で残置・標高 0 は未取得）＋ **`capitalNote` フィールド新設**＝旧消費側 draw.js の capitalComment 表をデータ側へ
移設（defacto/changed/multi/text・赤道ギニア={defacto: マラボ}）・SADR の currency=MAD|DZD（通貨 def 表）・LanguageDB の
zh/ko 欠け4語は名前補完（記事が無いものは wiki id 0）。据え置き＝Conflicts に無い擬似キー "AF"（アフガニスタン二政権用・
geoPNG は admin1 の AF で描ける）。国旗は全 262 か国カバー（直接 253・領有国代替 8・SADR→西サハラ別名 1・余剰 13 は UI/旧例外用）。
検札の手口＝scratchpad の audit.py（bucket から JSON を落として鍵/参照/欠測/統計/紛争を機械検札）

## 消費側（ビューア）の移植＝apps/world（2026-09-09・v1）

旧 draw.js + draw.scss を `apps/world/`（vite・`npm run dev:world`）へ移植。見た目は draw.scss そのまま、旧フレームワーク依存を置換:

| 旧 | 新 |
|---|---|
| `#inline` HTML パーツ（__HTML__） | main.js 内テンプレート（[name=head]/[name=main]>[name=scroll]/[name=modal]） |
| selectOptions / selectButtons / inputSearch（旧 d3 拡張） | src/controls.js に自作 |
| `isox` + ハードコード表 | データ側 `key`（NationDB に焼き込み済）・AU 加盟の名前特例は組織リストへ "B28" |
| `capitalComment` ハードコード表 | データ側 `capitalNote`（defacto/changed/multi/text） |
| language_hash[name.ja] / currency.split("\|") | キー結合（LanguageDB.key / 配列） |
| FlagSVG（ratio/colors/format） | src/flag.js（viewBox 約分・fill/stroke 色の抽出） |
| makeSpeach / divideSentence / hebon2kana | Web Speech API 直・文末で分割・**hebon2kana は src/hebon2kana.js に新規実装**（ヘボン式→カナ・長音/促音/ヴァ行を任意にした正規表現＝osutoraria でも oosutoraria でも当たる・読み(yomi)も検索対象＝nihon→日本） |
| WhiteEarth 地図・setupMapGeometories | **作らない**（Kenji 裁定「地図は後から」）＝geoPNG はサムネイルのみ・クリック配線なし |
| d3.cache（設定の永続化） | native-bucket Cache（world/system）。zip3本は ETag 付き IDB キャッシュ（2回目以降は無通信） |

- 起動: `npm run dev:world` → http://localhost:5173/ 。`?open=国名|key|iso2` で国旗モーダルを開いた状態で起動（ディープリンク）
- 実描画検証（ヘッドレス Chrome・CDP）: 262か国・一覧表262行・GDP順（アメリカ→中国→ドイツ）・モーダル（首都読み上げ文・縦横比 3:2/2色）・console エラー0
- 轍①: `const` の関数式を初回呼び出しより後に置くと TDZ（unhide と同じ）＝main.js の makeRegexp は function 宣言に
- 轍②: **common の d3 拡張は `selection.empty()` を `html("")` に上書き**している＝d3 標準の空判定のつもりで呼ぶと先頭要素の中身を消す（resize の `scroll.select("div").empty()` で1件目のカードが空になった実害）。空判定は `.node()` で

## i18n（2026-09-10・英語基軸 26 言語・サーバー側テーブル・?lang=xx・RTL）

方針（Kenji）: 英語を基軸に 26 言語へ。読み込むデータを増やさないため**言語別テーブルは bucket 側**に置き、クライアントは
基軸（NationDB の英語名＋英語キーの UI）＋選択言語の1本だけ読む。RTL（ar/fa/ur/he）対応。`?lang=xx` で切替。

| もの | 場所 | 中身 |
|---|---|---|
| 言語一覧 | `packages/world/i18n/langs.json`（クライアント同梱・小） | code / native 名 / rtl |
| UI 辞書（正本） | `packages/world/i18n/ui.json` | 英語キー → 25 言語（53 キー）。uploader の bake が各言語テーブルへ同梱 |
| 言語別テーブル | bucket `GIS/world/i18n/<lang>.json`（1本 53〜99KB） | `{ nations:{key:{name,wiki}}, cities:{wikiJa:{…}}, languages:{key:{…}}, currencies:{key:{…}}, ui:{英語キー:訳}, rtl }` |

- **名前の出所**: en wiki id → QID → **Wikidata の labels（名前）＋ sitelinks（各言語の記事名）**＝Wikipedia 言語間リンクより網羅が良く、1回の wbgetentities で 26 言語まとめて取れる。uploader「i18n作成(createI18N・26言語)」ボタン（初回は scratchpad の python で seed 済）
- **クライアント**（apps/world）: `?lang=` → 保存値 → ブラウザ言語 → en の順で決定。`trans(英語キー)`＝テーブルに訳が無ければ英語キーそのもの（英語基軸のフォールバック）。名前は `i18n テーブル → 埋め込み name[lang]（ja/zh/ko）→ en`。Wikipedia リンクは選択言語の記事名 URL。数値は `Intl.NumberFormat`（数字はラテン・区切りは言語）、名前順は `Intl.Collator`
- **RTL**: `html[dir=rtl]` で物理 left/right を論理方向へ上書き（draw.scss 末尾）。カードは float:inline-end、モーダルの戻る/進む・閉じる・DL ボタンは左右入替
- 検証: ar=`lang/dir=ar/rtl`・国名 آيسلندا・UI العاصمة、ja/en 正常、console 0
- 残: 組織の正式名（filter_names）は ja/en/zh/ko のみ（他は英語）・ローマ字検索は日本語カナのみ・extend（正式国名の型）は ja/en のみ

## 精査後の改良（2026-09-10・Kenji「上から着手」）

1. 設定保存から i18n テーブルを除外 2. `?open=` 等の URL パラメータを言語確定時に保持 3. 日本語順＝先頭カナは名前そのもの・先頭漢字だけ読み
4. 検索文字列を言語切替で作り直し（選択言語の国名で当たる） 5. スマホ幅（≤720px）＝モーダル上下バーを縦積み・カード全幅
6. **旗/地図PNGは bucket の個別ファイル**（`flags/<key>.svg`・`geoms/<key>.png`）を `<img loading=lazy>` で＝初回 7MB の zip 取得を撤廃
   （zip は保管・一括DL 用に残す。uploader の save は zip と個別の両方を配置。geoPNG も `<key>.png` 命名へ）
7. 国歌＝commons の mp3 派生（videoinfo derivatives）を優先（ogg は Safari/iOS で鳴らない）＝次回 createNationDB で反映
8. 旗 `<img>` に alt 9. createI18N が言語ごとの国名の欠けを一覧 12. 国連加盟日を `Intl.DateTimeFormat`
13. 公開経路＝`base:'/world/'`＋`build:all` で `www/dist/world` へ（dev は http://localhost:5174/world/）
14. JSON も IDB に保存＝ネット不達時は前回分で起動（オフライン）
15. ブロック表示＝CSS Grid（`[name=scroll].grid`・280px 自動充填・中央寄せ）。float は 26 言語で国名の行数が揃わず崩れた（背の高いカードに次行が引っかかる）。
   罠: Grid 項目に `overflow:hidden` を付けると Chrome で行高が 0 に潰れる（スクロールコンテナ扱い）→ `overflow:clip`
16. **カードの文字は描画前に幅を測って枠に収める**（main.js `fitScale`・Kenji「はみ出すものはフォントを小さくしてでも枠に入れる」「描画前にサイズを計算」）
   canvas.measureText で行ごとに測り、枠幅 164px（=280−border-spacing 6−旗列 72−td 余白 10−#番号 28−余裕 2）を超える行だけ font-size を縮める（下限 70%・以降は CSS 折り返し）。
   国名は 2 行まで（貪欲折り返しの模擬）・ja は「・/、/および」で折る候補と比べ 5% 以内なら切れ目で折る。結果: en/ja/ar/de の 262 枚が全て 94px で揃う

## 素材の出所（2026-09-10・公開ライセンス整理の一環）

- **効果音 音源.zip＝全 9 本 OtoLogic（https://otologic.jp）CC BY 4.0**。ID3 タグ（TPE1=OtoLogic / TALB=OtoLogic-SE）で確認。
  素材名: 出題=Quiz-Question01-2・成功=Quiz-Correct_Answer01-2・失敗=Quiz-Wrong_Buzzer01-1・発表=Quiz-Results01-1・達成=Quiz-Results02-1・
  残念=Onoma-Negative04-1・操作H/M/L=Anime_Motion31-1/2/3。クレジット表記が条件（同梱・再配布可）＝画面はヘッダ地球アイコンのツールチップ、配布物は本節。
- 出所不明だった 移動.mp3・リスト.mp3（タグ無し・LAME3.100 192kbps 固定＝別ルート入手）は Kenji 裁定「OtoLogic の既存音で代用」で撤去（bucket も差し替え済み）。
  main.js の Sound は 移動→操作H・リスト→操作L の別名で鳴らす。
- **GPI/PSI の裁定（2026-09-10 Kenji「2+3」）**: IEP のスコアはどこで取っても非商用ライセンス（sekai-hub の「治安ランキング」も IEP の
  Societal Safety and Security 領域スコアの転載＝同じ出所）。→ **GPI は英語版 Wikipedia の順位表**（他データと同じ Wikipedia 経路・
  `gpi=[年, スコア]` の 1 年分・出典表記は IEP）、**PSI は廃止して World Bank の故意の殺人率 `homicide`（VC.IHR.PSRC.P5・UNODC 由来・CC BY 4.0）**
  ＝`[最新年, 値…2015]` 小数 2 桁・10 万人あたり。viewer のラベルは Homicide／「Intentional homicide rate」（ui.json 26 言語）。
  bucket の NationDB.json と i18n/*.json は 9/10 に直接パッチ済み（次回 createNationDB でも同じ結果になる）
- 未裁定: データ本体のライセンス（Wikipedia 由来＝CC BY-SA 4.0 案）
17. **起動は IDB 優先・裏で更新**（data.js 全面改稿・Kenji「IDB があっても遅いのはなぜ」）。旧はネット優先で IDB は不達時の予備＝オンラインでは
   毎回 Worker（1 本 0.6〜1.4s・一覧→JSON→i18n/zip の 3 段）を待っていた（実測 3.8s・getBucket の競合で一覧が二重）。
   新: IDB に揃っていれば即描画（温 0.2s）、初回は一段で全部並列（冷 2.3s・Bucket は `lazy` で到達確認の一覧を省く）。描画後に `refresh()` が
   GIS/world と i18n/ の一覧（ETag）を突合し、変わったファイルだけ取り直して IDB を更新→組み直して再描画（国旗モーダル中は閉じた時に）。
   旗の一覧は flags.zip の ETag が変わった時だけ・音は次回起動から。言語切替も IDB 優先＋裏取り。
   buildModel は生データの `un` 配列を書き換えない（同じ生データから組み直せるように）
18. **Wikipedia はアプリ内 iframe**（Kenji「census のように iframe 表示の方がいい」）。`[name=wiki]` がヘッダ下を全面に覆い、記事は
   `xx.m.wikipedia.org`（狭い枠でも読みやすい）。バーに記事名・↗（別タブ）・×。Escape で閉じる（国旗モーダル中に開いた場合は閉じた後に
   モーダルの Escape を復帰）。model 側は `OpenWikipedia()` が `ctx.openWiki` を呼ぶ＝無ければ従来どおり別タブ。Wikipedia は
   X-Frame-Options / frame-ancestors を送らないので埋め込み可（2026-09-10 実測）
