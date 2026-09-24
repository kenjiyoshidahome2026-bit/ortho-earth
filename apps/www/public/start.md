# Build with Ortho Earth

A step-by-step recipe for putting the Ortho Earth globe in your own web page — written for people and for AI coding agents alike.
Every step below is checked by an automated test that installs the published npm packages into an empty project and runs them.

- No API key, no account, no server of your own. Public data is fetched by the visitor's browser and cached there.
- The globe draws with WebGPU and falls back to WebGL2 automatically.
- License: the engine is GPL-3.0-or-later (a commercial license is available: kenji.yoshida.home.2026@gmail.com). The data format `geopbf` is MIT.

There are two routes. Pick one.

| Route | Use it when | Package |
|---|---|---|
| **A. With Vite** (recommended) | You write JavaScript in a project with `npm` | `@ortho-earth/globe` — the whole world, extend with your data |
| **B. Without a bundler** | You only want to drop a map into an existing HTML page | `@ortho-earth/japan` — a prebuilt bundle with the Japan pack (GSI basemap, PLATEAU 3D buildings) |

---

## Route A — with Vite

Requirements: Node.js 20 or newer.

### A1. Create a project

```bash
npm create vite@latest my-globe -- --template vanilla --no-interactive
cd my-globe
npm install
npm install @ortho-earth/globe
```

### A2. Tell Vite about the package's workers

Create `vite.config.js` in the project root:

```js
export default {
  optimizeDeps: { exclude: ["@ortho-earth/globe", "@ortho-earth/core"] },
  worker: { format: "es" },
};
```

The globe runs its drawing in Web Workers that live inside the package. Vite's dependency pre-bundling would move them away from their files, so these two packages must be excluded from it. Without this file `npm run dev` fails with "Could not load …?url".

### A3. Replace `index.html` and `src/main.js`

`index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>My globe</title>
    <link rel="icon" href="data:,">
    <style>html, body { margin: 0; height: 100%; } #map { height: 100vh; }</style>
  </head>
  <body>
    <div id="map"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

`src/main.js` (the template's `src/counter.js`, `src/style.css` and `src/assets/` are no longer used — delete them if you like):

```js
import { createGlobe } from "@ortho-earth/globe";

const map = await createGlobe({ target: "#map", view: "#3/20/140" });   // "#zoom/lat/lon"
```

### A4. Run it

```bash
npm run dev
```

Open the address it prints. You should see the Earth with the night side, stars at low zoom, and country borders.
`npm run build` writes a static site to `dist/` that you can host anywhere (it needs no special server headers).

### A5. Add your own data

The layer API follows MapLibre GL JS.

```js
map.addSource("cities", {
  type: "geojson",
  data: {
    type: "FeatureCollection",
    features: [
      { type: "Feature", properties: { name: "Tokyo" }, geometry: { type: "Point", coordinates: [139.77, 35.68] } },
      { type: "Feature", properties: { name: "Seoul" }, geometry: { type: "Point", coordinates: [126.98, 37.57] } },
    ],
  },
});
await map.addLayer({ id: "cities", type: "circle", source: "cities",
  paint: { "circle-radius": 6, "circle-color": "#e4572e" } });
```

`data` can also be a URL of a GeoJSON file. Layer types: `fill`, `line`, `circle`, `symbol`, `fill-extrusion`, `heatmap`, `raster`.
Other formats (Shapefile, GeoPackage, FlatGeobuf, GeoParquet, KML, GPX …) are read with `geopbf` — `import { geopbf } from "@ortho-earth/globe"`.

### A6. Clicks, popups, markers and the camera

```js
import { createGlobe, Marker, Popup } from "@ortho-earth/globe";

const popup = new Popup();
map.on("click", "cities", e => {          // e.features, e.lngLat ({ lng, lat }), e.point ({ x, y })
  popup.setLngLat(e.lngLat).setText(e.features[0].properties.name).addTo(map);
});

new Marker().setLngLat([139.77, 35.68])
  .setPopup(new Popup().setText("Tokyo"))
  .addTo(map);

await map.flyTo({ center: [139.77, 35.68], zoom: 12, pitch: 60 });   // resolves when the flight lands
```

Camera: `jumpTo`, `easeTo`, `flyTo`, `fitBounds`, `getCenter`, `getZoom`. Events: `map.on("move" | "settle" | "click" | "time", …)`.

### A7. More

- 3D Tiles and I3S: `await map.add3DTiles(url)`, `await map.addI3S(url)`
- Your own terrain (`raster-dem`): `map.setTerrain({ source: { tiles: [url], encoding: "terrarium" } })`
- Raster tiles (XYZ, WMS, WMTS, PMTiles): `map.addSource(id, { type: "raster", tiles: [url] })` + a `raster` layer
- A MapLibre `style.json`: `createGlobe({ style: url })`
- Time: `map.clock` (night side, stars and satellites follow it)
- Analysis: `map.sunShadow()`, `map.viewshed()`, `map.lineOfSight(a, b)`
- The `map` API is the same in both routes. Its TypeScript definitions ship with the SDK: `node_modules/@ortho-earth/japan/dist/lib/ortho-japan.d.ts` (install it alongside if you want them). The engine overview is at https://www.ortho-earth.com/docs/core.html

---

## Route B — without a bundler

```bash
npm install @ortho-earth/japan
cp -R node_modules/@ortho-earth/japan/dist/lib public/lib
cp -R node_modules/@ortho-earth/japan/assets public/assets
```

`public/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="./lib/ortho-japan.css">
    <style>html, body { margin: 0; height: 100%; } #here { height: 100vh; }</style>
  </head>
  <body>
    <div id="here"></div>
    <script type="module">
      import orthoJapan from "./lib/ortho-japan.js";
      const map = await orthoJapan({ target: "#here", assetBase: "./assets/" });
    </script>
  </body>
</html>
```

Serve `public/` over HTTP (for example `npx serve public`) — opening the file directly (`file://`) does not work, because ES modules and workers need a server.
The `map` object has the same API as in Route A.

---

## Notes for AI coding agents

- Install from npm; do not load the engine from a CDN (`esm.sh`, `unpkg`). Its workers must come from the same origin as the page.
- Keep the `vite.config.js` of step A2 exactly. It is the most common cause of a blank page in `npm run dev`.
- Top-level `await` in `main.js` is fine.
- After each change, run the dev server, open the page, and check the browser console. A healthy start logs `[boot] frame1 received` and no errors.
- Coordinates are `[longitude, latitude]` in degrees (WGS84), as in GeoJSON.
- Zoom levels match web maps: the whole Earth is about z0–z2, a city about z12, streets z16+. Without a region pack the world data is honest up to about z8.
