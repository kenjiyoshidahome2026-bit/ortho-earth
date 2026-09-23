// DOM の Marker / Popup（MapLibre と同名・#38・2026-09-23）＝経緯度に DOM を留める薄い部品。
//   new Marker({ element?, color?, scale?, anchor?, offset?, draggable?, altitude? }).setLngLat([lon, lat]).addTo(map)
//   new Popup({ closeButton?, closeOnClick?, anchor?, offset?, maxWidth?, className? }).setLngLat(…).setHTML(…).addTo(map)
//   marker.setPopup(popup)＝マーカーのクリックで開閉（MapLibre と同じ）。
// 位置は描くたび（map.onFrame）に投影し直す＝地形の高さに乗る（altitude＝地表からの高さ m）・球の裏へ回ったら隠す。
// 引出線つきの吹き出し（pop ガジェット）とは別物＝こちらは錨の真上に留まる箱。
const CSS = `
.oe-marker{position:absolute;left:0;top:0;will-change:transform;cursor:pointer;z-index:3}
.oe-marker.oe-drag{cursor:grab;touch-action:none}
.oe-popup{position:absolute;left:0;top:0;will-change:transform;z-index:4;pointer-events:auto;display:flex;flex-direction:column;align-items:center}
.oe-popup-body{position:relative;background:var(--qm-surface,#fff);color:var(--qm-text,#222);border-radius:6px;padding:10px 12px;box-shadow:0 1px 4px rgba(0,0,0,.25);font:13px/1.45 system-ui,sans-serif;max-width:var(--oe-pop-max,240px)}
.oe-popup-close{position:absolute;top:0;inset-inline-end:0;border:0;background:none;font:16px/1 system-ui;padding:4px 7px;cursor:pointer;color:inherit;opacity:.6}
.oe-popup-close:hover{opacity:1}
.oe-popup-tip{width:0;height:0;border:7px solid transparent}
.oe-popup[data-anchor=bottom] .oe-popup-tip{border-top-color:var(--qm-surface,#fff);border-bottom:0;order:2}
.oe-popup[data-anchor=top] .oe-popup-tip{border-bottom-color:var(--qm-surface,#fff);border-top:0;order:-1}
.oe-popup[data-anchor=left],.oe-popup[data-anchor=right]{flex-direction:row}
.oe-popup[data-anchor=left] .oe-popup-tip{border-right-color:var(--qm-surface,#fff);border-left:0;order:-1}
.oe-popup[data-anchor=right] .oe-popup-tip{border-left-color:var(--qm-surface,#fff);border-right:0;order:2}`;
let cssOn = false;
const ensureCss = () => { if (cssOn) return; cssOn = true; const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); };
const lngLatOf = c => Array.isArray(c) ? [+c[0], +c[1]] : [+(c.lng ?? c.lon), +c.lat];
const pinSvg = (color, scale) => `<svg width="${27 * scale}" height="${41 * scale}" viewBox="0 0 27 41" aria-hidden="true"><path d="M13.5 0C6 0 0 6 0 13.4 0 23.5 13.5 41 13.5 41S27 23.5 27 13.4C27 6 21 0 13.5 0z" fill="${color}"/><circle cx="13.5" cy="13.5" r="5" fill="#fff"/></svg>`;
// 錨の位置に対する要素の置き方（translate の割合）
const ANCHOR = { center: [-0.5, -0.5], top: [-0.5, 0], bottom: [-0.5, -1], left: [0, -0.5], right: [-1, -0.5], "top-left": [0, 0], "top-right": [-1, 0], "bottom-left": [0, -1], "bottom-right": [-1, -1] };

