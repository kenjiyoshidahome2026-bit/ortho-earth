# ortho-earth ⇄ Unity 6 ── データの往復の設計（2026-11-07 起案・叩き台）

**目的**：ortho-earth が読んでいるデータ（地形・PLATEAU 建物・3D Tiles・点群）を Unity 6 のシーンに持ち込む。
逆に Unity で作った 3D データを ortho-earth の地球儀に置く。
**規模（本人・2026-11-07）**：2〜3 街区。Unity プロジェクトは無い（ここで作る）。**まずは静的**（書き出してファイルで渡す。
Unity 内でタイルを動的に読む仕組みは Cesium for Unity・PLATEAU SDK for Unity が既にある＝作らない）。

## 0. 結論（先に）

- **受け渡しは GLB 1 本**。Unity 6 は glTFast（`com.unity.cloud.gltfast`・公式）で GLB を読み書きできる。
  ortho-earth 側は `sdk/glbconv`（GLB → glb/gltf/obj/ply/stl/usdz/3dtiles）と `gadget.model`（GLB を地球儀に置く）が既にある。
- **座標の約束は 1 つ**（§2）。基準点（錨）を緯度経度・楕円体高で決め、その点の ENU（東・北・上・メートル）を Unity の
  ローカル座標にする。Unity は左手系 Y-up なので **ENU → Unity は (E, U, N)**（X=東・Y=上・Z=北）。glTF は右手系 Y-up なので
  **ENU → glTF は (E, U, −N)**。glTFast は glTF→Unity で **X を反転する**（2026-11-07 実機）＝素の prefab は ENU を Y まわりに 180° 回した姿＝package の Place が 1 ノードで戻す（§2.2）。ファイルの約束は Cesium と同じ 1 つ。
- 錨の情報は **glTF の `extras`**（`asset.extras.orthoEarth`）に書く（§2.3）。ortho-earth → Unity でも Unity → ortho-earth でも同じ欄。
  3D Tiles 由来の物は `CESIUM_RTC`（ECEF）も残す＝`glbconv` と `gadget.model` がそのまま読む。
- 4 段で進める（§5）。1＝この文書・2＝`ortho-export` CLI・3＝Unity → ortho-earth の取り込み口・4＝Unity 6 の見本プロジェクト。

## 1. 今あるもの（土台）

| 物 | 場所 | 使い方 |
| --- | --- | --- |
| 3D Tiles の木を降りて bbox の葉タイルを集め、b3dm → glb を抜く（依存ゼロ・Node） | `sdk/ortho-export/src/tiles3d/tiles3d.mjs`（`collectTiles`・`b3dmToGlb`）、`glbmerge.mjs`（`mergeGlb`）＝2026-11-07 に `apps/uploader/scripts/tiles3d/` から移した（uploader は `ortho-export/tiles3d` で読む） | PLATEAU の名所を 1 枚の glb に束ねる `plateau-landmarks.mjs` がこれで動いている＝**街区の書き出しの原型** |
| GLB の変換器（Draco 展開・RTC の保存・obj/ply/usdz/3dtiles 出力） | `sdk/glbconv`（`convertToFile`・中立な `scene`） | 出力の最終段＝ここに「錨付き GLB」の出口を足す |
| 標高タイルの読み（raster-dem／dem_png） | `packages/ortho-core/src/dem-src.ts`（`decodeDEM`）、`packages/globe/src/demtiles.ts`、Node の例＝`apps/japan-map/scripts/bake-dem10b.mjs`（地理院 `dem_png` z12 を PNG から直に復号） | 地形メッシュを焼く元 |
| COPC 点群の読み（範囲読み・JGD2011 平面直角 → 経緯度） | `packages/globe/src/copc-worker.ts`・`copc-place.ts`・`pointcloud-crs.ts` | 点群の書き出しの元（Node で動くのは `copc-place` だけ＝LAZ の解読はブラウザの worker 前提・§3.3） |
| GLB を地球儀に置く | `packages/globe/src/gadgets/model.ts`（`map.gadget.model(src, { at, heading, scale })`・`?g=&at=lon,lat,heading,scale`・`CESIUM_RTC` が埋まっていればそちらが勝つ） | Unity → ortho-earth の受け口 |
| 名所模型の台帳と置き場 | `ortho-data/japan/models.json`・`apps/uploader/scripts/models-upload.mjs`（bucket `GIS/models/<id>.glb`） | Unity から来た模型をカードとして見せる所 |
| PLATEAU の配信元の台帳 | `packages/jp/assets/plateau-sets.json`（市区町村ごとの tileset URL） | 街区の bbox から tileset を引く |

## 2. 座標の約束（往復で同じ 1 つ）

### 2.1 錨（anchor）

