# Changelog

Release notes for the Ortho Earth npm packages. Each release also has a longer article on
ortho-earth.com and an entry on [GitHub Releases](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/releases).

## 2.2.0 — 2026-10-31

**@ortho-earth/globe 2.2.0 · @ortho-earth/core 2.2.0**. New packages: **@ortho-earth/cesium 0.1.0**,
**@ortho-earth/leaflet 0.1.0** and **@ortho-earth/gmaps 0.2.0**.

```
npm i @ortho-earth/globe@2.2
```

Release article: [English](https://www.ortho-earth.com/docs/release-2-2) · [日本語](https://www.ortho-earth.com/docs/release-2-2-jp) ·
[GitHub Release](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/releases/tag/v2.2.0)

- **CesiumJS code on the globe.** `import * as Cesium from "@ortho-earth/cesium"` gives CesiumJS 1.146's names.
  Everything that does not draw is Cesium's own code, and the drawing is the Ortho Earth globe. Across Cesium's
  297 scored Sandcastle examples (309 in all): same picture 23 → 190, same answers 120 → 107, runs-only 129 → 0,
  does-not-run 24 → 0. Every pair side by side: https://www.ortho-earth.com/sandcastle/
- **The engine learned it too**, all usable from the plain globe API: model lighting (sun, HDR, image-based light),
  shadows, clearcoat and KTX2; bloom, silhouettes, depth of field, lens flare and your own GLSL post stages;
  particles, clouds, clustering; terrain materials, ocean depths, a translucent globe and an underground camera;
  3D Tiles clipping by planes and polygons, imagery draped on 3D Tiles, I3S, point clouds, voxels, Gaussian splats,
  and custom shaders (GLSL on WebGL2, translated to WGSL on WebGPU).
- **Leaflet and Google Maps code, too.** `@ortho-earth/leaflet` (an `L` like Leaflet 1.9) and `@ortho-earth/gmaps`
  (`google.maps`; no Google key for the map, and with your key Geocoder, Directions, Places and Street View are
  relayed to Google). Guides: [From Leaflet](https://www.ortho-earth.com/docs/from-leaflet) ·
  [From Google Maps](https://www.ortho-earth.com/docs/from-google-maps)
- **Same API as 2.1.** Everything is additive; code written for 2.1 runs as is.

## 2.1.0 — 2026-10-23

**@ortho-earth/globe 2.1.0 · @ortho-earth/core 2.1.0** (also @ortho-earth/plugin-splat 0.5.0)

Release article: [English](https://www.ortho-earth.com/docs/release-2-1) · [日本語](https://www.ortho-earth.com/docs/release-2-1-jp) ·
[GitHub Release](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/releases/tag/v2.1.0)

- **Map text on the GPU.** Labels, road names, icons, shields, geojson symbol layers, cluster counts and star names
  are drawn from an SDF glyph atlas with WebGPU (default where WebGPU is available; Canvas2D on WebGL2; `?text=2d`
  forces the old path). Heaviest text scene ~20% faster; pixel difference vs. Canvas2D under 1%. Cluster circles,
  screen grid, CZML/GPX tracks, `line-gradient` and `line-pattern` also moved to the GPU.
- **MapLibre compatibility.** Across MapLibre's 137 scored official examples: same picture 66 → 79, same answers
  50 → 47, runs-only 21 → 11, does-not-run 0. Results: https://www.ortho-earth.com/maplibre/
- **Same API as 2.0**, with one rename: `map.gadget.cluster` layer ids changed from `clusters` / `unclustered-point`
  to `gadget-cluster-clusters` / `gadget-cluster-unclustered`.

## Earlier

See [GitHub Releases](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/releases) and
[MIGRATION.md](MIGRATION.md) for 2.0.
