# @ortho-earth/globe の plugin（拡張点の手引き・2026-10-12 起票）

この地図の拡張は 1 つの形＝`definePlugin({ name, install(map, opts), uninstall? })` に揃っています。plugin は `map.use(p, opts)` で搭載し、
`map.registry.<kind>` に実装を登録して、既存の口（`addData`・`gadget`・`setLights`・`setClouds`・`setPostChain`・`walk`・タイルの解読）から呼ばれます。
「この地図でこの機能は絵になるか」は `map.supports(key)`／`map.capabilities()` が正直に答えます。台帳は [`maplibre-compat.md`](maplibre-compat.md) §9。

```js
import { createGlobe, definePlugin } from "@ortho-earth/globe";

const squares = definePlugin({
	name: "squares", version: "1.0.0", provides: ["data.squares"],
	install(map, opts) {
		map.registry.dataKinds.add("squares", { create: (m, data, o) => m.addData(data, { ...o, kind: "polygons", getPolygon: d => squareOf(d, opts.sizeM ?? 100) }) });
		return () => { /* 片付け（省略可・registry への登録は自動で外れる） */ };
	},
});
const map = await createGlobe({ target: "#map", plugins: [[squares, { sizeM: 50 }]] });   // か map.use(squares, { sizeM: 50 })
map.addData(points, { kind: "squares" });
map.supports("data.squares");   // true
```

## 約束

- **install は同期**。非同期の仕事（fetch・import()）は中で始める。install が返した関数は `map.unuse(name)`／`map.destroy()` で呼ぶ（`uninstall` があればそちら）。
- install が受ける map は**素の map**（`zoomScale` の旗つきでも外側の顔ではない＝地域パックと同じ・エンジンの z）。
- install 中に `registry.<kind>.add(...)` した物は撤去で自動的に外れる（`tileFormats` だけは core の表＝process-wide で残り、capabilities からは外れる）。
- builtin（この版が持つ名前）は上書きも撤去もできない（投げる）。同名の plugin の二重搭載も投げる。
- 口だけの段（"spec"）の機能は、plugin が描かない限り**絵は変わらない**。嘘をつかない＝`supports()` は builtin か plugin の時だけ true。

## registry の一覧

| kind | 契約（add(name, impl) の impl） | 呼ばれ方 | capabilities の鍵 |
|---|---|---|---|
| `dataKinds` | `{ create(map, data, opts) → 手綱 }` | `map.addData(data, { kind })` の builtin（points/arcs/trips/polygons/paths/columns）以外 | `data.<kind>` |
| `gadgets` | `function (opts) { … }`（`map.gadget(name, fn)` と同じ・this＝map） | `map.gadget.<name>(opts)` | `gadget.<name>` |
| `tileFormats` | `{ decode(bytes, need) }` か `{ load() → Promise<decode> }`・`pmtilesType?`（core の registerTileFormat と同じ） | source の encoding がその名の時 | `tiles.<name>` |
| `lights` | `{ apply(map, lights) }` | `map.setLights([...])` のたびに、その type の光源の配列（無ければ []） | `light.<type>` |
| `clouds` | `{ apply(map, clouds \| null) }` | `map.setClouds(spec)` のたびに（`type:"image"` は builtin も描く＝W6・plugin は手続きの雲・降水を受け持てる） | `clouds` |
| `postEffects` | `{ apply(map, passes) }` | `map.setPostChain([...])` のたびに、その type の pass の配列 | `post.<type>` |
| `handlers` | `{ create(map, opts) → { start, stop, active } }` | `"walk"` は `map.walk(opts)` の中身。他の名は plugin の自由 | `camera.walk`・`handler.<name>` |
| `textureTranscoders` | `{ url }`（worker が import() する module＝`transcode(bytes) → { width, height, rgba }`） | 契約だけ（worker 側の読み込みは第 3 波） | `texture.<name>` |

## 絵を出す手段（plugin が持てる物）

