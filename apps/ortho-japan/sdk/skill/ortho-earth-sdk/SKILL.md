---
name: ortho-earth-sdk
description: ortho-earth（ortho-japan）SDKで3D地球儀アプリを作る時に必ず読む。埋め込み・GeoPBFデータ読み書き・gint描画・罠台帳・検証の作法。SDK/地球儀/GeoPBF/gint/ortho-japanが話題に出たら発動。
---

# ortho-earth SDK で開発する

あなたは ortho-earth の 3D 地球儀 SDK（ortho-japan）を使ってアプリを作る。**最初に正典を読む**：

1. `https://www.ortho-earth.com/japan/llms.txt` — API面・罠台帳・検証作法の1枚正典（このスキルより常に新しい）
2. SDK 同梱の `README.md`（オプション表・埋め込み契約・出典義務）と `ortho-japan.d.ts`（型）。置き場所＝
   npm: `node_modules/@ortho-earth/japan/{README.md,dist/lib/ortho-japan.d.ts}` ／ zip: `{README.md,lib/ortho-japan.d.ts}`（同一物）／
   CDN: `https://www.ortho-earth.com/japan/lib/ortho-japan.d.ts`

## 鉄則

- **消費して、変形しない**。SDKの中身を書き換えたくなったら設計を疑う。gint系ハンドル
  （applyGintData/paintTable/onGintClick…）は将来 v2 の map.addGint() に置換されるので、
  **自作アプリ側の薄いモジュール1枚に必ず封じる**。
- **1ページ1マップ**。容れ物のidは"map"へ正規化される＝サイズ指定は#idセレクタ禁止。
- **出典表記は義務**。instruments の "attr" を消すならページ側で出典を明記。
- CSSは自動注入されない＝ `ortho-japan.css` の `<link>` を貼る。
- geopbf は SDK の export を使う。npm の geopbf を自分のバンドルに混ぜない（別インスタンス＝createGeopbf の呼び忘れで本番だけ死ぬ）。
  CDN libは external ＋ URL変数経由 `import(/* @vite-ignore */ LIB)`。
- ビルド不要が最速：www.ortho-earth.com 配下なら CDN 直import、他ドメインなら npm/zip の `lib/`＋`assets/` を self-host（静的ファイル・バンドラ不要）。

## 最小テンプレ（コピーして始める）

```html
<link rel="stylesheet" href="https://www.ortho-earth.com/japan/lib/ortho-japan.css">
<div id="map" style="width:100%;height:100vh"></div>
<script type="module">
  import orthoJapan from "https://www.ortho-earth.com/japan/lib/ortho-japan.js";
  const map = await orthoJapan({ target: "#map", view: "#13/35.68/139.76",
                                 assetBase: "https://www.ortho-earth.com/japan/" });
  map.gadget.search(); map.gadget.zoom(); map.gadget.compass();
</script>
```

## データを載せる（GeoPBF/gint）

geopbf は **SDK の named export**（1.0.3〜）＝ `npm i geopbf` も import map も createGeopbf も不要（SDK が初期化済み・出していない）。
npm の geopbf を同一ページに混ぜない（別インスタンス）。詳細＝llms.txt「データ知性層」。

```js
import orthoJapan, { geopbf } from ".../lib/ortho-japan.js";   // 同梱・初期化済み
const pbf = await geopbf(fileOrUrlOrGeoJSON, { name: "myapp/data" });   // gint は既定で焼かれる（opts.gint=false で抑止）
map.applyGintData(pbf, "mydata", true, { interactive: true });
map.onGintClick((fid, props, lnglat) => console.log(props));
```

- fid⇄自分のidの整列保証＝全propertiesに一意キーを入れてからエンコード。
- フィーチャ別スタイル＝`map.paintTable(u32, count)`（4×u32/fid: fill色/線色/(width*8)<<24|(radius*4)<<8|flags、flags bit0=visible）。点は線色欄が circle 色・radius が半径（0=描かない）。
  完成形（点をカテゴリ別に色分け・半径 8px。applyGintData 直後に同期で呼べる＝onReady 待ち不要）：
  ```js
  const feats = map.gintFeatures();                      // fid 整列の properties
  const u32 = new Uint32Array(feats.length * 4);
  const rgba = (r, g, b, a = 255) => ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  feats.forEach((f, fid) => { u32[fid * 4 + 1] = f.properties.category === "jr" ? rgba(30, 136, 229) : rgba(229, 57, 53);
                              u32[fid * 4 + 2] = ((8 * 4) << 8) | 1; });   // radius 8px・visible
  map.paintTable(u32, feats.length);
  ```
