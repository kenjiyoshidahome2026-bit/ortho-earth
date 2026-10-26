// Cesium3DTileset on the globe's 3D Tiles (map.add3DTiles). fromUrl / fromIonAssetId read the root tileset.json for the bounding sphere
// (zoomTo / flyTo / viewBoundingSphere need it before anything draws); adding the tileset to scene.primitives puts it on the globe.
// instanceof Cesium3DTileset and Cesium3DTileFeature hold (the prototypes chain to the engine's), so the widgets and CesiumWidget.zoomTo treat these as the real ones.
import { BoundingSphere, Cartesian3, Color, Event, Matrix3, Matrix4, OrientedBoundingBox, Rectangle } from "@cesium/core";
import { Cesium3DTileFeature as RealFeature, Cesium3DTileset as RealTileset, Cesium3DTileStyle, IonResource, Resource } from "@cesium/engine";
import { unsupported } from "./report.ts";

type Any = any;

/** the bounding sphere of a 3D Tiles bounding volume (with the tile's transform) */
export function sphereOfVolume(bv: Any, transform?: number[]): BoundingSphere | null {
	let s: BoundingSphere | null = null;
	if (bv?.sphere) s = new BoundingSphere(new Cartesian3(bv.sphere[0], bv.sphere[1], bv.sphere[2]), bv.sphere[3]);
	else if (bv?.box) { const b = bv.box; s = BoundingSphere.fromOrientedBoundingBox(new OrientedBoundingBox(new Cartesian3(b[0], b[1], b[2]), Matrix3.fromArray([b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11]]))); }
	else if (bv?.region) { const r = bv.region; s = BoundingSphere.fromOrientedBoundingBox(OrientedBoundingBox.fromRectangle(new Rectangle(r[0], r[1], r[2], r[3]), r[4], r[5])); return s; }   // regions are in the fixed frame already
	if (s && transform?.length === 16) s = BoundingSphere.transform(s, Matrix4.unpack(transform), new BoundingSphere());
	return s;
}

export interface TilesetHost { map: Any | null; ready: Promise<Any> }

/** the facade's Cesium3DTileset */
export class Cesium3DTileset {
	readonly resource: Any; readonly json: Any;
	readonly tileLoadProgressEvent = new Event(); readonly allTilesLoaded = new Event(); readonly initialTilesLoaded = new Event();
	readonly loadProgress = this.tileLoadProgressEvent;
	readonly tileLoad = new Event(); readonly tileUnload = new Event(); readonly tileFailed = new Event(); readonly tileVisible = new Event();
	modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
	maximumScreenSpaceError: number; featureIdLabel: string | number = "featureId_0"; instanceFeatureIdLabel: string | number = "instanceFeatureId_0";
	colorBlendMode = 0; colorBlendAmount = 0.5; shadows = 1; debugShowBoundingVolume = false; debugWireframe = false; debugColorizeTiles = false;
	clippingPlanes: Any = undefined; clippingPolygons: Any = undefined; imageBasedLighting: Any = undefined; customShader: Any = undefined;
	backFaceCulling = true; enableCollision = false; preloadWhenHidden = false; preloadFlightDestinations = true; skipLevelOfDetail = false;
	dynamicScreenSpaceError = true; foveatedScreenSpaceError = true; cullRequestsWhileMoving = true; cullWithChildrenBounds = true;
	splitDirection = 0; showOutline = true; outlineColor = Color.clone(Color.BLACK); pointCloudShading: Any = { attenuation: false, eyeDomeLighting: false };
	#show = true; #style: Any = undefined; #h: Any = null; #host: TilesetHost | null = null; #destroyed = false; #sphere: BoundingSphere;
	#opts: Any;

