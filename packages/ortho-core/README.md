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
| `./decode` · `./geodesic` · `./geojson` | MVT decode, Vincenty distance/area, GeoJSON → overlay |
| `./worldstyle` · `./worldpal` | the map-face palettes (`mono` / `dark` / `topo` / `sepia`) |
| `./workers/*` | worker entries (tile, scene, gint, gint bake) |

The core **knows no region**. Country-specific knowledge (basemaps, elevation, buildings, search) is a
declaration passed in from outside — see `@ortho-earth/globe` and its region packs.

## License

GPL-3.0-or-later ([LICENSE](LICENSE)). A commercial license — without GPL obligations such as disclosing
your site's source — is available: contact kenji.yoshida.home.2026@gmail.com.
