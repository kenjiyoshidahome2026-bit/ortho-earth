// MapLibre の口（src/maplibre/・公式例の門 §8）の操作部品＝MapLibre の IControl の形（onAdd(map)→要素・onRemove・getDefaultPosition）。
// 見た目は MapLibre の CSS（maplibre-gl.css）の class 名に乗る＝頁が MapLibre の CSS を読んでいればそのままの姿になる。
// 中で呼ぶのは地図の公開の口（zoomIn/resetNorth/flyTo/setTerrain…）だけ＝エンジンに機能を足さない。
// 出典はエンジンの計器（instruments "attr"）が持つ＝AttributionControl は受け取るだけ。GlobeControl（投影の切り替え）はこの地図が常に球＝押しても何もしない。
import { unsupported } from "./report.js";

const el = (tag, cls, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (parent) parent.appendChild(e); return e; };
const button = (parent, cls, title, onClick) => {
	const b = el("button", cls, parent); b.type = "button"; b.title = title; b.setAttribute("aria-label", title);
	el("span", "maplibregl-ctrl-icon", b).setAttribute("aria-hidden", "true");
	b.addEventListener("click", onClick);
	return b;
};

class Ctrl {
	getDefaultPosition() { return "top-right"; }
	onRemove() { this._container?.remove(); this._map = null; }
}

export class NavigationControl extends Ctrl {
	constructor(options = {}) { super(); this.options = { showCompass: true, showZoom: true, visualizePitch: false, ...options }; }
	onAdd(map) {
		this._map = map;
		const c = this._container = el("div", "maplibregl-ctrl maplibregl-ctrl-group");
		if (this.options.showZoom) {
			button(c, "maplibregl-ctrl-zoom-in", "Zoom in", e => map.zoomIn({}, { originalEvent: e }));
			button(c, "maplibregl-ctrl-zoom-out", "Zoom out", e => map.zoomOut({}, { originalEvent: e }));
		}
		if (this.options.showCompass) {
			const b = button(c, "maplibregl-ctrl-compass", "Reset bearing to north", () => (this.options.visualizePitch ? map.resetNorthPitch() : map.resetNorth()));
			const icon = b.firstChild, turn = () => { icon.style.transform = `rotate(${-map.getBearing()}deg)`; };
			map.on("rotate", turn); this._off = () => map.off("rotate", turn);
		}
		return c;
	}
	onRemove() { this._off?.(); super.onRemove(); }
}

export class FullscreenControl extends Ctrl {
	constructor(options = {}) { super(); this.options = options; }
	onAdd(map) {
		this._map = map;
		const c = this._container = el("div", "maplibregl-ctrl maplibregl-ctrl-group");
		const target = this.options.container || map.getContainer();
		button(c, "maplibregl-ctrl-fullscreen", "Enter fullscreen", () => (document.fullscreenElement ? document.exitFullscreen() : target.requestFullscreen?.()));
		return c;
	}
}

export class GeolocateControl extends Ctrl {
	constructor(options = {}) { super(); this.options = { fitBoundsOptions: { maxZoom: 15 }, ...options }; this._ev = new Map(); }
	onAdd(map) {
		this._map = map;
		const c = this._container = el("div", "maplibregl-ctrl maplibregl-ctrl-group");
		button(c, "maplibregl-ctrl-geolocate", "Find my location", () => this.trigger());
		return c;
	}
	trigger() {
		if (!this._map || !navigator.geolocation) return false;
		navigator.geolocation.getCurrentPosition(p => {
			const { longitude: lng, latitude: lat } = p.coords;
			this._map.flyTo({ center: [lng, lat], zoom: Math.max(this._map.getZoom(), this.options.fitBoundsOptions?.maxZoom ?? 15) });
			for (const f of this._ev.get("geolocate") || []) f(p);
		}, err => { for (const f of this._ev.get("error") || []) f(err); }, this.options.positionOptions);
		return true;
	}
	on(type, fn) { if (!this._ev.has(type)) this._ev.set(type, new Set()); this._ev.get(type).add(fn); return this; }
	off(type, fn) { this._ev.get(type)?.delete(fn); return this; }
	getDefaultPosition() { return "top-right"; }
}

// 縮尺＝画面の下辺近くで maxWidth px の 2 点を unproject して大円距離（球の地図でも正しい長さ）
export class ScaleControl extends Ctrl {
	constructor(options = {}) { super(); this.options = { maxWidth: 100, unit: "metric", ...options }; }
	getDefaultPosition() { return "bottom-left"; }
	onAdd(map) {
		this._map = map;
		const c = this._container = el("div", "maplibregl-ctrl maplibregl-ctrl-scale");
		const upd = () => {
			const r = map.getContainer().getBoundingClientRect(), y = r.height / 2, x0 = r.width / 2 - this.options.maxWidth / 2;
			const a = map.unproject([x0, y]), b = map.unproject([x0 + this.options.maxWidth, y]);
			if (!a || !b) return;
			const m = a.distanceTo(b), imperial = this.options.unit === "imperial";
			const v = imperial ? m / 0.3048 : m, big = imperial ? 5280 : 1000, unit = v >= big ? (imperial ? "mi" : "km") : (imperial ? "ft" : "m");
			const d = v >= big ? v / big : v, p = 10 ** (String(Math.floor(d)).length - 1), nice = [1, 2, 3, 5, 10].map(k => k * p).filter(k => k <= d).pop() || d;
			c.style.width = `${Math.round(this.options.maxWidth * nice / d)}px`; c.textContent = `${nice} ${unit}`;
		};
		map.on("move", upd); map.on("load", upd); this._off = () => { map.off("move", upd); map.off("load", upd); };
		return c;
	}
	setUnit(unit) { this.options.unit = unit; }
	onRemove() { this._off?.(); super.onRemove(); }
}

export class AttributionControl extends Ctrl {
	constructor(options = {}) { super(); this.options = options; }
	getDefaultPosition() { return "bottom-right"; }
	onAdd(map) { this._map = map; unsupported(map, "AttributionControl (the map shows its own attribution)", "cosmetic"); return (this._container = el("div", "maplibregl-ctrl")); }
}

export class LogoControl extends Ctrl {
	getDefaultPosition() { return "bottom-left"; }
	onAdd(map) { this._map = map; unsupported(map, "LogoControl", "cosmetic"); return (this._container = el("div", "maplibregl-ctrl")); }
}

export class GlobeControl extends Ctrl {
	onAdd(map) {
		this._map = map;
		const c = this._container = el("div", "maplibregl-ctrl maplibregl-ctrl-group");
		button(c, "maplibregl-ctrl-globe", "Toggle globe", () => unsupported(map, "GlobeControl (this map is always a globe)", "cosmetic"));
		return c;
	}
}

export class TerrainControl extends Ctrl {
	constructor(options = {}) { super(); this.options = options; }
	onAdd(map) {
		this._map = map;
		const c = this._container = el("div", "maplibregl-ctrl maplibregl-ctrl-group");
		button(c, "maplibregl-ctrl-terrain", "Toggle terrain", () => map.setTerrain(map.getTerrain() ? null : this.options));
		return c;
	}
}
