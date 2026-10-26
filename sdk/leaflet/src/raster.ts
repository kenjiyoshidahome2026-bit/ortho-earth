// Raster layers: L.TileLayer (and .WMS) as MapLibre raster sources, L.GridLayer's createTile() through a MapLibre protocol,
//   L.ImageOverlay / L.VideoOverlay as image / video sources. All join the map's stack: tilePane (200) below overlayPane (400),
//   and zIndex inside a pane, as in Leaflet.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Util, define, setOptions, stamp, unsupported } from "./core.ts";
import { Point, toLatLngBounds } from "./geo.ts";
import { Layer } from "./layer.ts";

let seq = 0;

/** what every raster layer shares: one source, one raster layer, opacity, zIndex, its place in the stack */
abstract class RasterBase extends Layer {
	_rid(): string { return this._lfid ||= `lf-t${++seq}`; }
	onAdd(map: any): void { map._glAttach(this); }
	onRemove(map: any): void { map._glDetach(this); }
	_subZ(): number { return this.options.zIndex ?? 1; }
	_layerIds(): string[] { return [this._rid()]; }
	abstract _source(map: any): any;
	_layerProps(map: any): Record<string, unknown> { return {}; }
	_glInstall(ml: any, before?: string): void {
		const id = this._rid();
		this._ml = ml;
		if (!ml.getSource(id)) ml.addSource(id, this._source(this._map));
		if (!ml.getLayer(id)) ml.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": +this.options.opacity, "raster-fade-duration": 0 }, ...this._layerProps(this._map) }, before);
		this.fire("load");
	}
	_glUninstall(ml: any): void { const id = this._rid(); if (ml.getLayer(id)) ml.removeLayer(id); if (ml.getSource(id)) ml.removeSource(id); this._ml = null; }
	/** a new source (URL / parameters changed) */
	_reinstall(): void { const m = this._map; if (!m) return; m._glDetach(this); m._glAttach(this); }
	setOpacity(opacity: number): this { this.options.opacity = opacity; if (this._ml?.getLayer(this._rid())) this._ml.setPaintProperty(this._rid(), "raster-opacity", +opacity); return this; }
	getOpacity(): number { return this.options.opacity; }
	setZIndex(z: number): this { this.options.zIndex = z; this._map?._glReorder(this); return this; }
	getContainer(): null { return null; }
	getElement(): null { return null; }
}

/** L.GridLayer: your createTile(coords, done) drawn through a MapLibre protocol (canvas or loaded <img> tiles) */
export class GridLayer extends RasterBase {
	initialize(options?: any): void { setOptions(this, options); }
	getTileSize(): Point { const s = this.options.tileSize; return s instanceof Point ? s : new Point(s, s); }
	bringToFront(): this { if (this._map) { let max = -Infinity; this._map.eachLayer((l: any) => { if (l !== this && l instanceof GridLayer && l.options.pane === this.options.pane) max = Math.max(max, l.options.zIndex ?? 1); }); this.setZIndex(Math.max(max + 1, this.options.zIndex ?? 1)); } return this; }
	bringToBack(): this { if (this._map) { let min = Infinity; this._map.eachLayer((l: any) => { if (l !== this && l instanceof GridLayer && l.options.pane === this.options.pane) min = Math.min(min, l.options.zIndex ?? 1); }); this.setZIndex(Math.min(min - 1, this.options.zIndex ?? 1)); } return this; }
	redraw(): this { this._reinstall(); return this; }
	isLoading(): boolean { return !!this._ml && !this._ml.isSourceLoaded?.(this._rid()); }
	_layerProps(map: any): Record<string, unknown> {
		const o = this.options, off = map._zoff, p: Record<string, unknown> = {};
		if (o.minZoom > 0) p.minzoom = Math.max(0, o.minZoom - off);
		if (o.maxZoom !== undefined && o.maxZoom - off < 24) p.maxzoom = Math.max(0, o.maxZoom - off) + 1e-6;
		return p;
	}
	_tileBounds(): number[] | undefined { const b = this.options.bounds && toLatLngBounds(this.options.bounds); return b?.isValid() ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : undefined; }
	_source(map: any): any {
		const ml = map._ctx.ml, size = this.getTileSize().x, proto = `lfgrid${stamp(this)}`;
		if (!this.createTile) unsupported("GridLayer without createTile()");
		else if (!ml.addProtocol) unsupported("GridLayer (this maplibregl has no addProtocol)");
		else if (!this._protocol) {
			this._protocol = proto;
			ml.addProtocol(proto, async (params: { url: string }) => ({ data: await this._tileBytes(params.url, size) }));
		}
		return { type: "raster", tiles: [`${proto}://{z}/{x}/{y}`], tileSize: size, ...(this._tileBounds() && { bounds: this._tileBounds() }), ...(this.options.maxNativeZoom !== undefined && { maxzoom: this.options.maxNativeZoom }) };
	}
	/** createTile → a PNG for MapLibre */
	async _tileBytes(url: string, size: number): Promise<ArrayBuffer> {
		const m = /(\d+)\/(\d+)\/(\d+)/.exec(url)!, coords: any = new Point(+m[2], +m[3]);
		coords.z = +m[1];
		const tile: any = await new Promise(res => { let el: any; const done = (err: unknown, t?: any): void => res(t ?? el); el = this.createTile(coords, done); if (this.createTile.length < 2) res(el); });
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = size;
		const g = canvas.getContext("2d")!;
		if (tile instanceof HTMLCanvasElement || tile instanceof HTMLImageElement) {
			if (tile instanceof HTMLImageElement && !tile.complete) await new Promise(r => { tile.onload = tile.onerror = r; });
			g.drawImage(tile, 0, 0, size, size);
		} else unsupported("GridLayer tiles that are not <canvas> or <img> (HTML tiles cannot be drawn by MapLibre)");
		const blob: Blob = await new Promise(r => canvas.toBlob(b => r(b!), "image/png"));
		return blob.arrayBuffer();
	}
}
define(GridLayer, { options: { tileSize: 256, opacity: 1, updateWhenIdle: false, updateWhenZooming: true, updateInterval: 200, zIndex: 1, bounds: null, minZoom: 0, maxZoom: undefined, maxNativeZoom: undefined, minNativeZoom: undefined, noWrap: false, pane: "tilePane", className: "", keepBuffer: 2 } });

