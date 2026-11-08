# Marunouchi（丸の内・東京駅）— ortho-earth ⇄ Unity の見本

2〜3 街区（bbox 139.7625, 35.6785 〜 139.7700, 35.6840）。`anchor.json` は本物の実走と同じ錨（139.76625, 35.68125, 楕円体高 40.0647 m・ジオイド 36.76 m）。
GLB（地形 0.6 MB・建物 7.8 MB／テクスチャ付き 36.9 MB）はリポジトリに入れていない＝下のコマンドで同じ物が出る（網のある機械・2〜16 秒）。
テクスチャ付きにするには末尾に `--textured`（webp を jpeg に焼き直す）。建物は 1 棟ずつのノード（173 棟）で `buildings.attributes.json` が属性。

```
node sdk/ortho-export/src/cli.mjs --bbox 139.7625,35.6785,139.7700,35.6840 --anchor 139.76625,35.68125,40.0647 --geoid 36.76 --out <このフォルダ>
```

## 手順

1. Unity Hub で Universal 3D（URP）のプロジェクトを作り、`com.unity.cloud.gltfast` と `com.unity.cloud.draco`（PLATEAU は Draco 圧縮）を入れ、**Add package from disk** で `plugins/unity/com.ortho-earth.unity/package.json` を選ぶ。
2. Package Manager の **Samples** から Marunouchi を Import（`Assets/Samples/Ortho Earth/<version>/Marunouchi/` に写る）。
3. 上のコマンドで `terrain.glb`・`buildings.glb` を同じフォルダに出す（glTFast が prefab にする）。
4. **Ortho Earth > Place export folder in scene…** でそのフォルダを選ぶ。`OrthoEarthAnchor` 付きの親の下に、地形（Y≈0）の上に建物が立つ。X=東・Y=上・Z=北・1 unit＝1 m。

## 確かめ方（実走で合っていた値・2026-11-07・Unity 6000.6.8f1）

| 物 | 錨座標での範囲 |
| --- | --- |
| terrain | X −339.5…339.5／Y −0.7…2.2／Z −305.1…305.1（bbox の四隅と一致） |
| buildings | X −378.3…356.9／Y −6.2…238.1／Z −358.9…338.3（中心が bbox の中の 173 棟・`--no-clip` ならタイル丸ごと） |
| 最も高い建物 | `OrthoEarthBuilding`：MeasuredHeight 235.2・gml:name 区立城東小学校（八重洲の低層部） |
| 最も高い建物の頂点 | Y 238.1 → `anchor.GeoOf` で lon 139.76916／lat 35.67951＝東京ミッドタウン八重洲 |

## 点群の検査用 PLY

`pointcloud-check.ply` は `/japan/pointcloud` の「PLY（点・Unity 向け）」と同じ書き方の 4 点（`make-check-ply.mjs` が作る）。錨をわざとこのフォルダの錨から 158 m 東・139 m 南にずらしてある。
Place がこの `.ply` を親の直下に置いた時、子ノードの位置が **(158.42, −0.30, −138.69)**、4 点が次の位置に来れば正しい（実走＝誤差 1 cm 程度）。

| 点 | 色 | Unity 座標（X 東・Y 上・Z 北） |
| --- | --- | --- |
| 東京ミッドタウン八重洲の頂点 | 赤 | (263.45, 238.13, −193.06) |
| bbox 南西角（地面） | 緑 | (−339.48, −0.32, −305.12) |
| bbox 北東角（地面） | 青 | (339.46, −0.32, 305.13) |
| PLY の錨 | 黄 | (158.42, −0.31, −138.69) |

本物の点群は `/japan/pointcloud` で範囲を読んでから「PLY（点・Unity 向け）」で落とし、同じフォルダに置く。
注意：Place は 2 つの錨の差を平行移動だけで足す（ENU の傾きの差は見ない）＝錨が数百 m なら cm、5 km 離れて 500 m 広がる点群で 0.4 m ほどずれる。

## 出典

- 国土地理院：標高タイル（DEM10B）・全国最新写真（シームレス）— 地理院コンテンツ利用規約（出典の明記）
- 国土交通省 Project PLATEAU：3D 都市モデル（建築物・千代田区／中央区／港区）— CC BY 4.0
