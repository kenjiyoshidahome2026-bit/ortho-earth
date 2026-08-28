# GeoPBF API Reference (v1.1)

`GeoPBF` is a high-performance GIS library for the browser, providing efficient binary storage, spatial analysis, and topological processing.

## Table of Contents
1. [Constructor](#1-constructor)
2. [Data Loading & Output](#2-data-loading--output)
3. [Metadata & Configuration](#3-metadata--configuration)
4. [Geometric Analysis](#4-geometric-analysis)
5. [Data Manipulation](#5-data-manipulation)
6. [Topology & Advanced GIS](#6-topology--advanced-gis)
7. [Static Methods](#7-static-methods)
8. [MapLibre Integration](#8-maplibre-integration-geopbfmaplibre)
9. [Leaflet Integration](#9-leaflet-integration-geopbfleaflet)
10. [OpenLayers Integration](#10-openlayers-integration-geopbfopenlayers)
11. [loaders.gl Integration](#11-loadersgl-integration-geopbfloaders)

---

## 1. Constructor

### `new PBF(options)`
Creates a new GeoPBF instance.
* **`options.name`** (String): Dataset name.
* **`options.precision`** (Number): Coordinate precision ($10^n$). Default is `6` ($10^{-6}$ degrees).
* **`options.noprop`** (Boolean): If true, skips property encoding to save space.
* **`options.noeval`** (Boolean): If true, FUNC-typed property values are returned as their source string instead of being revived with `new Function` (for CSP environments without `unsafe-eval`). Default `false`.

---

## 2. Data Loading & Output

### `await pbf.set(data)`
Loads data into the instance. Supports GeoJSON objects, ArrayBuffers, or TypedArrays.

### `pbf.geojson` (Getter)
Returns the entire dataset as a GeoJSON `FeatureCollection`.

### `pbf.arrayBuffer` (Getter)
Returns the serialized binary data as an `ArrayBuffer`.

---

## 3. Metadata & Configuration

### `pbf.name([value])` / `pbf.description([value])` / `pbf.license([value])`
Gets or sets metadata strings.

### `pbf.precision([value])`
Gets or sets the coordinate precision ($10^n$).

---

## 4. Geometric Analysis

### `pbf.centroid(index)`
Returns the `[lng, lat]` centroid of the feature at the specified index.

### `pbf.area(index)`
Returns the area (in square meters) of the polygon at the specified index.

### `pbf.contain([lng, lat], [getOneFlag])`
Checks which polygons contain the given point. Returns an array of indices or a single index if `getOneFlag` is true.

### `await pbf.nearPoint([lng, lat], maxResults, maxDistance)`
Performs a fast spatial search using an internal KDBush index. Returns the nearest feature indices.

---

## 5. Data Manipulation

### `await pbf.dissolve(propertyName)`
Merges adjacent polygons that share the same value for the specified property.

### `await pbf.filter(filterFunc)`
Returns a new PBF instance containing only features that satisfy the `filterFunc`.

### `await pbf.map(mapFunc)`
Returns a new PBF instance with properties modified by the `mapFunc`.

### `await pbf.classify(keyOrFunc)`
Splits the dataset into multiple PBF instances based on a property key or a custom classification function.

---

## 6. Topology & Advanced GIS

### `pbf.analyzeTopology()`
Analyzes the dataset to build shared boundaries (Arcs). This is required for `topojson`, `mesh`, and `merge`.

### `pbf.topojson` (Getter)
Returns the dataset in **TopoJSON** format.

### `pbf.neighbors([index])`
Returns an array of indices representing features that share boundaries with the specified feature.

### `pbf.mesh(filterFunc)`
Extracts shared boundaries (edges) between polygons that satisfy the filter criteria.

### `pbf.merge(filterFunc)`
Combines multiple polygons into a single geometry by removing shared internal boundaries.

---

## 7. Static Methods

### `await PBF.update(buffer, meta)`
Updates the header metadata (name, description, license, etc.) of an existing GeoPBF binary without re-encoding the entire body.

### `await PBF.concatinate(pbfArray, [name])`
Combines multiple PBF instances into a single instance.

---

## 8. MapLibre Integration (`geopbf/maplibre`)

Supplies GeoPBF files to MapLibre GL JS as GeoJSON sources. This module does not import maplibre-gl; protocol registration is the consumer's job. Inner URLs should be absolute (`geopbf://https://…`, pmtiles-style) — MapLibre's URL normalization corrupts relative forms.

### `geopbfProtocol(params, abortController)`
Ready-made handler for `maplibregl.addProtocol("geopbf", geopbfProtocol)` (MapLibre v4+ promise-style `AddProtocolAction`). Fetches the inner URL, transparently gunzips whole-file gzip, decodes with `noeval`, sanitizes properties, and resolves `{ data: FeatureCollection }`.

### `makeGeopbfProtocol(options)`
Builds a customized handler.
* **`options.fetch`** (Function `(url, { signal }) → Promise<Response>`): custom fetch (caching, auth, proxying). Default: plain `fetch` with `cache: "default"`.
* **`options.sanitize`** (Boolean): default `true`. When false, properties pass through undecoded-for-JSON (Date/Blob/ImageData objects survive locally but will not survive MapLibre's worker round-trip).
* **`options.onMeta`** (Function `(innerUrl, meta) → void`): called after each decode with `{ name, description, license, attribution, minZoom, maxZoom }`.

### `await loadGeopbf(url, [options])`
Protocol-free shortest path: returns `{ geojson, name, description, license, attribution, minZoom, maxZoom }` so the consumer can wire `attribution` into `addSource` and `minZoom`/`maxZoom` into `addLayer`. Accepts `geopbf://…` or a bare URL; relative URLs resolve against `location` (browser only). `options`: `{ signal, fetch, sanitize }`.

### `sanitizeProperties(properties)`
The JSON-safe mapping used by the handler, exported for reuse/testing: primitives and COLOR/JSON values pass through, `Date` → ISO string, BBOX (`Float64Array`) → plain array, functions/Blob/ImageData are dropped. Recurses one level (dot-key nested objects).

---

## 9. Leaflet Integration (`geopbf/leaflet`)

An `L.GeoJSON` subclass for Leaflet (1.x). This module does not import leaflet; registration is explicit and idempotent. `loadGeopbf` and `sanitizeProperties` are re-exported here too.

### `extendLeaflet(L)`
Registers `L.GeoPBF` (class) and `L.geoPBF(url, options)` (factory) on the given `L` and returns it. Throws if `L.GeoJSON.extend` is missing.

### `L.geoPBF(url, [options])`
Creates a layer that fetches and decodes the GeoPBF asynchronously (gzip-transparent, `noeval`, sanitized — shared loader with the MapLibre path). `url` accepts `geopbf://…` or a bare URL; relative URLs resolve against `location`.
* **`options`**: any `L.GeoJSON` option (`style`, `pointToLayer`, `onEachFeature`, …) plus loader options `{ fetch, sanitize, signal }`.
* **Attribution**: the file header's `attribution` is applied to the layer automatically; an explicit `options.attribution` takes precedence.
* **Events**: fires `load` (`{ meta, geojson }`) on success, `error` (`{ error }`) on failure.
* **`layer.getMeta()`**: `{ name, description, license, attribution, minZoom, maxZoom }` after load.
* **`await layer.whenReady()`**: resolves with the layer once loading settles (either outcome).

---

## 10. OpenLayers Integration (`geopbf/openlayers`)

A `VectorSource` loader factory for OpenLayers (ol 6+). This module does not import `ol`; the consumer passes a format instance. `loadGeopbf` and `sanitizeProperties` are re-exported here too.

### `makeGeopbfLoader(url, format, [options])`
Returns a loader function for `new VectorSource({ loader })` (or `source.setLoader(...)`). The loader fetches and decodes the GeoPBF (gzip-transparent, `noeval`, sanitized — shared loader), reprojects via `format.readFeatures(geojson, { featureProjection })` using the view projection ol passes in, and adds the features to the source.
* **`format`**: an ol format instance, normally `new GeoJSON()`. Throws if it has no `readFeatures`.
* **`options`**: loader options `{ fetch, sanitize, signal }` plus `onMeta(meta)` and `onError(error)`.
* **Attribution**: the file header's `attribution` is applied via `source.setAttributions()` unless the source already has attributions.
* On failure the loader calls `source.removeLoadedExtent(extent)` and the ol `failure` callback, then `onError`.

---

## 11. loaders.gl Integration (`geopbf/loaders`)

A loaders.gl `Loader` object for deck.gl, kepler.gl and other loaders.gl consumers. This module does not import `@loaders.gl/*`. `loadGeopbf` and `sanitizeProperties` are re-exported here too.

### `GeoPBFLoader`
`{ id: "geopbf", extensions: ["geopbf"], binary: true, worker: false, … , parse(arrayBuffer, options) }`. Use as `parse(buffer, GeoPBFLoader)` / `load(url, GeoPBFLoader)` with `@loaders.gl/core`, or `loaders: [GeoPBFLoader]` on a deck.gl layer.
* **`parse`** resolves to a GeoJSON FeatureCollection (gzip-transparent, `noeval`, sanitized) with the header metadata attached as **`geopbfMeta`** (`{ name, description, license, attribution, minZoom, maxZoom }`).
* **Options**: `{ geopbf: { sanitize: false } }` disables property sanitizing (deck.gl: pass via `loadOptions`).

---

*Document version: August 2026. This specification is based on the implementation in the `geopbf` library.*