- 錨＝`{ lon, lat, height }`（度・度・**楕円体高 m**、WGS84/GRS80）。2〜3 街区なら錨は 1 つ（街区の中心）。
- 錨の ENU 系＝錨を原点に、X=東・Y=北・Z=上（m）。地球の丸み＝1 km 四方で ≈8 cm の落ち込み。**ENU は平面でなく「錨での接平面」なので、
  3D Tiles（ECEF）から来た頂点は正確に ENU へ回す**（`ecef → enu` の回転行列＝`tiles3d.mjs` の `lonLatToEcef` の逆の姿勢）。地形の格子は
  経緯度＋標高から `lonLatToEcef` → ENU で頂点を作る＝丸みも乗る。Unity 側は何も補正しない。
- 高さ：PLATEAU の 3D Tiles は楕円体高（ECEF）。地理院 dem_png は**標高（ジオイド上）**なので、ジオイド高 N（日本では +30〜+40 m）を足して楕円体高に揃える
  （エンジンは既にこれをやっている＝`copc-place.ts` の `dz＝−N＋heightOffset` と同じ扱い）。初版は錨 1 点の N を定数で足す（街区の中で N の変化は mm 級）。

### 2.2 軸と単位（表）

| 系 | 手 | 上 | 前（北） | 単位 |
| --- | --- | --- | --- | --- |
| ENU（我々の中立） | 右 | Z | Y | m |
| glTF（ファイル） | 右 | Y | **−Z** | m |
| Unity | 左 | Y | +Z | m |

- ENU → glTF：`(x, y, z)_glTF = (E, U, −N)`。
- glTF → Unity：glTFast は右手系→左手系の変換で **X を反転する**（4.0 以降・Z ではない＝2026-11-07 に実機で確認・glTFast の UpgradeGuides.md）＝素の prefab は `(−E, U, −N)`＝
  ENU を Y まわりに 180° 回した姿（鏡像ではない）。package の Place が「glTF frame」ノード（Y 180°）を 1 つ挟んで戻す＝**錨の GameObject の直下は X=東・Y=上・Z=北**。
  ファイルの約束（Cesium と同じ (E, U, −N)）は変えない＝エンジン・glbconv・3D Tiles と同じ 1 つの向きを守る。
- Unity → glTF（glTFast Export）：Export は錨の空間を Y 180° 回した行列を origin に渡す＝X 反転と合わせて glTF は `(E, U, −N)` に戻る。
- heading（方位）：北から時計回りの度（`gadget.model` と同じ）。Unity の Y 軸回転（時計回りが正・上から見て）と同じ向き＝**変換不要**。
- スケールは 1（m）。Unity の prefab で縮めない。3D Tiles の `CESIUM_RTC`（ECEF の原点）は glb に残すが、頂点は錨の ENU で書く＝
  読み手（Unity）は RTC を無視してよい。ortho-earth の読み手は RTC があればそれを錨として使う（`gadget.model` の掟）。

### 2.3 錨の書き方（glTF `extras`）

```json
"asset": { "version": "2.0", "generator": "ortho-earth ortho-export 0.1",
  "extras": { "orthoEarth": {
    "anchor": { "lon": 139.7671, "lat": 35.6812, "height": 40.3 },
    "frame": "enu",            // 頂点＝錨の ENU を glTF の (E, U, -N) で
    "heading": 0,              // Unity から来る時：錨まわりの向き（北から時計回り・度）
    "source": [ { "kind": "plateau", "set": "13101-bldg-lod2", "license": "CC BY 4.0", "url": "…tileset.json" } ],
    "bbox": [139.765, 35.679, 139.770, 35.684]   // 書き出した範囲（度）
  } } }
```

- 3D Tiles 由来の glb は `CESIUM_RTC` を**外す**（頂点はもう錨の座標＝残すと ECEF へ二重に動かす読み手がある・`ortho-export` 0.1 で実装）。
  `extras` と `CESIUM_RTC` が両方ある古い物は **`extras.anchor` が正**。
- Unity から来る GLB に `extras` が無い時は `?at=lon,lat,heading,scale`（`gadget.model` の既存の口）で置く＝**錨なしでも置ける**。

## 3. ortho-earth → Unity（ステップ 2・`ortho-export`）

**形**：Node の CLI（依存ゼロ・`sdk/glbconv` と `apps/uploader/scripts/tiles3d` を使う）。置き場＝`sdk/ortho-export/`（npm に出すなら `@ortho-earth/export`）。

```
npx ortho-export --bbox 139.765,35.679,139.770,35.684 --out out/marunouchi \
  --terrain gsi-dem10b --buildings plateau --pointcloud <copc.laz|none>
```

出るもの（1 フォルダ＝Unity の `Assets/OrthoEarth/<name>/` にそのまま置く）：

