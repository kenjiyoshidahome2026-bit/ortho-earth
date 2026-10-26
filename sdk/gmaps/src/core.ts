// Core value types and the event system of google.maps: LatLng, LatLngBounds, Point, Size, MVCObject, MVCArray, event.
//   No map engine here: these are plain data, shared by the map, the overlays and geometry.

export type LatLngLiteral = { lat: number; lng: number };
export type LatLngLike = LatLng | LatLngLiteral;
export type LatLngBoundsLiteral = { north: number; south: number; east: number; west: number };
export type LatLngBoundsLike = LatLngBounds | LatLngBoundsLiteral;
type Fn = (...a: any[]) => unknown;

// Unsupported features are reported once each, never thrown (same rule as the MapLibre shim's [mlshim] log).
const reported = new Set<string>();
export function unsupported(what: string): void {
	if (reported.has(what)) return;
	reported.add(what);
	console.warn(`[gmshim] unsupported: ${what}`);
}
export const unsupportedReport = (): string[] => [...reported];

export class LatLng {
	#lat: number; #lng: number;
	constructor(lat: number | LatLngLiteral | LatLng, lng?: number | boolean, noClamp?: boolean) {
		if (typeof lat === "object") { noClamp = lng as boolean | undefined; const o = lat; lat = typeof o.lat === "function" ? (o as LatLng).lat() : (o as LatLngLiteral).lat; lng = typeof o.lng === "function" ? (o as LatLng).lng() : (o as LatLngLiteral).lng; }
		let a = +lat, b = +(lng as number);
		if (!noClamp) { a = Math.max(-90, Math.min(90, a)); if (b < -180 || b > 180) b = ((b + 180) % 360 + 360) % 360 - 180; }
		this.#lat = a; this.#lng = b;
	}
	lat(): number { return this.#lat; }
	lng(): number { return this.#lng; }
	equals(o: LatLngLike | null | undefined): boolean { if (!o) return false; const p = toLatLng(o); return Math.abs(p.lat() - this.#lat) < 1e-9 && Math.abs(p.lng() - this.#lng) < 1e-9; }
	toJSON(): LatLngLiteral { return { lat: this.#lat, lng: this.#lng }; }
	toString(): string { return `(${this.#lat}, ${this.#lng})`; }
	toUrlValue(precision = 6): string { const r = (v: number): number => +v.toFixed(precision); return `${r(this.#lat)},${r(this.#lng)}`; }
}
export const toLatLng = (v: LatLngLike): LatLng => v instanceof LatLng ? v : new LatLng(v);
/** google LatLng → MapLibre [lng, lat] */
export const toLngLat = (v: LatLngLike): [number, number] => { const p = toLatLng(v); return [p.lng(), p.lat()]; };
/** MapLibre LngLat ({lng, lat} or [lng, lat]) → google LatLng */
export const fromLngLat = (v: { lng: number; lat: number } | number[]): LatLng => Array.isArray(v) ? new LatLng(v[1], v[0], true) : new LatLng(v.lat, v.lng, true);

export class LatLngBounds {
	#s = Infinity; #w = Infinity; #n = -Infinity; #e = -Infinity;
	constructor(sw?: LatLngLike | LatLngBoundsLiteral | null, ne?: LatLngLike | null) {
		if (sw && "north" in sw) { this.#s = sw.south; this.#w = sw.west; this.#n = sw.north; this.#e = sw.east; return; }
		if (sw) this.extend(sw as LatLngLike);
		if (ne) this.extend(ne);
	}
	extend(p: LatLngLike): this {
		const q = toLatLng(p);
		this.#s = Math.min(this.#s, q.lat()); this.#n = Math.max(this.#n, q.lat());
		this.#w = Math.min(this.#w, q.lng()); this.#e = Math.max(this.#e, q.lng());
		return this;
	}
	union(o: LatLngBoundsLike): this { const b = toBounds(o); if (!b.isEmpty()) { this.extend(b.getSouthWest()); this.extend(b.getNorthEast()); } return this; }
	contains(p: LatLngLike): boolean { const q = toLatLng(p); return q.lat() >= this.#s && q.lat() <= this.#n && q.lng() >= this.#w && q.lng() <= this.#e; }
	intersects(o: LatLngBoundsLike): boolean { const b = toBounds(o).toJSON(); return !this.isEmpty() && b.south <= this.#n && b.north >= this.#s && b.west <= this.#e && b.east >= this.#w; }
	isEmpty(): boolean { return this.#s > this.#n || this.#w > this.#e; }
	getSouthWest(): LatLng { return new LatLng(this.#s, this.#w, true); }
	getNorthEast(): LatLng { return new LatLng(this.#n, this.#e, true); }
	getCenter(): LatLng { return new LatLng((this.#s + this.#n) / 2, (this.#w + this.#e) / 2, true); }
	toSpan(): LatLng { return this.isEmpty() ? new LatLng(0, 0) : new LatLng(this.#n - this.#s, this.#e - this.#w, true); }
	equals(o: LatLngBoundsLike | null | undefined): boolean { if (!o) return false; const a = this.toJSON(), b = toBounds(o).toJSON(); return a.north === b.north && a.south === b.south && a.east === b.east && a.west === b.west; }
	toJSON(): LatLngBoundsLiteral { return { north: this.#n, south: this.#s, east: this.#e, west: this.#w }; }
	toString(): string { return `(${this.getSouthWest()}, ${this.getNorthEast()})`; }
	toUrlValue(precision = 6): string { return `${this.getSouthWest().toUrlValue(precision)},${this.getNorthEast().toUrlValue(precision)}`; }
}
export const toBounds = (v: LatLngBoundsLike): LatLngBounds => v instanceof LatLngBounds ? v : new LatLngBounds(v);
/** google bounds → MapLibre [[w, s], [e, n]] */
export const toMlBounds = (v: LatLngBoundsLike): [[number, number], [number, number]] => { const b = toBounds(v).toJSON(); return [[b.west, b.south], [b.east, b.north]]; };

export class Point {
	x: number; y: number;
	constructor(x: number, y: number) { this.x = x; this.y = y; }
	equals(o: Point | null | undefined): boolean { return !!o && o.x === this.x && o.y === this.y; }
	toString(): string { return `(${this.x}, ${this.y})`; }
}
export class Size {
	width: number; height: number; widthUnit?: string; heightUnit?: string;
	constructor(width: number, height: number, widthUnit?: string, heightUnit?: string) { this.width = width; this.height = height; this.widthUnit = widthUnit; this.heightUnit = heightUnit; }
	equals(o: Size | null | undefined): boolean { return !!o && o.width === this.width && o.height === this.height; }
	toString(): string { return `(${this.width}, ${this.height})`; }
}

// ── events ──
export interface MapsEventListener { remove(): void }
const LISTENERS = new WeakMap<object, Map<string, Set<Fn>>>();
const listenersOf = (o: object): Map<string, Set<Fn>> => { let m = LISTENERS.get(o); if (!m) LISTENERS.set(o, (m = new Map())); return m; };
/** a hook an instance can define to start translating an engine event on its first listener */
export const ON_LISTEN = Symbol("gm.onListen");

export const event = {
	addListener(instance: object, name: string, fn: Fn): MapsEventListener {
		const m = listenersOf(instance);
		if (!m.has(name)) m.set(name, new Set());
		const w = (...a: unknown[]): unknown => fn.apply(instance, a);
		m.get(name)!.add(w);
		(instance as { [ON_LISTEN]?: (n: string) => void })[ON_LISTEN]?.(name);
		return { remove: () => { m.get(name)?.delete(w); } };
	},
	addListenerOnce(instance: object, name: string, fn: Fn): MapsEventListener {
		const h = event.addListener(instance, name, (...a: unknown[]) => { h.remove(); return fn.apply(instance, a); });
		return h;
	},
	addDomListener(el: EventTarget, name: string, fn: Fn, capture?: boolean): MapsEventListener {
		el.addEventListener(name, fn as EventListener, capture);
		return { remove: () => el.removeEventListener(name, fn as EventListener, capture) };
	},
	addDomListenerOnce(el: EventTarget, name: string, fn: Fn, capture?: boolean): MapsEventListener {
		const h = event.addDomListener(el, name, (...a: unknown[]) => { h.remove(); return fn(...a); }, capture);
		return h;
	},
	removeListener(h: MapsEventListener | null | undefined): void { h?.remove(); },
	clearListeners(instance: object, name: string): void { listenersOf(instance).delete(name); },
	clearInstanceListeners(instance: object): void { LISTENERS.delete(instance); },
	trigger(instance: object, name: string, ...args: unknown[]): void { for (const f of [...(LISTENERS.get(instance)?.get(name) || [])]) f(...args); },
	hasListeners(instance: object, name: string): boolean { return !!LISTENERS.get(instance)?.get(name)?.size; },
};

/** google.maps.MVCObject: get/set with <key>_changed events (bindTo is not supported) */
export class MVCObject {
	#v: Record<string, unknown> = {};
	get(k: string): any { return this.#v[k]; }
	set(k: string, v: unknown): void { if (this.#v[k] === v) return; this.#v[k] = v; (this as unknown as Record<string, Fn | undefined>)[`${k}_changed`]?.call(this); this.notify(k); }
	setValues(o: Record<string, unknown> | null | undefined): void { for (const k in o) { const s = (this as unknown as Record<string, unknown>)[`set${k[0].toUpperCase()}${k.slice(1)}`]; typeof s === "function" ? s.call(this, o[k]) : this.set(k, o[k]); } }
	notify(k: string): void { event.trigger(this, `${k}_changed`); }
	addListener(name: string, fn: Fn): MapsEventListener { return event.addListener(this, name, fn); }
	bindTo(k: string, _target?: unknown): void { unsupported(`MVCObject.bindTo("${k}")`); }
	unbind(): void {}
	unbindAll(): void {}
}

/** google.maps.MVCArray: insert_at / remove_at / set_at events on every change */
export class MVCArray<T = unknown> extends MVCObject {
	#a: T[];
	constructor(a: T[] = []) { super(); this.#a = [...a]; }
	getArray(): T[] { return this.#a; }
	getAt(i: number): T { return this.#a[i]; }
	getLength(): number { return this.#a.length; }
	get length(): number { return this.#a.length; }
	forEach(f: (v: T, i: number) => void): void { this.#a.forEach((v, i) => f(v, i)); }
	insertAt(i: number, v: T): void { this.#a.splice(i, 0, v); event.trigger(this, "insert_at", i); }
	removeAt(i: number): T { const [v] = this.#a.splice(i, 1); event.trigger(this, "remove_at", i, v); return v; }
	setAt(i: number, v: T): void { const old = this.#a[i]; this.#a[i] = v; event.trigger(this, "set_at", i, old); }
	push(v: T): number { this.insertAt(this.#a.length, v); return this.#a.length; }
	pop(): T | undefined { return this.#a.length ? this.removeAt(this.#a.length - 1) : undefined; }
	clear(): void { while (this.#a.length) this.pop(); }
}
/** calls f on any change of an MVCArray (and of nested MVCArrays one level down) */
export function watchArray(a: MVCArray<any>, f: () => void): MapsEventListener {
	const subs: MapsEventListener[] = [];
	const bind = (): void => {
		for (const h of subs.splice(0)) h.remove();
		for (const n of ["insert_at", "remove_at", "set_at"]) subs.push(event.addListener(a, n, () => { bind(); f(); }));
		a.forEach(v => { if (v instanceof MVCArray) for (const n of ["insert_at", "remove_at", "set_at"]) subs.push(event.addListener(v, n, f)); });
	};
	bind();
	return { remove: () => { for (const h of subs.splice(0)) h.remove(); } };
}
