# GeoPBF File Format Specification (v1.1)

GeoPBF is an optimized binary format for geospatial data, built upon Google's Protocol Buffers (PBF) architecture. It combines the efficiency of Protobuf with specific optimizations for geographic information: **integer-scaled, delta-encoded coordinates** and a **global key dictionary** for attributes. Together these make a GeoPBF file roughly one tenth the size of the equivalent GeoJSON.

## What is in the file — and what is not

The wire format is deliberately small and flat: **per-feature geometry as delta-encoded integer coordinates, plus attributes**. Two structures that the `geopbf` library is known for are **derived at read time and are not part of the wire format**:

| | Where it lives | Produced by |
| :--- | :--- | :--- |
| **Arcs** (shared-boundary topology) | in memory, after loading | `analyzeTopology()` — §5 |
| **gint** (64-bit Morton coordinates carrying LOD ranks) | in memory / on the GPU | conversion to GintBUF — §6 |

Readers therefore need to implement only §2–§4 to read every GeoPBF file. §5 and §6 describe representations a reader may *build* from that data; a minimal reader (for example the GDAL/OGR driver) omits them entirely.

Files may additionally be **gzip-compressed** as a whole; readers should detect the gzip signature (`1f 8b`) and inflate transparently.

All multi-byte values follow the Protocol Buffers wire format (little-endian varints, zigzag for `SVarint`, IEEE 754 little-endian for `Double`). Unknown tags must be skipped, not rejected.

---

## 1. High-Level Structure

A GeoPBF file consists of two primary sections: the **Header Section** and the **Body Section**.

## 2. Header Section

The header contains metadata, global dictionaries for property keys, and binary data pools.

| Tag | Field Name | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 1 | `NAME` | String | The name of the dataset. |
| 2 | `KEYS` | Repeated String | Global dictionary of property names, sorted. A nested object property `{ a: { b: 1 } }` is flattened to the key `"a.b"` at write time; readers reassemble the object by splitting on the first `.`. |
| 3 | `PRECISION` | Varint | Floating point precision ($10^n$). Default is 6 ($10^{-6}$ deg). |
| 4 | `BUFS` | Repeated Bytes | A pool for binary data like Blobs or raw pixel data. **Each entry is individually compressed with raw DEFLATE** (RFC 1951, no zlib/gzip framing); the index used by `BLOB` / `IMAGE` values is the entry's position in this repeated field (0-based). Identical buffers are stored once. |
| 14 | `DESCRIPTION` | String | A brief summary of the data content. |
| 15 | `LICENSE` | String | Licensing or copyright information. |
| 16 | `ATTRIBUTION` | String | Attribution information of the data. |
| 17 | `MIN_ZOOM` | Varint | Optional. Lowest zoom level at which the dataset is intended to be drawn. |
| 18 | `MAX_ZOOM` | Varint | Optional. Highest zoom level at which the dataset is intended to be drawn. |

## 3. Body Section (FARRAY)

The body is a single container field that holds an array of Features.

| Tag | Field Name | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 5 | `FARRAY` | Message | Encapsulates the array of Feature messages. Exactly one per file; it is the last header field. |
| 6 | `FEATURE` | Message | Contains its geometry and associated properties. |
| 7 | `GEOMETRY` | Message | Coordinates are stored. |
| 8 | `GTYPE` | Varint | Geometry type: 0:Point, 1:MPoint, 2:Line, 3:MLine, 4:Poly, 5:MPoly, 6:GCollection. |
| 9 | `LENGTH` | Packed Varint | Vertex counts for rings or multi-part geometries (§3.2). Absent for Point and LineString. |
| 10 | `COORDS` | Packed SVarint | Delta-encoded coordinates ($X_0, Y_0, \Delta X_1, \Delta Y_1, ...$), see §3.1. Absent for GeometryCollection. |
| 11 | `VALUE` | Repeated Message | One property value each, in the order of `INDEX`. The message holds a single field whose **field number is the type ID** of §4 and whose wire type is that of the type's format. |
| 12 | `INDEX` | Packed Varint | For each `VALUE`, the index of its key in the global `KEYS` array. Null / undefined properties are not written. |
| 13 | `GARRAY` | Message | Only when `GTYPE` = 6: a message that holds the member geometries as repeated `GEOMETRY` (tag 7) messages, each with its own `GTYPE` / `LENGTH` / `COORDS`. Nesting a GeometryCollection inside another is allowed by the encoding but not produced by the library. |

A `FEATURE` message is `GEOMETRY` followed by the `VALUE` messages and the `INDEX` field. Features without a geometry (`geometry: null`, or an unknown type) are **not written** (the writer counts them in `dropped`).

### 3.1 Coordinates

* Every coordinate is scaled by $10^{\text{PRECISION}}$ and rounded to an integer; longitude is first wrapped into $[-180, 180]$. Latitude is written as given (not clamped).
* **The delta chain restarts at (0, 0) for every ring or part**: within one ring the first vertex is absolute and every later vertex is the difference from its predecessor. For a `Point` the two values are absolute.
* Consecutive identical vertices (after rounding) are written once.
* **Polygon rings omit the closing vertex.** A ring of $n$ distinct vertices is written as $n$ points; readers append a copy of the first vertex. A ring that has fewer than 3 distinct vertices after rounding is dropped from `LENGTH` / `COORDS`; a polygon left with no ring is still written with an empty `COORDS` and no `LENGTH`.
* Polygon rings additionally pass through the writer's `cleanCoords` (spikes and collinear repeats removed). A Polygon that crosses the antimeridian is split by the library at write time unless the `cut: false` option is given; readers see ordinary geometry.
* A `Multi*` with exactly one member is written as the singular type (`MultiPolygon` with one polygon → `GTYPE` 4). Readers must not expect the multiplicity to round-trip.

