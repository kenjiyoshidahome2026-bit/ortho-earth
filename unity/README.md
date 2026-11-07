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
5. **Ortho Earth > Place export folder in scene…** でそのフォルダを選ぶ。`OrthoEarthAnchor` 付きの親の下に全部が原点そのままで並ぶ（X=東・Y=上・Z=北・1 unit＝1 m）。

座標が欲しい時：`anchor.WorldOf(lon, lat, h)`／`anchor.GeoOf(worldPos, out lon, out lat, out h)`（`OrthoEarthAnchor`）。

## Unity → ortho-earth

1. 模型を `OrthoEarthAnchor` を持つ親の下に置く（錨の lon/lat/height/heading が「原点がどこか」）。Place で作った親をそのまま使えばよい。
2. 模型を選んで **Ortho Earth > Export selection to GLB…**。glTFast が GLB を書き、錨が `asset.extras.orthoEarth` に入る。
3. その GLB を [www.ortho-earth.com/japan/](https://www.ortho-earth.com/japan/) にドロップ（`map.gadget.model` が錨で置く・`?at=` を付ければそちらが勝つ）。大きい物は `glbconv` で `3dtiles` にする（錨が `CESIUM_RTC` になる）。

材質：ortho-earth が描くのは baseColor（係数×テクスチャ×頂点色）だけ＝Lit の **Base Map 1 枚**に寄せる。1 unit＝1 m で作る（錨に scale は無い）。

## まだ

- Unity の実機では未検証（この版は glTFast 6.9 の API に合わせて書いた物＝最初に開いた時のコンパイルエラーは直す前提）。
- 見本のシーン（丸の内）は ortho-export の実走（網のある機械）の後に `Samples~/` へ。
- 点群は `/japan/pointcloud` の「範囲を PLY で落とす」（設計書 §3.3）ができてから。
