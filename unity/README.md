# unity — ortho-earth ⇄ Unity 6

Unity 6 側の受け口。npm の workspace の外（Unity の package＝UPM）。設計は [docs/notes/unity-roundtrip.md](../docs/notes/unity-roundtrip.md)。

| 場所 | 中身 |
| --- | --- |
| [`com.ortho-earth.unity/`](com.ortho-earth.unity/) | UPM package。`OrthoEarthAnchor`（錨＝シーンの原点の緯度経度・楕円体高・向き）、`Geo`（経緯度 ⇄ ローカル座標）、`PlyLoader`／`PlyImporter`（点群）、メニュー **Ortho Earth > Place export folder in scene…**（ortho-export の出力をシーンへ）と **Ortho Earth > Export selection to GLB…**（Unity → ortho-earth・錨を `asset.extras.orthoEarth` に押す） |

## 使い方（Unity 6 LTS・URP）

1. Unity Hub で **Universal 3D**（URP）のプロジェクトを作る（Unity 6000.x）。
2. **Window > Package Manager > + > Add package by name** で `com.unity.cloud.gltfast` を入れる（glTF の読み書き・Unity 公式）。
3. 同じく **Add package from disk** でこのリポジトリの `unity/com.ortho-earth.unity/package.json` を選ぶ（Unity が `.meta` を足す＝そのまま commit してよい）。
4. ortho-export の出力フォルダ（`anchor.json`・`terrain.glb`・`buildings.glb`・`pointcloud.ply`…）を **`Assets/OrthoEarth/<名前>/`** に丸ごとコピーする。glTFast が `.glb` を prefab に、この package が `.ply` を Mesh にする。
5. **Ortho Earth > Place export folder in scene…** でそのフォルダを選ぶ。`OrthoEarthAnchor` 付きの親（X=東・Y=上・Z=北・1 unit＝1 m）の下に全部が並ぶ。
   glTFast は右手系→左手系の変換で **X を反転する**（Z ではない）ので、glb の prefab はそのままだと (西, 上, 南)＝Y まわりに 180° 回った姿になる。
   Place はその間に「glTF frame」ノード（Y 180°）を 1 つ挟んで戻す＝親の直下は ENU そのもの。点群（.ply）は親の直下に置く（`PlyImporter` が Z を反転）。

建物の属性：Place は `buildings.attributes.json` を `buildings.attributes.asset`（`OrthoEarthAttributeTable`）にし、棟の GameObject（名前＝PLATEAU の `gml_id`）に
`OrthoEarthBuilding` を付ける。Scene で棟を選ぶ（prefab の根の次にもう一度クリック）と Inspector に属性（用途・高さ・住所・浸水…）が並ぶ。
コードでは `b.Get("bldg:usage")`・`b.MeasuredHeight`・`b.Attributes`。Play でクリックして見るには任意の GameObject に **Ortho Earth/Building Picker** を付ける（棟に MeshCollider を足す）。
テクスチャ付き：`ortho-export … --textured`（webp を jpeg に焼き直す）。

座標が欲しい時：`anchor.WorldOf(lon, lat, h)`／`anchor.GeoOf(worldPos, out lon, out lat, out h)`（`OrthoEarthAnchor`）。

## Unity → ortho-earth

1. 模型を `OrthoEarthAnchor` を持つ親の下に置く（錨の lon/lat/height/heading が「原点がどこか」）。Place で作った親をそのまま使えばよい。
2. 模型を選んで **Ortho Earth > Export selection to GLB…**。glTFast が GLB を書き、錨が `asset.extras.orthoEarth` に入る。
3. その GLB を [www.ortho-earth.com/japan/](https://www.ortho-earth.com/japan/) にドロップ（`map.gadget.model` が錨で置く・`?at=` を付ければそちらが勝つ）。大きい物は `glbconv` で `3dtiles` にする（錨が `CESIUM_RTC` になる）。

材質：ortho-earth が描くのは baseColor（係数×テクスチャ×頂点色）だけ＝Lit の **Base Map 1 枚**に寄せる。1 unit＝1 m で作る（錨に scale は無い）。

## 確認済み（2026-11-07・Unity 6000.6.8f1・glTFast 6.14.1・Draco 5.6.0）

- コンパイル：エラー 0・警告 0。PLATEAU は Draco 圧縮＝`com.unity.cloud.draco` が要る（package の依存に入れた）。
- Place（丸の内）：錨座標で terrain X −339.5…339.5／Z −305.1…305.1＝bbox の四隅と一致。最も高い建物（238 m）は lon 139.76916／lat 35.67951＝東京ミッドタウン八重洲の位置に戻る（X=東・Z=北）。
- 点群：`Samples~/Marunouchi/pointcloud-check.ply`（錨をわざと 158 m 東・139 m 南にずらした 4 点）を Place が置くと、子ノード (158.42, −0.30, −138.69)・4 点とも期待値との差 1 cm 程度。
- Export → glbconv：書き出した terrain を `glbToScene` で読むと 12 prims／7,544 頂点・範囲・RTC とも元の terrain.glb と一致。`asset.extras.orthoEarth` に錨が入る。
- `.meta` を同梱（git URL／tarball で入れると package は読み取り専用＝`.meta` の無い資産は無視されるため）。

## 見本（Samples~/Marunouchi）

Package Manager の **Samples** から Import。`anchor.json`・出典・点群の検査用 PLY が入る。GLB はリポジトリに無い＝見本の README のコマンド（`ortho-export --anchor … --geoid 36.76`）で同じ物が出る。

## まだ

- Place は 2 つの錨（フォルダと PLY）の差を平行移動だけで足す＝錨が数 km 離れた点群を混ぜる時は回転も要る。
- 属性は Unity では見える（`OrthoEarthBuilding`）が、Export → ortho-earth の地球儀へ戻した時の棟の当たり（EXT_mesh_features）は付けていない。
