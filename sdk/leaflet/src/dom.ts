// L.DomUtil and L.DomEvent: the DOM helpers Leaflet code and plugins call (controls, popups, custom icons).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { stamp } from "./core.ts";
import { Point } from "./geo.ts";

export const DomUtil = {
	TRANSFORM: "transform", TRANSITION: "transition", TRANSITION_END: "transitionend",
	get(id: string | HTMLElement): HTMLElement | null { return typeof id === "string" ? document.getElementById(id) : id; },
	getStyle(el: HTMLElement, style: string): string | null { let v = (el.style as any)[style]; if ((!v || v === "auto") && typeof getComputedStyle === "function") v = (getComputedStyle(el) as any)[style]; return v === "auto" ? null : v; },
	create(tagName: string, className?: string, container?: HTMLElement): HTMLElement {
		const el = document.createElement(tagName);
		el.className = className || "";
		container?.appendChild(el);
		return el;
	},
	remove(el: HTMLElement): void { el.parentNode?.removeChild(el); },
	empty(el: HTMLElement): void { while (el.firstChild) el.removeChild(el.firstChild); },
	toFront(el: HTMLElement): void { const p = el.parentNode; if (p && p.lastChild !== el) p.appendChild(el); },
	toBack(el: HTMLElement): void { const p = el.parentNode; if (p && p.firstChild !== el) p.insertBefore(el, p.firstChild); },
	hasClass(el: HTMLElement, name: string): boolean { return ` ${DomUtil.getClass(el)} `.includes(` ${name} `); },
	addClass(el: HTMLElement, name: string): void { for (const c of name.split(/\s+/).filter(Boolean)) if (!DomUtil.hasClass(el, c)) DomUtil.setClass(el, `${DomUtil.getClass(el)} ${c}`.trim()); },
	removeClass(el: HTMLElement, name: string): void { DomUtil.setClass(el, ` ${DomUtil.getClass(el)} `.replace(` ${name} `, " ").trim()); },
	setClass(el: any, name: string): void { if (el.className?.baseVal !== undefined) el.className.baseVal = name; else el.className = name; },
	getClass(el: any): string { return el.className?.baseVal ?? el.className ?? ""; },
	setOpacity(el: HTMLElement, value: number): void { el.style.opacity = String(value); },
	testProp(props: string[]): string | false { const s: any = typeof document !== "undefined" ? document.documentElement.style : {}; return props.find(p => p in s) ?? false; },
	setTransform(el: HTMLElement, offset?: Point, scale?: number): void { const p = offset || new Point(0, 0); el.style.transform = `translate3d(${p.x}px,${p.y}px,0)${scale ? ` scale(${scale})` : ""}`; },
	setPosition(el: any, point: Point): void { el._leaflet_pos = point; DomUtil.setTransform(el, point); },
	getPosition(el: any): Point { return el._leaflet_pos || new Point(0, 0); },
	disableTextSelection(): void {}, enableTextSelection(): void {}, disableImageDrag(): void {}, enableImageDrag(): void {},
	preventOutline(): void {}, restoreOutline(): void {},
	getSizedParentNode(el: HTMLElement): HTMLElement { let e: any = el; do e = e.parentNode; while ((!e.offsetWidth || !e.offsetHeight) && e !== document.body); return e; },
	getScale(el: HTMLElement): { x: number; y: number; boundingClientRect: DOMRect } { const r = el.getBoundingClientRect(); return { x: r.width / el.offsetWidth || 1, y: r.height / el.offsetHeight || 1, boundingClientRect: r }; },
};

