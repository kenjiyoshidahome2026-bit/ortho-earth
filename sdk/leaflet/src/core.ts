// Leaflet's core with no map engine: Util, Class (extend / include / mergeOptions / addInitHook), Evented, Handler, Browser,
// and the "[lfshim] unsupported" report. Leaflet-style classes are ES classes here, so `L.Marker.extend({...})` (plugins, L.Control.extend)
// and `class X extends L.Marker` both work. Rule: no class fields in these classes (Class's constructor runs initialize(), and fields would
// be assigned after it); state lives in properties set by initialize().
/* eslint-disable @typescript-eslint/no-explicit-any */

// Unsupported features are reported once each, never thrown (same rule as the MapLibre shim's [mlshim] and gmaps' [gmshim]).
const reported = new Set<string>();
export function unsupported(what: string): void {
	if (reported.has(what)) return;
	reported.add(what);
	console.warn(`[lfshim] unsupported: ${what}`);
}
export const unsupportedReport = (): string[] => [...reported];

let lastId = 0;
const falseFn = (): false => false;
const hasDoc = (): boolean => typeof document !== "undefined";

export const Util = {
	extend(dest: any, ...src: any[]): any { for (const s of src) for (const k in s) dest[k] = s[k]; return dest; },
	create: Object.create,
	bind(fn: (...a: any[]) => any, obj: unknown, ...args: unknown[]): (...a: any[]) => any { return fn.bind(obj, ...args); },
	stamp(o: any): number { if (typeof o._leaflet_id !== "number") o._leaflet_id = ++lastId; return o._leaflet_id; },
	get lastId(): number { return lastId; },
	throttle(fn: (...a: any[]) => void, time: number, context?: unknown): (...a: any[]) => void {
		let lock = false, queued: any[] | null = null;
		const later = (): void => { lock = false; if (queued) { wrapper(...queued); queued = null; } };
		const wrapper = (...a: any[]): void => { if (lock) { queued = a; return; } fn.apply(context, a); setTimeout(later, time); lock = true; };
		return wrapper;
	},
	wrapNum(x: number, range: number[], includeMax?: boolean): number { const max = range[1], min = range[0], d = max - min; return x === max && includeMax ? x : ((x - min) % d + d) % d + min; },
	falseFn,
	formatNum(num: number, precision?: number | false): number { if (precision === false) return num; const pow = Math.pow(10, precision === undefined ? 6 : precision); return Math.round(num * pow) / pow; },
	trim(s: string): string { return s.trim(); },
	splitWords(s: string): string[] { return s.trim().split(/\s+/); },
	setOptions(obj: any, options?: any): any {
		if (!Object.prototype.hasOwnProperty.call(obj, "options")) obj.options = obj.options ? Object.create(obj.options) : {};
		for (const k in options) obj.options[k] = options[k];
		return obj.options;
	},
	getParamString(obj: Record<string, unknown>, existingUrl?: string, uppercase?: boolean): string {
		const params: string[] = [];
		for (const k in obj) params.push(`${encodeURIComponent(uppercase ? k.toUpperCase() : k)}=${encodeURIComponent(String(obj[k]))}`);
		return (!existingUrl || existingUrl.indexOf("?") === -1 ? "?" : "&") + params.join("&");
	},
	template(str: string, data: Record<string, any>): string {
		return str.replace(/\{([^{}]*)\}/g, (s, k: string) => {   // Leaflet's /\{ *([\w_ -]+) *\}/, without its polynomial backtracking
			const key = k.trim();
			if (!/^[\w -]+$/.test(key)) return s;
			let v = data[key];
			if (v === undefined) throw new Error(`No value provided for variable ${s}`);
			if (typeof v === "function") v = v(data);
			return v;
		});
	},
	isArray: Array.isArray,
	indexOf(a: unknown[], el: unknown): number { return a.indexOf(el); },
	emptyImageUrl: "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=",
	requestAnimFrame(fn: (t: number) => void, context?: unknown, immediately?: boolean): number {
		if (immediately) { fn.call(context, Date.now()); return 0; }
		return typeof requestAnimationFrame === "function" ? requestAnimationFrame(t => fn.call(context, t)) : setTimeout(() => fn.call(context, Date.now()), 16) as unknown as number;
	},
	cancelAnimFrame(id: number): void { if (id) (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout)(id); },
};
export const { extend, stamp, setOptions } = Util;

