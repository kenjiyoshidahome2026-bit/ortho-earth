# @ortho-earth/globe

A 3D globe for the browser: real terrain at true scale, vector basemaps (MVT, and MLT with `@ortho-earth/tile-formats`), 3D buildings, 3D Tiles / I3S,
rasters (XYZ · WMS · WMTS · PMTiles), labels, and a MapLibre-shaped API — with **no map server of your
own**. It reads public data directly and keeps what it decoded in the browser.

**Try it:** [www.ortho-earth.com](https://www.ortho-earth.com/) · [all 139 MapLibre examples running on the globe](https://www.ortho-earth.com/maplibre/)

```
npm i @ortho-earth/globe
```

```js
import { createGlobe } from "@ortho-earth/globe";

const map = await createGlobe({ target: "#map", view: "#3/20/140" });
map.flyTo({ center: [139.767, 35.681], zoom: 14, pitch: 60 });
```

## Always a globe

This map has no flat Mercator mode. Orthographic and perspective are one continuum on the sphere, so MapLibre's
`projection` is read as "globe" whatever it says, `renderWorldCopies` has nothing to copy, and the same scene carries
from the whole Earth to street level. The MapLibre face (`@ortho-earth/globe/maplibre`) is graded against MapLibre's own
139 examples: 66 same picture · 50 same answer · 21 run · 0 fail to run (`npm run verify:examples`; ledger in
[`maplibre-compat.md`](maplibre-compat.md)).

## Guides

- [MapLibre GL JS code on a 3D globe](https://www.ortho-earth.com/docs/from-maplibre) — change one import
- [Coming from CesiumJS](https://www.ortho-earth.com/docs/from-cesium) — 3D Tiles, quantized-mesh, glTF, the ellipsoid, CZML and the clock, side by side
- [Equal Earth on the GPU](https://www.ortho-earth.com/docs/equal-earth) — the flat world map of this project

## Plugins

Every extension has one shape: `definePlugin({ name, install(map, opts) })`, installed with `map.use(plugin)` or
`createGlobe({ plugins: [...] })`. Plugins register into `map.registry` (data kinds, gadgets, tile formats, light types,
clouds, post-process passes, handlers) and `map.supports(key)` / `map.capabilities()` answer honestly what this map
renders, what a plugin renders, and what is only accepted as a spec. Handbook: [`PLUGINS.md`](PLUGINS.md).

## What you get

- **Camera**: `jumpTo` / `easeTo` / `flyTo` / `fitBounds` / `cameraForBounds` / padding / `setMaxBounds`
- **Layers**: external MapLibre `style.json` (`setStyle`), `setPaintProperty` / `setLayoutProperty` /
  `setFilter` / `moveLayer` / per-layer events, `queryRenderedFeatures`-equivalent
- **Vectors**: Gint layers (`map.addGint`: topology, GPU picking, draping) and, for big GeoPBF / GeoParquet
  files you only look at, column chunks (`map.addColumnar`: no topology pass, first frame after read + pack)
- **3D**: extrusions, glTF/GLB models (`map.model`: several at once, move / turn / scale / lift after loading, drag handles), any 3D Tiles tileset (`map.add3DTiles`), I3S (`map.addI3S`)
- **Terrain**: built-in elevation, or your own `raster-dem` source (`map.setTerrain`)
- **Analysis**: sun shadow / shadow-hours, viewshed, line of sight, profiles, measurement
- **DOM**: `new Marker().setLngLat([lon, lat]).addTo(map)`, `Popup`, `addProtocol`, `transformRequest`
- **Overlays**: `map.overlay(url)` draws in the render worker's frame (same camera, scene depth on request); overlays that export
  `pick(x, y, r, ctx)` answer `map.pickOverlays(x, y)`, `map.on("click" | "mousemove", overlayName, cb)` and
  `queryRenderedFeatures({ layers: [overlayName] })` like any layer (GPU id pass for points, geometry for canvas overlays)
- **three.js**: `map.addThree({ module: <URL of your module exporting setup(THREE, scene, h)> })` runs three.js inside the render
  worker on the same camera: meters in an east-north-up frame around `origin` (RTE), occluded by terrain and buildings through the
  scene depth, pickable with the overlay picking above. Your module may `import * as THREE from "three"` and
  `import { GLTFLoader } from "three/addons/…"` (resolved inside the worker). three.js is not a dependency: `three` defaults to
  jsDelivr's `three@0.186.1`, or pass your own URL (r180 or later for depth). `renderer: "webgpu"` uses three's `WebGPURenderer`
  and, when the map runs on WebGPU, shares its `GPUDevice` and depth texture (no per-frame copy). Guide, limits and MapLibre
  porting: [THREE.md](./THREE.md)
- **Custom layers in the worker**: `map.addLayer({ id, type: "custom", renderingMode: "3d", url: <URL of a module exporting createLayer(params)> , params })`
  runs a MapLibre-style `CustomLayerInterface` (`onAdd(map, gl)` / `render(gl, args)` with `args.defaultProjectionData.mainMatrix`, prelude and
  `getProjectionData`) inside the render worker on the same camera; the scene depth is written into the layer's depth buffer first, so a "3d" layer is
  occluded by terrain and buildings without touching its shaders (`depth: false` to opt out). Add `three: <URL of three.module.js>` to let the module
  import `"three"` and its addons by bare name. `map.getCustomLayerHandle(id)` posts messages to the layer's `onMessage`. Passing a layer object (no `url`) keeps the main-thread canvas route (always on top, no depth).
- **deck.gl**: `MapboxOverlay` (overlaid) from `@deck.gl/mapbox` works on the MapLibre-shaped `Map` (`@ortho-earth/globe/maplibre`) through the usual
  `map.addControl(overlay)`: the camera follows the `render` event, picking and `onClick` go through the container's mouse and drag events.
  `interleaved: true` falls back to overlaid (the map is drawn in a worker, so deck.gl cannot share its GL context). deck.gl is not a dependency; it is
  a devDependency for `tests/t-deckgl.html` only.
- **Post-processing**: `map.setPostProcess({ bloom: { threshold: 0.75, strength: 0.5, radius: 1 }, vignette: { strength: 0.5, radius: 0.8, softness: 0.5 } })`
  (or `bloom: true` / `vignette: true` for the defaults, `null` to turn it off; `postProcess` in `createGlobe` options) applies a bloom (bright pass at
  half resolution, separable Gaussian blur, additive composite) and a vignette to the base scene. Labels and same-frame overlays are separate canvases and
  are not affected. WebGL2 runs it in the FBO copy stage shared with the scene-depth hand-off; WebGPU runs it at the end of `flush()`. `map.getPostProcess()`
  returns the normalized settings.
- **Data layers**: `map.addData(array, { kind, getPosition, getColor, getRadius, … })` takes an array (or GeoJSON) plus deck.gl-style
  accessors. `kind: "points"` and `"arcs"` (great circles with optional height, `getSourcePosition` / `getTargetPosition`) are GPU
  overlays with picking; `"polygons"`, `"paths"` and `"columns"` ride the ordinary `fill` / `line` / `fill-extrusion` layer route.
  `h.setData(array)` re-bakes everything, like deck.gl. `kind: "trips"` draws timestamped paths up to `currentTime` with a fading
  `trailLength` (`h.setCurrentTime`, `h.animate`, `h.useClock`). Points, arcs and trips take `getFilterValue` + `h.setFilter([lo, hi])`
  (GPU range filter), `h.brush(true, radius)` (pointer brushing) and `h.setMask(polygon)`; points animate `setData` with `transition: { duration }`
- **Cells, contours, screen grid**: `map.addCells(points | ids, { kind: "grid" | "mesh" | "geohash" | "quadkey" | "s2", res, weight })`
  bins points into (or draws given) cells as `fill` / `fill-extrusion` layers, pure JS with no dependency (S2 ids match the
  reference library). `map.addContour(points, { cellSize, thresholds | bands })` draws isolines / isobands, and
  `map.addScreenGrid(points, { cellPx })` is a screen-fixed grid overlay. `map.addAggregate(src, { kind })` dispatches to these and H3
- **H3**: `map.addH3(points | cells, { res, weight, paint, extrude })` bins points into H3 cells (or draws given cell ids) as a
  `fill` / `fill-extrusion` layer (`@ortho-earth/h3`, loaded on demand)
- **Regions**: pass `opts.region` to add a country pack (basemap, elevation, buildings, search…).
  Without it you get the world: Natural Earth 10m, global hypsometry, lakes, rivers, maritime
  boundaries, stars — honest up to about z8, which is what world data can carry.

## Upgrading from 1.x

2.0 is a major release. The ones most likely to touch your code:

- **Imports**: 1.x opened every file under `src/` (`"./*"`); 2.0 exports only named subpaths (`page.js`, `i18n.js`, `worker.js`,
  `maplibre`, …; see `exports` in `package.json`), and `internal/*` is not public.
- **Gadgets you write**: `map.registry.gadgets.add(name, (map, ...args) => handle)`. The 1.x `map.gadget(name, function () { this … })`
  is gone; `map.gadget` is only the table of callers (`map.gadget.<name>(…)`).
- **Aliases removed**: `plateau` → `mesh` (option, `map.on("mesh")`, type `MeshEvent`), `maxPitch` / `setMaxPitch` always in degrees,
  `chips` takes `true` / `false` only, romaji keys in `opts.layers` (old shared URLs keep working), `addCOPC` / `removeCOPC` →
  `addPointCloud` / `removePointCloud`. `OrthoJapanMap` stays as an alias of `GlobeMap`.

Every change, old → new, per package: [MIGRATION.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/MIGRATION.md)
(Japanese). 1.x stays installable by version range: `npm i @ortho-earth/globe@1` (the last 1.x is 1.16.0).

## Verification

The gates live with the code: `npm run verify:ui` (18 pages), `npm run verify:webgpu` (10 pages, real GPU; a page that
boots on WebGL2 or skips for lack of WebGPU fails),
`npm run verify:nocoi` (the no-`crossOriginIsolated` world), and `npm run verify:net` (3 pages that depend on outside servers — NASA GIBS and ArcGIS — kept out of the standing gates). They boot pages through this package's own
public face, so what is tested is what you install.

## License

GPL-3.0-or-later ([LICENSE](LICENSE)). A commercial license — without GPL obligations such as disclosing
your site's source — is available: contact kenji.yoshida.home.2026@gmail.com.
