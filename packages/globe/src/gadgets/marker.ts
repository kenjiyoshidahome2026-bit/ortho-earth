// DOM の Marker / Popup（MapLibre と同名・#38・2026-09-23）＝経緯度に DOM を留める薄い部品。
//   new Marker({ element?, color?, scale?, anchor?, offset?, draggable?, altitude? }).setLngLat([lon, lat]).addTo(map)
//   new Popup({ closeButton?, closeOnClick?, anchor?, offset?, maxWidth?, className? }).setLngLat(…).setHTML(…).addTo(map)
//   marker.setPopup(popup)＝マーカーのクリックで開閉（MapLibre と同じ）。
// 位置は描くたび（map.onFrame）に投影し直す＝地形の高さに乗る（altitude＝地表からの高さ m）・球の裏へ回ったら隠す。
// 引出線つきの吹き出し（pop ガジェット）とは別物＝こちらは錨の真上に留まる箱。
import { RAW } from "../zoomscale.js";
import type { LonLat, MarkerOptions, PopupOptions } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** 部品が使う map の口（mapEl・投影・描画のフック・move・逆投影）。旗つきの顔は [RAW] に素の map を持つ */
type MarkerMap = Pick<GlobeMap, "mapEl" | "makeProjectorH" | "onFrame" | "on" | "unprojectXY" | "unproject"> & { [RAW]?: MarkerMap };
/** 地形込みの投影（lon, lat, 高さ m → [x, y, front]） */
type Proj = ReturnType<GlobeMap["makeProjectorH"]>;
/** 経緯度の受け口（[lon, lat] か { lng|lon, lat }） */
type LngLatLike = LonLat | number[] | { lng?: number; lon?: number; lat: number };
/** 登録簿（地図ごと）＝描くたびに items を置き直す */
interface Reg { items: Set<{ _place(proj: Proj): void }>; off: (() => void) | null; place?: () => void }
/** 知らせの受け手（e＝{ type, target＝発した Marker／Popup, …添え物 }） */
type Listener<T> = (e: { type: string; target: T; [k: string]: unknown }) => void;
const rawOf = (map: MarkerMap) => map?.[RAW] ?? map;   // 旗つきの地図（外側の顔）でも素の map で登録・投影する（登録簿を顔と素で二重にしない・台帳 R2/R18）
const CSS = `
.oe-marker{position:absolute;left:0;top:0;will-change:transform;cursor:pointer;z-index:3}
.oe-marker.oe-drag{cursor:grab;touch-action:none}
.oe-popup{position:absolute;left:0;top:0;will-change:transform;z-index:4;pointer-events:auto;display:flex;flex-direction:column;align-items:center}
.oe-popup-body{position:relative;background:var(--qm-surface,#fff);color:var(--qm-text,#222);border-radius:6px;padding:10px 12px;box-shadow:0 1px 4px rgba(0,0,0,.25);font:13px/1.45 system-ui,sans-serif;max-width:var(--oe-pop-max,240px)}
.oe-popup-close{position:absolute;top:0;inset-inline-end:0;border:0;background:none;font:16px/1 system-ui;padding:4px 7px;cursor:pointer;color:inherit;opacity:.6}
.oe-popup-close:hover{opacity:1}
.oe-popup-tip{width:0;height:0;border:7px solid transparent}
.oe-popup.oe-popup-track{pointer-events:none}
.oe-popup[data-anchor=bottom] .oe-popup-tip{border-top-color:var(--qm-surface,#fff);border-bottom:0;order:2}
.oe-popup[data-anchor=top] .oe-popup-tip{border-bottom-color:var(--qm-surface,#fff);border-top:0;order:-1}
.oe-popup[data-anchor=left],.oe-popup[data-anchor=right]{flex-direction:row}
.oe-popup[data-anchor=left] .oe-popup-tip{border-right-color:var(--qm-surface,#fff);border-left:0;order:-1}
.oe-popup[data-anchor=right] .oe-popup-tip{border-left-color:var(--qm-surface,#fff);border-right:0;order:2}`;
let cssOn = false;
const ensureCss = () => { if (cssOn) return; cssOn = true; const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); };
const lngLatOf = (c: LngLatLike) => Array.isArray(c) ? [+c[0], +c[1]] : [+(c.lng ?? c.lon)!, +c.lat];
// color は呼び手の入力＝属性へ入れる前に逃がす（CodeQL・2026-10-16）。CSS の色（#hex・rgb()・名前）は & < > " を含まない＝出力は前と同じ
const escAttr = (s: unknown) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as Record<string, string>)[c]);
const pinSvg = (color: string, scale: number) => `<svg width="${27 * scale}" height="${41 * scale}" viewBox="0 0 27 41" aria-hidden="true"><path d="M13.5 0C6 0 0 6 0 13.4 0 23.5 13.5 41 13.5 41S27 23.5 27 13.4C27 6 21 0 13.5 0z" fill="${escAttr(color)}"/><circle cx="13.5" cy="13.5" r="5" fill="#fff"/></svg>`;
// 錨の位置に対する要素の置き方（translate の割合）
const ANCHOR: Record<string, number[]> = { center: [-0.5, -0.5], top: [-0.5, 0], bottom: [-0.5, -1], left: [0, -0.5], right: [-1, -0.5], "top-left": [0, 0], "top-right": [-1, 0], "bottom-left": [0, -1], "bottom-right": [-1, -1] };

