// 2 枚の地図を左右（上下）スワイプで比べる（#173 段 5・2026-09-30）＝MapLibre 公式 maplibre-gl-compare と同じ形。
//   const c = new Compare(before, after, container, { orientation: "vertical"|"horizontal", mousemove: false });
//   c.setSlider(x) ／ c.currentPosition ／ c.on("slideend", e => e.currentPosition) ／ c.off ／ c.remove()
// before＝つまみの左（上）・after＝右（下）を見せる。2 枚の容れ物は同じ場所に重ねて置く（利用者の CSS・公式と同じ）。
// 切り抜きは clip-path＝切った側はクリックも下の地図へ抜ける（公式は旧 clip）。カメラは sync.js で連動（mapbox-gl-sync-move と同じ所作）。
// before/after＝createGlobe の地図（mapEl）か MapLibre 互換の Map（getContainer()）。container＝つまみを置く要素（セレクタ可）。
import { syncMaps } from "./sync.js";

// 公式と同じクラス名＝公式の maplibre-gl-compare.css を当てている頁でも同じ見た目。値は公式の CSS に揃えた（つまみ 60px の丸・線 2px）
const CSS = `.maplibregl-compare{background-color:#fff;position:absolute;width:2px;height:100%;z-index:1}
.maplibregl-compare .compare-swiper-vertical{background-color:#3887be;box-shadow:inset 0 0 0 2px #fff;display:inline-block;border-radius:50%;position:absolute;width:60px;height:60px;top:50%;left:-30px;margin:-30px 1px 0;color:#fff;cursor:ew-resize;background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Cpath d='M 21.72 30.0 l 6 -6 v 12 z M 38.28 30.0 l -6 -6 v 12 z' fill='%23fff'/%3E%3C/svg%3E")}
.maplibregl-compare-horizontal{position:relative;width:100%;height:2px}
.maplibregl-compare .compare-swiper-horizontal{background-color:#3887be;box-shadow:inset 0 0 0 2px #fff;display:inline-block;border-radius:50%;position:absolute;width:60px;height:60px;left:50%;top:-30px;margin:1px -30px 0;color:#fff;cursor:ns-resize;transform:rotate(90deg);background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Cpath d='M 21.72 30.0 l 6 -6 v 12 z M 38.28 30.0 l -6 -6 v 12 z' fill='%23fff'/%3E%3C/svg%3E")}`;
const ensureCss = () => { if (document.getElementById("oj-compare-css")) return; const s = document.createElement("style"); s.id = "oj-compare-css"; s.textContent = CSS; document.head.append(s); };
const elOf = m => (typeof m.getContainer === "function" ? m.getContainer() : m.mapEl);

export class Compare {
	constructor(before, after, container, options = {}) {
		this.options = { mousemove: false, orientation: "vertical", ...options };
		this._horizontal = this.options.orientation === "horizontal";
		this._before = before; this._after = after;
		this._elA = elOf(before); this._elB = elOf(after);
		this._container = typeof container === "string" ? document.querySelector(container) : container;
		if (!this._elA || !this._elB || !this._container) throw new Error("Compare: maps and a container element are required");
		this._handlers = {};
		this._ac = new AbortController();
		ensureCss();
		const swiper = this._swiper = document.createElement("div");
		swiper.className = this._horizontal ? "compare-swiper-horizontal" : "compare-swiper-vertical";
		const ctl = this._controlContainer = document.createElement("div");
		ctl.className = this._horizontal ? "maplibregl-compare maplibregl-compare-horizontal" : "maplibregl-compare";
		ctl.append(swiper);
		this._container.append(ctl);
		this._clearSync = syncMaps([before, after]);
		const signal = this._ac.signal;
		const pos = e => { const b = this._bounds; return this._horizontal ? e.clientY - b.top : e.clientX - b.left; };
		// つまみのドラッグ（pointer＝マウスもタッチも）。離した時に slideend（公式と同じ）
		swiper.addEventListener("pointerdown", e => {
			e.preventDefault(); e.stopPropagation();
			this._bounds = this._elB.getBoundingClientRect();
			const move = ev => this._setPosition(pos(ev));
			const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); removeEventListener("pointercancel", up); this._fire("slideend", { currentPosition: this.currentPosition }); };
			addEventListener("pointermove", move, { signal }); addEventListener("pointerup", up, { signal }); addEventListener("pointercancel", up, { signal });
		}, { signal });
		if (this.options.mousemove) for (const el of [this._elA, this._elB]) el.addEventListener("mousemove", e => { this._bounds = this._elB.getBoundingClientRect(); this._setPosition(pos(e)); }, { signal });   // 公式と同じ＝両方の地図の上でカーソルを追う
		// 大きさが変わったら同じ割合の位置へ（公式は resize で中央へ戻す＝ここは割合を保つ）
		this._ro = new ResizeObserver(() => { const f = this._span ? this.currentPosition / this._span : 0.5; this._bounds = this._elB.getBoundingClientRect(); this._setPosition(this._size() * f); });
		this._ro.observe(this._elB);
		this._bounds = this._elB.getBoundingClientRect();
		this._setPosition(this._size() / 2);
	}
	_size() { return this._horizontal ? this._bounds.height : this._bounds.width; }
	_setPosition(x) {
		const w = this._bounds.width, h = this._bounds.height, span = this._size();
		x = Math.min(Math.max(x, 0), span);
		this._span = span;
		this.currentPosition = x;
		this._controlContainer.style.transform = this._horizontal ? `translate(0, ${x}px)` : `translate(${x}px, 0)`;
		// before＝[0, x)・after＝[x, 端)。inset(上 右 下 左)
		this._elA.style.clipPath = this._horizontal ? `inset(0 0 ${h - x}px 0)` : `inset(0 ${w - x}px 0 0)`;
		this._elB.style.clipPath = this._horizontal ? `inset(${x}px 0 0 0)` : `inset(0 0 0 ${x}px)`;
	}
	setSlider(x) { this._bounds = this._elB.getBoundingClientRect(); this._setPosition(x); }
	on(type, fn) { (this._handlers[type] ||= []).push(fn); return this; }
	off(type, fn) { const a = this._handlers[type]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } return this; }
	_fire(type, data) { for (const fn of this._handlers[type] || []) { try { fn(data); } catch (e) { console.error(e); } } }
	remove() {
		this._ac.abort(); this._ro.disconnect(); this._clearSync();
		this._elA.style.clipPath = ""; this._elB.style.clipPath = "";
		this._controlContainer.remove();
	}
}