- minZoom：線/面を含むデータは範囲から自動（狭域 13〜14・全国 3）・**点だけは自動なし（全ズームで描く）**。onGintClick の lnglat＝カーソル位置（フィーチャ座標ではない）・**非ヒットでは呼ばれない**（海クリック解除＝mapEl click＋unprojectXY＋pbf.contain()）。
- 面のコロプレス＝`map.paint({ "fill-color": ["step", ["get","pop"], "#eff3ff", 1,"#bdd7e7", 4,"#3182bd"], "line-width": ["case", ["==",["get","id"], sel], 3.5, 0.9] })`
  （キー fill-*/line-*/circle-*・演算子は get/match/step/case/interpolate 等の Mapbox サブセット・色は #hex/rgb()。詳細＝llms.txt）。自分の値は**エンコード前**に properties へ。
- **URL 読込は proxy 経由**（罠台帳⑪）：1.0.3 以前は許可ホスト外・**自サイトの相対パス**とも 0 件で黙る＝`fetch(url)`→`new File([blob], "data.gpx")` を渡す。1.0.4〜は直 fetch へ自動フォールバック・相対パス可・失敗は例外。
- **チルトで層が消える**＝applyGintData に `drapeFill: true`（スタイル付き線/塗りを地形の上に描き続ける）。`drape:true` は別物（細い固定幅の地形沿い線）。チルト時の識別は海面基準＝setEditClick＋makeProjectorH の最近傍で。
- getHeight は 1.0.4〜ローダ着荷を待つ（1.0.3 以前は未着 0＝>0 まで再照会）。ガジェットの手綱＝shot().open()/composite()・qr().open()・measure().start()（llms.txt「map の公式面」）。

## 埋め込み（記事内ウィジェット等）の掟

- 容れ物は class で寸法・id は借りられて destroy() で返る。lang/theme の live 切替 API は無い＝`view: map.view.hash` を持って destroy()→再生成。
- **1.0.3 以前は WebGPU 起動後 20 秒以内の destroy() でホストページが reload される**（番犬タイマー・1.0.4 で修正）＝古い lib なら 21 秒待つか `?stay=1`。
- theme を指定すると palette は載らない（切替可にするなら view の c=dark）。contextmenu({items}) は既定 2 項目の**置換**。埋め込みでは URL ハッシュを書かない（urlHash:true で書く）。
- backend は `map.backend`、PLATEAU の読込合図は `map.on("plateau", e => e.phase)`（catalog→start→done。いずれも 1.0.4〜。1.0.3 以前はコンソール文字列＝llms.txt 罠⑯）。
- 画像アイコン等は **File/Blob をプロパティ値に直接**（BUFSへ一個書き・等価dedup・往復File復元）。
- スタイルの互換規約＝@プロパティ（@fill @stroke @width @icon @shape @text @size @tip @pop）。

## 検証してから納品する

- 自己判定HTML（結果を`<title>`にPASS/FAIL）→ headless Chrome の `--dump-dom` で読む。
- エンジン起動込みは仮想時間でなく**実時間+CDP**でtitleを監視（worker並走と仮想時計は相性が悪い）。
- 本番形の検定＝①エンジン再同梱がないこと（lib URL参照の確認）②実走で404ゼロ（worker 内の取得はページの Network に出ないことがある＝サーバ側の台帳も読む）。
- 雛形＝SDK 同梱 `verify-example.mjs`（npm: `node_modules/@ortho-earth/japan/sdk/`・zip: ルート。依存ゼロ・Node 22+）。
  `node verify-example.mjs http://127.0.0.1:4174/ 9555`＝title 実時間監視・スクショ・4xx 台帳・console。他プロセスと衝突しない devtools ポートを選ぶ。静的サーバは `npx serve`／Node 製を使う（`python3 -m http.server` は初回応答が ~50s 止まる環境があった）。
