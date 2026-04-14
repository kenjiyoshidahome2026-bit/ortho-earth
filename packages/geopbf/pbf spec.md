# GeoPBF File Format Specification (v1.0)

GeoPBF is an optimized binary format for geospatial data, built upon Google's Protocol Buffers (PBF) architecture. It combines the efficiency of Protobuf with specific optimizations for geographic information, such as coordinate delta-encoding, attribute key-value indexing, and advanced topological management via Morton codes.

---

## 1. High-Level Structure

A GeoPBF file consists of two primary sections: the **Header Section** and the **Body Section**.

### 1.1 Header Section
The header contains metadata, global dictionaries for property keys, and binary data pools.

| Tag | Field Name  | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 1 | `NAME` | String | The name of the dataset. |
| 14 | `DESCRIPTION` | String | A brief summary of the data content. |
| 15 | `LICENSE` | String | Licensing or copyright information. |
| 3 | `PRECISION` | Varint | Floating point precision ($10^n$). Default is 6 ($10^{-6}$ deg). |
| 2 | `KEYS` | Repeated String | Global dictionary of property names. |
| 4 | `BUFS` | Repeated Bytes | A pool for binary data like Blobs or raw pixel data. |

### 1.2 Body Section (FARRAY)
The body is a single container field that holds an array of Features.

| Tag | Field Name | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 5 | `FARRAY` | Message | Encapsulates the array of Feature messages. |

---

## 2. Feature Structure (Tag 6)

Each Feature contains its geometry and associated properties.

### 2.1 Geometry Message (Tag 7)
Coordinates are stored as integers (after applying the precision multiplier) and are delta-encoded to minimize storage.

| Tag | Field Name | Protobuf Type | Description |
| :--- | :--- | :--- | :--- |
| 8 | `GTYPE` | Varint | Geometry type: 0:Point, 1:MPoint, 2:Line, 3:MLine, 4:Poly, 5:MPoly, 6:GCollection. |
| 9 | `LENGTH` | Packed Varint | Vertex counts for rings or multi-part geometries. |
| 10 | `COORDS` | Packed SVarint | Delta-encoded coordinates ($X_0, Y_0, \Delta X_1, \Delta Y_1, ...$). |
| 13 | `GARRAY` | Repeated Message | Nested Geometry messages for `GeometryCollection`. |

### 2.2 Property Encoding (Tags 11, 12)
Properties are encoded using a separate key-index system to avoid redundant strings.

* **Tag 12 (`INDEX`)**: A `Packed Varint` pointing to the indices in the global `KEYS` array.
* **Tag 11 (`VALUE`)**: A `Repeated Message` containing the actual data, tagged by its type.

#### Supported Data Types (Internal Tag 11)
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

## 3. Gint: Morton Coordinate Packing

GeoPBF utilizes `gint` (Geospatial Integer), a 64-bit coordinate representation based on the Morton curve (Z-order). This allows for extremely fast spatial queries and topological integrity.

### 3.1 Bit Structure
* **Bit 63 (Terminal Bit)**: If `1`, it represents an **L1 node** (fixed precision, $10^{-7}$). If `0`, it represents an **L2 node**.
* **Bits 0-5 (VW Weight)**: For L2 nodes, these bits store the Visvalingam-Whyatt (VW) rank (0-63), defining the importance of a vertex for dynamic simplification.

### 3.2 Benefits
By converting 2D coordinates into a 1D Morton integer, spatial proximity is preserved in numerical order, enabling binary searches for features within a specific area.

---

## 4. Topology Management

GeoPBF supports advanced topological structures through the `analyzeTopology()` process.

* **Arc System**: Instead of storing redundant coordinates for shared boundaries, GeoPBF stores unique "Arcs".
* **Feature Referencing**: Features reference Arcs by their index. A negative index indicates the Arc should be read in reverse order.
* **Purification**: The internal engine detects and resolves segment intersections to ensure mathematical consistency across the dataset.

---

*Document version: April 2026. This specification is governed by the implementation in the `geopbf` library.*