# GeoPBF API Reference (v1.19)

`GeoPBF` is a high-performance GIS library for the browser, providing efficient binary storage, spatial analysis, and topological processing.

## Table of Contents
1. [Constructor](#1-constructor)
2. [Data Loading & Output](#2-data-loading--output)
3. [Metadata & Configuration](#3-metadata--configuration)
4. [Geometric Analysis](#4-geometric-analysis)
5. [Data Manipulation](#5-data-manipulation)
6. [Topology & Advanced GIS](#6-topology--advanced-gis)
7. [Combining](#7-combining)
8. [MapLibre Integration](#8-maplibre-integration-geopbfmaplibre)
9. [Leaflet Integration](#9-leaflet-integration-geopbfleaflet)
10. [OpenLayers Integration](#10-openlayers-integration-geopbfopenlayers)
11. [loaders.gl Integration](#11-loadersgl-integration-geopbfloaders)

---

## 1. Constructor

### `new GeoPBF(options)`
Creates a new GeoPBF instance (`import { GeoPBF } from "geopbf"` (1.20; `geopbf/pbf-base` is the container without the extension methods); the auto-detecting entry `geopbf(input, options)` from `createGeopbf()` creates instances with the same options).
* **`options.name`** (String): Dataset name.
* **`options.precision`** (Number): Coordinate precision ($10^n$). Default is `6` ($10^{-6}$ degrees).
* **`options.noprop`** (Boolean): If true, skips property encoding to save space.
* **`options.cut`** (Boolean): `false` disables the antimeridian split at encode time (for a container that must round-trip shapes unchanged, e.g. an editor session). Default `true`; `pbf.cutCount` counts the features that were split.
* **`options.description` / `license` / `attribution` / `minZoom` / `maxZoom`**: header metadata (see §3).
* **`options.validate`** (`"lenient"` | `"strict"` | `"legacy"`): the encode-time validation layer (1.20). **`"lenient"` (default)** repairs what it can and counts the rest: `NaN`/`±Infinity` property values become null (not written), latitudes outside ±90 are only counted (values untouched, never thrown — CRS-less drawings keep their numbers), broken positions (non-finite or non-numeric) are dropped, empty coordinates / degenerate rings (< 3 vertices) / null geometries are dropped (a polygon whose outer ring is degenerate is dropped; a hole is just removed), GeometryCollection members are checked one by one. What happened is in **`pbf.issues`** (first 100 `{ kind, index, detail }`; `index` = position in the input) and **`pbf.issueCount`** (per kind: `nullGeometry`, `emptyCoords`, `badCoordinate`, `latitude`, `degenerateRing`, `badNumber`, plus the informational `multiDegraded` = single-member Multi* written as the singular type, which is the wire contract and never an error), and `close()` logs one summary line. **`"strict"`** throws on the first problem (`err.issue = { kind, index, detail }`) — use it as an ingestion gate. **`"legacy"`** is the pre-1.20 behaviour (`NaN` → 0, `Infinity` throws, `Point` `[]` → (0,0), latitudes untouched, geometry-less features dropped with one warning). `pbf.dropped` counts dropped features in every mode.
* **`options.noeval`** (Boolean): FUNC-typed property values (wire type 7, written when a property is a JavaScript function) are returned as their source string. **Default `true`** since 1.19: opening an unknown file never runs code from it, and decoding works under a CSP without `unsafe-eval`. Pass `{ noeval: false }` to opt back into the old behaviour (`new Function(\`return ${src}\`)`, i.e. a thunk that returns the function).

---

## 2. Data Loading & Output

### `await pbf.set(data)`
Loads data into the instance. Supports GeoJSON objects, ArrayBuffers, or TypedArrays.
* **ArrayBuffer ownership.** When a decoder worker is wired (after `createGeopbf()` in a browser), the buffer is **transferred** to the worker and the caller's `ArrayBuffer` becomes detached (`byteLength === 0`). Pass `buf.slice(0)` if you still need it. On the main-thread path (`{ worker: false }`, or Node where no `Worker` exists) the buffer is used in place and stays readable.
* **`options.worker`** (Boolean, constructor): `false` decodes `set(ArrayBuffer)` and `setGintBUF()` on the calling thread for this instance even when `createGeopbf()` has wired workers. `createGeopbf(apiBase, { worker: false })` passes it to every instance it creates. In Node (no global `Worker`) the main-thread path is used automatically.

### `pbf.geojson` (Getter)
Returns the entire dataset as a GeoJSON `FeatureCollection`.

### `pbf.arrayBuffer` (Getter)
Returns the serialized binary data as an `ArrayBuffer`.

---

## 3. Metadata & Configuration

### `pbf.name([value])` / `pbf.description([value])` / `pbf.license([value])`
Gets or sets metadata strings.

### `pbf.precision([value])`
Without an argument: the coordinate precision ($10^n$, synchronous). With an argument (1–9): **returns a Promise of a new instance** re-encoded at that precision (the receiver is unchanged).

### `pbf.updateHeader(meta)` / `pbf.attribution([value])` / `pbf.minZoom([value])` / `pbf.maxZoom([value])`
Header metadata is rewritten in place (O(header), the feature body is copied, not re-encoded). `pbf.headerBuffer` is the header alone.

---

## 4. Geometric Analysis

### `pbf.centroid(index)`
Returns the `[lng, lat]` centroid of the feature at the specified index.

### `pbf.area(index)`
Returns the area (in square meters) of the polygon at the specified index.

### `pbf.contain([lng, lat])`
Returns the feature index (fid) of the **smallest** polygon containing the point, or `null` (also `null` when no Gint has been baked). Needs `{ gint: true }`.

### `pbf.identifyAt(lng, lat, [options])`
Point / line / polygon hit test without a projection, in that order: `{ point: 50, polyline: 30 }` are the search radii in metres, `accept(fid)` filters candidates. Returns the feature index or `null`.
Lines and polygons are matched through a uniform grid index built lazily per layer (`geopbf/identify` → `hitGridOf(stream, arcMeta)`): only features whose bbox covers the query cell are tested, so hover on large layers no longer scans every feature (polygons ×10–20, lines ×3–5 on 6k/3k-feature layers). Answers are identical to the full scan (smallest polygon wins; first line in stream order).

### `pbf.lineLength(index)` / `pbf.getBbox(index)` / `pbf.bbox` / `pbf.bboxes`
Length in metres, per-feature bbox, dataset bbox, all bboxes.

---

## 5. Data Manipulation

### `await pbf.dissolve(propertyName)`
Merges adjacent polygons that share the same value for the specified property (`true` = everything, omitted = all properties equal, compared by type: `1` and `"1"` differ).

### `await pbf.map(mapFunc)` / `await pbf.closeFilter(filterFunc)` / `await pbf.cloneMap({ map, filter })`
Returns a new instance with properties modified by `mapFunc` / only the features passing `filterFunc`.

### `await pbf.classify(keyOrFunc)`
Splits the dataset into multiple instances based on a property key or a custom classification function.

### `pbf.clone()` / `pbf.cloneHead()` / `pbf.getPropertyTable()` / `pbf.getCSV()` / `pbf.propertiesTable` / `pbf.propsRow(i)`
Copies and attribute tables. `propsRow(i)` is the row of values in `keys` order, decoded lazily.

### `pbf.simplified(minRank)`
A FeatureCollection thinned to vertices of Gint rank ≥ `minRank` (for baking dedicated low-detail data, not for drawing).

---

## 6. Topology & Advanced GIS

All of §6 needs the Gint topology (`geopbf(input, { gint: true })`, or `await pbf.gint()`).

### `pbf.topojson()`
Returns the dataset in **TopoJSON** format (arcs shared between neighbours).

### `pbf.neighbors([index])`
Indices of the features sharing a boundary with `index`; without an argument, the whole adjacency list.

### `pbf.mesh({ filter, arc })`
MultiLineString of the boundaries shared by exactly two polygons that satisfy `filter` (`arc: true` returns arc indices).

### `pbf.merge({ filter, arc })`
Outer boundary of the union of the polygons that satisfy `filter`, with shared internal boundaries removed.

### `await pbf.gint([options])` / `await pbf.setGintBUF(buf)` / `pbf.cleanTopology(options)` / `pbf._gintBuffer` / `pbf.unPackGint`
Bake, attach, clean and read the GintBUF (format 5). `options.clean` runs the intersection repair after baking. `setGintBUF(buf)` **takes ownership** of `buf` (a `SharedArrayBuffer` is used as is, an `ArrayBuffer` is wrapped without a copy where no SAB exists); pass `buf.slice(0)` to keep your own copy. `unPackGint`'s typed arrays are views over `_gintBuffer`, and its bbox tables (`polyBboxByFid`, `lineBboxByFid`, `polyCompBbox`) are built lazily on first read.

---

## 7. Combining & export

### `pbf.concat(...others)` / `GeoPBF.concatinate([a, b, …], name)`
Combines this instance with other instances into a new instance (named after this one).

### Export (methods added by `createGeopbf()`)
`await pbf.geopbfFile()`, `geojsonFile()`, `topojsonFile()`, `shapeFile()`, `kmzFile()`, `gpxFile()`, `czmlFile()`, `gmlFile()`, `fgbFile()` → a `File`/`Blob` of that format, encoded in a worker (`{ gz: true }` where the format is text). `await pbf.save()` stores to the configured bucket; `await pbf.preview(canvas, props)` draws a thumbnail; `await pbf.profile()` measures sizes; `await pbf.gintbuf()` returns the GintBUF.

### Module map (package subpaths)
| Subpath | What it exports |
| :-- | :-- |
| `geopbf` | `createGeopbf`, `geopbf`, `geopbfCached`, `geopbfCachePrune`, `setWorkerFactory`, `GeoPBF` (the class with every extension method, 1.20) |
| `geopbf/core` | the light entry (1.20): `GeoPBF` (the container only, no extension methods), `loadGeopbf` / `decodeToGeojson` / `fetchAndDecode` / `sanitizeProperties`, `gzip` / `gunzip` / `isGzip`. Static import closure 14 files / 77 KB against 30 / 218 KB for `geopbf` — for code that only reads or writes `.geopbf` files |
| `geopbf/pbf-base` | `GeoPBF` (the container alone: encode / decode / header, no `centroid`, `identifyAt`, `dissolve` …), `makeKeys`, `propsKeyOf` |
| `geopbf/pbf` | `Pbf` (default): the built-in protobuf wire reader / writer (same API as the old `pbf` package) |
| `geopbf/worker`, `geopbf/no-builtin-workers` | the single worker entry; the alias that drops geopbf's own worker from a host bundle |
| `geopbf/gint`, `geopbf/topology`, `geopbf/identify` | Gint baking (WASM), GintBUF pack/unpack, `findPolygon` and friends |
| `geopbf/convert`, `geopbf/pmtiles`, `geopbf/geoparquet`, `geopbf/parquet`, `geopbf/spatial-order` | PMTiles / GeoParquet writers and readers, engines, spatial ordering |
| `geopbf/gpkg`, `geopbf/sqlite`, `geopbf/spatialite`, `geopbf/mbtiles`, `geopbf/filegdb`, `geopbf/fgb`, `geopbf/dxf`, `geopbf/table` | readers: GeoPackage (own SQLite reader), SpatiaLite, MBTiles, File Geodatabase, FlatGeobuf, DXF, CSV/TSV/XLSX |
| `geopbf/proj`, `geopbf/datum`, `geopbf/convert/node-gint` | projections (`crsFromWKT` → `toLonLat` / `fromLonLat`, `epsgToWKT`; one Krüger TM shared with the COG reader), JGD datum shifts (TKY2JGD / PatchJGD), Gint baking from Node |
| `geopbf/cog`, `geopbf/cog/core`, `geopbf/cog/source`, `geopbf/maplibre-cog`, `geopbf/leaflet-cog` | Cloud Optimized GeoTIFF by Range requests and its map adapters |
| `geopbf/featureservice` | ArcGIS FeatureServer / OGC API – Features as a GeoPBF source |
| `geopbf/georef` | IIIF Georeference Annotation (control points → image warp) |
| `geopbf/edit`, `geopbf/edit/*` | the editing model used by geoedit (DOM-free) |
| `geopbf/maplibre`, `geopbf/leaflet`, `geopbf/openlayers`, `geopbf/loaders`, `geopbf/load` | map library adapters (§8–§11) and the shared loader |
| `geopbf/tilesource` | on-demand MVT tiles from a GeoPBF+Gint (`createTileSource`; the `geopbf://…/{z}/{x}/{y}` protocol's engine) |
| `geopbf/sanitize`, `geopbf/czml`, `geopbf/gzip`, `geopbf/encodeZIP`, `geopbf/decodeZIP`, `geopbf/encodeXLSX`, `geopbf/fname2mime` | utilities |

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

### Vector tiles: `geopbf://…/{z}/{x}/{y}`
The same `geopbfProtocol` serves Mapbox Vector Tiles when the URL ends with `/{z}/{x}/{y}` (`.pbf`/`.mvt` suffix allowed) and MapLibre asks for an `arrayBuffer` (a `vector` source). Tiles are built on demand from the file's Gint with the `toPMTiles` pipeline (`convert/tilesource.js`): shared borders stay one arc at every zoom, `feature.id` is the fid, the source layer is the header `name`. One tile source is kept per inner URL (fetched, baked and projected once).
* **`makeGeopbfProtocol({ tiler })`**: `tiler` takes every `toPMTiles` option (`minZoom`, `maxZoom`, `extent`, `buffer`, `layer`, `simplification`, `lodBias`, `dropRate`, `tinyPolygon`, `tinyLine`, `include`/`exclude`/`excludeAll`, `gpu`) plus `zoomCache` (4) / `columnCache` (256), the number of per-zoom coordinate sets and per-column tile sets kept. `tilerOf(innerUrl)` returns per-URL overrides. `bake(pbf)` replaces the Gint step (default: `pbf.gint()` when the main package is loaded, else the wasm topology on the main thread). `onSource(innerUrl, src)` is called once per source.
* **`handler.tiles.sources`** (Map) / **`handler.tiles.dispose(innerUrl)`**: the cached tile sources; `dispose` releases one.
* **`geopbfTileProtocol`** / **`makeGeopbfTileProtocol(options)`**: the tile-only handler (throws on a URL without `/z/x/y`).
* **`parseTileUrl(url)`** → `{ inner, z, x, y }` or `null`.
* **`await createTileSource(pbf, options)`** (`geopbf/tilesource`): protocol-free form. `src.tile(z, x, y)` → `Promise<Uint8Array | null>` (uncompressed MVT; `null` when the tile has no feature or is out of range), `src.metadata` (same as `toPMTiles`), `src.minZoom/maxZoom/bounds/layerName`, `src.destroy()`. With the same options (and `tinyPolygon: 0`) the bytes equal the `toPMTiles` tiles.

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
* **`dropRate`** (2.5): point thinning below `maxZoom`, tippecanoe `-r` semantics — a point survives at zoom `z` when `hash(fid, ordinal)/2^32 < dropRate^-(maxZoom−z)` (ordinal = the point's position within its feature in Morton order; a single Point keeps the 1.19 key `hash(fid)`), so kept sets nest across zooms and a MultiPoint is thinned point by point (1.20); `1` keeps every point. Polygons and lines are never dropped by this.
* **`tinyPolygon`** (2, tile units², tippecanoe `-s`): a polygon component whose *full-resolution* area at zoom `z` is below this is not written; its area is added to a per-feature accumulator (decided on the main thread per zoom since 1.20, so the result does not depend on `workers`) and each time the accumulator reaches the threshold one square of that area is written in its place, so archipelagos and parcel blocks keep their density at low zooms instead of vanishing (the same goes for components the rank filter collapsed to fewer than 3 vertices). Clipped fragments below the threshold and holes below it are dropped outright. `0` disables all of it. **`tinyLine`** (0): drop a line whose bbox is smaller than this in both directions at that zoom.
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
The inverse: a GeoParquet (or any Parquet with a WKB geometry column) → `{ pbf: GeoPBF, stats }`. Reads the `geo` metadata for the primary column, encoding (`WKB` only) and CRS (must be CRS84 / EPSG:4326 unless **`ignoreCrs`**); other columns become properties — leaves of nested groups under their dotted path (`nest.x`, GeoPBF's own convention), the `bbox` covering column dropped, repeated (list/map) columns skipped and listed in `stats.skipped`. **`precision`** defaults to the file's `geopbf:precision` key-value, else 6; **`name`**, **`geometryColumn`**, **`include`** / **`exclude`** / **`excludeAll`** as elsewhere. Supported: DataPage v1/v2; encodings PLAIN, PLAIN_DICTIONARY / RLE_DICTIONARY, RLE (booleans), DELTA_BINARY_PACKED (INT32/INT64), DELTA_LENGTH_BYTE_ARRAY, DELTA_BYTE_ARRAY (BYTE_ARRAY and FIXED_LEN_BYTE_ARRAY), BYTE_STREAM_SPLIT (FLOAT/DOUBLE/INT32/INT64/FIXED_LEN_BYTE_ARRAY); codecs none / snappy / gzip / zstd; physical types BOOLEAN, INT32, INT64, INT96 (legacy timestamp → Date), FLOAT, DOUBLE, BYTE_ARRAY, FIXED_LEN_BYTE_ARRAY (UTF8 → string, JSON → parsed, TIMESTAMP/DATE → Date). Not supported: the deprecated BIT_PACKED level/value encoding, repeated (list/map) columns — such a column is reported in `stats.skipped` with the encoding and type named, e.g. `unsupported encoding BIT_PACKED for physical type INT32`. A nested leaf whose dotted name collides with a real column (`a/b` and `"a.b"`) gets `#2`, `#3`… appended, so both are read; column chunks are matched by schema path, not name. `readParquet(u8)` (`geopbf/convert`) exposes the plain column reader; `tests/fixtures/parquet/` holds pyarrow-written fixtures for every encoding (`make.py` regenerates them).
`geopbf parquet2pbf <in.parquet> <out.geopbf> [--precision N] [--name name] [--geometry col] [--ignore-crs] [--no-gzip] [--include a,b] [--exclude a,b] [--exclude-all]`

### Lower-level pieces (`geopbf/convert`)
`getDevice()` / `setGPU(gpu)` / `findGPU()` — device acquisition; `createEngine(device)` / `cpuEngine()` — the kernel contract (`project`, `lodCount`, `lodWrite`, `wkb`, `bbox`); `await writePMTiles(tiles, metadata, opts)` / `await assemblePMTiles(items, contents, metadata, opts)` / `await readPMTiles(u8)` (async `getTile`) / `zxyToTileId` / `tileIdToZxy`; `encodeTile(layer)` (MVT, dependency-free) / `decodeTile(u8)` (test decoder, `geopbf/convert` only); `await writeParquet({ schema, columns, numRows }, opts)` (columns take `values` arrays or `get(row)`, `stats:false`, `dict:false`); `attrFilter(opts)`; `gzip(u8)` / `gunzip(u8)` (zlib in Node, `CompressionStream` elsewhere) / `zstd(u8, level)` / `unzstd(u8)` / `hasZstd()` (Node ≥ 22.15 only).

### TypeScript (1.20)
The package ships hand-written declarations (`types/*.d.ts`, `"types"` in `package.json`, and a `"types"` condition on each typed subpath): `geopbf`, `geopbf/core`, `geopbf/pbf`, `geopbf/pbf-base`, `geopbf/load`, `geopbf/maplibre`, `geopbf/leaflet`, `geopbf/openlayers`, `geopbf/loaders`, `geopbf/identify`, `geopbf/topology`, `geopbf/worker`. The `GeoPBF` class, its options (`validate`, `noeval`, `worker`, `cut`, …), `geopbf(input, options)`, the Gint structures (`UnPackGint`) and the protocol handlers are typed; the remaining subpaths (converters, COG, edit, …) are declared as shorthand ambient modules (`any`) in `types/subpaths.d.ts`, so importing them type-checks without `TS7016`. GeoJSON types are minimal and self-contained (structurally compatible with `@types/geojson`). `tests/t-dts.mjs` keeps the declarations, `sideEffects` and the `geopbf/core` closure honest, and type-checks `tests/fixtures/dts/consumer.ts` in strict mode when `typescript` is resolvable.

`"sideEffects"` lists the modules that must survive tree shaking: the worker bodies (top-level `onmessage`), `pbf.js` / `pbf-base.js` / `index.js` (they add methods to `GeoPBF.prototype` at load) and the WASM glue. Everything else (loaders, identify, converters) is side-effect free and can be dropped when unused.

### CLI
`geopbf pmtiles <in.geopbf> <out.pmtiles> [--minzoom N] [--maxzoom N] [--extent N] [--buffer N] [--layer name] [--gint in.gint] [--simplification N|off] [--lod-bias N] [--tiny-polygon A] [--tiny-line L] [--include a,b] [--exclude a,b] [--exclude-all] [--workers N] [--drop-rate R] [--gpu | --no-gpu]`
`geopbf parquet <in.geopbf> <out.parquet> [--compression gzip|none] [--row-group N] [--order str|hilbert|morton|none] [--no-bbox] [--gpu | --no-gpu]`

### Verification
`npm run test:convert` — CPU references (exact division vs BigInt, table error bound, clipping, MVT, PMTiles directory), end-to-end PMTiles (shared-border identity across zooms, hole winding, de-duplication, CLI) and GeoParquet (WKB round-trip, pyarrow read-back when available, CLI, and the pyarrow-written encoding fixtures: delta, byte-stream-split, RLE booleans, INT96, colliding leaf names).
`npm run verify:gpu` — headless Chromium (SwiftShader is enough) runs every kernel on CPU and GPU and asserts byte-identical output; `--bench <dir> <name>` times a real dataset both ways and checks the archives are identical.
`npm run build:wasm` (1.20) — rebuilds `wasm/pkg` reproducibly: `rust-toolchain.toml` pins rustc 1.96.0 with the `wasm32-unknown-unknown` target, `wasm/build.sh` runs `cargo build --release --locked` → `wasm-bindgen --target web` (the CLI must match the `wasm-bindgen` version in `Cargo.lock`, 0.2.122) → `wasm-opt -O` (binaryen, pinned by `WASM_OPT_VERSION` in the script; `npm i -g binaryen@<version>` or `WASM_OPT=…`), then writes the ledger `wasm/pkg.sha256` (sha256 of the `.rs` / Cargo files and of `pkg/*`, plus the rustc / wasm-bindgen / wasm-opt versions). `npm run check:wasm` (and `tests/t-wasm-pkg.mjs` in `npm test`) compare the ledger with the tree: a changed `.rs` without a rebuild, a hand-edited `pkg`, a different toolchain, a glue export that the JS does not import (dead Rust) or a `#[wasm_bindgen]` item missing from the glue all fail. The crate exports exactly what `src/extension/gint.js` imports: `init_panic_hook`, `alloc_wasm_memory`, `free_wasm_memory`, `L1toL2_wasm`, `detect_intersections_wasm`, `topology_full_wasm` (+ the `GintBufOut` return type); `GintConverter`, `XYtoL1_wasm`, `build_polygons_wasm` and `build_polylines_wasm` were removed in 1.20 (never called from JS), which took the wasm from 143 KB to 129 KB.

`npm run verify:npm` — packs the tarball, installs it into a throw-away Vite 8 app, builds, and runs the built app in headless Chromium (Playwright's, or `$CHROME`): GeoJSON → Gint (worker + WASM) → identify → PMTiles with two tile workers → GeoParquet. `npm run verify:all` chains `npm test`, `verify:gpu` and `verify:npm`; `.github/workflows/ci.yml` runs the same three on push and pull request (Node 22, pyarrow installed so the Parquet read-back is not skipped). `npm ci` works from the committed lockfile; `tests/fixtures/amedas.geopbf` (JMA AMeDAS stations, 141 KB) is the real-data fixture the loader tests use.

---

*Document version: October 2026 (v1.19). This reference follows the implementation in the `geopbf` library.*
