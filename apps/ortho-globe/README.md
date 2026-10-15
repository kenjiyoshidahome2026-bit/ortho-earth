# ortho-globe

The globe's own pages — pages that use `@ortho-earth/globe` with **no region declaration**.
Served at `www.ortho-earth.com/globe/` by this app's own Worker.

| Page | URL | Data |
|---|---|---|
| Globe ⇄ Equal Earth | `/globe/` (`?start=equal` opens on the Equal Earth side) | bucket `GIS/world/` (rules: `@ortho-earth/core/worldcontent`) |
| Satellites | `/globe/sats` | `/sats/active.csv` (`apps/sats-mirror`), CelesTrak as fallback |
| The shortest way is an arc | `/globe/arcs` (`?mode=cmp\|air\|csv` · `?csv=URL`) | Capitals from the world ledger (`NationDB` + `CityDB`, GitHub Pages `ortho-data/globe/`); airports and routes from OpenFlights (`airports.dat`, `routes.dat`, ODbL, frozen in June 2014) read by the browser from raw.githubusercontent.com and kept in the Cache API; country shapes = NE admin_0 50m (the engine's own geopbf). Arcs, lights and dots are `map.addData` (`arcs` / `trips` / `points`) |
| Landforms of the World | `/globe/physical` (`?data=URL` swaps the catalogue) | GitHub Pages `ortho-data/globe/` (`packages/world` TerrainDB + `ne-physical.geopbf`), Köppen grid, PB2002 plates |
| National Parks of the United States | `/globe/parks` (`?p=<id>` opens a park, e.g. `?p=yellowstone`) | `ortho-data/us/parks-us.json` + `ortho-data/us/parks-us.geopbf` (NPS boundaries, public domain) + `ortho-data/us/nps-units.geopbf`; names from Wikidata, photos from Wikimedia Commons, Wikipedia read by the browser. Built by `scripts/parks-ledger/` — same shape as `/japan/parks` |
| World clock | `/globe/clock`（`#…/t=<UTC>` opens at a fixed time） | Natural Earth `ne_10m_time_zones` read by the browser from NE's S3 (CORS open) + the globe's admin0 countries; country → IANA names from `clock-zones.json` (IANA `zone.tab`, `npm run clock:zones`); times, daylight saving and zone names from the browser's `Intl`. How a point gets its zone: `clock-zones.js` (tested by `npm test -w ortho-globe`); stage-0 audit of country × NE zone pairs: `scripts/clock-audit.md` |
| World population in hexagons | `/globe/hex` (`?data=URL` swaps the data folder) | GitHub Pages `ortho-data/globe/h3/kontur-20231101/` — Kontur Population (CC BY 4.0) as H3 cells, baked by `scripts/kontur-h3.mjs` (format `hex-pop.js`) and published with `npm run publish:pages -w world-data -- --only=h3 --write` |
| Clouds | `/globe/clouds` (`?vol=0` flat shell · `?lv=2..5` detail · `?perf=1` GPU time) | Geostationary infrared read by the browser: NASA GIBS WMTS (Himawari, GOES-West, GOES-East) + EUMETSAT EUMETView WMS (Meteosat 0°, Meteosat IODC) — no mirror |

Each page bundles `@ortho-earth/globe` itself. It never loads the Japan SDK (`/japan/lib/`) or the Japan shell (`apps/ortho-japan/app.js`),
so nothing Japan-specific is shipped here. The old URLs `/japan/earth`, `/japan/quakes` and `/japan/sats` are redirected here (301) by the Japan Worker.
See `LAYERS.md` at the repository root ("globe の家").

Every page is built the same way (the "demo page contract", checked by `npm test -w www` → `tests/t-demo-pages.mjs`):
the English `<head>` carries description, canonical, theme-color and a share card (og:image + twitter:card); the inline script hands
language, boot cover and startup failure to `@ortho-earth/globe/page.js` (`startPage`); the data pages mount `zoom · compass · full · shot · hint`
plus `map.gadget.lang()` (physical and parks keep their own language `<select>` in the panel). See `apps/www/demos-quality.md` for the ledger.

## Develop

```
npm run dev -w ortho-globe          # http://localhost:5186/globe/
```

World earthquakes (`/globe/quakes/`) moved to its own app, [`apps/quakes`](../quakes), on 2026-10-15.

## UI text

UI strings are English keys. Shared strings live in the globe's main dictionary (`packages/globe/src/i18n/ui.json`); strings used only by one page live in
`i18n/pages/<page>.json`. After editing a page dictionary:

```
npm run i18n:build -w ortho-globe   # bake i18n/lang/<page>/<code>.json
npm run verify:i18n -w ortho-globe  # the gate (also run by build)
```

## Deploy

```
npm run deploy -w ortho-globe       # build (i18n gate) → verify:prod (real Chrome on the built files) → wrangler deploy
```

License: GPL-3.0-or-later.