/** Leaflet's L.Class: initialize(), options merged along the prototype chain, init hooks */
export class Class {
	[k: string]: any;
	static __super__: any;
	constructor(...args: any[]) {
		this._initHooksCalled = false;
		this.initialize?.(...args);
		this.callInitHooks();
	}
	callInitHooks(): void {
		if (this._initHooksCalled) return;
		this._initHooksCalled = true;
		const chain: any[] = [];
		for (let p = Object.getPrototypeOf(this); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) if (Object.prototype.hasOwnProperty.call(p, "_initHooks")) chain.unshift(p._initHooks);
		for (const hooks of chain) for (const h of hooks) h.call(this);
	}
	/** L.Class.extend(props): a subclass with props on its prototype (options merged with the parent's, includes, statics) */
	static extend(props: Record<string, any> & ThisType<any> = {}): any {
		const C = class extends (this as any) {};
		define(C, props);
		return C;
	}
	static include(props: Record<string, any> & ThisType<any>): any {
		const parentOptions = this.prototype.options;
		extend(this.prototype, props);
		if (props.options) { this.prototype.options = parentOptions; this.mergeOptions(props.options); }
		return this;
	}
	static mergeOptions(options: Record<string, unknown>): any {
		if (!Object.prototype.hasOwnProperty.call(this.prototype, "options")) this.prototype.options = Object.create(this.prototype.options || Object.prototype);
		extend(this.prototype.options, options);
		return this;
	}
	static addInitHook(fn: string | ((this: any) => void), ...args: unknown[]): any {
		const init = typeof fn === "function" ? fn : function (this: any) { this[fn].apply(this, args); };
		if (!Object.prototype.hasOwnProperty.call(this.prototype, "_initHooks")) this.prototype._initHooks = [];
		this.prototype._initHooks.push(init);
		return this;
	}
}
/** what Class.extend does to a new class: statics, includes, prototype props, options inheriting the parent's options */
export function define(C: any, props: Record<string, any> & ThisType<any>): any {
	const proto = C.prototype, parent = Object.getPrototypeOf(proto);
	const { statics, includes, options, ...rest } = props;
	if (statics) extend(C, statics);
	if (includes) for (const i of ([] as any[]).concat(includes)) extend(proto, i);
	extend(proto, rest);
	proto.options = extend(Object.create(parent.options || Object.prototype), options);
	proto._initHooks = [];
	C.__super__ = parent;
	return C;
}
define(Class, {});
Class.prototype.options = undefined;

