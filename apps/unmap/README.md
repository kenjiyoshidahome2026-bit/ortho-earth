# unmap

UNMAP offline viewer — **experimental, for UN staff only; not served publicly** (no `servedAt`, so `apps/globe-host` does not gather it).
The goal is a globe that works fully offline on a smartphone: the user picks rectangles on the Equal Earth map, and the device extracts that area from a planet PMTiles archive into its own storage (OPFS).
Until UNMAP itself is available, the prototype uses an OSM-derived planet archive.

## M1 (this app now)

The globe with an OSM planet PMTiles basemap and Smart Maps GEL terrain, both read online with HTTP Range requests.

| Data | Default URL | Notes |
|---|---|---|
| OSM planet | `https://data.source.coop/protomaps/openstreetmap/v4.pmtiles` | Protomaps basemaps v4 (OSM + Natural Earth), z0–15, ~126 GB, ODbL. The publisher asks not to hotlink: copy it to UN storage before staff use it. |
| GEL terrain | `https://data.source.coop/smartmaps/gel/gel.pmtiles` | Smart Maps Global Elevation Tiles, CC0, ~183 GB, WebP, Mapbox pixel packing. z2–5 Global Map (85°N–85°S), z6–12 NASADEM (~30 m, 60°N–56°S). |

URL parameters:

- `?osm=<url>` and `?gel=<url>` point at other copies of the archives (https, or http on localhost / the same origin).
- `?names=local|en|fr|es|ru|zh|ar` sets the language of place names (the UN official languages, or local names). Without it, the app uses the last choice from the picker at the bottom left, then the UI language if it is one of the six, then local names. A name missing in the chosen language falls back to the local name.
- `?status=0` hides the check card. The card reads the first 127 bytes of each archive with a Range request and shows whether Range and CORS work and what the header declares, plus the renderer (WebGPU or WebGL2). This is the M0 check, run on the device itself.
- `?gl2=1` forces WebGL2; `?debug=1` exposes the engine's debug globals.

The terrain is read through the engine's raster-dem path with `tiles: ["pmtiles://<url>"]` (`packages/ortho-core/src/dem-src.ts`).

```
npm run dev -w unmap        # http://localhost:5230/unmap/ (also on the LAN for a phone)
npm run build -w unmap      # dist/site/unmap/ (the engine is bundled in, not the shared /globe/engine/)
npm test -w unmap
```

## M2: files on the device

The status card has an **Offline data** section. **＋ Add .pmtiles** copies a PMTiles v3 file into the browser's private storage (OPFS): vector archives go to `unmap/map/`, raster archives (terrain) to `unmap/terrain/`, decided by the header's tile type. The page then reloads and reads:

- map: the device's files first, then the online OSM planet last, combined into one source (`pmtiles://composite:…` in `packages/ortho-core/src/pmtiles-src.ts`). For each tile the first archive that covers it and has it wins. An archive that can't be read (no network, deleted file) is skipped, so the device's files still draw offline.
- terrain: the same, with GEL last.

`?online=0` leaves the online archives out, to check what the device alone shows. The card also lists the stored files (🗑 deletes one) and the storage used.

Checked in headless Chromium: two files imported through the button, the browser switched offline, and the map still drew place names from the device's file and read the terrain height (5999.8 m at the synthetic peak).

## M3: save an area for offline use

- **📍 Save my area** (button at the bottom, also in the Data card) asks for the device location and opens an Equal Earth map with a 3×3 block of zoom-8 tiles (about 450 km square) centred on it. Without location permission it asks you to tap the map instead (no IP lookup). **Choose area on map** starts from the globe's current view.
- Drag inside the box to move it, drag the round handles (corners and edges) to resize it, tap outside it to move it there. Edges always snap to zoom-8 tiles; up to 24×24 tiles.
- The sheet shows the exact size before saving: it reads the planet's and GEL's directories by HTTP Range (only the parts that cover the box) and adds up the tile bytes, next to the free space on the device. Defaults: map up to z14, terrain up to z10; if map + terrain would pass 1 GB for one area, the map detail is lowered until it fits.
- Saving runs in a worker: tiles that sit close together in the planet are fetched in one Range request, written to `unmap/map/area-<id>.pmtiles.part` (and `unmap/terrain/…`) with a SyncAccessHandle, then the new archive's directory is read back and checked before the file gets its final name. Progress is kept in `<name>.json`, so a save that stops (network, closed tab, **Stop**) resumes from the Data card. An area crossing the antimeridian is saved as two files (`-w` / `-e`).
- The first save also stores a world overview (`world.pmtiles`, planet z0–5), so the globe is not blank outside your areas when offline.
- Saved areas show as green boxes in the area map. Extraction code lives in core: `@ortho-earth/core/pmtiles-extract`.

