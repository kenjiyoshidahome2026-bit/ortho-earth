# メルカトル・ラスタタイルを v2（ortho-core）へ ── 移植計画と実装記録（2026-09-21）

v1（packages/ortho-map）の機能でまだ v2 に無かった「ラスタタイル（XYZ 画像）の表示」の移植。
**裁定（2026-09-21 本人）**：①基図＋重ねの両方（公共のサーバーレス源）②方式 B′ ③ラスタ基図では塗りを伏せ線と注記は残す
④⑤⑥⑦は案のとおり（Google 直・Bing 代理・8192 下地・円クリップは捨てる／`?pm=` は tileType 自動判別＋`?xyz=`／v1 凍結／COG 統一は後回し）。
同日に実装・検定済（§7）。以下 §0〜§6 は叩き台の原文（設計の根拠として保存）。

## 7. 実装記録（2026-09-21・裁定どおり B′）

- **エンジン**：`src/raster-src.js`（プロバイダ契約 xyz/pmtiles/port・`expandTemplate`・`normalizeSpec`）／`src/raster.js`（`createRaster`：selectLOD 選抜・
  取得列（距離順・並列 8／LOW_MEM 4）・在庫（バイト予算 64MB／24MB・LRU）・祖先フォールバック（v1 の親 uv＝無いタイルは親を要求）・格子メッシュ
  `buildTileMesh`（(z,y,n) 共有・n=16/24/32）・描画リスト＝`renderer.setRasterDraws`）／`src/pmtiles-src.js`（`tileType`・`fetchPMTilesRaw`・ラスタは
  ベクタ配管の門で空タイル）。**テクスチャは配列でなくタイル 1 枚 1 テクスチャ**（v1 と同じ・per-draw のバインド＝枚数 100〜300 で十分軽い。配列化は後日の最適化）。
- **GL2**：`RASTER_VS`＝`FILL_VS` の derive（a_uv・u_tileOff・u_uvT）・`RASTER_FS`＝標本化＋霧・unit10。**WebGPU**：`RASTER_WGSL`＝`FILL_WGSL` の deriveWgsl・
  group(2)=per-tile UBO（dynamic offset・MAX_RAS=800）・group(3)=bglPlTex 流用・Frame スロット `raster`（origin=cam.center）。
- **描画位置**：`under`＝地形パス直後・海面下/湖/等高線/塗りの前（山岳ビューは塗りと同じ「地形深度でテストだけ」）／`over`＝塗りの後・**最初の線の前**に一度
  （classic/multi_draw 両経路・線が無い画面は塗りの後）。`hideFills`（under 既定）＝両経路の fill op を skip＝線と注記は残る。
- **render worker**：`createRaster` を terrain と同じく常駐・毎 frame `raster.update(glCam, W, H, { groundR })`・set cmd `rasterAdd/rasterRemove/rasterSet`・
  `rasterStats`・mem 台帳 `raster` バイト・`rasterInfo/rasterError` を main へ。
- **アプリ（ortho-japan）**：`map.raster`（add/remove/set/list/info/stats/onChange＋カタログ `select/toggle/selected`＝`?r=` 同期）／ローカル容器＝
  `rastertiles-worker.js`（worker.js の役割 `rastertiles`・main 所有・MessagePort を render worker へ）／`?pm=` ラスタ自動判別・`?xyz=`・`?r=`／出典行
  「Imagery: …」（自己申告を消毒・無ければホスト名）／取り込み表 `.mbtiles`・`.gpkg`（タイル表が無ければベクタ本道へ）／HUD の raster 行。
- **外から定義できる口**（本人要望）：地域パック `REGION.rasters`（jp/region.js＝地理院 std/pale/写真/色別標高＝基図・陰影/洪水浸水想定＝重ね）／
  URL（`?xyz=` `?pm=` `?r=`）／公開 API `map.raster.add`（自前契約の URL テンプレ＝Google/Bing 等はここ・ラスタ PMTiles・MessagePort）。