// MapLibre fills {z} {x} {y}; Leaflet's {s} (subdomain), {r} (retina) and {-y} (TMS) are resolved here, other {keys} from the options
const RESERVED = new Set(["z", "x", "y", "s", "r", "-y"]);
/** L.TileLayer(urlTemplate, options): a MapLibre raster source */
export class TileLayer extends GridLayer {
	initialize(url: string, options?: any): void {
		this._url = url;
		const o = setOptions(this, options);
		if (o.detectRetina && typeof window !== "undefined" && window.devicePixelRatio > 1 && o.maxZoom > 0) unsupported("TileLayer detectRetina (MapLibre draws 256 px tiles at the device's resolution)");
		if (typeof o.subdomains === "string") o.subdomains = o.subdomains.split("");
		if (o.zoomOffset && !(o.zoomOffset === -1 && +o.tileSize === 512)) unsupported(`TileLayer zoomOffset ${o.zoomOffset}`);
	}
	setUrl(url: string, noRedraw?: boolean): this {
		if (this._url === url && noRedraw === undefined) noRedraw = true;
		this._url = url;
		if (!noRedraw) this.redraw();
		return this;
	}
	getTileUrl(coords: { x: number; y: number; z: number }): string {
		const o = this.options, data: Record<string, unknown> = { r: "", s: this._subdomain(coords), x: coords.x, y: coords.y, z: coords.z, ...o };
		if (o.tms) data["-y"] = Math.pow(2, coords.z) - 1 - coords.y;
		return Util.template(this._url, data);
	}
	_subdomain(c: { x: number; y: number }): string { const s = this.options.subdomains; return s[Math.abs(c.x + c.y) % s.length]; }
	/** the MapLibre tile URLs: one per subdomain, other placeholders filled from the options */
	_mlTiles(): string[] {
		const o = this.options;
		const fill = (sub: string): string => this._url.replace(/\{ *([\w_ -]+) *\}/g, (s: string, key: string) => {
			if (key === "s") return sub;
			if (key === "r") return "";
			if (key === "-y") return "{y}";
			if (RESERVED.has(key)) return `{${key}}`;
			let v = o[key];
			if (v === undefined) throw new Error(`No value provided for variable ${s}`);
			if (typeof v === "function") v = v({ ...o });
			return String(v);
		});
		return /\{ *s *\}/.test(this._url) ? o.subdomains.map(fill) : [fill("")];
	}
	_source(): any {
		const o = this.options;
		return {
			type: "raster", tiles: this._mlTiles(), tileSize: +o.tileSize || 256,
			...(o.tms || /\{ *-y *\}/.test(this._url) ? { scheme: "tms" } : {}),
			...(o.minNativeZoom !== undefined && { minzoom: o.minNativeZoom }),
			maxzoom: Math.min(30, o.maxNativeZoom ?? o.maxZoom ?? 22),
			...(this._tileBounds() && { bounds: this._tileBounds() }),
			...(o.attribution && { attribution: o.attribution }),
		};
	}
	createTile(): HTMLElement { return document.createElement("img"); }
}
define(TileLayer, { options: { minZoom: 0, maxZoom: 18, subdomains: "abc", errorTileUrl: "", zoomOffset: 0, tms: false, zoomReverse: false, detectRetina: false, crossOrigin: false, referrerPolicy: false } });

