> **English** · [日本語](Packages-ja)

# Packages

Versions as of 2026-10-31 (from each `package.json` on `main`). "private" means the package is not published to npm.

## Engine and shared parts (`packages/*`)

| Package | Version | Licence | What it is |
|---|---|---|---|
| `@ortho-earth/core` | 2.2.0 | GPL-3.0-or-later | Spherical vector-tile rendering, camera, projection, Gint, overlay contract |
| `@ortho-earth/globe` | 2.2.0 | GPL-3.0-or-later | The 3D globe: `createGlobe()`, MapLibre-shaped API, plugins, data layers, analysis |
| `@ortho-earth/tile-formats` | 0.2.0 | GPL-3.0-or-later | On-demand decoders: MLT tiles, LAZ records for COPC |
| `@ortho-earth/h3` | 0.2.0 | GPL-3.0-or-later | H3 cells, binning and `map.addH3()` |
| `@ortho-earth/ephem` | 1.3.0 | GPL-3.0-or-later | Solar-system ephemeris, shared clock, SGP4/SDP4 satellites |
| `geopbf` | 2.1.0 | MIT | GeoPBF container + Gint topology; 18 GIS formats in, 14 out, in the browser |
| `geoedit` | 0.4.0 | MIT | Topological GeoPBF editor on the sphere, as a map gadget |
| `altpbf` | 1.2.0 | MIT | Binary elevation tiles decoded straight into `Int16Array` |
| `native-bucket` | 1.1.0 | MIT | Cloudflare R2 ⇄ browser IndexedDB bridge for heavy binary data |
| `quiet-mono` | 1.0.1 | GPL-3.0-or-later | Design kit (tokens and UI parts) shared by the apps |
| `@ortho-earth/jp` | 0.0.1 (private) | GPL-3.0-or-later | Japan region pack |
| `@ortho-earth/nl` | 0.0.1 (private) | GPL-3.0-or-later | Netherlands region pack |
| `@ortho-earth/regions` | 0.0.1 (private) | GPL-3.0-or-later | Region switch (`orthoJapan`) |
| `@ortho-earth/equal` | 0.0.1 (private) | GPL-3.0-or-later | Equal Earth world map parts (`createEqual`) |
| `common` | 1.0.0 (private) | MIT | Small shared helpers |
| `world-data` | 2.0.0 (private) | CC BY-SA 4.0 (data) | 262 countries and territories, ~900 landforms, sky names, 26 languages |

## SDKs and tools (`sdk/*`)

| Package | Version | Licence | What it is |
|---|---|---|---|
| `@ortho-earth/japan` | 2.0.2 | GPL-3.0-or-later | Self-contained Japan globe for any page (engine + Japan pack) |
| `@ortho-earth/cesium` | 0.1.0 | GPL-3.0-or-later | The CesiumJS API on ortho-earth: `import * as Cesium from "@ortho-earth/cesium"` |
| `@ortho-earth/react` | 0.1.0 | GPL-3.0-or-later | React bindings: `<Globe>`, `<Source>`, `<Layer>`, `useGlobe`… |
| `@ortho-earth/gmaps` | 0.2.0 | GPL-3.0-or-later | A `google.maps` namespace on MapLibre or the globe |
| `@ortho-earth/leaflet` | 0.1.0 | GPL-3.0-or-later | A Leaflet `L` namespace on MapLibre or the globe |
| `@ortho-earth/google3d` | 0.2.0 | GPL-3.0-or-later | Google Photorealistic 3D Tiles: key, session, attribution |
| `@ortho-earth/ktx2` | 0.1.0 | GPL-3.0-or-later | KTX2 / Basis Universal transcoder |
| `@ortho-earth/scene` | 0.2.0 | GPL-3.0-or-later | Instanced meshes, billboards and 3D text as `map.addData` kinds |
| `@ortho-earth/splat` | 0.6.0 | GPL-3.0-or-later | Gaussian splats (`.ply` `.splat` `.spz` `.ksplat` `.sog`, 3D Tiles) |
| `@ortho-earth/voxel` | 0.6.0 | GPL-3.0-or-later | Voxel grids: volume, blocks or isosurface |
| `glbconv` | 0.2.0 | MIT | GLB to other 3D formats, browser and Node |

## Packages owned by one app

| Package | Version | Licence | Where |
|---|---|---|---|
| `himekuri` | 2.0.0 | MIT | `apps/himekuri/lib` (tear-off calendar and world-clock SVG widgets) |
| `ortho-world` | 1.0.0 | MIT | `apps/world` (a country selector for any `<div>`) |

## Mirrors

`geopbf`, `altpbf`, `geoedit`, `native-bucket`, `ortho-world` and `himekuri` are also copied to standalone read-only repositories on each release (workflow `mirror`).

## Upgrading

2.0 removed the aliases and internal paths kept in 1.x. [MIGRATION.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/MIGRATION.md) lists every change, old → new.
