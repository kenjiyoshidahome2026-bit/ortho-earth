# @ortho-earth/gmaps

The Google Maps JavaScript API on MapLibre GL. `createGoogleMaps(maplibregl)` returns a `google.maps` namespace whose `Map`, `Marker`, `InfoWindow`, shapes and `Data` draw through the `maplibregl` you give it: the real [`maplibre-gl`](https://maplibre.org/), or [`@ortho-earth/globe/maplibre`](../../packages/globe) (the 3D globe). Code written for Google Maps keeps its shape; only the import changes. The map itself needs no Google API key and sends nothing to Google. If you do pass a key, the services that live on Google's servers (Geocoder, Directions, Distance Matrix, Elevation, Places, Street View) are relayed to Google's REST APIs with it.

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

Code that loads the API with `@googlemaps/js-api-loader` can use the `Loader` from `@ortho-earth/gmaps/globe` instead (`new Loader({ apiKey }).importLibrary("maps")`; the key goes to the services below). `google.maps.importLibrary("maps" | "marker" | "core" | "geometry" | "places" | "routes" | "geocoding" | "elevation" | "streetView")` works too.

## Google's services, with your key

```js
import { createGlobeMaps } from "@ortho-earth/gmaps/globe";
const maps = createGlobeMaps({ apiKey: MY_KEY, language: "ja", region: "JP" });   // or maps.setApiKey(MY_KEY) later, or new Loader({ apiKey })

const geocoder = new maps.Geocoder();
const { results } = await geocoder.geocode({ address: "東京駅" });
new maps.DirectionsService().route({ origin: "東京駅", destination: "渋谷駅", travelMode: "TRANSIT" }, (res, status) => {
	if (status === "OK") new maps.DirectionsRenderer({ map, directions: res, panel: document.getElementById("steps") });
});
new maps.places.PlacesService(map).nearbySearch({ location: map.getCenter(), radius: 500, type: "cafe" }, (places, status) => { … });
new maps.places.Autocomplete(document.getElementById("search"), { fields: ["geometry", "name"] }).addListener("place_changed", …);
```

| Google Maps | Relayed to | Notes |
|---|---|---|
| `Geocoder.geocode` (`address`, `location`, `placeId`, `bounds`, `componentRestrictions`) | Geocoding API | results with `LatLng` / `LatLngBounds` geometry; callback `(results, status)`, promise `{ results }` |
| `DirectionsService.route` (`origin` / `destination` / `waypoints` as address, `LatLng` or `{ placeId }`, `travelMode`, `avoid*`, `optimizeWaypoints`, `provideRouteAlternatives`, `unitSystem`, `drivingOptions`, `transitOptions`) | Routes API `computeRoutes` | `DirectionsResult` with `routes[].legs[].steps[]`, `overview_path`, `bounds`, `{ text, value }` distances and durations. Leg `start_address` / `end_address` are empty (the Routes API does not return them) |
| `DirectionsRenderer` (`directions`, `routeIndex`, `polylineOptions`, `markerOptions`, `suppressMarkers`, `suppressPolylines`, `preserveViewport`, `panel`) | — | a `Polyline` and lettered `Marker`s on the map, text steps in the panel |
| `DistanceMatrixService.getDistanceMatrix` | Routes API `computeRouteMatrix` | `rows[].elements[]` with `status`, `distance`, `duration` |
| `ElevationService.getElevationForLocations` / `getElevationAlongPath` | Elevation API | |
| `places.PlacesService.textSearch` / `nearbySearch` / `findPlaceFromQuery` / `getDetails` | Places API (New) | `PlaceResult` with `place_id`, `name`, `geometry`, `rating`, `opening_hours`, `photos[].getUrl()`, `reviews`… `nearbySearch` with a `keyword` goes through text search (the new API has no keyword). No paging (`hasNextPage` is false) |
| `places.AutocompleteService.getPlacePredictions`, `places.Autocomplete` on an `<input>`, `AutocompleteSessionToken` | Places API (New) autocomplete | `Autocomplete` draws a plain dropdown (`.pac-container` / `.pac-item`) and fires `place_changed` after loading the details |
| `StreetViewService.getPanorama` | Street View metadata API | pano id, position, date |
| `StreetViewPanorama`, `map.getStreetView()` | Street View Static API | a **still image** for the position, heading, pitch and zoom; dragging turns it and fetches a new still, the wheel zooms. Google does not publish the panorama tiles outside its own JS API, so there is no smooth 360° view and no pegman |

Statuses follow the JS API (`OK`, `ZERO_RESULTS`, `REQUEST_DENIED`, `INVALID_REQUEST`, `OVER_QUERY_LIMIT`, `NOT_FOUND`, `UNKNOWN_ERROR`); a rejected promise carries it as `error.code`. The key is sent only to `*.googleapis.com`. Enable the Geocoding, Routes, Elevation, Places (New) and Street View Static APIs for it in the Cloud console and restrict it to your origins; Google's usage terms and billing apply to these calls. Without a key the same methods report `[gmshim] unsupported` once and fail with `REQUEST_DENIED`, so the map keeps working.

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

- **Google's services without a key**: their constructors exist so the page still runs, but their methods reject (callbacks get `REQUEST_DENIED`). With a key see above. An interactive 360° Street View, the pegman and `StreetViewPanorama` links / pan controls stay out either way.
- **Google JSON styling** (`styles: [{ featureType, … }]`) and cloud-based map styles have no counterpart; give MapLibre styles to `createGoogleMaps({ styles })` keyed by map type or `mapId`.
- Editable or draggable shapes, `Polyline.icons`, marker animations, `Data` point icons (drawn as circles), map type / Street View / rotate controls, `overlayMapTypes`, `MVCObject.bindTo`.

Each of these is reported once in the console as `[gmshim] unsupported: …` (never thrown), and `google.maps.unsupportedReport()` lists them, so a port can be checked by running it.

`map.getMapLibre()` returns the MapLibre map underneath for anything else.

Tests: `npm test -w @ortho-earth/gmaps` (node, with a fake `maplibregl`: values, geometry, options and camera, events, markers, info windows, shapes, Data, the unsupported report; and with a fake `fetch`: every service's request and the reshaped result, the key only on `googleapis.com`, `REQUEST_DENIED` without a key) and, in `packages/globe`, `npm run verify:ui -- t-gmaps` (on the real globe: zoom shift, shapes drawn and hit by `queryRenderedFeatures`, a shape click is not a map click, marker and info window in the DOM, Data styled by function).

## Release notes

- 0.2.0 (2026-10-31): part of Ortho Earth 2.2. [Release article](https://www.ortho-earth.com/docs/release-2-2) ([日本語](https://www.ortho-earth.com/docs/release-2-2-jp)) · [From Google Maps](https://www.ortho-earth.com/docs/from-google-maps). All releases: [CHANGELOG](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/CHANGELOG.md) · [GitHub Releases](https://github.com/kenjiyoshidahome2026-bit/ortho-earth/releases)
