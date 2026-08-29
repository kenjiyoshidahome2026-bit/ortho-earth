# geopbf

[![npm](https://img.shields.io/npm/v/geopbf)](https://www.npmjs.com/package/geopbf) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

> **Repo layout note** — development happens in the [ortho-earth monorepo](https://github.com/kenjiyoshidahome2026-bit/ortho-earth) (`packages/geopbf`); this standalone repo is a read-only mirror synced on each release. Issues are welcome here; patches land in the monorepo. / 開発はモノレポ側で行い、ここはリリースごとに同期される公開ミラーです（Issue歓迎・変更はモノレポへ）。

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

## MapLibre GL JS integration

`geopbf/maplibre` supplies GeoPBF files to MapLibre as GeoJSON sources — no maplibre-gl import on our side, no extra dependency. (This is data supply only; it is not a MapLibre-compatible rendering layer for the gint engine.)

```js
import maplibregl from "maplibre-gl";
import { geopbfProtocol } from "geopbf/maplibre";

maplibregl.addProtocol("geopbf", geopbfProtocol);
map.addSource("rail", { type: "geojson",
  data: "geopbf://https://api.ortho-earth.com/bucket/GIS/pbf/N02-25_RailroadSection" });
```

- **URL contract**: pass the inner URL **absolute** (`geopbf://https://…`), as with pmtiles. MapLibre normalizes source URLs through `new URL()`, which corrupts relative forms like `geopbf://../x`; the handler repairs the one mangling absolute URLs suffer (`https//` losing its colon), but relative paths cannot be recovered — absolutize them first.
- **Whole-file gzip** is detected by magic bytes and decompressed transparently.
- **Properties are sanitized** to survive MapLibre's JSON round-trip to its worker: `Date` → ISO string, BBOX → plain array, FUNC → source string (decoded with `noeval`, so no `new Function` — CSP-safe), Blob/ImageData values are dropped. Pass `makeGeopbfProtocol({ sanitize: false })` to opt out.
- **Metadata** (name / description / license / attribution / minZoom / maxZoom travel inside the file, but a protocol handler cannot set source attribution or layer zoom range) — use `loadGeopbf(url)` to get `{ geojson, ...meta }` and wire them into `addSource`/`addLayer` yourself, or `makeGeopbfProtocol({ onMeta })`. For feature-state, set `promoteId` on the source (GeoPBF features carry no `id`).
- Since a GeoPBF file is one whole dataset (not z/x/y tiles), MapLibre's built-in geojson-vt does the tiling/simplification. Comfortable up to tens of MB of resulting GeoJSON; a true MVT transcoding path for very large datasets is a possible future addition.

See `examples/maplibre.html` for a full standalone demo (base map + protocol source + `loadGeopbf` metadata wiring).

## Leaflet integration

`geopbf/leaflet` provides an `L.GeoJSON` subclass — again without importing leaflet itself. Register it explicitly (works with ESM and the CDN global `L` alike):

```js
import L from "leaflet";                        // or the CDN global
import { extendLeaflet } from "geopbf/leaflet";

extendLeaflet(L);
L.geoPBF("geopbf://https://api.ortho-earth.com/bucket/GIS/pbf/N02-25_RailroadSection", {
  style: { color: "#3564c0" },                  // plus any L.GeoJSON option
})
  .on("load", e => console.log(e.meta))         // "error" on failure
  .addTo(map);
```

Unlike MapLibre's protocol handler, a Leaflet layer owns its attribution — the file header's `attribution` is wired into the layer automatically (an explicit `options.attribution` wins). `getMeta()` returns the header metadata after load, and `await layer.whenReady()` awaits it. Loading/sanitizing behavior (gzip, `noeval`, property mapping, `{ fetch, sanitize, signal }` options) is shared with the MapLibre path. See `examples/leaflet.html`.

## OpenLayers integration

`geopbf/openlayers` provides a `VectorSource` loader factory — no `ol` import on our side; pass your format instance:

```js
import VectorSource from "ol/source/Vector.js";
import GeoJSON from "ol/format/GeoJSON.js";
import { makeGeopbfLoader } from "geopbf/openlayers";

const source = new VectorSource({
  loader: makeGeopbfLoader("geopbf://https://…/N02-25_RailroadSection", new GeoJSON(), {
    onMeta: meta => console.log(meta),   // header metadata; onError for failures
  }),
});
```

Features are reprojected to the view projection automatically (`featureProjection`), and the file header's `attribution` is wired into the source (an explicit `attributions` option wins). Loader options `{ fetch, sanitize, signal }` as elsewhere. See `examples/openlayers.html`.

## deck.gl / loaders.gl integration

`geopbf/loaders` exports a loaders.gl `Loader` object, which plugs into deck.gl (and other loaders.gl consumers) directly:

```js
import { GeoJsonLayer } from "@deck.gl/layers";
import { GeoPBFLoader } from "geopbf/loaders";

new GeoJsonLayer({ data: "https://…/N02-25_RailroadSection", loaders: [GeoPBFLoader] });
```

`parse` returns a GeoJSON FeatureCollection with the header metadata attached as `geopbfMeta`; pass `loadOptions: { geopbf: { sanitize: false } }` to opt out of property sanitizing. See `examples/deckgl.html`.

## Cesium, D3, and everything else (`geopbf/load`)

Libraries that accept a GeoJSON object directly need no plugin at all — `geopbf/load` exposes the shared loader the four integrations above are built on:

```js
import { loadGeopbf } from "geopbf/load";

// Cesium
const r = await loadGeopbf("geopbf://https://…/N02-25_RailroadSection");
viewer.dataSources.add(await Cesium.GeoJsonDataSource.load(r.geojson));
if (r.attribution) viewer.creditDisplay.addStaticCredit(new Cesium.Credit(r.attribution));
```

Same deal for D3 (`d3.geoPath` over `r.geojson`), Observable notebooks, or anything else that eats GeoJSON. `loadGeopbf` returns `{ geojson, name, description, license, attribution, minZoom, maxZoom }` and handles gzip, `noeval`, and property sanitizing. See `examples/cesium.html`.

## Editing (`geopbf/edit`, v1.3)

The editing core battle-tested in [geoedit](https://www.ortho-earth.com/geoedit/) — pure data modules (no DOM, worker-safe, Node-testable):

```js
import { buildTopology, createModel } from "geopbf/edit";

const topo = buildTopology(featureCollection, 6);   // grid 10^-6 deg; shared borders become single arcs
const model = createModel(topo);
const addr = model.addrOf(eid, pathIdx, vertIdx);   // stable address {eid, path, vi}
const { arcId, idx } = model.resolveAddr(addr);
model.moveVertex(arcId, idx, lng, lat);             // one arc, N features: neighbors move together
model.toGeoJSON();                                  // → FeatureCollection (round-trip)
model.stats();                                      // → { features, arcs, vertices }
```

- **`buildTopology(fc, gridExp)`** — extract shared-edge topology; a border edit moves both features at once.
- **`createModel(topo)`** — vertex move/insert/delete, feature add/delete, holes, translate; command objects (`applyCmd`/`invertCmd`) with re-extraction-stable addresses make undo/redo survive topology rebuilds.
- **`createLargeModel(pbf)`** — edit tens of millions of vertices in place on the GeoPBF bytes + Gint buffer (no full extraction, no OOM).
- **`createSnapIndex(gridExp, deref)`** — grid-linked snapping. **`createHistory()`** — undo/redo stack.
- **`smoothRing / smoothGeom`** — Catmull-Rom subdivision used by both the editor and `@spline` playback (same curve everywhere).

Granular imports: `geopbf/edit/model`, `geopbf/edit/large-model`, `geopbf/edit/topo-extract`, `geopbf/edit/snap`, `geopbf/edit/history`, `geopbf/edit/spline`.

## Bundler notes

Workers are declared as `new Worker(new URL("./…", import.meta.url), { type: "module" })` and the WASM ships as a regular asset — Vite and other modern bundlers handle both natively, no plugins. One setting is required in the consumer's Vite config (the workers use dynamic imports internally, which Vite's default `iife` worker format rejects):

```js
// vite.config.js
export default { worker: { format: "es" } };
```

Runtime dependencies: `pbf` (protobuf reader) and `pako` (raw-deflate for one decoder). Requires a browser with `CompressionStream` (all evergreen browsers).

## License

MIT. The format is meant to spread — build on it freely. Format spec and technical notes: [ortho-earth.com/docs/geopbf.html](https://www.ortho-earth.com/docs/geopbf.html)
