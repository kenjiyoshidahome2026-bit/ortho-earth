# @ortho-earth/globe

A 3D globe for the browser: real terrain at true scale, vector basemaps, 3D buildings, 3D Tiles / I3S,
rasters (XYZ · WMS · WMTS · PMTiles), labels, and a MapLibre-shaped API — with **no map server of your
own**. It reads public data directly and keeps what it decoded in the browser.

```
npm i @ortho-earth/globe
```

```js
import { createGlobe } from "@ortho-earth/globe";

const map = await createGlobe({ target: "#map", view: "#3/20/140" });
map.flyTo({ center: [139.767, 35.681], zoom: 14, pitch: 60 });
```

## What you get

- **Camera**: `jumpTo` / `easeTo` / `flyTo` / `fitBounds` / `cameraForBounds` / padding / `setMaxBounds`
- **Layers**: external MapLibre `style.json` (`setStyle`), `setPaintProperty` / `setLayoutProperty` /
  `setFilter` / `moveLayer` / per-layer events, `queryRenderedFeatures`-equivalent
- **3D**: extrusions, glTF/GLB models, any 3D Tiles tileset (`map.add3DTiles`), I3S (`map.addI3S`)
- **Terrain**: built-in elevation, or your own `raster-dem` source (`map.setTerrain`)
- **Analysis**: sun shadow / shadow-hours, viewshed, line of sight, profiles, measurement
- **DOM**: `new Marker().setLngLat([lon, lat]).addTo(map)`, `Popup`, `addProtocol`, `transformRequest`
- **Regions**: pass `opts.region` to add a country pack (basemap, elevation, buildings, search…).
  Without it you get the world: Natural Earth 10m, global hypsometry, lakes, rivers, maritime
  boundaries, stars — honest up to about z8, which is what world data can carry.

## Verification

The gates live with the code: `npm run verify:ui` (17 pages), `npm run verify:webgpu` (10 pages, real GPU; a page that
boots on WebGL2 or skips for lack of WebGPU fails),
`npm run verify:nocoi` (the no-`crossOriginIsolated` world). They boot pages through this package's own
public face, so what is tested is what you install.

## License

GPL-3.0-or-later ([LICENSE](LICENSE)). A commercial license — without GPL obligations such as disclosing
your site's source — is available: contact kenji.yoshida.home.2026@gmail.com.