	constructor(resource: Any, json: Any, opts: Any = {}) {
		this.resource = resource; this.json = json; this.#opts = opts;
		this.maximumScreenSpaceError = opts.maximumScreenSpaceError ?? 16;
		if (opts.modelMatrix) this.modelMatrix = Matrix4.clone(opts.modelMatrix);
		if (opts.show === false) this.#show = false;
		if (opts.featureIdLabel != null) this.featureIdLabel = opts.featureIdLabel;
		const bs = sphereOfVolume(json?.root?.boundingVolume, json?.root?.transform) ?? new BoundingSphere(Cartesian3.ZERO, 6378137);
		this.#sphere = BoundingSphere.transform(bs, this.modelMatrix, new BoundingSphere());
		for (const k of ["clippingPlanes", "clippingPolygons", "customShader"]) if (opts[k] != null) { (this as Any)[k] = opts[k]; unsupported(`Cesium3DTileset option ${k}`); }
	}
	static async fromUrl(url: Any, options: Any = {}): Promise<Cesium3DTileset> {
		const res = (Resource as Any).createIfNeeded(await url);
		const json = await res.fetchJson();
		return new Cesium3DTileset(res, json, options);
	}
	static async fromIonAssetId(assetId: number, options: Any = {}): Promise<Cesium3DTileset> {
		const res = await IonResource.fromAssetId(assetId);
		return Cesium3DTileset.fromUrl(res, options);
	}
	get url() { return this.resource.url; }
	get basePath() { return this.resource.url.replace(/[^/]*$/, ""); }
	get asset() { return this.json?.asset; }
	get properties() { return this.json?.properties; }
	get extras() { return this.json?.extras; }
	get extensions() { return this.json?.extensions; }
	get metadata() { return this.json?.metadata; }
	get geometricError() { return this.json?.geometricError; }
	get root() { return { boundingVolume: { boundingVolume: this.#sphere, boundingSphere: this.#sphere }, boundingSphere: this.#sphere, transform: Matrix4.IDENTITY, children: [], content: undefined }; }
	get boundingSphere() { return this.#sphere; }
	get ready() { return true; }
	get tilesLoaded() { return !!this.#h && (this.#h.stats?.inflight ?? 0) === 0; }
	get totalMemoryUsageInBytes() { return this.#h?.stats?.bytes ?? 0; }
	get ellipsoid() { return undefined; }
	get show() { return this.#show; }
	set show(v: boolean) { this.#show = !!v; this.#h?.setVisible(this.#show); }
	get style() { return this.#style; }
	set style(s: Any) { this.#style = s; this.#h?.setStyle(styleOf(s)); }
	makeStyleDirty() { this.#h?.setStyle(styleOf(this.#style)); }
	get timeSinceLoad() { return 0; }
	get statistics() { return statsOf(this.#h); }
	/** what the 3D Tiles inspector reads (per pass: render, pick…): the globe's counts, 0 for the rest */
	get _statisticsPerPass() { const s = statsOf(this.#h); return new Proxy([], { get: (t, k) => (typeof k === "string" && /^\d+$/.test(k) ? s : (t as Any)[k]) }); }
	/** the globe's tileset handle (null until it is on the globe) */
	get orthoHandle() { return this.#h; }

	/** put it on the globe (the scene calls this when it is added to scene.primitives) */
	__attach(host: TilesetHost) {
		if (this.#host || this.#destroyed) return;
		this.#host = host;
		void host.ready.then(async map => {
			if (this.#destroyed || !this.#host) return;
			const r: Any = this.resource;
			// an ion asset's server wants the endpoint's token, which IonResource adds only as it sends each request (_makeRequest)
			const ir: Any = r instanceof IonResource && !(r as Any)._isExternal ? r : null, ion = ir?._ionEndpoint?.accessToken ? { Authorization: `Bearer ${ir._ionEndpoint.accessToken}` } : null;
			const headers = (r.headers && Object.keys(r.headers).length) || ion ? { ...r.headers, ...ion } : null;
			const query = this.resource.queryParameters && Object.keys(this.resource.queryParameters).length ? this.resource.queryParameters : null;
			const url = new URL(this.url, document.baseURI).href;   // a tileset given by a relative path ("../../SampleData/…")
			const origin = new URL(url).origin;
			const requestTransform = headers || query ? (u: string) => {
				const x = new URL(u, url);
				if (x.origin !== origin) return null;
				if (query) for (const [k, v] of Object.entries(query)) if (!x.searchParams.has(k)) x.searchParams.set(k, String(v));
				return { url: x.href, ...(headers && { headers }) };
			} : undefined;
			try {
				const h = await map.add3DTiles(url, { maxSSE: this.maximumScreenSpaceError, fit: false, ...(requestTransform && { requestTransform }), ...(this.#style && { style: styleOf(this.#style) }), pickable: true });
				if (this.#destroyed || !this.#host) { h?.remove(); return; }
				this.#h = h;
				if (!this.#show) h.setVisible(false);
				this.initialTilesLoaded.raiseEvent(); this.allTilesLoaded.raiseEvent();
			} catch (e) { this.tileFailed.raiseEvent({ url: this.url, message: String((e as Error)?.message || e) }); console.warn("[csshim] 3D Tiles", this.url, e); }
		});
	}
	__detach() { this.#host = null; this.#h?.remove(); this.#h = null; }
	/** the feature under a screen point (scene.pick) */
	__pick(x: number, y: number) {
		const p = this.#h?.pick?.(x, y);
		return p ? new Cesium3DTileFeature(this, p) : undefined;
	}
	update() {}
	prePassesUpdate() {}
	postPassesUpdate() {}
	updateForPass() {}
	trimLoadedTiles() {}
	hasExtension(name: string) { return !!this.json?.extensionsUsed?.includes(name); }
	getHeight() { return undefined; }
	isDestroyed() { return this.#destroyed; }
	destroy() { this.#destroyed = true; this.__detach(); return undefined; }
}
Object.setPrototypeOf(Cesium3DTileset.prototype, RealTileset.prototype);
for (const k of ["fromUrl", "fromIonAssetId"] as const) void k;

const statsOf = (h: Any) => new Proxy({ numberOfLoadedTilesTotal: h?.stats?.loaded ?? 0, numberOfTilesTotal: h?.stats?.loaded ?? 0, numberOfTilesWithContentReady: h?.stats?.shown ?? 0, numberOfPendingRequests: h?.stats?.inflight ?? 0, geometryByteLength: h?.stats?.bytes ?? 0 } as Any, { get: (t, k) => (k in t ? t[k] : 0) });

/** a Cesium3DTileStyle (or its JSON) → the globe's Tiles3DStyle (it reads Cesium's styling language as is) */
function styleOf(s: Any): Any {
	if (!s) return null;
	if (s instanceof Cesium3DTileStyle) return (s as Any).style ?? (s as Any)._style ?? null;
	return s;
}

/** what scene.pick returns for a 3D Tiles hit */
export class Cesium3DTileFeature {
	readonly tileset: Cesium3DTileset; readonly primitive: Cesium3DTileset; readonly featureId: number;
	#p: Any; #color: Color | undefined; #show = true;
	constructor(tileset: Cesium3DTileset, pick: Any) { this.tileset = tileset; this.primitive = tileset; this.#p = pick; this.featureId = pick.featureId ?? 0; }
	get content() { return { tileset: this.tileset, url: this.tileset.url }; }
	get pickId() { return this.featureId; }
	get color() { return this.#color ?? Color.WHITE; }
	set color(c: Color) { this.#color = c; this.tileset.orthoHandle?.setFeatureState(this.featureId, { color: c ? c.toCssColorString() : null }); }
	get show() { return this.#show; }
	set show(v: boolean) { this.#show = !!v; if (!v) unsupported("Cesium3DTileFeature.show = false"); }
	getPropertyIds(result: string[] = []) { result.length = 0; result.push(...Object.keys(this.#p.properties || {}).filter(k => !k.startsWith("__"))); return result; }
	/** the batch table hierarchy (the globe puts the class in __class and the class with its ancestors in __classes) */
	getExactClassName() { return this.#p.properties?.__class ?? undefined; }
	isExactClass(name: string) { return this.getExactClassName() === name; }
	isClass(name: string) { return !!this.#p.properties?.__classes?.includes?.(name); }
	hasProperty(name: string) { return Object.prototype.hasOwnProperty.call(this.#p.properties || {}, name); }
	getProperty(name: string) { return this.#p.properties?.[name]; }
	getPropertyInherited(name: string) { return this.getProperty(name) ?? this.#p.contentMetadata?.properties?.[name] ?? this.#p.tileMetadata?.properties?.[name] ?? this.#p.groupMetadata?.properties?.[name]; }
	setProperty(name: string, value: unknown) { (this.#p.properties ||= {})[name] = value; }
	/** the globe's pick (lngLat, distance…) */
	get orthoPick() { return this.#p; }
}
Object.setPrototypeOf(Cesium3DTileFeature.prototype, RealFeature.prototype);