// 地図ごとの登録簿＝描くたびに全部を 1 本の投影で置き直す
const registry = new WeakMap<MarkerMap, Reg>();
function reg(map: MarkerMap): Reg {
	let r = registry.get(map);
	if (r) return r;
	r = { items: new Set(), off: null };
	const place = () => {
		if (!r.items.size) return;
		const proj = map.makeProjectorH({ terrain: true });
		for (const it of r.items) it._place(proj);
	};
	r.off = map.onFrame(place);
	map.on("move", place);   // カメラが動いた瞬間にも置き直す（描画のフックは rAF 待ち＝重い時に 1 拍遅れる）
	r.place = place;
	registry.set(map, r);
	return r;
}
class Evented {
	declare _ev: Map<string, Set<Listener<this>>>;
	constructor() { this._ev = new Map(); }
	on(t: string, f: Listener<this>) { (this._ev.get(t) ?? this._ev.set(t, new Set()).get(t)!).add(f); return this; }
	off(t: string, f: Listener<this>) { this._ev.get(t)?.delete(f); return this; }
	once(t: string, f: Listener<this>) { const g: Listener<this> = e => { this.off(t, g); f(e); }; return this.on(t, g); }
	fire(t: string, e: Record<string, unknown> = {}) { for (const f of this._ev.get(t) || []) try { f({ type: t, target: this, ...e }); } catch (err) { console.error("[marker]", err); } return this; }
}

