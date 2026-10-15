import * as d3 from 'd3';
import { isString } from '../utility.ts';
import './selection.scss';

// 拡張の this＝HTML 要素のセレクション（d3 の selection.prototype は型が無い（any）＝ここで決める）
type Proto = d3.Selection<HTMLElement, unknown, d3.BaseType, unknown>;
/** 縮む／膨らむの的＝セレクションか要素（無ければ中心から） */
export type CoverTarget = { node(): Element | null } | Element | null | undefined;
export interface CoverOpts { ease?: (t: number) => number; trans?: number; fallback?: (sel: Proto) => void }
export interface Context2DOpts {
	target?: string | { node(): Element | null } | Element | null; mag?: number; width?: number; height?: number;
	id?: string; name?: string; class?: string; style?: string; fill?: string;
}
/** context2D() が返す 2D コンテキスト（canvas の便利口つき） */
export interface Context2D extends CanvasRenderingContext2D {
	toBlob(type?: string, quality?: number): Promise<Blob | null>;
	size(): [number, number];
	size(v: [number, number]): Context2D;
	clear(): Context2D;
	show(): Context2D;
	hide(): Context2D;
}

declare module 'd3-selection' {
	interface Selection<GElement extends BaseType, Datum, PElement extends BaseType, PDatum> {
		show(): this;
		hide(): this;
		toggle(): this;
		showIF(flag: unknown): this;
		isVisible(): boolean;
		shrinkHide(target?: CoverTarget, opts?: CoverOpts): Promise<this>;
		resumeShow(target?: CoverTarget, opts?: CoverOpts): Promise<this>;
		parent(): Selection<BaseType, unknown, null, undefined>;
		prepend(elem: string): Selection<BaseType, Datum, PElement, PDatum>;
		getSize(): [number, number];
		getOffset(): [number, number];
		getOuterSize(): [number, number];
		toggleClass(name: string): boolean;
		/** ⚠ d3 の empty()（空か？）を上書き＝中身を空にする（common の流儀） */
		empty(): this;
		prependNode(el: Node): this;
		appendNode(el: Node): this;
		editable(def: string, exec: (text: string) => void): this;
		css(q: Record<string, string | number | null | undefined>): this;
		slideX(flag?: boolean): this;
		trigger(event: string | Event, props?: unknown): this;
		context2D(opts?: Context2DOpts): Context2D;
	}
}

d3.selection.prototype.show = function(this: Proto): Proto { return this.classed("hidden", false); };
d3.selection.prototype.hide = function(this: Proto): Proto { return this.classed("hidden", true); };
d3.selection.prototype.toggle = function(this: Proto): Proto { return this.classed("hidden", !this.classed("hidden")); };
d3.selection.prototype.showIF = function(this: Proto, flag: unknown): Proto { return this.classed("hidden", !flag); };
d3.selection.prototype.isVisible = function(this: Proto): boolean { return !this.classed("hidden"); };
d3.selection.prototype.shrinkHide = function(this: Proto, target?: CoverTarget, opts?: CoverOpts): Promise<Proto> { return shrinkHide(this, target, opts); };
d3.selection.prototype.resumeShow = function(this: Proto, target?: CoverTarget, opts?: CoverOpts): Promise<Proto> { return resumeShow(this, target, opts); };

d3.selection.prototype.parent = function(this: Proto) { return d3.select(this.node()!.parentNode as d3.BaseType); };
d3.selection.prototype.prepend = function(this: Proto, elem: string) { return this.insert(elem,":first-child"); };
d3.selection.prototype.getSize = function(this: Proto): [number, number] { let rect = this.node()!.getBoundingClientRect(); return [~~rect.width, ~~rect.height]; };
d3.selection.prototype.getOffset = function(this: Proto): [number, number] { let rect = this.node()!.getBoundingClientRect(); return [~~rect.left, ~~rect.top]; };
d3.selection.prototype.getOuterSize = function(this: Proto): [number, number] { let rect = this.node()!.getBoundingClientRect();
	const num = (s: string): number => +s.replace(/px$/,"");
	const {marginTop, marginRight, marginBottom, marginLeft} = window.getComputedStyle(this.node()!);
	return [rect.width + num(marginRight)+num(marginLeft), rect.height + num(marginTop)+num(marginBottom)]; };
