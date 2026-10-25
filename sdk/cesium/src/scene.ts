// A Scene without WebGL: the members Cesium code and the engine's own helpers (Camera, CameraFlightPath, EntityView, SceneTransforms,
// the widgets) read, with the real engine classes where they need no GL context (Camera, Globe, PrimitiveCollection, Fog, Atmosphere,
// PostProcessStageCollection, SunLight, TweenCollection). Drawing is the globe's; this object only keeps the state and the per-frame events.
import { BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, Ellipsoid, Event, GeographicProjection, IntersectionTests, Matrix4, Ray } from "@cesium/core";
import { Atmosphere, Camera, Fog, Globe, MapMode2D, PostProcessStageCollection, PrimitiveCollection, SceneMode, SceneTransforms, SunLight } from "@cesium/engine";
import * as engine from "@cesium/engine";
const { TweenCollection } = engine as any;   // a runtime export the d.ts leaves out
import { globeCamOf, poseOfGlobeCam, poseKey, sameKey, sameGlobeCam, setCameraWorldPose, type GlobeCam } from "./camera.ts";
import { unsupported } from "./report.ts";

/** the globe and what the facade hangs on it (filled when createGlobe resolves) */
export interface Host {
	map: any | null;
	ready: Promise<any>;
	/** the entity display (picking, bounding spheres) */
	display: { pick(x: number, y: number): unknown; drillPick(x: number, y: number, limit?: number): unknown[] } | null;
}

const R2D = 180 / Math.PI;

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
	globe: any;
	readonly frameState: any;
	readonly context = { drawingBufferWidth: 1, drawingBufferHeight: 1, webgl2: true, stencilBuffer: true, depthTexture: true, uniformState: {}, _gl: null, shaderCache: { numberOfShaders: 0 } };
	readonly atmosphere = new Atmosphere(); readonly fog = new Fog(); readonly postProcessStages: any; light: any = new SunLight();
	readonly shadowMap = { enabled: false, softShadows: false, size: 2048, darkness: 0.3, maximumDistance: 5000, normalOffset: true, fadingEnabled: true, isDestroyed: () => false, destroy: () => undefined };
	skyBox: any = { show: true }; skyAtmosphere: any = { show: true, hueShift: 0, saturationShift: 0, brightnessShift: 0, atmosphereLightIntensity: 50 };
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
	readonly specularEnvironmentMapsSupported = false; readonly highDynamicRangeSupported = false; readonly msaaSupported = true; readonly orderIndependentTranslucency = true;
	readonly maximumAliasedLineWidth = 1; readonly maximumCubeMapSize = 16384; readonly id = "ortho-scene";
	pixelRatio = 1;
	lastRenderTime: any = undefined;
	#terrainProvider: any;
	#lastPose: number[] | null = null; #lastGlobe: GlobeCam | null = null; #fovy = 0;
	#destroyed = false;

	constructor(host: Host, canvas: HTMLCanvasElement, o: { scene3DOnly?: boolean; globe?: unknown } = {}) {
		this.host = host; this.canvas = canvas; this.scene3DOnly = !!o.scene3DOnly;
		this.frameState = { mode: SceneMode.SCENE3D, mapProjection: this.mapProjection, useLogDepth: false, frameNumber: 0, time: undefined, camera: null, context: this.context, pixelRatio: 1, verticalExaggeration: 1 };
		this.screenSpaceCameraController = controllerOf(host);
		this.camera = new Camera(this as never);
		this.frameState.camera = this.camera;
		this.preloadFlightCamera = new Camera(this as never);
		this.postProcessStages = (() => { try { return new PostProcessStageCollection(); } catch { return { add: (s: unknown) => s, remove: () => true, contains: () => false, removeAll() {}, fxaa: { enabled: false }, bloom: { enabled: false, uniforms: {} }, ambientOcclusion: { enabled: false, uniforms: {} }, length: 0 }; } })();
		this.globe = o.globe === false ? undefined : makeGlobe(this);
		this.#terrainProvider = this.globe?.terrainProvider;
	}
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

	// ── the frame (CesiumWidget.render: initializeFrame → clock.tick → render) ──
	initializeFrame() {
		this.tweens.update();
		const map = this.host.map;
		if (!map) return;
		// the user moved the globe (or the globe flew) and Cesium code did not move the camera: take the globe's view
		const g = map.getCamera() as GlobeCam;
		const fovy = this.camera.frustum.fovy;
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
			this.#pushCamera();
			this.camera._updateCameraChanged?.();
			this.postRender.raiseEvent(this, time);
			credits?.endFrame?.();
			this.lastRenderTime = time;
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
		const pose = poseKey(this.camera);
		if (sameKey(this.#lastPose, pose)) return;
		const g = globeCamOf(this.camera.positionWC, this.camera.directionWC, this.camera.upWC);
		if (!g) return;
		map.setCamera(g);
		this.#lastPose = pose; this.#lastGlobe = map.getCamera();
	}

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
	pickFromRay() { unsupported("scene.pickFromRay"); return undefined; }
	drillPickFromRay() { unsupported("scene.drillPickFromRay"); return []; }
	sampleHeight(position: Cartographic) {
		const map = this.host.map;
		const r = map?.sampleHeight?.([[position.longitude * R2D, position.latitude * R2D]]);
		const h = Array.isArray(r) ? r[0]?.height : undefined;
		if (Number.isFinite(h)) return h;
		const t = map?.queryTerrainElevation?.(position.longitude * R2D, position.latitude * R2D);
		return Number.isFinite(t) ? t : undefined;
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
	Object.defineProperty(g, "tilesLoaded", { get: () => true, configurable: true });
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
		if (!(scene.host as any).flatStart || map.getTerrain?.()) return;
		const r = p._layers?.[0]?.resource, token = (engine as any).Ion?.defaultAccessToken;
		const source = p.__orthoWorldTerrain && token ? { type: "quantized-mesh", ion: { assetId: 1, accessToken: token } }
			: r?.url && !r._ionEndpoint ? { type: "quantized-mesh", url: new URL("layer.json", r.url).href, headers: r.headers } : null;
		if (source) map.setTerrain?.({ source }).catch?.((e: unknown) => console.warn("[csshim] terrain", e));
		else unsupported(`terrain provider ${name}`);
	});
}

export { BoundingSphere, Matrix4 };
