# 層の線引き — core は硬く、アプリは柔らかく（2026-09-23 裁定）

このモノレポの部品は四つの層に分かれる。**上ほど硬く（関門・型・版で守る）、下ほど柔らかい（殻＝自由に変えてよい）**。
新しい機能は「どの層か」を先に言ってから書く。

| 層 | 硬さ | 置き場 | 中身 |
|---|---|---|---|
| core | 硬い | `packages/ortho-core`（`@ortho-earth/core`） | 描画・カメラ・投影・gint・overlay 契約。地域を知らない |
| globe | 硬い | 今は `apps/ortho-japan/app.js` の `createGlobe`（→ 段階 2 で `packages/globe`） | 地球儀のホスト＝起動・世界層（ハイプソ／admin0／湖／河川／海洋境界／星）・地域非依存ガジェット（spotlight／outline／symbols／anno／extrude／heatmap／cluster／model／raster／measure／shot／palette…）・SDK の型（d.ts）・i18n は英語基底・関門 |
| region パック | 硬め（データ） | `packages/jp`（`@ortho-earth/jp`）＋日本だけの部品 | 地域の申告（dtm／buildings／basemap／rasters／attribution／view／home／search／poi／rail）と、日本だけの部品（mesh＝PLATEAU・POI・地理院検索・N02・airports・e-Stat＝`map.estat`・jp/codes・層チップ） |
| apps | 柔らかい | `apps/*` | 殻。`japan`＝globe＋jp パック＋日本 UI。`world`／`equal`／`census2020`／`solar`… |

## z の線（本人 2026-09-23）

- **globe は基本 z<8**＝世界データ（Natural Earth 10m・全球ハイプソ・湖・河川・海洋境界）が持つ所まで。これが地球儀の実力であり天井。
- **そこから先は地域パックの拡張**＝japan なら z≥6.5 から地理院ベクタ基図・DEM10B・PLATEAU・POI・地理院検索が入る（入場点は地域の申告 `basemap.tileMinZoom`／`BASEMAP_MINZOOM` が持つ）。両方ある帯（6.5〜8）は地域が勝つ＝世界の色は基図の入場点で退場する。
- ゆえに **japan＝globe＋拡張（z≥6.5）＋日本 UI**。world のような世界のアプリは globe だけを使い、`zoomMax: 8` で天井を明示する。

## 掟

1. **globe と core に地域名を書かない**（JP・日本・地理院・GSI を core/globe のコードに置かない）。地域は宣言（`opts.region`）とパックで足す。
2. **消費者は公開面（`sdk/ortho-japan.d.ts`）だけを使う**。`map.estat` のような地域の口は japan の拡張面であって globe の口ではない。`dbgHost`／`__*` はアプリから触らない。
3. **内製アプリはエンジンを自分の束に焼く**（本番だけ `/japan/lib/` を実行時に食う二重構成はしない）。japan を出さなくても各アプリが自分の deploy で進み、japan を出しても他が変わらない。
4. **core／globe の変更は関門＋d.ts＋版**（verify:webgpu／verify:ui／型の更新／SDK の版上げ）。apps は自由＝各アプリの verify:prod だけ。
5. 地球儀が要るアプリは `createGlobe(opts)` を使う（`orthoJapan()` は「globe＋日本の申告」の薄い包み）。

## 段階（可逆）

- **1（済 2026-09-23）** 文書で線を引く。`createGlobe` を export（region 省略＝地球儀）。world はそれを使う。中身は動かさない。
- **2** `app.js` を `packages/globe` へ移し、japan は薄い包み（`orthoJapan = o => createGlobe({ region: JP_REGION, …jp の部品, …o })`）。e-Stat／N02／mesh／POI／検索は jp 側へ。関門を globe 用と japan 用に二分。
- **3** equal の palette／labels を globe の worldpal／labels と一本化（world の色定数の手写しを無くす）。

## 今の「混ざり」の目録（段階 2 の作業表）

`apps/ortho-japan/app.js`（約 3,000 行）に同居しているもの：`REGION_*`／`REGIONLESS` 41 箇所、e-Stat／N02／GSI／地理院 43 箇所、`JAPAN_VIEW`、airports.json、`gadget("japan")`（列島へ戻る）、`gadget("mesh")`（PLATEAU）、`gadget("search")`（地理院）、`gadget("poiedit")`、`overlay.js`（e-Stat 小地域）。
`gint/layers.js` には世界層（admin0／世界の線）とユーザー層と e-Stat 系が同居。
