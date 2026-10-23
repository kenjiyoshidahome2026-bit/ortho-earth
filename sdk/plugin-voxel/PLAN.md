# @ortho-earth/plugin-voxel の計画（2026-10-23 起票）

体積（Cesium 型）とブロック（Minecraft 型）を**同じ格子データ**から描き分ける plugin。手元のデータはまだ無い＝見本も作る。
作りは [plugin-splat](../plugin-splat/src/index.ts) と同じ：`definePlugin` → `registry.dataKinds.add("voxel")` → `map.addData(data, { kind: "voxel" })`。

## 設計の芯

- **描き手は同一フレームのオーバーレイ一つ**（render worker の WebGL 文脈は Chrome で 4 つまで＝層ごとに作らない・`addLayerId` で層を名乗る）。モジュールは依存ゼロ（import 文なし）。
- **方式は一つ・描き方は三つ**：格子を包む箱の裏面を描き、FS で光線を格子空間へ入れて DDA（Amanatides–Woo）で進む。
  - `render: "blocks"`＝最近傍・最初の空でないセルで止まる・面の法線で陰影（Minecraft 型）
  - `render: "volume"`＝三線形・色表＋不透明度で前から重ねる・不透明になったら打ち切り（Cesium 型）
  - `render: "iso"`＝しきい値の交差を二分探索で詰め・勾配を法線に
- **地形・建物に隠れる**：シーン深度 `sceneDepthAt()`（`ortho-core/src/depthout.ts`・対数深度）を w に戻して光線を打ち切る。WebGPU は `api.depth.gpuTexture(device)` を束ねる。
- **精度**：splat と同じ anchor＋ENU 基底・逆行列は CPU の float64 で作って毎フレーム渡す（RTE）。
- **地球の形**：既定は球・`?ell=1` で楕円体。region → ECEF は splat と同じく `api.rAx` に従う。

## 契約（第 0 段で予約・globe `src/voxel.ts` の `normVoxel` が検める）

```ts
VoxelData = {
  shape: "box" | "region",
  dims: [nx, ny, nz],                              // x が最も速く変わる並び（i + nx*(j + ny*k)）
  box?: { origin: [lng, lat, alt], size: [m, m, m], orientation?: [heading, pitch, roll] } | { transform: 列優先 4×4（局所 m → ECEF m） },
  region?: [w, s, e, n, h0, h1],                   // 度と m（3D Tiles の region と同じ並び・単位は度）
  values: Float32Array | Uint16Array | Uint8Array, // components 個ずつ（1＝スカラー・4＝RGBA 直）
  components?: 1 | 4, noData?: number, range?: [min, max],
}
```

plugin が無ければ `addData` は契約を検めてから投げる（`capabilities()["data.voxel"]` は "spec"）。

## 段取り

| 段 | 中身 | 目安 |
|---|---|---|
| **0 受け口の予約**（globe 本体） | `src/voxel.ts`（`normVoxel`）・`api/data.ts` の分岐・capabilities `data.voxel: spec`・`globe.d.ts` と `types/map.ts` の型・PLUGINS.md の予約節・`tests/voxel.mjs`・`t-plugin?v=voxel`・llms.txt を同コミットで | 半日 |
| **1 骨格・box・WebGL2** | `sampler3D` で box の格子。blocks／volume・色表（名前か stops）・range・opacity・depthTest・above・setVisible・remove。読み手は worker | 3〜4 日 |
| **2 WebGPU・region・断面** | WGSL 版（device と深度を共有）・`shape: "region"`・iso・`clip` の箱で断面・picking（CPU で同じ DDA を辿り `[i,j,k]` と値） | 3〜4 日 |
| **3 見本とデモ** | 合成 3 種（球・トーラス・ノイズの雲）・PLATEAU の街区を 2m ボクセル化（blocks）・震源密度の体積（quakes） | 2 日 |
| **4 3D Tiles の voxel** | `EXT_primitive_voxels`＋`EXT_structural_metadata` の property attributes → `meshdecode.ts` が検出 → `tiles3d.ts` がタイルごとに `addData({kind:"voxel"})`（splat と同じ経路）。implicit tiling は既存。fixture＝CesiumJS Specs の voxel tileset（Apache-2.0）。**仕様の今の版を先に確かめる** | 3〜4 日 |
| **5 大きな格子** | 64³ のブリック化・占有格子で空白飛ばし・3D Tiles の階層で LoD・時間次元を `map.clock` へ。後で cylinder・NetCDF／Zarr の読み手 | 4 日〜 |

第 1 段は WebGL2 から（Android は GL2 封印＝省けない・深度は貼った GLSL で読めて試しやすい・splat と同じ順）。

## 落とし穴（先に分かっている物）

- WebGPU の `r32float` は filterable でない → `r16float` に詰めるか補間を自前で。
- 3D テクスチャの上限＝WebGL2 は最低 256³。第 1 段は超えたら縮めて一度 warn、本対策は第 5 段。タッチ端末は GPU 160MB の予算に数える（`packages/ortho-core/fallback-ladder.md` も更新）。
- region の blocks は DDA が厳密でない（セル境界＝経線・緯線・等高度面）。第 2 段は等間隔サンプル＋最近傍で近似＝README に限界を書く。
- 本番ビルドで worker が消える（`sideEffects:false`）＝verify-prod ②b で確かめる。描き手の `new URL("./voxel-draw.js", import.meta.url)` は `scripts/lib/vite-app.mjs` の先回りに乗るか確かめる。

