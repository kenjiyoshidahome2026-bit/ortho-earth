// Leaflet's plain values: LatLng, LatLngBounds, Point, Bounds, Transformation, Projection, CRS. No engine: shared by the map and every layer.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Util } from "./core.ts";
const { formatNum } = Util;

// ── Point / Bounds (pixels) ──
export class Point {
	x: number; y: number;
	constructor(x: number, y: number, round?: boolean) { this.x = round ? Math.round(x) : x; this.y = round ? Math.round(y) : y; }
	clone(): Point { return new Point(this.x, this.y); }
	add(p: PointLike): Point { const q = toPoint(p)!; return new Point(this.x + q.x, this.y + q.y); }
	_add(p: Point): this { this.x += p.x; this.y += p.y; return this; }
	subtract(p: PointLike): Point { const q = toPoint(p)!; return new Point(this.x - q.x, this.y - q.y); }
	_subtract(p: Point): this { this.x -= p.x; this.y -= p.y; return this; }
	divideBy(n: number): Point { return new Point(this.x / n, this.y / n); }
	_divideBy(n: number): this { this.x /= n; this.y /= n; return this; }
	multiplyBy(n: number): Point { return new Point(this.x * n, this.y * n); }
	_multiplyBy(n: number): this { this.x *= n; this.y *= n; return this; }
	scaleBy(p: Point): Point { return new Point(this.x * p.x, this.y * p.y); }
	unscaleBy(p: Point): Point { return new Point(this.x / p.x, this.y / p.y); }
	round(): Point { return new Point(Math.round(this.x), Math.round(this.y)); }
	_round(): this { this.x = Math.round(this.x); this.y = Math.round(this.y); return this; }
	floor(): Point { return new Point(Math.floor(this.x), Math.floor(this.y)); }
	_floor(): this { this.x = Math.floor(this.x); this.y = Math.floor(this.y); return this; }
	ceil(): Point { return new Point(Math.ceil(this.x), Math.ceil(this.y)); }
	trunc(): Point { return new Point(Math.trunc(this.x), Math.trunc(this.y)); }
	distanceTo(p: PointLike): number { const q = toPoint(p)!; return Math.hypot(q.x - this.x, q.y - this.y); }
	equals(p: PointLike): boolean { const q = toPoint(p)!; return q.x === this.x && q.y === this.y; }
	contains(p: PointLike): boolean { const q = toPoint(p)!; return Math.abs(q.x) <= Math.abs(this.x) && Math.abs(q.y) <= Math.abs(this.y); }
	toString(): string { return `Point(${formatNum(this.x)}, ${formatNum(this.y)})`; }
}
export type PointLike = Point | [number, number] | { x: number; y: number };
/** L.point(x, y) / L.point([x, y]) / L.point({x, y}) */
export function toPoint(x: any, y?: number, round?: boolean): Point | undefined {
	if (x instanceof Point) return x;
	if (Array.isArray(x)) return new Point(x[0], x[1]);
	if (x === undefined || x === null) return x;
	if (typeof x === "object" && "x" in x && "y" in x) return new Point(x.x, x.y);
	return new Point(x, y!, round);
}

