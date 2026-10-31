> **English** · [日本語](Architecture-ja)

# Architecture

The repository is one npm workspace: `packages/*` (engine and shared parts), `sdk/*` (SDKs and tools for outside users) and `apps/*` (pages and Workers). The authoritative rules are in [LAYERS.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/LAYERS.md).

## Layers: parts → base → engine → apps

Parts are hard at the top (gates, types, versions) and soft at the bottom (apps may change freely).

![ortho-earth layers: base, engine, plugins and apps, with gzip sizes](images/layers.svg)

_Dependency map as of 2026-10-24 (arrows point from provider to user; sizes are gzip). The 2.2 SDKs `cesium`, `leaflet` and `gmaps` came after it._

| Layer | Where | What |
|---|---|---|
| base | `packages/geopbf`, `packages/ortho-core` (`@ortho-earth/core`) | Data container and topology (GeoPBF, Gint); rendering, camera, projection. Knows no region |
| engine | `packages/globe` (`@ortho-earth/globe`) with `common`, `world-data`, `equal`, `regions` | The globe host: boot, world layers, region-independent gadgets, the MapLibre face, plugins, SDK types, gates |
| region packs | `packages/jp`, `packages/nl` | A region's declaration (terrain, buildings, basemap, rasters, search, POI, rail). `jp` and `nl` do not know each other; only `regions` (the switch, `orthoJapan`) knows both |
| apps | `apps/*` | Shells over the layers above |
| SDKs | `sdk/*` | Published for outside users (`@ortho-earth/japan`, `cesium`, `react`, `gmaps`, `leaflet`, `google3d`, `ktx2`, `scene`, `splat`, `voxel`, `glbconv`) |

Region names never appear in core or globe code: the `verify:regionless` gate counts them and fails if they grow. The globe covers the world up to about z8; past that, a region pack takes over (Japan from z≥6.5: GSI vector tiles, DEM, PLATEAU buildings, POI, search).

## The shared engine

`@ortho-earth/globe` and every module that two or more apps use are built once by `apps/engine` and served by the Worker `ortho-engine` at

```
https://www.ortho-earth.com/globe/engine/<version>/
```

- `<version>` is a content hash of the build, so the URL is immutable and the browser cache is shared across all apps.
- `current.json` lists the current version and its `imports` (entry name → file). The entry list is `apps/engine/src/entries.mjs`.
- Each app's build calls `sharedEngine()` (`packages/globe/scripts/lib/shared-engine.mjs`), which marks those imports external and points them at the live engine URL. In dev the sources are used directly.
- An app built against an older version keeps working: old entry points are redirected (302) to the current version by the Worker.
- Japan apps are two-stage: the shared engine (region-free) plus `regions/app.js` (`orthoJapan`) and the `jp/*` or `nl/*` entries, which are also served from the engine URL.

## Page shell and hosts

Since the app restructure (2026-10-24), each page is its own `apps/<name>/` with `"servedAt": "/globe/"` or `"/japan/"` in its `package.json`. The page code starts through the shared shell `@ortho-earth/globe/page.js` (`startPage`). Two host Workers collect and serve them:

- `apps/globe-host` (Worker `ortho-globe`) serves every app with `servedAt: "/globe/"`.
- `apps/japan-host` (Worker `ortho-japan`) serves every app with `servedAt: "/japan/"`.

Public URLs did not change with the restructure.

## Rules between apps

1. **Apps do not read other apps.** Code used by two or more apps lives in `packages/*` and is loaded at run time from the shared engine URL, not baked into each app. Code only one app uses stays in that app. The only exception is `apps/www`, which collects other apps' outputs and docs for the site. The gate `npm run verify:app-imports` enforces this.
2. **No duplicate libraries.** An app that loads the shared engine must not bundle its own copy of a library the engine exports (a d3 copy mismatch once broke gishub-jp).
3. **Consumers use the public surface** (`globe.d.ts`) only; internal hooks such as `dbgHost` or `__*` are off-limits to apps.
4. **Changes to core/globe need gates + types + version**; apps only need their own `verify:prod`.

## Data

- Bulk data (`world`, `space`, GeoPBF archives) lives in a Cloudflare R2 bucket and is uploaded only through `apps/uploader`. The bucket is kept lean.
- Demo data is published to GitHub Pages from `ortho-data/` (workflow `pages`).
- See [DATA.md](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/DATA.md) for sources and licences.
