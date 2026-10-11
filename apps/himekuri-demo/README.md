# 日めくり（himekuri-demo）

[himekuri](../../packages/himekuri)（旧暦・六曜・二十四節気・七十二候・暦注・祝日の SVG 日めくり）を真ん中に、**今いる場所の太陽と月**（日の出・南中・日の入り・薄明・月の出入り・月齢・次の朔望）を外に添えた頁。日めくりの下に**今日の言葉**（366 句・出典つき・著作権切れの言葉）。
`www.ortho-earth.com/himekuri/`（www のデモ一覧「Japan's open data」に載る）。

| | |
|---|---|
| URL | `/himekuri/` — `?d=YYYY-MM-DD`（日付）・`?mode=week`（週）・`?lat=&lon=&alt=`（場所と標高 m）・`?tz=Asia/Tokyo`（表示の時間帯）・`?lang=` |
| 日（day） | himekuri の日めくり＋今日の言葉／太陽・月・予定・場所の札。← → で一日・Shift で一か月・スワイプ・T で今日・W で週 |
| 週（week） | 近傍の日を一行ずつ（曜日・祝日・節気・六曜・旧暦・干支・九星・暦注・☀ 出入りと昼の長さ・☾ 出入りと月齢・月相・予定）。上下に際限なく送れる（14 日ずつ足し、200 日で遠い側を畳む）。行を押すとその日へ |
| 場所 | `navigator.geolocation`（断られたら東京）。標高は Open-Meteo の標高 API（全球 90 m）→ 地理院標高タイル .txt（日本 dem5a/dem・国外 demgm）→ GPS 高度 → 0 m の順（`src/elevation.js`・30 日 localStorage）。設定で緯度経度・標高・時間帯を手入力できる |
| 太陽・月 | `src/astro.js`：太陽＝Meeus 低精度（0.01°）・月＝Schlyter（0.3°）。出入り＝0 時〜24 時を 10 分刻みで追い二分法。目標高度＝−大気差 34′ −視半径 −**地平線の降下 1.76′√h**（h＝標高 m・設定で切れる）。月は中心・視差込み。薄明＝−6/−12/−18°・降下なし。極地の白夜・極夜も出る |
| 予定 | iCal の URL（この端末で fetch・CORS 不可なら .ics 取り込みへ案内）か .ics ファイル（`src/ical.js`：DATE/DATE-TIME/TZID/UTC・DURATION・RRULE DAILY/WEEKLY/MONTHLY/YEARLY・COUNT/UNTIL/BYDAY/BYMONTHDAY/BYMONTH・EXDATE・RECURRENCE-ID）。localStorage に持つ |
| 言語 | UI 26 言語（頁の辞書 `i18n/pages/himekuri.json`・芯は `@ortho-earth/globe/i18n.js`）。暦の中身と今日の言葉は日本語のまま（日本の暦） |
| 器 | `@ortho-earth/globe/page.js` の `startPage`（言語・起動画面・起動失敗の面）。英語 head・共有カード（og:image＝www のサムネイル）・canonical・theme-color |

## 開発

```
npm run dev -w himekuri-demo          # http://localhost:5197/
npm test -w himekuri-demo             # 太陽・月（NAOJ の値と ±1 分）・標高（モック fetch）・iCal・週の束ね・i18n 門
npm run i18n:build -w himekuri-demo   # i18n/pages/himekuri.json を直したら焼く（i18n/lang/himekuri/<code>.json）
npm run build -w himekuri-demo        # dist/site/himekuri/（wrangler.toml の assets・route /himekuri*）
```

検定（`tests/`）は Node だけで走る＝外部網は使わない（標高はモック・iCal は文字列）。ブラウザでの目視は手元で。

## 設計の覚え書き

- 標高による地平線の降下は「海抜＝見える地平線までの高さ」とみなす近似。海辺・山頂では妥当、内陸では実際の地平線はもっと高い（出は遅く入りは早い側に外れる）＝太陽の札に海抜 0 との差を併記する。
- 時刻は表示の時間帯（既定＝端末）で出す。遠くの場所を手入力する時は設定でその土地の帯を選ぶ（`?tz=` でも）。himekuri の暦（節気・六曜）は日本時で数える＝日本の暦そのもの。
- 今日の言葉は年通日（1/1＝0）で選ぶ＝同じ日は毎年同じ句。足す時は `src/quotes.js` の末尾に `[言葉, 出典]`。

License: GPL-3.0-or-later（himekuri 本体は MIT）。
