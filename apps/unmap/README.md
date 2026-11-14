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

## Not yet (later milestones)

- Rectangle selection and extraction from the planet into OPFS (M3), app shell offline via the service worker (M4), hosting behind UN authentication (M5).
- A small world base archive (low zooms) so the globe is not blank outside the device's rectangles when offline (M3).
- The engine shows "Failed to load map data" whenever the browser is offline, even when the device's files cover the view (M4).
- Offline still depends on engine data fetched from the network: the default world elevation (GEBCO / AW3D30 index), and Natural Earth admin0. These have to be bundled or switched off before the app works fully offline.

License: GPL-3.0-or-later.
