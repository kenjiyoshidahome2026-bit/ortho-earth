# geopbf — vector tiles: exactness and the GPU

Design notes for `geopbf/pmtiles` and `geopbf/geoparquet`, moved out of the [README](README.md) §5 on 2026-11-03
(npm cuts a README at 64 KB). The section numbers are the README's.

## 5.4 Exactness is the design rule

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
dependency-free Parquet reader (Thrift compact footer, DataPage v1/v2, every value encoding a writer uses today —
PLAIN, the two dictionary encodings, `DELTA_BINARY_PACKED`, `DELTA_LENGTH_BYTE_ARRAY`, `DELTA_BYTE_ARRAY`,
`BYTE_STREAM_SPLIT` and `RLE` booleans, so parquet-java, DuckDB and pyarrow v2 pages keep their attributes — the
physical types `BOOLEAN`/`INT32`/`INT64`/`INT96`/`FLOAT`/`DOUBLE`/`BYTE_ARRAY`/`FIXED_LEN_BYTE_ARRAY`, none/gzip/zstd
and a built-in snappy decoder for pyarrow's default; a column the reader cannot decode is skipped with its reason
in `stats.skipped`, never silently emptied) plus a WKB parser (all seven types, EWKB flags, Z/M dropped). A
file geopbf wrote comes back bit-identical — coordinates are `round(x·10^precision)` with the precision recorded in
the file — and files written by geopandas, pyarrow (v2 pages, zstd) and DuckDB read back to the same features
(Natural Earth: all 258 identical across the three writers). ZCTA5 2010 (33,092 features, 52M vertices, zstd) comes back
in 72 s — 12 s to read, 60 s to encode — with every feature identical to the original. The CRS must be lon/lat
(CRS84 / EPSG:4326); anything else is refused unless `ignoreCrs`. Rows without a geometry are dropped and counted
(`stats.droppedGeometries`) — a GeoPBF feature always carries a shape, as it does on the GeoPackage, FlatGeobuf and KML
paths. PMTiles has no such inverse: tiles are simplified
and quantized, so the best one could do is an approximate reassembly, which this package does not attempt.

**Read only what you need.** `openParquet(src)` from `geopbf/parquet` opens a Parquet or GeoParquet file **without
downloading it**: `src` may be a URL, a `File`/`Blob`, a `Uint8Array` or a `{ read(from, len), size }` you provide. It
fetches the footer first (two small `Range` requests: `bytes=0-0` for the total length, then the last 64 KB — both in the CORS-safelisted form, so no preflight) and returns the schema, the `geo` metadata, and one
entry per row group with its byte size and column statistics (`min`/`max`). `pq.select({ bbox })` uses the statistics of
the bbox covering column to name the row groups that touch a viewport — on a file written with `order: "str"` a
Tokyo-sized view of an 8,000-feature test file touches 32 of 63 row groups and reads 110 KB of 505 KB — and
`pq.readRowGroup(g, { columns })` fetches only those column chunks, coalescing neighbouring byte ranges into as few
requests as possible (the same source as the COG reader). Hosts that ignore `Range` get the whole file once and
everything else works the same; files without statistics simply select every row group (`pruned: false`).
`fromGeoParquet(url)` rides on the same reader, so it too stops holding whole files.

**zstd in the browser.** Browsers have no zstd (`DecompressionStream("zstd")` is specified but not shipped), and geopbf
keeps zero runtime dependencies, so it takes a decoder from you instead (Node uses `node:zlib` first). Inject it in the
thread that reads — inside the worker if you read in a worker:

```js
import { setZstdDecoder } from "geopbf/parquet";
setZstdDecoder(async u8 => (await import("fzstd")).decompress(u8));   // loaded only when a zstd page appears
```

## 5.5 Where the GPU is, honestly

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