export class Marker extends Evented {
	declare _opts: MarkerOptions & { anchor: NonNullable<MarkerOptions["anchor"]>; offset: [number, number]; altitude: number };
	declare _el: HTMLElement; declare _ll: number[] | null; declare _map: MarkerMap | null; declare _popup: Popup | null;
	declare _dragged?: boolean; declare _dragBound?: boolean;
	constructor(opts: MarkerOptions | HTMLElement = {}) {
		super();
		ensureCss();
		if (opts instanceof HTMLElement) opts = { element: opts };
		this._opts = { anchor: opts.element ? "center" : "bottom", offset: [0, 0], altitude: 0, ...opts };
		const el = opts.element || Object.assign(document.createElement("div"), { innerHTML: pinSvg(opts.color || "#3FB1CE", opts.scale ?? 1) });
		el.classList.add("oe-marker");
		this._el = el; this._ll = null; this._map = null; this._popup = null;
		el.addEventListener("click", e => { if (this._dragged) { this._dragged = false; return; } if (this._popup) { e.stopPropagation(); this.togglePopup(); } });
		if (this._opts.draggable) this._bindDrag();
	}
	setLngLat(ll: LngLatLike) { this._ll = lngLatOf(ll); this._popup?.setLngLat(this._ll); this._map && reg(this._map).place!(); return this; }
	getLngLat() { return this._ll ? { lng: this._ll[0], lat: this._ll[1] } : null; }
	getElement() { return this._el; }
	setOffset(o: [number, number]) { this._opts.offset = o; return this; }
	setDraggable(on: boolean) { this._opts.draggable = !!on; if (on) this._bindDrag(); this._el.classList.toggle("oe-drag", !!on); return this; }
	isDraggable() { return !!this._opts.draggable; }
	setAltitude(m: number | string) { this._opts.altitude = +m || 0; return this; }
	addTo(map: MarkerMap) {
		this.remove();
		this._map = map = rawOf(map);
		map.mapEl.append(this._el);
		reg(map).items.add(this); reg(map).place!();
		return this;
	}
	remove() {
		if (this._map) { reg(this._map).items.delete(this); this._popup?.remove(); }
		this._el.remove(); this._map = null;
		return this;
	}
	setPopup(p: Popup | null) { this._popup = p || null; if (p && this._ll) p.setLngLat(this._ll); if (p) p._marker = this; return this; }
	getPopup() { return this._popup; }
	togglePopup() { const p = this._popup; if (!p || !this._map) return this; if (p.isOpen()) p.remove(); else p.setLngLat(this._ll!).addTo(this._map); return this; }
	_place(proj: Proj) {
		if (!this._ll) { this._el.style.display = "none"; return; }
		const [x, y, f] = proj(this._ll[0], this._ll[1], this._opts.altitude);
		if (f < 0) { this._el.style.display = "none"; return; }
		const [ax, ay] = ANCHOR[this._opts.anchor] || ANCHOR.center, [ox, oy] = this._opts.offset;
		this._el.style.display = "";
		this._el.style.transform = `translate(${x + ox}px, ${y + oy}px) translate(${ax * 100}%, ${ay * 100}%)`;
	}
	_bindDrag() {
		if (this._dragBound) return; this._dragBound = true;
		const el = this._el; el.classList.add("oe-drag");
		el.addEventListener("pointerdown", e => {
			if (!this._opts.draggable || !this._map) return;
			e.stopPropagation(); e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch { /* 合成イベント等＝捕捉なしで続ける */ }
			const r = this._map.mapEl.getBoundingClientRect(); let moved = false;
			const mv = (ev: PointerEvent) => { const ll = this._map!.unprojectXY(ev.clientX - r.left, ev.clientY - r.top); if (!ll) return; if (!moved) { moved = true; this.fire("dragstart"); } this.setLngLat(ll); this.fire("drag"); };
			const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); if (moved) { this._dragged = true; this.fire("dragend"); } };
			el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
		});
	}
}

