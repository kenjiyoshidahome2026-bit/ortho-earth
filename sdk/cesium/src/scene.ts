// A Scene without WebGL: the members Cesium code and the engine's own helpers (Camera, CameraFlightPath, EntityView, SceneTransforms,
// the widgets) read, with the real engine classes where they need no GL context (Camera, Globe, PrimitiveCollection, Fog, Atmosphere,
// PostProcessStageCollection, SunLight, TweenCollection). Drawing is the globe's; this object only keeps the state and the per-frame events.
import { BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, Ellipsoid, Event, GeographicProjection, IntersectionTests, Matrix4, Ray } from "@cesium/core";
import { Atmosphere, Camera, Fog, Globe, MapMode2D, PostProcessStageCollection, PrimitiveCollection, SceneMode, SceneTransforms, SunLight } from "@cesium/engine";
import * as engine from "@cesium/engine";
const { TweenCollection } = engine as any;   // a runtime export the d.ts leaves out
import { globeCamOf, poseOfGlobeCam, poseKey, sameKey, sameGlobeCam, setCameraWorldPose, type GlobeCam } from "./camera.ts";
import { unsupported } from "./report.ts";
import { postChainOf, type PostFrame } from "./postprocess.ts";
import { sunPositionWC } from "./lighting.ts";
import { clipSpecOf, polygonClipOf } from "./clipping.ts";
import { groundMaterialOf, materialKey, readRampImage } from "./globe-material.ts";
import { RawDrawer } from "./rawdraw.ts";
import { bridgedTerrainSource } from "./terrain.ts";

/** the globe and what the facade hangs on it (filled when createGlobe resolves) */
export interface Host {
	map: any | null;
	ready: Promise<any>;
	/** the entity display (picking, bounding spheres) */
	display: { pick(x: number, y: number): unknown; drillPick(x: number, y: number, limit?: number): unknown[] } | null;
	/** the viewer's clock: model animations run only while it animates, at its multiplier (Cesium's ModelVisualizer) */
	clock?: { shouldAnimate: boolean; multiplier: number } | null;
}

const R2D = 180 / Math.PI;
const ORTHO_FOVY = Math.PI / 180;   // the telephoto field of view an orthographic frustum is drawn with (the globe's narrowest)
/** an orthographic frustum's height in metres (width = the horizontal extent, height = width / aspectRatio); null = a perspective frustum */
function orthoExtent(f: any): number | null {
	const w = f?.width, a = f?.aspectRatio;
	if (f?.fovy !== undefined || !(w > 0)) return null;
	return a > 0 ? w / a : w;
}

/** the screen-space camera controller: the globe handles the input; the flags map to its handlers */
function controllerOf(host: Host): any {
	const flags: Record<string, unknown> = {
		enableInputs: true, enableTranslate: true, enableZoom: true, enableRotate: true, enableTilt: true, enableLook: true, enableCollisionDetection: true,
		minimumZoomDistance: 1, maximumZoomDistance: Number.POSITIVE_INFINITY, inertiaSpin: 0.9, inertiaTranslate: 0.9, inertiaZoom: 0.8, maximumMovementRatio: 0.1,
		bounceAnimationTime: 3, minimumCollisionTerrainHeight: 15000, minimumPickingTerrainHeight: 150000, minimumPickingTerrainDistanceWithInertia: 4000,
		minimumTrackBallHeight: 7500000, zoomFactor: 5, translateEventTypes: 0, zoomEventTypes: [], rotateEventTypes: 0, tiltEventTypes: [], lookEventTypes: {},
	};
	const handlerOf: Record<string, string[]> = { enableInputs: ["dragPan", "scrollZoom", "dragRotate", "touchZoomRotate", "doubleClickZoom", "keyboard"], enableTranslate: ["dragPan"], enableZoom: ["scrollZoom", "doubleClickZoom"], enableRotate: ["dragPan"], enableTilt: ["dragRotate"] };
	return new Proxy(flags, {
		set(o, k, v) {
			o[k as string] = v;
			const hs = handlerOf[k as string];
			if (hs && host.map?.setHandler) for (const h of hs) host.map.setHandler(h, !!v && (k === "enableInputs" || o.enableInputs !== false));
			return true;
		},
	});
}