## M4: the app itself works without a connection

- **App on the device**: the page registers the shared service worker (`public/sw.js` → `packages/globe/scripts/lib/sw.js`) and, on a start with a connection, copies every file of this build (listed in `offline.json`, written by `vite.config.js`; about 7.6 MB, the engine is bundled) into Cache `oj-pack-unmap`. With no connection the service worker serves the page and its files from there, also when the URL carries `?osm=…` or `#z/lat/lon`. A new deploy (different `build`) is re-copied quietly on the next online start. The Data card shows "App offline: saved · <build>". Needs https (or localhost); `?nosw=1` skips it.
- **Add to Home Screen**: `manifest.webmanifest` + icons (standalone, scope `/unmap/`). On iPhone this also keeps Safari from clearing the saved data after 7 days without use.
- **Place search without a connection**: after saving, a worker reads the saved map files' `places` layer (areas at z12, the world overview at z5) and writes `unmap/places/<file>.json`. The search box at the top looks only in those indexes (prefix matches first, then word and substring matches; countries, regions and towns ranked by population), shows the name in the chosen place-name language, and flies there. Areas saved before M4 get their index on the next start.
- **No false "check your connection" message**: the engine now hides its network toast as soon as a tile loads, also when the browser is offline (the tile came from the device).
- The engine's own world elevation (api.ortho-earth.com) is not needed for relief: GEL from the device draws it offline.

Checked in headless Chromium (production build, local Range server, synthetic data): save the area around a set location → browser switched fully offline → page reloaded from the service worker → search "tok" → Tokyo → flew there, map drawn from the device, no network toast.

## M5: fit to a country, and keep every area on the same data version

- **Fit to a country**: in the area picker, tap a country. A "Fit to <country>" button appears; it sets the box to that country's bounding box (from the world search index), snapped to z8 tiles. A country bigger than one area (24×24 z8 tiles) is cut to 24×24 around where you tapped, with a note; drag the handles to trim, and save the rest as another area. Needs a connection (like saving).
- **Version stamp**: every saved file records in its PMTiles metadata (`unmap`) the source URL, the exact z8 box (`part`), the zooms and a version stamp of the source (`archiveVersion` in `@ortho-earth/core/pmtiles-extract`, made from the source header's sizes, so it does not depend on the host or ETag).
- **Update all saved areas**: on an online start the app compares the stamps with the current planet and GEL. If a source changed, the Data card says "Newer map data is available for N saved files" with an **Update all** button. It re-cuts every outdated file (and the world overview) with the same box and zooms, rebuilds their place-name index, and reloads. All areas then come from one version, so roads meet at the edges. Areas saved before M5 (no stamp) are included when any stamped file is outdated. The update resumes from the Data card if it stops.

Checked in headless Chromium (dev server, local Range server, synthetic data): save the area around Tokyo → reopen with the same planet (no prompt) → reopen with a changed planet → "Newer map data is available for 2 saved files" → Update all → both map files carry the new stamp, terrain unchanged, the new place appears in search, no prompt after reload. The country button was not checked in the browser here, because the test machine cannot reach the world data; its box logic is covered by `tests/t-versions.mjs`.

## M6: field-test fixes

- **No data is grey, not sea**: the style's background is now a neutral grey. Sea comes from the `water` layer (Protomaps v4 draws the ocean as water polygons). Offline, outside the saved areas above z5, the map used to look like open sea; now it reads as "no data here". Found on a Galaxy Tab A11+ (Android 16, Chrome 157), 2026-11-14.

- **Standard globe at low zoom**: below MapLibre z5.5 the app shows the engine's standard earth (relief tint, Natural Earth borders and lakes, coastline, night side, star sky) through the new globe option `worldBelow` (a style map keeps the engine's world band below that zoom). OSM starts at z5.5 (`OSM_MINZOOM` in `style.ts`). The engine keeps that world data in IndexedDB after the first online start; the star sky files are added to the app pack (`packWorld` in `app-pack.ts`).
- **Coarse map outside saved areas**: core's composite PMTiles now overzooms. When no member has a tile, it stretches the nearest ancestor (`overzoomTile` in `@ortho-earth/core`), as MapLibre does past maxzoom. Offline, outside saved areas you see the world overview (z5) stretched; above an area's top zoom (z14), its z14 tiles are stretched.
- **Lighter on low-memory devices**: on devices that report 4 GB of memory or less, the app renders at 1.25× instead of the full screen density. `?dpr=<n>` overrides.
- The star-sky clock moved below the search box.

## Not yet (later milestones)

- Field tests on real phones and laptops, minimum device spec, and the user guide (M6).