## 検定

- node：`normVoxel`・CPU の DDA とシェーダの答えの突き合わせ（golden）・region の座標変換。
- verify:ui `t-voxel`（WebGL2）／verify:webgpu：画素・地形の向こうで隠れる・picking。

## 進み

- [x] 第 0 段（2026-10-23）＝`packages/globe/src/voxel.ts`・`api/data.ts` の分岐・`plugin.ts` の `data.voxel`・`globe.d.ts` の `VoxelData`・PLUGINS.md／maplibre-compat.md §7・§9・検定 `tests/voxel.mjs`／`t-plugin?v=voxel`／`plugin.mjs`。llms.txt は japan SDK の物＝globe の plugin kind は載っていないので触らない
- [x] 第 1 段（2026-10-23）＝`sdk/plugin-voxel`（grid.ts／voxel-reader.ts／voxel-draw.ts／voxel-gl.ts／index.ts・README）・`t-pvoxel`（REALTIME に登録＝worker の動的 import は仮想時計で解決しない）・node 検定。
  決めた事＝`transform` は単位立方体 [0,1]³ → ECEF（列の長さが辺）・値は R8 に詰める（0＝空・pick の value は main が持つ元の値）・当たりパスは scissor で読む画素だけ（SwiftShader の全画面パスは秒単位＝往復 3 秒を越えて [] になった轍）。
  未検証＝本番ビルド（`moduleUrlAsChunk` が voxel-draw.js／voxel-gl.js を拾うか・reader worker が sideEffects:false で消えないか）＝第 3 段で見本のアプリに載せる時に verify-prod で見る。
- [x] 第 2 段（2026-10-23）＝`voxel-gpu.ts`（WGSL・device と深度の共有・r32uint の当たり）・`voxel-draw.ts` の選び・region（殻＝面ごとの外向きで winding を決める＝「中心から外」は丸みで corner が内向きになる轍）・iso（二分探索 6 回・勾配は A⁻ᵀ）・clip・`"style"` の軽い更新。verify:webgpu は WebGL2 と同じ画素値で PASS。
  決めた事＝region の既定は絶対高さ・blocks は 1/4 セル刻みの最近傍（DDA でない）・殻は球で作る（rAx は main に無い＝`?ell=1` の国規模 region は数 km ずれる＝第 3 段で rAx を worker へ渡す）・値は閾で切らない（iso は場の全体が要る＝閾は描き手が見る）。
- [x] 第 3 段（2026-10-23）＝見本の頁 `/globe/voxel`（apps/ortho-globe の voxel.html／voxel-page.ts／voxel.ts・`?v=cloud|torus|fuji|quakes`）。雲（ノイズ・volume）・トーラス（距離場・iso）・富士山（`map.sampleTerrain` を 333 m×48×48・100 m 刻みのブロック）・地震（`/quakes/archive.geopbf` 68 MB を日本の箱 0.25°×0.25°×20 km に数えて region の体積・5.4 万件）。つまみは全部 `setProps` の "style"。rAx を prepare へ（`map.ellipsoidOn()`）。verify-prod（static＝生の .ts なし・run・address・console）PASS＝本番ビルドの検札済み。og 画像は `scripts/og-shot.mjs voxel` で撮った。
  踏んだ罠＝①`?scene=` は本体の scenes の口と衝突（JSON を取りに行く）＝`?v=` に。②場面の切り替えで remove → すぐ addData すると同じ名のオーバーレイの片付けと新しい登録が競い、新しい層が描かれない＝plugin の `release()` に猶予（`OVERLAY_LINGER_MS`＝250 ms・その間の acquire は続投）。③`flyTo` は離陸で秒単位＝場面の移動は `easeTo`。④`sampleTerrain` は 1 点 5 ms＝点数を 2304 に絞り 8 回に分けて進みを出す。
  見送り＝PLATEAU の 2 m ブロック（globe の家は地域を持てない＝japan のアプリに置く時に）・www の一覧（demos.json）への登録＝本番に出てから `npm run thumbs -w www -- --only=voxel` でサムネを撮って足す。
- [x] 第 4 段（2026-10-23）＝3D Tiles の voxel。仕様の今の版（cesium-native 0.62 の実装で確認）＝`EXT_primitive_voxels { shape（KHR_implicit_shapes の索引）, dimensions, padding{before,after}, noData{属性: [値]} }`・mode 2147483647・値は独自の属性（x が最速）・形は `KHR_implicit_shapes.shapes[]`（box.size・原点が中心）か shape の拡張 `EXT_implicit_ellipsoid_region`（rad・min/max の経緯度と高さ）／`EXT_implicit_cylinder_region`（未対応）。Cesium の tileset の経路＝root.content の `3DTILES_content_voxels { class, dimensions, padding }`＋タイルの境界体積。
  実装＝meshdecode `voxelPrim` → tiles3d-decode／model-worker → gadget tiles3d がタイルごとに `addData(kind "voxel")`（splat と同じ骨）。fixture 2 経路・node 15 件・`t-tiles3d-voxel`（verify:ui／verify:webgpu・noplugin）。
  踏んだ罠＝①`decodeTile3D` の「描く物なし＝null」の条件に voxels を足し忘れると層が立たない ②検定頁の配置（北東の箱が東の region の中に食い込んでいた）③面の陰影（0.55 倍）で色の判定が落ちる＝色相で判定。
- [ ] 第 5 段（大きな格子＝ブリック・LoD・時間・NetCDF／Zarr）
