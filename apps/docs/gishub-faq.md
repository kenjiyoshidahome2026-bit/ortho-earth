# GIS-HUB — Frequently Asked Questions

## General

**Q: What is GIS-HUB?**
A browser-based GIS workstation — no install, no server, no account required. Load any geospatial file, explore it in a WebGL2 3D globe, and export to multiple formats, all from your browser.

**Q: Does GIS-HUB send my data to a server?**
Files you drag-and-drop or select locally are processed entirely in your browser using WebAssembly and JavaScript — they never leave your machine. Catalog datasets are fetched directly from their original public sources (Natural Earth, US Census Bureau, Japan MLIT, etc.).

**Q: What browsers are supported?**
Any modern browser with WebGL2 support: Chrome, Edge, Firefox, and Safari 16+. Browsers with hardware-accelerated graphics disabled may not work correctly.

---

## File Formats

**Q: What formats can I load?**
Shapefile (ZIP), GeoJSON, FlatGeobuf (.fgb), GML, KMZ/KML, GPX, and GeoPBF. You can also paste a direct HTTPS URL, or use `https://…/archive.zip#inner-file.geojson` syntax to target a specific file inside a remote ZIP archive.

**Q: What formats can I export to?**
GeoPBF, GeoJSON, TopoJSON, FlatGeobuf, Shapefile, GML, KMZ/KML, and GPX. All formats are available from the DOWNLOAD panel after a dataset is loaded.

**Q: Can I export to CSV or Excel?**
Yes. Open the **Show Property Table** view after loading a dataset, then download the attribute table as CSV or Excel (.xlsx).

---

## Performance & Caching

**Q: Why is "US ZIP Code Tabulation Areas" marked "only for high-spec PC"?**
This dataset contains approximately 33,000 polygons with complex geometry. Processing it requires significant RAM (4 GB+ recommended). On lower-end devices it may run slowly or stall.

**Q: Why is loading so much faster the second time?**
After the first load, GIS-HUB caches the decoded GeoPBF to IndexedDB in your browser. Subsequent visits skip the fetch-and-decode step entirely and load from local storage.

**Q: Is there a file size limit?**
No hard limit is enforced, but all processing happens in memory, so practical limits depend on your device's available RAM. Files up to a few hundred MB typically work fine on modern hardware.

---

## Ortho-Map (3D View)

**Q: What is "View in Ortho-Map"?**
Ortho-Map is a WebGL2 3D globe renderer built into GIS-HUB. It renders your data with dynamic Level-of-Detail (LOD) — geometry is simplified at small scales and refined as you zoom in — enabling smooth navigation from global to street level at 60 fps.

**Q: How do I view feature attributes?**
Hover over a feature to see a tooltip with its properties. Click for a persistent popup that stays visible while you continue navigating.

---

## Data & Licensing

**Q: Can I use Catalog datasets in my own projects?**
All Catalog datasets are open data. Most Natural Earth and US Census Bureau datasets are **Public Domain**. Japan MLIT / MOJ datasets are licensed under **CC BY 4.0** (attribution required). Always check the license badge on each catalog card and follow the link to the original source for full terms.

**Q: Can I load data sources that aren't in the Catalog?**
Yes. Paste any publicly accessible HTTPS URL into the input box — no catalog entry needed. The `zip-url#inner-filename` syntax also works for targeting files inside remote ZIPs.

---

## GeoPBF

**Q: What is GeoPBF?**
GIS-HUB's internal binary format (Protocol Buffers + spatial index). It stores geometry and attributes in a compact, indexed form that supports spatial queries without decoding the entire file. Download your loaded data as `.gpbf` to reload it instantly on your next visit — no re-fetch, no re-decode.

**Q: Why does GIS-HUB use GeoPBF internally instead of GeoJSON?**
GeoJSON is a text format — verbose, slow to parse, and blocks the main thread at scale. GeoPBF is roughly 1/10th the size, binary-decoded off the main thread via Web Workers, and natively supports spatial indexing for fast identify and LOD queries. See the [GeoPBF Technical Overview](geopbf.html) for details.

---

## Technical

**Q: Does GIS-HUB support Web Mercator (EPSG:3857)?**
Shapefiles that include a `.prj` file declaring EPSG:3857 are **automatically reprojected to WGS84** on load — no manual conversion needed. For other projected coordinate systems (JGD2011, UTM, etc.), a warning is displayed; pre-convert to WGS84 (EPSG:4326) using GDAL or QGIS before loading. The Ortho-Map viewer uses orthographic projection (3D globe) only; flat Web Mercator tile maps are not supported as a display mode.

**Q: Is there a command-line tool (CLI) for batch conversion?**
Not yet. GIS-HUB currently runs as a browser-only application. The conversion engine is architected with Node.js compatibility in mind, and a CLI tool is planned for a future release. In the meantime, [GDAL (ogr2ogr)](https://gdal.org/) is a well-supported open-source option for batch format conversion.
