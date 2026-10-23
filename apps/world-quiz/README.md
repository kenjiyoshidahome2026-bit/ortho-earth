# world-quiz（世界クイズ）

www.ortho-earth.com/quiz/ ＝ World（apps/world）の国名・国旗・首都・位置で遊ぶ教育用クイズ。子供が飽きずに覚えられるように。

- **モード 4 つ**：国名＋国旗 → 首都／国旗 ⇄ 国名（交互）／地図 → 国名（Lv.3 は国名 → 地球儀を押す）／**世界の地形**（2026-10-23）
- **世界の地形**：地球儀が山・川・湖・海・砂漠・半島・海峡…を指す（面＝周りを薄く覆う＋赤い輪郭・川＝赤い線・山や滝＝小さな円）→ 分類（「💧 川」）を見て名前を 4 択で選ぶ。
  台帳は World の TerrainDB（約 1,000 件・35 分類・名前は `TerrainDB.i18n/<lang>.json`・分類名は World の ui-table）と形状台帳 `ne-physical.geopbf`＝/globe/physical と同じ GitHub Pages（ortho-data/globe/）の物＝新しいデータは無い（`src/terrains.ts`・モードを選んだ時に読む）。
  層＝NE scalerank（Lv.1＝0〜1 約 140／Lv.2＝2〜3 と手で足した名所／Lv.3＝全部）。地域＝代表点に最も近い国の地域（大陸・大洋は「世界」だけ）。選択肢は同じ分類から（範囲の外も）→ 足りなければ同じ系統。プレート・海流は出さない。地図が起きない時は「〜の近く」（近い国 2 つ）を手がかりに出す
- **難易度 3 段**（国の知名度で層分け・`src/quiz.js` の `tierOf`）：Lv.1＝国連加盟国で人口 1,500 万以上か面積 100 万 km² 以上（約 80）・選択肢は範囲のどこからでも／Lv.2＝国連加盟国で人口 100 万以上（約 160）・選択肢は同じ地域／Lv.3＝領土・小国・係争地も全部（262）
- **範囲**：世界か 6 地域（World の REGIONS と同じ番号 `?region=`）
- **1 セット 10 問**：選ぶ→その場で○×→地球儀が正解の国へ寄る（spotlight）→首都と人口のひとこと→次へ（正解は 1.6 秒で自動、間違いは押すまで）。数字キー 1〜4・Enter で進む
- **覚える工夫**：間違えた国は次のセットに優先して混ざる（間隔反復＝正解すると 1 日→2 日→4 日と間が延び、3 回続けて正解で消える）・最近出た 40 か国は避ける・図鑑（正解した国の数）・星（10/8/5 問）・最高記録（モード×レベル×地域）・連続正解・バッジ 9 種。全部 localStorage（`world-quiz.v1`）
- **言語**：26 言語。UI 文言は `i18n/pages/quiz.json`（`npm run i18n:build` で `i18n/lang/quiz/` へ）。国名・首都・地域名は World の台帳の訳（bucket `GIS/world/i18n/<lang>.json`）をそのまま。ja の文言は漢字で書く。World の yomi は並べ替え用の鍵なのでルビには使わない
- **データ**：World と同じ bucket（`packages/world/src/data.js` の `loadWorld`＝IDB 優先・裏で更新）。国旗は `flags/<key>.svg`。地球儀は `@ortho-earth/globe`（dev はソース直・build は共有エンジン）＝World の地図パネルと同じ配線。Lv.3 の「押して当てる」は World の `worldlayers.js`（ne-cultural base）で押した所の国を引く。小さい国は指で押し損ねるので、外れても国の形から 24px 以内なら正解（海を押した時は国の大小を問わず、隣の国を押した時は画面で 40px 未満の国だけ＝`quiz.js` の `reachOf`・`tapHits`）。マウスの下の国は黄色の線で囲む（名前は出さない＝答えを探し当てられないように。指とドラッグ中は出さない）

```
npm run dev -w world-quiz      # http://localhost:5198/quiz/（/api → api.ortho-earth.com）
npm test -w world-quiz         # 出題の芯・進捗保存・i18n の門
npm run build -w world-quiz    # dist/site/quiz/（共有エンジンを焼いてから）
```

URL：`?mode=capital|flag|map|terrain&level=1|2|3&region=0|1..6&lang=ja`、`?start` で即開始、`?nomap` で地球儀なし。