| ファイル | 中身 | 作り方 |
| --- | --- | --- |
| `anchor.json` | §2.3 と同じ錨（Unity の C# が読む・GLB の extras の写し） | CLI |
| `terrain.glb` | 地形メッシュ（格子・法線・uv）＋航空写真か地理院の標準地図をテクスチャに | dem_png z14（≈2.4 m/px・2 街区なら数千頂点）を `bake-dem10b.mjs` の復号で読み、§2.1 で ENU に。テクスチャ＝XYZ ラスタ 1 枚に束ねる（z17〜18） |
| `buildings.glb` | PLATEAU 建物（LOD2 テクスチャ付きがあればそれ・無ければ LOD1/2 無テクスチャ） | `collectTiles(tileset, bbox)` → `b3dmToGlb` → `mergeGlb` → ECEF→ENU に回す → extras |
| `pointcloud.ply`（任意） | 点（xyz・RGB・classification）・binary little endian | §3.3 |
| `README.md` | 出典・ライセンス（PLATEAU＝CC BY 4.0・地理院＝出典明記・VIRTUAL SHIZUOKA＝CC BY 4.0）・錨・範囲 | CLI が台帳から起こす |

### 3.1 地形

- 元＝地理院 `dem_png`（DEM10B・z14 まで。都市部は DEM5A が z15 で読めるが初版は 10B で十分＝街区の地面の起伏は 1 m 級）。
- 格子＝bbox を覆うタイルの画素をそのまま頂点に（間引きなし・2 街区なら 256×256 程度）。縁は bbox で切る。
- テクスチャ＝地理院 `seamlessphoto`（航空写真）か `std`。1 枚（最大 4096²）に束ねて `baseColorTexture`。
- 建物の足元が地形に沈む／浮く問題：PLATEAU の建物は楕円体高で正しい位置にある。地形側をジオイドで揃えれば一致する（§2.1）。
  ずれが残る時は建物側でなく地形側を動かす（Unity の `Terrain` コンポーネントには変換しない＝メッシュのまま。2〜3 街区なら軽い）。

### 3.2 PLATEAU 建物

- tileset＝`plateau-sets.json` から bbox を含む市区町村の `bldg` を引く（LOD2 textured → LOD2 → LOD1 の順）。
- 建物ごとの属性（`gml_id`・用途・階数）は b3dm の batch table にある＝**`EXT_structural_metadata` か頂点の `_FEATURE_ID_0`＋`extras.features[]`** で残す。
  初版は `extras.features`（glTFast が extras を読める）。Unity 側で建物をクリックして属性を見るのはステップ 4 の範囲。
- テクスチャ＝PLATEAU は webp が多い。Unity は webp を読まない＝**jpeg へ焼き直す**（`tiles3d/webp2jpeg.mjs` が既にある）。
- 重複面・両面＝`meshdecode` の dedup は使わない（Unity 側はそのまま描ける）。glTF の `doubleSided` を残す。

### 3.3 点群

- 元＝COPC（VIRTUAL SHIZUOKA など）。範囲読み（bbox に重なる節）で 2〜3 街区なら数十万〜数百万点。
- **Node に LAZ の解読が無い**（エンジンは worker で wasm を使う）。初版は (a) ブラウザの `/japan/pointcloud` 頁に「範囲を PLY で落とす」ボタンを付ける、
  (b) CLI は `laszip`/`pdal` が手元にある時だけ呼ぶ、の二択で **(a)** を先に（頁の読み口と `copc-place` がそのまま使える）。
- 形式＝PLY（binary little endian・xyz float32＝錨相対で **glTF と同じ (E, U, −N)**・RGB u8・classification u8）。Unity には点群の標準読み手が無い＝
  package の `PlyImporter`（`.ply` → `MeshTopology.Points` の Mesh・Z を反転して Unity の北＝+Z に・classification は uv0.x）が読む（数百万点までなら 1 Mesh・それ以上は分割）。
  glTF の `POINTS` でも可だが Unity の glTFast が点を描かない版がある＝PLY が安全。

### 3.4 他（3D Tiles 一般・I3S・Gaussian splat）

- 任意の 3D Tiles（PLATEAU 以外）も同じ道（`collectTiles` は一般の木を降りる）。I3S・splat は対象外（splat は Unity 側に専用の読み手が要る）。

## 4. Unity → ortho-earth（ステップ 3）

**Unity 側**：glTFast の Export（`GLTFast.Export.GameObjectExport`）で GLB を出す。小さな Editor スクリプト `OrthoEarthExport.cs`（ステップ 4 の見本に同梱）が

1. シーンの `OrthoEarthAnchor` コンポーネント（lon/lat/height/heading・ステップ 2 の `anchor.json` から読んだ物か手で入れた物）を見て、
2. 選んだ GameObject を GLB に書き、
3. §2.3 の `extras.orthoEarth` を `asset.extras` に差し込む（glTFast の Export は extras を書けないので**出た GLB の JSON チャンクを書き換える**＝依存ゼロ・20 行）。

