// Google's services with an API key: Geocoder, DirectionsService (+ DirectionsRenderer), DistanceMatrixService, ElevationService, places.*.
//   The map part of google.maps is translated to MapLibre (map.ts…); these parts have no MapLibre counterpart, they are Google's servers.
//   With createGoogleMaps(ml, { apiKey }) (or Loader({ apiKey })) each call goes to Google's REST API with that key and the answer is
//   reshaped into what the JS API hands out (LatLng objects, {text, value} distances, PlaceResult…), so callbacks and promises keep working.
//   Without a key every method reports "[gmshim] unsupported" once, calls back with REQUEST_DENIED and rejects, as before.
//   Endpoints: Geocoding API and Elevation API (maps.googleapis.com, legacy JSON), Routes API (routes.googleapis.com: computeRoutes,
//   computeRouteMatrix) and Places API (New) (places.googleapis.com). The key only ever goes to those hosts.
import { LatLng, LatLngBounds, MVCObject, event, unsupported, toLatLng, type LatLngLike } from "./core.ts";
import { encoding } from "./geometry.ts";
import { Marker } from "./markers.ts";
import { Polyline } from "./shapes.ts";
import type { GMap } from "./map.ts";

export interface ServiceCtx {
	apiKey?: string | null;
	language?: string;
	region?: string;
	/** fetch to use (tests pass a fake) */
	fetch?: typeof fetch;
}
type Cb<T> = ((result: T | null, status: string, ...rest: any[]) => void) | undefined;

export const GeocoderStatus = { OK: "OK", ZERO_RESULTS: "ZERO_RESULTS", OVER_QUERY_LIMIT: "OVER_QUERY_LIMIT", REQUEST_DENIED: "REQUEST_DENIED", INVALID_REQUEST: "INVALID_REQUEST", UNKNOWN_ERROR: "UNKNOWN_ERROR", ERROR: "ERROR" } as const;
export const DirectionsStatus = { OK: "OK", NOT_FOUND: "NOT_FOUND", ZERO_RESULTS: "ZERO_RESULTS", MAX_WAYPOINTS_EXCEEDED: "MAX_WAYPOINTS_EXCEEDED", INVALID_REQUEST: "INVALID_REQUEST", OVER_QUERY_LIMIT: "OVER_QUERY_LIMIT", REQUEST_DENIED: "REQUEST_DENIED", UNKNOWN_ERROR: "UNKNOWN_ERROR" } as const;
export const DistanceMatrixStatus = { OK: "OK", INVALID_REQUEST: "INVALID_REQUEST", OVER_QUERY_LIMIT: "OVER_QUERY_LIMIT", REQUEST_DENIED: "REQUEST_DENIED", UNKNOWN_ERROR: "UNKNOWN_ERROR", MAX_ELEMENTS_EXCEEDED: "MAX_ELEMENTS_EXCEEDED", MAX_DIMENSIONS_EXCEEDED: "MAX_DIMENSIONS_EXCEEDED" } as const;
export const DistanceMatrixElementStatus = { OK: "OK", NOT_FOUND: "NOT_FOUND", ZERO_RESULTS: "ZERO_RESULTS" } as const;
export const ElevationStatus = { OK: "OK", INVALID_REQUEST: "INVALID_REQUEST", OVER_QUERY_LIMIT: "OVER_QUERY_LIMIT", REQUEST_DENIED: "REQUEST_DENIED", UNKNOWN_ERROR: "UNKNOWN_ERROR" } as const;
export const PlacesServiceStatus = { OK: "OK", ZERO_RESULTS: "ZERO_RESULTS", INVALID_REQUEST: "INVALID_REQUEST", OVER_QUERY_LIMIT: "OVER_QUERY_LIMIT", REQUEST_DENIED: "REQUEST_DENIED", UNKNOWN_ERROR: "UNKNOWN_ERROR", NOT_FOUND: "NOT_FOUND" } as const;
export const TravelMode = { DRIVING: "DRIVING", WALKING: "WALKING", BICYCLING: "BICYCLING", TRANSIT: "TRANSIT", TWO_WHEELER: "TWO_WHEELER" } as const;
export const UnitSystem = { METRIC: 0, IMPERIAL: 1 } as const;
export const TrafficModel = { BEST_GUESS: "bestguess", OPTIMISTIC: "optimistic", PESSIMISTIC: "pessimistic" } as const;
export const RankBy = { PROMINENCE: 0, DISTANCE: 1 } as const;
export const BusinessStatus = { OPERATIONAL: "OPERATIONAL", CLOSED_TEMPORARILY: "CLOSED_TEMPORARILY", CLOSED_PERMANENTLY: "CLOSED_PERMANENTLY" } as const;

