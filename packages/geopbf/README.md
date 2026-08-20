# geopbf

**Carry geometry as geometry.** GeoPBF is a compact binary container for geospatial features that keeps shapes as shapes — instead of flattening them into draw-only tiles — plus **Gint**, a GPU-readable topology layer that makes the data *answerable*: instant point-in-polygon identify, shared-edge topology, choropleth painting by feature id.

Everything runs in the browser: format conversion in workers, topology baking in WASM, no servers, no API keys. This is the data layer under [ortho-earth](https://www.ortho-earth.com/) — 1,900+ Japanese municipal polygons identify in 0.5–4 ms on an ordinary laptop.

```js
import { createGeopbf } from "geopbf";
const geopbf = createGeopbf();

// From anything: GeoJSON object, File (drag & drop), or URL
const pbf = await geopbf(featureCollection, { gint: true });
const pbf2 = await geopbf(file);        // .geojson .zip(shp) .kml .kmz .gpx .gml .fgb .topojson (.gz OK)
const pbf3 = await geopbf("https://example.com/data.zip#layer.shp");

pbf.geojson         // → FeatureCollection (round-trip)
pbf.features        // → features array
pbf.arrayBuffer     // → the GeoPBF binary (store it, ship it, re-load it)
pbf.contain(lng, lat)   // → which feature contains this point (smallest-wins)
```

## What's inside

- **Converters** (worker-per-format, lazy): GeoJSON, Shapefile (zip), KML/KMZ, GPX, GML, FlatGeobuf, TopoJSON, MOJ 登記所備付地図 — in, and back out (`geojsonFile`, `kmzFile`, `gpxFile`, `gmlFile`, `fgbFile`, `shapeFile`, `topojsonFile`)
- **Gint** (`{ gint: true }`): a typed-array buffer of arcs, features and neighbor topology, baked in WASM, designed so a GPU vertex shader can read it directly — but equally useful in plain JS for identify/topology queries
- **Feature ops**: `centroid`, `area`, `lineLength`, `getBbox`, `classify`, `map`/`filter` clones, CSV/property tables
- **Attribution fields**: `description`, `license`, `attribution` travel inside the file — data provenance is part of the format

## Storage / caching (optional injection)

Out of the box, `createGeopbf()` fetches plainly and re-converts on every load — correct, dependency-free, cache-less. If you have your own storage layer (IndexedDB cache, remote bucket, proxied fetch), inject it:

```js
createGeopbf(apiBase, { bucket: myProvider });
// myProvider(apiBase, options) → { Bucket, Cache, Fetch }
```

Everything else (conversion, gint, identify) is identical either way.

## Bundler notes

Workers are declared as `new Worker(new URL("./…", import.meta.url), { type: "module" })` and the WASM ships as a regular asset — Vite and other modern bundlers handle both natively, no plugins. One setting is required in the consumer's Vite config (the workers use dynamic imports internally, which Vite's default `iife` worker format rejects):

```js
// vite.config.js
export default { worker: { format: "es" } };
```

Runtime dependencies: `pbf` (protobuf reader) and `pako` (raw-deflate for one decoder). Requires a browser with `CompressionStream` (all evergreen browsers).

## License

MIT. The format is meant to spread — build on it freely. Format spec and technical notes: [ortho-earth.com/docs/geopbf.html](https://www.ortho-earth.com/docs/geopbf.html)
