# @ortho-earth/plugin-splat

Gaussian splats for [`@ortho-earth/globe`](../../packages/globe). The plugin fills the reserved `map.addData` kind `"splat"`. The globe already checks the contract (`SplatData` in `src/splat.js`, or a `.ply` / `.splat` / `.spz` URL); this package reads the files and draws them.

- **Drawing** is a same-frame overlay with the globe's camera, **WebGPU first**: splats are sorted back to front on the GPU (a counting sort in three compute passes, re-run whenever the view direction turns), each splat is an ellipse projected from its 3D covariance, and the color is evaluated per view direction from the **spherical harmonics** (degree 1–3, as in the file). When the map itself draws with WebGPU the plugin shares the map's `GPUDevice` and reads the map's depth texture directly: no copy and no read-back. Browsers without WebGPU fall back to a WebGL2 renderer (DC color only, CPU sort).
- Splats are **hidden by terrain and buildings** through the scene depth.
- They are **picked** by the unified picking: `handle.pick(x, y)`, `map.on("click", id, …)` and `queryRenderedFeatures({ layers: [id] })`. A hit carries the splat `index`, its `lngLat` and your `properties`.
- **Readers** are plain JS on the main thread: 3DGS `.ply` (binary little endian, `f_rest_*` kept as SH), `.splat` (32 bytes per splat) and `.spz` v2 / v3 (with SH). `.spz` is gunzipped with the browser's built-in `DecompressionStream`, so no WASM is needed. To use your own reader (for example a WASM build), pass `splatPlugin({ decoders: { spz: bytes => splatData } })`.

```js
import { createGlobe } from "@ortho-earth/globe";
import { splatPlugin } from "@ortho-earth/plugin-splat";

const map = await createGlobe({ target: "#map", plugins: [splatPlugin()] });   // or map.use(splatPlugin({ backend: "auto" | "webgpu" | "webgl2" }))
map.supports("data.splat");                                                   // true ("plugin", via "plugin-splat")

// a capture file, placed with its origin on the map
const room = map.addData("/scenes/room.spz", { kind: "splat", id: "room", origin: [139.7671, 35.6812, 0], orientation: [30, 0, 0] });
// your own splats in longitude / latitude
const mine = map.addData({ positions, scales, rotations, colors }, { kind: "splat", id: "mine", properties: { source: "survey" } });

await room.ready;
room.backend;                                                                 // "webgpu" | "webgl2" (null until the overlay has chosen)
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
| `shDegree` | highest spherical-harmonics degree to draw: `0` (DC only) … `3` (default: whatever the data has). WebGPU only |

`SplatData` is `{ n?, positions, scales, rotations, colors, sh?, crs? }`. `scales` are the sigma of each axis in meters, `rotations` are quaternions `x, y, z, w`, and the alpha of `colors` is the opacity. With `crs: "lnglat"` (default) the rotations are in the local east-north-up frame; with `crs: "ecef"` they are in earth-centered axes. `sh` holds the coefficients above DC, coefficient-major: `n × K×3` with `sh[i*K*3 + k*3 + c]`, `K = 3 / 8 / 15` for degree 1 / 2 / 3 (the `.spz` order; the readers reorder `.ply`'s `f_rest_*`). The handle is `{ id, kind, n, anchor, backend, ready, setData, setProps, setVisible, pick, remove, overlay }`.

## Renderers

| | WebGPU (default where available) | WebGL2 (fallback) |
|---|---|---|
| color | DC + spherical harmonics (degree 1–3, quantized to 8 bit like `.spz`) | DC only |
| sorting | GPU counting sort, every time the view direction turns | CPU counting sort on the render worker; layers above 200,000 splats at most every 0.1 s |
| depth | the map's packed depth texture, shared when the map draws with WebGPU (no copy) | the map's depth uploaded as a texture once per frame |
| picking | id pass to `r32uint`, read back asynchronously (needs an `@ortho-earth/globe` newer than 2.0.1, whose render worker awaits a Promise from `pick`) | id pass, synchronous read |

`splatPlugin({ backend })` picks: `"auto"` (default) tries WebGPU and falls back, `"webgpu"` fails without it, `"webgl2"` forces the fallback. `handle.backend` says which one draws.

## Limits

- A layer is placed rigidly around one anchor (the mean of its positions, or `origin`), so the scene should span kilometers at most. `positions` in `crs: "lnglat"` are `Float32Array` by contract, which rounds to about a meter; use a file with `origin` for finer scenes.
- No level of detail yet: every splat of a layer is drawn each frame. Keep layers to a few million splats.
- One overlay holds every splat layer of a map (the render worker allows only a few WebGL contexts).
- `map.snapshot()` does not include the WebGPU overlay canvas yet.
- The SH coefficients are stored as 8-bit signed values scaled by the layer's largest coefficient, like `.spz`.

Tests: `npm test -w @ortho-earth/plugin-splat` (node: the three readers including `.spz` v2 and v3 and the `.ply` SH reorder, ENU placement for lnglat / ecef / local, covariances, SH packing and the SH frame, sorting, plugin shape) and, in `packages/globe`, `npm run verify:ui -- t-psplat` (WebGL2) and `npm run verify:webgpu -- t-psplat` (WebGPU): a tower at Tokyo Station, a splat in front is drawn and one behind is hidden, an elongated ellipse stays elongated on screen, a near splat is drawn over a far one, `.splat` and `.spz` URLs, a degree-1 SH splat changes color with the view (WebGPU), picks, setVisible, remove, unuse.