/** an error with the status code, as Google's MapsRequestError carries it */
class MapsRequestError extends Error { code: string; constructor(code: string, msg?: string) { super(msg || `google.maps request failed: ${code}`); this.code = code; } }
const ll = (p: { lat: number; lng: number } | undefined | null): LatLng | undefined => p ? new LatLng(p.lat, p.lng, true) : undefined;
const llNew = (p: { latitude: number; longitude: number } | undefined | null): LatLng | undefined => p ? new LatLng(p.latitude, p.longitude, true) : undefined;
const bounds = (b: { northeast: any; southwest: any } | undefined | null): LatLngBounds | undefined => b ? new LatLngBounds(ll(b.southwest), ll(b.northeast)) : undefined;
const boundsNew = (b: { high: any; low: any } | undefined | null): LatLngBounds | undefined => b ? new LatLngBounds(llNew(b.low), llNew(b.high)) : undefined;
const secs = (d: string | number | undefined): number => typeof d === "number" ? d : +String(d ?? "0").replace(/s$/, "") || 0;
const durationText = (s: number): string => { const m = Math.round(s / 60), h = Math.floor(m / 60); return h ? `${h} hour${h > 1 ? "s" : ""}${m % 60 ? ` ${m % 60} min${m % 60 > 1 ? "s" : ""}` : ""}` : `${Math.max(1, m)} min${m > 1 ? "s" : ""}`; };
const distanceText = (m: number, imperial: boolean): string => imperial ? (m < 160.9 ? `${Math.round(m / 0.3048)} ft` : `${(m / 1609.344).toFixed(1)} mi`) : (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
/** Routes/Places (gRPC-style) error status → JS API status */
const statusOf = (grpc: string | undefined, http: number): string => grpc === "PERMISSION_DENIED" || grpc === "UNAUTHENTICATED" || http === 401 || http === 403 ? "REQUEST_DENIED" : grpc === "NOT_FOUND" ? "NOT_FOUND" : grpc === "INVALID_ARGUMENT" || http === 400 ? "INVALID_REQUEST" : grpc === "RESOURCE_EXHAUSTED" || http === 429 ? "OVER_QUERY_LIMIT" : "UNKNOWN_ERROR";
/** a place waypoint for the Routes API: LatLng-like, an address string, or { placeId } / { location } / { query } */
function waypoint(p: any): object {
	if (typeof p === "string") return { address: p };
	if (p && (p.placeId || p.place_id)) return { placeId: p.placeId || p.place_id };
	if (p && p.query) return { address: p.query };
	const q = p && p.location != null ? p.location : p;
	const c = toLatLng(q);
	return { location: { latLng: { latitude: c.lat(), longitude: c.lng() } } };
}
const RMODE: Record<string, string> = { DRIVING: "DRIVE", WALKING: "WALK", BICYCLING: "BICYCLE", TRANSIT: "TRANSIT", TWO_WHEELER: "TWO_WHEELER" };
const PLACE_FIELDS = "id,displayName,formattedAddress,location,viewport,rating,userRatingCount,types,primaryType,businessStatus,googleMapsUri,websiteUri,nationalPhoneNumber,internationalPhoneNumber,priceLevel,currentOpeningHours,regularOpeningHours,photos,addressComponents,utcOffsetMinutes,editorialSummary,plusCode";
const PRICE: Record<string, number> = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };

