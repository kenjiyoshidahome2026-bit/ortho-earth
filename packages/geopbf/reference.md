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

## 12. PMTiles / GeoParquet export (`geopbf/pmtiles`, `geopbf/geoparquet`, `geopbf/convert`)

DOM-free modules (Node, workers, browsers). The parallel stages run as WebGPU compute when a device is available and as
integer-identical CPU code otherwise; `stats.engine` tells which ran.

### `await toPMTiles(pbf, [options])` (`geopbf/pmtiles`)
Builds a PMTiles v3 archive of Mapbox Vector Tiles from a GeoPBF and its Gint. Resolves to `{ buffer: Uint8Array, stats, metadata }`.
* **`options.gint`** (ArrayBuffer): the GintBUF. Defaults to `pbf._gintBuffer` (set by `pbf.gint()`); in Node use `bakeGint(pbf)` from `geopbf/convert/node-gint` or the CLI.
* **`minZoom`** (0) / **`maxZoom`** (14): zoom range. `maxZoom ≤ 32 − log2(extent)` (20 for extent 4096).
* **`extent`** (4096, power of two) / **`buffer`** (80, tile units): MVT grid and clip buffer.
* **`layer`**: layer name (default: header `name`).
* **`simplification`** (1, tile units; tippecanoe `-S`): per-arc calibration of the rank threshold to Douglas-Peucker. One DP decomposition per arc gives each vertex the tolerance at which it survives; for every (arc, zoom) the rank threshold is chosen so the rank filter keeps the number of vertices DP would keep at `simplification × 2^(32−z−log2 extent)` world units. Vertex choice stays rank-based (shared borders identical on both sides); only the budget follows DP. `false` uses the fixed rule `63 − 3·(z + log2(extent/256))`. `stats.calibration = { vertices, dpKept[], vwKept[] }`, `stats.ms.calibrate`.
* **`lodBias`** (0): added to the (calibrated or fixed) rank threshold; `+3` = one zoom step = VW area ×4 (≈2× coarser linearly), positive keeps fewer vertices, negative more.
* **`dropRate`** (2.5): point thinning below `maxZoom`, tippecanoe `-r` semantics — a point survives at zoom `z` when `hash(fid)/2^32 < dropRate^-(maxZoom−z)`, so kept sets nest across zooms; `1` keeps every point. Polygons and lines are never dropped by this.
* **`tinyPolygon`** (2, tile units², tippecanoe `-s`): a polygon component whose *full-resolution* area at zoom `z` is below this is not written; its area is added to a per-feature accumulator and each time the accumulator reaches the threshold one square of that area is written in its place, so archipelagos and parcel blocks keep their density at low zooms instead of vanishing (the same goes for components the rank filter collapsed to fewer than 3 vertices). Clipped fragments below the threshold and holes below it are dropped outright. `0` disables all of it. **`tinyLine`** (0): drop a line whose bbox is smaller than this in both directions at that zoom.
* **`include`** / **`exclude`** (arrays of keys) / **`excludeAll`** (tippecanoe `-y` / `-x` / `-X`): attribute selection; a key matches flattened names (`a.b`) and their parent (`a`). `attrFilter(opts)` (`geopbf/convert`) builds the predicate. The same options apply to `toGeoParquet` (columns).
* **`tileCompression`** (`"gzip"` | `"none"`), **`workers`** (default = CPU cores, max 8; `0` = inline; on 4 cores 4 was fastest, 5–7 slightly slower), **`metadata`** (merged into the PMTiles JSON), **`center`**, **`batchVertices`** (32M: read-back batch size), **`onProgress({ zoom, tiles })`**, **`onWarn(err)`** (worker pool unavailable → inline).
* **`gpu`**: `false` → CPU; a `GPU` object → use it; omitted → `navigator.gpu` or, in Node, the optional `webgpu` package.
* `stats`: `{ engine, gpu, workers, vertices, arcs, kept, tiles, contents, bytes, ms: { project_lod, area, tags, pool_init, lod_write, assemble, pmtiles, total } }` (`tags` = building the attribute table, `area` = full-resolution component areas for `tinyPolygon`).
* Semantics: one layer, feature `id` = feature index (fid) as Gint assigns it — Gint folds features whose property rows are identical into the first such feature, so those share one `id` and their parts appear as one multi-part feature (Natural Earth roads: 56,600 features → 53,963 ids, all 56,645 parts present) — polygons follow MVT 2.1 winding (outer positive / holes negative area), shared borders are simplified identically on both sides (one arc), interior full-cover tiles are de-duplicated (content hash + run length). Clipping is Sutherland–Hodgman per half-plane; three consecutive vertices on a clip line collapse to two, so the zero-width spurs SH leaves where a ring leaves and re-enters the tile are removed (shape unchanged).