- **ガジェット**：`gadgets/raster.js`（切替＝基図ラジオ＋重ねチェック・#search 型の小パネル）／`gadgets/globe.js`（**ミニ地球儀＝v1 draw_globe 移植**・
  右下・視野の枠・NE 110m land・クリックで飛ぶ・z≤8）。site.js に搭載。
- **検定**：`packages/ortho-core/tests/raster.mjs`（Node：テンプレ/正規化/メッシュ/祖先 uv/管理層一周）／`apps/ortho-japan/tests/t-raster.html`
  （REALTIME・verify:ui と verify:webgpu の両方＝MessagePort 合成タイル・塗り伏せ・線残存・出典・set/remove・ラスタ PMTiles を焼いて読む）。
  実データのスクショ（地理院 標準地図 z12 真俯瞰／写真＋陰影 富士 62° チルト／洪水浸水想定 重ね）で目視済。
- **残**：モバイル実機（LOW_MEM 予算 24MB の体感）・テクスチャ配列化（バインド削減）・非メルカトルのタイル行列・COG の provider 統一（裁定⑦＝後回し）。

---

---

## 0. 結論（先に）

- **v1 の base.js / image.js は「持ち上げて載せ替え」できない**。d3 直交投影のスクリーン空間四角形＝ノード依存
  （2D・チルト無し・地形無し）。v1/v2 移植モデルどおり、**知見だけ携えて v2 のノード（mat4／球／worker／地形）で再導出**する。
- v2 には既に「単一の等経緯度 RGBA を球・地形・塗りの三つの FS でドレープする」**COG スロット**（unit9・GL2/WGSL 両対応）がある。
  これがラスタ表示の最短の足掛かりであり、同時に「1 枚アトラス・静定時 re-warp・単一スロット」という限界も持つ。
- 推奨方式＝**B′「テクスチャ付き塗り op」**：メルカトルタイル 1 枚＝原点相対 dLL の格子メッシュ（uv は CPU でメルカトルから算出）を、
  既存の塗り VS（球・楕円体・地形リフト・フォグ・RTE 原点）に載せ、FS だけテクスチャ標本化に差し替える。
  **CRS はシェーダに入れない**（cog.js の宣言どおり）・地形ドレープと建物遮蔽は塗りと同じ経路で自動継承・GL2/WGSL の並行は塗りと同型。
- **PMTiles との関係**：v2 の PMTiles 配管（pmtiles-src.js）は現在 **MVT 専用**。pmtiles.js 自体はヘッダの `tileType`
  （MVT/PNG/JPEG/WebP/AVIF）を返すので、**「tileType≠MVT ならバイト列→ImageBitmap」の分岐 1 本**でラスタ PMTiles が同じ `pmtiles://` 口に乗る。
  ラスタ GeoPackage（`openGpkgTiles`）・MBTiles（`openMBTiles`）・COG（`renderXYZ`）も同じ **z/x/y プロバイダ契約**に揃える＝9/12 の
  「ortho-core に画像タイル層が無い」裁定待ちを、この一つの層で一括解消する。

---

## 1. 現状

### 1.1 v1（packages/ortho-map）＝凍結・発表用
| 臓器 | 何をしているか | ノード依存度 |
| :-- | :-- | :-- |
| `workers/base.js` | 基図。8192×4096 の下地画像（whiteEarth / naturalEarth 等の webp・bucket `GIS/base`）＋ XYZ タイル。視野 bbox（pad 2）から z を決め、高緯度行は Y2T/Y4T 表で 1〜2 段粗く、**祖先 3 段フォールバック（親テクスチャの部分 uv）**、blob-URL サブ worker で fetch→ImageBitmap、`drawn` で視野外を破棄、`base` 切替でセッション番号を進めて在庫を全捨て | 選抜・描画とも d3 投影のスクリーン空間＝**依存大** |
| `workers/image.js` | 画像重ね。bbox 矩形（dx×dy 分割）と円クリップ。minZoom/maxZoom | 同上 |
| `modules/layers.js` | カタログ 9 本：whiteEarth／Google 4 種（`mt{0-3}.google.com` 直）／OSM 2 種（Bing は `tiler.ortho-earth.com` 経由）／地理院 std・pale（z<7 と日本域外は OSM へ） | 純データ |
| `workers/orthoGL2.js` | `createTileTexture`（mips・CLAMP_TO_EDGE）・`drawTile`（TRIANGLE_STRIP 4 頂点） | GL 断片は再利用可 |

