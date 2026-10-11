# parks-ledger — アメリカ合衆国の国立公園の台帳（public/parks-us.json・public/parks-us.geopbf・public/nps-units.geopbf）の作り方

一回物の生成手順（2026-10-07）。/japan/parks の `apps/ortho-japan/scripts/parks-ledger` と同じ段取り＝ネットに出るのはここだけ。実行時の頁は台帳と Wikipedia/Commons の直読みだけ。
作業フォルダ（`work/`）はリポジトリに入れない。

1. `curl -o work/list.wiki 'https://en.wikipedia.org/w/index.php?title=List_of_national_parks_of_the_United_States&action=raw'` — 一覧の wikitext（api.php は共有 IP で 429 が出るので action=raw）。
   `node parse-list.mjs work/list.wiki work/list.json` — 63 行：en 記事名・短い名・州・座標・指定日（Date established as park）・面積（acre・NPS の 2023 年の面積報告）・来訪者（2025）・写真・一文。
2. `node fetch-wikidata.mjs work/list.json work/parks-raw.json work/states.json` — 記事名 → QID（sites=enwiki）→ 名前 26 言語・Wikipedia の頁名・P18 写真・P856 公式サイト、Commons から写真の 1280/640 の URL と作者/ライセンス、州（P300 の ISO 3166-2 で US-XX → 名前 26 言語）。
3. `node fetch-boundary.mjs work/codes.json work/parks-boundary-raw.geojson 0.0005` — NPS Land Resources Division の境界（ArcGIS FeatureServer・パブリックドメイン）。codes.json＝63 公園の UNIT_CODE（`UNIT_TYPE='National Parks'`＋NERI＝New River Gorge は "National Preserves" 扱い）。
   Park と Preserve（Denali 等 7 件＋New River Gorge）は同じ UNIT_CODE で別の面＝両方取る。maxAllowableOffset 0.0005°（日本版の DP と同じ尺）・geometryPrecision 5。
   `node fetch-boundary.mjs - work/nps-units-raw.geojson 0.002` — 全ユニット 442（「他の NPS ユニット」の重ね・粗め）。
4. `node build-ledger.mjs work/parks-raw.json work/states.json work/parks-boundary-raw.geojson public/parks-us.json work/parks-boundary.geojson` — id（短い名の slug）・地域（NPS の REGION：AKR/PWR/IMR/MWR/SER/NER）・bbox を当て、地域ごとに西→東の順で `parks-us.json` を書く。外周の属性＝`{ id, code, kind: park|preserve }`。
   `node build-units.mjs work/nps-units-raw.geojson work/nps-units.geojson` — 国立公園本体（と付属の Preserve）を除いた 372 面に種別の群（group：monument/historic/shore/recreation/preserve/trail/other）を持たせる。
5. `node ../../../../packages/geopbf/bin/geopbf.mjs enc work/parks-boundary.geojson public/parks-us.geopbf --precision 5`（0.14MB）／`… enc work/nps-units.geojson public/nps-units.geopbf --precision 4`（0.10MB）。

⚠ 指定日・面積・来訪者は Wikidata を信用しない（単位違い・国定記念物時代の日付が混じる）＝一覧（出典は NPS）の値が正。日本版と同じ裁定。
⚠ 写真の URL は Commons の API が作った幅（1280・640）だけが配信される＝任意幅の直叩きは 400。取り直したら全 URL を HEAD で確かめる。