### `await toGeoParquet(pbf, [options])` (`geopbf/geoparquet`)
Writes GeoParquet 1.1: `geometry` (WKB, little-endian), an optional `bbox` struct column with statistics, and one column per property key (`BOOLEAN` / `INT64` / `DOUBLE` / `TIMESTAMP(ms, UTC)` / `UTF8` / `JSON`, nested keys flattened to `a.b`). Resolves to `{ buffer, stats, geo }`. Every column carries `min`/`max`/`null_count` statistics per row group (strings by unsigned byte order; skipped when a value exceeds 128 bytes; never for `geometry`); a column whose distinct values within a row group are at most half the rows is written with a dictionary page and `RLE_DICTIONARY` indices (never `geometry`, `bbox`, booleans). Rows are transposed into contiguous per-column arrays in the final order before writing.
* **`order`** (`"str"` default | `"hilbert"` | `"morton"` | `"none"`): spatial row ordering by feature-bbox centre so row-group `bbox` statistics are tight (STR packs them disjointly); `"none"` keeps input order (row index = fid). Features without geometry go last. Recorded as key-value `geopbf:order`.
* **`codec`** (`"zstd"` | `"gzip"` | `"none"`; default `"zstd"` where `node:zlib` has it — Node ≥ 22.15 — else `"gzip"`; recorded in `stats.codec`), **`level`** (zstd level, 9), **`pageSize`** (1 MB of values per data page; column chunks are split into pages so readers can stream), **`rowGroupSize`** (65536; also the STR page size), **`bboxColumn`** (`true` default; `"auto"` omits it for point-only data; `false` never), **`geometryName`** (`"geometry"`), **`gpu`**, **`compress`**.
* Coordinates are the GeoPBF integers divided by `10^precision`, converted to doubles exactly (same bits as JavaScript division). Empty geometries become nulls. Header fields travel as `geopbf:name/description/license/attribution` key-values.

### `await fromGeoParquet(u8, [options])` (`geopbf/geoparquet`)
The inverse: a GeoParquet (or any Parquet with a WKB geometry column) → `{ pbf: GeoPBF, stats }`. Reads the `geo` metadata for the primary column, encoding (`WKB` only) and CRS (must be CRS84 / EPSG:4326 unless **`ignoreCrs`**); other columns become properties — leaves of nested groups under their dotted path (`nest.x`, GeoPBF's own convention), the `bbox` covering column dropped, repeated (list/map) columns skipped and listed in `stats.skipped`. **`precision`** defaults to the file's `geopbf:precision` key-value, else 6; **`name`**, **`geometryColumn`**, **`include`** / **`exclude`** / **`excludeAll`** as elsewhere. Supported: DataPage v1/v2, PLAIN, PLAIN_DICTIONARY / RLE_DICTIONARY, codecs none / snappy / gzip / zstd; BOOLEAN, INT32, INT64, FLOAT, DOUBLE, BYTE_ARRAY (UTF8 → string, JSON → parsed, TIMESTAMP/DATE → Date). `readParquet(u8)` (`geopbf/convert`) exposes the plain column reader.
`geopbf parquet2pbf <in.parquet> <out.geopbf> [--precision N] [--name name] [--geometry col] [--ignore-crs] [--no-gzip] [--include a,b] [--exclude a,b] [--exclude-all]`

### Lower-level pieces (`geopbf/convert`)
`getDevice()` / `setGPU(gpu)` / `findGPU()` — device acquisition; `createEngine(device)` / `cpuEngine()` — the kernel contract (`project`, `lodCount`, `lodWrite`, `wkb`, `bbox`); `await writePMTiles(tiles, metadata, opts)` / `await assemblePMTiles(items, contents, metadata, opts)` / `await readPMTiles(u8)` (async `getTile`) / `zxyToTileId` / `tileIdToZxy`; `encodeTile(layer)` (MVT, dependency-free) / `decodeTile(u8)` (test decoder, `geopbf/convert` only); `await writeParquet({ schema, columns, numRows }, opts)` (columns take `values` arrays or `get(row)`, `stats:false`, `dict:false`); `attrFilter(opts)`; `gzip(u8)` / `gunzip(u8)` (zlib in Node, `CompressionStream` elsewhere) / `zstd(u8, level)` / `unzstd(u8)` / `hasZstd()` (Node ≥ 22.15 only).

### CLI
`geopbf pmtiles <in.geopbf> <out.pmtiles> [--minzoom N] [--maxzoom N] [--extent N] [--buffer N] [--layer name] [--gint in.gint] [--simplification N|off] [--lod-bias N] [--tiny-polygon A] [--tiny-line L] [--include a,b] [--exclude a,b] [--exclude-all] [--workers N] [--drop-rate R] [--gpu | --no-gpu]`
`geopbf parquet <in.geopbf> <out.parquet> [--compression gzip|none] [--row-group N] [--order str|hilbert|morton|none] [--no-bbox] [--gpu | --no-gpu]`

### Verification
`npm run test:convert` — CPU references (exact division vs BigInt, table error bound, clipping, MVT, PMTiles directory), end-to-end PMTiles (shared-border identity across zooms, hole winding, de-duplication, CLI) and GeoParquet (WKB round-trip, pyarrow read-back when available, CLI).
`npm run verify:gpu` — headless Chromium (SwiftShader is enough) runs every kernel on CPU and GPU and asserts byte-identical output; `--bench <dir> <name>` times a real dataset both ways and checks the archives are identical.
`npm run verify:npm` — packs the tarball, installs it into a throw-away Vite 8 app, builds, and runs the built app in headless Chromium (Playwright's, or `$CHROME`): GeoJSON → Gint (worker + WASM) → identify → PMTiles with two tile workers → GeoParquet. `npm run verify:all` chains `npm test`, `verify:gpu` and `verify:npm`; `.github/workflows/ci.yml` runs the same three on push and pull request (Node 22, pyarrow installed so the Parquet read-back is not skipped). `npm ci` works from the committed lockfile; `tests/fixtures/amedas.geopbf` (JMA AMeDAS stations, 141 KB) is the real-data fixture the loader tests use.

---

*Document version: August 2026. This specification is based on the implementation in the `geopbf` library.*