利用者：apps/gishub・www・viewer・gishub-jp（`setBase`）。**v1 は触らない**（凍結）。

### 1.2 v2（packages/ortho-core）＝画像タイル層は無い
| 既存の臓器 | 使えるか |
| :-- | :-- |
| **COG スロット**（`setCogTex`／`cogTexMix`）：等経緯度 RGBA 1 枚＋bboxLL。GLOBE_FS（低ズーム床・絶対経緯度）／TERRAIN_FS（メッシュ窓 uv）／塗り FS（原点相対×f64 前計算）。WGSL 同型（`cogTex0`／`F.cogP`／`GCG`） | 「塗りの上・線/建物/ラベルの下」という**重ね位置**と、三つのパスに標本点があるという**配線**は流用対象。単一スロット・2048²・静定 re-warp が限界 |
| `gadgets/cog.js`：窓モデル（全域→静定 0.4 s でビュー窓へ絞る）・生タイル LRU | 「静定で重い層を発火」の型はラスタでは使わない（連続追従が要る）。LRU の型は流用 |
| `selectLOD`（tilecover.js）：距離 LOD・sticky・groundR（地形リフト球）・minZ/maxZ・tilePx | **そのまま流用**（純関数・export 済）。256px タイルなら tilePx≈300 |
| `tilemanager`：coverage 門・バイト予算 LRU・abort・祖先フォールバック（`readyWithFallback`） | 型を写す（ジオメトリ経路は不要なので別実装・小さい） |
| `terrain.js`：render worker 内で自前 fetch（altpbf）→アトラス cell を `texSubImage2D` | **render worker 常駐モジュールの前例**。ラスタ層も同じ置き場 |
| 標高アトラス cell 管理（stage／commit ダブルバッファ） | テクスチャ配列のスロット管理の型 |
| 模型テクスチャ（`plateauTexture`：mips＋異方性 8） | タイルテクスチャの設定はこれと同じ |
| 同一フレーム overlay（`map.overlay`） | 別 OffscreenCanvas・深度無し・ラベル直下＝**基図には不可**。「写真を最前面に」用途なら可だが本計画では使わない |

### 1.3 PMTiles と geopbf の現在地
- `pmtiles-src.js`：`fetchPMTiles`→`decodeMVT` 固定。Range プローブ（206/200 自動判別）・アーカイブ毎の索引キャッシュ・`pmtilesInfo`（bbox/zoom 域/vector_layers/attribution/name）。**tileType は読んでいない**。
- ortho-japan `?pm=`：ベクタ前提（`style-pm.js` が vector_layers から規則生成）。ラスタ PMTiles を渡すと metadata に vector_layers が無く「規則なし」で沈黙。
- geopbf 側は読み口が揃っている：`openGpkgTiles(u8, table)`（xyz 判定・bboxLonLat・has/get/mimeOf）／`openMBTiles(u8)`（同形・TMS 反転済）／`openCog(...).renderXYZ(z,x,y)`（bitmap）。
  書き口 `toPMTiles` は MVT 専用（gzip 前提）。
- formats.md（9/20）の「未対応・裁定待ち：ラスタ GeoPackage / MBTiles の画像タイル層（ortho-core に画像タイル層が無い）」が本計画の対象。

---

## 2. v1 から持つ知見／捨てるもの（node-independent / node-dependent）