// Cesium's ContextLimits are filled only when a GL Context is made, which this facade never does: left at 0, any RenderState with
// lineWidth 1 (GroundPolylinePrimitive, ShadowMap) or a Texture3D throws from the constructor. Fill them with common WebGL2 limits.
let limitsSet = false;
function fillContextLimits() {
	if (limitsSet) return; limitsSet = true;
	const L = (engine as unknown as { ContextLimits?: Record<string, number | boolean> }).ContextLimits;
	if (!L || (L._maximumTextureSize as number) > 0) return;
	Object.assign(L, { _maximumCombinedTextureImageUnits: 32, _maximumCubeMapSize: 16384, _maximumFragmentUniformVectors: 1024, _maximumTextureImageUnits: 16, _maximumRenderbufferSize: 16384,
		_maximumTextureSize: 16384, _maximum3DTextureSize: 2048, _maximumVaryingVectors: 30, _maximumVertexAttributes: 16, _maximumVertexTextureImageUnits: 16, _maximumVertexUniformVectors: 1024,
		_minimumAliasedLineWidth: 1, _maximumAliasedLineWidth: 1, _minimumAliasedPointSize: 1, _maximumAliasedPointSize: 1024, _maximumViewportWidth: 16384, _maximumViewportHeight: 16384,
		_maximumTextureFilterAnisotropy: 16, _maximumDrawBuffers: 8, _maximumColorAttachments: 8, _maximumSamples: 4, _highpFloatSupported: true, _highpIntSupported: true });
}

export class OrthoScene {
	readonly host: Host;
	readonly canvas: HTMLCanvasElement;
	readonly ellipsoid = Ellipsoid.WGS84;
	readonly mapProjection = new GeographicProjection(Ellipsoid.WGS84);
	readonly mapMode2D = MapMode2D.INFINITE_SCROLL;
	readonly scene3DOnly: boolean;
	mode = SceneMode.SCENE3D;
	readonly preUpdate = new Event(); readonly postUpdate = new Event(); readonly preRender = new Event(); readonly postRender = new Event();
	readonly renderError = new Event(); readonly morphStart = new Event(); readonly morphComplete = new Event(); readonly terrainProviderChanged = new Event();
	readonly tweens = new TweenCollection();
	readonly primitives = new PrimitiveCollection(); readonly groundPrimitives = new PrimitiveCollection();
	readonly camera: any; readonly preloadFlightCamera: any; preloadFlightCullingVolume: unknown = undefined;
	readonly screenSpaceCameraController: any;
	readonly controllerHost: any;
	globe: any;
	readonly frameState: any;
	/** what the facade's own Cesium parts read as the context (no GL: ContextLimits, the voxel shaders); scene.context is a real one (rawdraw.ts) */
	readonly fakeContext = { drawingBufferWidth: 1, drawingBufferHeight: 1, webgl2: true, stencilBuffer: true, depthTexture: true, uniformState: {}, _gl: null, shaderCache: { numberOfShaders: 0 } };
	readonly atmosphere = new Atmosphere(); readonly fog = new Fog(); readonly postProcessStages: any; light: any = new SunLight();
	readonly shadowMap = { enabled: false, softShadows: false, size: 2048, darkness: 0.3, maximumDistance: 5000, normalOffset: true, fadingEnabled: true, isDestroyed: () => false, destroy: () => undefined };
	skyBox: any = { show: true }; skyAtmosphere: any = { show: true, hueShift: 0, saturationShift: 0, brightnessShift: 0, atmosphereLightIntensity: 50, atmosphereRayleighCoefficient: { x: 5.5e-6, y: 13.0e-6, z: 28.4e-6 }, atmosphereMieCoefficient: { x: 21e-6, y: 21e-6, z: 21e-6 }, atmosphereMieAnisotropy: 0.9, atmosphereRayleighScaleHeight: 10000, atmosphereMieScaleHeight: 3200 };   // SkyAtmosphere's defaults (the atmosphere example reads them)
	sun: any = { show: true, glowFactor: 1 }; moon: any = { show: true }; sunBloom = true;
	backgroundColor = Color.clone(Color.BLACK);
	rethrowRenderErrors = false; completeMorphOnUserInput = true; morphTime = 1;
	farToNearRatio = 1000; logarithmicDepthFarToNearRatio = 1e9; nearToFarDistance2D = 1.75e6;
	verticalExaggeration = 1; verticalExaggerationRelativeHeight = 0;
	debugShowFramesPerSecond = false; debugShowCommands = false; debugShowFrustums = false; debugShowFrustumPlanes = false; debugShowDepthFrustum = 1; debugCommandFilter: unknown = undefined;
	useDepthPicking = true; pickTranslucentDepth = false; cameraEventWaitTime = 500;
	invertClassification = false; invertClassificationColor = Color.clone(Color.WHITE);
	requestRenderMode = false; maximumRenderTimeChange = 0;
	highDynamicRange = false; gamma = 2.2; sphericalHarmonicCoefficients: unknown = undefined; specularEnvironmentMaps: unknown = undefined;
	splitPosition = 0; minimumDisableDepthTestDistance = 0; logarithmicDepthBuffer = true; msaaSamples = 4; focalLength: unknown = undefined; eyeSeparation: unknown = undefined;
	readonly pickPositionSupported = true; readonly sampleHeightSupported = true; readonly clampToHeightSupported = true; readonly invertClassificationSupported = false;
	readonly specularEnvironmentMapsSupported = true; readonly highDynamicRangeSupported = false; readonly msaaSupported = true; readonly orderIndependentTranslucency = true;
	readonly maximumAliasedLineWidth = 1; readonly maximumCubeMapSize = 16384; readonly id = "ortho-scene";
	pixelRatio = 1;
	lastRenderTime: any = undefined;
	#terrainProvider: any;
	#lastPose: number[] | null = null; #lastGlobe: GlobeCam | null = null; #fovy = 0;
	#postKey = ""; #aoOn = false; #clipKey = ""; #clipOwn = new WeakMap<object, boolean>();   // postProcessStages → map.setPostChain (順 4): what was last pushed
	#destroyed = false;
	readonly raw: RawDrawer;

