---
name: ortho-earth-sdk
description: ortho-earth（ortho-japan）SDKで3D地球儀アプリを作る時に必ず読む。埋め込み・GeoPBFデータ読み書き・gint描画・罠台帳・検証の作法。SDK/地球儀/GeoPBF/gint/ortho-japanが話題に出たら発動。
---

# ortho-earth SDK で開発する

あなたは ortho-earth の 3D 地球儀 SDK（ortho-japan）を使ってアプリを作る。**最初に正典を読む**：

1. `https://www.ortho-earth.com/japan/llms.txt` — API面・罠台帳・検証作法の1枚正典（このスキルより常に新しい）
2. SDK zip 同梱の `README.md`（オプション表・埋め込み契約・出典義務）と `lib/ortho-japan.d.ts`（型。CDN＝
   `https://www.ortho-earth.com/japan/lib/ortho-japan.d.ts` からも読める）

## 鉄則

- **消費して、変形しない**。SDKの中身を書き換えたくなったら設計を疑う。gint系ハンドル
  （applyGintData/paintTable/onGintClick…）は将来 v2 の map.addGint() に置換されるので、
  **自作アプリ側の薄いモジュール1枚に必ず封じる**。
- **1ページ1マップ**。容れ物のidは"map"へ正規化される＝サイズ指定は#idセレクタ禁止。
- **出典表記は義務**。instruments の "attr" を消すならページ側で出典を明記。
- CSSは自動注入されない＝ `ortho-japan.css` の `<link>` を貼る。
- geopbf は SDK の export を使う。npm の geopbf を自分のバンドルに混ぜない（別インスタンス＝createGeopbf の呼び忘れで本番だけ死ぬ）。
  CDN libは external ＋ URL変数経由 `import(/* @vite-ignore */ LIB)`。
- ビルド不要が最速：www.ortho-earth.com 配下なら CDN 直import、他ドメインなら SDK zip を self-host。

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
- 画像アイコン等は **File/Blob をプロパティ値に直接**（BUFSへ一個書き・等価dedup・往復File復元）。
- スタイルの互換規約＝@プロパティ（@fill @stroke @width @icon @shape @text @size @tip @pop）。

## 検証してから納品する

- 自己判定HTML（結果を`<title>`にPASS/FAIL）→ headless Chrome の `--dump-dom` で読む。
- エンジン起動込みは仮想時間でなく**実時間+CDP**でtitleを監視（worker並走と仮想時計は相性が悪い）。
- 本番形の検定＝①エンジン再同梱がないこと（lib URL参照の確認）②実走で404ゼロ。
