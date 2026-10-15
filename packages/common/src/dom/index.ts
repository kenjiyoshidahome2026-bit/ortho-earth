// common/dom ── d3-selection を使わない native DOM の薄い chainable セレクション（v2 側の UI 層）。
// [[v1/v2並行]] の通り packages/common/src/d3/ は v1 アプリ（www/gishub/gishub-jp/uploader）のまま据え置き、
// こちらを新しい apps が使う。API は common/d3/selection.ts と同じ形＝呼び出し側は書き換え不要で移れる。
//
// d3-selection の「難しい 80%」＝データジョイン（update/exit・キー関数・transition エンジン）は**作らない**。
// このコードベースは静的 enter（.data(list).enter().append()）しか使っておらず、それだけを実装している。
//
// ⚠ .empty() は d3 と意味が違う（common/d3 の流儀を継承）＝「空か？」ではなく「中身を空にする」。
//    d3 の empty() 相当が要るなら .size() === 0 を使う。
import { isString, isFunction } from "common";   // 名前で読む＝共有エンジンを読む頁ではエンジンの入口 common（束に二重に焼かない・2026-10-15）
import "./dom.scss";

const SVG = "http://www.w3.org/2000/svg";
const XHTML = "http://www.w3.org/1999/xhtml";

/** セレクションが持つノード＝要素に d3 と同じ場所（__data__）でデータを載せる */
export interface DataNode extends Element { __data__?: unknown }
/** 値のコールバック（this=ノード, 第1=データ, 第2=添字）＝d3 と同じ引数 */
export type ValueFn<R> = (this: DataNode, d: unknown, i: number) => R;
export type ValueOrFn<R> = R | ValueFn<R>;
/** 属性・スタイルに書ける値（null/undefined＝外す） */
export type AttrValue = string | number | boolean | null | undefined;
/** イベントの listener（this=ノード, 第1=イベント, 第2=データ）。null＝外す */
export type Listener<E extends Event = Event> = (this: DataNode, event: E, d: unknown) => void;
/** 縮む／膨らむの的＝セレクションか要素（無ければ中心から） */
export type CoverTarget = { node(): Element | null } | Element | null | undefined;
export interface CoverOpts { trans?: number; easing?: string; fallback?: (sel: Sel) => void }
/** 入口 sel() が受ける物＝セレクタ／要素／セレクション */
export type SelInput = string | DataNode | { node(): DataNode | null } | null | undefined;

// 生成時の名前空間＝d3 の creatorInherit と同じ規則。svg は明示、その他は親の名前空間を継ぐ
// （これが無いと <svg> の中の rect/path が HTML 要素として作られて描かれない）。
function create(parent: DataNode | null, name: string): DataNode {
	if (name === "svg") return document.createElementNS(SVG, "svg");
	const ns = parent && parent.namespaceURI;
	return (ns && ns !== XHTML) ? document.createElementNS(ns, name) : document.createElement(name);
}

// 値かコールバックか。コールバックは d3 と同じ引数（this=ノード, 第1=データ, 第2=添字）
const valueOf = <R>(v: ValueOrFn<R>, node: DataNode, i: number): R => isFunction(v) ? (v as ValueFn<R>).call(node, node.__data__, i) : (v as R);

// .on("click.tip", f) の名前空間＝同じ type.name で登録し直すと前のリスナが外れる（d3 と同じ）。
// tip/pop が mouseenter.tip 等を張り直すので、これが無いとリスナが増殖する。
const LISTENERS = new WeakMap<DataNode, Map<string, { fn: EventListener; options: AddEventListenerOptions | boolean | undefined }>>();

class Sel {
	_: DataNode[];
	_parent: DataNode | null;
	constructor(nodes: DataNode[], parent: DataNode | null = null) { this._ = nodes; this._parent = parent; }

	// d3 のセレクションと同じく反復可能＝[...sel] でノード配列になる（world が多用）
	[Symbol.iterator](): IterableIterator<DataNode> { return this._[Symbol.iterator](); }
	size(): number { return this._.length; }
	node(): DataNode | null { return this._[0] || null; }
	nodes(): DataNode[] { return this._.slice(); }
	each(func: ValueFn<unknown>): this { this._.forEach((n, i) => func.call(n, n.__data__, i)); return this; }
	call<A extends unknown[]>(func: (sel: this, ...args: A) => unknown, ...args: A): this { func(this, ...args); return this; }