export class Bounds {
	min?: Point; max?: Point;
	constructor(a?: any, b?: any) { if (!a) return; for (const p of b ? [a, b] : a) this.extend(p); }
	extend(obj: any): this {
		let min2: Point, max2: Point;
		if (!obj) return this;
		if (obj instanceof Point || typeof obj[0] === "number" || "x" in obj) min2 = max2 = toPoint(obj)!;
		else { const b = toBounds(obj); min2 = b.min!; max2 = b.max!; if (!min2 || !max2) return this; }
		if (!this.min && !this.max) { this.min = min2.clone(); this.max = max2.clone(); }
		else { this.min!.x = Math.min(min2.x, this.min!.x); this.max!.x = Math.max(max2.x, this.max!.x); this.min!.y = Math.min(min2.y, this.min!.y); this.max!.y = Math.max(max2.y, this.max!.y); }
		return this;
	}
	getCenter(round?: boolean): Point { return new Point((this.min!.x + this.max!.x) / 2, (this.min!.y + this.max!.y) / 2, round); }
	getBottomLeft(): Point { return new Point(this.min!.x, this.max!.y); }
	getTopRight(): Point { return new Point(this.max!.x, this.min!.y); }
	getTopLeft(): Point { return this.min!; }
	getBottomRight(): Point { return this.max!; }
	getSize(): Point { return this.max!.subtract(this.min!); }
	contains(obj: any): boolean {
		let min: Point, max: Point;
		if (typeof obj[0] === "number" || obj instanceof Point) obj = toPoint(obj); else obj = toBounds(obj);
		if (obj instanceof Bounds) { min = obj.min!; max = obj.max!; } else min = max = obj;
		return min.x >= this.min!.x && max.x <= this.max!.x && min.y >= this.min!.y && max.y <= this.max!.y;
	}
	intersects(b: any): boolean { const o = toBounds(b); return o.max!.x >= this.min!.x && o.min!.x <= this.max!.x && o.max!.y >= this.min!.y && o.min!.y <= this.max!.y; }
	overlaps(b: any): boolean { const o = toBounds(b); return o.max!.x > this.min!.x && o.min!.x < this.max!.x && o.max!.y > this.min!.y && o.min!.y < this.max!.y; }
	isValid(): boolean { return !!(this.min && this.max); }
	pad(r: number): Bounds { const dx = Math.abs(this.min!.x - this.max!.x) * r, dy = Math.abs(this.min!.y - this.max!.y) * r; return toBounds(toPoint([this.min!.x - dx, this.min!.y - dy]), toPoint([this.max!.x + dx, this.max!.y + dy])); }
	equals(b: any): boolean { if (!b) return false; const o = toBounds(b); return this.min!.equals(o.getTopLeft()) && this.max!.equals(o.getBottomRight()); }
}
export function toBounds(a: any, b?: any): Bounds { return !a || a instanceof Bounds ? a : new Bounds(a, b); }

export class Transformation {
	_a: number; _b: number; _c: number; _d: number;
	constructor(a: number | number[], b?: number, c?: number, d?: number) {
		if (Array.isArray(a)) { this._a = a[0]; this._b = a[1]; this._c = a[2]; this._d = a[3]; return; }
		this._a = a; this._b = b!; this._c = c!; this._d = d!;
	}
	transform(p: Point, scale?: number): Point { return this._transform(p.clone(), scale); }
	_transform(p: Point, scale = 1): Point { p.x = scale * (this._a * p.x + this._b); p.y = scale * (this._c * p.y + this._d); return p; }
	untransform(p: Point, scale = 1): Point { return new Point((p.x / scale - this._b) / this._a, (p.y / scale - this._d) / this._c); }
}
export const toTransformation = (a: number | number[], b?: number, c?: number, d?: number): Transformation => new Transformation(a, b, c, d);