const KEY = "_leaflet_events";
type Fn = (e: any) => void;
export const DomEvent: any = {
	on(obj: any, types: string | Record<string, Fn>, fn?: any, context?: unknown): typeof DomEvent {
		if (typeof types === "object") { for (const t in types) for (const w of t.split(/\s+/)) add(obj, w, types[t], fn); }
		else for (const t of types.split(/\s+/)) add(obj, t, fn, context);
		return DomEvent;
	},
	off(obj: any, types?: string | Record<string, Fn>, fn?: any, context?: unknown): typeof DomEvent {
		if (types === undefined) { for (const id in obj[KEY]) { const [t] = id.split(":"); obj.removeEventListener(t, obj[KEY][id]); } delete obj[KEY]; }
		else if (typeof types === "object") { for (const t in types) for (const w of t.split(/\s+/)) remove(obj, w, types[t], fn); }
		else for (const t of types.split(/\s+/)) remove(obj, t, fn, context);
		return DomEvent;
	},
	stopPropagation(e: any): typeof DomEvent {
		if (e.stopPropagation) e.stopPropagation();
		else if (e.originalEvent) e.originalEvent._stopped = true;
		else e.cancelBubble = true;
		return DomEvent;
	},
	disableScrollPropagation(el: HTMLElement): typeof DomEvent { return DomEvent.on(el, "wheel", DomEvent.stopPropagation); },
	disableClickPropagation(el: any): typeof DomEvent { DomEvent.on(el, "mousedown touchstart dblclick contextmenu click", DomEvent.stopPropagation); el._leaflet_disable_click = true; return DomEvent; },
	preventDefault(e: any): typeof DomEvent { if (e.preventDefault) e.preventDefault(); else e.returnValue = false; return DomEvent; },
	stop(e: any): typeof DomEvent { DomEvent.preventDefault(e); DomEvent.stopPropagation(e); return DomEvent; },
	getPropagationPath(e: any): EventTarget[] { return e.composedPath ? e.composedPath() : []; },
	getMousePosition(e: any, container?: HTMLElement): Point {
		if (!container) return new Point(e.clientX, e.clientY);
		const r = container.getBoundingClientRect();
		return new Point(e.clientX - r.left - container.clientLeft, e.clientY - r.top - container.clientTop);
	},
	getWheelDelta(e: WheelEvent): number { return -e.deltaY / (e.deltaMode === 1 ? 1 / 20 : e.deltaMode === 2 ? 1 / 60 : 1) / 4; },
	isExternalTarget(el: any, e: any): boolean { let r = e.relatedTarget; try { while (r && r !== el) r = r.parentNode; } catch { return false; } return r !== el; },
	addListener: undefined as any, removeListener: undefined as any,
};
DomEvent.addListener = DomEvent.on;
DomEvent.removeListener = DomEvent.off;
function add(obj: any, type: string, fn: Fn, context?: unknown): void {
	const id = `${type}:${stamp(fn)}${context ? `_${stamp(context)}` : ""}`;
	if (obj[KEY]?.[id]) return;
	const handler = (e: Event): void => fn.call(context || obj, e);
	obj.addEventListener(type, handler, false);
	(obj[KEY] ||= {})[id] = handler;
}
function remove(obj: any, type: string, fn: Fn, context?: unknown): void {
	const id = `${type}:${stamp(fn)}${context ? `_${stamp(context)}` : ""}`, handler = obj[KEY]?.[id];
	if (!handler) return;
	obj.removeEventListener(type, handler, false);
	delete obj[KEY][id];
}