/** L.TileLayer.WMS: GetMap requests with MapLibre's {bbox-epsg-3857} */
export class TileLayerWMS extends TileLayer {
	initialize(url: string, options?: any): void {
		this._url = url;
		const wmsParams: Record<string, unknown> = { ...this.defaultWmsParams };
		for (const k in options) if (!(k in this.options)) wmsParams[k] = options[k];
		options = setOptions(this, options);
		const size = +options.tileSize || 256;
		wmsParams.width = wmsParams.height = size;
		this.wmsParams = wmsParams;
		if (options.crs && options.crs.code !== "EPSG:3857") unsupported(`TileLayer.WMS crs ${options.crs.code} (tiles are requested in EPSG:3857)`);
	}
	setParams(params: Record<string, unknown>, noRedraw?: boolean): this { Object.assign(this.wmsParams, params); if (!noRedraw) this.redraw(); return this; }
	_mlTiles(): string[] {
		const v13 = parseFloat(String(this.wmsParams.version)) >= 1.3, params = { ...this.wmsParams, [v13 ? "crs" : "srs"]: "EPSG:3857" };
		const base = this._url.replace(/\{ *s *\}/g, "{s}");
		const subs = /\{s\}/.test(base) ? this.options.subdomains : [""];
		return subs.map((s: string) => base.replace("{s}", s) + Util.getParamString(params, base, this.options.uppercase) + (this.options.uppercase ? "&BBOX=" : "&bbox=") + "{bbox-epsg-3857}");
	}
	getTileUrl(): string { return this._mlTiles()[0]; }
}
define(TileLayerWMS, { defaultWmsParams: { service: "WMS", request: "GetMap", layers: "", styles: "", format: "image/jpeg", transparent: false, version: "1.1.1" }, options: { crs: null, uppercase: false } });

/** L.ImageOverlay(url, bounds): a MapLibre image source */
export class ImageOverlay extends RasterBase {
	initialize(url: string, bounds: any, options?: any): void { this._url = url; this._bounds = toLatLngBounds(bounds); setOptions(this, options); }
	_coords(): number[][] { const b = this._bounds; return [[b.getWest(), b.getNorth()], [b.getEast(), b.getNorth()], [b.getEast(), b.getSouth()], [b.getWest(), b.getSouth()]]; }
	_source(): any { return { type: "image", url: this._url, coordinates: this._coords() }; }
	setUrl(url: string): this {
		this._url = url;
		const s = this._ml?.getSource(this._rid());
		if (s?.updateImage) s.updateImage({ url, coordinates: this._coords() }); else this._reinstall();
		return this;
	}
	setBounds(bounds: any): this {
		this._bounds = toLatLngBounds(bounds);
		const s = this._ml?.getSource(this._rid());
		if (s?.setCoordinates) s.setCoordinates(this._coords()); else this._reinstall();
		return this;
	}
	getBounds(): any { return this._bounds; }
	getCenter(): any { return this._bounds.getCenter(); }
	bringToFront(): this { return this.setZIndex((this.options.zIndex ?? 1) + 1000); }
	bringToBack(): this { return this.setZIndex((this.options.zIndex ?? 1) - 1000); }
	setStyle(style: any): this { if (style?.opacity !== undefined) this.setOpacity(style.opacity); return this; }
}
define(ImageOverlay, { options: { opacity: 1, alt: "", interactive: false, crossOrigin: false, errorOverlayUrl: "", zIndex: 1, className: "" } });

/** L.VideoOverlay(urls, bounds): a MapLibre video source */
export class VideoOverlay extends ImageOverlay {
	_source(): any { return { type: "video", urls: ([] as string[]).concat(this._url), coordinates: this._coords() }; }
	getElement(): any { return this._ml?.getSource(this._rid())?.getVideo?.() ?? null; }
	setUrl(): this { unsupported("VideoOverlay.setUrl"); return this; }
}
define(VideoOverlay, { options: { autoplay: true, loop: true, keepAspectRatio: true, muted: false, playsInline: true } });

/** L.SVGOverlay: not drawn (MapLibre has no SVG source) */
export class SVGOverlay extends ImageOverlay {
	initialize(el: any, bounds: any, options?: any): void { super.initialize("", bounds, options); this._svg = el; unsupported("SVGOverlay"); }
	onAdd(): void {}
	onRemove(): void {}
	getElement(): any { return this._svg; }
}