**携える（知見）**
- 祖先フォールバック＝親テクスチャの部分 uv（`xx/nz`）。v2 では「op のテクスチャ id と uv 矩形を親に差し替える」だけで同じ。
- CLAMP_TO_EDGE＋mips（隣接タイルの滲み防止・斜め視のちらつき防止）。
- 取得は worker・ImageBitmap で転送・基図切替は世代番号で在庫を全捨て（`layerSession`）。
- dx×dy 分割＝「1 タイル 1 四角形では球に乗らない」→ v2 では格子メッシュ細分として一般化。
- minZoom/maxZoom・出典は**層の属性**（カタログ側が持つ）。

**再導出する（ノード依存）**
- 選抜：視野 bbox＋pad＋緯度表 → `selectLOD`（距離 LOD・地形リフト球・sticky）。
- 描画：スクリーン四角形 → 原点相対 dLL メッシュ＋塗り VS（球・楕円体・地形リフト・フォグ）。
- 可視判定：反時計回り検査 → カリング／深度。
- 8192×4096 下地画像 → **捨てる**（v2 は全球ハイプソ＋NE 国界＝新しい概念で古いを手放す）。
- `tiler.ortho-earth.com`（Bing 代理）→ **捨てる**（鯖無し規律・他社 ToS）。Google 直タイルも v2 のカタログに入れない（利用規約の観点）。
- 円クリップ重ね（image.js 円モード）→ 利用者が無ければ捨てる（裁定④）。

---

## 3. 設計

### 3.1 プロバイダ契約（z/x/y → 画像）＝「PMTiles との関連」の答え
```
source = {
  kind: "xyz" | "pmtiles" | "gpkg" | "mbtiles" | "cog",
  tileSize: 256 | 512, minZoom, maxZoom, bbox: [w,s,e,n] | null, tms: false,
  attribution, name,
  get(z, x, y, signal) → Promise<ImageBitmap | null>,   // null＝正当な「無い」（404・索引外・圏外）
  close()
}
```
| kind | 実装 | 置き場 |
| :-- | :-- | :-- |
| xyz | URL テンプレ `{z}/{x}/{y}`（`{-y}` で TMS）。`fetch(cache:"force-cache")`→blob→`createImageBitmap`。404→null。bbox は呼び出し側申告（地理院 JP_COVERAGE と同じ外付け知識） | render worker 直（terrain.js と同じ） |
| pmtiles | `pmtiles-src.js` に `fetchPMTilesRaw`（`getZxy` の生バイト）を足し、`pmtilesInfo` に `tileType` を追加。**tileType≠MVT でラスタ**。bbox/zoom 域は自己申告（初めにデータありき） | render worker 直（pmtiles.js 動的 import は tileworker と同じ） |
| gpkg / mbtiles | `openGpkgTiles`／`openMBTiles`（既存）。`xyz:false`（非メルカトル行列）は対象外＝落として言う | **プロバイダ worker**（main が生成し MessagePort を render worker へ＝入れ子 worker 禁止の掟）。File は構造化クローン可 |
| cog | `renderXYZ` 既存 | 後回し（現 cog ガジェットで足りる。統一は利点が実証されてから＝裁定⑦） |

AVIF は `createImageBitmap` 可否を起動時に 1 回試験して非対応なら source 生成時に落とす。

### 3.2 描画（推奨 B′）
- **1 タイル＝格子メッシュ**：n×n（n＝16、z<4 は 32）。頂点＝原点相対 dLL（度）＋uv。uv の v は **CPU でメルカトル y から**
  （`v = (merc(lat) − merc(north)) / (merc(south) − merc(north))`）。副格子内は線形補間＝2 次誤差＝16 分割で不可視。
- **VS＝塗り VS と同じ**（`a_delta`→球/楕円体→地形リフト→u_mvp）。**FS＝新設**（`texture(uv) × opacity`＋フォグ・premultiplied）。
  新しい小さなプログラム対 `rasterProg`（GL2）／`rasterPipeline`（WGSL）。塗りプログラムは触らない。
- **テクスチャ＝2D 配列 1 本／source**（`TEXTURE_2D_ARRAY`／`texture_2d_array`・層数 256・tileSize²・mips・異方性）。
  op は層 index を頂点属性で持つ＝**1 バインド 1 ドロー**。スロット LRU＝標高アトラス cell と同じ型。
