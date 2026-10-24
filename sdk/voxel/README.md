# @ortho-earth/voxel

Voxel grids for [`@ortho-earth/globe`](../../packages/globe). The plugin fills the reserved `map.addData` kind `"voxel"`. The globe already checks the contract (`VoxelData` in `src/voxel.ts`); this package draws it.

- **Drawing** is a same-frame overlay with the globe's camera: the grid's bounding box (or the curved shell of a `region` grid) is rasterised and the fragment shader **marches a ray through the cells**. `render: "blocks"` stops at the first solid cell (DDA, one step per cell) and shades it by its face, like a block world. `render: "volume"` takes fixed steps, samples the grid trilinearly and composites the colormap's colour and alpha front to back, like a weather or density field. `render: "iso"` finds where the value crosses `threshold` (bisection) and shades that surface by the field's gradient. All three come from the **same `VoxelData`**; only the option differs.
- **WebGPU first**: when the globe draws with WebGPU the overlay shares its `GPUDevice` and reads the scene depth texture directly (no copy); otherwise it draws with WebGL2 (every device, including Android where the globe itself is WebGL2). Same shader logic in WGSL and GLSL, same pixels.
- Grids are **hidden by terrain and buildings** through the scene depth: the ray stops where the scene is.
- `clip` keeps a sub-box of the grid (a thin range is a **slice**); it changes without re-uploading the grid, as do `render`, `opacity`, `step`, `threshold`, `colormap`, `alphaRamp`, `depthTest` and `properties`.
- They are **picked** by the unified picking: `handle.pick(x, y)`, `map.on("click", id, …)` and `queryRenderedFeatures({ layers: [id] })`. A hit carries the cell `index`, its `[i, j, k]` `cell`, the cell's `value` (scalar grids, via `handle.pick`) and your `properties`. Picking marches only the pixels under the cursor (scissor), so it stays cheap.
- **Preparation** runs in a worker (`voxel-reader.ts`): values are quantised to 8 bits (`R8`, or `RGBA8` for `components: 4`), the colormap is baked, the box is placed or the region shell is tessellated; the main thread only forwards the buffers.
- **Large grids** are split into **bricks**: a grid with an axis beyond 256 cells (the 3D texture size every WebGL2 device guarantees) becomes bricks of 126 cells per axis, one texture each with a 1-cell apron so trilinear sampling and iso gradients run across the seams. Bricks are drawn far to near, a brick whose cells are all below `threshold` (or empty) is skipped, and `clip`, `threshold`, picking (`index` / `cell` of the whole grid) and every style change work across them. `handle.bricks` says how many.
- **Time**: `times` (ms, ascending) makes `values` a run of frames, one per time. The layer follows `map.clock` by default (the last frame at or before the clock's time; scrub or play the clock and the frame changes without re-uploading), or `time: <ms>` pins one frame. One `range` covers every frame so colours compare across time. Only the frame shown is on the GPU; the others wait in the overlay's memory and go up when the clock reaches them.
- **GPU budget**: `voxelPlugin({ budget })` (MB, default 512, 128 on touch devices) caps the voxel textures of a map. A grid bigger than half of it also gets coarser levels (1/2, 1/4… cells per axis, averaging the non-empty cells), per brick. When the layers in view would not fit, the farthest ones (by distance over cell size) are drawn from a coarser level, and the textures of layers out of view are let go. `handle.levels` says how many coarser levels were made.
- Stages 1–4 are done (box and region grids, blocks / volume / iso, clipping, WebGPU and WebGL2, 3D Tiles `EXT_primitive_voxels`); stage 5 has bricks, time and the GPU budget with levels of detail, while file readers (NetCDF, Zarr) follow. See [PLAN.md](./PLAN.md).

```js
import { createGlobe } from "@ortho-earth/globe";
import { voxelPlugin } from "@ortho-earth/voxel";

const map = await createGlobe({ target: "#map", plugins: [voxelPlugin()] });   // or map.use(voxelPlugin({ backend: "auto" | "webgpu" | "webgl2" }))
map.supports("data.voxel");                                                    // true ("plugin", via "voxel")

// a 64 × 64 × 32 density field, 2 km × 2 km × 1 km, its origin corner at Tokyo station
const field = map.addData({
	dims: [64, 64, 32],
	box: { origin: [139.7671, 35.6812, 0], size: [2000, 2000, 1000] },
	values: new Float32Array(64 * 64 * 32),   // x fastest: values[i + 64 * (j + 64 * k)]
	noData: 0,
}, { kind: "voxel", id: "field", render: "volume", colormap: "turbo", opacity: 0.3 });

// the same grid as opaque blocks, cells below 0.5 empty; then as the 0.5 surface; then sliced
const blocks = map.addData(sameData, { kind: "voxel", id: "blocks", render: "blocks", threshold: 0.5, colormap: ["#3a6", "#fd4"] });
blocks.setProps({ render: "iso" });                       // no re-upload
blocks.setProps({ clip: [0, 1, 0, 1, 0.45, 0.55] });      // a horizontal slice

// a weather field on a longitude × latitude × height grid (west, south, east, north in degrees; heights in meters)
const wx = map.addData({ dims: [120, 80, 20], region: [128, 30, 146, 46, 0, 12000], values: temperature }, { kind: "voxel", id: "wx", colormap: "magma", opacity: 0.4 });

await field.ready;
field.backend;                                             // "webgpu" | "webgl2" (null until the overlay has chosen)
map.on("click", "field", e => console.log(e.features[0].properties.cell));
```

## VoxelData

| field | meaning |
|---|---|
| `dims` | `[nx, ny, nz]` cells; `values[i + nx * (j + ny * k)]` |
| `box` | `{ origin: [lng, lat, alt], size: [m, m, m], orientation?: [heading, pitch, roll] }` — the grid's x, y, z axes point east, north, up from the origin corner (heading rotates them clockwise from north); or `{ transform }`, a column-major 4×4 that takes the **unit cube `[0, 1]³`** to ECEF meters (the column lengths are the edges; the way a 3D Tiles tile transform × a glTF node matrix places a voxel primitive). A transform box is placed at its absolute height |
| `region` | `[west, south, east, north, h0, h1]` degrees and meters: cell x follows longitude, y latitude, z height. `east < west` crosses the antimeridian. Placed at its absolute height |
| `values` | `Float32Array`, `Uint16Array` or `Uint8Array`, `nx·ny·nz·components` long (× the number of `times`) |
| `components` | `1` (scalar, coloured by the colormap; default) or `4` (RGBA, drawn as is; alpha 0 = empty) |
| `noData` | cells with this value are empty |
| `range` | values mapped to the colormap's 0..1 (default the data's min / max over every frame) |
| `times` | frame times in ms, strictly ascending; `values` holds the frames one after another (globe 2.2.0+) |

