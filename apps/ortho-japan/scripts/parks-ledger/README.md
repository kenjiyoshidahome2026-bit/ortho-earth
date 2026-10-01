# parks-ledger — 国立公園の台帳（public/parks.json・public/parks.geopbf）の作り方

一回物の生成手順（2026-10-02）。ネットに出るのはここだけ＝実行時のページは台帳と Wikipedia/Commons の直読みだけ。

1. `node fetch-parks.mjs > parks-raw.json` — Wikidata（class Q1071482＝日本の国立公園・35 件）から名前 26 言語・Wikipedia の頁名・P18 写真・座標・公式サイト、Commons から写真の作者/ライセンス。
2. 外周：bucket `GIS/pbf/nps_all`（環境省の地種区分 1.1 万面・apps/uploader の nps() が焼く）を `geopbf dec` で GeoJSON にし、`python3 dissolve.py` で公園ごとに溶かす（共有辺の相殺→環の連結→DP 間引き 0.0005°→入れ子で穴を決める）＝ `parks-boundary.geojson`。
3. `python3 build-ledger.py` — 公式値（環境省 国立公園一覧：陸域 ha・指定日・都道府県）と地方・id を当て、`parks.json` を書く。外周は `geopbf enc parks-boundary.geojson parks.geopbf --precision 5`。
4. `node patch-thumbs.mjs public/parks.json` — Commons の API に 640px のサムネを作らせて `photo.thumb` に（任意幅の URL 直叩きは 400）。全 URL を HEAD で確かめる。

⚠ 面積・指定日は Wikidata を信用しない（単位違い・国定公園時代の日付が混じる）＝build-ledger.py の OFF 表が正。
