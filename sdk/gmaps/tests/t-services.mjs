// @ortho-earth/gmaps の services＝鍵があれば Google の REST へ中継し、返事を JS API の形に直す（偽の fetch・node だけ）。
//   鍵が無い時は REQUEST_DENIED で拒む・鍵は googleapis.com にしか行かない・Geocoder・Directions（Routes API）・DistanceMatrix・
//   Elevation・places（New）・Autocomplete・StreetView metadata と静止画の URL・DirectionsRenderer（偽の地図に線と印）
import { createGoogleMaps, LatLng, LatLngBounds } from "../src/index.ts";
let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
console.warn = () => {};
const K = "TEST_KEY";

// ── 偽の fetch：URL ごとに決まった返事・呼び出しを記録 ──
const calls = [];
const J = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const fakeFetch = async (url, init = {}) => {
	const u = new URL(url); calls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : null });
	if (u.hostname !== "maps.googleapis.com" && u.hostname !== "routes.googleapis.com" && u.hostname !== "places.googleapis.com") return J({ error: "wrong host" }, 500);
	if (u.pathname === "/maps/api/geocode/json") return u.searchParams.get("address") === "nowhere" ? J({ status: "ZERO_RESULTS", results: [] }) : J({ status: "OK", results: [{ formatted_address: "Tokyo Station", place_id: "P1", geometry: { location: { lat: 35.68, lng: 139.77 }, viewport: { northeast: { lat: 35.69, lng: 139.78 }, southwest: { lat: 35.67, lng: 139.76 } }, location_type: "ROOFTOP" }, types: ["train_station"] }] });
	if (u.pathname === "/directions/v2:computeRoutes") return J({ routes: [{ distanceMeters: 12345, duration: "1500s", description: "Route 1", polyline: { encodedPolyline: "_p~iF~ps|U_ulLnnqC" }, viewport: { low: { latitude: 38.5, longitude: -120.95 }, high: { latitude: 40.7, longitude: -120.2 } }, localizedValues: { duration: { text: "25 分" } },
		legs: [{ distanceMeters: 12345, duration: "1500s", startLocation: { latLng: { latitude: 38.5, longitude: -120.2 } }, endLocation: { latLng: { latitude: 40.7, longitude: -120.95 } }, steps: [{ distanceMeters: 100, staticDuration: "60s", navigationInstruction: { instructions: "Head north", maneuver: "TURN_LEFT" }, polyline: { encodedPolyline: "_p~iF~ps|U" }, startLocation: { latLng: { latitude: 38.5, longitude: -120.2 } }, endLocation: { latLng: { latitude: 38.5, longitude: -120.2 } }, travelMode: "DRIVE" }] }] }] });
	if (u.pathname === "/distanceMatrix/v2:computeRouteMatrix") return J([{ originIndex: 0, destinationIndex: 0, condition: "ROUTE_EXISTS", distanceMeters: 2500, duration: "300s" }, { originIndex: 0, destinationIndex: 1, condition: "ROUTE_NOT_FOUND" }]);
	if (u.pathname === "/maps/api/elevation/json") return J({ status: "OK", results: [{ elevation: 3776, location: { lat: 35.36, lng: 138.73 }, resolution: 10 }] });
	if (u.pathname === "/v1/places:searchText") return J({ places: [{ id: "PL1", displayName: { text: "Ramen Shop" }, formattedAddress: "1-1 Chiyoda", location: { latitude: 35.69, longitude: 139.75 }, rating: 4.5, userRatingCount: 120, types: ["restaurant"], priceLevel: "PRICE_LEVEL_MODERATE", photos: [{ name: "places/PL1/photos/AB", widthPx: 800, heightPx: 600, authorAttributions: [{ displayName: "A", uri: "https://x" }] }], currentOpeningHours: { openNow: true, weekdayDescriptions: ["Mon: 11-23"] } }] });
	if (u.pathname === "/v1/places:searchNearby") return J({ places: [] });
	if (u.pathname === "/v1/places/PL1") return J({ id: "PL1", displayName: { text: "Ramen Shop" }, location: { latitude: 35.69, longitude: 139.75 }, websiteUri: "https://ramen.example", reviews: [{ rating: 5, text: { text: "good" }, authorAttribution: { displayName: "B" }, publishTime: "2026-01-01T00:00:00Z" }] });
	if (u.pathname === "/v1/places:autocomplete") return J({ suggestions: [{ placePrediction: { placeId: "PL2", text: { text: "Tokyo Tower, Minato", matches: [{ endOffset: 5 }] }, structuredFormat: { mainText: { text: "Tokyo Tower" }, secondaryText: { text: "Minato" } }, types: ["tourist_attraction"] } }] });
	if (u.pathname === "/maps/api/streetview/metadata") return u.searchParams.get("location")?.startsWith("0,") ? J({ status: "ZERO_RESULTS" }) : J({ status: "OK", pano_id: "PANO1", location: { lat: 35.6813, lng: 139.7672 }, date: "2025-04", copyright: "© Google" });
	if (u.pathname === "/v1/places:denied") return J({ error: { status: "PERMISSION_DENIED", message: "no" } }, 403);
	return J({ status: "UNKNOWN" }, 404);
};
const ml = { Map: class { constructor(o) { this.o = o; } isStyleLoaded() { return true; } on() {} off() {} once() {} getCenter() { return { lng: 0, lat: 0 }; } getZoom() { return 0; } addControl() {} jumpTo() {} fitBounds(b, o) { this.fit = [b, o]; } getLayer() {} getSource() {} addSource(id, s) { (this.src ||= {})[id] = s; } addLayer(l) { (this.layers ||= []).push(l); } removeLayer() {} removeSource() {} }, Marker: class { constructor(o) { this.o = o; ml.markers.push(this); } setLngLat(l) { this.ll = l; return this; } addTo() { return this; } remove() { this.removed = true; } on() {} }, Popup: class {}, NavigationControl: class {} , markers: [] };
globalThis.document = { createElement: () => ({ style: {}, children: [], appendChild() {}, replaceChildren() {}, addEventListener() {}, setAttribute() {}, innerHTML: "", textContent: "", title: "" }) };
const q = (i) => calls[i].url.searchParams;