## Options

| option | meaning |
|---|---|
| `id` | layer id for picking and `map.on` |
| `render` | `"volume"` (default), `"blocks"` or `"iso"` |
| `colormap` | a name (`viridis` `magma` `inferno` `plasma` `turbo` `grey` `heat` `cool` `blues` `reds`), a list of colours spread evenly, or `[t, colour]` stops. Colours `"#rrggbb"`, `"#rrggbbaa"` or `[r, g, b, a?]` |
| `range` | overrides the data's `range` |
| `threshold` | blocks / volume: cells below this value (data units) are empty; iso: the value of the surface |
| `clip` | `[x0, x1, y0, y1, z0, z1]` fractions 0..1 of each axis to keep (default everything) |
| `alphaRamp` | volume: alpha over the colormap's 0..1 when the colours carry none (default `[0, 1]`) |
| `step` | volume / iso: distance between samples in cells (default 0.5; smaller is finer and slower). Region blocks sample every quarter cell |
| `opacity` | multiplies every cell's opacity (default 1) |
| `altitude` | `"relative"` (the origin's alt is above the ground, default for origin boxes) or `"absolute"` (above the ellipsoid; default for transform boxes and regions) |
| `depthTest` | hidden by terrain and buildings (default true) |
| `above` | draw above the labels (default false) |
| `properties` | merged into every pick hit's `properties` |
| `time` | grids with `times`: `"clock"` (follow `map.clock`, default) or a time in ms (show the frame at or before it) |

## Handle

`id`, `kind`, `shape`, `dims`, `n` (cells), `bricks` (0 = one texture), `levels` (coarser levels for the budget, 0 = none), `times` (null without frames), `frame` (the frame shown), `anchor`, `range`, `backend` (`"webgpu"` | `"webgl2"`, null until the overlay has chosen), `reader` (`"worker"` | `"main"`), `error` (the renderer refused the layer, e.g. a grid beyond the 3D texture limit), `ready`, `setData(data)`, `setProps(opts)` (style-only changes do not re-upload the grid), `setVisible(on)`, `pick(x, y, r?)` (the value of the frame shown), `remove()`.

## Notes

- Scalar values are quantised to 8 bits for the GPU (`range` → 1..255, 0 = empty). The colormap resolves 256 steps and an iso threshold lands on one of them; `handle.pick` reports the original value from the data kept on the main thread.
- A grid with every axis within 256 cells is one texture; a larger one is split into bricks (above). The bricks are kept in GPU memory as a whole (1 byte per cell, 4 for RGBA): a 1024 × 1024 × 128 grid needs 128 MB, so very large grids need level of detail (still to come) on phones.
- Region grids are marched in meters along a straight ray and each sample is converted back to longitude / latitude / height, so cell borders are the true meridians, parallels and height surfaces. Their blocks mode samples the nearest cell every quarter cell instead of a DDA (slightly soft edges). The shell is built on a sphere; under the ellipsoid display (`?ell=1`) a country-sized region can sit a few km off, which stage 3 will tighten. Very large regions (thousands of km) shade with the anchor's east / north / up.
- All grids of one map share one overlay canvas (the render worker's WebGL contexts are limited); the overlay goes away a moment (`OVERLAY_LINGER_MS`, 250 ms) after the last handle is removed, so `remove()` followed at once by `addData()` (switching scenes) keeps the same overlay instead of tearing it down and racing a new one with the same name.
- **3D Tiles**: a tileset whose glTF content carries `EXT_primitive_voxels` (with `KHR_implicit_shapes` boxes or `EXT_implicit_ellipsoid_region` regions), or whose `root.content` declares `3DTILES_content_voxels` (the grid fills the tile's bounding volume), becomes one layer per tile through `map.add3DTiles(url, { voxel: { render, colormap, threshold, property, … } })`; `property` picks the attribute (a class property name works too). Cylinders are not drawn yet; without this plugin the globe skips the grids and warns once.
- A live example: [`/globe/voxel`](https://www.ortho-earth.com/globe/voxel) (`apps/voxel/voxel.ts`): a noise cloud, a torus, Mt. Fuji as blocks from `map.sampleTerrain` and the USGS catalog as a region density volume.
