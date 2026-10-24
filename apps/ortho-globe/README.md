# ortho-globe

The globe's pages — pages that use `@ortho-earth/globe` with **no region declaration** — served at `www.ortho-earth.com/globe/` by this app's Worker.
Since 2026-10-24 every page except the front page is its own app (`apps/<name>/`, with `"servedAt": "/globe/"` in its package.json);
`npm run build` here builds the front page, then `packages/globe/scripts/lib/gather-apps.mjs` builds each of those apps and adds its output, so the URLs stay the same.

| Page | URL | App | Data |
|---|---|---|---|
| Globe ⇄ Equal Earth | `/globe/` (`?start=equal` opens on the Equal Earth side) | this app | bucket `GIS/world/` (rules: `@ortho-earth/core/worldcontent`) |
| Satellites | `/globe/sats` | [`apps/sats`](../sats) | `/sats/active.csv` (`apps/sats-mirror`), CelesTrak as fallback |
| The shortest way is an arc | `/globe/arcs` (`?mode=cmp\|air\|csv` · `?csv=URL`) | [`apps/arcs`](../arcs) | Capitals from the world ledger (`NationDB` + `CityDB`, GitHub Pages `ortho-data/globe/`); airports and routes from OpenFlights (`airports.dat`, `routes.dat`, ODbL, frozen in June 2014) read by the browser from raw.githubusercontent.com and kept in the Cache API; country shapes = NE admin_0 50m (the engine's own geopbf). Arcs, lights and dots are `map.addData` (`arcs` / `trips` / `points`) |
| Landforms of the World | `/globe/physical` (`?data=URL` swaps the catalogue) | [`apps/physical`](../physical) | GitHub Pages `ortho-data/globe/` (`packages/world` TerrainDB + `ne-physical.geopbf`), Köppen grid, PB2002 plates |
| National Parks of the United States | `/globe/parks` (`?p=<id>` opens a park, e.g. `?p=yellowstone`) | [`apps/parks-us`](../parks-us) | `ortho-data/us/parks-us.json` + `ortho-data/us/parks-us.geopbf` (NPS boundaries, public domain) + `ortho-data/us/nps-units.geopbf`; names from Wikidata, photos from Wikimedia Commons, Wikipedia read by the browser. Built by `scripts/parks-ledger/` — same shape as `/japan/parks` |
| World clock | `/globe/clock`（`#…/t=<UTC>` opens at a fixed time） | [`apps/clock`](../clock) | Natural Earth `ne_10m_time_zones` read by the browser from NE's S3 (CORS open) + the globe's admin0 countries; country → IANA names from `clock-zones.json` (IANA `zone.tab`, `npm run clock:zones`); times, daylight saving and zone names from the browser's `Intl`. How a point gets its zone: `clock-zones.ts` (tested by `npm test -w clock`); stage-0 audit of country × NE zone pairs: `scripts/clock-audit.md` |
| World population in hexagons | `/globe/hex` (`?data=URL` swaps the data folder) | [`apps/hex`](../hex) | GitHub Pages `ortho-data/globe/h3/kontur-20231101/` — Kontur Population (CC BY 4.0) as H3 cells, baked by `apps/hex/scripts/kontur-h3.mjs` (format `apps/hex/hex-pop.ts`; the page is its own app `apps/hex`) and published with `npm run publish:pages -w world-data -- --only=h3 --write` |
| Voxels on the globe | `/globe/voxel` (`?v=cloud\|torus\|fuji\|quakes` picks the scene) | [`apps/voxel`](../voxel) | Synthetic grids made in the browser (a noise cloud as a volume, a torus as an isosurface), Mt. Fuji as blocks from `map.sampleTerrain`, and the USGS catalog (`/quakes/archive.geopbf`, `apps/quakes-mirror`) binned into a longitude × latitude × depth density volume under Japan. Drawn by `@ortho-earth/plugin-voxel` (ray marching; WebGPU with the globe's device and depth, WebGL2 fallback); switch volume / blocks / surface, threshold, colormap and slice the grid |
| Gaussian splats on the globe | `/globe/splat` (`?mode=tiles\|file` picks the streaming mode · `?data=URL` swaps the data folder) | [`apps/splat`](../splat) | GitHub Pages `ortho-data/globe/splat/<scene>/` — two Niantic `.spz` sample scenes (MIT) at Tokyo Station's Marunouchi plaza, baked by `apps/splat/scripts/splat-tiles.mjs` into 3D Tiles (`KHR_gaussian_splatting` + SPZ, octree with REPLACE) plus one cleaned `.spz` each, published with `npm run publish:pages -w world-data -- --only=splat --write`. Drawn by `@ortho-earth/plugin-splat` (WebGPU: spherical harmonics, GPU sort, LoD; WebGL2 fallback); drop your own `.ply` / `.splat` / `.spz` / `.ksplat` / `.sog` |
| Clouds | `/globe/clouds` (`?vol=0` flat shell · `?lv=2..5` detail · `?perf=1` GPU time) | [`apps/clouds`](../clouds) | Geostationary infrared read by the browser: NASA GIBS WMTS (Himawari, GOES-West, GOES-East) + EUMETSAT EUMETView WMS (Meteosat 0°, Meteosat IODC) — no mirror |

Each page bundles `@ortho-earth/globe` itself. It never loads the Japan SDK (`/japan/lib/`) or the Japan shell (`apps/ortho-japan/app.js`),
so nothing Japan-specific is shipped here. The old URLs `/japan/earth`, `/japan/quakes` and `/japan/sats` are redirected here (301) by the Japan Worker.
See `LAYERS.md` at the repository root ("globe の家").

Every page is built the same way (the "demo page contract", checked by `npm test -w www` → `tests/t-demo-pages.mjs`):
the English `<head>` carries description, canonical, theme-color and a share card (og:image + twitter:card); the inline script hands
language, boot cover and startup failure to `@ortho-earth/globe/page.js` (`startPage`); the data pages mount `zoom · compass · full · shot · hint`
plus `map.gadget.lang()` (physical and parks keep their own language `<select>` in the panel). See `apps/www/demos-quality.md` for the ledger.

## Develop

```
npm run dev -w ortho-globe          # http://localhost:5186/globe/  (the front page)
npm run dev -w arcs                 # each page app has its own dev port (vite.config.js)
```

World earthquakes (`/globe/quakes/`) moved to its own app, [`apps/quakes`](../quakes), on 2026-10-15.

## UI text

UI strings are English keys. Shared strings live in the globe's main dictionary (`packages/globe/src/i18n/ui.json`); strings used only by one page live in
`i18n/pages/<page>.json` of that page's app. After editing a page dictionary:

```
npm run i18n:build -w <app>         # bake i18n/lang/<page>/<code>.json
npm run verify:i18n -w <app>        # the gate (also run by build and by PR CI)
```

## Deploy

```
npm run deploy -w ortho-globe       # build (i18n gate) → verify:prod (real Chrome on the built files) → wrangler deploy
```

License: GPL-3.0-or-later.
