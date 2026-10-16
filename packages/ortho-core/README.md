# @ortho-earth/core

The rendering core of [ortho-earth](https://www.ortho-earth.com/): vector tiles, terrain, rasters and
labels drawn **on a sphere** (orthographic/perspective are one continuum — a slider, not a wall), with a
WebGPU backend and a WebGL2 fallback.

This is the low-level layer. If you want a map you can put on a page, use
**[@ortho-earth/globe](https://www.npmjs.com/package/@ortho-earth/globe)** — it hosts this core.

```
npm i @ortho-earth/core
```

## What is inside

| Entry | What it gives |
|---|---|
| `@ortho-earth/core` | tile decode/build, draw lists, camera, flight, labels, GeoJSON overlays, buildings, gint layers |
| `./gpu` · `./gl` | the two backends (WebGPU / WebGL2) |
| `./camera` · `./viewurl` | `cameraState`/`project`/`unproject`, the `#z/lat/lon` hash grammar |
| `./terrain` · `./raster` · `./raster-src` | elevation atlases, XYZ/WMS/WMTS/PMTiles raster layers |
| `./decode` · `./tileformat` · `./geodesic` · `./geojson` | MVT decode and the tile-format registry (MLT via [`@ortho-earth/tile-formats`](../tile-formats)), Vincenty distance/area, GeoJSON → overlay |
| `./worldstyle` · `./worldpal` | the map-face palettes (`mono` / `dark` / `topo` / `sepia`) |
| `./workers/*` | worker entries (tile, scene, gint bake, elevation) |
| `./worker-msg` | types only: the messages between the workers and their host (`ScenePortMessage`, `GintBakeResponse`, `MergedScene` …); empty at run time |

Only the entries in `package.json` `exports` are public (the table lists the main ones). There is no `./internal/*` in 2.0
(the door to the source tree that the monorepo's tests used during the TypeScript port is closed): import from a public entry.

Types: in 2.0 the sources are TypeScript (`strict`), so the entries are typed from their sources (1.15 shipped hand-written
`types/*.d.ts`). `node tests/types.mjs` compiles a TypeScript fixture against the entries and checks, for every entry in
`exports`, that the names its types declare are exactly the names the runtime module exports; it is part of `npm test`.

The core **knows no region**. Country-specific knowledge (basemaps, elevation, buildings, search) is a
declaration passed in from outside — see `@ortho-earth/globe` and its region packs.

## Upgrading from 1.x

2.0 removes the standalone gint worker (`./workers/gint`; gint layers are drawn inside the render worker), root re-exports
nobody imported (`flyPlan`, `glidePlan`, `glidePathPlan`, `isPMTiles`, `createTileManager`, `mergeTiles`, `decodeQuantizedMesh`, …;
`ORIGIN_KEY` stays in `./expr`, `wmtsTemplate` in `./raster-src`) and the 1.15 type name `DtmSpec` (now `DtmDecl`). The full
old → new list is in [MIGRATION.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/MIGRATION.md) (Japanese).
When 2.0 is published, 1.x is planned to stay installable under the `v1` dist-tag (`npm i @ortho-earth/core@v1`).

## License

GPL-3.0-or-later ([LICENSE](LICENSE)). A commercial license — without GPL obligations such as disclosing
your site's source — is available: contact kenji.yoshida.home.2026@gmail.com.
