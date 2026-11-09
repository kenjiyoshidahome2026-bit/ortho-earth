# ortho-export

ortho-earth が読んでいるデータ（地理院の地形・PLATEAU 建物）を**範囲で切って Unity 向けの GLB に焼く** CLI。依存は [glbconv](../glbconv) と draco3d（PLATEAU の Draco を解く）・Node 22.18 以上。
設計は [docs/notes/unity-roundtrip.md](../../docs/notes/unity-roundtrip.md)。

```
node sdk/ortho-export/src/cli.mjs --bbox 139.7625,35.6785,139.7700,35.6840 --out out/marunouchi
```

出るもの（1 フォルダ＝Unity の `Assets/OrthoEarth/<name>/` にそのまま置く）：

| ファイル | 中身 |
| --- | --- |
| `anchor.json` | 錨（緯度経度・楕円体高）・ジオイド高・範囲・出典。Unity の C# が読む |
| `terrain.glb` | 地形メッシュ。画像タイル（既定＝地理院の全国最新写真 z17）1 枚ごとに 1 面・DEM10B で持ち上げ |
| `buildings.glb` | PLATEAU 建物。**1 棟＝1 ノード**（ノード名＝`gml_id`・`extras.plateau`＝batch table の行）・頂点は錨の座標・無圧縮。中心が bbox の外の棟は落とす（`--no-clip` で残す） |
| `buildings.attributes.json` | 同じ属性を平らにした表（`keys`＋棟ごとの `values`・入れ子は `/` でつなぐ）。Unity の Place が `OrthoEarthBuilding` を棟に付ける |
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
--textured                  PLATEAU のテクスチャ付き（webp）を読む。webp は glTFast が読まない＝下の変換器で jpeg/png に焼き直す
--texture-format jpeg|png   既定 jpeg
--texture-max 2048          長辺の上限 px（PLATEAU の atlas は 4096×2048＝Unity で 1 枚 32 MB。0＝そのまま）
--texture-quality 85
--image-tool sharp|sips|dwebp|ffmpeg|magick   既定＝この順に手元にある物（sharp は optionalDependencies・macOS は sips が標準）
--attributes plateau|none   既定 plateau＝棟ごとのノードと属性表。none＝タイルを束ねるだけ（Draco のまま・行列の親ノード・属性なし・小さい）
--no-clip                   bbox の外の棟も残す（タイル丸ごと）
--no-terrain
```

## 限界（0.1）

- 3D Tiles の `transform` は棟ごとの道（既定）では畳む。`--attributes none` では見ない（RTC だけの木が前提・警告を出す）。
- 属性は 3D Tiles 1.0 の batch table だけ（PLATEAU 2025 はこれ）。1.1 の `EXT_structural_metadata` は未対応（`_FEATURE_ID_0` で棟は割れる・属性は空）。
- 棟ごとの道は Draco を解くので大きい（丸の内・2026-11-07：173 棟・テクスチャなし 7.8 MB／`--textured` 36.9 MB＝jpeg 47 枚 2048 px。Draco の束は 10.5 MB）。
- 点群は別の道（`/japan/pointcloud` の頁から PLY で落とす＝設計書 §3.3）。

## Minecraft（`ortho-minecraft`）

出力フォルダを Minecraft のワールド（Java 版のフォルダ・WorldEdit の .schem・統合版の .mcworld）に焼く／Minecraft のブロックを錨つき GLB に戻す。
使い方は [plugins/minecraft](../../plugins/minecraft/README.md)、設計は [docs/notes/minecraft.md](../../docs/notes/minecraft.md)。

```
node sdk/ortho-export/src/minecraft-cli.mjs out/marunouchi --out out/marunouchi-mc
node sdk/ortho-export/src/minecraft-cli.mjs import <world|.mcworld|.schem> --out house.glb [--box x0,y0,z0,x1,y1,z1] [--diff <original world>]
```

## 検定

```
npm test -w ortho-export   # tests/t-export.mjs：合成の fetch（網を使わない）で錨の算術・DEM・地形・建物の座標の付け替え・出力
                           # tests/t-attributes.mjs：Draco＋webp＋batch table の合成 b3dm で棟ごとのノード・属性表・webp → jpeg・clip
                           # tests/t-minecraft.mjs：合成の地形と箱 → 格子・Java の region・.schem・統合版の LevelDB を読み戻す・取り込み（GLB）
```
