# yokohama — 横浜市デジタルツイン

横浜市の 3D 都市モデル（国土交通省 PLATEAU）に、暮らし・交通・観光・防災・解析を重ねる単独の頁（市民ファースト＝暮らしの面が先頭・既定）。`www.ortho-earth.com/yokohama/`。
エンジンは ortho-japan と同じ（共有エンジンの `regions/app.js`・choju と同型）。建物は 18 区とも常に出す（LOD2 の 5 区＝エンジン・残り 13 区の LOD1＝twin.ts）。市の外は薄く覆う。

| 面 | 中身 | 出どころ |
|---|---|---|
| 暮らし（先頭・既定） | 地区（18 区）＝真上から区を画面の 9 割に収める・区の線と名前・公共施設（区分ごと・押すと吹き出し）・施設の検索（表・CSV）・平面の地区図に重ねる区域（用途地域・小／中学校区・警察署／消防署の管轄） | 区の境界＝国土数値情報 N03・施設＝国土数値情報 P05／P29／P27／P28／P17／P18／P04・区域＝A29／A27／A32／P18／P17 |
| 交通 | 横浜市営地下鉄（路線の色・駅番号の記号・既定で出る）・市営バスの停留所・JR と私鉄の駅と線路・駅からの徒歩圏（5・10・15 分の輪＝直線の目安と、輪の中の施設・避難場所・バス停・駅の数） | 国土数値情報 N02（鉄道）・P11（バス停留所） |
| 観光 | 名所ツアー・港の物語（1859 年の開港から今まで 7 章・最後に海から街を眺める）・名所 15 か所（写真つき） | 写真＝Wikimedia Commons |
| 防災 | 地点を調べる（押した所の標高・想定浸水深と水が届く階・土砂の区域・近い避難場所 3 か所の距離／徒歩／標高差）・洪水（想定最大）・高潮・津波・土砂災害警戒区域を 3D の街に重ねる（濃さ・凡例）・指定緊急避難場所（対応災害で絞る・押すと標高） | 重ねるハザードマップ（disaportaldata）・避難場所＝bucket `bousai/hinan/14.json` |
| 解析 | 可視域・切り取り（断面・WebGPU）・一人称で歩く・距離と面積・断面図・その時刻の影（WebGPU）・冬至の日影図 | エンジンの機能 |

旧「時間」（年代の航空写真）は継ぎ目と色むらが目立つので外した（2026-10-21）。出典は案内板に書かず地図の出典の欄にまとめる（写真の作者と使用許諾だけは写真に添える）。

台帳＝`ortho-data/japan/yokohama/`（wards・rail・bus・facilities・photos、平面の地図に重ねる面＝zoning・school-e・school-j・police-areas・fire-areas の 10 本の JSON）。

| 台帳 | 中身 | 出どころ（国土数値情報）・年度 | 使用許諾 |
|---|---|---|---|
| zoning | 用途地域（12 種・1,864 面）{ n 名・b 建ぺい率 %・f 容積率 % } | A29-19（横浜市の分 14100）・2019 年度 | KSJ 利用規約＋横浜市＝オープンデータ公開可 |
| school-e／school-j | 小学校区 339・中学校区 144（横浜市立）{ n 学校名・a 所在地 } | A27-21／A32-21・2021 年度 | 横浜市＝オープンデータ公開・特記条件なし |
| police-areas | 警察署の管轄（横浜市内の 21 署）{ n 署名 } | P18-12 の PoliceStationJurisdiction・**2012 年度**（その後の署の新設・管轄の変更は入っていない） | 非商用 |
| fire-areas | 消防署の管轄（横浜市消防局の 18 署）{ n 署名 } | P17-12 の FireStationJurisdiction・**2012 年度** | 非商用（有償刊行物から作成） |

組む・置く：組む＝`node apps/yokohama/scripts/bake-yokohama.mjs`（外部網が要る＝手元の Mac・`--inspect` で KSJ の列名を確かめる）、
置く＝`npm run publish:pages -w world-data -- --scope=japan --only=yokohama --write`。dev は手元の正本を読む。

URL：`?tab=life|transit|sight|risk|tools`（既定 life＝暮らし）・`&ward=14101〜14118`・`&spot=<名所の id>`（data.ts）・`&hz=flood,hightide,tsunami,dosha`・`&tr=subway,bus,rail`（既定 subway）。旧 `tab=city|time|area` は観光・解析・暮らしへ読み替える。
UI は 26 言語（英語キー・`i18n/pages/yokohama.json`・`npm run i18n:build -w yokohama` で焼く）。市政の中立な道具として作る（選挙・候補者・政策の中身には触れない）。

## 開発

```
npm run dev -w yokohama     # http://localhost:5201/yokohama/
npm test -w yokohama        # data.ts の台帳と URL の状態（Node だけ）
npm run build -w yokohama   # dist/site/yokohama/（wrangler.toml の assets・route /yokohama*）
```

本番は `npm run deploy:engine`（root）か Actions の deploy＝エンジンの後に他のアプリと一緒に配る（scripts/deploy-engine.mjs の APPS）。

License: GPL-3.0-or-later.
