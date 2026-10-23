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
- [ ] 第 1 段
