# ortho-globe

The globe's own pages — pages that use `@ortho-earth/globe` with **no region declaration**.
Served at `www.ortho-earth.com/globe/` by this app's own Worker.

| Page | URL | Data |
|---|---|---|
| Globe ⇄ Equal Earth | `/globe/` (`?start=equal` opens on the Equal Earth side) | bucket `GIS/world/` (rules: `@ortho-earth/core/worldcontent`) |
| World earthquakes | `/globe/quakes` | `/quakes/*` (`apps/quakes-mirror`) + USGS FDSN, fetched by the browser |
| Satellites | `/globe/sats` | `/sats/active.csv` (`apps/sats-mirror`), CelesTrak as fallback |

Each page bundles `@ortho-earth/globe` itself. It never loads the Japan SDK (`/japan/lib/`) or the Japan shell (`apps/ortho-japan/app.js`),
so nothing Japan-specific is shipped here. The old URLs `/japan/earth`, `/japan/quakes` and `/japan/sats` are redirected here (301) by the Japan Worker.
See `LAYERS.md` at the repository root ("globe の家").

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
