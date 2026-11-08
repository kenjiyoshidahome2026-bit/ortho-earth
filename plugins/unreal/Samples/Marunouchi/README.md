# Marunouchi（丸の内・東京駅）— ortho-earth ⇄ Unreal の見本

Unity の見本（`plugins/unity/com.ortho-earth.unity/Samples~/Marunouchi`）と同じ範囲・同じ錨（139.76625, 35.68125, 楕円体高 40.0647 m・ジオイド 36.76 m）。
Unreal のマップ（.umap）はバイナリなので入れていない＝GLB を書き出して Place で組み立てる。

```
node sdk/ortho-export/src/cli.mjs --bbox 139.7625,35.6785,139.7700,35.6840 --anchor 139.76625,35.68125,40.0647 --geoid 36.76 --out out/marunouchi
cp plugins/unreal/Samples/Marunouchi/pointcloud-check.las out/marunouchi/   # 点群の検査（任意）
```

（テクスチャ付きは末尾に `--textured`。`out/` は大きいので commit しない。出力の `anchor.json` はこのフォルダの物と同じになる）

## 手順

1. プラグインを入れる（`plugins/unreal/README.md`）。新しいレベル（File > New Level > Basic）を開く。
2. 上のコマンドで `out/marunouchi/` に `anchor.json`・`terrain.glb`・`buildings.glb`・`buildings.attributes.json` を出す。
3. **Tools > Ortho Earth > Place export folder…** で `out/marunouchi/` を選ぶ。

## 確かめ方（期待値＝Unity の実走 2026-11-07 を Unreal の向きに写した物・X 東・Y 南・Z 上・cm）

| 物 | 錨の Actor から見た範囲 |
| --- | --- |
| terrain | X −33950…33950／Y −30510…30510／Z −70…220 |
| buildings | X −37830…35690／Y −33830…35890／Z −620…23810（173 棟） |
| 最も高い建物の頂点 | (26345, 19306, 23813)＝錨の Actor の `Geo Of` で lon 139.76916／lat 35.67951（東京ミッドタウン八重洲） |
| 建物の属性 | 173 棟に Ortho Earth Building・タグ `PLATEAU` |

**向きが違った時**：terrain の X と Y が入れ替わる・符号が逆＝Interchange の glTF の軸の写しが (x, z, y) でない。Place に回転を 1 つ足して直す（`docs/notes/unreal-roundtrip.md` §2）。

## 点群の検査用 LAS

`pointcloud-check.las` は `/japan/pointcloud` の「LAS（点・Unreal 向け）」と同じ書き方の 4 点（`make-check-las.mjs` が作る・Unity の PLY と同じ 4 点）。
錨をわざとフォルダの錨から 158 m 東・139 m 南にずらしてある。Place の後、点群の Actor が **(15842, 13869, −31)** に、4 点が次の位置に来れば正しい。

| 点 | 色 | Unreal 座標（cm） |
| --- | --- | --- |
| 東京ミッドタウン八重洲の頂点 | 赤 | (26345, 19306, 23813) |
| bbox 南西角（地面） | 緑 | (−33948, 30512, −32) |
| bbox 北東角（地面） | 青 | (33946, −30513, −32) |
| LAS の錨 | 黄 | (15842, 13869, −31) |

**Y の符号が逆の時**：LiDAR プラグインが LAS の Y を反転していない＝Place で点群の Actor の Y の尺度を −1 にする（§4）。

## Export の確かめ

terrain の Actor を選んで **Export selection to GLB…** → 出た GLB を `node -e` で `sdk/glbconv` の `glbToScene` に通すと、元の terrain.glb と prims（12）・頂点（7,544）・範囲・錨が一致すれば往復が通っている。
