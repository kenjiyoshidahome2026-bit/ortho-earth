# ortho-earth ⇄ Unreal Engine 5.6 以降（5.8.4 で確認） ── データの往復の設計（2026-11-08 起案）

**目的**：Unity と同じ往復（[unity-roundtrip.md](unity-roundtrip.md)）を Unreal Engine 5.6 以降（5.8.4 で確認）でもできるようにする。
ortho-earth のデータ（地形・PLATEAU 建物と属性・点群）を Unreal のレベルに持ち込み、Unreal で作った模型を地球儀に置く。
**本人の裁定（2026-11-08）**：Unreal は 5.6。Unity も Unreal も**プラグインの形**にする（`plugins/unity`・`plugins/unreal`）。点群は LAS も出す（重くてもよい）。

## 0. 結論（先に）

- **受け渡しは Unity と同じ**：`ortho-export` の出力フォルダ（`anchor.json`・`terrain.glb`・`buildings.glb`・`buildings.attributes.json`）を変えずに使う。
  約束（錨・GLB の中は (E, U, −N)・`asset.extras.orthoEarth`）も同じ 1 つ＝`plugins/spec/` の JSON Schema が正本。
- **Unreal の軸＝X 東・Y 南・Z 上・cm**（左手系・Cesium for Unreal と同じ）。Unreal の glTF インポーター（Interchange）は glTF (x, y, z) を Unreal (x, z, y)×100 にするので、
  ortho-export の GLB は**そのままこの向きで入る**＝Unity（glTFast の X 反転を 180° のノードで戻す）と違って補正のノードは要らない（§2・実機で確かめる）。
- **点群は LAS**：Unreal 標準の LiDAR Point Cloud プラグインは PLY を読まない（LAS・LAZ・E57・XYZ）。`/japan/pointcloud` に「LAS（点・Unreal 向け）」を足した（`apps/pointcloud/pc-las.ts`）。
- **プラグイン**：`plugins/unreal/OrthoEarth`（C++・.uplugin・Runtime と Editor の 2 モジュール）。メニュー **Tools > Ortho Earth > Place export folder…** と **Export selection to GLB…**。
- ortho-earth 側（`decodeModel` が `extras.orthoEarth.anchor` を読む・`glbconv`）は**直さない**。Unreal の glTF Exporter も glTF の約束で書く。

## 1. 今あるもの（そのまま使う）

| 物 | 場所 |
| --- | --- |
| 範囲を GLB に焼く CLI | `sdk/ortho-export`（`anchor.json` に `unreal` の注記を足しただけ） |
| 点群の書き出し | `apps/pointcloud/pc-ply.ts`（Unity 向け PLY）＋ **`pc-las.ts`（Unreal 向け LAS・新）** |
| GLB を地球儀に置く・錨を読む | `packages/globe` の `gadget.model`／`decodeModel`、`sdk/glbconv` |
| 受け渡しの約束 | **`plugins/spec/anchor.schema.json`・`attributes.schema.json`（新）**、検定 `node plugins/spec/check.mjs`（`npm run test:plugins`） |

## 2. 座標の約束（Unreal）

| 系 | 手 | 上 | 北 | 単位 |
| --- | --- | --- | --- | --- |
| ENU（中立） | 右 | Z | +Y | m |
| glTF（ファイル） | 右 | Y | −Z | m |
| Unity（Place の後） | 左 | Y | +Z | m |
| **Unreal（錨の Actor の下）** | 左 | Z | **−Y** | **cm** |

- ENU → Unreal：`(X, Y, Z) = (E, −N, U) × 100`。glTF → Unreal（Interchange）：`(x, y, z) → (x, z, y) × 100`＝`(E, U, −N) → (E, −N, U)`＝上と同じ。
- **確かめること（UE 5.6 以降の実機・5.8.4 で確認）**：Interchange の glTF の軸の写しが (x, z, y) か。違えば Place が 1 つの回転を挟む（Unity と同じやり方）。見本の四隅と点群の 4 点（§6）で分かる。
- heading（北から時計回り）＝Unreal の Yaw（上から見て時計回りが正）と同じ向き＝変換不要。
- 錨どうしの差：Place は 2 つ目の錨を 1 つ目の錨の Actor の子にし、差を**平行移動だけ**で足す（Unity と同じ・数百 m なら mm）。
- 大座標：Unreal 5 は LWC（double）なので数 km の街区でも精度の問題は無い。錨は Actor の原点。

## 3. ortho-earth → Unreal（Place）

`plugins/unreal/OrthoEarth/Source/OrthoEarthEditor/Private/OrthoEarthPlace.cpp`。

