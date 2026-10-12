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
| `clouds` | `{ apply(map, clouds \| null) }` | `map.setClouds(spec)` のたびに | `clouds` |
| `postEffects` | `{ apply(map, passes) }` | `map.setPostChain([...])` のたびに、その type の pass の配列 | `post.<type>` |
| `handlers` | `{ create(map, opts) → { start, stop, active } }` | `"walk"` は `map.walk(opts)` の中身。他の名は plugin の自由 | `camera.walk`・`handler.<name>` |
| `textureTranscoders` | `{ url }`（worker が import() する module＝`transcode(bytes) → { width, height, rgba }`） | 契約だけ（worker 側の読み込みは第 3 波） | `texture.<name>` |

## 絵を出す手段（plugin が持てる物）

1. **同一フレームのオーバーレイ**＝`map.overlay(url, { name, above })`。url は worker が `import()` する**依存ゼロ**のモジュール（import 文なし・vite の `?url`）で、
   `init(canvas, opts, host)`／`message(data)`／`frame(cam, camState, { w, h }, api) → boolean`／`pick?(x, y, r, ctx)`／`destroy()` を export する。地球・注記と同じフレーム・同じカメラで描き、
   `api.project/projectH/clipH/depth`（シーンの深度＝建物や地形に隠れる）が使える。見本＝`src/gadgets/points-gl.js`（点・RTE・GPU picking）・`arcs-gl.js`・`trips-gl.js`・`three-draw.js`（three.js を worker で）。
   手綱の `post(data, transfer)` で状態を渡し、`pick(x, y, r)` で当たりを返す（統一 picking＝`map.on("click", id, cb)`・`queryRenderedFeatures({ layers: [id] })` に乗る）。
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
  plugin が無ければ `addData` は投げる（`capabilities()["data.splat"]` は "spec"）。描く段は同一フレームのオーバーレイ（深度つき・視線順のソート）＝plugin か第 3 波。
- `textureTranscoders` の **`ktx2`**：`{ url }`＝worker が import する module（`transcode(bytes) → { width, height, rgba }`）。worker 側の読み込みは第 3 波。

## 検定

- `node tests/plugin.mjs`（契約・registry・capabilities の純関数）・`npm run verify:ui -- t-plugin`（default／lights／sun／post／gltf／tiles3d／terrain の変種）。
- 自分の plugin の検定は、`createGlobe({ plugins: [p] })` の後に `map.supports(...)` と `map.capabilities()[key].via === p.name` を見るのが最短。
