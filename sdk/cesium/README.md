# @ortho-earth/cesium

The CesiumJS API on ortho-earth. `import * as Cesium from "@ortho-earth/cesium"` gives a namespace with the same names as CesiumJS 1.146's, whose `Viewer` and `CesiumWidget` draw with [`@ortho-earth/globe`](../../packages/globe). Code written for Cesium keeps its shape; only the import changes.

```js
import * as Cesium from "@ortho-earth/cesium";

const viewer = new Cesium.Viewer("cesiumContainer");
const entity = viewer.entities.add({
	position: Cesium.Cartesian3.fromDegrees(-123.07, 44.05, 5000),
	model: { uri: "Cesium_Air.glb", minimumPixelSize: 128 },
});
viewer.trackedEntity = entity;
const tileset = await Cesium.Cesium3DTileset.fromUrl("tileset.json");
viewer.scene.primitives.add(tileset);
await viewer.zoomTo(tileset);
```

## How it is built

Everything that does not draw is Cesium's own code, unchanged: math, time, `Camera` (flyTo, setView, lookAt), `Entity` and the properties, the data sources (CZML, GeoJSON, KML), the clock, `Resource` and ion, the terrain and imagery providers, and the widgets (Animation, Timeline, BaseLayerPicker, Geocoder, InfoBox…). They come from `@cesium/core`, `@cesium/engine` and `@cesium/widgets` (Apache-2.0).

The facade replaces only what draws:

| Cesium | On the globe |
|---|---|
| `Scene` | `OrthoScene`: the real `Camera`, `Globe`, `PrimitiveCollection`, `ImageryLayerCollection` and the frame events, with no WebGL. Each frame the Cesium camera is pushed to the globe, and a drag on the globe is pulled back into the camera |
| `scene.pick`, `drillPick`, `pickPosition`, `sampleHeight`, `clampToHeight`, `cartesianToCanvasCoordinates` | the globe's picking and height sampling |
| entities: point, billboard, label, path, model, polyline, polygon, rectangle, ellipse, box, cylinder, ellipsoid, corridor, wall, polylineVolume | the globe's CZML overlay (points, billboards, labels, tracks, 3D lines), GeoJSON fill / line / fill-extrusion layers, and glTF models |
| imagery layers (UrlTemplate, OpenStreetMap, Bing, ArcGIS, WMTS REST, WMS, SingleTile, ion) | raster layers, in the collection's order, with alpha, brightness, contrast, hue and saturation |
| `Cesium3DTileset` (`fromUrl`, `fromIonAssetId`, `style`, `show`), `Cesium3DTileFeature` | the globe's 3D Tiles, picking and feature state. `instanceof` holds against the engine's classes |
| terrain (`createWorldTerrainAsync`, `CesiumTerrainProvider`, `EllipsoidTerrainProvider`) | the globe's terrain |

What the facade does not do yet is reported once in the console as `[csshim] unsupported: …` (never thrown), and `Cesium.unsupportedReport()` counts them. Today that is mostly `scene.primitives.add(…)` of the low-level primitives (`Primitive`, `Model`, the Billboard / Label / Point / Polyline collections, particles, voxels, I3S), 2D and Columbus view, and imagery in a geographic tiling scheme.

`viewer.orthoMap` is the globe underneath, for anything else.

## Tests

- `npm test -w @ortho-earth/cesium`: node only. The camera bridge both ways, glTF bounding spheres, 3D Tiles bounding volumes, imagery providers to raster sources, and the unsupported report.
- The examples gate, in `packages/globe`. It runs each of CesiumJS 1.146's 309 Sandcastle examples on real Cesium and on this facade, then grades them from 0 to 3: 1 runs, 2 gives the same answers (entity, data source, primitive and imagery counts, the camera, nothing unsupported), 3 gives the same picture. Steps:
  1. `node tests/csexamples/corpus.mjs` fetches the pinned examples into `.cache/`.
  2. `npx vite --config tests/csexamples/vite.config.mjs --port 5460` serves both sides.
  3. `CHROME=<chromium> node tests/csexamples/run.mjs` runs and grades them, and writes `summary.md`.
