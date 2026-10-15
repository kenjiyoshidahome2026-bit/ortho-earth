# @ortho-earth/plugin-splat

Gaussian splats for [`@ortho-earth/globe`](../../packages/globe). The plugin fills the reserved `map.addData` kind `"splat"`. The globe already checks the contract (`SplatData` in `src/splat.js`, or a `.ply` / `.splat` / `.spz` URL); this package reads the files and draws them.

- **Drawing** is a same-frame overlay with the globe's camera (WebGL2). Each splat is an ellipse projected from its 3D covariance. Splats are blended back to front, re-sorted by view depth when the view direction turns.
- Splats are **hidden by terrain and buildings** through the scene depth.
- They are **picked** by the unified picking: `handle.pick(x, y)`, `map.on("click", id, …)` and `queryRenderedFeatures({ layers: [id] })`. A hit carries the splat `index`, its `lngLat` and your `properties`.
- **Readers** are plain JS on the main thread: 3DGS `.ply` (binary little endian), `.splat` (32 bytes per splat) and `.spz` v2 / v3. `.spz` is gunzipped with the browser's built-in `DecompressionStream`, so no WASM is needed. To use your own reader (for example a WASM build), pass `splatPlugin({ decoders: { spz: bytes => splatData } })`.

```js
import { createGlobe } from "@ortho-earth/globe";
import { splatPlugin } from "@ortho-earth/plugin-splat";

const map = await createGlobe({ target: "#map", plugins: [splatPlugin()] });   // or map.use(splatPlugin())
map.supports("data.splat");                                                   // true ("plugin", via "plugin-splat")

// a capture file, placed with its origin on the map
const room = map.addData("/scenes/room.spz", { kind: "splat", id: "room", origin: [139.7671, 35.6812, 0], orientation: [30, 0, 0] });
// your own splats in longitude / latitude
const mine = map.addData({ positions, scales, rotations, colors }, { kind: "splat", id: "mine", properties: { source: "survey" } });

await room.ready;
map.on("click", "room", e => console.log(e.features[0].properties.index));
room.setVisible(false);
mine.remove();
```

## Options

| option | meaning |
|---|---|
| `id` | layer id for picking and `map.on` |
| `origin` | file sources: `[lng, lat, alt]` of the file's origin (required for URLs and bytes) |
| `upAxis` | file sources: `"z"`, `"y"` (right-up-back) or `"-y"` (right-down-forward). Default `.ply` / `.splat` `"-y"`, `.spz` `"y"` |
| `orientation`, `scale` | file sources: `[heading, pitch, roll]` degrees and meters per file unit |
| `format` | `"ply"`, `"splat"` or `"spz"` when the URL has no extension |
| `altitude` | `"relative"` (alt above the ground, default) or `"absolute"`. Data in `crs: "ecef"` defaults to `"absolute"` |
| `opacity` | multiplies every splat's opacity |
| `depthTest` | hidden by terrain and buildings (default true) |
| `above` | draw above the labels |
| `properties` | merged into every pick hit's properties |

`SplatData` is `{ n?, positions, scales, rotations, colors, sh?, crs? }`. `scales` are the sigma of each axis in meters, `rotations` are quaternions `x, y, z, w`, and the alpha of `colors` is the opacity. With `crs: "lnglat"` (default) the rotations are in the local east-north-up frame; with `crs: "ecef"` they are in earth-centered axes. The handle is `{ id, kind, n, anchor, ready, setData, setProps, setVisible, pick, remove, overlay }`.

## Limits

- Only the DC color is drawn. Higher spherical harmonics (`sh`, `f_rest_*`) are read and kept but not used.
- A layer is placed rigidly around one anchor (the mean of its positions, or `origin`), so the scene should span kilometers at most. `positions` in `crs: "lnglat"` are `Float32Array` by contract, which rounds to about a meter; use a file with `origin` for finer scenes.
- Sorting runs on the render worker's thread. Layers above 200,000 splats are re-sorted at most every 0.1 s while the view turns.
- One overlay holds every splat layer of a map (the render worker allows only a few WebGL contexts).
- Drawing is WebGL2 on the overlay canvas in the render worker. The page check runs on the WebGL2 backend.

Tests: `npm test -w @ortho-earth/plugin-splat` (node: the three readers including `.spz` v2 and v3, ENU placement for lnglat / ecef / local, covariances, sorting, plugin shape) and, in `packages/globe`, `npm run verify:ui -- t-psplat` (a tower at Tokyo Station: a splat in front is drawn and one behind is hidden, an elongated ellipse stays elongated on screen, a near splat is drawn over a far one, `.splat` and `.spz` URLs, picks, setVisible, remove, unuse).
