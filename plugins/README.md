# plugins — ortho-earth ⇄ ゲームエンジン

ortho-earth のデータ（地形・PLATEAU 建物と属性・点群）をゲームエンジンへ持ち込み、エンジンで作った模型を地球儀へ戻すプラグイン。
どちらも npm の workspace の外（エンジンが読む形）。受け渡しは `sdk/ortho-export` の出力フォルダと GLB 1 本。

| 場所 | エンジン | 形 | 設計 |
| --- | --- | --- | --- |
| [`unity/`](unity/) | Unity 6（URP・glTFast） | UPM package `com.ortho-earth.unity` | [unity-roundtrip.md](../docs/notes/unity-roundtrip.md) |
| [`unreal/`](unreal/) | Unreal Engine 5.6 以降（5.8.4 で確認・Interchange・glTF Exporter・LiDAR Point Cloud） | C++ プラグイン `OrthoEarth`（.uplugin） | [unreal-roundtrip.md](../docs/notes/unreal-roundtrip.md) |
| [`spec/`](spec/) | 共通 | `anchor.json`・`buildings.attributes.json` の JSON Schema と検定 | 両方 |

## 共通の約束

- 錨＝`{ lon, lat, height }`（度・度・楕円体高 m）。GLB の頂点は錨の ENU を glTF の (E, U, −N) で、錨は `asset.extras.orthoEarth`。
- エンジンの中の向き：Unity＝X 東・Y 上・Z 北・m／Unreal＝X 東・Y 南・Z 上・cm。どちらもメニュー **Place export folder…** と **Export selection to GLB…**。
- 建物の属性＝`buildings.attributes.json`（棟＝glTF のノード＝`gml_id`）。点群＝Unity は PLY・Unreal は LAS（`/japan/pointcloud` の書き出し）。
- 検定：`npm run test:plugins`（両方の見本の anchor.json が同じで schema に合うか・属性表・LAS と PLY が同じ点か）。

## 配布

`node plugins/pack.mjs` が `plugins/dist/` に 2 つを作る（GitHub Release に載せる）：

- `com.ortho-earth.unity-<version>.tgz`：Unity の Package Manager の **Add package from tarball**。git URL でも入る：
  `https://github.com/kenjiyoshidahome2026-bit/ortho-earth.git?path=plugins/unity/com.ortho-earth.unity#unity-v<version>`
- `OrthoEarth-unreal-<version>.zip`：Unreal のプロジェクトの `Plugins/OrthoEarth/` に展開（ソースのプラグイン＝初回に Xcode／Visual Studio でビルドされる）。
