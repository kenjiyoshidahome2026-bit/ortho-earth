# geopbf.js

**An efficient binary GIS data architecture designed for modern web environments.**

`geopbf.js` is a lightweight, Protocol Buffers (PBF) based data engine. It is designed to complement existing GIS standards like GeoJSON and Shapefiles by providing a high-performance binary alternative that enhances memory efficiency and rendering speed in the browser.

---

## 🟢 Seamless GeoJSON Compatibility

`geopbf.js` is designed with a **"GeoJSON-First"** philosophy. It is upwardly compatible with existing GeoJSON-based ecosystems:

* **Interoperable Data Model**: The internal structure follows the standard Feature/FeatureCollection model, making it familiar to any GIS developer.
* **Simple Transition**: You can load GeoJSON directly and, when needed, output it back via the `.geojson` getter.
* **Plug-and-Play**: It works alongside popular libraries like Leaflet, MapLibre GL JS, and OpenLayers, serving as a high-speed data provider for these existing tools.

---

## ⚡️ Key Technical Advantages

### 1. Memory Efficiency & Performance
While GeoJSON is excellent for readability and ease of use, large datasets can become memory-intensive. `geopbf.js` addresses this by utilizing a binary structure that minimizes the memory footprint and significantly reduces parsing time.

### 2. $O(1)$ Header Updates
The binary architecture allows for instant updates to metadata (Name, Description, License). By manipulating the file header directly, these changes are completed in constant time $O(1)$, ensuring that the data's integrity and indexing remain intact without needing to re-encode the entire dataset.

### 3. Integrated Topology Support
Building on the concepts of TopoJSON, `geopbf.js` includes a topology engine that identifies shared boundaries. This results in even smaller file sizes and ensures topological consistency for complex spatial analysis and visualization.

### 4. Zero-Latency Rendering Pipeline
By streaming binary coordinates directly to Canvas or WebGL contexts, the library avoids the overhead of intermediate object creation. This "Binary-to-Pixel" approach allows for smooth rendering of large-scale datasets while maintaining a responsive UI.

---

## 🚀 API Overview

### `geopbf(input, options)`
The main entry point for synchronizing various GIS formats into the binary hub.
* **Input**: Supports `File`, `Blob`, `ArrayBuffer`, and `Object` (GeoJSON).
* **Automatic Detection**: Handles Shapefiles (.zip), KMZ, GML, and GeoJSON automatically.

```javascript
import { geopbf } from 'geopbf';

// Load and convert to a high-performance binary instance
const pbf = await geopbf(inputData);
```

### Instance Methods (The `PBF` Class)

* **`.geojson` / `.topojson` (Getters)**: Access your data in familiar formats for use with other libraries.
* **`.draw(ctx, options)`**: Render data directly to a canvas context for maximum performance.
* **`.getFeature(i)`**: Access a specific feature without decoding the entire file.
* **`.header(meta)`**: Update metadata instantly via binary slicing.
* **`.shape()` / `.kmz()` / `.gml()`**: Export your data to various standard GIS formats for interoperability.
* **`.save(name)`**: Persist your work as a native `.pbf` file.

---

## 🏗 System Architecture

To ensure a fluid user experience, all intensive decoding and processing are handled by **Web Workers**. This off-main-thread architecture keeps the browser responsive, even when processing hundreds of megabytes of spatial data.

* **Built with Vite 8**: Utilizes modern code splitting to ensure that only the necessary components are loaded when needed.
* **Native Browser APIs**: Built on standard web technologies like `CompressionStream` for maximum compatibility and performance.

---

## 📄 License

```text
/*!
* geopbf.js v1.0.0
* (c) 2026 Kenji Yoshida
* Released under the MIT License.
*/
```