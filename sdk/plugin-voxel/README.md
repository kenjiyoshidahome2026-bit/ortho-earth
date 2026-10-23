# @ortho-earth/plugin-voxel

Voxel grids for [`@ortho-earth/globe`](../../packages/globe). The plugin fills the reserved `map.addData` kind `"voxel"`. The globe already checks the contract (`VoxelData` in `src/voxel.ts`); this package draws it.

- **Drawing** is a same-frame overlay with the globe's camera: the grid's bounding box is rasterised and the fragment shader **marches a ray through the cells**. `render: "blocks"` stops at the first solid cell (DDA, one step per cell) and shades it by its face, like a block world. `render: "volume"` takes fixed steps, samples the grid trilinearly and composites the colormap's colour and alpha front to back, like a weather or density field. Both come from the **same `VoxelData`**; only the option differs.
- Grids are **hidden by terrain and buildings** through the scene depth: the ray stops where the scene is.
- They are **picked** by the unified picking: `handle.pick(x, y)`, `map.on("click", id, …)` and `queryRenderedFeatures({ layers: [id] })`. A hit carries the cell `index`, its `[i, j, k]` `cell`, the cell's `value` (scalar grids, via `handle.pick`) and your `properties`.
- **Preparation** runs in a worker (`voxel-reader.ts`): values are quantised to 8 bits (`R8`, or `RGBA8` for `components: 4`), the colormap is baked and the box is placed; the main thread only forwards the buffers.
- Stage 1 draws with **WebGL2** (every device, including Android where the globe itself is WebGL2). WebGPU, `region` grids (longitude × latitude × height), iso surfaces and clipping planes are stage 2; 3D Tiles `EXT_primitive_voxels` stage 4; bricks, level of detail and file readers (NetCDF, Zarr) stage 5. See [PLAN.md](./PLAN.md).

```js
import { createGlobe } from "@ortho-earth/globe";
import { voxelPlugin } from "@ortho-earth/plugin-voxel";

const map = await createGlobe({ target: "#map", plugins: [voxelPlugin()] });   // or map.use(voxelPlugin())
map.supports("data.voxel");                                                    // true ("plugin", via "plugin-voxel")

// a 64 × 64 × 32 density field, 2 km × 2 km × 1 km, its origin corner at Tokyo station
const field = map.addData({
	dims: [64, 64, 32],
	box: { origin: [139.7671, 35.6812, 0], size: [2000, 2000, 1000] },
	values: new Float32Array(64 * 64 * 32),   // x fastest: values[i + 64 * (j + 64 * k)]
	noData: 0,
}, { kind: "voxel", id: "field", render: "volume", colormap: "turbo", opacity: 0.3 });

// the same grid as opaque blocks, cells below 0.5 empty
const blocks = map.addData(sameData, { kind: "voxel", id: "blocks", render: "blocks", threshold: 0.5, colormap: ["#3a6", "#fd4"] });

await field.ready;
map.on("click", "field", e => console.log(e.features[0].properties.cell));
field.setProps({ opacity: 0.6 });
blocks.remove();
```

## VoxelData

| field | meaning |
|---|---|
| `dims` | `[nx, ny, nz]` cells; `values[i + nx * (j + ny * k)]` |
| `box` | `{ origin: [lng, lat, alt], size: [m, m, m], orientation?: [heading, pitch, roll] }` — the grid's x, y, z axes point east, north, up from the origin corner (heading rotates them clockwise from north); or `{ transform }`, a column-major 4×4 that takes the **unit cube `[0, 1]³`** to ECEF meters (the column lengths are the edges; the way a 3D Tiles tile transform × a glTF node matrix places a voxel primitive). A transform box is placed at its absolute height |
| `region` | `[west, south, east, north, h0, h1]` degrees and meters — accepted by the contract, drawn in stage 2 |
| `values` | `Float32Array`, `Uint16Array` or `Uint8Array`, `nx·ny·nz·components` long |
| `components` | `1` (scalar, coloured by the colormap; default) or `4` (RGBA, drawn as is; alpha 0 = empty) |
| `noData` | cells with this value are empty |
| `range` | values mapped to the colormap's 0..1 (default the data's min / max) |

## Options

| option | meaning |
|---|---|
| `id` | layer id for picking and `map.on` |
| `render` | `"volume"` (default) or `"blocks"` |
| `colormap` | a name (`viridis` `magma` `inferno` `plasma` `turbo` `grey` `heat` `cool` `blues` `reds`), a list of colours spread evenly, or `[t, colour]` stops. Colours `"#rrggbb"`, `"#rrggbbaa"` or `[r, g, b, a?]` |
| `range` | overrides the data's `range` |
| `threshold` | cells below this value (data units) are empty — the usual way to turn a density field into blocks |
| `alphaRamp` | volume: alpha over the colormap's 0..1 when the colours carry none (default `[0, 1]`) |
| `step` | volume: distance between samples in cells (default 0.5; smaller is finer and slower) |
| `opacity` | multiplies every cell's opacity (default 1) |
| `altitude` | `"relative"` (the origin's alt is above the ground, default) or `"absolute"` (above the ellipsoid; default for transform boxes) |
| `depthTest` | hidden by terrain and buildings (default true) |
| `above` | draw above the labels (default false) |
| `properties` | merged into every pick hit's `properties` |

## Handle

`id`, `kind`, `dims`, `n` (cells), `anchor`, `range`, `backend` (`"webgl2"`, null until the overlay has loaded), `reader` (`"worker"` | `"main"`), `error` (the renderer refused the layer, e.g. a grid beyond `MAX_3D_TEXTURE_SIZE`), `ready`, `setData(data)`, `setProps(opts)`, `setVisible(on)`, `pick(x, y, r?)`, `remove()`.

## Notes

- Scalar values are quantised to 8 bits for the GPU (`range` → 1..255, 0 = empty). The colormap resolves 256 steps; `handle.pick` reports the original value from the data kept on the main thread.
- One grid axis may not exceed `MAX_3D_TEXTURE_SIZE` (at least 256 in WebGL2). Larger grids are refused with `handle.error` until stage 5 (bricks).
- All grids of one map share one overlay canvas (the render worker's WebGL contexts are limited); the overlay goes away with the last handle.
- Picking marches the rays of the few pixels under the cursor only (scissor), so it stays cheap even on software GL.
