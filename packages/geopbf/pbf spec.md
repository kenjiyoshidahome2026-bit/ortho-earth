# GeoPBF File Format Specification (v1.0)

GeoPBF is an optimized binary format for geospatial data, built upon Google's Protocol Buffers (PBF) architecture. It combines the efficiency of Protobuf with specific optimizations for geographic information: **integer-scaled, delta-encoded coordinates** and a **global key dictionary** for attributes. Together these make a GeoPBF file roughly one tenth the size of the equivalent GeoJSON.

## What is in the file — and what is not

The wire format is deliberately small and flat: **per-feature geometry as delta-encoded integer coordinates, plus attributes**. Two structures that the `geopbf` library is known for are **derived at read time and are not part of the wire format**:

| | Where it lives | Produced by |
| :--- | :--- | :--- |
| **Arcs** (shared-boundary topology) | in memory, after loading | `analyzeTopology()` — §5 |
| **gint** (64-bit Morton coordinates carrying LOD ranks) | in memory / on the GPU | conversion to GintBUF — §6 |

Readers therefore need to implement only §2–§4 to read every GeoPBF file. §5 and §6 describe representations a reader may *build* from that data; a minimal reader (for example the GDAL/OGR driver) omits them entirely.

Files may additionally be **gzip-compressed** as a whole; readers should detect the gzip signature (`1f 8b`) and inflate transparently.

---

## 1. High-Level Structure

A GeoPBF file consists of two primary sections: the **Header Section** and the **Body Section**.

## 2. Header Section

The header contains metadata, global dictionaries for property keys, and binary data pools.

| Tag | Field Name | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 1 | `NAME` | String | The name of the dataset. |
| 2 | `KEYS` | Repeated String | Global dictionary of property names. |
| 3 | `PRECISION` | Varint | Floating point precision ($10^n$). Default is 6 ($10^{-6}$ deg). |
| 4 | `BUFS` | Repeated Bytes | A pool for binary data like Blobs or raw pixel data. |
| 14 | `DESCRIPTION` | String | A brief summary of the data content. |
| 15 | `LICENSE` | String | Licensing or copyright information. |
| 16 | `ATTRIBUTION` | String | Attribution information of the data. |
| 17 | `MIN_ZOOM` | Varint | Optional. Lowest zoom level at which the dataset is intended to be drawn. |
| 18 | `MAX_ZOOM` | Varint | Optional. Highest zoom level at which the dataset is intended to be drawn. |

## 3. Body Section (FARRAY)

The body is a single container field that holds an array of Features.

| Tag | Field Name | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 5 | `FARRAY` | Message | Encapsulates the array of Feature messages. |
| 6 | `FEATURE` | Message | Contains its geometry and associated properties. |
| 7 | `GEOMETRY` | Message | Coordinates are stored. |
| 8 | `GTYPE` | Varint | Geometry type: 0:Point, 1:MPoint, 2:Line, 3:MLine, 4:Poly, 5:MPoly, 6:GCollection. |
| 9 | `LENGTH` | Packed Varint | Vertex counts for rings or multi-part geometries. |
| 10 | `COORDS` | Packed SVarint | Delta-encoded coordinates ($X_0, Y_0, \Delta X_1, \Delta Y_1, ...$). |
| 11 | `VALUE` | Repeated Message | The actual data, tagged by its type. |
| 12 | `INDEX` | Packed Varint | pointing to the indices in the global `KEYS` array. |
| 13 | `GARRAY` | Repeated Message | Nested Geometry messages for `GeometryCollection`. |

## 4. Supported Data Types (Internal Tag 11)

| Type ID | Name | Format |
| :--- | :--- | :--- |
| 0 | `NULL` | None |
| 1 | `BOOL` | Boolean |
| 2 | `INTEGER` | SVarint |
| 3 | `FLOAT` | Double |
| 4 | `STRING` | String |
| 5 | `DATE` | SVarint (Unix Timestamp / 1000) |
| 6 | `COLOR` | Bytes (RGBA 4-byte array) |
| 8 | `JSON` | String (JSON-serialized object) |
| 9 | `BBOX` | Packed Double (4 values) |
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

*Document version: August 2026. This specification is governed by the implementation in the `geopbf` library.
Change in this revision: §5 (arcs) and §6 (gint) are stated explicitly as derived representations rather than
wire-format features, `MIN_ZOOM` / `MAX_ZOOM` are documented, whole-file gzip is noted, and section numbering
is made sequential (§3 and §4 previously appeared twice).*
