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

座標が欲しい時：`anchor.WorldOf(lon, lat, h)`／`anchor.GeoOf(worldPos, out lon, out lat, out h)`（`OrthoEarthAnchor`）。

## Unity → ortho-earth

1. 模型を `OrthoEarthAnchor` を持つ親の下に置く（錨の lon/lat/height/heading が「原点がどこか」）。Place で作った親をそのまま使えばよい。
2. 模型を選んで **Ortho Earth > Export selection to GLB…**。glTFast が GLB を書き、錨が `asset.extras.orthoEarth` に入る。
3. その GLB を [www.ortho-earth.com/japan/](https://www.ortho-earth.com/japan/) にドロップ（`map.gadget.model` が錨で置く・`?at=` を付ければそちらが勝つ）。大きい物は `glbconv` で `3dtiles` にする（錨が `CESIUM_RTC` になる）。

材質：ortho-earth が描くのは baseColor（係数×テクスチャ×頂点色）だけ＝Lit の **Base Map 1 枚**に寄せる。1 unit＝1 m で作る（錨に scale は無い）。

## まだ

- Unity 6000.6.8f1・glTFast 6.14.1・Draco 5.6.0 でコンパイル（エラー 0）と丸の内の取り込みを確認（2026-11-07）。PLATEAU は Draco 圧縮＝`com.unity.cloud.draco` が要る（package の依存に入れた）。
- Place・Export の軸の扱い（上の 180°）は実機でまだ確かめていない（2026-11-07 の確認は 180° の問題を見つけた版）。
- 見本のシーン（丸の内）は ortho-export の実走（網のある機械）の後に `Samples~/` へ。
- 点群＝`/japan/pointcloud` の「PLY（点・Unity 向け）」で落とした `.ply` を同じフォルダに置けば Place が錨の差を足して並べる（実機＝未）。