- **祖先フォールバック**：ready でない枠は最寄りの ready な祖先の層 index＋部分 uv で描く（v1 の知見そのまま）。
- **重ね位置**（順序は op 単位）：`order:"under"`＝塗りの前（基図・ハイプソを覆う）／`order:"over"`＝塗りの後・線の前（COG と同位置＝写真・ハザード等）。層は複数可（name で Map）。
- **精度**：原点＝タイル集合の再ベース原点（`buildScene` と同じ流儀）。経度差は ±180 へ畳む（gint 経度周期の轍）。
- **地形貫き**：16 分割で z≥8 は十分。低 z で大タイル×チルトは霞の彼方（フォグ）。足りなければ f8f26d9d の VS インスタンス細分を流用。
- **極**：メルカトルは ±85.05° まで。uv 圏外の画素は素通し（`cogTexMix` と同じ）＝極冠は球色（ハイプソ）が自然に残る。

### 3.3 選抜・在庫・予算（render worker 常駐 `raster.js`＝`createRaster({renderer, requestDraw, source, order, opacity, lowMem})`）
- 毎フレームの cam で `selectLOD(cam, W, H, {minZ: source.minZoom, maxZ: source.maxZoom, tilePx: 300, groundR, sticky})`。
- 取得キュー：中心距離順・視野外は abort・3 回失敗で諦め（tilemanager と同じ）。coverage 門＝`tileOutsideCoverage`。
- GPU 予算：256²+mips≈341 KB／枚。desktop 64 MB（≈190 枚）／LOW_MEM 24 MB。**mem 台帳（?hud=1）に行を足す**。
- 静止で描画停止のエンジン＝画像到着で `requestDraw`。基図切替＝世代番号で全捨て（v1 `layerSession`）。

### 3.4 アプリ側（ortho-japan）
- `BASE_SOURCE` 記述子に `kind:"raster"` を追加。`?pm=` は **tileType で自動判別**（ラスタなら style-pm を通さず raster 基図へ）。
  URL テンプレは新パラメータ（名前は裁定⑤・例 `?xyz=`）。
- **地域パックがカタログを持つ**（`jp/region.js`：`rasters:[{id, name(i18n), tileUrl, minZoom, maxZoom, coverage, attribution}]`）。
  日本＝地理院 std／pale／seamlessphoto（空中写真）／hillshademap／ハザード系（洪水浸水想定等）。**エンジンに日本固有 0 行**（9/17 の切り出しと同じ）。
- 切替ガジェット（v1 の Layers ドロップダウン相当・四戒に従う・遅延ロード・zoom 域宣言）。
- ドロップ：`.gpkg`（feature 層が無く tiles 表がある）／`.mbtiles`／`.pmtiles`（ラスタ）→ raster 層（bbox へ飛ぶ）。ベクタ MBTiles は対象外（別項目）。
- ラスタ基図 ON 時のベクタ塗り：`hidden` 集合で塗り層を伏せる（線・注記は残す）か、chips に任せるか＝裁定③。
- 出典：source.attribution を既存の消毒→attrZone へ。

---

## 4. 方式比較（裁定②）

| | A. COG スロット拡張（窓アトラス） | **B′. テクスチャ付き塗り op** | C. 画素ごと間接参照（仮想テクスチャ） |
| :-- | :-- | :-- | :-- |
| 仕組み | XYZ→等経緯度窓へ CPU warp→`setCogTex` | タイル＝dLL 格子メッシュ＋uv・塗り VS 流用・FS 新設 | 球/地形/塗り FS で lon/lat→メルカトル→索引→配列テクスチャ |
| エンジン改修 | **0**（ガジェットのみ） | 小（プログラム対 1・配列テクスチャ・op 種 1・両バックエンド） | 中（3 FS×2 バックエンド・textureGrad・索引テクスチャ） |
| 追従 | 静定後 0.4 s・移動中は古い窓 | 連続（タイル到着で即） | 連続 |
| 解像度 | 2048² を窓に伸ばす＝チルトで甘い | タイル原寸・mips・異方性 | 原寸・mip は手計算 |
| CRS の置き場 | CPU | **CPU**（宣言どおり） | **シェーダ**（宣言に反する） |
| 地形ドレープ・建物遮蔽 | 継承 | 継承（塗りと同経路） | 継承 |
| 複数層 | 単一スロット | 複数 | 複数（索引の重ね） |
| 精度 | 実証済（f64 前計算） | 塗りと同じ RTE | 深ズームで要工夫 |
| 位置づけ | **Phase 0 の実証**（プロバイダ層の先行検証に使える） | **本命** | 見送り |