// ── LatLng / LatLngBounds ──
export class LatLng {
	lat: number; lng: number; alt?: number;
	constructor(lat: number, lng: number, alt?: number) {
		if (isNaN(lat) || isNaN(lng)) throw new Error(`Invalid LatLng object: (${lat}, ${lng})`);
		this.lat = +lat; this.lng = +lng;
		if (alt !== undefined) this.alt = +alt;
	}
	equals(obj: any, maxMargin?: number): boolean {
		if (!obj) return false;
		const o = toLatLng(obj);
		return !!o && Math.max(Math.abs(this.lat - o.lat), Math.abs(this.lng - o.lng)) <= (maxMargin === undefined ? 1.0e-9 : maxMargin);
	}
	toString(precision?: number): string { return `LatLng(${formatNum(this.lat, precision)}, ${formatNum(this.lng, precision)})`; }
	distanceTo(other: any): number { return Earth.distance(this, toLatLng(other)!); }
	wrap(): LatLng { return EPSG3857.wrapLatLng(this); }
	toBounds(sizeInMeters: number): LatLngBounds {
		const latAccuracy = 180 * sizeInMeters / 40075017, lngAccuracy = latAccuracy / Math.cos((Math.PI / 180) * this.lat);
		return toLatLngBounds([this.lat - latAccuracy, this.lng - lngAccuracy], [this.lat + latAccuracy, this.lng + lngAccuracy]);
	}
	clone(): LatLng { return new LatLng(this.lat, this.lng, this.alt); }
}
export type LatLngLike = LatLng | [number, number] | [number, number, number] | { lat: number; lng?: number; lon?: number; alt?: number };
/** L.latLng(lat, lng) / L.latLng([lat, lng]) / L.latLng({lat, lng}) (also {lat, lon}) */
export function toLatLng(a: any, b?: number, c?: number): LatLng | null {
	if (a instanceof LatLng) return a;
	if (Array.isArray(a) && typeof a[0] !== "object") return a.length === 3 ? new LatLng(a[0], a[1], a[2]) : a.length === 2 ? new LatLng(a[0], a[1]) : null;
	if (a === undefined || a === null) return a;
	if (typeof a === "object" && "lat" in a) return new LatLng(a.lat, "lng" in a ? a.lng : a.lon, a.alt);
	if (b === undefined) return null;
	return new LatLng(a, b, c);
}

export class LatLngBounds {
	_southWest?: LatLng; _northEast?: LatLng;
	constructor(c1?: any, c2?: any) { if (!c1) return; for (const p of c2 ? [c1, c2] : c1) this.extend(p); }
	extend(obj: any): this {
		let sw2: LatLng, ne2: LatLng;
		if (obj instanceof LatLng) sw2 = ne2 = obj;
		else if (obj instanceof LatLngBounds) { sw2 = obj._southWest!; ne2 = obj._northEast!; if (!sw2 || !ne2) return this; }
		else return obj ? this.extend((toLatLng(obj) || toLatLngBounds(obj)) as any) : this;
		const sw = this._southWest, ne = this._northEast;
		if (!sw && !ne) { this._southWest = new LatLng(sw2.lat, sw2.lng); this._northEast = new LatLng(ne2.lat, ne2.lng); }
		else { sw!.lat = Math.min(sw2.lat, sw!.lat); sw!.lng = Math.min(sw2.lng, sw!.lng); ne!.lat = Math.max(ne2.lat, ne!.lat); ne!.lng = Math.max(ne2.lng, ne!.lng); }
		return this;
	}
	pad(r: number): LatLngBounds {
		const sw = this._southWest!, ne = this._northEast!, h = Math.abs(sw.lat - ne.lat) * r, w = Math.abs(sw.lng - ne.lng) * r;
		return new LatLngBounds(new LatLng(sw.lat - h, sw.lng - w), new LatLng(ne.lat + h, ne.lng + w));
	}
	getCenter(): LatLng { return new LatLng((this._southWest!.lat + this._northEast!.lat) / 2, (this._southWest!.lng + this._northEast!.lng) / 2); }
	getSouthWest(): LatLng { return this._southWest!; }
	getNorthEast(): LatLng { return this._northEast!; }
	getNorthWest(): LatLng { return new LatLng(this.getNorth(), this.getWest()); }
	getSouthEast(): LatLng { return new LatLng(this.getSouth(), this.getEast()); }
	getWest(): number { return this._southWest!.lng; }
	getSouth(): number { return this._southWest!.lat; }
	getEast(): number { return this._northEast!.lng; }
	getNorth(): number { return this._northEast!.lat; }
	contains(obj: any): boolean {
		const o: any = typeof obj[0] === "number" || obj instanceof LatLng || "lat" in obj ? toLatLng(obj) : toLatLngBounds(obj);
		const sw = this._southWest!, ne = this._northEast!;
		let sw2: LatLng, ne2: LatLng;
		if (o instanceof LatLngBounds) { sw2 = o.getSouthWest(); ne2 = o.getNorthEast(); } else sw2 = ne2 = o;
		return sw2.lat >= sw.lat && ne2.lat <= ne.lat && sw2.lng >= sw.lng && ne2.lng <= ne.lng;
	}
	intersects(b: any): boolean { const o = toLatLngBounds(b), sw = this._southWest!, ne = this._northEast!, sw2 = o.getSouthWest(), ne2 = o.getNorthEast(); return ne2.lat >= sw.lat && sw2.lat <= ne.lat && ne2.lng >= sw.lng && sw2.lng <= ne.lng; }
	overlaps(b: any): boolean { const o = toLatLngBounds(b), sw = this._southWest!, ne = this._northEast!, sw2 = o.getSouthWest(), ne2 = o.getNorthEast(); return ne2.lat > sw.lat && sw2.lat < ne.lat && ne2.lng > sw.lng && sw2.lng < ne.lng; }
	toBBoxString(): string { return [this.getWest(), this.getSouth(), this.getEast(), this.getNorth()].join(","); }
	equals(b: any, maxMargin?: number): boolean { if (!b) return false; const o = toLatLngBounds(b); return this._southWest!.equals(o.getSouthWest(), maxMargin) && this._northEast!.equals(o.getNorthEast(), maxMargin); }
	isValid(): boolean { return !!(this._southWest && this._northEast); }
}
/** L.latLngBounds(sw, ne) / L.latLngBounds([latlng, …]) */
export function toLatLngBounds(a: any, b?: any): LatLngBounds { return a instanceof LatLngBounds ? a : new LatLngBounds(a, b); }

