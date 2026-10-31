// Cesium3DTileset on the globe's 3D Tiles (map.add3DTiles). fromUrl / fromIonAssetId read the root tileset.json for the bounding sphere
// (zoomTo / flyTo / viewBoundingSphere need it before anything draws); adding the tileset to scene.primitives puts it on the globe.
// instanceof Cesium3DTileset and Cesium3DTileFeature hold (the prototypes chain to the engine's), so the widgets and CesiumWidget.zoomTo treat these as the real ones.
import { BoundingSphere, Cartesian3, Color, Event, Matrix3, Matrix4, OrientedBoundingBox, Rectangle } from "@cesium/core";
import { Cesium3DTileFeature as RealFeature, Cesium3DTileset as RealTileset, Cesium3DTileStyle, ConditionsExpression, Expression, ImageryLayerCollection, IonResource, Resource } from "@cesium/engine";
import * as engineAll from "@cesium/engine";
import { clippingOriginOf } from "./clipping.ts";
import { TilesetDrape } from "./drape.ts";

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

import { customShaderId } from "./custom-shader.ts";
import { tilesetEnvSH } from "./lighting.ts";
export interface TilesetHost { map: Any | null; ready: Promise<Any> }

const clsOf = (t: unknown) => (["terrain", "tiles3d", "both"] as const)[t as number] ?? null;   // ClassificationType → the globe's classificationType

/** the facade's Cesium3DTileset */
export class Cesium3DTileset {
	readonly resource: Any; readonly json: Any;
	readonly tileLoadProgressEvent = new Event(); readonly allTilesLoaded = new Event(); readonly initialTilesLoaded = new Event();
	readonly loadProgress = this.tileLoadProgressEvent;
	readonly imageryLayers = new ImageryLayerCollection();   // imagery draped on the tileset (drape.ts → map.setMeshImagery)
	readonly tileLoad = new Event(); readonly tileUnload = new Event(); readonly tileFailed = new Event(); readonly tileVisible = new Event();
	modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
	maximumScreenSpaceError: number; featureIdLabel: string | number = "featureId_0"; instanceFeatureIdLabel: string | number = "instanceFeatureId_0";
	colorBlendMode = 0; colorBlendAmount = 0.5; shadows = 1; debugShowBoundingVolume = false; debugWireframe = false; debugColorizeTiles = false;
	clippingPlanes: Any = undefined; clippingPolygons: Any = undefined; imageBasedLighting: Any = undefined; customShader: Any = undefined;
	backFaceCulling = true; enableCollision = false; preloadWhenHidden = false; preloadFlightDestinations = true; skipLevelOfDetail = false;
	dynamicScreenSpaceError = true; foveatedScreenSpaceError = true; cullRequestsWhileMoving = true; cullWithChildrenBounds = true;
	splitDirection = 0; showOutline = true; outlineColor = Color.clone(Color.BLACK); pointCloudShading: Any = { attenuation: false, geometricErrorScale: 1, maximumAttenuation: undefined, baseResolution: undefined, eyeDomeLighting: true, eyeDomeLightingStrength: 1, eyeDomeLightingRadius: 1, backFaceCulling: false, normalShading: true };   // PointCloudShading's defaults
	#shadeKey = ""; #csId: string | null = null; #blendKey = "";
	#show = true; #style: Any = undefined; #h: Any = null; #host: TilesetHost | null = null; #destroyed = false; #sphere: BoundingSphere; #env: Float32Array | null = null; #olKey = "";
	#opts: Any;
	#split: string | null = null;
	#tiles = new Map<number, Any>(); #drape: TilesetDrape | null = null;   // the loaded tiles tileLoad was raised for (tileUnload gets the same object)

