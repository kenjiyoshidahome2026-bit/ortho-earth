# glbconv

GLB（glTF バイナリ）を他の 3D 形式へ変換する小さな道具。**依存ゼロ**、ブラウザでも Node でも同じコードで動く。

```js
import { convertToFile } from "glbconv";

const out = await convertToFile(glbBytes, "usdz", { name: "osaka-castle" });
// out = { name: "osaka-castle.usdz", bytes: Uint8Array, type: "model/vnd.usdz+zip" }
```

## 出せる形式

| key | 出るもの | 備考 |
| :-- | :-- | :-- |
| `glb` | `<name>.glb` | Draco も量子化も解いた**素の GLB**。圧縮拡張に対応しない読み手でも開く |
| `gltf` | `<name>.gltf` ＋ `<name>.bin`（zip） | 仕様どおりの分離形。画像は bufferView のまま .bin に載る |
| `gltf-embedded` | `<name>.gltf` | バッファを data URI に埋めた 1 ファイル |
| `obj` | `.obj` ＋ `.mtl` ＋ 画像（zip） | 面は三角形・`map_Kd` つき。原点は先頭のコメントに |
| `ply` | `<name>.ply` | binary little endian・法線と頂点色つき |
| `stl` | `<name>.stl` | binary・形だけ（3D プリント向け） |
| `usdz` | `<name>.usdz` | Apple の AR クイックルック。無圧縮 zip・64 byte 境界・先頭が `.usda` |
| `3dtiles` | `tileset.json` ＋ `model.glb`（zip） | Cesium などへ戻す。境界は ECEF の球 |

`convert()` は `[{ name, bytes }]` を返し、`convertToFile()` は 2 本以上なら zip に畳んで 1 個にする。

## 位置情報（ここが肝）

3D Tiles 由来の GLB は **`CESIUM_RTC`**（ECEF の原点）を持つ。`glb` / `gltf` / `3dtiles` はそれをそのまま引き継ぐので、
落とした先でも地球上の正しい場所に立つ。OBJ・PLY・STL・USDZ にはその欄が無いので、**原点をヘッダやコメントに書き残す**
（相手が地球へ戻せるように）。

## 注入口（依存を持たないための口）

外の重い実装は**呼び手が渡す**。渡さなければ、それが要る場面でだけ理由つきで落ちる。

```js
await convertToFile(glb, "obj", {
  name: "osaka-castle",
  // ① Draco（KHR_draco_mesh_compression）の展開。loaders.gl・draco3d など何でもよい
  decodeDraco: (bytes, attrIds) => parse(bytes, DracoLoader),
  // ② テクスチャの焼き直し（任意）。OBJ と USDZ は webp を読めない相手が多い＝jpeg へ寄せる
  transcodeImage: async (bytes, mime, want) => {
    const bm = await createImageBitmap(new Blob([bytes], { type: mime }));
    const cv = new OffscreenCanvas(bm.width, bm.height);
    cv.getContext("2d").drawImage(bm, 0, 0);
    const out = await cv.convertToBlob({ type: want, quality: 0.9 });
    return { mime: out.type, bytes: new Uint8Array(await out.arrayBuffer()) };
  },
});
```

`glb` / `gltf` / `3dtiles` は Draco が要らない道も通れる（GLB をそのまま配るだけなら `decodeDraco` 無しでよい）。

## 中立な「シーン」

読み口は 1 つだけ。書き出し側は全部これを見る。自前のメッシュを流し込むこともできる。

```js
scene = {
  rtc: [x, y, z] | null,            // ECEF の原点（CESIUM_RTC）
  bbox: [minx, miny, minz, maxx, maxy, maxz],
  prims: [{
    positions: Float32Array,        // ノードの行列は畳み済み
    normals: Float32Array | null,
    uvs: Float32Array | null,
    colors: Uint8Array | null,      // RGBA
    indices: Uint32Array,
    material: { name, baseColor: [r,g,b,a], doubleSided, image: { mime, bytes } | null },
  }],
}
```

## 検定

```
npm test        # tests/t-glbconv.mjs（合成 GLB で全形式・zip の CRC・USDZ の境界・RTC の保存）
```

## ライセンス

MIT
