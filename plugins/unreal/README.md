# unreal — ortho-earth ⇄ Unreal Engine 5.6 以降（5.8.4 で確認）

Unreal 側の受け口。C++ のプラグイン `OrthoEarth`（npm の workspace の外）。設計は [docs/notes/unreal-roundtrip.md](../../docs/notes/unreal-roundtrip.md)。

| 場所 | 中身 |
| --- | --- |
| [`OrthoEarth/`](OrthoEarth/) | プラグイン本体。`OrthoEarthRuntime`（`AOrthoEarthAnchor`＝錨の Actor・`UOrthoEarthGeoLibrary`＝経緯度 ⇄ ローカル座標・`UOrthoEarthAttributeTable`・`UOrthoEarthBuildingComponent`）と `OrthoEarthEditor`（メニュー **Tools > Ortho Earth > Place export folder…**・**Export selection to GLB…**） |
| [`Samples/Marunouchi/`](Samples/Marunouchi/) | 丸の内の見本：`anchor.json`（Unity の見本と同じ）・点群の検査用 `pointcloud-check.las`・期待値の表 |

## 入れ方（UE 5.6 以降（5.8.4 で確認）・macOS は Xcode が要る）

1. Unreal のプロジェクト（C++ でも Blueprint でもよい）の `Plugins/` に `OrthoEarth/` を丸ごとコピーする（Release の zip を展開してもよい）。
2. プロジェクトを開くと「モジュールをビルドしますか」と聞かれる＝**はい**（Xcode／Visual Studio が裏でビルドする）。Blueprint だけのプロジェクトで聞かれない時は、
   空の C++ クラスを 1 つ足して C++ プロジェクトにする（Tools > New C++ Class）。
3. Edit > Plugins で **Ortho Earth** が有効、**Interchange**・**glTF Exporter**・**LiDAR Point Cloud**（点群を使う時）も有効になっていることを見る（.uplugin が有効にする）。

## ortho-earth → Unreal

1. `sdk/ortho-export` で範囲を書き出す（見本の README のコマンド）。点群は [/japan/pointcloud](https://www.ortho-earth.com/japan/pointcloud) で読んでから **LAS（点・Unreal 向け）** で落とし、同じフォルダに置く。
2. **Tools > Ortho Earth > Place export folder…** でそのフォルダを選ぶ。`Ortho Earth <フォルダ名>`（`AOrthoEarthAnchor`）の下に地形・建物・点群が並ぶ。
   **X=東・Y=南・Z=上・1 unit＝1 cm**（Cesium for Unreal と同じ）。資産は `/Game/OrthoEarth/<フォルダ名>/`。
3. 建物：Actor を選ぶと Details に **Ortho Earth Building**（`gml_id` と属性）。タグ `PLATEAU`・`<gml_id>`・`usage:<用途>` が付く＝Outliner の検索や `Get All Actors With Tag` で引ける。
   Blueprint では `Get Component by Class (OrthoEarthBuilding)` → `Get("bldg:usage")`／`Measured Height`。
4. 座標が欲しい時：錨の Actor の `World Of (lon, lat, height)`／`Geo Of (world)`（Blueprint からも呼べる）。

## Unreal → ortho-earth

1. 模型を錨の Actor（Place で出来た物、または Place Actors で置いた **Ortho Earth Anchor** に lon/lat/height を入れた物）の**子に**する。
2. 模型を選んで **Tools > Ortho Earth > Export selection to GLB…**。glTF Exporter が GLB を書き、錨が `asset.extras.orthoEarth` に入る。
3. その GLB を [www.ortho-earth.com/japan/](https://www.ortho-earth.com/japan/) にドロップ（錨の位置に立つ）。大きい物は `glbconv` で `3dtiles` に。

材質：ortho-earth が描くのは baseColor（係数×テクスチャ×頂点色）だけ＝Base Color 1 枚に寄せる。

## まだ（2026-11-08）

- **実機で未確認**（このリポジトリの機械には Unreal が無い）：コンパイル・Interchange の軸の写し・LiDAR の Y の向き。見本の表（`Samples/Marunouchi/README.md`）で確かめて直す。
- 錨どうしの差は平行移動だけ（Unity と同じ）。点群の LAZ（圧縮）は出さない。
