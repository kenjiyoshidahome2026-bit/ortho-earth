# @ortho-earth/leaflet

Leaflet on MapLibre GL. `createLeaflet(maplibregl)` returns an `L` namespace whose map, markers, popups, tile layers, vector layers and GeoJSON draw through the `maplibregl` you give it: the real [`maplibre-gl`](https://maplibre.org/), or [`@ortho-earth/globe/maplibre`](../../packages/globe) (the 3D globe). Code written for Leaflet 1.9 keeps its shape; only the import changes.

```js
// on the globe
import L from "@ortho-earth/leaflet/globe";

const map = L.map("map").setView([35.6812, 139.7671], 15);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
L.marker([35.6812, 139.7671]).addTo(map).bindPopup("<b>Tokyo Station</b>").openPopup();
L.polygon([[35.68, 139.76], [35.68, 139.77], [35.69, 139.77]], { color: "red" }).addTo(map);
L.geoJSON(parks, { style: f => ({ fillColor: f.properties.kind === "park" ? "green" : "gray" }), onEachFeature: (f, l) => l.bindTooltip(f.properties.name) }).addTo(map);
```

```js
// on maplibre-gl, with a MapLibre style under your layers
import maplibregl from "maplibre-gl";
import { createLeaflet, installGlobal } from "@ortho-earth/leaflet";

const L = createLeaflet(maplibregl);                                   // an empty style: only your layers, as in Leaflet
const L2 = createLeaflet(maplibregl, { style: "https://demotiles.maplibre.org/style.json" });
installGlobal(L);   // window.L, for scripts and plugins that read the global
```

`@ortho-earth/leaflet/globe` also has Leaflet's named exports (`map`, `tileLayer`, `marker`, …), so a bundler alias ports an app without touching its imports:

```js
// vite.config.js
export default { resolve: { alias: { leaflet: "@ortho-earth/leaflet/globe" } } };
```

Leaflet's stylesheet is not needed: the bits of `leaflet.css` (and of `maplibre-gl.css`, for the control corners) that the translated parts use are added to the page. A page's own `leaflet.css` still wins.

## What is translated

| Leaflet | On MapLibre |
|---|---|
| `L.map` options: `center`, `zoom`, `minZoom`/`maxZoom`, `maxBounds`, `layers`, `zoomSnap`, `zoomDelta`, `dragging`, `scrollWheelZoom`, `doubleClickZoom`, `boxZoom`, `keyboard`, `touchZoom`, `zoomControl`, `attributionControl`, `closePopupOnClick`, `renderer`/`preferCanvas` | `Map` options. **Zoom is shifted by one**: Leaflet zoom z = MapLibre zoom z − 1 (256 px vs 512 px tiles; `zoomOffset` changes it). Rotation and tilt stay off, as in Leaflet (`rotate: true` turns them on; `bearing`, `pitch` and a raw `maplibre` options object pass through) |
| Map methods: `setView`, `setZoom`, `zoomIn`/`zoomOut`, `setZoomAround`, `panTo`, `panBy`, `flyTo`, `fitBounds`, `flyToBounds`, `fitWorld`, `getBoundsZoom`, `panInsideBounds`, `setMaxBounds`, `setMinZoom`/`setMaxZoom`, `getCenter`, `getZoom`, `getBounds`, `getSize`, `invalidateSize`, `project`/`unproject`, `latLngToContainerPoint` and the other point conversions, `distance`, `locate`, `whenReady`, `remove`, `createPane`/`getPane`, handlers (`map.dragging.disable()` …) | the camera calls. `fitBounds` / `getBoundsZoom` use Leaflet's own arithmetic (padding, `zoomSnap`), so a port lands on the same zoom. The layer-point origin is the container's top-left corner |
| Map events: `click`, `dblclick`, `contextmenu`, `mousedown`, `mouseup`, `mousemove`, `mouseover`, `mouseout`, `preclick`, `move`, `movestart`, `moveend`, `zoom`, `zoomstart`, `zoomend`, `dragstart`, `drag`, `dragend`, `resize`, `load`, `unload`, `keydown`…, `layeradd`/`layerremove`, `popupopen`/`popupclose`, `tooltipopen`/`tooltipclose`, `zoomlevelschange`, `baselayerchange`/`overlayadd`/`overlayremove`, `locationfound`/`locationerror` | MapLibre events with Leaflet's event object (`latlng`, `containerPoint`, `layerPoint`, `originalEvent`). Like Leaflet, a path's mouse event reaches its groups (`e.layer`, `e.propagatedFrom`) and then the map unless `bubblingMouseEvents: false` or `L.DomEvent.stopPropagation(e)`; a marker's click does not reach the map |
| `L.tileLayer(url, options)`: `{s}`/`subdomains`, `{r}`, `{-y}`/`tms`, your own `{keys}`, `tileSize`, `minZoom`/`maxZoom`, `minNativeZoom`/`maxNativeZoom`, `bounds`, `opacity`, `zIndex`, `attribution`; `setUrl`, `setOpacity`, `setZIndex`, `bringToFront`; `L.tileLayer.wms` | a MapLibre raster source (one tile URL per subdomain; WMS with `{bbox-epsg-3857}`). Like Leaflet, the tile layers' `maxZoom` limits the map's zoom |
| `L.GridLayer` with your `createTile(coords, done)` (canvas or `<img>` tiles) | a MapLibre protocol that draws each tile |
| `L.imageOverlay`, `L.videoOverlay` | MapLibre image / video sources |
| `L.marker` (`icon`, `draggable`, `title`, `alt`, `opacity`, `zIndexOffset`, `riseOnHover`, `keyboard`), `L.icon`, `L.divIcon`, `L.Icon.Default` (with `mergeOptions` / `imagePath`) | a MapLibre `Marker` holding the icon element Leaflet would build (your `createIcon()` works); the default icon is Leaflet's blue pin as SVG, no image files to serve |
| `L.popup`, `bindPopup` / `openPopup` / `closePopup` / `togglePopup`, `L.tooltip`, `bindTooltip` (`permanent`, `sticky`, `direction`, `offset`, `opacity`) | MapLibre `Popup`s placed as Leaflet places them (marker `popupAnchor` / `tooltipAnchor`, `autoClose`, `closeOnClick`, `closeOnEscapeKey`, `autoPan`) |
| `L.polyline`, `L.polygon` (holes, multi), `L.rectangle`, `L.circle` (meters), `L.circleMarker` (pixels); `setStyle`, `setLatLngs`, `addLatLng`, `bringToFront`/`bringToBack`, `getBounds`, `getCenter`, `toGeoJSON`; `color`, `weight`, `opacity`, `fill`, `fillColor`, `fillOpacity`, `dashArray`, `lineCap`, `interactive` | like Leaflet's single SVG / Canvas renderer per pane: **one GeoJSON source per pane** with fill / line / circle layers; each path is a feature whose style is in its properties. Changes are batched into one upload per frame, so 10,000 GeoJSON features cost one source |
| `L.geoJSON` (`style`, `pointToLayer`, `onEachFeature`, `filter`, `coordsToLatLng`; `addData`, `setStyle`, `resetStyle`, `toGeoJSON`) | one layer per feature, as in Leaflet, drawn through the shared source |
| `L.layerGroup`, `L.featureGroup` (events, `setStyle`, `getBounds`, `bindPopup`) | groups |
| `L.control.zoom`, `L.control.attribution` (layers' and the style's attributions), `L.control.scale`, `L.control.layers`, `L.Control.extend({ onAdd })` | controls in MapLibre's control corners |
| Panes: `map.createPane(name)` and its `style.zIndex`; `pane` option on layers | the order of the MapLibre layers (tilePane 200 < overlayPane 400 < your panes) |
| `L.Class` (`extend`, `include`, `mergeOptions`, `addInitHook`), `L.Evented`, `L.Handler`, `L.Util`, `L.DomUtil`, `L.DomEvent`, `L.Browser`, `L.latLng`, `L.latLngBounds`, `L.point`, `L.bounds`, `L.CRS`, `L.Projection` | plain values and helpers, as in Leaflet (plugins built on `L.Class.extend` load) |

## What is not

- **Other CRSs** (`L.CRS.Simple`, EPSG:4326 maps): MapLibre draws Web Mercator and the globe.
- **SVG / DOM internals of vector layers**: `path.getElement()` returns null (a path is a MapLibre feature), `L.svgOverlay`, and plugins that draw into Leaflet's panes or renderers (marker clustering, Leaflet.draw) do not draw.
- HTML `GridLayer` tiles (only canvas and `<img>` tiles can be drawn), `TileLayer` `detectRetina` and `zoomOffset` (other than 512 px tiles with `zoomOffset: -1`), the `zoomanim` event.

Each of these is reported once in the console as `[lfshim] unsupported: …` (never thrown), and `L.unsupportedReport()` lists them, so a port can be checked by running it.

`map.getMapLibre()` returns the MapLibre map underneath for anything else.

Tests: `npm test -w @ortho-earth/leaflet` (node, with a fake `maplibregl`: values, `L.Class`, events, options and camera, `fitBounds`, tile / WMS sources and their order, the shared path source, GeoJSON, where a click goes, popups, tooltips, markers and drag, the layers control, the unsupported report) and, in `packages/globe`, `npm run verify:ui -- t-leaflet` (on the real globe: zoom shift, a `GridLayer` drawn through the protocol, paths drawn and hit by `queryRenderedFeatures`, a path click reaches the path then the map, a marker click opens its popup and does not reach the map, tooltips, GeoJSON styled by function, controls in their corners).
