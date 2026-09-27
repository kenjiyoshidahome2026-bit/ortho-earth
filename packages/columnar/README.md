# @ortho-earth/columnar

A **column-chunk layer** for [`@ortho-earth/globe`](../globe): draws GeoPBF and GeoParquet
*without* the Gint topology pass. Data goes reader → flat arrays → GPU in spatial chunks
(GeoParquet row groups, or GeoPBF cut into row-group-like chunks), so the first frame waits
only for "read + pack" — no shared-arc encoding, no Morton ranks, no bake.

```
GeoParquet ─ row group ─┐
                         ├→ column chunk (worker) → overlay (render worker, same frame as the globe)
GeoPBF ── spatial cut ───┘        attributes stay columns; only the ones paint refers to are read
```

Gint stays the layer for editing, topology, terrain draping and exact shared borders. This
layer is the default for *drawing* large files; see the trade-offs below.

## Use

```js
const h = await map.addColumnar(src, {              // src: GeoParquet URL/File, GeoPBF File/ArrayBuffer, or geopbf() result
  paint: { "fill-color": ["interpolate", ["linear"], ["get", "pop"], 0, "#ffeeee", 5000, "#990000"], "line-width": 0.5 },
  filter: ["==", ["get", "class"], "residential"],
});
await h.ready;
h.setPaint(...); h.setFilter(...); h.setVisible(false);   // tables only — geometry is never rebuilt
const hit = await h.query([lon, lat]);                    // worker: 50 m point → 30 m line → smallest polygon
h.on("click", e => console.log(e.row, e.properties));
h.remove();
```

In the ortho-earth apps a dropped `.parquet` always takes this path, and a `.geopbf` / `.fgb` takes it
above `opts.columnarBytes` (default 4 MB; `?columnar=1|0` forces it) — **unless the data looks like a
choropleth with long shared arcs** (admin1, administrative maps). Every reader measures `meta.share` on its
first chunk (`ratio` = vertices already seen in another feature, `meanVertices` per feature); the default rule
(`gintPreferred`: ratio ≥ 0.3 and ≥ 40 vertices per feature, ≤ 64 MB) sends those to Gint, whose winding fill,
single-drawn shared borders and continuous LOD suit them. `createGlobe({ columnarRule })` replaces the rule.

By default the layer **drapes** on the terrain (per-vertex elevation from the render worker's terrain, lifted
when the view is tilted, resampled 60 k vertices per frame as tiles arrive) and is **occluded by the scene depth**
(mountains, buildings; `depth: false` to disable, LOW_MEM devices never build the depth).

## What a chunk is

```js
{ g, bbox, rows: Int32Array,       // chunk index, [w,s,e,n], chunk-local index → source row (fid)
  origin: [x, y, z],               // relative-to-eye-style origin: positions are float32 offsets from here
  points: { pos, feat },           // unit-sphere xyz, feature index per point
  levels: [{ zoom, lines: { pos, feat }, fills: { pos, index, feat } }, …] }   // full + 2–3 LODs
```

- Edges longer than 1° are subdivided in lon/lat before packing (the same reason Gint inserts
  degree anchors: big polygons must not open on the sphere).
- Polygons are triangulated with `earcut`. No topology: a shared border is drawn twice.
- LOD: vertices are snapped to the pixel grid of zoom 12 / 9 / 6 and consecutive duplicates
  dropped; a ring that collapses becomes a ≥ half-pixel quad so small parcels keep their fill.
  A level that does not remove ≥ 25 % of the vertices is skipped.
- Features spanning ±180° are made continuous by shifting negative longitudes by 360.

## Readers (`registerColumnarSource`)

```js
registerColumnarSource({
  name: "geoparquet",
  test({ name, head }) { … },                       // extension and magic bytes (PAR1 …)
  async open(src, ctx) { return {
    meta,                                           // { rows, chunks: [{ bbox, rows, bytes }], columns, range, bbox, types }
    select(bbox),                                   // chunk indices touching the view (all when no statistics)
    readGeometry(g),                                // flat geometry (src/flat.js)
    readColumns(g, names, rows),                    // { column: values[] } aligned with the chunk
    readProps(g, row),                              // one row's attributes (tips)
  }; },
});
```

Built in: `geoparquet` (own Parquet reader from `geopbf/parquet`: footer, statistics pruning,
Range requests, none/snappy/gzip, zstd via `fzstd` on demand), `geopbf` (in-memory: one
scan of wire integers for bboxes, STR spatial order from `geopbf/spatial-order`, cut by
feature/vertex count) and `fgb` (FlatGeobuf, whole-file through `geopbf/fgb` then the `geopbf`
reader; Range reads through the packed Hilbert R-tree are not done yet). GeoArrow-encoded
GeoParquet is not read (the own Parquet reader has no nested list columns); a `parquet-wasm`
reader can be registered by an app. Workers register readers through the `#columnar-sources` package import;
an app that adds readers points that alias at its own module (functions cannot be posted).

## Trade-offs vs Gint

| | Gint | Column chunks |
|---|---|---|
| First frame | after full encode + bake | after the view's chunks are packed |
| Shared borders | drawn once | drawn twice |
| Overlapping fills | winding union | later on top |
| LOD | continuous (VW rank) | 2–3 steps |
| Terrain | draped (GPU subdivision) | draped per vertex (`drape: true`), scene-depth occlusion |
| Editing / topology | yes | switch to Gint when needed |

## Measured (phase 0 yardstick)

`packages/globe/scripts/perf-columnar.mjs` (headless Chrome, SwiftShader — use the numbers relatively):
time to the first frame, same GeoPBF bytes through both roads.

| data | bytes | Gint (encode + bake) | column chunks (open + first chunk) |
|---|---|---|---|
| 20 k parcels, 8-gons | 1.5 MB | 457 ms | 75 ms |
| 60 k parcels | 4.4 MB | 1174 ms | 70 ms |
| 150 k parcels | 11 MB | 1257 ms | 98 ms |
| 1 M points | 32 MB | 1307 ms | 255 ms |

The chunk road is flat in the file size (the first chunk is ~8 k features: read 5–7 ms, pack 9–10 ms); the rest of the
view arrives in the background (all visible chunks: 205 / 205 / 382 / 551 ms). The overlay's CPU issue time per frame is ≤ 0.2 ms.

## Test

`node tests/t-columnar.mjs` (readers agree with each other, WKB fast path = parseWkb,
subdivision, LOD, antimeridian, identify, style tables, registry).
Browser: `packages/globe/tests/t-columnar.html?g=same|perf` via `npm run verify:ui`.