	constructor(host: Host, canvas: HTMLCanvasElement, o: { scene3DOnly?: boolean; globe?: unknown } = {}) {
		fillContextLimits();
		this.host = host; this.canvas = canvas; this.scene3DOnly = !!o.scene3DOnly;
		this.raw = new RawDrawer(this, canvas);
		this.frameState = { mode: SceneMode.SCENE3D, mapProjection: this.mapProjection, useLogDepth: false, frameNumber: 0, time: undefined, camera: null, context: this.fakeContext, pixelRatio: 1, verticalExaggeration: 1 };
		this.screenSpaceCameraController = controllerOf(host);
		this.controllerHost = new engine.ControllerHost();   // widget.addController(ScreenSpaceTiltOrbitCameraController…): Cesium's own host, updated each frame (camera-controllers example)
		this.camera = new Camera(this as never);
		this.frameState.camera = this.camera;
		this.preloadFlightCamera = new Camera(this as never);
		this.postProcessStages = (() => { try { return new PostProcessStageCollection(); } catch { return { add: (s: unknown) => s, remove: () => true, contains: () => false, removeAll() {}, fxaa: { enabled: false }, bloom: { enabled: false, uniforms: {} }, ambientOcclusion: { enabled: false, uniforms: {} }, length: 0 }; } })();
		this.globe = o.globe === false ? undefined : makeGlobe(this);
		this.#terrainProvider = this.globe?.terrainProvider;
	}
	/** scene.context: a real Cesium Context over the globe, made when an example asks for it (its own primitives draw with it) */
	get context(): any { return this.raw.context ?? this.fakeContext; }
	get drawingBufferWidth() { return Math.max(1, Math.round(this.canvas.clientWidth * this.pixelRatio)); }
	get drawingBufferHeight() { return Math.max(1, Math.round(this.canvas.clientHeight * this.pixelRatio)); }
	get imageryLayers() { return this.globe?.imageryLayers; }
	get terrainProvider() { return this.#terrainProvider; }
	set terrainProvider(p: any) {
		this.#terrainProvider = p;
		if (this.globe) this.globe.terrainProvider = p;
		this.terrainProviderChanged.raiseEvent(p);
		onTerrain(this, p);
	}
	get view() { return { passState: {}, camera: this.camera }; }
	get defaultView() { return this.view; }
	get cameraUnderground() { return false; }
	get globeHeight() { return 0; }
	get numberOfFrustums() { return 1; }
	get frustumCommandsList() { return []; }
	get debugFrustumStatistics() { return undefined; }
	get jobScheduler() { return {}; }
	get environmentState() { return {}; }
	get picking() { return {}; }
	get vectorProvider() { return undefined; }
	get useWebVR() { return false; }
	set useWebVR(_v: boolean) { unsupported("scene.useWebVR"); }
	setTerrain(terrain: any) {
		const p = (terrain as any)?.provider; if (p) this.terrainProvider = p;
		terrain?.readyEvent?.addEventListener?.((prov: unknown) => { this.terrainProvider = prov; });
		return terrain;
	}

	// postProcessStages (Cesium's real collection; the examples add stages to it) → map.setPostChain each frame when it changed (順 4 · postprocess.ts)
	// the frame the lens flare and the depth of field are drawn for (only when such a stage is in the collection: the sun costs a little)
	#postFrame(): PostFrame | null {
		const c = this.postProcessStages as any, n = c?.length ?? 0;
		let want = false;
		for (let i = 0; i < n && !want; i++) { const s = c.get(i); want = !!s && s.enabled !== false && (s.name === "czm_lens_flare" || s.name === "czm_depth_of_field"); }
		if (!want) return null;
		const cam = this.camera as any, fr = cam.frustum, p = cam.positionWC;
		const t = this.lastRenderTime ?? (this as any).frameState?.time;
		let sun: number[] | null = null;
		try { sun = t ? sunPositionWC(t) : null; } catch { sun = null; }
		// czm_currentFrustum: Cesium's near/far fit the drawn commands, clamped to frustum.near/far; the sun and the moon are commands too (the moon at
		// 3.8e8 m), so the far is frustum.far (5e8) in practice (depth-of-field: the ground behind the focus stays almost sharp, as in Cesium)
		return { view: Array.from(cam.viewMatrix as ArrayLike<number>), proj: Array.from(fr.projectionMatrix as ArrayLike<number>), eye: [p.x, p.y, p.z], sun, near: Math.max(fr.near ?? 1, 1e-3), far: Math.max(fr.far ?? 5e8, 1000),
			radius: Math.hypot(p.x, p.y, p.z) - (cam.positionCartographic?.height ?? 0) };
	}
	#syncPost() {
		const map = this.host.map; if (!map?.setPostChain) return;
		let r: ReturnType<typeof postChainOf>;
		try { r = postChainOf(this.postProcessStages, this.#postFrame()); } catch { return; }
		const key = JSON.stringify(r.chain) + (r.ao ? "|ao" : "");
		if (key === this.#postKey) return;
		this.#postKey = key;
		for (const w of r.skipped) unsupported(w);
		try { map.setPostChain(r.chain.length ? r.chain : null); } catch (e) { console.warn("[csshim] postProcessStages", (e as Error)?.message || e); }
		if (r.ao !== this.#aoOn) { this.#aoOn = r.ao; map.setRenderFx?.({ ao: r.ao }); }
	}
	// the tilesets' clippingPlanes / clippingPolygons and globe.clippingPolygons → map.setClipping. The globe has one clipping on its models:
	// the first shown tileset that clips owns it, and every other tileset is left out of it (Cesium clips a tileset by its own collections)
	#syncClip() {
		const map = this.host.map; if (!map?.setClipping) return;
		const groups: any[] = [], skipped: string[] = [], sets: any[] = [];
		let owner: any = null;
		const walk = (c: any) => {
			for (let i = 0; i < (c?.length ?? 0); i++) {
				const p = c.get(i);
				if (p instanceof PrimitiveCollection) { walk(p); continue; }
				if (p?.orthoHandle === undefined || typeof p.clippingPlanesOriginMatrix !== "object") continue;
				sets.push(p);
				if (owner || p.show === false) continue;
				const r = p.clippingPlanes ? clipSpecOf(p.clippingPlanes, p.clippingPlanesOriginMatrix) : null, poly = polygonClipOf(p.clippingPolygons, ["models"]);
				if (r?.spec || poly) { owner = p; if (r?.spec) { groups.push(r.spec); skipped.push(...r.skipped); } if (poly) groups.push(poly); }
			}
		};
		try { walk(this.primitives); } catch { return; }
		let g: any = null;
		try { g = this.globe?.show !== false ? polygonClipOf(this.globe?.clippingPolygons, ["terrain"]) : null; } catch { /* a globe without the surface */ }
		if (g) {
			const same = groups.find(x => x.polygon && JSON.stringify([x.polygon, x.inverse]) === JSON.stringify([g.polygon, g.inverse]));
			if (same) same.targets = ["models", "terrain"]; else groups.push(g);
		}
		for (const p of sets) {
			const h = p.orthoHandle, on = !owner || p === owner;
			if (h && this.#clipOwn.get(h) !== on) { this.#clipOwn.set(h, on); h.setOptions?.({ clip: on }); }
		}
		const spec = groups.length ? (groups.length === 1 ? groups[0] : groups) : null, key = JSON.stringify(spec);
		if (key === this.#clipKey) return;
		this.#clipKey = key;
		for (const w of skipped) unsupported(w);
		try { map.setClipping(spec ?? false); } catch (e) { console.warn("[csshim] clipping", (e as Error)?.message || e); }
	}
	// ── the frame (CesiumWidget.render: initializeFrame → clock.tick → render) ──
	initializeFrame() {
		this.tweens.update();
		const map = this.host.map;
		if (!map) return;
		// the user moved the globe (or the globe flew) and Cesium code did not move the camera: take the globe's view
		const g = map.getCamera() as GlobeCam;
		const fovy = this.camera.frustum.fovy;   // an orthographic frustum has none: #pushCamera sets the telephoto field of view
		if (Number.isFinite(fovy) && Math.abs(fovy - this.#fovy) > 1e-9) { this.#fovy = fovy; map.setVerticalFieldOfView(fovy * R2D); }
		const pose = poseKey(this.camera);
		if (this.#lastGlobe && !sameGlobeCam(this.#lastGlobe, g) && sameKey(this.#lastPose, pose)) {
			setCameraWorldPose(this.camera, poseOfGlobeCam(g));
			this.#lastPose = poseKey(this.camera); this.#lastGlobe = g;
		}
	}
	render(time?: any) {
		if (this.#destroyed) return;
		this.frameState.frameNumber++; this.frameState.time = time;
		try {
			this.preUpdate.raiseEvent(this, time);
			this.postUpdate.raiseEvent(this, time);
			const credits = this.frameState.creditDisplay;
			credits?.update?.();
			this.preRender.raiseEvent(this, time);
			credits?.beginFrame?.();
			for (let i = 0; i < (this.imageryLayers?.length ?? 0); i++) {   // what the globe's tiles would credit: each shown layer's provider
				const L = this.imageryLayers.get(i), c = L.show && L.ready ? L.imageryProvider?.credit : undefined;
				if (c) credits.addCreditToNextFrame(c);
			}
			this.controllerHost.update(this, time);   // as Scene.render: the registered controllers move the camera before it is pushed to the globe
			this.#pushCamera();
			this.globe?.__orthoSyncMaterial?.();   // globe.material → the globe's ground material (after preRender: the examples set its uniforms there)
			for (const t of (this as any).__tilesets ?? []) t.__sync?.(this);   // tileset pointCloudShading → the globe
			this.#syncClip();   // tileset clippingPlanes → the globe's clipping (the examples move the plane in preRender / on drag)
			this.#syncPost();   // postProcessStages → the globe's post chain (the examples flip enabled/uniforms in preRender and the knockout bindings)
			this.raw.render(time);   // the primitives that draw themselves (Cesium DrawCommands on scene.context)
			this.camera._updateCameraChanged?.();
			this.lastRenderTime = time;   // as Scene.render: set before postRender (scene-rendering-performance reads it there)
			this.postRender.raiseEvent(this, time);
			credits?.endFrame?.();
		} catch (e) {
			this.renderError.raiseEvent(this, e);
			if (this.rethrowRenderErrors) throw e;
			console.error(e);
		}
	}
	forceRender(time?: any) { this.initializeFrame(); this.render(time); }
	requestRender() { this.host.map?.requestDraw?.(); }
	/** Cesium code moved the camera: show it on the globe */
	#pushCamera() {
		const map = this.host.map;
		if (!map) return;
		const pose = poseKey(this.camera), ortho = orthoExtent(this.camera.frustum);
		const same = sameKey(this.#lastPose, pose) && ortho === this.#lastOrtho, terrOn = !!map.getTerrain?.();
		if (same && !this.#terrainPending && terrOn === this.#terrOnLast) return;   // also again when a terrain arrived or left after the last push
		this.#terrOnLast = terrOn;
		const tf = this.camera.transform, focus = tf && !Matrix4.equals(tf, Matrix4.IDENTITY) ? Matrix4.getTranslation(tf, new Cartesian3()) : null;   // camera.lookAt / trackedEntity
		// the target is on the drawn terrain: heights come from map.sampleTerrain (async, waits for the tiles) into a memo; a point not in it yet
		// makes the result `pending`, the heights are fetched, and the push is repeated with the same pose once they are in
		const memo = this.#terrHeights, wanted: [number, number][] = [], wanting = this.#terrWanting;
		const terrainAt = typeof map.sampleTerrain === "function" && map.getTerrain?.() ? (lng: number, lat: number) => {
			const k = `${lng.toFixed(6)},${lat.toFixed(6)}`, v = memo.get(k);
			if (v !== undefined) return v;
			if (!wanting.has(k)) { wanting.add(k); wanted.push([lng, lat]); }
			return null;
		} : null;
		const g = globeCamOf(this.camera.positionWC, this.camera.directionWC, this.camera.upWC, focus, terrainAt);
		if (!g) return;
		this.#terrainPending = false;
		if (g.pending && wanted.length) {
			if (memo.size > 4000) memo.clear();
			map.sampleTerrain(wanted).then((rs: Array<{ lng: number; lat: number; height: number }>) => {
				for (const r of rs) { const k = `${r.lng.toFixed(6)},${r.lat.toFixed(6)}`; memo.set(k, Number.isFinite(r.height) ? r.height : 0); wanting.delete(k); }
				this.#terrainPending = true; this.requestRender();
			}, () => { for (const [lng, lat] of wanted) wanting.delete(`${lng.toFixed(6)},${lat.toFixed(6)}`); });
		}
		if (same && this.#lastGlobe && Math.abs(this.#lastGlobe.distance - g.distance) <= 1e-3 * g.distance) return;   // the same pose, and the terrain did not move the target
		// the globe's near plane is a share of the distance to the target; with globe:false (no terrain to hit) the target sits on the ellipsoid, up to
		// 2 km under the 3D Tiles the camera actually looks at, so the near plane (hundreds of metres) cut away everything in front of the camera
		// (google-photorealistic-3d-tiles-with-building-insert: the whole foreground white). Cesium's own near (frustum.near, 1 m) caps it instead
		const near = (this.camera.frustum as { near?: number }).near;
		if (Number.isFinite(near) && near! > 0) g.near = near;
		if (ortho !== null) {
			// an orthographic frustum (ProjectionPicker): the globe draws in perspective only, so it is drawn as a telephoto view of the same target and
			// extent (fovy ≥ 1°, the eye backed off along the view ray until the frustum's height fills the screen; ≤ 3e7 m away: a whole-earth width keeps a wider angle)
			const fov = Math.max(ORTHO_FOVY, 2 * Math.atan(ortho / 2 / 3e7));
			if (Math.abs(fov - this.#fovy) > 1e-9) { this.#fovy = fov; map.setVerticalFieldOfView(fov * R2D); }
			g.distance = ortho / 2 / Math.tan(fov / 2);
		}
		map.setCamera(g);
		this.#lastPose = pose; this.#lastOrtho = ortho; this.#lastGlobe = map.getCamera();
	}
	#lastOrtho: number | null = null;   // the orthographic frustum's height last pushed (its size moves the telephoto eye)
	#terrainPending = false; #terrOnLast = false; #terrHeights = new Map<string, number>(); #terrWanting = new Set<string>();

	// ── picking ──
	pick(windowPosition: Cartesian2, _w?: number, _h?: number) { return this.host.display?.pick(windowPosition.x, windowPosition.y); }
	async pickAsync(windowPosition: Cartesian2, w?: number, h?: number) { return this.pick(windowPosition, w, h); }
	drillPick(windowPosition: Cartesian2, limit?: number) { return this.host.display?.drillPick(windowPosition.x, windowPosition.y, limit) ?? []; }
	pickPosition(windowPosition: Cartesian2, result?: Cartesian3) { return this.pickPositionWorldCoordinates(windowPosition, result); }
	pickPositionWorldCoordinates(windowPosition: Cartesian2, result?: Cartesian3) {
		const map = this.host.map;
		if (!map) return undefined;
		const hit = map.pickPosition?.(windowPosition.x, windowPosition.y);   // 3D Tiles・models when the globe can tell
		if (hit && Number.isFinite(hit.lng)) return Cartesian3.fromDegrees(hit.lng, hit.lat, hit.height ?? 0, Ellipsoid.WGS84, result);
		const ll = map.unproject([windowPosition.x, windowPosition.y]);
		if (!ll) return undefined;
		const h = map.queryTerrainElevation?.(ll.lng, ll.lat) ?? 0;
		return Cartesian3.fromDegrees(ll.lng, ll.lat, Number.isFinite(h) ? h : 0, Ellipsoid.WGS84, result);
	}
	pickMetadata() { unsupported("scene.pickMetadata"); return undefined; }
	pickMetadataSchema() { unsupported("scene.pickMetadataSchema"); return undefined; }
	pickVoxel(windowPosition: Cartesian2) { const v = (this as any).__voxels; if (!v) { unsupported("scene.pickVoxel"); return undefined; } return v.pickVoxel(windowPosition.x, windowPosition.y); }
	// pickFromRay / drillPickFromRay: the ray against the loaded 3D Tiles (map.raycast, the triangles the globe keeps for picking) → { object, position, exclude }
	//   object = the tile's Cesium3DTileFeature (or the tileset where the triangles carry no feature ids). The globe's models are not answered (no Cesium object to give back)
	pickFromRay(ray: Ray, objectsToExclude?: unknown[], width?: number) { return this.drillPickFromRay(ray, 1, objectsToExclude, width)[0]; }
	drillPickFromRay(ray: Ray, limit?: number, objectsToExclude?: unknown[], _width?: number) {
		const map = this.host.map;
		if (!map?.raycast || !ray) return [];
		const n = limit && limit > 0 ? limit : Infinity, ex = new Set(objectsToExclude ?? []), out: any[] = [];
		const llh = (p: Cartesian3) => { const c = Ellipsoid.WGS84.cartesianToCartographic(p); return c ? [c.longitude * R2D, c.latitude * R2D, c.height] : null; };
		const a = llh(ray.origin), b = llh(Cartesian3.add(ray.origin, Cartesian3.multiplyByScalar(Cartesian3.normalize(ray.direction, new Cartesian3()), 1000, new Cartesian3()), new Cartesian3()));
		if (!a || !b) return [];
		let hits: any[] = [];
		try { hits = map.raycast(a, b, { limit: Number.isFinite(n) ? n + ex.size + 8 : 64 }); } catch { return []; }
		const sets: any[] = (this as any).__tilesets ?? [];
		for (const h of hits) {
			if (out.length >= n || h.source !== "tiles3d") continue;
			const ts = sets.find(t => t?.orthoHandle?.id === h.id);
			if (!ts || ex.has(ts)) continue;
			const object = h.featureId != null ? ts.__feature(h.featureId, h.tile) : ts;
			if (ex.has(object)) continue;
			out.push({ object, position: Cartesian3.fromDegrees(h.lng, h.lat, h.height), exclude: false });
		}
		return out;
	}
	sampleHeight(position: Cartographic) {
		const map = this.host.map;
		const r = map?.sampleHeight?.([[position.longitude * R2D, position.latitude * R2D]]);
		const h = Array.isArray(r) ? r[0]?.height : undefined;
		if (Number.isFinite(h)) return h;
		const t = map?.queryTerrainElevation?.(position.longitude * R2D, position.latitude * R2D);
		return Number.isFinite(t) ? t : undefined;
	}
	// Billboard/Label/PointPrimitive clamping (private Cesium API): the globe clamps the drawn marks itself, so answer once with the height
	// known now and hand back the remover Cesium expects
	getHeight(cartographic: Cartographic) { return this.sampleHeight(cartographic); }
	updateHeight(cartographic: Cartographic, callback: (c: Cartographic) => void) {
		const h = this.sampleHeight(cartographic);
		if (h != null) callback(new Cartographic(cartographic.longitude, cartographic.latitude, h));
		return () => {};
	}
	clampToHeight(cartesian: Cartesian3, _objectsToExclude?: unknown, _width?: number, result?: Cartesian3) {
		const c = Ellipsoid.WGS84.cartesianToCartographic(cartesian);
		if (!c) return undefined;
		const h = this.sampleHeight(c);
		return h == null ? undefined : Cartesian3.fromRadians(c.longitude, c.latitude, h, Ellipsoid.WGS84, result);
	}
	async sampleHeightMostDetailed(positions: Cartographic[]) {
		const map = await this.host.ready;
		const r = await map.sampleHeightMostDetailed?.(positions.map(p => [p.longitude * R2D, p.latitude * R2D])).catch?.(() => null);
		positions.forEach((p, i) => { const h = r?.[i]?.height ?? this.sampleHeight(p); p.height = h ?? (undefined as never); });
		return positions;
	}
	async clampToHeightMostDetailed(cartesians: Cartesian3[]) {
		const cs = cartesians.map(c => Ellipsoid.WGS84.cartesianToCartographic(c));
		await this.sampleHeightMostDetailed(cs.filter(Boolean) as Cartographic[]);
		cs.forEach((c, i) => { if (c && c.height != null) Cartesian3.fromRadians(c.longitude, c.latitude, c.height, Ellipsoid.WGS84, cartesians[i]); else (cartesians as unknown[])[i] = undefined; });
		return cartesians;
	}
	cartesianToCanvasCoordinates(position: Cartesian3, result?: Cartesian2) { return SceneTransforms.worldToWindowCoordinates(this as never, position, result); }
	getCompressedTextureFormatSupported() { return false; }
	clampLineWidth(w: number) { return Math.max(1, w); }
	isVisible() { return true; }
	snap() { return undefined; }

	// ── modes: the globe is 3D only ──
	completeMorph() {}
	morphTo2D(_d?: number) { unsupported("scene.morphTo2D (the globe is 3D only)"); }
	morphToColumbusView(_d?: number) { unsupported("scene.morphToColumbusView (the globe is 3D only)"); }
	morphTo3D(_d?: number) {}
	isDestroyed() { return this.#destroyed; }
	destroy() { this.#destroyed = true; this.tweens.removeAll(); return undefined; }
}

// the real Globe (no GL until it is updated, which never happens here) with getHeight and pick answered by the globe
function makeGlobe(scene: OrthoScene): any {
	let g: any;
	try { g = new Globe(Ellipsoid.WGS84); }
	catch (e) { console.warn("[csshim] Globe", e); g = { show: true, imageryLayers: null, terrainProvider: null, tileLoadProgressEvent: new Event(), ellipsoid: Ellipsoid.WGS84 }; }
	g.getHeight = (c: Cartographic) => {
		const t = scene.host.map?.queryTerrainElevation?.(c.longitude * R2D, c.latitude * R2D);
		return Number.isFinite(t) ? t : (scene.host.map ? 0 : undefined);
	};
	g.pick = (ray: Ray, _scene: unknown, result?: Cartesian3) => {
		const hit = IntersectionTests.rayEllipsoid(ray, Ellipsoid.WGS84);
		return hit ? Ray.getPoint(ray, hit.start, result) : undefined;
	};
	// tilesLoaded: everything in view has loaded (the globe's areTilesLoaded: a running clock does not matter, as in Cesium)
	Object.defineProperty(g, "tilesLoaded", { get: () => !!scene.host.map?.areTilesLoaded?.(), configurable: true });
	// globe.material: painted by the globe (globe-material.ts) and re-read each frame while its uniforms change (bathymetry sets them in preRender)
	let material: any; let sent = "";
	Object.defineProperty(g, "material", { get: () => material, set: (m: any) => { material = m; sent = ""; }, configurable: true });
	g.__orthoSyncMaterial = () => {
		const map = scene.host.map; if (!map || typeof map.setGroundMaterial !== "function") return;
		const key = material ? materialKey(material) : "";
		if (key === sent) return;
		sent = key;
		map.setGroundMaterial(material ? groundMaterialOf(material, readRampImage) : null);
	};
	return g;
}

// terrain providers: the world terrain (ion) becomes the globe's own terrain; an ellipsoid provider turns terrain off
// a terrain provider set after the viewer started flat: the globe gets the provider's quantized-mesh (Cesium World Terrain through the user's ion key)
function onTerrain(scene: OrthoScene, p: any) {
	if (!p) return;
	void scene.host.ready.then((map: any) => {
		if (scene.terrainProvider !== p || !map) return;
		const name = p.constructor?.name;
		if (name === "EllipsoidTerrainProvider") { map.setTerrain?.(null); return; }
		const r = p._layers?.[0]?.resource, token = (engine as any).Ion?.defaultAccessToken;
		// Cesium World Terrain itself, in its own ellipsoid heights ("orthometric" = taken as they are, no geoid taken off): Cesium's
		// tilesets, entities and camera are in ellipsoid heights, so the ground has to be too (on the globe's own geoid-based DEM
		// New York's buildings sank 33 m into it)
		const cwt = (p.__orthoWorldTerrain || (r?._ionEndpoint && /\/asset_depot\/1\//.test(r.url ?? ""))) && token;   // ours (createWorldTerrainAsync) or the engine's (Terrain.fromWorldTerrain)
		// Cesium World Bathymetry (createWorldBathymetryAsync = ion asset 2426648): the sea floor as it is (the globe keeps negative heights
		// instead of the sea surface at 0, and shows its own GEBCO sea floor where the asset has no tile)
		const bathy = !cwt && r?._ionEndpoint && /\/asset_depot\/2426648\//.test(r.url ?? "") && token;
		// another ion terrain asset (CesiumTerrainProvider.fromIonAssetId: ArcticDEM, PAMAP): the globe reads it from ion by its id
		const ionId = !cwt && !bathy && token ? +(/\/assets\/(\d+)\/endpoint/.exec(r?._ionEndpointResource?.url ?? "")?.[1] ?? NaN) : NaN;
		// a provider the globe cannot read by URL (CustomHeightmapTerrainProvider, ArcGIS LERC, VRTheWorld …): re-tiled through its own requestTileGeometry
		const urlOk = cwt || bathy || ionId > 0 || (r?.url && !r._ionEndpoint);
		const bridged = !urlOk ? bridgedTerrainSource(map, p) : null;
		if (!urlOk && !bridged && (!(scene.host as any).flatStart || map.getTerrain?.())) return;
		const source = bridged ?? (cwt ? { type: "quantized-mesh", ion: { assetId: 1, accessToken: token }, heights: "orthometric" }
			: bathy ? { type: "quantized-mesh", ion: { assetId: 2426648, accessToken: token }, heights: "orthometric", seafloor: true }
			: ionId > 0 ? { type: "quantized-mesh", ion: { assetId: ionId, accessToken: token }, heights: "orthometric" }
			: r?.url && !r._ionEndpoint ? { type: "quantized-mesh", url: new URL("layer.json", r.url).href, headers: r.headers, heights: "orthometric" } : null);
		if (source) map.setTerrain?.({ source }).catch?.((e: unknown) => console.warn("[csshim] terrain", e));
		else unsupported(`terrain provider ${name}`);
	});
}

export { BoundingSphere, Matrix4 };