	// ── 探索 ──
	// select は親のデータを引き継ぐ（d3 と同じ）。selectAll は引き継がない。
	select(selector: string): Sel {
		const out: DataNode[] = [];
		for (const n of this._) {
			const c: DataNode | null = n.querySelector(selector);
			if (c) { if (c.__data__ === undefined) c.__data__ = n.__data__; out.push(c); }
		}
		return new Sel(out, this._[0] || null);
	}
	selectAll(selector: string): Sel {
		const out: DataNode[] = [];
		for (const n of this._) out.push(...n.querySelectorAll(selector));
		return new Sel(out, this._[0] || null);
	}
	parent(): Sel { const n = this.node(); return new Sel(n && n.parentNode ? [n.parentNode as DataNode] : []); }
	filter(func: string | ValueFn<unknown>): Sel { return new Sel(this._.filter((n, i) => isFunction(func) ? func.call(n, n.__data__, i) : n.matches(func)), this._parent); }

	// ── 生成・削除 ──
	append(name: string): Sel { return new Sel(this._.map(n => { const el = create(n, name); el.__data__ = n.__data__; n.appendChild(el); return el; }), this._[0] || null); }
	insert(name: string, before?: string): Sel { return new Sel(this._.map(n => { const el = create(n, name); el.__data__ = n.__data__; n.insertBefore(el, before ? n.querySelector(before) : null); return el; }), this._[0] || null); }
	prepend(name: string): Sel { return new Sel(this._.map(n => { const el = create(n, name); el.__data__ = n.__data__; n.insertBefore(el, n.firstChild); return el; }), this._[0] || null); }
	prependNode(el: Node): this { const n = this.node(); n && n.insertBefore(el, n.firstChild); return this; }
	appendNode(el: Node): this { const n = this.node(); n && n.appendChild(el); return this; }
	remove(): this { this._.forEach(n => n.remove()); return this; }
	empty(): this { return this.html(""); }   // ⚠ d3 と別物＝中身を空にする（common/d3 の流儀）

	// ── 属性・内容 ──
	attr(name: string): string | null;
	attr(name: string, value: ValueOrFn<AttrValue>): this;
	attr(name: string, value?: ValueOrFn<AttrValue>): string | null | this {
		if (value === undefined) { const n = this.node(); return n ? n.getAttribute(name) : null; }
		this._.forEach((n, i) => { const v = valueOf(value, n, i); v == null ? n.removeAttribute(name) : n.setAttribute(name, v as string); });
		return this;
	}
	property(name: string): unknown;
	property(name: string, value: ValueOrFn<unknown>): this;
	property(name: string, value?: ValueOrFn<unknown>): unknown {
		if (value === undefined) { const n = this.node(); return n ? (n as unknown as Record<string, unknown>)[name] : undefined; }
		this._.forEach((n, i) => (n as unknown as Record<string, unknown>)[name] = valueOf(value, n, i));
		return this;
	}
	classed(name: string): boolean;
	classed(name: string, value: ValueOrFn<unknown>): this;
	classed(name: string, value?: ValueOrFn<unknown>): boolean | this {
		if (value === undefined) { const n = this.node(); return !!n && n.classList.contains(name); }
		this._.forEach((n, i) => n.classList.toggle(name, !!valueOf(value, n, i)));
		return this;
	}
	toggleClass(name: string): boolean { const flag = !this.classed(name); this.classed(name, flag); return flag; }
	style(name: string): string;
	style(name: string, value: ValueOrFn<string | number | null | undefined>, priority?: string): this;
	style(name: string, value?: ValueOrFn<string | number | null | undefined>, priority?: string): string | this {
		if (value === undefined) { const n = this.node(); return n ? getComputedStyle(n).getPropertyValue(name) : ""; }
		this._.forEach((n, i) => { const v = valueOf(value, n, i); v == null ? (n as HTMLElement).style.removeProperty(name) : (n as HTMLElement).style.setProperty(name, v as string, priority); });
		return this;
	}
	text(): string | null;
	text(value: ValueOrFn<unknown>): this;
	text(value?: ValueOrFn<unknown>): string | null | this {
		if (value === undefined) { const n = this.node(); return n ? n.textContent : ""; }
		this._.forEach((n, i) => n.textContent = (valueOf(value, n, i) ?? "") as string);
		return this;
	}
	html(): string;
	html(value: ValueOrFn<unknown>): this;
	html(value?: ValueOrFn<unknown>): string | this {
		if (value === undefined) { const n = this.node(); return n ? n.innerHTML : ""; }
		this._.forEach((n, i) => n.innerHTML = (valueOf(value, n, i) ?? "") as string);
		return this;
	}
	datum(): unknown;
	datum(value: unknown): this;
	datum(value?: unknown): unknown { if (value === undefined) { const n = this.node(); return n && n.__data__; } this._.forEach(n => n.__data__ = value); return this; }