/** the services as a loosely typed bag (google.maps itself is untyped here; declaration emit cannot name classes with #private fields) */
export type Services = Record<string, any>;
export function createServices(ctx: ServiceCtx): Services {
	const needKey = (what: string, cb: Cb<any>): MapsRequestError | null => {
		if (ctx.apiKey) return null;
		unsupported(`google.maps.${what} (no apiKey: pass createGoogleMaps(ml, { apiKey }) or Loader({ apiKey }))`);
		cb?.(null, "REQUEST_DENIED");
		return new MapsRequestError("REQUEST_DENIED", `google.maps.${what} needs an API key: createGoogleMaps(maplibregl, { apiKey })`);
	};
	const f = (): typeof fetch => ctx.fetch ?? globalThis.fetch;
	/** legacy JSON web service (Geocoding, Elevation): key in the query; the body carries status */
	async function legacy(path: string, params: Record<string, string | undefined>): Promise<any> {
		const u = new URL(`https://maps.googleapis.com/maps/api/${path}/json`);
		for (const [k, v] of Object.entries(params)) if (v != null && v !== "") u.searchParams.set(k, v);
		if (ctx.language && !u.searchParams.has("language")) u.searchParams.set("language", ctx.language);
		if (ctx.region && !u.searchParams.has("region")) u.searchParams.set("region", ctx.region);
		u.searchParams.set("key", ctx.apiKey!);
		let r: Response;
		try { r = await f()(u.href); } catch (e) { throw new MapsRequestError("UNKNOWN_ERROR", String(e)); }
		const j = await r.json().catch(() => ({}));
		if (!r.ok && !j.status) throw new MapsRequestError(statusOf(undefined, r.status), j.error_message);
		if (j.status && j.status !== "OK") throw new MapsRequestError(j.status, j.error_message);
		return j;
	}
	/** Routes / Places (New): key and field mask in headers; errors are { error: { status } } */
	async function modern(url: string, body: object | null, fieldMask: string, method = body ? "POST" : "GET"): Promise<any> {
		const headers: Record<string, string> = { "X-Goog-Api-Key": ctx.apiKey!, "X-Goog-FieldMask": fieldMask };
		if (body) headers["Content-Type"] = "application/json";
		let r: Response;
		try { r = await f()(url, { method, headers, ...(body && { body: JSON.stringify(body) }) }); } catch (e) { throw new MapsRequestError("UNKNOWN_ERROR", String(e)); }
		const j = await r.json().catch(() => ({}));
		if (!r.ok) throw new MapsRequestError(statusOf(j?.error?.status, r.status), j?.error?.message);
		return j;
	}
	/** run a request: resolve and call back on success; on failure call back (null, status) and reject */
	async function run<T>(what: string, cb: Cb<T>, go: () => Promise<[T, ...any[]]>): Promise<T> {
		const e = needKey(what, cb);
		if (e) throw e;
		try { const [res, ...rest] = await go(); cb?.(res, "OK", ...rest); return res; }
		catch (err) { const st = err instanceof MapsRequestError ? err.code : "UNKNOWN_ERROR"; cb?.(null, st); throw err instanceof MapsRequestError ? err : new MapsRequestError(st, String(err)); }
	}

	// ── Geocoder（Geocoding API）──
	const geocodeResult = (r: any): any => ({ ...r, geometry: { ...r.geometry, location: ll(r.geometry?.location), viewport: bounds(r.geometry?.viewport), bounds: bounds(r.geometry?.bounds) } });
	class Geocoder {
		/** callback gets (results, status) as in Google; the promise resolves with { results } */
		geocode(req: Record<string, any>, cb?: Cb<any[]>): Promise<{ results: any[] }> {
			return run("Geocoder.geocode", cb && ((r: { results: any[] } | null, st: string) => cb(r ? r.results : null, st)), async () => {
				const p: Record<string, string | undefined> = { address: req.address, place_id: req.placeId, language: req.language, region: req.region };
				if (req.location) { const c = toLatLng(req.location); p.latlng = `${c.lat()},${c.lng()}`; }
				if (req.bounds) { const b = req.bounds instanceof LatLngBounds ? req.bounds.toJSON() : req.bounds; p.bounds = `${b.south},${b.west}|${b.north},${b.east}`; }
				if (req.componentRestrictions) p.components = Object.entries(req.componentRestrictions).map(([k, v]) => `${k.replace(/([A-Z])/g, "_$1").toLowerCase()}:${v}`).join("|");
				if (req.extraComputations?.length) p.extra_computations = req.extraComputations.join("|");
				const j = await legacy("geocode", p);
				return [{ results: (j.results || []).map(geocodeResult), plus_code: j.plus_code }];
			});
		}
	}

	// ── DirectionsService（Routes API computeRoutes）──
	const dist = (m: number, imperial: boolean, text?: string): { text: string; value: number } => ({ text: text ?? distanceText(m, imperial), value: Math.round(m) });
	const dur = (d: string | number | undefined, text?: string): { text: string; value: number } => { const s = secs(d); return { text: text ?? durationText(s), value: s }; };
	function directionsResult(j: any, req: Record<string, any>): any {
		const imperial = req.unitSystem === UnitSystem.IMPERIAL;
		const routes = (j.routes || []).map((r: any) => {
			const legs = (r.legs || []).map((g: any) => ({
				start_location: llNew(g.startLocation?.latLng), end_location: llNew(g.endLocation?.latLng),
				start_address: "", end_address: "",
				distance: dist(g.distanceMeters ?? 0, imperial, g.localizedValues?.distance?.text), duration: dur(g.duration, g.localizedValues?.duration?.text),
				steps: (g.steps || []).map((s: any) => ({
					instructions: s.navigationInstruction?.instructions ?? "", maneuver: (s.navigationInstruction?.maneuver ?? "").toLowerCase().replace(/_/g, "-"),
					distance: dist(s.distanceMeters ?? 0, imperial, s.localizedValues?.distance?.text), duration: dur(s.staticDuration, s.localizedValues?.staticDuration?.text),
					start_location: llNew(s.startLocation?.latLng), end_location: llNew(s.endLocation?.latLng),
					path: s.polyline?.encodedPolyline ? encoding.decodePath(s.polyline.encodedPolyline) : [], travel_mode: (s.travelMode === "DRIVE" ? "DRIVING" : s.travelMode === "WALK" ? "WALKING" : s.travelMode === "BICYCLE" ? "BICYCLING" : s.travelMode) || req.travelMode,
					transit: s.transitDetails,
				})),
				via_waypoints: [], traffic_speed_entry: [],
			}));
			const overview = r.polyline?.encodedPolyline ? encoding.decodePath(r.polyline.encodedPolyline) : legs.flatMap((g: any) => g.steps.flatMap((s: any) => s.path));
			const b = boundsNew(r.viewport) ?? overview.reduce((bb: LatLngBounds, p: LatLng) => bb.extend(p), new LatLngBounds());
			return { legs, overview_path: overview, overview_polyline: { points: r.polyline?.encodedPolyline ?? encoding.encodePath(overview) }, bounds: b, summary: r.description ?? "", warnings: r.warnings ?? [], waypoint_order: r.optimizedIntermediateWaypointIndex ?? [], copyrights: "Map data ©Google", fare: r.travelAdvisory?.transitFare, distanceMeters: r.distanceMeters, duration: dur(r.duration, r.localizedValues?.duration?.text) };
		});
		return { routes, geocoded_waypoints: [], request: req, status: "OK" };
	}
	class DirectionsService {
		route(req: Record<string, any>, cb?: Cb<any>): Promise<any> {
			return run("DirectionsService.route", cb, async () => {
				const mode = RMODE[req.travelMode] ?? "DRIVE";
				const body: Record<string, any> = {
					origin: waypoint(req.origin), destination: waypoint(req.destination), travelMode: mode,
					...(req.waypoints?.length && { intermediates: req.waypoints.map((w: any) => ({ ...waypoint(w.location ?? w), ...(w.stopover === false && { via: true }) })) }),
					...(req.optimizeWaypoints && { optimizeWaypointOrder: true }),
					...(req.provideRouteAlternatives && { computeAlternativeRoutes: true }),
					...((req.avoidTolls || req.avoidHighways || req.avoidFerries) && { routeModifiers: { avoidTolls: !!req.avoidTolls, avoidHighways: !!req.avoidHighways, avoidFerries: !!req.avoidFerries } }),
					...(mode === "DRIVE" && (req.drivingOptions?.departureTime || req.drivingOptions) && { routingPreference: "TRAFFIC_AWARE", ...(req.drivingOptions?.departureTime && { departureTime: new Date(req.drivingOptions.departureTime).toISOString() }) }),
					...(mode === "TRANSIT" && req.transitOptions && { transitPreferences: { ...(req.transitOptions.modes && { allowedTravelModes: req.transitOptions.modes }), ...(req.transitOptions.routingPreference && { routingPreference: req.transitOptions.routingPreference }) }, ...(req.transitOptions.departureTime && { departureTime: new Date(req.transitOptions.departureTime).toISOString() }), ...(req.transitOptions.arrivalTime && { arrivalTime: new Date(req.transitOptions.arrivalTime).toISOString() }) }),
					units: req.unitSystem === UnitSystem.IMPERIAL ? "IMPERIAL" : "METRIC",
					...((req.language ?? ctx.language) && { languageCode: req.language ?? ctx.language }), ...((req.region ?? ctx.region) && { regionCode: req.region ?? ctx.region }),
				};
				const j = await modern("https://routes.googleapis.com/directions/v2:computeRoutes", body, "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs,routes.description,routes.warnings,routes.viewport,routes.optimizedIntermediateWaypointIndex,routes.localizedValues,routes.travelAdvisory");
				if (!j.routes?.length) throw new MapsRequestError("ZERO_RESULTS");
				return [directionsResult(j, req)];
			});
		}
	}

	// ── DirectionsRenderer＝Polyline と Marker で描く・panel に案内を書く ──
	class DirectionsRenderer extends MVCObject {
		#o: Record<string, any>; #map: GMap | null = null; #dir: any = null; #idx = 0; #line: Polyline | null = null; #markers: Marker[] = [];
		constructor(o: Record<string, any> = {}) { super(); this.#o = { ...o }; if (o.map) this.setMap(o.map); if (o.directions) this.setDirections(o.directions); }
		#clear(): void { this.#line?.setMap(null); this.#line = null; for (const m of this.#markers) m.setMap(null); this.#markers = []; }
		#draw(): void {
			this.#clear();
			const r = this.#dir?.routes?.[this.#idx];
			if (!r || !this.#map) { if (this.#o.panel) this.#o.panel.replaceChildren(); return; }
			if (!this.#o.suppressPolylines) this.#line = new Polyline({ map: this.#map, path: r.overview_path, strokeColor: "#4285F4", strokeOpacity: 0.8, strokeWeight: 6, zIndex: 1, ...this.#o.polylineOptions });
			if (!this.#o.suppressMarkers) {
				const pts: LatLng[] = [];
				r.legs.forEach((g: any, i: number) => { if (i === 0 && g.start_location) pts.push(g.start_location); if (g.end_location) pts.push(g.end_location); });
				this.#markers = pts.map((p, i) => new Marker({ map: this.#map, position: p, label: String.fromCharCode(65 + i), ...this.#o.markerOptions }));
			}
			if (!this.#o.preserveViewport && r.bounds && !r.bounds.isEmpty()) this.#map.fitBounds(r.bounds, 40);
			const panel: HTMLElement | undefined = this.#o.panel;
			if (panel) {
				panel.replaceChildren();
				const esc = (s: string): string => s.replace(/<[^>]*>/g, "");
				for (const g of r.legs) {
					const h = document.createElement("div"); h.className = "gm-directions-leg"; h.textContent = `${g.distance.text} · ${g.duration.text}`; panel.appendChild(h);
					const ol = document.createElement("ol"); ol.className = "gm-directions-steps";
					for (const s of g.steps) { const li = document.createElement("li"); li.textContent = `${esc(s.instructions)} (${s.distance.text})`; ol.appendChild(li); }
					panel.appendChild(ol);
				}
			}
		}
		setMap(m: GMap | null): void { if (m === this.#map) return; this.#map = m; this.#draw(); }
		getMap(): GMap | null { return this.#map; }
		setDirections(d: any): void { this.#dir = d; this.#idx = 0; this.#draw(); event.trigger(this, "directions_changed"); }
		getDirections(): any { return this.#dir; }
		setRouteIndex(i: number): void { this.#idx = i; this.#draw(); }
		getRouteIndex(): number { return this.#idx; }
		setPanel(p: HTMLElement | null): void { this.#o.panel?.replaceChildren(); this.#o.panel = p; this.#draw(); }
		getPanel(): HTMLElement | null { return this.#o.panel ?? null; }
		setOptions(o: Record<string, any> = {}): void { const { map, directions, ...rest } = o; Object.assign(this.#o, rest); if (directions !== undefined) this.#dir = directions; if (map !== undefined) this.#map = map; this.#draw(); }
	}

	// ── DistanceMatrixService（Routes API computeRouteMatrix）──
	class DistanceMatrixService {
		getDistanceMatrix(req: Record<string, any>, cb?: Cb<any>): Promise<any> {
			return run("DistanceMatrixService.getDistanceMatrix", cb, async () => {
				const mode = RMODE[req.travelMode] ?? "DRIVE", imperial = req.unitSystem === UnitSystem.IMPERIAL;
				const body = { origins: req.origins.map((o: any) => ({ waypoint: waypoint(o) })), destinations: req.destinations.map((d: any) => ({ waypoint: waypoint(d) })), travelMode: mode, units: imperial ? "IMPERIAL" : "METRIC",
					...(mode === "DRIVE" && req.drivingOptions?.departureTime && { routingPreference: "TRAFFIC_AWARE", departureTime: new Date(req.drivingOptions.departureTime).toISOString() }),
					...((req.language ?? ctx.language) && { languageCode: req.language ?? ctx.language }), ...((req.region ?? ctx.region) && { regionCode: req.region ?? ctx.region }) };
				const j = await modern("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", body, "originIndex,destinationIndex,duration,distanceMeters,status,condition,localizedValues");
				const els: any[] = Array.isArray(j) ? j : j.elements ?? [];
				const rows = req.origins.map(() => ({ elements: req.destinations.map(() => ({ status: "NOT_FOUND" })) }));
				for (const e of els) rows[e.originIndex].elements[e.destinationIndex] = e.condition === "ROUTE_EXISTS" ? { status: "OK", distance: dist(e.distanceMeters ?? 0, imperial, e.localizedValues?.distance?.text), duration: dur(e.duration, e.localizedValues?.duration?.text) } : { status: e.status?.code ? "NOT_FOUND" : "ZERO_RESULTS" };
				const addr = (p: any): string => typeof p === "string" ? p : p?.placeId ? p.placeId : (() => { const c = toLatLng(p.location ?? p); return `${c.lat()},${c.lng()}`; })();
				return [{ originAddresses: req.origins.map(addr), destinationAddresses: req.destinations.map(addr), rows }];
			});
		}
	}

	// ── ElevationService（Elevation API）──
	const elev = (r: any): any => ({ elevation: r.elevation, location: ll(r.location), resolution: r.resolution });
	const locs = (a: LatLngLike[]): string => a.map(p => { const c = toLatLng(p); return `${c.lat()},${c.lng()}`; }).join("|");
	class ElevationService {
		getElevationForLocations(req: { locations: LatLngLike[] }, cb?: Cb<any[]>): Promise<{ results: any[] }> {
			return run("ElevationService.getElevationForLocations", cb && ((r: { results: any[] } | null, st: string) => cb(r ? r.results : null, st)), async () => [{ results: (await legacy("elevation", { locations: locs(req.locations) })).results.map(elev) }]);
		}
		getElevationAlongPath(req: { path: LatLngLike[]; samples: number }, cb?: Cb<any[]>): Promise<{ results: any[] }> {
			return run("ElevationService.getElevationAlongPath", cb && ((r: { results: any[] } | null, st: string) => cb(r ? r.results : null, st)), async () => [{ results: (await legacy("elevation", { path: locs(req.path), samples: String(req.samples) })).results.map(elev) }]);
		}
	}

	// ── places（Places API New）──
	const placeResult = (p: any): any => {
		const hours = (h: any) => h && { open_now: h.openNow, weekday_text: h.weekdayDescriptions, periods: h.periods };
		return {
			place_id: p.id, name: p.displayName?.text ?? "", formatted_address: p.formattedAddress, vicinity: p.shortFormattedAddress ?? p.formattedAddress,
			geometry: { location: llNew(p.location), viewport: boundsNew(p.viewport) },
			rating: p.rating, user_ratings_total: p.userRatingCount, types: p.types ?? [], business_status: p.businessStatus, url: p.googleMapsUri, website: p.websiteUri,
			formatted_phone_number: p.nationalPhoneNumber, international_phone_number: p.internationalPhoneNumber, price_level: p.priceLevel != null ? PRICE[p.priceLevel] : undefined,
			opening_hours: hours(p.currentOpeningHours ?? p.regularOpeningHours), utc_offset_minutes: p.utcOffsetMinutes, plus_code: p.plusCode && { global_code: p.plusCode.globalCode, compound_code: p.plusCode.compoundCode },
			address_components: (p.addressComponents ?? []).map((c: any) => ({ long_name: c.longText, short_name: c.shortText, types: c.types })),
			editorial_summary: p.editorialSummary && { overview: p.editorialSummary.text },
			photos: (p.photos ?? []).map((ph: any) => ({ height: ph.heightPx, width: ph.widthPx, html_attributions: (ph.authorAttributions ?? []).map((a: any) => `<a href="${a.uri}">${a.displayName}</a>`),
				getUrl: (o: { maxWidth?: number; maxHeight?: number } = {}) => `https://places.googleapis.com/v1/${ph.name}/media?key=${encodeURIComponent(ctx.apiKey!)}${o.maxWidth ? `&maxWidthPx=${o.maxWidth}` : ""}${o.maxHeight ? `&maxHeightPx=${o.maxHeight}` : ""}${!o.maxWidth && !o.maxHeight ? "&maxWidthPx=1600" : ""}` })),
		};
	};
	const circle = (center: any, radius: number) => { const c = toLatLng(center); return { circle: { center: { latitude: c.lat(), longitude: c.lng() }, radius: Math.min(50000, Math.max(0, +radius || 5000)) } }; };
	const rect = (b: any) => { const j = b instanceof LatLngBounds ? b.toJSON() : b; return { rectangle: { low: { latitude: j.south, longitude: j.west }, high: { latitude: j.north, longitude: j.east } } }; };
	const placesFields = (fields?: string[]): string => fields?.length ? [...new Set(fields.flatMap(f => f === "geometry" || f.startsWith("geometry") ? ["location", "viewport"] : f === "name" ? ["displayName"] : f === "place_id" ? ["id"] : f === "formatted_address" ? ["formattedAddress"] : f === "photos" || f === "photo" ? ["photos"] : f === "rating" ? ["rating"] : f === "user_ratings_total" ? ["userRatingCount"] : f === "opening_hours" ? ["currentOpeningHours", "regularOpeningHours"] : f === "website" ? ["websiteUri"] : f === "url" ? ["googleMapsUri"] : f === "formatted_phone_number" ? ["nationalPhoneNumber"] : f === "international_phone_number" ? ["internationalPhoneNumber"] : f === "price_level" ? ["priceLevel"] : f === "types" ? ["types"] : f === "business_status" ? ["businessStatus"] : f === "address_components" ? ["addressComponents"] : f === "vicinity" ? ["shortFormattedAddress"] : f === "utc_offset_minutes" ? ["utcOffsetMinutes"] : f === "plus_code" ? ["plusCode"] : f === "editorial_summary" ? ["editorialSummary"] : f === "reviews" ? ["reviews"] : ["id", "displayName"]))].join(",") : PLACE_FIELDS;
	const search = async (url: string, body: object, fields?: string[]): Promise<any[]> => ((await modern(url, body, placesFields(fields).split(",").map(x => `places.${x}`).join(","))).places ?? []).map(placeResult);
	const searchCb = (cb: Cb<any[]>): Cb<any[]> => cb && ((r, st) => cb(r, r && !r.length ? "ZERO_RESULTS" : st, { hasNextPage: false, nextPage() {} }));
	class PlacesService {
		constructor(_attrContainer?: unknown) {}
		textSearch(req: Record<string, any>, cb?: Cb<any[]>): Promise<any[]> {
			return run("places.PlacesService.textSearch", searchCb(cb), async () => [await search("https://places.googleapis.com/v1/places:searchText", {
				textQuery: req.query, ...(req.type && { includedType: req.type }), ...(req.location && req.radius && { locationBias: circle(req.location, req.radius) }), ...(req.bounds && { locationBias: rect(req.bounds) }),
				...(req.openNow && { openNow: true }), ...(req.minPriceLevel != null && { priceLevels: Object.keys(PRICE).filter(k => PRICE[k] >= (req.minPriceLevel ?? 0) && PRICE[k] <= (req.maxPriceLevel ?? 4)) }), ...((req.language ?? ctx.language) && { languageCode: req.language ?? ctx.language }), ...((req.region ?? ctx.region) && { regionCode: req.region ?? ctx.region }) })]);
		}
		nearbySearch(req: Record<string, any>, cb?: Cb<any[]>): Promise<any[]> {
			return run("places.PlacesService.nearbySearch", searchCb(cb), async () => {
				const center = req.location ?? (req.bounds && (req.bounds instanceof LatLngBounds ? req.bounds : new LatLngBounds(req.bounds)).getCenter());
				const radius = req.radius ?? (req.rankBy === RankBy.DISTANCE ? 5000 : 5000);
				// the new API's nearby search has no keyword: a keyword or name goes through text search biased to the circle
				if (req.keyword || req.name) return [await search("https://places.googleapis.com/v1/places:searchText", { textQuery: req.keyword ?? req.name, ...(req.type && { includedType: req.type }), locationBias: circle(center, radius), rankPreference: req.rankBy === RankBy.DISTANCE ? "DISTANCE" : "RELEVANCE", ...(req.openNow && { openNow: true }), ...((req.language ?? ctx.language) && { languageCode: req.language ?? ctx.language }) })];
				return [await search("https://places.googleapis.com/v1/places:searchNearby", { locationRestriction: circle(center, radius), ...(req.type && { includedTypes: [req.type] }), ...(req.rankBy === RankBy.DISTANCE && { rankPreference: "DISTANCE" }), maxResultCount: 20, ...((req.language ?? ctx.language) && { languageCode: req.language ?? ctx.language }) })];
			});
		}
		findPlaceFromQuery(req: Record<string, any>, cb?: Cb<any[]>): Promise<any[]> {
			return run("places.PlacesService.findPlaceFromQuery", searchCb(cb), async () => [await search("https://places.googleapis.com/v1/places:searchText", { textQuery: req.query, maxResultCount: 1, ...(req.locationBias && (req.locationBias.radius != null ? { locationBias: circle(req.locationBias.center ?? req.locationBias, req.locationBias.radius) } : "north" in (req.locationBias.toJSON?.() ?? req.locationBias) ? { locationBias: rect(req.locationBias) } : { locationBias: circle(req.locationBias, 5000) })) }, req.fields)]);
		}
		getDetails(req: Record<string, any>, cb?: Cb<any>): Promise<any> {
			return run("places.PlacesService.getDetails", cb, async () => {
				const u = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(req.placeId)}`);
				if (req.language ?? ctx.language) u.searchParams.set("languageCode", req.language ?? ctx.language);
				if (req.region ?? ctx.region) u.searchParams.set("regionCode", req.region ?? ctx.region);
				if (req.sessionToken) u.searchParams.set("sessionToken", String(req.sessionToken));
				const p = await modern(u.href, null, placesFields(req.fields));
				return [{ ...placeResult(p), reviews: (p.reviews ?? []).map((r: any) => ({ author_name: r.authorAttribution?.displayName, author_url: r.authorAttribution?.uri, profile_photo_url: r.authorAttribution?.photoUri, rating: r.rating, text: r.text?.text, relative_time_description: r.relativePublishTimeDescription, time: r.publishTime && Math.floor(new Date(r.publishTime).getTime() / 1000), language: r.text?.languageCode })) }];
			});
		}
	}
	class AutocompleteSessionToken { readonly token = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`); toString(): string { return this.token; } }
	const prediction = (s: any): any => { const p = s.placePrediction; return { place_id: p.placeId, description: p.text?.text ?? "", structured_formatting: { main_text: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "", secondary_text: p.structuredFormat?.secondaryText?.text ?? "", main_text_matched_substrings: (p.structuredFormat?.mainText?.matches ?? []).map((m: any) => ({ offset: m.startOffset ?? 0, length: (m.endOffset ?? 0) - (m.startOffset ?? 0) })) }, matched_substrings: (p.text?.matches ?? []).map((m: any) => ({ offset: m.startOffset ?? 0, length: (m.endOffset ?? 0) - (m.startOffset ?? 0) })), types: p.types ?? [], terms: (p.text?.text ?? "").split(/,\s*/).reduce((a: any[], t: string) => { a.push({ offset: a.length ? a[a.length - 1].offset + a[a.length - 1].value.length + 2 : 0, value: t }); return a; }, []), distance_meters: p.distanceMeters }; };
	class AutocompleteService {
		getPlacePredictions(req: Record<string, any>, cb?: Cb<any[]>): Promise<{ predictions: any[] }> {
			return run("places.AutocompleteService.getPlacePredictions", cb && ((r: { predictions: any[] } | null, st: string) => cb(r ? r.predictions : null, r && !r.predictions.length ? "ZERO_RESULTS" : st)), async () => {
				const body: Record<string, any> = { input: req.input, ...(req.sessionToken && { sessionToken: String(req.sessionToken) }), ...((req.language ?? ctx.language) && { languageCode: req.language ?? ctx.language }), ...((req.region ?? ctx.region) && { regionCode: req.region ?? ctx.region }) };
				const bias = req.locationBias ?? (req.location && req.radius ? { center: req.location, radius: req.radius } : req.bounds);
				if (bias) body.locationBias = bias.radius != null ? circle(bias.center ?? bias, bias.radius) : "north" in (bias.toJSON?.() ?? bias) ? rect(bias) : circle(bias, 20000);
				if (req.locationRestriction) body.locationRestriction = rect(req.locationRestriction);
				if (req.origin) { const c = toLatLng(req.origin); body.origin = { latitude: c.lat(), longitude: c.lng() }; }
				const cc = req.componentRestrictions?.country; if (cc) body.includedRegionCodes = (Array.isArray(cc) ? cc : [cc]).map((x: string) => x.toLowerCase());
				if (req.types?.length) body.includedPrimaryTypes = req.types.map((t: string) => t === "(cities)" ? "locality" : t === "(regions)" ? "administrative_area_level_1" : t === "establishment" ? "establishment" : t);
				const j = await modern("https://places.googleapis.com/v1/places:autocomplete", body, "*");
				return [{ predictions: (j.suggestions ?? []).filter((s: any) => s.placePrediction).map(prediction) }];
			});
		}
		getQueryPredictions(req: Record<string, any>, cb?: Cb<any[]>): Promise<{ predictions: any[] }> { return this.getPlacePredictions(req, cb); }
	}
	/** places.Autocomplete on an <input>: a dropdown of predictions; picking one loads the details and fires place_changed */
	class Autocomplete extends MVCObject {
		#input: HTMLInputElement; #o: Record<string, any>; #place: any = null; #list: HTMLElement | null = null; #token = new AutocompleteSessionToken(); #svc = new AutocompleteService(); #ps = new PlacesService(); #timer = 0;
		constructor(input: HTMLInputElement, o: Record<string, any> = {}) {
			super(); this.#input = input; this.#o = { ...o };
			input.setAttribute("autocomplete", "off");
			input.addEventListener("input", () => { clearTimeout(this.#timer); this.#timer = setTimeout(() => this.#query(), 250) as unknown as number; });
			input.addEventListener("keydown", e => { if (e.key === "Escape") this.#close(); });
			input.addEventListener("blur", () => setTimeout(() => this.#close(), 200));
		}
		async #query(): Promise<void> {
			const v = this.#input.value.trim();
			if (!v) { this.#close(); return; }
			let preds: any[] = [];
			try { preds = (await this.#svc.getPlacePredictions({ input: v, sessionToken: this.#token, bounds: this.#o.bounds, componentRestrictions: this.#o.componentRestrictions, types: this.#o.types, ...(this.#o.strictBounds && this.#o.bounds && { locationRestriction: this.#o.bounds }) })).predictions; } catch { preds = []; }
			if (!preds.length) { this.#close(); return; }
			if (!this.#list) {
				this.#list = document.createElement("div"); this.#list.className = "pac-container";
				const r = this.#input.getBoundingClientRect();
				Object.assign(this.#list.style, { position: "absolute", left: `${r.left + window.scrollX}px`, top: `${r.bottom + window.scrollY}px`, width: `${r.width}px`, background: "#fff", border: "1px solid #ccc", borderTop: "none", boxShadow: "0 2px 6px rgba(0,0,0,.3)", zIndex: "1000", font: "13px Arial,sans-serif", cursor: "pointer" });
				document.body.appendChild(this.#list);
			}
			this.#list.replaceChildren(...preds.map(p => { const d = document.createElement("div"); d.className = "pac-item"; d.style.cssText = "padding:6px 8px;border-top:1px solid #e6e6e6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"; d.textContent = p.description; d.addEventListener("mousedown", e => { e.preventDefault(); this.#pick(p); }); return d; }));
		}
		#close(): void { this.#list?.remove(); this.#list = null; }
		async #pick(p: any): Promise<void> {
			this.#input.value = p.description; this.#close();
			try { this.#place = await this.#ps.getDetails({ placeId: p.place_id, fields: this.#o.fields, sessionToken: this.#token }); } catch { this.#place = { place_id: p.place_id, name: p.structured_formatting.main_text }; }
			this.#token = new AutocompleteSessionToken();
			event.trigger(this, "place_changed");
		}
		getPlace(): any { return this.#place; }
		getBounds(): any { return this.#o.bounds; }
		setBounds(b: any): void { this.#o.bounds = b; }
		setComponentRestrictions(c: any): void { this.#o.componentRestrictions = c; }
		setFields(f: string[]): void { this.#o.fields = f; }
		setTypes(t: string[]): void { this.#o.types = t; }
		setOptions(o: Record<string, any>): void { Object.assign(this.#o, o); }
		bindTo(k: string, target?: any): void { if (k === "bounds" && target?.getBounds) { const upd = () => { this.#o.bounds = target.getBounds(); }; upd(); target.addListener?.("bounds_changed", upd); } }
	}

	// ── Street View：metadata API（StreetViewService）と Static API（StreetViewPanorama＝静止画・ドラッグで向きを変えて撮り直す）──
	//   Google は JS API の外にパノラマのタイルを出していない＝滑らかな 360° はここでは作れない。静止画の口だけ同じ形にする
	const panoData = (j: any): any => ({ location: { pano: j.pano_id, latLng: ll(j.location), description: j.copyright, shortDescription: "" }, copyright: j.copyright, imageDate: j.date, links: [], tiles: { worldSize: { width: 0, height: 0 }, tileSize: { width: 0, height: 0 }, centerHeading: 0 } });
	class StreetViewService {
		getPanorama(req: Record<string, any>, cb?: Cb<any>): Promise<{ data: any }> {
			return run("StreetViewService.getPanorama", cb && ((r: { data: any } | null, st: string) => cb(r ? r.data : null, st === "NOT_FOUND" ? "ZERO_RESULTS" : st)), async () => {
				const u = new URL("https://maps.googleapis.com/maps/api/streetview/metadata");
				if (req.pano) u.searchParams.set("pano", req.pano);
				else if (req.location) { const c = toLatLng(req.location); u.searchParams.set("location", `${c.lat()},${c.lng()}`); u.searchParams.set("radius", String(req.radius ?? 50)); }
				if (req.source === "outdoor") u.searchParams.set("source", "outdoor");
				u.searchParams.set("key", ctx.apiKey!);
				let r: Response;
				try { r = await f()(u.href); } catch (e) { throw new MapsRequestError("UNKNOWN_ERROR", String(e)); }
				const j = await r.json().catch(() => ({}));
				if (j.status !== "OK") throw new MapsRequestError(j.status === "ZERO_RESULTS" || j.status === "NOT_FOUND" ? "ZERO_RESULTS" : statusOf(undefined, r.status), j.error_message);
				return [{ data: panoData(j) }];
			});
		}
	}
	class StreetViewPanorama extends MVCObject {
		#el: HTMLElement; #img: HTMLImageElement | null = null; #pos: LatLng | null = null; #pano: string | null = null; #pov = { heading: 0, pitch: 0 }; #zoom = 1; #visible = true; #status = "UNKNOWN_ERROR"; #loc: any = null; #timer = 0; #svc = new StreetViewService();
		controls: unknown[] = [];
		constructor(container: HTMLElement, o: Record<string, any> = {}) {
			super(); this.#el = container;
			if (typeof document !== "undefined") {
				container.style.position ||= "relative"; container.style.overflow = "hidden"; container.style.background = "#222";
				const img = this.#img = document.createElement("img");
				Object.assign(img.style, { width: "100%", height: "100%", objectFit: "cover", display: "block", userSelect: "none", cursor: "grab" }); img.draggable = false;
				container.appendChild(img);
				let drag: { x: number; y: number; h: number; p: number } | null = null;
				const fovPerPx = (): number => this.#fov() / Math.max(1, container.clientWidth || 640);
				img.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, h: this.#pov.heading, p: this.#pov.pitch }; img.setPointerCapture(e.pointerId); img.style.cursor = "grabbing"; });
				img.addEventListener("pointermove", e => { if (!drag) return; this.#pov = { heading: ((drag.h - (e.clientX - drag.x) * fovPerPx()) % 360 + 360) % 360, pitch: Math.max(-90, Math.min(90, drag.p + (e.clientY - drag.y) * fovPerPx())) }; event.trigger(this, "pov_changed"); this.#refresh(150); });
				img.addEventListener("pointerup", () => { drag = null; img.style.cursor = "grab"; this.#refresh(0); });
				img.addEventListener("wheel", e => { e.preventDefault(); this.setZoom(Math.max(0, Math.min(4, this.#zoom + (e.deltaY < 0 ? 0.5 : -0.5)))); }, { passive: false });
			}
			if (o.pov) this.#pov = { heading: o.pov.heading ?? 0, pitch: o.pov.pitch ?? 0 };
			if (o.zoom != null) this.#zoom = o.zoom;
			if (o.visible === false) this.setVisible(false);
			if (o.pano) this.setPano(o.pano); else if (o.position) this.setPosition(o.position);
			for (const k of ["addressControl", "linksControl", "panControl", "zoomControl", "enableCloseButton", "fullscreenControl", "motionTracking", "showRoadLabels"]) if (o[k] != null) unsupported(`StreetViewPanorama option ${k}`);
		}
		#fov(): number { return Math.min(120, Math.max(10, 180 / Math.pow(2, this.#zoom))); }
		#url(): string | null {
			if (!ctx.apiKey || (!this.#pos && !this.#pano)) return null;
			const u = new URL("https://maps.googleapis.com/maps/api/streetview");
			const w = Math.min(640, Math.max(64, this.#el.clientWidth || 640)), h = Math.min(640, Math.max(64, this.#el.clientHeight || 640));
			u.searchParams.set("size", `${Math.round(w)}x${Math.round(h)}`);
			if (this.#pano) u.searchParams.set("pano", this.#pano); else u.searchParams.set("location", `${this.#pos!.lat()},${this.#pos!.lng()}`);
			u.searchParams.set("heading", String(Math.round(this.#pov.heading * 100) / 100)); u.searchParams.set("pitch", String(Math.round(this.#pov.pitch * 100) / 100)); u.searchParams.set("fov", String(Math.round(this.#fov())));
			u.searchParams.set("return_error_code", "true"); u.searchParams.set("key", ctx.apiKey);
			return u.href;
		}
		#refresh(delay: number): void {
			clearTimeout(this.#timer);
			const go = (): void => { const u = this.#url(); if (this.#img && u && this.#visible) this.#img.src = u; };
			if (delay) this.#timer = setTimeout(go, delay) as unknown as number; else go();
		}
		async #lookup(req: Record<string, any>): Promise<void> {
			if (!ctx.apiKey) { needKey("StreetViewPanorama", undefined); return; }
			try {
				const { data } = await this.#svc.getPanorama(req);
				this.#loc = data.location; this.#pano = data.location.pano; this.#pos = data.location.latLng ?? this.#pos; this.#status = "OK";
				event.trigger(this, "pano_changed"); event.trigger(this, "position_changed");
			} catch (e) { this.#status = (e as MapsRequestError).code ?? "UNKNOWN_ERROR"; this.#loc = null; }
			event.trigger(this, "status_changed");
			this.#refresh(0);
		}
		getPosition(): LatLng | null { return this.#pos; }
		setPosition(p: LatLngLike): void { this.#pos = toLatLng(p); this.#pano = null; event.trigger(this, "position_changed"); this.#refresh(0); this.#lookup({ location: this.#pos, radius: 50 }); }
		getPano(): string | null { return this.#pano; }
		setPano(id: string): void { this.#pano = id; event.trigger(this, "pano_changed"); this.#refresh(0); this.#lookup({ pano: id }); }
		getPov(): { heading: number; pitch: number } { return { ...this.#pov }; }
		setPov(p: { heading?: number; pitch?: number }): void { this.#pov = { heading: p.heading ?? this.#pov.heading, pitch: p.pitch ?? this.#pov.pitch }; event.trigger(this, "pov_changed"); this.#refresh(0); }
		getZoom(): number { return this.#zoom; }
		setZoom(z: number): void { this.#zoom = z; event.trigger(this, "zoom_changed"); this.#refresh(0); }
		getVisible(): boolean { return this.#visible; }
		setVisible(v: boolean): void { this.#visible = v; this.#el.style.display = v ? "" : "none"; event.trigger(this, "visible_changed"); if (v) this.#refresh(0); }
		getStatus(): string { return this.#status; }
		getLocation(): any { return this.#loc; }
		getLinks(): unknown[] { return []; }
		getPhotographerPov(): { heading: number; pitch: number } { return { heading: 0, pitch: 0 }; }
		getMotionTracking(): boolean { return false; }
		setMotionTracking(): void {}
		registerPanoProvider(): void { unsupported("StreetViewPanorama.registerPanoProvider"); }
		focus(): void { this.#img?.focus(); }
		setOptions(o: Record<string, any> = {}): void { if (o.pov) this.setPov(o.pov); if (o.zoom != null) this.setZoom(o.zoom); if (o.visible != null) this.setVisible(o.visible); if (o.pano) this.setPano(o.pano); else if (o.position) this.setPosition(o.position); }
		/** the URL of the current still (the Static API image) */
		getImageUrl(): string | null { return this.#url(); }
	}
	const StreetViewStatus = { OK: "OK", UNKNOWN_ERROR: "UNKNOWN_ERROR", ZERO_RESULTS: "ZERO_RESULTS" } as const;
	const StreetViewSource = { DEFAULT: "default", OUTDOOR: "outdoor", GOOGLE: "google" } as const;

	const places = { PlacesService, AutocompleteService, Autocomplete, AutocompleteSessionToken, PlacesServiceStatus, RankBy, BusinessStatus };
	return { Geocoder, GeocoderStatus, DirectionsService, DirectionsRenderer, DirectionsStatus, TravelMode, UnitSystem, TrafficModel, DistanceMatrixService, DistanceMatrixStatus, DistanceMatrixElementStatus, ElevationService, ElevationStatus, places, StreetViewService, StreetViewPanorama, StreetViewStatus, StreetViewSource, MapsRequestError };
}