1. **同一フレームのオーバーレイ**＝`map.overlay(url, { name, above })`。url は worker が `import()` する**依存ゼロ**のモジュール（import 文なし・vite の `?url`）で、
   `init(canvas, opts, host)`／`message(data)`／`frame(cam, camState, { w, h }, api) → boolean`／`pick?(x, y, r, ctx)`／`destroy()` を export する。地球・注記と同じフレーム・同じカメラで描き、
   `api.project/projectH/clipH/depth`（シーンの深度＝建物や地形に隠れる）が使える。見本＝`src/gadgets/points-gl.js`（点・RTE・GPU picking）・`arcs-gl.js`・`trips-gl.js`・`three-draw.js`（three.js を worker で）。
   手綱の `post(data, transfer)` で状態を渡し、`pick(x, y, r)` で当たりを返す（統一 picking＝`map.on("click", id, cb)`・`queryRenderedFeatures({ layers: [id] })` に乗る）。
   **文脈の数に気をつける**：render worker の WebGL 文脈は Chrome で 4 つまで（地球が 1 つ使う）。超えると一番古い文脈＝地球が落ちる。層ごとにオーバーレイを作らず、一つのオーバーレイに多くの層を載せる：
   手綱の `addLayerId(id)`／`removeLayerId(id)` で層の id を名乗り、module の `pick` の答えに `layer: id` を入れると、`map.on(ev, id)`・`queryRenderedFeatures({ layers: [id] })`・`pickOverlays({ names: [id] })` がその id で当たる（W9）。
2. **GeoJSON の層**＝`map.addSource/addLayer`（fill/line/circle/symbol/fill-extrusion/heatmap）＝MapLibre の意味で評価される既存の経路。`addData` の polygons/paths/columns はこれ。
3. **three.js**＝`map.addThree(url)`（worker 内の three.js・深度で隠れる）。
4. **DOM**＝`map.mapEl` に自前の要素（Marker/Popup と同じ層）。`map.makeProjectorH()` で毎フレーム投影。
5. **CSS filter**＝`map.mapEl.querySelector("canvas")` への filter（tone mapping や LUT の簡易な代わり＝postEffects の apply で掛け外しする）。

## 例：光源の type を足す（描くのは自前のオーバーレイ）

```js
const laser = definePlugin({
	name: "laser",
	install(map) {
		const ov = map.overlay(new URL("./laser-draw.js", import.meta.url).href, { name: "laser" });
		map.registry.lights.add("laser", { apply: (m, lights) => ov.post({ type: "lights", lights }) });
		return () => ov.remove();
	},
});
map.use(laser);
map.setLights([{ type: "directional" }, { type: "laser", position: [139.76, 35.68, 100], color: "#f00" }]);
```

## 例：後処理の pass を足す（CSS filter）

```js
map.use({ name: "sepia", install(m) {
	const cv = m.mapEl.querySelector("canvas");
	m.registry.postEffects.add("sepia", { apply: (mm, passes) => { const p = passes.find(x => x.enabled); cv.style.filter = p ? `sepia(${p.amount ?? 1})` : ""; } });
	return () => { cv.style.filter = ""; };
} });
map.setPostChain([{ type: "bloom" }, { type: "sepia", amount: 0.6 }]);
```

## 例：一人称歩行の中身

```js
map.use({ name: "legs", install(m) {
	m.registry.handlers.add("walk", { create: (mm, o) => {
		let raf = 0, on = false;
		const step = () => { if (!on) return; /* WASD → mm.easeTo / mm.setCamera・mm.sampleTerrain で足元の高さ */ raf = requestAnimationFrame(step); };
		return { start() { on = true; step(); }, stop() { on = false; cancelAnimationFrame(raf); }, get active() { return on; } };
	} });
} });
map.walk({ speed: 1.4, eyeHeight: 1.7 }).start();
```

## 予約された kind（受け口＝契約だけ・2026-10-12）

- `dataKinds` の **`splat`**（Gaussian splat）：`map.addData(data, { kind: "splat" })`。data＝`{ n, positions: Float32Array(n*3)（[lng,lat,alt] か ECEF＝opts.crs）, scales: Float32Array(n*3), rotations: Float32Array(n*4)（四元数）, colors: Uint8Array(n*4), sh?: Float32Array }` か .ply/.splat/.spz の URL（読み手は plugin）。
  plugin が無ければ `addData` は投げる（`capabilities()["data.splat"]` は "spec"）。描く段は同一フレームのオーバーレイ（深度つき・視線順のソート）＝`@ortho-earth/plugin-splat`（下の節）が実装している。
- `textureTranscoders` の **`ktx2`**：`{ url }`＝worker が import() する module（`export transcode(bytes: Uint8Array, { mimeType }) → { width, height, rgba: Uint8Array(width*height*4) }`・Promise でもよい）。模型（gadget model）と 3D Tiles の glb の KHR_texture_basisu の画像がこれを通って普通のテクスチャになる（第 3 波 W5）。登録が無ければ fallback の画像（texture.source）のまま＝`capabilities()["texture.ktx2"]` は "spec"、登録があれば "plugin"。`@ortho-earth/ktx2` が basis_universal の WASM（opt-in・既定は unpkg の @loaders.gl/textures の libs・`libraryPath` で自前配布）で実装している：`map.use(ktx2Plugin({ libraryPath }))`。