export class Popup extends Evented {
	declare _opts: PopupOptions & { closeButton: boolean; closeOnClick: boolean; anchor: NonNullable<PopupOptions["anchor"]>; offset: number | [number, number]; maxWidth: string };
	declare _el: HTMLDivElement; declare _body: HTMLDivElement; declare _content: HTMLDivElement; declare _ll: number[] | null; declare _map: MarkerMap | null;
	declare _marker?: Marker; declare _onMapClick: (e: MouseEvent) => void; declare _track: boolean; declare _onTrack: (e: PointerEvent) => void;
	constructor(opts: PopupOptions = {}) {
		super();
		ensureCss();
		this._opts = { closeButton: true, closeOnClick: true, anchor: "bottom", offset: 0, maxWidth: "240px", ...opts };
		this._el = document.createElement("div");
		this._el.className = "oe-popup" + (opts.className ? " " + opts.className : "");
		this._body = Object.assign(document.createElement("div"), { className: "oe-popup-body" });
		this._el.append(Object.assign(document.createElement("div"), { className: "oe-popup-tip" }), this._body);
		this._content = document.createElement("div"); this._body.append(this._content);
		if (this._opts.closeButton) { const b = Object.assign(document.createElement("button"), { className: "oe-popup-close", type: "button", textContent: "×" }); b.setAttribute("aria-label", "Close"); b.addEventListener("click", () => this.remove()); this._body.append(b); }
		this._el.dataset.anchor = this._opts.anchor;
		this.setMaxWidth(this._opts.maxWidth);
		this._ll = null; this._map = null;
		this._onMapClick = e => { if (!this._el.contains(e.target as Node) && !this._marker?.getElement().contains(e.target as Node)) this.remove(); };
		// trackPointer（MapLibre 同名・C8）＝カーソルに付いて回る吹き出し。pointer-events を切り、mapEl の pointermove で lngLat を置き直す（球の外＝隠す）
		this._track = false;
		this._onTrack = e => { const m = this._map; if (!m) return; const r = m.mapEl.getBoundingClientRect(), ll = m.unproject([e.clientX - r.left, e.clientY - r.top]); if (ll) this.setLngLat([ll.lng, ll.lat]); else { this._ll = null; this._el.style.display = "none"; } };
	}
	trackPointer() { this._track = true; this._el.classList.add("oe-popup-track"); this._map?.mapEl.addEventListener("pointermove", this._onTrack); return this; }
	setLngLat(ll: LngLatLike) { this._ll = lngLatOf(ll); this._map && reg(this._map).place!(); return this; }
	getLngLat() { return this._ll ? { lng: this._ll[0], lat: this._ll[1] } : null; }
	setHTML(html: string) { this._content.innerHTML = html; return this; }   // ⚠呼び手の HTML をそのまま入れる（MapLibre と同じ）＝外来の文字列は setText で
	setText(s: string) { this._content.textContent = s; return this; }
	setDOMContent(node: Node) { this._content.replaceChildren(node); return this; }
	setMaxWidth(w: string) { this._el.style.setProperty("--oe-pop-max", w); return this; }
	getElement() { return this._el; }
	isOpen() { return !!this._map; }
	addTo(map: MarkerMap) {
		if (this._map) this.remove();
		this._map = map = rawOf(map);
		map.mapEl.append(this._el);
		reg(map).items.add(this); reg(map).place!();
		if (this._opts.closeOnClick) setTimeout(() => this._map && map.mapEl.addEventListener("click", this._onMapClick), 0);   // 開けたクリック自身で閉じない
		if (this._track) map.mapEl.addEventListener("pointermove", this._onTrack);
		this.fire("open");
		return this;
	}
	remove() {
		if (!this._map) return this;
		reg(this._map).items.delete(this);
		this._map.mapEl.removeEventListener("click", this._onMapClick);
		this._map.mapEl.removeEventListener("pointermove", this._onTrack);
		this._el.remove(); this._map = null;
		this.fire("close");
		return this;
	}
	_place(proj: Proj) {
		if (!this._ll) { this._el.style.display = "none"; return; }
		const alt = this._marker?._opts.altitude ?? 0;
		const [x, y, f] = proj(this._ll[0], this._ll[1], alt);
		if (f < 0) { this._el.style.display = "none"; return; }
		const a = this._opts.anchor, [ax, ay] = ANCHOR[a] || ANCHOR.bottom;
		let o = this._opts.offset; if (typeof o === "number") o = a === "top" ? [0, o] : a === "left" ? [o, 0] : a === "right" ? [-o, 0] : [0, -o];
		// マーカーに付いた吹き出し＝ピンの頭の上に出す（既定のピン＝高さ 41px）
		const mk = this._marker && !this._marker._opts.element && a === "bottom" ? -41 * (this._marker._opts.scale ?? 1) : 0;
		this._el.style.display = "";
		this._el.style.transform = `translate(${x + o[0]}px, ${y + o[1] + mk}px) translate(${ax * 100}%, ${ay * 100}%)`;
	}
}