// ── 鍵なし＝拒む ──
{
	const gm = createGoogleMaps(ml, { fetch: fakeFetch });
	let cbArgs = null, rejected = null;
	await new gm.Geocoder().geocode({ address: "Tokyo" }, (r, s) => { cbArgs = [r, s]; }).catch(e => { rejected = e.code; });
	ok("noKey", cbArgs[0] === null && cbArgs[1] === "REQUEST_DENIED" && rejected === "REQUEST_DENIED" && calls.length === 0);
	gm.setApiKey(K); ok("setApiKey", gm.getApiKey() === K);
}
const gm = createGoogleMaps(ml, { apiKey: K, language: "ja", fetch: fakeFetch });
// ── Geocoder ──
{
	let cb = null;
	const { results } = await new gm.Geocoder().geocode({ address: "Tokyo Station", bounds: new LatLngBounds({ lat: 35, lng: 139 }, { lat: 36, lng: 140 }), componentRestrictions: { country: "JP" } }, (r, s) => { cb = [r, s]; });
	ok("geocode.request", q(0).get("key") === K && q(0).get("address") === "Tokyo Station" && q(0).get("language") === "ja" && q(0).get("bounds") === "35,139|36,140" && q(0).get("components") === "country:JP");
	ok("geocode.result", results[0].geometry.location instanceof LatLng && results[0].geometry.location.lng() === 139.77 && results[0].geometry.viewport.getNorthEast().lat() === 35.69 && cb[0] === results && cb[1] === "OK");
	await new gm.Geocoder().geocode({ location: { lat: 1, lng: 2 } }); ok("geocode.reverse", q(1).get("latlng") === "1,2");
	let zr = null; await new gm.Geocoder().geocode({ address: "nowhere" }, (r, s) => { zr = s; }).catch(() => {}); ok("geocode.zero", zr === "ZERO_RESULTS");
}
// ── DirectionsService ＋ Renderer ──
{
	calls.length = 0;
	const svc = new gm.DirectionsService();
	const res = await svc.route({ origin: "Tokyo", destination: { lat: 40.7, lng: -120.95 }, waypoints: [{ location: { placeId: "W1" }, stopover: true }], travelMode: gm.TravelMode.WALKING, avoidTolls: true, provideRouteAlternatives: true, optimizeWaypoints: true });
	const b = calls[0].body;
	ok("route.request", calls[0].url.hostname === "routes.googleapis.com" && calls[0].init.headers["X-Goog-Api-Key"] === K && /routes\.legs/.test(calls[0].init.headers["X-Goog-FieldMask"]) && b.origin.address === "Tokyo" && b.destination.location.latLng.latitude === 40.7 && b.intermediates[0].placeId === "W1" && b.travelMode === "WALK" && b.routeModifiers.avoidTolls === true && b.computeAlternativeRoutes === true && b.optimizeWaypointOrder === true && b.languageCode === "ja" && b.units === "METRIC");
	const r = res.routes[0], leg = r.legs[0];
	ok("route.result", res.status === "OK" && r.overview_path.length === 2 && r.overview_path[0] instanceof LatLng && leg.distance.value === 12345 && leg.distance.text === "12.3 km" && leg.duration.value === 1500 && leg.duration.text === "25 mins" && r.duration.text === "25 分" && leg.steps[0].instructions === "Head north" && leg.steps[0].maneuver === "turn-left" && leg.steps[0].travel_mode === "DRIVING" && leg.steps[0].path.length === 1 && r.bounds.getNorthEast().lat() === 40.7 && r.summary === "Route 1", JSON.stringify({ d: leg.distance, t: leg.duration }));
	await svc.route({ origin: { lat: 0, lng: 0 }, destination: { lat: 1, lng: 1 }, travelMode: "DRIVING", unitSystem: gm.UnitSystem.IMPERIAL }).then(r2 => ok("route.imperial", r2.routes[0].legs[0].distance.text === "7.7 mi" && calls[1].body.units === "IMPERIAL" && calls[1].body.travelMode === "DRIVE"));
	// Renderer：偽の地図に線 1 本と印 2 つ・fitBounds・panel
	const map = new gm.Map({ style: {}, appendChild() {} }, { center: { lat: 0, lng: 0 }, zoom: 3 });
	const panel = { children: [], replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); } };
	const rd = new gm.DirectionsRenderer({ map, directions: res, panel, polylineOptions: { strokeColor: "#f00" } });
	const mlm = map.getMapLibre();
	ok("renderer.draw", Object.keys(mlm.src || {}).length === 1 && mlm.layers?.[0]?.paint?.["line-color"] === "#f00" && ml.markers.length === 2 && ml.markers[0].ll[1] === 38.5 && mlm.fit?.[0]?.[1]?.[1] === 40.7 && panel.children.length === 2);
	rd.setMap(null); ok("renderer.clear", ml.markers.every(m => m.removed) && panel.children.length === 0);
}
// ── DistanceMatrix ──
{
	calls.length = 0;
	const m = await new gm.DistanceMatrixService().getDistanceMatrix({ origins: ["Tokyo"], destinations: [{ lat: 35, lng: 139 }, "Mars"], travelMode: "DRIVING" });
	ok("matrix", calls[0].url.pathname === "/distanceMatrix/v2:computeRouteMatrix" && calls[0].body.origins[0].waypoint.address === "Tokyo" && m.rows[0].elements[0].status === "OK" && m.rows[0].elements[0].distance.value === 2500 && m.rows[0].elements[0].duration.text === "5 mins" && m.rows[0].elements[1].status === "ZERO_RESULTS" && m.originAddresses[0] === "Tokyo" && m.destinationAddresses[0] === "35,139");
}
// ── Elevation ──
{
	calls.length = 0;
	let cb = null;
	const { results } = await new gm.ElevationService().getElevationForLocations({ locations: [{ lat: 35.36, lng: 138.73 }] }, (r, s) => { cb = [r, s]; });
	ok("elevation", q(0).get("locations") === "35.36,138.73" && results[0].elevation === 3776 && results[0].location instanceof LatLng && cb[0] === results && cb[1] === "OK");
	await new gm.ElevationService().getElevationAlongPath({ path: [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }], samples: 5 }); ok("elevation.path", q(1).get("path") === "0,0|1,1" && q(1).get("samples") === "5");
}
// ── places ──
{
	calls.length = 0;
	const ps = new gm.places.PlacesService(null);
	let cb = null;
	const res = await ps.textSearch({ query: "ramen", location: { lat: 35.68, lng: 139.77 }, radius: 1000, type: "restaurant" }, (r, s, pg) => { cb = [r, s, pg]; });
	const b = calls[0].body, p = res[0];
	ok("places.textSearch.request", calls[0].url.hostname === "places.googleapis.com" && calls[0].init.headers["X-Goog-Api-Key"] === K && /places\.displayName/.test(calls[0].init.headers["X-Goog-FieldMask"]) && b.textQuery === "ramen" && b.includedType === "restaurant" && b.locationBias.circle.radius === 1000 && b.languageCode === "ja");
	ok("places.textSearch.result", p.place_id === "PL1" && p.name === "Ramen Shop" && p.geometry.location instanceof LatLng && p.rating === 4.5 && p.user_ratings_total === 120 && p.price_level === 2 && p.opening_hours.open_now === true && p.photos[0].getUrl({ maxWidth: 400 }).startsWith(`https://places.googleapis.com/v1/places/PL1/photos/AB/media?key=${K}&maxWidthPx=400`) && cb[1] === "OK" && cb[2].hasNextPage === false);
	let zr = null; await ps.nearbySearch({ location: { lat: 35.68, lng: 139.77 }, radius: 500, type: "cafe" }, (r, s) => { zr = s; });
	ok("places.nearby", calls[1].url.pathname === "/v1/places:searchNearby" && calls[1].body.includedTypes[0] === "cafe" && calls[1].body.locationRestriction.circle.radius === 500 && zr === "ZERO_RESULTS");
	await ps.nearbySearch({ location: { lat: 35.68, lng: 139.77 }, radius: 500, keyword: "coffee" });
	ok("places.nearby.keyword", calls[2].url.pathname === "/v1/places:searchText" && calls[2].body.textQuery === "coffee");
	const d = await ps.getDetails({ placeId: "PL1", fields: ["name", "geometry", "website", "reviews"] });
	ok("places.details", calls[3].url.pathname === "/v1/places/PL1" && calls[3].init.headers["X-Goog-FieldMask"] === "displayName,location,viewport,websiteUri,reviews" && d.website === "https://ramen.example" && d.reviews[0].author_name === "B" && d.reviews[0].time === 1767225600);
	const { predictions } = await new gm.places.AutocompleteService().getPlacePredictions({ input: "tokyo t", componentRestrictions: { country: "JP" }, sessionToken: new gm.places.AutocompleteSessionToken() });
	ok("places.autocomplete", calls[4].url.pathname === "/v1/places:autocomplete" && calls[4].body.input === "tokyo t" && calls[4].body.includedRegionCodes[0] === "jp" && typeof calls[4].body.sessionToken === "string" && predictions[0].place_id === "PL2" && predictions[0].description === "Tokyo Tower, Minato" && predictions[0].structured_formatting.main_text === "Tokyo Tower" && predictions[0].matched_substrings[0].length === 5);
	// 拒まれた時の status
	let st = null; await ps.textSearch({ query: "x" }).catch(() => {});
	calls.length = 0;
	const denied = createGoogleMaps(ml, { apiKey: K, fetch: async () => J({ error: { status: "PERMISSION_DENIED" } }, 403) });
	await new denied.places.PlacesService().textSearch({ query: "x" }, (r, s) => { st = s; }).catch(e => { st += "/" + e.code; });
	ok("places.denied", st === "REQUEST_DENIED/REQUEST_DENIED");
}
// ── Street View ──
{
	calls.length = 0;
	const { data } = await new gm.StreetViewService().getPanorama({ location: { lat: 35.6812, lng: 139.7671 }, radius: 100 });
	ok("sv.metadata", calls[0].url.pathname === "/maps/api/streetview/metadata" && q(0).get("location") === "35.6812,139.7671" && q(0).get("radius") === "100" && q(0).get("key") === K && data.location.pano === "PANO1" && data.location.latLng.lat() === 35.6813 && data.imageDate === "2025-04");
	let zr = null; await new gm.StreetViewService().getPanorama({ location: { lat: 0, lng: 0 } }, (r, s) => { zr = s; }).catch(() => {}); ok("sv.zero", zr === "ZERO_RESULTS");
	const el = { style: {}, clientWidth: 800, clientHeight: 400, appendChild() {} };
	const pano = new gm.StreetViewPanorama(el, { position: { lat: 35.6812, lng: 139.7671 }, pov: { heading: 90, pitch: 10 }, zoom: 1 });
	const u = new URL(pano.getImageUrl());
	ok("sv.image", u.pathname === "/maps/api/streetview" && u.searchParams.get("size") === "640x400" && u.searchParams.get("location") === "35.6812,139.7671" && u.searchParams.get("heading") === "90" && u.searchParams.get("pitch") === "10" && u.searchParams.get("fov") === "90" && u.searchParams.get("key") === K);
	await new Promise(r => setTimeout(r, 10));
	ok("sv.lookup", pano.getPano() === "PANO1" && pano.getStatus() === "OK" && new URL(pano.getImageUrl()).searchParams.get("pano") === "PANO1");
	pano.setPov({ heading: 180 }); pano.setZoom(0);
	ok("sv.pov", new URL(pano.getImageUrl()).searchParams.get("heading") === "180" && new URL(pano.getImageUrl()).searchParams.get("fov") === "120");
	const map = new gm.Map({ style: {}, appendChild() {} }, {});
	const sv = map.getStreetView();
	ok("map.getStreetView", sv instanceof gm.StreetViewPanorama && map.getStreetView() === sv && sv.getVisible() === false);
}
// ── importLibrary の区分 ──
ok("importLibrary", (await gm.importLibrary("places")).PlacesService === gm.places.PlacesService && (await gm.importLibrary("routes")).DirectionsService === gm.DirectionsService && (await gm.importLibrary("geocoding")).Geocoder === gm.Geocoder && (await gm.importLibrary("streetView")).StreetViewPanorama === gm.StreetViewPanorama);
ok("keyHosts", calls.every(c => /\.googleapis\.com$/.test(c.url.hostname)));
if (fails) { console.error(`${fails} failed`); process.exit(1); } else console.log("ALL PASS gmaps services");