	constructor(resource: Any, json: Any, opts: Any = {}) {
		this.resource = resource; this.json = json; this.#opts = opts;
		this.maximumScreenSpaceError = opts.maximumScreenSpaceError ?? 16;
		if (opts.modelMatrix) this.modelMatrix = Matrix4.clone(opts.modelMatrix);
		if (opts.show === false) this.#show = false;
		if (opts.featureIdLabel != null) this.featureIdLabel = opts.featureIdLabel;
		const bs = sphereOfVolume(json?.root?.boundingVolume, json?.root?.transform) ?? new BoundingSphere(Cartesian3.ZERO, 6378137);
		this.#sphere = BoundingSphere.transform(bs, this.modelMatrix, new BoundingSphere());
		if (opts.pointCloudShading) Object.assign(this.pointCloudShading, opts.pointCloudShading);
		if (opts.clippingPlanes != null) this.clippingPlanes = opts.clippingPlanes;   // drawn by the scene (clipping.ts)
		if (opts.clippingPolygons != null) this.clippingPolygons = opts.clippingPolygons;   // drawn by the scene (clipping.ts)
		if (opts.showOutline === false) this.showOutline = false;
		if (opts.outlineColor) this.outlineColor = Color.clone(opts.outlineColor);
		if (opts.customShader != null) this.customShader = opts.customShader;   // drawn by the globe (custom-shader.ts), followed in __sync
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
	// TilesetMetadata (a MetadataEntity): the JSON values, with the class defaults from an inline schema
	get metadata() {
		const m = this.json?.metadata; if (!m) return undefined;
		const props: Record<string, unknown> = m.properties ?? {}, cls = this.json?.schema?.classes?.[m.class], def = (id: string) => cls?.properties?.[id]?.default;
		const get = (id: string) => id in props ? props[id] : def(id);
		const bySem = (sem: string) => { const id = Object.keys(cls?.properties ?? {}).find(k => cls.properties[k].semantic === sem) ?? Object.keys(props).find(k => k === sem); return id == null ? undefined : get(id); };
		return { class: cls ? { id: m.class, ...cls } : undefined, extras: m.extras, extensions: m.extensions,
			hasProperty: (id: string) => get(id) !== undefined, hasPropertyBySemantic: (sem: string) => bySem(sem) !== undefined,
			getPropertyIds: (out: string[] = []) => { for (const k of new Set([...Object.keys(props), ...Object.keys(cls?.properties ?? {})])) out.push(k); return out; },
			getProperty: get, getPropertyBySemantic: bySem,
			setProperty: (id: string, v: unknown) => { if (!(id in props) && def(id) === undefined) return false; props[id] = v; return true; },
			setPropertyBySemantic: () => false };
	}
	get geometricError() { return this.json?.geometricError; }
	get root() {
		const t = this.json?.root?.transform?.length === 16 ? Matrix4.unpack(this.json.root.transform) : Matrix4.clone(Matrix4.IDENTITY);
		return { boundingVolume: { boundingVolume: this.#sphere, boundingSphere: this.#sphere }, boundingSphere: this.#sphere, transform: t, computedTransform: Matrix4.multiply(this.modelMatrix, t, new Matrix4()), children: [], content: undefined };
	}
	get clippingPlanesOriginMatrix() { return clippingOriginOf(this.json, this.modelMatrix); }
	get boundingSphere() { return this.#sphere; }
	get ready() { return true; }
	get tilesLoaded() { const st = this.#h?.stats; return !!st && st.complete !== false && (st.inflight ?? 0) === 0; }   // complete＝今の視点の分が揃った（inflight 0 だけだと最初に巡る前・次の段を投げる前の一瞬に true になる）
	get totalMemoryUsageInBytes() { return this.#h?.stats?.bytes ?? 0; }
	get ellipsoid() { return undefined; }
	/** ClassificationType (TERRAIN 0 / CESIUM_3D_TILE 1 / BOTH 2) or undefined: the tileset's volumes (.geom) paint what is inside them instead of being drawn */
	get classificationType() { return this.#opts.classificationType; }
	/** HeightReference: CLAMP_TO_GROUND (1) / CLAMP_TO_TERRAIN (3) drape the content on the terrain (3d-tiles-property-lod-river: river lines at
	 *  ellipsoid height 0 under the Himalaya); the globe lifts every vertex by the terrain's height (add3DTiles ground:"terrain"). The others draw as they are */
	get heightReference() { return this.#opts.heightReference ?? 0; }
	get show() { return this.#show; }
	set show(v: boolean) { this.#show = !!v; this.#h?.setVisible(this.#show); }
	get style() { return this.#style; }
	set style(s: Any) { this.#style = s; this.#h?.setStyle(this.#styleSent()); }
	// no style: every feature's colour is Cesium's default white, which REPLACE / MIX paint too (imodel-mesh-export-service: the iModels white)
	#styleSent() { return styleOf(this.#style) ?? ((this.colorBlendMode | 0) === 0 ? null : { color: "color('white')" }); }
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
				const ps = pointSizeOf(this.#style), sent = this.#style;
				const cid = customShaderId(map, this.customShader); this.#csId = cid;
				const mm = Matrix4.equals(this.modelMatrix, Matrix4.IDENTITY) ? null : Matrix4.toArray(this.modelMatrix);   // the tileset's modelMatrix as it is when added (itwin-gaussian-splats moves the dam onto the terrain with it)
				const h = await map.add3DTiles(url, { maxSSE: this.maximumScreenSpaceError, fit: false, pointSize: ps, ...(mm && { modelMatrix: mm }), ...(requestTransform && { requestTransform }), ...(sent && { style: styleOf(sent) }), pickable: true, pointShape: "square", customShader: cid, outline: this.showOutline !== false ? [this.outlineColor.red, this.outlineColor.green, this.outlineColor.blue, this.outlineColor.alpha] : null, mc: !!cid, ...(clsOf(this.classificationType) && { classificationType: clsOf(this.classificationType) }), ...((this.heightReference === 1 || this.heightReference === 3) && { ground: "terrain" }) });   // positionMC only for a tileset that starts with a shader (photogrammetry is large)
				if (this.#destroyed || !this.#host) { h?.remove(); return; }
				this.#h = h;
				if (this.#style !== sent) h.setStyle(styleOf(this.#style));   // the style set while the tileset was being added
				if (!this.#show) h.setVisible(false);
				this.initialTilesLoaded.raiseEvent(); this.allTilesLoaded.raiseEvent();
			} catch (e) { this.tileFailed.raiseEvent({ url: this.url, message: String((e as Error)?.message || e) }); console.warn("[csshim] 3D Tiles", this.url, e); }
		});
	}
	/** each frame (scene.render): pointCloudShading → the globe's point shading (the examples change it after the tileset is added). Cesium lights the
	 *  eye dome only while attenuation is on */
	__sync(scene?: Any) {
		if (!this.#h) return;
		if (scene && (this.imageryLayers.length || this.#drape)) (this.#drape ??= new TilesetDrape(this.#host?.map)).sync(this, scene, this.#h);   // imagery draped on the tileset
		const s = this.pointCloudShading ?? {}, att = !!s.attenuation;
		const spec = att ? { attenuation: true, geometricErrorScale: s.geometricErrorScale ?? 1, ...(s.maximumAttenuation != null && { maximumAttenuation: s.maximumAttenuation }), ...(s.baseResolution != null && { baseResolution: s.baseResolution }),
			eyeDomeLighting: !!s.eyeDomeLighting, edlStrength: s.eyeDomeLightingStrength ?? 1, edlRadius: s.eyeDomeLightingRadius ?? 1 } : null;
		const key = JSON.stringify(spec);
		if (key !== this.#shadeKey) { this.#shadeKey = key; this.#h.setOptions({ pointShading: spec }); }
		const env = scene ? tilesetEnvSH(scene, this.#sphere.center) : null;   // the tileset's own environment map (DynamicEnvironmentMapManager at boundingSphere.center)
		if (env !== this.#env) { this.#env = env; this.#h.setOptions({ environment: env }); }
		const oc = this.outlineColor, ol = this.showOutline !== false && oc ? [oc.red, oc.green, oc.blue, oc.alpha] : null, ok = String(ol);   // CESIUM_primitive_outline: showOutline / outlineColor
		if (ok !== this.#olKey) { this.#olKey = ok; this.#h.setOptions({ outline: ol }); }
		const sd = this.splitDirection < 0 ? "left" : this.splitDirection > 0 ? "right" : null;   // SplitDirection LEFT -1 / NONE 0 / RIGHT 1 (scene.splitPosition: the viewer)
		if (sd !== this.#split) { this.#split = sd; this.#h.setOptions({ splitDirection: sd }); }
		const cam = scene?.camera, cull = this.tileVisible.numberOfListeners && cam?.frustum?.computeCullingVolume ? cam.frustum.computeCullingVolume(cam.positionWC, cam.directionWC, cam.upWC) : null;
		if (this.tileVisible.numberOfListeners) for (const id of this.#h.shownTileIds ?? []) {   // tileVisible: each tile drawn this frame and in the view frustum (raised between preRender and postRender, as Cesium does while it renders)
			const sp = cull ? this.#h.tileSphere?.(id) : null;
			if (sp && cull.computeVisibility(new BoundingSphere(Cartesian3.fromArray(sp.center), sp.radius)) === -1) continue;   // Intersect.OUTSIDE
			let t = this.#tiles.get(id) ?? this.#seen.get(id);
			if (!t) { t = this.#tileOf(id); this.#seen.set(id, t); }
			this.tileVisible.raiseEvent(t);
		}
		if (this.tileLoad.numberOfListeners || this.tileUnload.numberOfListeners) {   // tileLoad / tileUnload: the globe loads tiles on its own, so the loaded set is compared once a frame
			const now = new Set<number>(this.#h.tileIds ?? []);
			for (const id of now) if (!this.#tiles.has(id)) { const t = this.#tileOf(id); this.#tiles.set(id, t); this.tileLoad.raiseEvent(t); }
			for (const [id, t] of this.#tiles) if (!now.has(id)) { this.#tiles.delete(id); this.tileUnload.raiseEvent(t); }
		}
		const cid = customShaderId(this.#host?.map, this.customShader);   // tileset.customShader = … (or null)
		if (cid !== this.#csId) { this.#csId = cid; this.#h.setOptions({ customShader: cid }); }
		const mode = (["highlight", "replace", "mix"] as const)[this.colorBlendMode | 0] ?? "highlight", bk = `${mode}:${this.colorBlendAmount}`;   // Cesium3DTileColorBlendMode HIGHLIGHT 0 / REPLACE 1 / MIX 2
		if (bk !== this.#blendKey) {
			this.#blendKey = bk; this.#h.setOptions({ colorBlend: { mode, amount: this.colorBlendAmount } });
			if (!this.#style) this.#h.setStyle(this.#styleSent());
		}
	}
	/** a loaded tile as Cesium3DTile: its content holds the tile's features (content.featuresLength / getFeature, the same objects until it unloads) */
	#tileOf(id: number) {
		const feats = (this.#h?.tileFeatures?.(id) ?? []).map((p: Any) => new Cesium3DTileFeature(this, { ...p, tile: id }));
		// a Model3DTileContent (instanceof holds: the examples test it) whose values are its own; getExtension = the glTF's root extension as Cesium's loader
		// makes it (NGA_gpm_local → GltfGpmLoader's objects), else the raw json
		let ext: Record<string, Any> | null | undefined;
		const getExtension = (name: string) => {
			if (ext === undefined) ext = this.#h?.tileExtensions?.(id) ?? null;
			const e = ext?.[name];
			if (e === undefined) return undefined;
			if (name === "NGA_gpm_local") { try { return GltfGpmLoader.load(e); } catch { return undefined; } }
			return e;
		};
		const content = Object.create(Model3DTileContent.prototype, Object.fromEntries(Object.entries({ tileset: this, url: this.url, featuresLength: feats.length, innerContents: undefined, getFeature: (i: number) => feats[i], hasProperty: (i: number, name: string) => !!feats[i]?.hasProperty?.(name), getExtension }).map(([k, v]) => [k, { value: v, enumerable: true, writable: true }])));
		return { ...this.root, tileset: this, content };
	}
	__detach() { this.#drape?.clear(); this.#drape = null; this.#host = null; this.#h?.remove(); this.#h = null; }
	/** the feature under a screen point (scene.pick) */
	__pick(x: number, y: number) {
		const p = this.#h?.pick?.(x, y);
		return p ? new Cesium3DTileFeature(this, p) : undefined;
	}
	/** a feature by its id in a tile (scene.pickFromRay): one object per feature while its tile stays, as Cesium hands back the same Cesium3DTileFeature */
	__feature(featureId: number, tile?: number) {
		const key = `${tile ?? ""}:${featureId}`;
		let f = this.#features.get(key);
		if (!f) {
			const p = tile != null ? (this.#h?.tileFeatures?.(tile) ?? []).find((q: Any) => q.featureId === featureId) : null;
			f = new Cesium3DTileFeature(this, { ...(p ?? {}), featureId, tile });
			this.#features.set(key, f);
		}
		return f;
	}
	#features = new Map<string, Cesium3DTileFeature>();
	#seen = new Map<number, Any>();   // the tiles handed to tileVisible (the same object each frame)
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
// The engine's own helpers (ITwinData.createTilesetFromIModelId / createTilesetForRealityDataId) call the engine class's fromUrl:
// they get this tileset, drawn by the globe, instead of one that needs Cesium's renderer
(RealTileset as Any).fromUrl = (url: Any, options?: Any) => Cesium3DTileset.fromUrl(url, options);
for (const k of ["fromUrl", "fromIonAssetId"] as const) void k;

const statsOf = (h: Any) => new Proxy({ numberOfLoadedTilesTotal: h?.stats?.loaded ?? 0, numberOfTilesTotal: h?.stats?.loaded ?? 0, numberOfTilesWithContentReady: h?.stats?.shown ?? 0, numberOfPendingRequests: h?.stats?.inflight ?? 0, geometryByteLength: h?.stats?.bytes ?? 0,
	selected: h?.stats?.shown ?? 0, numberOfTrianglesSelected: h?.stats?.triangles ?? 0, numberOfPointsSelected: h?.stats?.points ?? 0 } as Any, { get: (t, k) => (k in t ? t[k] : 0) });   // selected／triangles＝描いている物（公式例の門の「答え」＝足した物が実際に描けたか）

/** a Cesium3DTileStyle (or its JSON) → the globe's Tiles3DStyle (it reads Cesium's styling language as is) */
/** the globe's point radius (CSS px) for a style's constant pointSize: Cesium's pointSize is the point's width in pixels and defaults to 1
 *  (ModelVS; the canvas is at CSS resolution as useBrowserRecommendedResolution asks). An expression that varies per point is not followed */
export function pointSizeOf(s: Any): number {
	const v = styleOf(s)?.pointSize, n = typeof v === "number" ? v : typeof v === "string" && /^\s*[\d.]+\s*$/.test(v) ? +v : NaN;
	return (Number.isFinite(n) && n > 0 ? n : 1) / 2;
}
export function styleOf(s: Any): Any {
	if (!s) return null;
	if (s instanceof Cesium3DTileStyle) {
		// style.color = { evaluateColor(feature, result) } / style.show = { evaluate(feature) }: functions the globe calls per feature (the JSON has no
		// trace of them); an Expression / ConditionsExpression made from the JSON is read from the JSON
		const json = (s as Any).style ?? (s as Any)._style ?? null, own = (v: Any, k: string) => v && typeof v[k] === "function" && !(v instanceof Expression) && !(v instanceof ConditionsExpression) ? v : null;
		const fc = own((s as Any)._color, "evaluateColor"), fs = own((s as Any)._show, "evaluate");
		if (!fc && !fs) return json;
		const out: Any = { ...json };
		if (fc) out.color = (x: Any) => { const c = fc.evaluateColor(new StyleFeature(x), new Color()); return c ? [c.red, c.green, c.blue, c.alpha] : null; };
		if (fs) out.show = (x: Any) => fs.evaluate(new StyleFeature(x));
		return out;
	}
	return s;
}

/** a 64-bit integer property as Cesium gives it (a BigInt); the globe has it as a number, or a string past 2^53 */
const int64Of = (v: unknown, names: string[] | undefined, name: string) => v != null && names?.includes(name) && (typeof v === "number" || typeof v === "string") ? (() => { try { return BigInt(v); } catch { return v; } })() : v;
/** the feature a style function is called with (the globe's style input: its properties, id and state) */
class StyleFeature {
	readonly #x: Any;
	constructor(x: Any) { this.#x = x; }
	get featureId() { return this.#x.id; }
	getProperty(name: string) { return int64Of(this.#x.props?.[name], this.#x.int64, name); }
	getPropertyInherited(name: string) { return this.getProperty(name); }
	hasProperty(name: string) { return Object.prototype.hasOwnProperty.call(this.#x.props || {}, name); }
	getPropertyIds(result: string[] = []) { result.length = 0; result.push(...Object.keys(this.#x.props || {}).filter(k => !k.startsWith("__"))); return result; }
}
/** what scene.pick returns for a 3D Tiles hit */
const { GltfGpmLoader, Model3DTileContent } = engineAll as Any;   // private in the d.ts, exported at run time

export class Cesium3DTileFeature {
	readonly tileset: Cesium3DTileset; readonly primitive: Cesium3DTileset; readonly featureId: number;
	#p: Any; #color: Color | undefined; #show = true;
	constructor(tileset: Cesium3DTileset, pick: Any) { this.tileset = tileset; this.primitive = tileset; this.#p = pick; this.featureId = pick.featureId ?? 0; }
	get content() { return { tileset: this.tileset, url: this.tileset.url }; }
	get pickId() { return this.featureId; }
	get color() { return this.#color ?? Color.WHITE; }
	set color(c: Color) { this.#color = c; this.tileset.orthoHandle?.setFeatureState(this.featureId, { color: c ? c.toCssColorString() : null }, this.#p.tile); }
	get show() { return this.#show; }
	set show(v: boolean) { this.#show = !!v; this.tileset.orthoHandle?.setFeatureState(this.featureId, { show: v ? undefined : false }, this.#p.tile); }   // the globe cuts a hidden feature out (alpha 0 on a MASK batch)
	getPropertyIds(result: string[] = []) { result.length = 0; result.push(...Object.keys(this.#p.properties || {}).filter(k => !k.startsWith("__"))); return result; }
	/** the batch table hierarchy (the globe puts the class in __class and the class with its ancestors in __classes) */
	getExactClassName() { return this.#p.properties?.__class ?? undefined; }
	isExactClass(name: string) { return this.getExactClassName() === name; }
	isClass(name: string) { return !!this.#p.properties?.__classes?.includes?.(name); }
	hasProperty(name: string) { return Object.prototype.hasOwnProperty.call(this.#p.properties || {}, name); }
	getProperty(name: string) { return int64Of(this.#p.properties?.[name], this.#p.table?.int64, name); }
	getPropertyInherited(name: string) { return this.getProperty(name) ?? this.#p.contentMetadata?.properties?.[name] ?? this.#p.tileMetadata?.properties?.[name] ?? this.#p.groupMetadata?.properties?.[name]; }
	setProperty(name: string, value: unknown) { (this.#p.properties ||= {})[name] = value; }
	/** the globe's pick (lngLat, distance…) */
	get orthoPick() { return this.#p; }
}
Object.setPrototypeOf(Cesium3DTileFeature.prototype, RealFeature.prototype);