**ortho-earth 側**（受け口・2 本立て）：

| 大きさ | 受け口 | 作る物 |
| --- | --- | --- |
| 単体の模型（〜数十 MB） | `gadget.model`（ドロップ・`?g=`）＝今すぐ置ける。`extras.orthoEarth.anchor` を読んで錨にする（**今は `CESIUM_RTC` と `?at=` だけ**＝`model-worker` に extras の読みを足す＝数行） | エンジンの小改修＋`models.json` に `anchor` 欄（カードに載せる時） |
| 大きい・たくさん | `glbconv` の `3dtiles` 出力（`tileset.json`＋glb）＝錨の ENU → ECEF に回して `CESIUM_RTC` を付ける。範囲が広ければ `glbmerge` の逆（格子で割る）で複数タイルに | `glbconv` に「extras の錨 → RTC」の変換を足す |

- Unity の材質：glTFast の Export は URP/Built-in の Lit を PBR に落とす。ortho-earth の `gadget.model` は `baseColorFactor×COLOR_0`＋`baseColorTexture` だけ描く＝
  金属・粗さ・法線マップは落ちる（既存の掟）。見本では「Lit・baseColor＋1 枚テクスチャ」に寄せる。
- 単位：Unity で 1 unit＝1 m で作る。`scale` は錨に持たせない（`?at=` の scale は非常口）。

## 5. 段取り

| 段 | 出す物 | 済の条件 |
| --- | --- | --- |
| 1 | この文書 | 本人の修正が入って確定 |
| 2 | `sdk/ortho-export`（CLI）：地形＋PLATEAU → `anchor.json`・`terrain.glb`・`buildings.glb`・`README.md`。検定＝合成の fetch で錨・DEM・地形・建物の座標の付け替え（`tests/t-export.mjs`）＋丸の内 2 街区の実走 | 済（2026-11-07 実走：geoid 36.76 m・地形 12 枚 7,544 頂点 0.6 MB・建物 31 枚 10.5 MB（千代田 27・中央 4）・4.1 s。建物はタイル単位＝bbox より広い約 1.2×1.1 km が入る） |
| 2′ | 点群＝`/japan/pointcloud` の「PLY（点・Unity 向け）」ボタン（`apps/pointcloud/pc-ply.ts`・読んだ点をそのまま＝図郭 1 枚か熱海の見本・錨は見出しの comment・2026-11-07） | 熱海の見本が PLY で出て Unity の `PlyImporter` が読む（ブラウザの実機＝未） |
| 3 | 取り込み口：`decodeModel` が `asset.extras.orthoEarth.anchor` を読む（`opts.at` が無い時・`tests/model-anchor.mjs`）／`glbconv` が錨を `CESIUM_RTC` へ畳む（`glbToScene`）／Unity の `Ortho Earth > Export selection to GLB…` が錨を押す | Unity で出した GLB をドロップすると錨の位置に立つ（エンジン側＝済。Unity の Export → `glbToScene` で元の terrain.glb と prims・頂点・RTC が一致＝2026-11-07 実機で済） |
| 4 | `unity/com.ortho-earth.unity/`（UPM package・Unity 6・URP・glTFast）：`OrthoEarthAnchor`・`Geo`・`PlyLoader`／`PlyImporter`・`Place export folder in scene…`・`Export selection to GLB…`・README。見本のシーンは段 2 の実走の後に `Samples~/` へ | 段 2 の出力を開いて地形の上に建物が立つ・段 3 の往復が通る（2026-11-07 実機で済：Unity 6000.6.8f1・glTFast 6.14.1・Draco 5.6.0 でエラー 0・丸の内の Place が bbox の四隅と一致・最高の建物が東京ミッドタウン八重洲の位置に戻る。`.meta` 同梱） |

**置き場**：Unity 側は repo の根に `unity/com.ortho-earth.unity/`（UPM package・npm workspace の外＝利用者は自分の URP プロジェクトに Add package from disk。
プロジェクト丸ごとは置かない＝ProjectSettings の YAML を手で書くより package の方が壊れない）。CLI は `sdk/ortho-export`。
**裁定（本人・2026-11-07）**：①見本の街区＝丸の内（東京駅前）③点群の初版＝ブラウザから落とす方式（§3.3 の (a)）。
②レンダーパイプライン＝URP（本人は特に希望なし＝標準の URP を採る。HDRP は後から切り替えられるが材質の見本は作り直し）。

## 6. やらないこと

- Unity 内でタイルを動的に読む（Cesium for Unity・PLATEAU SDK の領分）。Unity WebGL から JS のエンジンを呼ぶ道（別の企画）。
- Unity の `Terrain` コンポーネントへの変換（メッシュで十分・街区規模）。
- FBX（Autodesk の SDK が要る・GLB で足りる）。