// ── projections and CRS ──
const R = 6378137, MAX_LATITUDE = 85.0511287798, D = Math.PI / 180;
export const SphericalMercator = {
	R, MAX_LATITUDE,
	project(latlng: LatLng): Point {
		const lat = Math.max(Math.min(MAX_LATITUDE, latlng.lat), -MAX_LATITUDE), sin = Math.sin(lat * D);
		return new Point(R * latlng.lng * D, R * Math.log((1 + sin) / (1 - sin)) / 2);
	},
	unproject(p: Point): LatLng { return new LatLng((2 * Math.atan(Math.exp(p.y / R)) - Math.PI / 2) / D, p.x / D / R); },
	bounds: new Bounds([-R * Math.PI, -R * Math.PI], [R * Math.PI, R * Math.PI]),
};
export const LonLat = {
	project: (latlng: LatLng): Point => new Point(latlng.lng, latlng.lat),
	unproject: (p: Point): LatLng => new LatLng(p.y, p.x),
	bounds: new Bounds([-180, -90], [180, 90]),
};
export const Projection = { SphericalMercator, LonLat, Mercator: SphericalMercator };

const CRSBase = {
	latLngToPoint(this: any, latlng: LatLng, zoom: number): Point { return this.transformation._transform(this.projection.project(latlng), this.scale(zoom)); },
	pointToLatLng(this: any, p: Point, zoom: number): LatLng { return this.projection.unproject(this.transformation.untransform(p, this.scale(zoom))); },
	project(this: any, latlng: LatLng): Point { return this.projection.project(latlng); },
	unproject(this: any, p: Point): LatLng { return this.projection.unproject(p); },
	scale: (zoom: number): number => 256 * Math.pow(2, zoom),
	zoom: (scale: number): number => Math.log(scale / 256) / Math.LN2,
	getProjectedBounds(this: any, zoom: number): Bounds | null {
		if (this.infinite) return null;
		const b = this.projection.bounds, s = this.scale(zoom);
		return new Bounds(this.transformation.transform(b.min, s), this.transformation.transform(b.max, s));
	},
	infinite: false,
	wrapLatLng(this: any, latlng: LatLng): LatLng {
		const lng = this.wrapLng ? Util.wrapNum(latlng.lng, this.wrapLng, true) : latlng.lng, lat = this.wrapLat ? Util.wrapNum(latlng.lat, this.wrapLat, true) : latlng.lat;
		return new LatLng(lat, lng, latlng.alt);
	},
	wrapLatLngBounds(this: any, bounds: LatLngBounds): LatLngBounds {
		const center = bounds.getCenter(), nc = this.wrapLatLng(center), dLat = center.lat - nc.lat, dLng = center.lng - nc.lng;
		if (dLat === 0 && dLng === 0) return bounds;
		const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
		return new LatLngBounds(new LatLng(sw.lat - dLat, sw.lng - dLng), new LatLng(ne.lat - dLat, ne.lng - dLng));
	},
};
export const Earth = {
	...CRSBase, wrapLng: [-180, 180], R: 6371000,
	/** great-circle distance in meters (haversine on Leaflet's 6,371,000 m sphere) */
	distance(a: LatLng, b: LatLng): number {
		const lat1 = a.lat * D, lat2 = b.lat * D, sinDLat = Math.sin((b.lat - a.lat) * D / 2), sinDLon = Math.sin((b.lng - a.lng) * D / 2);
		const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
		return 2 * 6371000 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
	},
};
const S3857 = 0.5 / (Math.PI * R);
export const EPSG3857 = { ...Earth, code: "EPSG:3857", projection: SphericalMercator, transformation: new Transformation(S3857, 0.5, -S3857, 0.5) };
export const EPSG4326 = { ...Earth, code: "EPSG:4326", projection: LonLat, transformation: new Transformation(1 / 180, 1, -1 / 180, 0.5) };
export const Simple = { ...CRSBase, projection: LonLat, transformation: new Transformation(1, 0, -1, 0), scale: (z: number): number => Math.pow(2, z), zoom: (s: number): number => Math.log(s) / Math.LN2, distance: (a: LatLng, b: LatLng): number => Math.hypot(b.lng - a.lng, b.lat - a.lat), infinite: true };
export const CRS = { ...CRSBase, Earth, EPSG3857, EPSG900913: { ...EPSG3857, code: "EPSG:900913" }, EPSG3395: { ...EPSG3857, code: "EPSG:3395" }, EPSG4326, Simple };

