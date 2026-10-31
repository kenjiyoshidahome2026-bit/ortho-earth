> **English** · [日本語](Recent-Changes-ja)

# Recent Changes (October 2026)

Newest first. Numbers are pull requests.

## 2026-10-31

- **Security:** 26 CodeQL alerts triaged (7 fixed, #821); `npm audit` 4 moderate → 0 by overriding `c8`'s `glob`/`minimatch` (#822).
- **Globe:** world rivers and maritime boundaries stop at z9 like the coastline (#823).
- **Less duplication:** one shared i18n gate for the shell apps (#813); one GL program builder for the GL overlays (#814); gishub-jp's copied census drill-down removed in favour of `/japan/census2020/` (#816).
- **Performance:** per-frame work cached in the Cesium layer and 3D Tiles selection, `?perf=1` timers (#815). Measured on the Mac: CPU per frame is already about 1 ms or less; the rest is GPU.
- **Decision:** WebGL2 stays supported through 2.x (#817).
- **Docs:** 2.2 release notes and Stories, the Sandcastle gallery, Leaflet and Google Maps guides (#809–#812).

## Release 2.2.0 (late October)

- `@ortho-earth/core` and `@ortho-earth/globe` 2.2.0.
- New **`@ortho-earth/cesium`** 0.1.0: the CesiumJS API on ortho-earth; Cesium's non-drawing code is used unchanged and only drawing is replaced. A Cesium Sandcastle gallery runs at [/sandcastle/](https://www.ortho-earth.com/sandcastle/).
- New `@ortho-earth/leaflet` and `@ortho-earth/gmaps` faces; `scene` 0.2.0, `splat` 0.6.0, `voxel` 0.6.0, `google3d` 0.2.0.
- Rendering added for Cesium parity: CustomShader on models and 3D Tiles (GLSL and WGSL), imagery draped on 3D Tiles, clipping polygons, tileset outlines, point-cloud classification, specular IBL, lens flare, depth of field, bloom, seafloor (bathymetry) mode, terrain providers, `sampleHeight` on 3D Tiles.

## Mid to late October

- **App restructure (2026-10-24):** every page is its own `apps/<name>` with `servedAt`, started by `@ortho-earth/globe/page.js`; hosts `globe-host` and `japan-host`. URLs unchanged.
- **Automatic deploy (2026-10-23):** merges to `main` deploy through the Mac runner; see [Deploy and Release](Deploy-and-Release).
- **Security hardening (2026-10-24):** response headers, `security.txt`, Dependabot with cooldown, old Pages project removed.
- **Apps:** Yokohama digital twin (`/yokohama/`), scenes editor with MP4 export (`/japan/scene`), Tellus viewer with highlights and before/after swipe (`/japan/tellus`), voxels and splats on the globe, point clouds, onsen, clouds.
- **Fixes:** WebGPU sun-uniform layout (#719), WebGPU depth/clip on the globe (#737), d3 copies and Shift_JIS ZIP names in gishub-jp (#688, #691, #692, #707).

For the full history see the [commits on main](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/commits/main) and the [closed pull requests](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/pulls?q=is%3Apr+is%3Amerged).