## 3D Tiles の要求と出典（requestTransform・attribution）

- `add3DTiles(url, { requestTransform(url, type) })`＝tileset.json・外部 tileset（type "Source"）とタイル（"Tile"）の全要求が通る。`{ url }` を返せば書き換え、null なら元のまま（F5）。
- `add3DTiles(url, { attribution })`＝文字列か `(copyrights) => 文字列|null`。copyrights＝今見えているタイルの glTF `asset.copyright`（";" で分け・多い順）。出典の欄に出て、remove で消える。手綱の `copyrights` でも読める（第 3 波 W8・`capabilities()["tiles3d.attribution"]`＝builtin）。
- `@ortho-earth/google-tiles` がこの二つで Google Photorealistic 3D Tiles を読む：鍵（key=…）は許した host への要求にだけ付け、子の tileset の URI にある session=… を覚えて後の要求に付け回す。出典は "Google; 提供元…"。`addGoogle3DTiles(map, { key })` か `map.use(googleTilesPlugin({ key }))` → `map.gadget.googleTiles()`。鍵はアプリが実行時に渡す（package にも repo にも置かない）。

## instanced・billboard・3D 文字（@ortho-earth/plugin-scene）

`map.use(scenePlugin())` で `addData` の kind が 3 つ増える（第 3 波 W9）。`dataKinds` と同一フレームのオーバーレイだけで作った見本でもある（`sdk/plugin-scene/src/index.js`＝main で焼く、`scene-gl.js`＝worker で描く・深度・当たり）。手綱がいくつあっても一つの map に一つのオーバーレイ（`above` の物は別にもう一つ）で描き、手綱の id を `addLayerId` で名乗る。

```js
import { scenePlugin } from "@ortho-earth/plugin-scene";
map.use(scenePlugin());
map.addData(trees, { kind: "instanced", id: "trees", shape: "cone", getPosition: d => [d.lon, d.lat], getScale: d => [4, 4, d.h], getColor: [40, 140, 60] });
map.addData(shops, { kind: "billboards", id: "pins", getIcon: "pin", icons: { pin: "/img/pin.png" }, getSize: 32, getPosition: d => [d.lon, d.lat, 20] });
map.addData(peaks, { kind: "labels3d", id: "peaks", getText: d => d.name, getSize: 14, getPosition: d => [d.lon, d.lat, d.ele], altitude: "absolute" });
```

`instanced` の shape＝box／cylinder／cone／sphere／`{ pos, idx, nrm?, col? }`（x 東・y 北・z 上・底が z 0）／圧縮なしの `.glb`。billboards と labels3d は `facing`（screen／flat／upright）と `sizeUnits`（pixels／meters）。どれも建物や地形に隠れ（`depthTest: false` で外す）、統一 picking に乗る。

## Gaussian splat（@ortho-earth/plugin-splat）

`map.use(splatPlugin())` で予約された kind "splat" に中身が入る（第 3 波 W10）。読み手（.ply／.splat／.spz）は main の素の JS、描き手（`splat-gl.js`）は worker で視線順に並べ替えて楕円を描く。plugin-scene と同じく一つの map に一つのオーバーレイで、手綱の id を `addLayerId` で名乗る。

```js
import { splatPlugin } from "@ortho-earth/plugin-splat";
map.use(splatPlugin());   // 自前の読み手（WASM など）は splatPlugin({ decoders: { spz: bytes => splatData } })
map.addData("/scenes/room.spz", { kind: "splat", id: "room", origin: [139.7671, 35.6812, 0], orientation: [30, 0, 0] });
map.addData({ positions, scales, rotations, colors }, { kind: "splat", id: "mine" });   // 経緯度の SplatData
```

URL と bytes は `origin` が要る（file の原点を置く経緯度）。`upAxis` の既定は .ply／.splat が "-y"（y 下・z 前）、.spz が "y"（y 上・z 後）。描くのは DC の色だけ（球面調和の残りは持つが使わない）。

## 検定

- `node tests/plugin.mjs`（契約・registry・capabilities の純関数）・`npm run verify:ui -- t-plugin`（default／lights／sun／post／gltf／tiles3d／terrain の変種）。
- 自分の plugin の検定は、`createGlobe({ plugins: [p] })` の後に `map.supports(...)` と `map.capabilities()[key].via === p.name` を見るのが最短。
