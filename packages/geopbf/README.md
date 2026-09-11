# geopbf

[![npm](https://img.shields.io/npm/v/geopbf)](https://www.npmjs.com/package/geopbf) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

> **Repo layout note** — development happens in the [ortho-earth monorepo](https://github.com/kenjiyoshidahome2026-bit/ortho-earth) (`packages/geopbf`); this standalone repo is a read-only mirror synced on each release. Issues are welcome here; patches land in the monorepo. / 開発はモノレポ側で行い、ここはリリースごとに同期される公開ミラーです（Issue歓迎・変更はモノレポへ）。

**Carry geometry as geometry.** GeoPBF is a compact binary container for geospatial features that keeps shapes as
shapes — instead of flattening them into draw-only tiles — plus **Gint**, a derived topology layer, readable by a GPU
vertex shader, that makes the data *answerable*: point-in-polygon identify, shared-edge topology, choropleth painting
by feature id.

Everything runs in the browser: format conversion in workers, topology baking in WASM, no servers, no API keys. Zero
runtime dependencies. This is the data layer under [ortho-earth](https://www.ortho-earth.com/), where 1,900+
Japanese municipal polygons identify in 0.5–4 ms on an ordinary laptop.

**Contents** — [1. Data model](#1-data-model) · [2. Quick start](#2-quick-start) · [3. File size](#3-file-size) ·
[4. Command line](#4-command-line) · [5. Vector tiles, GeoParquet, GeoPackage](#5-vector-tiles-and-geoparquet) ·
[6. COG](#6-cog--cloud-optimized-geotiff) · [7. Editing](#7-editing) · [8. Map library integrations](#8-map-library-integrations) ·
[9. Storage injection](#9-storage-injection) · [10. Runtime requirements](#10-runtime-requirements)

---

## 1. Data model

### 1.1 What is in the file

A GeoPBF file is a protobuf message with a header (name, key dictionary, precision, provenance fields) and a flat
array of features. Coordinates are **quantized to an integer grid** of `10^-precision` degrees and stored
**delta-encoded as packed signed varints**; property keys live in one global dictionary and are referenced by index.
Precision is a per-file parameter (1–9, default 6 ≈ 0.11 m).

| Header field | Meaning |
| :-- | :-- |
| `NAME` | dataset name |
| `KEYS` | global dictionary of property names |
| `PRECISION` | coordinate grid, `10^-n` degrees (default 6) |
| `DESCRIPTION` / `LICENSE` / `ATTRIBUTION` | provenance, carried inside the file |
| `MIN_ZOOM` / `MAX_ZOOM` | intended draw range (optional) |
| `BUFS` | pool for binary values (Blob / ImageData) |

Property values are typed: null, bool, integer, double, string, date, color, JSON, bbox, blob, image. A whole file may
additionally be gzipped; readers detect the `1f 8b` signature rather than trusting the extension. Full wire format:
[`pbf spec.md`](./pbf%20spec.md).

### 1.2 What is derived

Two structures the library is known for are **not** in the wire format — they are built at read time, so a minimal
reader (the GDAL/OGR driver, for instance) implements neither:

| | Built by | Lives in |
| :-- | :-- | :-- |
| **Arcs** — shared-boundary topology | `analyzeTopology()` | memory |
| **Gint** — 64-bit Morton coordinates carrying LOD ranks | `topology()` → GintBUF (WASM) | memory / GPU buffer |

Gint packs each vertex into 8 bytes: a Morton-interleaved position plus, in the low 6 bits, a **Visvalingam-Whyatt
rank**. Level of detail is then a comparison, not a re-simplification — a vertex is drawn at zoom `z` when
`rank >= 3·(21 − z)` — and because neighbouring polygons share one arc, both sides of a border always keep the
*identical* vertex list. No slivers, no gaps, at any zoom, with no per-zoom geometry baked anywhere.

```
  z  threshold      vertices   kept        (npx geopbf lod ne_10m_admin_0_countries.geopbf)
   0   63              9,742    1.8%  #
   4   51             38,330    7.0%  ###
   8   39            395,448   72.1%  #############################
  21    0            548,469  100.0%  ########################################
```

---

## 2. Quick start

```bash
npm i geopbf
```

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

| | |
| :-- | :-- |
| **Converters** (worker per format, lazily loaded) | GeoJSON · Shapefile (zip) · KML/KMZ · GPX · GML · FlatGeobuf · TopoJSON · MOJ 登記所備付地図 — in, and back out (`geojsonFile`, `kmzFile`, `gpxFile`, `gmlFile`, `fgbFile`, `shapeFile`, `topojsonFile`) |
| **Topology** (`{ gint: true }`) | typed-array buffer of arcs, features and neighbour topology, baked in WASM; usable from a GPU vertex shader or from plain JS |
| **Feature ops** | `centroid`, `area`, `lineLength`, `getBbox`, `classify`, `map`/`filter` clones, CSV/property tables |
| **Export** | PMTiles (MVT), GeoParquet, GeoJSON, TopoJSON, FlatGeobuf, KMZ, GPX, GML, Shapefile |

---

## 3. File size

Three public datasets of different shape and scale, each measured end to end on one machine. Every row holds the
same features; sizes are decimal MB, and the two caveats on coordinate precision are spelled out under the table.

| | **NE 10m admin_0**<br>countries, v5.1.1 | **KSJ N03 (2026)**<br>Japanese municipalities | **TIGER 2024 ZCTA5**<br>US ZIP code areas |
| :-- | --: | --: | --: |
| features | 258 | 125,130 | 33,791 |
| vertices | 548,469 | 15,669,416 | 51,258,797 |
| coordinate grid | 10⁻⁶° (0.11 m) | 10⁻⁶° (0.11 m) | 10⁻⁵° (1.1 m) |
| | | | |
| Shapefile (`.shp`+`.dbf`+`.shx`) | 9.7 | 282.8 | 825.3 |
| Shapefile + `.prj`, zipped −9 | 4.9 | 174.8 | 530.5 |
| GML (`.xml`) | — | 580.7 | — |
| GML + gzip −9 | — | 123.2 | — |
| GeoJSON | 13.3 | 579.6 | 1,089.6 |
| GeoJSON + gzip −9 | 4.7 | 138.6 | 265.8 |
| FlatGeobuf | 9.3 | 266.9 | 826.8 |
| FlatGeobuf + gzip −9 | 5.4 | 156.3 | 421.9 |
| GeoParquet (WKB, zstd, STR order, bbox column) | 4.5 | 124.5 | 333.7 |
| **GeoPBF** | **3.3** | **48.6** | **117.8** |
| **GeoPBF + gzip −9** (the distribution form) | **2.7** | **34.4** | **95.2** |
| | | | |
| bytes per vertex, Shapefile | 17.7 | 18.1 | 16.1 |
| bytes per vertex, Shapefile + zip | 9.0 | 11.2 | 10.3 |
| bytes per vertex, GeoJSON | 24.2 | 37.0 | 21.3 |
| bytes per vertex, GeoJSON + gzip | 8.6 | 8.8 | 5.2 |
| bytes per vertex, FlatGeobuf | 17.0 | 17.0 | 16.1 |
| bytes per vertex, FlatGeobuf + gzip | 9.8 | 10.0 | 8.2 |
| bytes per vertex, GeoPBF | 6.0 | 3.1 | 2.3 |
| bytes per vertex, GeoPBF + gzip | 4.9 | 2.2 | 1.9 |
| GeoJSON ÷ GeoPBF, both raw | 4.1× | 11.9× | 9.2× |
| GeoJSON ÷ GeoPBF, both gzipped | 1.8× | 4.0× | 2.8× |

Reproduce with `npx geopbf enc <in.geojson> <out.geopbf>` and `npx geopbf parquet`; the FlatGeobuf rows use the
official `flatgeobuf` npm writer on the same features, and the zipped-shapefile row is `.shp`+`.dbf`+`.shx`+`.prj`
packed here at deflate −9 so that all three datasets are measured the same way. The shipped archives differ in what
else they contain and are not directly comparable: Natural Earth 4.9 MB (adds `.cpg` and an HTML README), TIGER
528.8 MB (adds `.cpg` and two ISO metadata XML), KSJ N03 803.2 MB (carries GML *and* shapefile *and* GeoJSON in one
archive).

Two caveats on precision. The shapefiles are the original distributions and hold full double coordinates, while the
GeoJSON/GeoPBF/FlatGeobuf rows sit on the file's stated grid — but a shapefile spends a fixed 16 bytes per point
whatever the precision, so its size rows are unaffected. The ZCTA GeoJSON was written on the same 10⁻⁵° grid as the
GeoPBF, so within that column no text-or-binary row has a precision advantage over another.

**Compare like with like.** Gzipped against gzipped, GeoPBF is 1.8–4.0× smaller than GeoJSON — not the 5–17× the
raw rows suggest, and every format here is normally shipped compressed. Compression does most of its work on text
(GeoJSON keeps 24–36 % of its bytes, GML 21 %), a fair amount on the double-based binaries (shapefile 51–64 %,
FlatGeobuf 51–59 %: consecutive coordinates share the high-order bytes of their doubles, even though the low mantissa
bits are incompressible noise), and least on GeoPBF (71–82 %), which has already removed by construction the
redundancy the compressor goes looking for. The uncompressed rows are what a decoder walks through in memory; the
compressed rows are what crosses the network.

**Why it lands where it does.** Shapefile and FlatGeobuf land in the same place — 16–18 bytes per vertex — for the
same reason: both store two IEEE-754 doubles per point regardless of what the geometry looks like, and the spread
between them is record headers and attribute encoding, not coordinates. Two decades of format design separate the
two, and the geometry section did not move. GeoPBF stores a delta on an integer grid, so its byte cost falls
with vertex density: a boundary sampled every few metres spends 2–3 bytes per vertex uncompressed, while sparse
geometry (the Natural Earth countries, whose 258 features also carry 168 attribute columns) spends more. The header
dictionary means the attribute cost is paid once per key rather than once per feature.

GeoPBF is a *container*, not an index: unlike FlatGeobuf it has no packed Hilbert R-tree and no support for partial
reads — spatial queries come from Gint after a whole-file load, which is the trade this format makes deliberately.

**And the derived layer.** Gint costs 8 bytes per *arc* vertex plus the feature, polygon and neighbour index
streams — about 8.2–8.5 bytes per arc vertex in total. It is held in memory or uploaded to the GPU, and never
written to the file:

| | NE 10m admin_0 | N03 2026 | ZCTA5 2024 |
| :-- | --: | --: | --: |
| arcs | 4,658 | 129,034 | 102,782 |
| arc vertices (after shared-border folding) | 480,217 (88 %) | 13,028,137 (83 %) | 28,312,663 (55 %) |
| GintBUF | 4.1 MB | 110.4 MB | 232.0 MB |
| bake time (WASM, 1 core) | 0.14 s | 3.0 s | 6.9 s |

The folding ratio is a property of the data: ZIP code areas tile the country, so more than half of all vertices are
on a border two features share and are stored once.

---

## 4. Command line

The library is browser-first, but the core encoder/decoder runs on plain Node — so the package also ships a small
CLI. No build step, no GDAL, no extra dependencies.

```bash
npx geopbf enc ne_10m_admin_0_countries.geojson countries.geopbf   # 13.3 MB -> 2.7 MB, gzipped by default
npx geopbf enc in.geojson out.geopbf --precision 7 --no-gzip       # 1 cm grid, raw (un-gzipped) GeoPBF
npx geopbf info countries.geopbf                                   # features, vertices, precision, header fields
npx geopbf dec countries.geopbf back.geojson                       # round trip
npx geopbf lod countries.geopbf                                    # what Gint would actually draw, per zoom
npx geopbf pmtiles countries.geopbf countries.pmtiles --maxzoom 10 # → PMTiles (MVT), simplified per zoom from Gint
npx geopbf parquet countries.geopbf countries.parquet              # → GeoParquet (WKB + bbox)
npx geopbf parquet2pbf in.parquet out.geopbf                       # ← GeoParquet, from anyone's writer
npx geopbf gpkg2pbf roads.gpkg                                     # list the layers of a GeoPackage
npx geopbf gpkg2pbf roads.gpkg roads.geopbf --layer roads          # ← GeoPackage, one layer (own SQLite reader, no GDAL)
npx geopbf cog info https://…/TCI.tif                              # remote COG structure over HTTP Range
```

Output is gzipped by default, matching the GDAL driver's `COMPRESS=GZIP` and the usual distribution form; pass
`--no-gzip` for a raw file. Gzip input is detected by signature, not by extension, for every command including
`enc`. For inputs other than GeoJSON, GeoParquet and GeoPackage — Shapefile, PostGIS, and everything else GDAL
reads — use the [GDAL/OGR driver](https://github.com/kenjiyoshidahome2026-bit/gdal-geopbf) (`ogr2ogr -f GeoPBF`,
needs GDAL ≥ 3.12), or the browser workers in `src/index.js`.

---

## 5. Vector tiles and GeoParquet

`geopbf/pmtiles` and `geopbf/geoparquet` take a GeoPBF (plus its Gint) out the other side: a **PMTiles** archive of
Mapbox Vector Tiles, or a **GeoParquet** file. The embarrassingly parallel stages — projection, per-zoom rank
filtering, integer→double conversion, bbox reduction — run on the GPU when WebGPU is present, and on a CPU path with
the *same* integer arithmetic when it is not. Zero new dependencies; the CLI runs on plain Node. Read
[§5.5](#55-where-the-gpu-is-honestly) before expecting the GPU to change the wall-clock.

```bash
npx geopbf pmtiles countries.geopbf countries.pmtiles --maxzoom 10   # bakes Gint with WASM, then tiles from it
npx geopbf pmtiles countries.geopbf countries.pmtiles --gint countries.gint --gpu   # reuse a baked Gint
npx geopbf parquet countries.geopbf countries.parquet                # WKB + bbox covering column
```

```js
import { toPMTiles } from "geopbf/pmtiles";
import { toGeoParquet } from "geopbf/geoparquet";

const pbf = await geopbf(file, { gint: true });          // browser: Gint is baked by the worker as usual
const { buffer, stats } = await toPMTiles(pbf, { maxZoom: 12 });   // stats.engine → "gpu" | "cpu"
const pq = await toGeoParquet(pbf);                      // pq.buffer → .parquet bytes, pq.geo → the "geo" metadata
```

### 5.1 Tiles come from Gint, not from the raw features

This is the same derived buffer ortho-earth draws on the GPU. Shared borders are single arcs and every vertex carries
its VW rank, so per-zoom simplification is a `rank >= threshold` filter — the `63 − 3·(z + log2(extent/256))` rule
ortho-core uses at draw time — and two neighbouring polygons are simplified to the identical vertex list.

1. **`project`** — Morton decode → fixed-point Web Mercator `X32/Y32` (32-bit, whole world). Once per vertex, not
   once per zoom.
2. **`lod`** — one dispatch over `(arc × zoom)`: keep `rank >= threshold`, shift to tile space, drop consecutive
   duplicates, write compacted coordinates (count pass + write pass). All zooms in a single round trip.
3. **Worker pool** (browser `Worker` / Node `worker_threads`, one code path) — each `(zoom × tile-column range)` job
   stitches rings and lines from the arcs (`polyStream`/`lineStream`), bisects them into tiles with buffer, encodes
   MVT, gzips and content-hashes its tiles. The main thread merges by content key and packs PMTiles v3: Hilbert tile
   ids, run-length plus content de-duplication for interior tiles, leaf directories once the root exceeds 16 KB.
   Sharding only prunes the bisection tree, so **the output is byte-identical at any worker count** (`workers: 0`
   runs inline).

The assembly stage is typed-array based, stops bisecting as soon as a sub-range of tiles is provably interior to a
polygon (one range event instead of one clip per tile), encodes the attribute section once per feature, and hashes
tile content before copying it. Attributes reach the workers as one typed-array table (key dictionary, UTF-8 string
dictionary, per-feature entry list) rather than a million small arrays: worker start-up for 1,000,000 features
dropped from 16 s to 1.6 s, and string bytes are written into the tiles as they are, without a second UTF-8 encoding.
Compression is one code path with no pako — `node:zlib` in Node, `CompressionStream` driven through its
writer/reader directly in browsers (≈4× cheaper per tile than the `Blob`→`Response` idiom).

Points skip the clipping tree entirely (tile index by shift, buffer copies to neighbours) and are thinned at lower
zooms like tippecanoe's `-r`: `dropRate` 2.5 keeps 1/2.5 of the points per zoom step below `maxZoom`, chosen by a
hash of the feature id so the kept sets nest. `dropRate: 1` keeps every point in every tile.

### 5.2 Simplification is calibrated to tippecanoe's, per arc

The Gint rank is a Visvalingam area; tippecanoe drops vertices by Douglas-Peucker distance (1 tile unit, `-S 1`).
The two do not map to each other by a constant — a VW area threshold keeps far more vertices on long, gently curved
segments than DP does, and none on tiny islands where DP keeps 3 — so a fixed rank rule came out 3 % (countries) to
31 % (ZIP areas) larger than tippecanoe.

`simplification` (default 1, in tile units) fixes this the honest way: one Douglas-Peucker decomposition per arc
yields, for every vertex, the tolerance at which it would survive; for each arc and zoom the rank threshold is then
chosen so that VW keeps as many vertices as DP would.

| | DP (tippecanoe) | VW (calibrated) |
| :-- | --: | --: |
| NE 10m countries, z0 | 46,442 | 47,985 |
| NE 10m countries, z10 | 471,774 | 471,927 |
| Canada, z0 | 7,234 | 7,649 |
| USA, z0 | 2,466 | 2,725 |

Which vertices survive is still decided by rank, so shared borders stay identical on both sides. The calibration runs
on the CPU and costs 0.1 s on 480k vertices, 4.2 s on 29M; the per-`(arc, zoom)` thresholds then feed the same
GPU/CPU kernel, byte-identical either way. `simplification: false` restores the fixed rule; `lodBias` shifts the
calibrated thresholds (`+3` ≈ one rank step ≈ 1.26× coarser linearly).

Tile quality follows tippecanoe's defaults where they matter. Polygon components smaller than `tinyPolygon` tile
units² at a zoom — measured on the full-resolution geometry, so components the simplification collapsed count too —
are replaced by one placeholder square per accumulated threshold of area, which keeps atolls and archipelagos visible
as dots at z2 instead of disappearing; sub-threshold clip fragments and holes are dropped; the clipper removes the
zero-width spurs Sutherland-Hodgman leaves along tile edges. `tinyPolygon: 0` turns the reduction off.

### 5.3 Benchmarks

Same 4-core box, same inputs, tippecanoe v2.82, PMTiles out.

| Input | Zooms | | geopbf | tippecanoe |
| :-- | :-- | :-- | --: | --: |
| **NE 10m countries**<br>258 polygons / 480k arc vertices | z0–10 | time<br>size<br>tiles | ≈6.5 s *(enc 0.4 + Gint 0.5 + tiles 5.3–5.9)*<br>151.0 MB<br>573,896 | 58 s<br>147 MB<br>573,885 |
| **NE 10m roads**<br>56,600 lines / 709k vertices | z0–10 | time<br>size<br>tiles | 10.0 s *(+2.2 s enc + Gint)*<br>72.8 MB<br>108,688 | 16.2 s<br>69.7 MB<br>108,682 |
| **TIGER ZCTA5** *(2010 vintage — a different file from §3)*<br>33,092 polygons / 52M vertices (28.9M after folding) | z0–12 | time<br>size<br>tiles | 47 s<br>251 MB<br>238,322 | 251 s<br>246 MB<br>238,319 |
| **1,000,000 synthetic points**, 4 attributes | z0–10 | time<br>size | 14.6 s<br>51 MB *(default `dropRate`)* | 31 s<br>42 MB |
| same, every point kept | z0–10 | time<br>size | 42 s<br>270 MB | 65 s / 221 MB *(`-r1`)* |

GDAL's PMTiles driver (3.12) took 780 s for the countries job.

The tile *sets* agree to within a handful of tiles: countries, 13 tiles only in geopbf and 2 only in tippecanoe, all
at z6–10, and interior tiles are byte-for-byte the same size apart from the layer name and the feature `id` geopbf
writes — which is the whole of the remaining 2.7 % size difference. Roads: every line reaching a tile edge continues
in the neighbouring tile (3,001 of 3,001 checked at z8), and the only features tippecanoe keeps that geopbf does not
are 15 small closed loops the rank filter collapses at z0 (extent ≤ 3 tile units). ZCTA5 2010: the same tile set within 7
tiles, per-zoom sizes within 1–2 % from z7 up (z12: 102.0 vs 100.6 MB), indistinguishable in MapLibre at z3/z7/z11,
and byte-identical on re-run (322 MB with `simplification: false`).

Countries z0–10 in more detail on 4 cores: 5.3–5.9 s with 4 workers (the default is one per core; 3 → 5.8 s, 5–7 →
5.5–6.8 s), 16–18 s single-threaded, of which zlib is ≈8 s (85k unique tiles, ~90 µs each regardless of level).
Chromium z0–8 takes ≈5.7 s with 3 workers.

GeoParquet on the same data:

| | geopbf | geopandas |
| :-- | --: | --: |
| ZCTA5 2010 (52M vertices), zstd | 28.5 s / 437 MB | 54 s / 542 MB (gzip) |
| 1,000,000 points, STR order + bbox column | ≈12 s / 45.6 MB | — |
| 1,000,000 points, no bbox column | 21.4 MB | 4.9 s / 20.2 MB (unsorted, no bbox) |

geopbf writes 608 MB for that ZCTA5 with gzip rather than zstd: Node's zlib is the Chromium fork whose 4-byte hash misses
the short matches a stream of WKB doubles is full of (0.73 vs 0.64 ratio against stock zlib on the same bytes), which
is why zstd is the default codec in Node. The Parquet stage for 1M points is 7 s of the 12 s, down from 11 s before
columns were transposed once into contiguous arrays and dictionary-encoded.

### 5.4 Exactness is the design rule

Every kernel is integer-only. The Mercator latitude uses a 2¹³·10⁻⁷° table with an exact slope column (error ≤ 3
units of 2⁻³²); longitude uses exact 64-bit division emulated in 32-bit. So the GPU output is not "close to" the CPU
output, it is byte-identical, and `scripts/verify-convert-gpu.mjs` proves it on every kernel through headless
Chromium — on SwiftShader, so it runs in CI without a GPU.

GeoParquet takes the GeoPBF integers directly (no Gint round-trip, so coordinates are exactly the file's values): the
GPU converts `i / 10^precision` to IEEE-754 doubles by long division with round-to-nearest-even, bit-identical to
JavaScript's own division, and reduces per-feature bboxes; the CPU assembles WKB and writes Parquet (Thrift compact
footer, PLAIN or dictionary pages, RLE definition levels, GZIP or zstd, `geo` metadata 1.1 with a `bbox` covering
column and min/max/null-count statistics on every column). Low-cardinality columns are dictionary-encoded per row
group (`RLE_DICTIONARY`, chosen when distinct values are at most half the rows). Readable by pyarrow, DuckDB, GDAL
and GeoPandas.

Rows are **spatially ordered** (`order`, default `"str"`): feature bbox centres are packed Sort-Tile-Recursive style
— sorted by x, cut into √P slices of `rowGroupSize` multiples, each slice sorted by y — so every row group's `bbox`
statistics cover a disjoint patch and a reader that pushes an area filter down (DuckDB, pyarrow datasets, GeoPandas)
fetches only the row groups that intersect it. This follows Kanahiro Iguchi's *Spatial sort for well-packed
GeoParquet* (CNG Japan 2026); replicated here on 1,000,000 points in 50 row groups:

| `order` | row-group bbox overlap ratio | candidate row groups, city-sized query |
| :-- | --: | --: |
| `none` (input order; row index = feature id) | 24.5 | 50 |
| `morton` (the Gint-native key, cheapest) | 0.87 | 3–4 |
| `hilbert` | 0.28 | 2 |
| `str` (default) | 0.00 | 1–2 |

The `bbox` column is written by default because it is what the pruning keys on. For point-only data it merely
repeats the coordinates, so `bboxColumn: "auto"` drops it there (half the size, no pruning); `false` drops it always.

**And back again.** `fromGeoParquet(u8)` / `geopbf parquet2pbf` turns a GeoParquet file into a GeoPBF: a
dependency-free Parquet reader (Thrift compact footer, DataPage v1/v2, PLAIN and dictionary encodings, none/gzip/zstd
and a built-in snappy decoder for pyarrow's default) plus a WKB parser (all seven types, EWKB flags, Z/M dropped). A
file geopbf wrote comes back bit-identical — coordinates are `round(x·10^precision)` with the precision recorded in
the file — and files written by geopandas, pyarrow (v2 pages, zstd) and DuckDB read back to the same features
(Natural Earth: all 258 identical across the three writers). ZCTA5 2010 (33,092 features, 52M vertices, zstd) comes back
in 72 s — 12 s to read, 60 s to encode — with every feature identical to the original. The CRS must be lon/lat
(CRS84 / EPSG:4326); anything else is refused unless `ignoreCrs`. Rows without a geometry are dropped and counted
(`stats.droppedGeometries`) — a GeoPBF feature always carries a shape, as it does on the GeoPackage, FlatGeobuf and KML
paths. PMTiles has no such inverse: tiles are simplified
and quantized, so the best one could do is an approximate reassembly, which this package does not attempt.

### 5.5 Where the GPU is, honestly

The kernels that run on the GPU are projection, the per-zoom rank filter with its count/prefix-sum/write, the
integer→double conversion and the bbox reduction. Everything after them — ring assembly, clipping, MVT encoding,
gzip, PMTiles/Parquet writing — is CPU work in workers, and it dominates. Measured shares of the GPU-able stages on
the CPU path (4-core Node):

| Job | GPU-able stages | Total | Share |
| :-- | --: | --: | --: |
| NE countries, 480k vertices, z0–10 | 0.16 s | 5.6 s | 3 % |
| 200,000 synthetic parcels / 8.2M vertices (4.4M after folding), z0–16, 43,880 tiles / 185 MB | 2.1 s | 41.5 s | 5 % |
| 1,000,000 synthetic points, z0–10 | 0.9 s | 14.6 s | 6 % |

By Amdahl's law a GPU that made those stages free would shave at most that much. The honest reading is that the GPU
is a nicety for the browser — it keeps the main thread free and scales flatly with vertex count — not the reason the
converter is fast. The speed comes from Gint (a rank filter instead of per-zoom simplification, one arc per shared
border) and from the assembly stage.

Real-GPU timings could not be measured in the CI container. On SwiftShader (a software Vulkan) the GPU path is slower
than the CPU path, as expected, and produces identical bytes (`scripts/verify-convert-gpu.mjs --bench`). Chromium on
the synthetic parcel map, z0–12 (`--bench big_raw --maxzoom 12`): CPU path project+LOD 0.8 s + write 0.9 s of 28.7 s;
SwiftShader path 1.5 s + 1.4 s, bytes identical; GeoParquet kernels 0.2 s on the CPU vs 2.1 s on SwiftShader,
identical output.

Node has no `navigator.gpu`. `npm i webgpu` (Dawn) gives the CLI a real adapter; without it, `--gpu` reports the
fallback and runs the CPU path — same bytes out. Deno's built-in WebGPU works as is. In the browser everything is
automatic. `gpu: false` forces CPU; a `GPU` object (e.g. from the `webgpu` package) can be passed as `gpu`.

### 5.6 Options

```js
toPMTiles(pbf, { gint, minZoom = 0, maxZoom = 14, extent = 4096, buffer = 80, layer, simplification = 1,
                 lodBias = 0, dropRate = 2.5, tinyPolygon = 2, tinyLine = 0, include, exclude, excludeAll,
                 tileCompression = "gzip", gpu, workers, onProgress })

toGeoParquet(pbf, { codec, level = 9, rowGroupSize = 65536, pageSize, order = "str", bboxColumn = true,
                    geometryName = "geometry", include, exclude, excludeAll, gpu })
```

`codec` is `"zstd"` / `"gzip"` / `"none"` and defaults to zstd where the runtime has it (Node 22.15+) and gzip
otherwise. `include` / `exclude` / `excludeAll` select attributes — tiles and Parquet columns alike — and correspond
to tippecanoe's `-y` / `-x` / `-X`.

---

### 5.7 GeoPackage in (read-only)

`geopbf/gpkg` reads a `.gpkg` directly — in the browser (drop the file, or `geopbf(file)`) and in Node — with a
small **read-only SQLite reader of its own** (`geopbf/sqlite`, ~200 lines: B-tree pages, overflow chains, record
serial types, UTF-8/UTF-16). No sql.js, no WASM, still zero dependencies. It walks the table B-tree of one feature
layer, unwraps the GeoPackageBinary header and hands the WKB to the same decoder GeoParquet uses.

```js
import { readGeoPackage, fromGeoPackage } from "geopbf/gpkg";
const { layers } = readGeoPackage(u8);                        // [{ table, geometryType, crs, count, columns }]
const { pbf, stats } = await fromGeoPackage(u8, { layer: "roads" });   // layer omitted → first feature layer
```

| | |
| :-- | :-- |
| CRS | EPSG:4326 / CRS84 / undefined-geographic pass through; EPSG:3857 is converted back to lon/lat; anything else throws unless `ignoreCrs` (GeoPBF is lon/lat only — reproject first) |
| Geometry | all seven WKB types, either byte order, with or without envelope; Z/M dropped; NULL / empty / extension geometries are dropped and counted (`stats.droppedGeometries`) |
| Attributes | SQLite values as they are; declared `BOOLEAN` → bool, `DATE`/`DATETIME`/`TIMESTAMP` → Date; `BLOB` columns skipped (`stats.skipped`); integers beyond 2^53 kept as strings |
| Not read | indexes and R-trees (not needed for a full scan), views, `WITHOUT ROWID` tables, un-checkpointed WAL |

Raster GeoPackages (tile pyramids) are opened as what they are — a z/x/y tile store — rather than converted:

```js
import { openGpkgTiles } from "geopbf/gpkg";
const t = openGpkgTiles(u8, "std");     // { zooms, xyz, count, bboxLonLat, matrices, get(z,x,y), has(z,x,y), mimeOf }
const png = t.get(14, 14553, 6452);     // Uint8Array — createImageBitmap(new Blob([png])) in the browser
```

`xyz` is true when the matrix set is the EPSG:3857 world grid (256 px, 2^z × 2^z), in which case `tile_row` equals the
XYZ `y`; other grids expose their `matrices` for the caller to map. The index (z/x/y → rowid) is built once by decoding
only the first columns of each row, so the tile blobs are never copied until `get` asks for one.

Writing GeoPackage is deliberately not here — `ogr2ogr -f GPKG` from the GDAL driver does it, and building a SQLite
file by hand is where a dependency would start to earn its keep.

---

## 6. COG — Cloud Optimized GeoTIFF

Rasters, the same way: a COG is a static file read by HTTP Range requests — no tile server, no preprocessing. The
reader is hand-written pure JS (zero new dependencies): one 16 KB range request fetches the whole header, tile
requests are sorted and coalesced (adjacent ranges merge into one request), decode and reprojection run in a worker
pool, and decoded tiles sit in a byte-budgeted LRU. JPEG/WebP tiles go through the browser's native (hardware)
decoder.

```js
import { openCog } from "geopbf/cog";
const cog = await openCog("https://…/TCI.tif");     // 1 range request, header parsed
cog.bboxLL;                                          // [w,s,e,n] in WGS84
const bm = await cog.renderXYZ(14, x, y);            // ImageBitmap, warped to Web Mercator
cog.metrics();                                       // {ttfhMs, rangeRequests, coalescedFrom, …}
```

MapLibre and Leaflet, one line each (host libraries are not imported by geopbf):

```js
import { cogProtocol } from "geopbf/maplibre-cog";
maplibregl.addProtocol("cog", cogProtocol);
map.addSource("x", { type: "raster", tiles: ["cog://https://…/TCI.tif/{z}/{x}/{y}"], tileSize: 256 });

import { cogGridLayer } from "geopbf/leaflet-cog";
(await cogGridLayer(L, "https://…/TCI.tif")).addTo(map);
```

```bash
npx geopbf cog info https://…/TCI.tif --bench   # structure + measured numbers (Node fetch + Range)
npx geopbf cog png  https://…/TCI.tif out.png   # quick-look render
```

**Supported subset** (public-COG mainstream; everything else fails with an explicit error):

| | |
| :-- | :-- |
| Layout | tiled and stripped TIFF, BigTIFF |
| Compression | none · deflate · LZW · JPEG · WebP *(JPEG/WebP decode in browser only)* · predictor 2 |
| Samples | uint8 RGB(A) · palette · single-band uint8/16 · int16 · float32 *(auto percentile stretch, `GDAL_NODATA` → transparent)* |
| CRS | EPSG:4326 · EPSG:3857 · UTM 326xx–327xx *(Krüger n-series, nm-accurate)* |

For anything beyond that, `gdal_translate -of COG` first. Sources without CORS: inject a proxy via
`openCog(url, { fetch })`. Node reads the same core via `geopbf/cog/core` (DOM-free).

---

## 7. Editing

`geopbf/edit` (v1.3) is the editing core battle-tested in
[geoedit](https://www.ortho-earth.com/japan/geoedit) — pure data modules, no DOM, worker-safe, Node-testable.

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

| | |
| :-- | :-- |
| `buildTopology(fc, gridExp)` | extract shared-edge topology; a border edit moves both features at once |
| `createModel(topo)` | vertex move/insert/delete, feature add/delete, holes, translate; command objects (`applyCmd`/`invertCmd`) with re-extraction-stable addresses, so undo/redo survives topology rebuilds |
| `createLargeModel(pbf)` | edit tens of millions of vertices in place on the GeoPBF bytes + Gint buffer — no full extraction, no OOM |
| `createSnapIndex(gridExp, deref)` | grid-linked snapping |
| `createHistory()` | undo/redo stack |
| `smoothRing` / `smoothGeom` | Catmull-Rom subdivision, shared by the editor and `@spline` playback so the curve is the same everywhere |

Granular imports: `geopbf/edit/model`, `geopbf/edit/large-model`, `geopbf/edit/topo-extract`, `geopbf/edit/snap`,
`geopbf/edit/history`, `geopbf/edit/spline`.

---

## 8. Map library integrations

None of these import the host library; each is a thin adapter you register yourself. All of them share one loader
(gzip detection, `noeval` property decoding, sanitizing) and the same `{ fetch, sanitize, signal }` options.

### 8.1 MapLibre GL JS

`geopbf/maplibre` supplies GeoPBF files to MapLibre as GeoJSON sources. (Data supply only; this is not a
MapLibre-compatible rendering layer for the Gint engine.)

```js
import maplibregl from "maplibre-gl";
import { geopbfProtocol } from "geopbf/maplibre";

maplibregl.addProtocol("geopbf", geopbfProtocol);
map.addSource("rail", { type: "geojson",
  data: "geopbf://https://api.ortho-earth.com/bucket/GIS/pbf/N02-25_RailroadSection" });
```

- **URL contract** — pass the inner URL **absolute** (`geopbf://https://…`), as with pmtiles. MapLibre normalizes
  source URLs through `new URL()`, which corrupts relative forms like `geopbf://../x`; the handler repairs the one
  mangling absolute URLs suffer (`https//` losing its colon), but relative paths cannot be recovered.
- **Whole-file gzip** is detected by magic bytes and decompressed transparently.
- **Properties are sanitized** to survive MapLibre's JSON round-trip to its worker: `Date` → ISO string, BBOX → plain
  array, FUNC → source string (decoded with `noeval`, so no `new Function` — CSP-safe), Blob/ImageData values
  dropped. `makeGeopbfProtocol({ sanitize: false })` opts out.
- **Metadata** — name / description / license / attribution / minZoom / maxZoom travel inside the file, but a
  protocol handler cannot set source attribution or layer zoom range. Use `loadGeopbf(url)` to get
  `{ geojson, ...meta }` and wire them into `addSource`/`addLayer` yourself, or `makeGeopbfProtocol({ onMeta })`. For
  feature-state, set `promoteId` on the source (GeoPBF features carry no `id`).
- A GeoPBF file is one whole dataset, not z/x/y tiles, so MapLibre's built-in geojson-vt does the tiling and
  simplification. Comfortable up to tens of MB of resulting GeoJSON; for very large datasets, tile it first with
  [§5](#5-vector-tiles-and-geoparquet).

See `examples/maplibre.html` for a standalone demo (base map + protocol source + `loadGeopbf` metadata wiring).

### 8.2 Leaflet

`geopbf/leaflet` provides an `L.GeoJSON` subclass. Register it explicitly (works with ESM and the CDN global `L`):

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

Unlike MapLibre's protocol handler, a Leaflet layer owns its attribution, so the file header's `attribution` is wired
in automatically (an explicit `options.attribution` wins). `getMeta()` returns the header metadata after load;
`await layer.whenReady()` awaits it. See `examples/leaflet.html`.

### 8.3 OpenLayers

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

Features are reprojected to the view projection automatically (`featureProjection`), and the header's `attribution`
is wired into the source (an explicit `attributions` option wins). See `examples/openlayers.html`.

### 8.4 deck.gl / loaders.gl

`geopbf/loaders` exports a loaders.gl `Loader`, which plugs into deck.gl and other loaders.gl consumers directly:

```js
import { GeoJsonLayer } from "@deck.gl/layers";
import { GeoPBFLoader } from "geopbf/loaders";

new GeoJsonLayer({ data: "https://…/N02-25_RailroadSection", loaders: [GeoPBFLoader] });
```

`parse` returns a GeoJSON FeatureCollection with the header metadata attached as `geopbfMeta`; pass
`loadOptions: { geopbf: { sanitize: false } }` to opt out of property sanitizing. See `examples/deckgl.html`.

### 8.5 Cesium, D3, and everything else

Libraries that accept a GeoJSON object directly need no plugin at all — `geopbf/load` exposes the shared loader the
four integrations above are built on:

```js
import { loadGeopbf } from "geopbf/load";

// Cesium
const r = await loadGeopbf("geopbf://https://…/N02-25_RailroadSection");
viewer.dataSources.add(await Cesium.GeoJsonDataSource.load(r.geojson));
if (r.attribution) viewer.creditDisplay.addStaticCredit(new Cesium.Credit(r.attribution));
```

Same deal for D3 (`d3.geoPath` over `r.geojson`), Observable notebooks, or anything else that eats GeoJSON.
`loadGeopbf` returns `{ geojson, name, description, license, attribution, minZoom, maxZoom }`. See
`examples/cesium.html`.

---

## 9. Storage injection

Out of the box, `createGeopbf()` fetches plainly and re-converts on every load — correct, dependency-free,
cache-less. If you have your own storage layer (IndexedDB cache, remote bucket, proxied fetch), inject it:

```js
createGeopbf(apiBase, { bucket: myProvider });
// myProvider(apiBase, options) → { Bucket, Cache, Fetch }
```

Everything else — conversion, Gint, identify — is identical either way.

---

## 10. Runtime requirements

No runtime dependencies. The protobuf wire reader/writer is built in (`geopbf/pbf`); the last external package,
`pbf`, was dropped in 1.6. Compression and decompression everywhere — gzip/deflate for
GeoPBF, ZIP/Shapefile/MOJ decoders, COG tiles, PMTiles and Parquet — go through the platform's native codecs
(`CompressionStream`/`DecompressionStream` in browsers and workers, `node:zlib` in Node); pako was removed in 1.5.
Requires a browser with `CompressionStream` (all evergreen browsers). zstd in Node needs 22.15+.

Workers are declared as `new Worker(new URL("./…", import.meta.url), { type: "module" })` and the WASM ships as a
regular asset — Vite and other modern bundlers handle both natively, no plugins. One setting is required in the
consumer's Vite config, because the workers use dynamic imports internally and Vite's default `iife` worker format
rejects them:

```js
// vite.config.js
export default { worker: { format: "es" } };
```

---

## License

MIT. The format is meant to spread — build on it freely. Format spec and technical notes:
[ortho-earth.com/docs/geopbf.html](https://www.ortho-earth.com/docs/geopbf.html)