---

## 5. 段階計画と検証

| 段 | 内容 | 検定 | 規模感 |
| :-- | :-- | :-- | :-- |
| 0（任意） | 裁定①〜⑦。プロバイダ契約だけ先に作り、cog ガジェットの窓へ XYZ を warp して球に出す（エンジン無改修の実証） | Node：source 正規化・gpkg/mbtiles/pmtiles(raster) 固定資料 | 半日〜1 日 |
| 1 | `packages/ortho-core/src/raster-src.js`（契約＋xyz/pmtiles）・`pmtiles-src.js` に tileType/raw・geopbf の gpkg/mbtiles を契約へ包む | `tests/t-raster-src.mjs`（fetch モック・writePMTiles に tile_type=PNG を開ければ往復検定） | 1 日 |
| 2a | GL2：`rasterProg`・配列テクスチャ・`set("rasterTex")`/`set("rasterScene")`・`raster.js`（選抜/在庫/予算/フォールバック） | CDP スクショ台＋ローカル静的タイル（z/x/y を焼いた色分けタイル＝縫い目・向き・y 反転を目で検定）・`?gl2=1` | 1〜2 日 |
| 2b | WGSL 並行（`texture_2d_array`・同じ op 契約） | `verify:webgpu` に 1 本追加 | 1 日 |
| 3 | ortho-japan：記述子 kind raster・`?pm=` 自動判別・新パラメータ・jp カタログ・切替ガジェット・ドロップ・出典・mem 台帳・LOW_MEM 予算 | `verify:ui` に t-raster（REALTIME・ローカルタイル）・実機（Air3 コールド・XS） | 1〜2 日 |
| 4 | formats.md 更新・README（geopbf のラスタ容器が「表示できる」へ）・ロードマップ item・栞 | 全関門緑 | 半日 |

⚠ 轍：worker 内 import は `verify:ui` の仮想時間で解決しない（REALTIME 頁）／Lighthouse は IDB 全消去／`?gl2=1` は iframe に継承させる／本番 lib は build:lib 再ビルド。

---

## 6. 裁定一覧（本人へ）

1. **用途**：ラスタを v2 に「基図としても」持つか。(a) 基図＋重ね（推奨・公共のサーバーレス源に限る） (b) 重ねだけ (c) 持たない（COG 窓で足りる）
2. **方式**：B′（推奨）／A／C。
3. **ラスタ基図 ON 時のベクタ塗り**：自動で伏せる（推奨・線と注記は残す）／chips 任せ。
4. **v1 カタログの取捨**：地理院 std/pale＝持つ。空中写真・陰影・ハザード＝新規に持つ。OSM＝任意 URL としては可・既定カタログに入れない。Google 直・Bing 代理・8192 下地画像・円クリップ＝捨てる。
5. **入口の名前**：`?pm=` は自動判別で兼用（推奨）。URL テンプレの新パラメータ名（例 `?xyz=`）。
6. **v1 は凍結のまま**（gishub/www/viewer は v1 のまま・移設は別項目）＝前提の確認。
7. **COG の統一**：cog ガジェットを z/x/y プロバイダへ寄せるのは後回し（推奨）。

裁定が出れば Phase 1 から着手。Phase 0 は「先に球で見たい」なら挟む。
