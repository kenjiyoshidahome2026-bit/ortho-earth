> **English** · [日本語](Home-ja)

# Ortho Earth wiki

**maplibre + cesium − mercator = ortho-earth.** A serverless WebGPU / WebGL2 orthographic map engine and GIS workstation, built from scratch with zero runtime dependencies. It runs entirely in the browser: always a globe, no flat Mercator (the flat world map is Equal Earth).

- Site: [www.ortho-earth.com](https://www.ortho-earth.com) · Japan 3D map: [/japan/](https://www.ortho-earth.com/japan/) · World globe: [/globe/](https://www.ortho-earth.com/globe/) · MapLibre gallery: [/maplibre/](https://www.ortho-earth.com/maplibre/) · Cesium Sandcastle: [/sandcastle/](https://www.ortho-earth.com/sandcastle/)
- Quick start: `npm i @ortho-earth/globe`, then `createGlobe({ target: "#map" })`, or keep MapLibre code with `@ortho-earth/globe/maplibre`, or Cesium code with `@ortho-earth/cesium`.

## Pages

| Page | What it covers |
|---|---|
| [Architecture](Architecture) | Layers, the shared engine at `/globe/engine/<version>/`, the page shell, the rules between apps |
| [Apps and URLs](Apps-and-URLs) | Every public page, which `apps/<name>` serves it, and the internal Workers |
| [Packages](Packages) | npm packages and SDKs with their current versions and licences |
| [Deploy and Release](Deploy-and-Release) | Automatic deploy on merge, the gates, npm publish, mirrors, data |
| [Development and Tests](Development-and-Tests) | Setting up, building, the test suites and gates |
| [Security](Security) | Supported versions, how to report a vulnerability, code scanning |
| [Recent Changes](Recent-Changes) | What changed lately (October 2026) |
| [Roadmap](Roadmap) | What comes next after 2.2: measuring, speed-ups, removing duplication |

The source of truth is the repository itself: [README](https://github.com/kenjiyoshidahome2026-bit/ortho-earth#readme), [LAYERS.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/LAYERS.md), [MIGRATION.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/MIGRATION.md), [DATA.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/DATA.md), [SECURITY.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/SECURITY.md). This wiki is an overview; when they differ, the repository wins.

_Last updated: 2026-10-31._
