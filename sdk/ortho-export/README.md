# ortho-export

ortho-earth が読んでいるデータ（地理院の地形・PLATEAU 建物）を**範囲で切って Unity 向けの GLB に焼く** CLI。依存ゼロ（[glbconv](../glbconv) だけ）・Node 22.18 以上。
設計は [docs/notes/unity-roundtrip.md](../../docs/notes/unity-roundtrip.md)。

```
node sdk/ortho-export/src/cli.mjs --bbox 139.7625,35.6785,139.7700,35.6840 --out out/marunouchi
```

出るもの（1 フォルダ＝Unity の `Assets/OrthoEarth/<name>/` にそのまま置く）：

| ファイル | 中身 |
| --- | --- |
| `anchor.json` | 錨（緯度経度・楕円体高）・ジオイド高・範囲・出典。Unity の C# が読む |
| `terrain.glb` | 地形メッシュ。画像タイル（既定＝地理院の全国最新写真 z17）1 枚ごとに 1 面・DEM10B で持ち上げ |
| `buildings.glb` | PLATEAU 建物（3D Tiles の葉を 1 枚に束ねた物）。根のノード 1 つが「3D Tiles の座標 → 錨の座標」の行列を持つ |
| `README.md` | 出典とライセンス（PLATEAU＝CC BY 4.0・地理院＝出典の明記） |

## 座標の約束

- 錨＝`{ lon, lat, height }`（度・度・楕円体高 m）。省略すると bbox の中心・高さはその地点の地面（DEM＋ジオイド）。
- 頂点は錨の ENU（東・北・上・m）を glTF の **(E, U, −N)** で書く。Unity（glTFast）は X を反転するので素の prefab は (西, 上, 南)＝package の Place が Y 180° のノードで **X=東・Y=上・Z=北** に戻す・1 unit＝1 m。
- 錨は各 GLB の `asset.extras.orthoEarth` にもある。`CESIUM_RTC` は外す（頂点はもう錨の座標）。
- 高さ：地理院の標高（ジオイド上）＋ジオイド高＝楕円体高＝PLATEAU と同じ基準。ジオイド高は既定で地理院の API（`--geoid auto`）・網が無ければ `--geoid 36.7` のように渡す。

## オプション

```
--anchor lon,lat[,height]   錨（省略＝bbox の中心・高さ＝地面）
--geoid auto|<m>            ジオイド高（既定 auto＝地理院 API。東京 ≈ 36.7）
--zoom 17                   画像タイルの z（最大 18）
--imagery seamlessphoto|std|pale|none
--dem-zoom 14               標高タイルの z（dem_png は 14 まで）
--segments 32               画像タイル 1 枚あたりの地形の分割数
--buildings catalog|<tileset.json url>[,…]|none   既定 catalog＝packages/jp/assets/plateau-sets.json から bbox の市区町村を引く
--textured                  catalog のセット名の notexture を texture に置き換えて読む（配信があれば）
--no-terrain
```

## 限界（0.1）

- 3D Tiles の `transform`（tileset の根の行列）は見ない＝PLATEAU のように RTC だけで置く木が前提。他の木では警告を出す。
- 建物の属性（batch table の `gml_id` など）はまだ運ばない。
- PLATEAU の webp テクスチャは Unity が読めない。`--textured` で読む時は `apps/uploader/scripts/tiles3d/webp2jpeg.mjs`（macOS の sips）で焼き直す口を `fixup` に渡す（CLI にはまだ無い）。
- 点群は別の道（`/japan/pointcloud` の頁から PLY で落とす＝設計書 §3.3）。

## 検定

```
npm test -w ortho-export   # tests/t-export.mjs：合成の fetch（網を使わない）で錨の算術・DEM・地形・建物の座標の付け替え・出力
```
