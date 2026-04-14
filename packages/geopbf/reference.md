# GeoPBF API Reference (v1.0)

`GeoPBF` is a high-performance GIS library for the browser, providing efficient binary storage, spatial analysis, and topological processing.

## Table of Contents
1. [Constructor](#1-constructor)
2. [Data Loading & Output](#2-data-loading--output)
3. [Metadata & Configuration](#3-metadata--configuration)
4. [Geometric Analysis](#4-geometric-analysis)
5. [Data Manipulation](#5-data-manipulation)
6. [Topology & Advanced GIS](#6-topology--advanced-gis)
7. [Static Methods](#7-static-methods)

---

## 1. Constructor

### `new PBF(options)`
Creates a new GeoPBF instance.
* **`options.name`** (String): Dataset name.
* **`options.precision`** (Number): Coordinate precision ($10^n$). Default is `6` ($10^{-6}$ degrees).
* **`options.noprop`** (Boolean): If true, skips property encoding to save space.

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

*Document version: April 2026. This specification is based on the implementation in the `geopbf` library.*