	// ── イベント ──
	// listener は d3 と同じ引数（this=ノード, 第1=イベント, 第2=データ）。type は "click.名前空間" 可。
	on<E extends Event = Event>(type: string, listener: Listener<E> | null | undefined, options?: AddEventListenerOptions | boolean): this {
		const [kind, ...ns] = type.split(".");
		const key = ns.length ? type : kind;
		this._.forEach(n => {
			let map = LISTENERS.get(n); map || LISTENERS.set(n, map = new Map());
			const old = map.get(key);
			if (old) { n.removeEventListener(kind, old.fn, old.options); map.delete(key); }
			if (listener == null) return;
			const fn = function (event: Event): void { listener.call(n, event as E, n.__data__); };
			n.addEventListener(kind, fn, options);
			map.set(key, { fn, options });
		});
		return this;
	}
	trigger(event: string | Event, props: unknown = {}): this {
		const evt = isString(event) ? new CustomEvent(event, { detail: props }) : event;
		const n = this.node(); n && n.dispatchEvent(evt);
		return this;
	}

	// ── 静的 enter だけのデータ結合 ──
	// 既存ノードを超えた分のデータ＝enter。update/exit・キー関数は持たない（このコードベースは使っていない）。
	data(values: unknown[]): { enter: () => EnterSel; exit: () => Sel; nodes: DataNode[] } {
		const parent = this._parent, existing = this._.length;
		this._.forEach((n, i) => n.__data__ = values[i]);
		return {
			enter: () => new EnterSel(parent, values.slice(existing)),
			exit: () => new Sel(this._.slice(values.length), parent),
			nodes: this._,
		};
	}

	// ── 表示の切り替え（.hidden クラス＝dom.scss）──
	show(): this { return this.classed("hidden", false); }
	hide(): this { return this.classed("hidden", true); }
	toggle(): this { return this.classed("hidden", !this.classed("hidden")); }
	showIF(flag: unknown): this { return this.classed("hidden", !flag); }
	isVisible(): boolean { return !this.classed("hidden"); }

	// ── 寸法 ──
	getSize(): [number, number] { const r = this.node()!.getBoundingClientRect(); return [~~r.width, ~~r.height]; }
	getOffset(): [number, number] { const r = this.node()!.getBoundingClientRect(); return [~~r.left, ~~r.top]; }
	getOuterSize(): [number, number] {
		const r = this.node()!.getBoundingClientRect();
		const num = (s: string): number => +String(s).replace(/px$/, "") || 0;
		const { marginTop, marginRight, marginBottom, marginLeft } = getComputedStyle(this.node()!);
		return [r.width + num(marginRight) + num(marginLeft), r.height + num(marginTop) + num(marginBottom)];
	}

	// ── まとめてスタイル（数値は px を補う）──
	css(q: Record<string, string | number | null | undefined>): this {
		Object.entries(q).forEach(([key, val]) => {
			const k = unCamel(key);
			this.style(k, (typeof val === "number" && !isNaN(val) && PX_PROPS.has(k)) ? val + "px" : val);
		});
		return this;
	}

	// 横スクロール帯。離脱時に戻す位置は「張った時の位置」＝RTL でも正しい（物理 0 を決め打ちしない）
	slideX(keep?: boolean): this {
		const node = this.node(); if (!node) return this;
		const home = node.scrollLeft;
		this.on("wheel", (e: WheelEvent) => { node.scrollBy(e.deltaX + e.deltaY, 0); e.preventDefault(); e.stopPropagation(); });
		keep || this.on("mouseleave", () => node.scrollLeft = home);
		return this;
	}

