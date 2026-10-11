# terrain-ledger — 日本の地形の台帳（public/terrain.json・terrain-i18n/・terrain.geopbf）の作り方

/japan/terrain（terrain.html・terrain.js）が読む台帳を組む一回物の手順（2026-10-06）。ネットに出るのはここだけ＝実行時のページは台帳と Wikipedia の直読みだけ。
world（/globe/physical・packages/world）の作法に合わせた＝「地図帳に載る地形を機械的に選び、Wikidata で名前 26 言語と物理量を引き、形は公的データから」。

| 段 | スクリプト | 入力 → 出力 | 中身 |
|---|---|---|---|
| 1 | `anno-crawl.mjs optimal_bvmap-v1 4 9` / `anno-crawl.mjs experimental_bvmap 4 8` | 地理院ベクトルタイル → `.cache/anno-*.json` | 日本の範囲の z4〜9 の注記（Anno）を全部読む。世界の NE scalerank に当たる「地図帳での目立ち度」＝**地理院が名前を置く最小のズーム**を rank にする。川（322）は experimental だけ |
| 2 | `seed-build.mjs` | `.cache/anno-*.json` → `seed/terrains-anno.csv`（生成物） | 注記分類（311〜352）→ 分類（接尾辞で山地/平野/盆地/湾/海峡…を分ける）。同名が離れて複数ある時は `#2`（駒ヶ岳・大島・白根山） |
| 3 | `wd-landforms.mjs` | Wikidata SPARQL → `.cache/wd-landforms.json` | 日本の地形項目（landform の下位クラス × P17 日本 × 座標あり）約 1.9 万件の一括取得＝名前照合の材料 |
| 4 | `wikidata-match.mjs` | 種＋手動層 → `.cache/match.json`・`.cache/unmatched.csv` | ① 日本語ラベル一致＋最寄り（分類の相性を見る）② jawiki の記事名（SPARQL schema:about）③ 手動層の alias。海域・海底・列島は名前だけで結ぶ |
| 5 | `wikidata-fetch.mjs` | QID → `.cache/entities.json` | 名前 26 言語・各言語の Wikipedia 記事名・P625・P31・物理量（標高 P2044／プロミネンス P2660／長さ P2043／面積 P2046／流域 P2053／深さ P4511／落差 P2048／流量 P2225／体積 P2234） |
| 6 | `shapes-ksj.mjs --ksj DIR` | 国土数値情報 W09（湖沼）・W05（河川・47 都道府県）→ `.cache/shapes-lakes.json`・`shapes-rivers.json` | 名前（ゆれ込み）× 最寄りで切り出す。川は河川名 × 水系域コードで束ね、区間を端点でつなぎ 0.0003° で間引く。W05 の名が違う川は手動層 `w05`（四万十川＝渡川） |
| 7 | `ledger-build.mjs` | 種 × 結び × 中身 → `public/terrain.json`・`public/terrain-i18n/<lang>.json` | 日本語版 Wikipedia の記事が無い物は入れない。分類名 26 言語＝world の categories ＋ 海山・丘・砂丘・浜・断層・洞窟（Wikidata のクラスのラベル） |
| 8 | `shapes-build.mjs` | 湖・川・手書き軸線 → `public/terrain.geopbf`（precision 5・gzip・約 280 KB） | 山地・海溝の軸線（`seed/terrains-manual.json` の axis・幅 km）は表示側で帯にする（physical の rangeBand と同じ）。海流＝axis＋flow・構造線＝line |

手動層 `seed/terrains-manual.json`（人が持つ）: `add`（注記に無い物＝平野・盆地・台地・高原・滝・砂丘・湿原・海溝・海流・構造線・プレート…・qid は QID か jawiki の記事名）／`drop`／`alias`（`"名前|code"` → QID か記事名）／`category`（分類の上書き）／`axis`（手書き軸線）／`w05`（国土数値情報の河川名の読み替え）。

データ源（取得は Node から直接・いずれも 2026-10-06 に到達を確認）: 地理院ベクトルタイル `cyberjapandata.gsi.go.jp`（出典: 国土地理院）・Wikidata `query.wikidata.org`（CC0・`www.wikidata.org/w/api.php` は共有 IP で 429 が出るので SPARQL だけ使う）・国土数値情報 `nlftp.mlit.go.jp/ksj/`（W09-05 湖沼 8 MB・W05 河川 47 本 約 280 MB＝取ったら Stream の shp/dbf/shx だけ残す）。
Wikidata の値の選び方＝preferred rank を優先し、単位は QID で換算（ft・mi・ha・hm³）。深さの無い海溝・海盆は標高が負なら深さとして読む（physical と同じ）。

数（2026-10-06）: 種 1,807＋手動 180 → 結び 1,663 → 台帳 1,520 件（山 328・火山 108・島 301・川 298・岬 68・湖 56・山地 44・湾 42・峠 37・列島 34・盆地 28・半島 29・平野 24・海 22・高原 18・海峡 18・滝 16・浜 10・海溝 7・湿原 7…）。形 400（湖 53・川 291・山地 42・海溝 7・海流 4・構造線 3）。
落とした 94 件＝日本語版 Wikipedia の記事が無い山・岬・小島（`.cache/dropped.json`）。未一致の約 300 件（主に小さな岬・岩礁・北海道の小河川）は `.cache/unmatched.csv`＝必要な物は alias で足す。

検査: `node tests/t-terrain.mjs`（npm test に含む）＝台帳の形・座標の範囲・形状台帳との結び・分類名の言語数・手動層の整合。