// ── Leaflet latlng arrays ──
/** a flat array of latlngs (not nested rings) */
export const isFlat = (a: any[]): boolean => !Array.isArray(a[0]) || (typeof a[0][0] !== "object" && typeof a[0][0] !== "undefined");

// ── GeoJSON coordinates ↔ latlngs (L.GeoJSON's statics; used by every layer's toGeoJSON) ──
export const coordsToLatLng = (c: number[]): LatLng => new LatLng(c[1], c[0], c[2]);
export function coordsToLatLngs(coords: any[], levelsDeep = 0, c2l: (c: number[]) => LatLng = coordsToLatLng): any[] {
	return coords.map(c => levelsDeep ? coordsToLatLngs(c, levelsDeep - 1, c2l) : c2l(c));
}
export function latLngToCoords(latlng: LatLng, precision?: number | false): number[] {
	const p = toLatLng(latlng)!;
	return p.alt !== undefined ? [formatNum(p.lng, precision), formatNum(p.lat, precision), formatNum(p.alt, precision)] : [formatNum(p.lng, precision), formatNum(p.lat, precision)];
}
export function latLngsToCoords(latlngs: any[], levelsDeep = 0, closed = false, precision?: number | false): any[] {
	const coords = latlngs.map(l => levelsDeep ? latLngsToCoords(l, isFlat(l) ? 0 : levelsDeep - 1, closed, precision) : latLngToCoords(l, precision));
	if (!levelsDeep && closed && coords.length > 0) coords.push(coords[0].slice());
	return coords;
}
export function asFeature(geojson: any): any { return geojson.type === "Feature" || geojson.type === "FeatureCollection" ? geojson : { type: "Feature", properties: {}, geometry: geojson }; }
export function getFeature(layer: any, newGeometry: any): any { return layer.feature ? { ...layer.feature, geometry: newGeometry } : asFeature(newGeometry); }