// ── events ──
type Listener = { fn: (e: any) => void; ctx: unknown; once?: boolean };
export class Evented extends Class {
	on(types: string | Record<string, (e: any) => void>, fn?: any, context?: unknown): this {
		if (typeof types === "object") { for (const t in types) for (const w of Util.splitWords(t)) this._on(w, types[t], fn); }
		else for (const t of Util.splitWords(types)) this._on(t, fn, context);
		return this;
	}
	off(types?: string | Record<string, (e: any) => void>, fn?: any, context?: unknown): this {
		if (types === undefined) { delete this._events; return this; }
		if (typeof types === "object") { for (const t in types) for (const w of Util.splitWords(t)) this._off(w, types[t], fn); }
		else for (const t of Util.splitWords(types)) this._off(t, fn, context);
		return this;
	}
	_on(type: string, fn: (e: any) => void, context?: unknown, once?: boolean): void {
		if (typeof fn !== "function") { console.warn(`wrong listener type: ${typeof fn}`); return; }
		if (context === this) context = undefined;
		this._events ||= {};
		const ls: Listener[] = this._events[type] ||= [];
		if (ls.some(l => l.fn === fn && l.ctx === context)) return;
		ls.push({ fn, ctx: context, once });
		this._onListen?.(type);
	}
	_off(type: string, fn?: (e: any) => void, context?: unknown): void {
		const ls: Listener[] | undefined = this._events?.[type];
		if (!ls) return;
		if (!fn) { for (const l of ls) l.fn = falseFn; delete this._events[type]; return; }
		if (context === this) context = undefined;
		const i = ls.findIndex(l => l.fn === fn && l.ctx === context);
		if (i < 0) return;
		ls[i].fn = falseFn;   // a fire in progress skips it
		this._events[type] = ls.slice(0, i).concat(ls.slice(i + 1));
	}
	fire(type: string, data?: any, propagate?: boolean): this {
		if (!this.listens(type, propagate)) return this;
		const event = extend({}, data, { type, target: this, sourceTarget: (data && data.sourceTarget) || this });
		const ls: Listener[] | undefined = this._events?.[type];
		if (ls) for (const l of ls.slice()) { const fn = l.fn; if (l.once) this.off(type, fn, l.ctx); fn.call(l.ctx || this, event); }
		if (propagate) this._propagateEvent(event);
		return this;
	}
	listens(type: string, fn?: any, context?: unknown, propagate?: boolean): boolean {
		if (typeof fn !== "function") { propagate = !!fn; fn = undefined; context = undefined; }
		const ls: Listener[] | undefined = this._events?.[type];
		if (ls?.length) {
			if (!fn) return true;
			if (context === this) context = undefined;
			if (ls.some(l => l.fn === fn && l.ctx === context)) return true;
		}
		if (propagate) for (const id in this._eventParents) if (this._eventParents[id].listens(type, fn, context, propagate)) return true;
		return false;
	}
	once(types: string | Record<string, (e: any) => void>, fn?: any, context?: unknown): this {
		if (typeof types === "object") { for (const t in types) for (const w of Util.splitWords(t)) this._on(w, types[t], fn, true); }
		else for (const t of Util.splitWords(types)) this._on(t, fn, context, true);
		return this;
	}
	addEventParent(obj: Evented): this { (this._eventParents ||= {})[stamp(obj)] = obj; return this; }
	removeEventParent(obj: Evented): this { if (this._eventParents) delete this._eventParents[stamp(obj)]; return this; }
	_propagateEvent(e: any): void {
		for (const id in this._eventParents) this._eventParents[id].fire(e.type, extend({ layer: e.target, propagatedFrom: e.target }, e), true);
	}
}
// Leaflet's aliases
Object.assign(Evented.prototype, {
	addEventListener: Evented.prototype.on, removeEventListener: Evented.prototype.off, clearAllEventListeners: Evented.prototype.off,
	addOneTimeEventListener: Evented.prototype.once, fireEvent: Evented.prototype.fire, hasEventListeners: Evented.prototype.listens,
});
/** L.Mixin.Events (deprecated in Leaflet, still read by old plugins) */
export const Mixin = { Events: Evented.prototype };

/** L.Handler: enable() → addHooks(), disable() → removeHooks() */
export class Handler extends Class {
	initialize(map: any): void { this._map = map; }
	enable(): this { if (this._enabled) return this; this._enabled = true; this.addHooks?.(); return this; }
	disable(): this { if (!this._enabled) return this; this._enabled = false; this.removeHooks?.(); return this; }
	enabled(): boolean { return !!this._enabled; }
	static addTo(map: any, name: string): any { map.addHandler(name, this); return this; }
}

const ua = typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
const touch = typeof window !== "undefined" && ("ontouchstart" in window || (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0));
/** L.Browser: what Leaflet code commonly checks */
export const Browser = {
	ie: false, ielt9: false, edge: false, webkit: ua.includes("webkit"), android: ua.includes("android"), android23: false, androidStock: false, opera: false,
	chrome: ua.includes("chrome"), gecko: ua.includes("gecko") && !ua.includes("webkit"), safari: ua.includes("safari") && !ua.includes("chrome"),
	phantom: false, opera12: false, win: typeof navigator !== "undefined" && /win/i.test(navigator.platform ?? ""), mac: typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? ""), linux: /linux/.test(ua),
	ie3d: false, webkit3d: true, gecko3d: true, any3d: true, mobile: /mobi|android/.test(ua), mobileWebkit: false, mobileWebkit3d: false, msPointer: false,
	pointer: typeof window !== "undefined" && !!(window as any).PointerEvent, touch, touchNative: touch, mobileOpera: false, mobileGecko: false,
	retina: typeof window !== "undefined" && (window.devicePixelRatio || 1) > 1, passiveEvents: true, canvas: hasDoc(), svg: hasDoc(), vml: false, inlineSvg: hasDoc(),
};
