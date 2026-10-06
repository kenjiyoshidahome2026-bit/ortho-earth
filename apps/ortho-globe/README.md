# ortho-globe

The globe's own pages — pages that use `@ortho-earth/globe` with **no region declaration**.
Served at `www.ortho-earth.com/globe/` by this app's own Worker.

| Page | URL | Data |
|---|---|---|
| Globe ⇄ Equal Earth | `/globe/` (`?start=equal` opens on the Equal Earth side) | bucket `GIS/world/` (rules: `@ortho-earth/core/worldcontent`) |
| World earthquakes | `/globe/quakes` | `/quakes/*` (`apps/quakes-mirror`) + USGS FDSN, fetched by the browser |
| Satellites | `/globe/sats` | `/sats/active.csv` (`apps/sats-mirror`), CelesTrak as fallback |
| Landforms of the World | `/globe/physical` (`?data=URL` swaps the catalogue) | bucket `GIS/world/` (`packages/world` TerrainDB + `ne-physical.geopbf`), Köppen grid, PB2002 plates |
| National Parks of the United States | `/globe/parks` (`?p=<id>` opens a park, e.g. `?p=yellowstone`) | `public/parks-us.json` + `public/parks-us.geopbf` (NPS boundaries, public domain) + `public/nps-units.geopbf`; names from Wikidata, photos from Wikimedia Commons, Wikipedia read by the browser. Built by `scripts/parks-ledger/` — same shape as `/japan/parks` |
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

The earthquake page reads `public/quakes/usgs-quakes-m2.geopbf` in dev (not in git; build it with `scripts/usgs-quakes-build.mjs` at the repository root), or any `?src=URL`.

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