d3.selection.prototype.toggleClass = function(this: Proto, name: string): boolean { let flag = !this.classed(name); this.classed(name, flag); return flag; };
d3.selection.prototype.empty = function(this: Proto): Proto { return this.html(""); };
d3.selection.prototype.prependNode = function(this: Proto, el: Node): Proto { this.node()!.insertBefore(el, this.node()!.childNodes[0]); return this; }
d3.selection.prototype.appendNode = function(this: Proto, el: Node): Proto { this.node()!.appendChild(el); return this; }
d3.selection.prototype.editable = function(this: Proto, def: string, exec: (text: string) => void): Proto {
	let emode = false;
	return this.attr("contenteditable",true).text(def).on("change",e=>exec(this.text()))
	.on("keydown",(e: KeyboardEvent)=>emode = (e.which==13))
	.on("keyup", (e: KeyboardEvent)=>emode && (e.which==13) && exec(this.text()));
}
const unCamel = (str: string): string => str.replace(/[A-Z]/g, t => "-" + t.toLowerCase());
const pxProps = new Set([
	"top", "bottom", "left", "right",
	"margin", "padding", "width", "height",
	"margin-top", "margin-bottom", "margin-left", "margin-right",
	"padding-top", "padding-bottom", "padding-left", "padding-right",
	"font-size", "border-width"
]);
d3.selection.prototype.css = function (this: Proto, q: Record<string, string | number | null | undefined>): Proto {
	Object.entries(q).forEach(([key, val]) => {
		const kebabKey = unCamel(key);
		if (typeof val === 'number' && !isNaN(val) && pxProps.has(kebabKey)) {
			val = val + "px";
		}
		val == null ? this.style(kebabKey, null) : this.style(kebabKey, val);
	});
	return this;
};
d3.selection.prototype.slideX = function(this: Proto, flag?: boolean): Proto { const node = this.node()!;
	this.on("wheel",(e: WheelEvent)=>{ node.scrollBy(e.deltaX+e.deltaY, 0); e.preventDefault(); e.stopPropagation(); });
	flag || this.on("mouseleave",e=>node.scrollLeft = 0);
	return this;
};
d3.selection.prototype.trigger = function(this: Proto, event: string | Event, props: unknown = {}): Proto {
	const evt = isString(event)? new CustomEvent(event, {detail:props}): event;
	this.node() && this.node()!.dispatchEvent(evt);
	return this;
};
d3.selection.prototype.context2D = function(this: Proto, opts: Context2DOpts = {}): Context2D { const target = opts.target = this;
	const mag = opts.mag || 1;
	const [w,h] = target.getSize();//.map(t=>t*mag);
	let width = opts.width || w;
	let height = opts.height || h;
	const ctx = context2D(width*mag, height*mag, opts); ctx.scale(mag,mag);
	window.addEventListener("resize", resize);
	ctx.clear = () => (ctx.clearRect(0,0,width,height),ctx);
	return ctx;
	function resize(): void {	[width,height] = target.getSize(); ctx.size([width*mag,height*mag]); }
};
const context2D = (w = 300, h = 150, opts: Context2DOpts = {}): Context2D => {
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d") as Context2D;
	canvas.width = w;
	canvas.height = h;
	// Direct DOM property assignment is faster and safer than setAttribute.
	if (opts.id) canvas.id = opts.id;
	if (opts.name) canvas.setAttribute("name", opts.name);
	if (opts.class) canvas.className = opts.class;
	if (opts.style) canvas.style.cssText = opts.style;
	// Accept a CSS selector string, a D3 selection, or a raw DOM node as target.
	if (opts.target) {
		const parent = typeof opts.target === "string" ? document.querySelector(opts.target) :
			"node" in opts.target ? opts.target.node() : opts.target;
		if (parent) parent.appendChild(canvas);
	}
	if (opts.fill) {
		ctx.fillStyle = opts.fill;
		ctx.fillRect(0, 0, w, h);
	}
	ctx.toBlob = (type = "image/png", quality = 1.0) =>
		new Promise(resolve => canvas.toBlob(resolve, type, quality));
	function size(): [number, number];
	function size(v: [number, number]): Context2D;
	function size(v?: [number, number]): Context2D | [number, number] {
		if (v) { canvas.width = v[0]; canvas.height = v[1]; return ctx; }
		return [canvas.width, canvas.height];
	}
	ctx.size = size;
	ctx.clear = () => {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		return ctx;
	};
	ctx.show = () => { canvas.style.display = ""; return ctx; };
	ctx.hide = () => { canvas.style.display = "none"; return ctx; };
	return ctx;
};
function clone(dom: Element, target: CoverTarget): d3.Selection<HTMLDivElement, unknown, null, undefined> {
	const el: Element | null | undefined = target && "node" in target ? target.node() : target;
	const div = document.createElement("div");
	div.appendChild(dom.cloneNode(true));
	dom.parentNode!.appendChild(div);

	const setOrigin = (): string => {
		if (!el) return "50% 50%";
		const tr = el.getBoundingClientRect();
		const dr = div.getBoundingClientRect();
		const ox = (tr.left + tr.width / 2) - dr.left;
		const oy = (tr.top + tr.height / 2) - dr.top;
		return `${ox}px ${oy}px`;
	};

	return d3.select(div)
		.classed("overlay-fullbody", true)
		.style("transform-origin", setOrigin());
}
function shrinkHide(selection: Proto, target: CoverTarget, opts: CoverOpts = {}): Promise<Proto> {
	const cover = clone(selection.node()!, target);
	selection.hide();
	return new Promise(resolve => {
		cover.transition()
			.ease(opts.ease || d3.easeCubic)
			.duration(opts.trans || 500)
			.style("transform", "scale(0)")
			.on("end", () => {
				cover.remove();
				if (opts.fallback) opts.fallback(selection);
				resolve(selection);
			});
	});
}
function resumeShow(selection: Proto, target: CoverTarget, opts: CoverOpts = {}): Promise<Proto> {
	selection.show();
	const cover = clone(selection.node()!, target).style("transform", "scale(0)");
	selection.hide();
	return new Promise(resolve => {
		cover.transition()
			.ease(opts.ease || d3.easeCubic)
			.duration(opts.trans || 500)
			.style("transform", "scale(1)")
			.on("end", () => {
				selection.show();
				cover.remove();
				if (opts.fallback) opts.fallback(selection);
				resolve(selection);
			});
	});
}