### 3.2 `LENGTH`

| `GTYPE` | `LENGTH` contents |
| :--- | :--- |
| 0 Point, 2 LineString | none (a LineString's vertex count follows from the `COORDS` length) |
| 1 MultiPoint | none; `COORDS` is one delta chain of all points |
| 3 MultiLineString, 4 Polygon | one entry per part / ring: its vertex count |
| 5 MultiPolygon | `[P, R_1, len_{1,1} … len_{1,R_1}, R_2, len_{2,1} … ]`: the polygon count, then for each polygon its ring count followed by that many ring lengths |

## 4. Supported Data Types (Internal Tag 11)

| Type ID | Name | Format |
| :--- | :--- | :--- |
| 0 | `NULL` | None |
| 1 | `BOOL` | Boolean |
| 2 | `INTEGER` | SVarint (zigzag). Writers use it only for integer values with |v| ≤ 2^52, so the zigzag-doubled value stays exact in a double; larger integers go out as `FLOAT`. |
| 3 | `FLOAT` | Double (also integer-valued numbers beyond ±2^52, and 1e300-class values) |
| 4 | `STRING` | String |
| 5 | `DATE` | SVarint: Unix time in **seconds** (milliseconds are rounded away). |
| 6 | `COLOR` | Bytes (RGBA 4-byte array). Written only for strings in the exact canonical forms `rgb(r,g,b)` / `rgba(r,g,b,a)` (no spaces, 0–255 integers, `a` in 0–1); read back as that string (`rgba` alpha as `a/255` with two decimals, `rgb` when alpha is 255). Any other colour notation (`#hex`, spaces, …) is a plain `STRING`. |
| 7 | `FUNC` | String: the source text of a JavaScript function (`Function.prototype.toString()`). The reference reader returns it **as a string** (always since 2.0; the 1.19 `noeval: false` opt-in that revived it is gone) and non-JavaScript readers treat it as `STRING`. |
| 8 | `JSON` | String (JSON-serialized object or array) |
| 9 | `BBOX` | Packed Double (4 values: `[minX, minY, maxX, maxY]`) |
| 10 | `BLOB` | String metadata (`Name:Mime:ID`) pointing to `BUFS` |
| 11 | `IMAGE` | String metadata (`W:H:ID`) pointing to `BUFS` |

---

## 5. Topology (derived — not stored in the file)

> **Not part of the wire format.** Arcs are computed in memory from the per-feature coordinates of §3.
> A reader that skips this section still reads every GeoPBF file correctly.

Calling `analyzeTopology()` builds a shared-boundary (arc) model over a loaded dataset. It is a prerequisite for `topojson`, `mesh`, `merge` and `neighbors`.

* **Arc System**: Boundaries shared by adjacent polygons are identified and represented once as unique "Arcs".
* **Feature Referencing**: Features reference arcs by index; a negative index means the arc is traversed in reverse.
* **Purification**: Segment intersections are detected and resolved so the derived model is mathematically consistent.

Because this model is rebuilt from the coordinates on load, a file written before or after `analyzeTopology()` is byte-identical.

---

## 6. gint: Morton Coordinate Packing (derived — not stored in the file)

> **Not part of the wire format.** `gint` is the in-memory / GPU representation (GintBUF) that the rendering
> pipeline converts a loaded GeoPBF into. The file itself always carries plain delta-encoded coordinates (§3).

`gint` (Geospatial Integer) is a 64-bit coordinate representation based on the Morton curve (Z-order), used to make spatial queries and level-of-detail selection cheap at draw time.

### 6.1 Bit Structure

* **Bit 63 (Terminal Bit)**: If `1`, it represents an **L1 node** (fixed precision, $10^{-7}$). If `0`, it represents an **L2 node**.
* **Bits 0-5 (VW Weight)**: For L2 nodes, these bits store the Visvalingam-Whyatt (VW) rank (0-63), defining the importance of a vertex for dynamic simplification.

### 6.2 Benefits

Morton order preserves spatial proximity as numerical order, so proximity queries become ordered scans. The VW rank travels with each vertex, which lets a renderer thin a line continuously with a threshold comparison instead of shipping pre-simplified copies — the reason no level of detail is baked on the server side.

---

*Document version: October 2026 (v1.1). This specification is governed by the implementation in the `geopbf` library
(`src/pbf-base.js`, `src/modules/bufferTub.js`).
Changes in v1.1 (documenting behaviour the writer has always had): per-entry raw-DEFLATE compression of `BUFS`,
the `VALUE` message layout, the `GARRAY` nesting, the delta chain restarting per ring, the omitted polygon closing
vertex, the `LENGTH` layout per geometry type, the demotion of single-member `Multi*`, the canonical-form-only
`COLOR`, second-precision `DATE`, type 7 `FUNC`, the flattening of nested keys, and that geometry-less features are
not written.
v1.0 (August 2026): §5 (arcs) and §6 (gint) stated as derived representations, `MIN_ZOOM` / `MAX_ZOOM`, whole-file gzip,
sequential section numbering.*