// The bits of leaflet.css that the translated markers, tooltips and controls need when the page does not load leaflet.css,
// and of maplibre-gl.css for the control corners (a Leaflet page loads neither); inserted first, so a page's own stylesheets win.
const CSS = `
.maplibregl-ctrl-top-left,.maplibregl-ctrl-top-right,.maplibregl-ctrl-bottom-left,.maplibregl-ctrl-bottom-right{position:absolute;pointer-events:none;z-index:2}
.maplibregl-ctrl-top-left{top:0;left:0}.maplibregl-ctrl-top-right{top:0;right:0}.maplibregl-ctrl-bottom-left{bottom:0;left:0}.maplibregl-ctrl-bottom-right{bottom:0;right:0}
.maplibregl-ctrl{clear:both;pointer-events:auto}
.maplibregl-ctrl-top-left .maplibregl-ctrl{float:left;margin:10px 0 0 10px}.maplibregl-ctrl-top-right .maplibregl-ctrl{float:right;margin:10px 10px 0 0}
.maplibregl-ctrl-bottom-left .maplibregl-ctrl{float:left;margin:0 0 10px 10px}.maplibregl-ctrl-bottom-right .maplibregl-ctrl{float:right;margin:0 10px 10px 0}
.maplibregl-ctrl-group{background:#fff;border-radius:4px;box-shadow:0 0 0 2px rgba(0,0,0,.1)}
.maplibregl-ctrl-group button{display:block;width:29px;height:29px;padding:0;border:0;background:transparent;cursor:pointer;box-sizing:border-box}
.maplibregl-ctrl-group button+button{border-top:1px solid #ddd}
.maplibregl-ctrl.leaflet-control-attribution{margin:0}
.leaflet-marker-icon,.leaflet-marker-shadow{position:absolute;left:0;top:0;display:block}
.leaflet-marker-shadow{pointer-events:none}
.leaflet-interactive{cursor:pointer}
.leaflet-div-icon{background:#fff;border:1px solid #666;box-sizing:content-box}
.leaflet-tooltip .maplibregl-popup-content{padding:6px;font:12px/1.4 "Helvetica Neue",Arial,Helvetica,sans-serif;color:#222;border-radius:3px;white-space:nowrap}
.leaflet-tooltip.lf-notip .maplibregl-popup-tip{display:none}
.leaflet-popup .maplibregl-popup-content{padding:13px 24px 13px 20px;border-radius:12px;font:12px/1.4 "Helvetica Neue",Arial,Helvetica,sans-serif}
.leaflet-popup-content{line-height:1.4;font-size:13px}
.leaflet-popup-content p{margin:1.3em 0}
.leaflet-control-zoom button{font:bold 18px/29px "Lucida Console",Monaco,monospace;color:#333}
.leaflet-control-zoom button:disabled{color:#bbb;cursor:default}
.leaflet-control-attribution{background:rgba(255,255,255,.8);margin:0;padding:0 5px;font:12px/1.4 "Helvetica Neue",Arial,Helvetica,sans-serif;color:#333}
.leaflet-control-attribution a{color:#0078a8;text-decoration:none}
.leaflet-control-scale-line{color:#333;border:2px solid #777;border-top:none;line-height:1.1;padding:2px 5px 1px;font-size:11px;white-space:nowrap;box-sizing:border-box;background:rgba(255,255,255,.8);text-shadow:1px 1px #fff}
.leaflet-control-scale-line:not(:first-child){border-top:2px solid #777;border-bottom:none;margin-top:-2px}
.leaflet-control-layers{background:#fff;border-radius:5px;box-shadow:0 1px 5px rgba(0,0,0,.4);font:12px/1.5 "Helvetica Neue",Arial,Helvetica,sans-serif;color:#333}
.leaflet-control-layers-toggle{display:block;width:36px;height:36px;cursor:pointer;background:center/26px no-repeat url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 26 26'%3E%3Cpath d='M13 3 1 9l12 6 12-6z' fill='%23b9b9b9' stroke='%23555'/%3E%3Cpath d='m4 13-3 1.5 12 6 12-6-3-1.5-9 4.5z' fill='%23d9d9d9' stroke='%23555'/%3E%3C/svg%3E")}
.leaflet-control-layers-list{display:none;padding:6px 10px 6px 6px}
.leaflet-control-layers-expanded .leaflet-control-layers-list{display:block}
.leaflet-control-layers-expanded .leaflet-control-layers-toggle{display:none}
.leaflet-control-layers label{display:block;font-size:1.08333em}
.leaflet-control-layers-separator{height:0;border-top:1px solid #ddd;margin:5px -10px 5px -6px}
`;
let cssDone = false;
export function injectCss(): void {
	if (cssDone || typeof document === "undefined" || !document.head) return;
	cssDone = true;
	const s = document.createElement("style");
	s.id = "lfshim-css";
	s.textContent = CSS;
	document.head.insertBefore(s, document.head.firstChild);   // first: a page's own leaflet.css / styles win
}
