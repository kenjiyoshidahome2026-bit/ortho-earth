# sceneCollection — 共有シーン・フォーマット v1（flat）

> permalink の視点を数珠つなぎに、字幕とともに**ライブ再生**する JSON。動画ではない＝実秒でエンジンが毎フレーム描く（軽い・止めて回せる・端末で尺が伸縮しても崩れない）。
> **ドロップ**すれば再生。将来 iMovie 風エディタで作れる。**「定義したそのまま」＝先頭の視点で始まり、末尾の視点で終わる**（遠景の intro/outro を足さない）。

## 0. 拡張子・MIME・見分け（drop routing）
- **拡張子** ＝ `.scene.json`。中身は素の JSON（エディタ/GitHub/`JSON.parse` がそのまま効く）。
- **MIME** ＝ 実務 `application/json`。公式型 `application/vnd.ortho-earth.scene+json`（RFC6839 `+json`）を予約。判定に MIME は使わない（`file.type` は不定）。
- **見分けの権威は中身の `"type":"sceneCollection"`**：`.scene.json` は確定／`.json`・`.geojson` は先頭64KBに `"sceneCollection"` を含めば全 parse、無ければ従来 geopbf（`FeatureCollection`）。

## 1. 構造（平ら）
```jsonc
{
  "type": "sceneCollection",       // 必須・見分け
  "title": "隅田川を遡る",
  "lang": "jp",                    // 既定表示言語（?lang= が上書き）
  "waitLoading": true,             // 任意：重いデータ（3D都市＝PLATEAU）が立ち上がるまで開始を待つ（リビールが必ず街に着地・道中のポップイン無し）
  "defaults": { "transition":"glide", "hold":0, "secs":2.6 },   // 各 scene が継承（省略時の値）
  "scenes": [ … ],                 // ← キーフレームの配列（これが本体）
  "audio": [ … ]                   // 任意・予約（外部URL/blob のみ・再生は次ステージ）
}
```

## 2. scenes[]（キーフレーム）
| key | 意味 | 既定 |
|---|---|---|
| `view` | 到達視点＝permalink ハッシュ `#z/lat/lng[/Pt][/Br][/l=…][/c=…]`（層 `l=`・配色 `c=` 込み） | 必須 |
| `transition` | 来かた：`glide`(直線滑走) / `fly`(球面フライト) / `fade` / `cut` | defaults |
| `hold` | 到達後の静止[秒]（着地から計時）。`0`＝止まらず次へ | defaults |
| `secs` | 遷移時間[秒]（glide/連続ドリーの尺） | defaults |
| `caption` | 字幕（§3） | — |
| `<lang>` | 言語別の字幕上書き（`jp`/`en`…） | — |
| `pre` / `slide` / `mobile` | 入場の見せ玉 / 紙カード(画像URL・生テキスト) / 縦画面Δz | — |

- **先頭 scene** ＝ その視点で即開始（jump・遠景の弧を作らない）。**末尾** ＝ finale（遠景）を足さない。＝「定義したそのまま」。

### spline（hold:0 連続＝連続ドリー）
`transition:"glide"` かつ `hold:0` が連続する区間を1本の **centripetal Catmull-Rom** で通す（5自由度：経緯度=曲線／zoom/pitch/bearing=区間補間）。`hold>0` で停止（杭）。`fly`/`fade`/`cut` はスプラインを断つ。点を数個打てば川に沿って滑る。

## 3. 字幕の言語（1つが基本）
`caption:"文字列"` が既定。必要なら同じ scene に `en:"…"` / `jp:"…"` を足す＝**表示 lang と一致すればそちら**。解決＝ `scene[lang] ?? caption`（demo の `scene[lang] ?? title` と同流儀）。
```jsonc
{ "view":"#…", "caption":"東京駅", "en":"Tokyo Station" }   // jp表示→東京駅／en表示→Tokyo Station
```

## 4. waitLoading（読み込み待ち・任意）
`waitLoading:true` ＝ 全 scene の view の重いデータ（3D都市＝PLATEAU）を先読みし、**立ち上がるまで開始を待つ**（「Loading city…」表示）。リビールが必ず建物に着地し、ドリーの道中も建物が揃う。タイムアウトで諦めて開始（回線が細い時も止まらない）。※ Plateau は固有名詞ゆえ書式のキーは汎用名（`waitLoading`）。

## 5. audio（任意・予約）
`audio:[{ kind:"music"|"sfx", at, src, gain, fade, loop }]`。`src` は外部URL/`blob:` のみ。**v1 は型のみ・再生は次ステージ**（Web Audio）。

## 6. 再生の作法
ドロップ→`type`判定→demo プレーヤーで自動上演（実秒クロック）。先頭 jump・末尾 finale なし。掴めば中断＝主導権は人。画面収録すれば動画にもなる（本質は配って各自の GPU で再生）。

---
### 未確定（次ステージ）
絶対 `captions[]` トラック（経路上に複数字幕）／`fade`・`cut` の作り分け／`fly` の `secs`／audio 再生／`?scene=<URL>` ロード／iMovie 風エディタ（今の視点を「撮る」＝permalink 流用→並べ替え→書き出し）。
