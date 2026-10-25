// google.maps.geometry: spherical (distance, heading, offset, area on a sphere of radius 6378137 m, as Google does), encoding (polyline codec), poly.
import { LatLng, toLatLng, MVCArray, type LatLngLike } from "./core.ts";

const R = 6378137, rad = (d: number): number => d * Math.PI / 180, deg = (r: number): number => r * 180 / Math.PI;
type Path = LatLngLike[] | MVCArray<LatLngLike>;
const arr = (p: Path): LatLng[] => (p instanceof MVCArray ? p.getArray() : p).map(toLatLng);

function computeDistanceBetween(from: LatLngLike, to: LatLngLike, radius = R): number {
	const a = toLatLng(from), b = toLatLng(to), f1 = rad(a.lat()), f2 = rad(b.lat());
	const h = Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(rad(b.lng() - a.lng()) / 2) ** 2;
	return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** heading from → to in degrees, [-180, 180) clockwise from north */
function computeHeading(from: LatLngLike, to: LatLngLike): number {
	const a = toLatLng(from), b = toLatLng(to), f1 = rad(a.lat()), f2 = rad(b.lat()), dl = rad(b.lng() - a.lng());
	const h = deg(Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)));
	return ((h + 180) % 360 + 360) % 360 - 180;
}
function computeOffset(from: LatLngLike, distance: number, heading: number, radius = R): LatLng {
	const a = toLatLng(from), d = distance / radius, t = rad(heading), f1 = rad(a.lat()), l1 = rad(a.lng());
	const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
	const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
	return new LatLng(deg(f2), deg(l2));
}
/** the point a fraction of the way along the great circle from → to */
function interpolate(from: LatLngLike, to: LatLngLike, fraction: number): LatLng {
	const a = toLatLng(from), b = toLatLng(to), f1 = rad(a.lat()), l1 = rad(a.lng()), f2 = rad(b.lat()), l2 = rad(b.lng());
	const d = computeDistanceBetween(a, b, 1);
	if (d < 1e-12) return new LatLng(a.lat() + (b.lat() - a.lat()) * fraction, a.lng() + (b.lng() - a.lng()) * fraction);
	const A = Math.sin((1 - fraction) * d) / Math.sin(d), B = Math.sin(fraction * d) / Math.sin(d);
	const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2), y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2), z = A * Math.sin(f1) + B * Math.sin(f2);
	return new LatLng(deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x)));
}
function computeLength(path: Path, radius = R): number { const p = arr(path); let s = 0; for (let i = 1; i < p.length; i++) s += computeDistanceBetween(p[i - 1], p[i], radius); return s; }
/** signed area of a closed path (counter-clockwise positive), spherical excess per edge */
function computeSignedArea(path: Path, radius = R): number {
	const p = arr(path); if (p.length < 3) return 0;
	let s = 0;
	for (let i = 0; i < p.length; i++) {
		const a = p[i], b = p[(i + 1) % p.length];
		const t1 = Math.tan((Math.PI / 2 - rad(a.lat())) / 2), t2 = Math.tan((Math.PI / 2 - rad(b.lat())) / 2), dl = rad(b.lng() - a.lng());
		s += 2 * Math.atan2(t1 * t2 * Math.sin(dl), 1 + t1 * t2 * Math.cos(dl));
	}
	return s * radius * radius;
}
const computeArea = (path: Path, radius = R): number => Math.abs(computeSignedArea(path, radius));

export const spherical = { computeDistanceBetween, computeHeading, computeOffset, interpolate, computeLength, computeArea, computeSignedArea };

// Encoded polyline algorithm (precision 1e5)
function encodePath(path: Path): string {
	let out = "", pl = 0, pg = 0;
	const enc = (v: number): void => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
	for (const q of arr(path)) { const l = Math.round(q.lat() * 1e5), g = Math.round(q.lng() * 1e5); enc(l - pl); enc(g - pg); pl = l; pg = g; }
	return out;
}
function decodePath(s: string): LatLng[] {
	const out: LatLng[] = []; let i = 0, lat = 0, lng = 0;
	const dec = (): number => { let r = 0, sh = 0, b: number; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
	while (i < s.length) { lat += dec(); lng += dec(); out.push(new LatLng(lat / 1e5, lng / 1e5)); }
	return out;
}
export const encoding = { encodePath, decodePath };

/** poly: containsLocation (ray casting in lat/lng, like Google for small polygons) and isLocationOnEdge (tolerance in degrees, default 1e-9) */
type PolyLike = { getPath(): MVCArray<LatLng> };
function containsLocation(point: LatLngLike, polygon: PolyLike): boolean {
	const p = toLatLng(point), v = polygon.getPath().getArray(); let inside = false;
	for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
		const xi = v[i].lng(), yi = v[i].lat(), xj = v[j].lng(), yj = v[j].lat();
		if ((yi > p.lat()) !== (yj > p.lat()) && p.lng() < (xj - xi) * (p.lat() - yi) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}
function isLocationOnEdge(point: LatLngLike, poly: PolyLike, tolerance = 1e-9): boolean {
	const p = toLatLng(point), v = poly.getPath().getArray();
	for (let i = 1; i < v.length; i++) {
		const ax = v[i - 1].lng(), ay = v[i - 1].lat(), bx = v[i].lng(), by = v[i].lat(), dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
		const t = L ? Math.max(0, Math.min(1, ((p.lng() - ax) * dx + (p.lat() - ay) * dy) / L)) : 0;
		if (Math.hypot(p.lng() - (ax + t * dx), p.lat() - (ay + t * dy)) <= tolerance) return true;
	}
	return false;
}
export const poly = { containsLocation, isLocationOnEdge };
export const geometry = { spherical, encoding, poly };