1. `anchor.json` → `AOrthoEarthAnchor`（lon/lat/楕円体高/heading・geoid・bbox・出典）。レベルに錨が無ければ原点、あれば §2 の差だけずらして子に。
2. `*.glb` → Interchange の ImportScene（「レベルに読み込む」と同じ・ダイアログなし）。資産は `/Game/OrthoEarth/<フォルダ名>/<ファイル名>/`。出来た Actor の根を錨の子に。
3. `buildings.attributes.json` → `UOrthoEarthAttributeTable`（データアセット）。Actor のラベル（＝glTF のノード名＝`gml_id`）が表にある Actor に
   `UOrthoEarthBuildingComponent`（属性を Details に並べる・`Get("bldg:usage")`・`MeasuredHeight()`）と**タグ**（`PLATEAU`・`gml_id`・`usage:<用途>`）を付ける。
   Interchange が同名の Actor に付ける `_<n>` は外して照らす。
4. `*.las` → AssetTools で読み（LiDAR Point Cloud の工場）、Actor の工場で置く。`RestoreOriginalCoordinates` で中心寄せを戻し、VLR の錨（標高＋ジオイド）と錨の差だけずらす。
   LiDAR プラグインが無効なら読まずに言う（.uplugin で Optional）。

注意：PLATEAU のテクスチャ付き（`--textured`）は webp → jpeg 済み。建物の Draco は ortho-export の既定（1 棟ずつ）では解いてある＝Interchange の Draco 対応を当てにしない。

## 4. 点群（LAS）

- `pc-las.ts`：LAS 1.2・点の形式 2（xyz int32＋強度＋返り＋分類＋RGB 16 bit＝26 B/点）・尺度 1 mm・オフセット 0。位置＝錨からの m を **(E, N, U)** のまま。
- 錨は VLR（user `orthoEarth`・record 1・JSON `{ anchor: { lon, lat, height, datum: "orthometric" }, frame: "enu", units: "m" }`）。
- 重さ：PLY（16 B/点）の約 1.6 倍。LAZ（圧縮）はブラウザに符号器が無いので出さない。
- 検定：`apps/pointcloud/tests/t-pc-las.mjs`（見出し・VLR・点・範囲・間引き）。laspy 2.x で読めることを確かめた（2026-11-08）。
- **確かめること**：LiDAR プラグインが LAS (E, N, U) m を Unreal (E, −N, U) cm にするか（Y の反転）。違えば Place で Actor の Y の尺度を −1 にする。

## 5. Unreal → ortho-earth（Export）

`OrthoEarthExport.cpp`。選んだ Actor（とその子）を Unreal の glTF Exporter（`UGLTFExporter::ExportToGLTF`）で GLB にし、`asset.extras.orthoEarth` を JSON チャンクに差し込む（Unity の `StampExtras` と同じ・依存ゼロ）。
Exporter は世界座標で書くので、書く間だけ錨の Actor を原点（無回転）に動かして戻す＝錨の子の Actor は錨からの位置で書かれる。glTF Exporter は Unreal → glTF で (x, y, z)/100 → (x, z, y) にする＝ファイルは (E, U, −N)。

材質：ortho-earth が描くのは baseColor（係数×テクスチャ×頂点色）だけ＝Unreal でも Base Color 1 枚に寄せる。

## 6. 段取り

| 段 | 出す物 | 済の条件 |
| --- | --- | --- |
| 1 | この文書・`plugins/` への並べ替え（`unity/` → `plugins/unity/`）・`plugins/spec/` | 本人の確認 |
| 2 | 点群の LAS（`pc-las.ts`・ボタン・25 言語） | 検定と laspy で読める（2026-11-08 済）・Unreal で 4 点が期待値に来る |
| 3 | `plugins/unreal/OrthoEarth`（Anchor・Geo・属性・Place・Export） | Mac（UE 5.6 以降（5.8.4 で確認）・Xcode）でコンパイルが通る |
| 4 | 見本 `plugins/unreal/Samples/Marunouchi`（anchor.json・`pointcloud-check.las`・README） | Place で四隅・最も高い建物・4 点が期待値（README の表）に来る。Export → `glbToScene` で元と一致 |
| 5 | 配布（GitHub Release：Unity は tgz＋git タグ、Unreal はソースの zip）＝`plugins/pack.mjs` | Release に 2 つが載る |

## 7. やらないこと

- Unreal の中でタイルを動的に読む（Cesium for Unreal の領分）。Landscape への変換（メッシュで十分・街区規模）。Blueprint の資産（.uasset はバイナリ＝リポジトリでは C++ とテキストだけ）。