// 地図ごとの登録簿＝描くたびに全部を 1 本の投影で置き直す
const registry = new WeakMap();
function reg(map) {
	let r = registry.get(map);
	if (r) return r;
	r = { items: new Set(), off: null };
	const place = () => {
		if (!r.items.size) return;
		const proj = map.makeProjectorH({ terrain: true });
		for (const it of r.items) it._place(proj);
	};
	r.off = map.onFrame(place);
	r.place = place;
	registry.set(map, r);
	return r;
}
class Evented {
	constructor() { this._ev = new Map(); }
	on(t, f) { (this._ev.get(t) ?? this._ev.set(t, new Set()).get(t)).add(f); return this; }
	off(t, f) { this._ev.get(t)?.delete(f); return this; }
	once(t, f) { const g = e => { this.off(t, g); f(e); }; return this.on(t, g); }
	fire(t, e = {}) { for (const f of this._ev.get(t) || []) try { f({ type: t, target: this, ...e }); } catch (err) { console.error("[marker]", err); } return this; }
}

export class Marker extends Evented {
	constructor(opts = {}) {
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
	setLngLat(ll) { this._ll = lngLatOf(ll); this._popup?.setLngLat(this._ll); this._map && reg(this._map).place(); return this; }
	getLngLat() { return this._ll ? { lng: this._ll[0], lat: this._ll[1] } : null; }
	getElement() { return this._el; }
	setOffset(o) { this._opts.offset = o; return this; }
	setDraggable(on) { this._opts.draggable = !!on; if (on) this._bindDrag(); this._el.classList.toggle("oe-drag", !!on); return this; }
	isDraggable() { return !!this._opts.draggable; }
	setAltitude(m) { this._opts.altitude = +m || 0; return this; }
	addTo(map) {
		this.remove();
		this._map = map;
		map.mapEl.append(this._el);
		reg(map).items.add(this); reg(map).place();
		return this;
	}
	remove() {
		if (this._map) { reg(this._map).items.delete(this); this._popup?.remove(); }
		this._el.remove(); this._map = null;
		return this;
	}
	setPopup(p) { this._popup = p || null; if (p && this._ll) p.setLngLat(this._ll); if (p) p._marker = this; return this; }
	getPopup() { return this._popup; }
	togglePopup() { const p = this._popup; if (!p || !this._map) return this; if (p.isOpen()) p.remove(); else p.setLngLat(this._ll).addTo(this._map); return this; }
	_place(proj) {
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
			const mv = ev => { const ll = this._map.unprojectXY(ev.clientX - r.left, ev.clientY - r.top); if (!ll) return; if (!moved) { moved = true; this.fire("dragstart"); } this.setLngLat(ll); this.fire("drag"); };
			const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); if (moved) { this._dragged = true; this.fire("dragend"); } };
			el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
		});
	}
}

export class Popup extends Evented {
	constructor(opts = {}) {
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
		this._onMapClick = e => { if (!this._el.contains(e.target) && !this._marker?.getElement().contains(e.target)) this.remove(); };
	}
	setLngLat(ll) { this._ll = lngLatOf(ll); this._map && reg(this._map).place(); return this; }
	getLngLat() { return this._ll ? { lng: this._ll[0], lat: this._ll[1] } : null; }
	setHTML(html) { this._content.innerHTML = html; return this; }   // ⚠呼び手の HTML をそのまま入れる（MapLibre と同じ）＝外来の文字列は setText で
	setText(s) { this._content.textContent = s; return this; }
	setDOMContent(node) { this._content.replaceChildren(node); return this; }
	setMaxWidth(w) { this._el.style.setProperty("--oe-pop-max", w); return this; }
	getElement() { return this._el; }
	isOpen() { return !!this._map; }
	addTo(map) {
		if (this._map) this.remove();
		this._map = map;
		map.mapEl.append(this._el);
		reg(map).items.add(this); reg(map).place();
		if (this._opts.closeOnClick) setTimeout(() => this._map && map.mapEl.addEventListener("click", this._onMapClick), 0);   // 開けたクリック自身で閉じない
		this.fire("open");
		return this;
	}
	remove() {
		if (!this._map) return this;
		reg(this._map).items.delete(this);
		this._map.mapEl.removeEventListener("click", this._onMapClick);
		this._el.remove(); this._map = null;
		this.fire("close");
		return this;
	}
	_place(proj) {
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