	editable(def: string, exec: (text: string | null) => void): this {
		let emode = false;
		return this.attr("contenteditable", true).text(def).on("change", () => exec(this.text()))
			.on("keydown", (e: KeyboardEvent) => emode = (e.key === "Enter"))
			.on("keyup", (e: KeyboardEvent) => emode && e.key === "Enter" && exec(this.text()));
	}

	// ── 縮んで消える／膨らんで出る（d3-transition を使わず Web Animations で）──
	shrinkHide(target?: CoverTarget, opts: CoverOpts = {}): Promise<Sel> { return scaleCover(this, target, opts, 1, 0, () => this.hide()); }
	resumeShow(target?: CoverTarget, opts: CoverOpts = {}): Promise<Sel> {
		this.show();
		const run = scaleCover(this, target, opts, 0, 1, () => { });
		this.hide();
		return run.then(() => (this.show(), this));
	}
}

// enter セレクション＝親に対して要素を作るだけ。データはノードに載せる（__data__＝d3 と同じ場所）
class EnterSel {
	_parent: DataNode | null;
	_values: unknown[];
	constructor(parent: DataNode | null, values: unknown[]) { this._parent = parent; this._values = values; }
	append(name: string): Sel {
		const parent = this._parent;
		return new Sel(this._values.map(d => { const el = create(parent, name); el.__data__ = d; parent!.appendChild(el); return el; }), parent);
	}
	size(): number { return this._values.length; }
}

const unCamel = (s: string): string => s.replace(/[A-Z]/g, t => "-" + t.toLowerCase());
const PX_PROPS = new Set(["top", "bottom", "left", "right", "inset-block-start", "inset-block-end", "inset-inline-start", "inset-inline-end",
	"margin", "padding", "width", "height",
	"margin-top", "margin-bottom", "margin-left", "margin-right", "margin-inline-start", "margin-inline-end",
	"padding-top", "padding-bottom", "padding-left", "padding-right", "padding-inline-start", "padding-inline-end",
	"font-size", "border-width"]);

// 本体を複製した覆いを拡大／縮小する（本体は動かさない＝レイアウトを揺らさない）
function scaleCover(selection: Sel, target: CoverTarget, opts: CoverOpts, from: number, to: number, onStart: () => void): Promise<Sel> {
	const node = selection.node();
	if (!node) return Promise.resolve(selection);
	const div = document.createElement("div");
	div.appendChild(node.cloneNode(true));
	node.parentNode!.appendChild(div);
	div.classList.add("overlay-fullbody");
	div.style.transformOrigin = origin(div, target);
	onStart();
	const anim = div.animate(
		[{ transform: `scale(${from})` }, { transform: `scale(${to})` }],
		{ duration: opts.trans || 500, easing: opts.easing || "cubic-bezier(0.65,0,0.35,1)", fill: "forwards" });   // easeCubic 相当
	return anim.finished.catch(() => { }).then(() => {
		div.remove();
		opts.fallback && opts.fallback(selection);
		return selection;
	});
}
function origin(div: HTMLElement, target: CoverTarget): string {
	if (!target) return "50% 50%";
	const node = target && "node" in target ? target.node() : target;
	if (!node || !node.getBoundingClientRect) return "50% 50%";
	const tr = node.getBoundingClientRect(), dr = div.getBoundingClientRect();
	return `${(tr.left + tr.width / 2) - dr.left}px ${(tr.top + tr.height / 2) - dr.top}px`;
}

// ── 入口 ──
const toNode = (q: SelInput): DataNode | null | undefined => isString(q) ? document.querySelector(q) : (q && "node" in q) ? q.node() : q;
export function sel(q: SelInput): Sel { const n = toNode(q); return new Sel(n ? [n] : []); }
export function selAll(q: string | Iterable<DataNode> | null | undefined): Sel { return new Sel(isString(q) ? [...document.querySelectorAll<DataNode>(q)] : [...(q || [])]); }
export { Sel, EnterSel };
