# @ortho-earth/gmaps

The Google Maps JavaScript API on MapLibre GL. `createGoogleMaps(maplibregl)` returns a `google.maps` namespace whose `Map`, `Marker`, `InfoWindow`, shapes and `Data` draw through the `maplibregl` you give it: the real [`maplibre-gl`](https://maplibre.org/), or [`@ortho-earth/globe/maplibre`](../../packages/globe) (the 3D globe). Code written for Google Maps keeps its shape; only the import changes. No Google API key is needed, and nothing is sent to Google.

```js
// on the globe
import google from "@ortho-earth/gmaps/globe";   // { maps }

const map = new google.maps.Map(document.getElementById("map"), { center: { lat: 35.6812, lng: 139.7671 }, zoom: 15, tilt: 45 });
const marker = new google.maps.Marker({ map, position: { lat: 35.6812, lng: 139.7671 }, title: "Tokyo Station", label: "T" });
const info = new google.maps.InfoWindow({ content: "<b>Tokyo Station</b>" });
marker.addListener("click", () => info.open({ map, anchor: marker }));
new google.maps.Polygon({ map, paths: [...], fillColor: "#FF0000", fillOpacity: 0.35 });
map.data.loadGeoJson("/parks.geojson");
map.data.setStyle(f => ({ fillColor: f.getProperty("kind") === "park" ? "green" : "gray" }));
```

```js
// on maplibre-gl, with your own MapLibre styles per map type
import maplibregl from "maplibre-gl";
import { createGoogleMaps, installGlobal } from "@ortho-earth/gmaps";

const maps = createGoogleMaps(maplibregl, { styles: { roadmap: "https://demotiles.maplibre.org/style.json", satellite: mySatelliteStyle } });
installGlobal(maps);   // window.google.maps, for code that reads the global
```

Code that loads the API with `@googlemaps/js-api-loader` can use the `Loader` from `@ortho-earth/gmaps/globe` instead (`new Loader({ apiKey }).importLibrary("maps")`; the key is ignored). `google.maps.importLibrary("maps" | "marker" | "core" | "geometry")` works too.

## What is translated

| Google Maps | On MapLibre |
|---|---|
| `Map` options: `center`, `zoom`, `heading`, `tilt`, `minZoom`/`maxZoom`, `mapTypeId`, `mapId`, `restriction`, `gestureHandling`, `draggable`, `scrollwheel`, `disableDoubleClickZoom`, `keyboardShortcuts`, `disableDefaultUI`, `zoomControl`, `fullscreenControl`, `scaleControl`, `backgroundColor` | `Map` options. **Zoom is shifted by one**: Google zoom z = MapLibre zoom z − 1 (256 px vs 512 px tiles; `zoomOffset` changes it). `mapTypeId` / `mapId` pick a MapLibre style from `styles` (hybrid falls back to satellite, terrain to roadmap) |
| `Map` methods: `get/setCenter`, `get/setZoom`, `get/setHeading`, `get/setTilt`, `moveCamera`, `panTo`, `panBy`, `panToBounds`, `fitBounds`, `getBounds`, `get/setMapTypeId`, `setOptions`, `getDiv`, `getProjection`, `controls[ControlPosition]` | the camera calls; `controls` places your elements in the MapLibre control corners (the centered positions get strips of their own). Overlays are added again after a style change |
| `Map` events: `click`, `dblclick`, `rightclick`, `mousemove`, `mouseover`, `mouseout`, `mousedown`, `mouseup`, `idle`, `tilesloaded`, `bounds_changed`, `center_changed`, `zoom_changed`, `heading_changed`, `tilt_changed`, `drag`, `dragstart`, `dragend`, `resize` | MapLibre events, with Google's event object (`latLng`, `pixel`, `domEvent`, `stop()`). Like Google, a click on a marker or a clickable shape is not also a map click |
| `Marker` (`icon` as URL / `Icon` / `Symbol`, `label`, `title`, `draggable`, `visible`, `opacity`, `zIndex`, `clickable`) | a MapLibre `Marker` with Google's red pin, your image, or the SVG symbol (`SymbolPath.*` or a path) |
| `marker.AdvancedMarkerElement`, `marker.PinElement` | a MapLibre `Marker` with your `content` element (default: the pin); `gmp-click` |
| `InfoWindow` (`content` as HTML or a node, `headerContent`, `position`, `pixelOffset`, `maxWidth`, `open({ map, anchor })`, `close`, `closeclick`, `domready`) | a MapLibre `Popup` above the marker, following it when it moves |
| `Polyline`, `Polygon` (holes), `Circle`, `Rectangle`; `MVCArray` paths; `geodesic`; `zIndex`; mouse events | a GeoJSON source with line / fill layers per shape; editing the path redraws it; `geodesic` follows the great circle; `zIndex` orders the layers |
| `Data`: `addGeoJson`, `loadGeoJson`, `add`, `remove`, `getFeatureById`, `forEach`, `toGeoJson`, `setStyle` (object or function), `overrideStyle`, `revertStyle`, `Data.Feature`, `Data.Point`…, events with `feature` | one GeoJSON source with fill / line / circle layers; each feature's style is evaluated and written into its properties |
| `LatLng`, `LatLngBounds`, `Point`, `Size`, `MVCObject`, `MVCArray`, `event.*` | plain values and an event registry |
| `geometry.spherical` (distance, heading, offset, interpolate, length, area), `geometry.encoding`, `geometry.poly` | computed here on a sphere of radius 6,378,137 m, as Google does |

## What is not

- **Google's services** (`Geocoder`, `DirectionsService`, `DistanceMatrixService`, `places`, `StreetViewPanorama`, `ElevationService`…) need Google's servers. Their constructors exist so the page still runs, but their methods reject (callbacks get `REQUEST_DENIED`).
- **Google JSON styling** (`styles: [{ featureType, … }]`) and cloud-based map styles have no counterpart; give MapLibre styles to `createGoogleMaps({ styles })` keyed by map type or `mapId`.
- Editable or draggable shapes, `Polyline.icons`, marker animations, `Data` point icons (drawn as circles), map type / Street View / rotate controls, `overlayMapTypes`, `MVCObject.bindTo`.

Each of these is reported once in the console as `[gmshim] unsupported: …` (never thrown), and `google.maps.unsupportedReport()` lists them, so a port can be checked by running it.

`map.getMapLibre()` returns the MapLibre map underneath for anything else.

Tests: `npm test -w @ortho-earth/gmaps` (node, with a fake `maplibregl`: values, geometry, options and camera, events, markers, info windows, shapes, Data, the unsupported report) and, in `packages/globe`, `npm run verify:ui -- t-gmaps` (on the real globe: zoom shift, shapes drawn and hit by `queryRenderedFeatures`, a shape click is not a map click, marker and info window in the DOM, Data styled by function).
