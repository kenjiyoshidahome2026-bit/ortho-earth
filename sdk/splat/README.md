# @ortho-earth/splat

Gaussian splats for [`@ortho-earth/globe`](../../packages/globe). The plugin fills the reserved `map.addData` kind `"splat"`. The globe already checks the contract (`SplatData` in `src/splat.js`, or a `.ply` / `.splat` / `.spz` / `.ksplat` / `.sog` URL); this package reads the files and draws them.

- **Drawing** is a same-frame overlay with the globe's camera, **WebGPU first**: splats are sorted back to front on the GPU (a counting sort in three compute passes, re-run whenever the view direction turns), each splat is an ellipse projected from its 3D covariance, and the color is evaluated per view direction from the **spherical harmonics** (degree 1–3, as in the file). The plugin shares the map's `GPUDevice` and reads the map's depth texture directly: no copy and no read-back. Where the map draws with WebGL2 (no WebGPU in the browser) the plugin falls back to a WebGL2 renderer (DC color only, CPU sort).
- Splats are **hidden by terrain and buildings** through the scene depth.
- They are **picked** by the unified picking: `handle.pick(x, y)`, `map.on("click", id, …)` and `queryRenderedFeatures({ layers: [id] })`. A hit carries the splat `index`, its `lngLat` and your `properties`.
- **Readers** run in a worker (`splat-reader.ts`): fetch, gunzip, parse, ENU placement, SH packing and the LoD ranking all happen off the main thread, which only forwards the buffers (transferred, not copied) to the renderer. 3DGS `.ply` (binary little endian, `f_rest_*` kept as SH), `.splat` (32 bytes per splat), `.spz` v2 / v3 (with SH), `.ksplat` (GaussianSplats3D's `SplatBuffer`: compression levels 0 / 1 / 2, bucketed positions, SH degree 0–2) and `.sog` v2 (PlayCanvas' Spatially Ordered Gaussians as the zip bundle: `meta.json` plus the WebP planes, codebooks and the SH palette); `.spz` is gunzipped and `.sog` unzipped with the built-in `DecompressionStream`, so no WASM is needed. The `.sog` WebP planes are decoded with `createImageBitmap` and read back through a WebGL2 texture (exact bytes, no premultiplied alpha; a 2D canvas is the fallback), or with your own `decodeImage` through `parseSog(bytes, { decodeImage })`. The unbundled `.sog` folder (a bare `meta.json` next to its images) is not read. Your own reader (for example a WASM build) plugs in with `splatPlugin({ decoders: { spz: bytes => splatData } })` and runs on the main thread (a function cannot cross to the worker). `handle.reader` says where the last source was read.
- **3D Tiles**: a tileset whose glTF content carries [`KHR_gaussian_splatting`](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_gaussian_splatting) (Release Candidate attribute names, the older `_SCALE` / `_ROTATION` / `_OPACITY` draft with log scales, and `KHR_gaussian_splatting_compression_spz_2` bytes) streams through `map.add3DTiles(url)` once this plugin is in: the globe's tile worker hands every splat primitive over as local coordinates plus the tile's `transform`, and the gadget makes one `"splat"` layer per tile (`setVisible` as tiles refine, `remove` on unload, picks carry `properties.tile`). `add3DTiles(url, { splat: { depthTest: false, shDegree: 1, … } })` passes options to those layers. Without the plugin the tiles are drawn as points (the extension's fallback) with one warning.
- **Level of detail** (WebGPU): every splat gets a rank by weight (opacity × size) when it is read. When a layer is small on screen only the heaviest splats are drawn, about 2 per screen pixel of the layer's footprint (at least 4096), and the GPU sort only touches those. Zooming in brings the rest back; `handle.drawn` says how many the last frame drew. `lod: false` draws everything, a number sets the density.

```js
import { createGlobe } from "@ortho-earth/globe";
import { splatPlugin } from "@ortho-earth/splat";

const map = await createGlobe({ target: "#map", plugins: [splatPlugin()] });   // or map.use(splatPlugin({ backend: "auto" | "webgpu" | "webgl2" }))
map.supports("data.splat");                                                   // true ("plugin", via "splat")

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

## Point clouds → splats (WebGPU)

A LAS / LAZ / COPC file, or a `.zip` with a LAS inside, can be given as a splat source. The engine reads the points (`map.readPointCloud`, the COPC worker: CRS, geoid, ENU placement, at most `maxPoints` of them, the shallow COPC nodes first), and the render worker turns them into Gaussian splats **on the GPU** with WebGPU compute: a spatial-hash counting sort, one splat per cell with its covariance from the neighbouring points (so a road becomes thin flat splats and a wall becomes upright ones), and coarser levels (cell × 2, × 4, …) merged from the finer one. Each frame draws the level whose splats are about `pxPerSplat` pixels on screen, so a far view costs a few thousand splats and a close view the finest level. Nothing is sent back to the main thread unless you ask for it.

```js
const pc = map.addData("https://…/08NF2392.zip", { kind: "splat", id: "pc", crs: "EPSG:6676", vertical: "orthometric", color: "auto",
	maxPoints: 4e6, cloud: { detail: 1 }, onProgress: (loaded, total) => {} });
await pc.ready;                               // rejects with "WebGPU is required …" when the overlay draws with WebGL2
pc.points; pc.levels; pc.level; pc.plan; pc.ms;   // points read · [{ n, cell, radius, bb }] (level 0 is the finest) · level drawn last frame · plan · { read, build, total } ms
pc.setAltitude(alt);                          // move the anchor (m above the ellipsoid)

const data = await pc.read();                 // { anchor, levels: [{ n, cell, ctr, cov, col, bb, radius }] } — the GPU buffers, for OPFS / IndexedDB
const again = addSplatCloud(map, data, { id: "pc2" });   // back on the map with no conversion (ms.build = 0)

// export (cloud-export.ts): one level as .spz (gzipped) with its placement, or 3D Tiles (tileset.json + one glb per level,
// KHR_gaussian_splatting + KHR_gaussian_splatting_compression_spz_2, REPLACE refinement, root transform ENU → ECEF); zipStore packs the files
import { cloudToSpz, spzPlacement, cloudTo3DTiles, zipStore } from "@ortho-earth/splat";
const spz = await cloudToSpz(data, 0);                 // finest level; spzPlacement(data) → { anchor, addData: { origin, upAxis: "z", altitude: "absolute" }, transform }
const zip = zipStore(await cloudTo3DTiles(data));      // tileset.json, level0.glb, level1.glb, …
```

| option | meaning |
|---|---|
| `crs`, `vertical` | the file's horizontal CRS (`"EPSG:6676"` or WKT) and `"orthometric"` / `"ellipsoidal"` when the file does not say |
| `maxPoints` | at most this many points are read (default 4,000,000; 1,500,000 on low-memory devices; `0` = all) |
| `color` | `"auto"` (RGB when the file has it, else elevation), `"rgb"`, `"elevation"`, `"intensity"`, `"classification"` (ASPRS colors); `elevationRange` / `intensityRange` set the ramps |
| `cloud.detail` | level-0 cell = point spacing × detail (`2` → about a quarter of the splats) |
| `cloud.levels` | number of levels (default: until the coarsest cell is 1/16 of the extent, 1–8) |
| `cloud.fill`, `cloud.cap`, `cloud.maxNb`, `cloud.radius` | thickness added to each splat, the size cap, and the neighbour count / radius (× cell) of the covariance |
| `cloud.pxPerSplat` | switch to the finer level when a splat is wider than this many pixels (default 1.5) |

**CLI** (repo tool, not in the npm package): `node sdk/splat/scripts/las2splat.mjs <in.las|.laz|.copc.laz|.zip> --out <dir> [--gpu|--cpu] [--crs EPSG:6676] [--vertical orthometric] [--max-points 4000000] [--color auto] [--detail 1] [--levels N] [--format tiles|spz|both]`. `--gpu` (default) opens `packages/globe/tests/tool-las2splat.html` in the headless Chrome for Testing with a real GPU (the same stand as `verify:webgpu`) and runs the browser pipeline, writing the files back through a small local HTTP server; `--cpu` runs the same algorithm in node (`buildCloudCpu`, laz-perf, the engine's CRS and ENU helpers) and is slow for millions of points. Output: `tileset.json` + `level<L>.glb`, and/or `<name>.spz` + `placement.json`.

This is **WebGPU only** by design: with the WebGL2 renderer `ready` rejects (`WebGPU is required for point cloud splats`) and nothing is converted on the CPU. `buildCloudCpu` (the same algorithm in plain JS) exists for tests and the CLI, not for the page.

## Options

| option | meaning |
|---|---|
| `id` | layer id for picking and `map.on` |
| `origin` | file sources: `[lng, lat, alt]` of the file's origin (required for URLs and bytes) |
| `upAxis` | file sources: `"z"`, `"y"` (right-up-back) or `"-y"` (right-down-forward). Default `.ply` / `.splat` / `.ksplat` `"-y"`, `.spz` / `.sog` `"y"` |
| `orientation`, `scale` | file sources: `[heading, pitch, roll]` degrees and meters per file unit |
| `format` | `"ply"`, `"splat"`, `"spz"`, `"ksplat"` or `"sog"` when the URL has no extension or for bytes |
| `transform` | column-major 4×4 matrix (16 numbers) from the data's local axes to ECEF meters, for `crs: "local"` data and for file sources that come from a 3D Tiles tile. Replaces `origin` / `upAxis` / `orientation` / `scale`; the default `altitude` becomes `"absolute"` |
| `altitude` | `"relative"` (alt above the ground, default) or `"absolute"`. Data in `crs: "ecef"` defaults to `"absolute"` |
| `opacity` | multiplies every splat's opacity |
| `depthTest` | hidden by terrain and buildings (default true) |
| `above` | draw above the labels |
| `properties` | merged into every pick hit's properties |
| `shDegree` | highest spherical-harmonics degree to draw: `0` (DC only) … `3` (default: whatever the data has). WebGPU only |
| `lod` | level of detail: `true` (default, about 2 splats per screen pixel of the layer's footprint when it is small on screen), a number (that density), `false` (always every splat). WebGPU only |

`SplatData` is `{ n?, positions, scales, rotations, colors, sh?, crs?, transform? }`. `scales` are the sigma of each axis in meters, `rotations` are quaternions `x, y, z, w`, and the alpha of `colors` is the opacity. With `crs: "lnglat"` (default) the rotations are in the local east-north-up frame; with `crs: "ecef"` they are in earth-centered axes; with `crs: "local"` the positions, scales and rotations are in the axes of `transform` (a column-major 4×4 to ECEF, in the data or in the options), which is how 3D Tiles content arrives. `sh` holds the coefficients above DC, coefficient-major: `n × K×3` with `sh[i*K*3 + k*3 + c]`, `K = 3 / 8 / 15` for degree 1 / 2 / 3 (the `.spz` order; the readers reorder `.ply`'s `f_rest_*`). The handle is `{ id, kind, n, anchor, backend, drawn, reader, ready, setData, setProps, setVisible, pick, remove, overlay }`.

## Renderers

| | WebGPU (default where available) | WebGL2 (fallback) |
|---|---|---|
| color | DC + spherical harmonics (degree 1–3, quantized to 8 bit like `.spz`) | DC only |
| sorting | GPU counting sort, every time the view direction turns | CPU counting sort on the render worker; layers above 200,000 splats at most every 0.1 s |
| depth | the map's packed depth texture, shared when the map draws with WebGPU (no copy) | the map's depth uploaded as a texture once per frame |
| picking | id pass to `r32uint`, read back asynchronously (needs an `@ortho-earth/globe` newer than 2.0.1, whose render worker awaits a Promise from `pick`) | id pass, synchronous read |
| level of detail | the heaviest N splats when the layer is small on screen (`lod`, `handle.drawn`) | every splat, always |

`splatPlugin({ backend })` picks: `"auto"` (default) draws with WebGPU when the map itself draws with WebGPU (sharing its device) and with WebGL2 otherwise; `"webgpu"` uses WebGPU even under a WebGL2 map (its own device, depth uploaded per frame) and fails where there is none; `"webgl2"` forces the fallback. `handle.backend` says which one draws.

## Limits

- A layer is placed rigidly around one anchor (the mean of its positions, or `origin`), so the scene should span kilometers at most. `positions` in `crs: "lnglat"` are `Float32Array` by contract, which rounds to about a meter; use a file with `origin` for finer scenes.
- The level of detail is a weight-ordered subset of one file (the heaviest splats first), not a hierarchy: a layer that fills the screen still draws every splat, and the whole file is read and uploaded. Keep layers to a few million splats, or stream them as 3D Tiles with `KHR_gaussian_splatting` (one layer per tile, selected by screen-space error like any tileset).
- One overlay holds every splat layer of a map (the render worker allows only a few WebGL contexts).
- `map.snapshot()` does not include the WebGPU overlay canvas yet.
- The SH coefficients are stored as 8-bit signed values scaled by the layer's largest coefficient, like `.spz`.

Tests: `npm test -w @ortho-earth/splat` (node: `t-cloud.mjs` = the point-cloud plan, hash, level choice, colors, the CPU reference build, SPZ / glTF axes / 3D Tiles helpers; `t-splat.mjs` = the five readers including `.spz` v2 and v3, `.ksplat` at compression 0 / 1 / 2 with buckets and the SH reorder, `.sog` v2 from a synthetic zip with a PNG stand-in decoder, and the `.ply` SH reorder, ENU placement for lnglat / ecef / local, a local layer placed by a `transform`, covariances, SH packing and the SH frame, sorting, the LoD rank and count, the reader's `read` with bytes / URL / data, plugin shape) and, in `packages/globe`, `npm run verify:ui -- t-psplat` (WebGL2) and `npm run verify:webgpu -- t-psplat` (WebGPU): a tower at Tokyo Station, a splat in front is drawn and one behind is hidden, an elongated ellipse stays elongated on screen, a near splat is drawn over a far one, `.splat` and `.spz` URLs, a degree-1 SH splat changes color with the view (WebGPU), every source read in the worker, a 20,000-splat patch drawn with fewer splats while it is small on screen and with all of them after `lod: false` (WebGPU), picks, setVisible, remove, unuse. The 3D Tiles path: `npm test -w @ortho-earth/globe` (node: `tests/tiles3d-splat.mjs` decodes a fixture tileset with Release Candidate names, degree-1 SH, the draft names and an SPZ child) and `npm run verify:ui -- t-tiles3d-splat` / `verify:webgpu -- t-tiles3d-splat` (four children in four colors land in the right quadrants, picks carry the tile id, the parent alone when far, remove takes every layer down; `?v=noplugin` = points fallback).

## License

GPL-3.0-or-later ([LICENSE](LICENSE)). A commercial license — without GPL obligations such as disclosing
your site's source — is available: contact kenji.yoshida.home.2026@gmail.com.
