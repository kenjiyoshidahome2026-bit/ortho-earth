// Viewer and CesiumWidget on the globe.
//   CesiumWidget: the engine's own prototype (zoomTo, flyTo, trackedEntity, clock tracking of data sources, the render loop) over an instance
//   whose scene is the facade's OrthoScene and whose display is the facade's EntityDisplay. The globe (createGlobe) draws into the widget's element.
//   Viewer: the widgets' own prototype and its widgets (Animation, Timeline, HomeButton, Geocoder, InfoBox, SelectionIndicator…) built the way the
//   widgets' Viewer constructor builds them, around that CesiumWidget.
import { Cartesian3, Clock, Ellipsoid, Event, EventHelper, JulianDate, Rectangle } from "@cesium/core";
import { CesiumWidget as RealWidgetClass, CreditDisplay, SkyBox, ImageryLayer, DataSourceCollection, Entity, ScreenSpaceEventHandler, ScreenSpaceEventType, Camera, Cesium3DTileFeature as RealFeature } from "@cesium/engine";
import {
	Animation, AnimationViewModel, BaseLayerPicker, ClockViewModel, FullscreenButton, Geocoder,
	HomeButton, InfoBox, NavigationHelpButton, ProjectionPicker, SceneModePicker, SelectionIndicator, Timeline, Viewer as RealViewerClass,
} from "@cesium/widgets";
import * as widgets from "@cesium/widgets";
import * as engine from "@cesium/engine";
import { createGlobe } from "@ortho-earth/globe";
import { OrthoScene, type Host } from "./scene.ts";
import { EntityDisplay } from "./display.ts";
import { Cesium3DTileset } from "./tileset.ts";
import { syncImagery } from "./imagery.ts";
import { skyBoxLayer } from "./skybox.ts";
import { PrimitiveDrawer, isGeometryPrimitive } from "./primitives.ts";
import { VoxelDrawer, isVoxelPrimitive } from "./voxels.ts";
import { CollectionDrawer, isCollection } from "./collections.ts";
import { unsupported } from "./report.ts";

type Any = any;
// the real classes with their private members (the prototypes these chain to), and runtime exports the d.ts leaves out
const RealWidget = RealWidgetClass as Any, RealViewer = RealViewerClass as Any;
const { createDefaultImageryProviderViewModels, createDefaultTerrainProviderViewModels } = widgets as Any, { Property } = engine as Any;
const getElement = (c: Any): HTMLElement => { const el = typeof c === "string" ? document.getElementById(c) : c; if (!el) throw new Error(`Element with id "${c}" does not exist in the document.`); return el; };

/** options the facade adds (Viewer and CesiumWidget) */
export interface OrthoOptions {
	/** extra options for createGlobe (the globe underneath) */
	ortho?: Record<string, unknown>;
}

/** the globe's options for a Cesium viewer */
function globeOptions(o: Any, target: HTMLElement): Any {
	const terrain = o.terrain != null || (o.terrainProvider != null && o.terrainProvider.constructor?.name !== "EllipsoidTerrainProvider");
	return {
		target, terrain: terrain ? undefined : false, chips: false, countryTip: false, persistView: false, urlHash: false, instruments: ["attr"], ellipsoid: true,
		night: false, coastline: false, worldLines: false, maxPitch: 89, zoomMax: 25,   // Cesium lets the camera come within metres of a model (trackedEntity); the globe default stops at z20 (≈100 m)
		// the globe's own basemap is off: Cesium's imagery layers draw the ground, over the globe's base colour (Cesium's default is blue)
		style: { version: 8, sources: {}, layers: [{ id: "__cs-base", type: "background", paint: { "background-color": "#0000ff" } }] },
		stars: false, clearColor: "transparent",   // space is Cesium's: scene.backgroundColor and the sky box, drawn under the globe (skybox.ts)
		...o.ortho,
	};
}

// ── CesiumWidget ──────────────────────────────────────────────────────────────
// the globe's own furniture a Cesium page does not have (the star theatre's clock)
const CSS = ".cesium-widget #sky-clock{display:none}";
function addCss() {
	if (document.getElementById("__csshim-css")) return;
	const st = document.createElement("style"); st.id = "__csshim-css"; st.textContent = CSS; document.head.appendChild(st);
}
export function CesiumWidget(this: Any, container: Any, options: Any = {}) {
	container = getElement(container);
	addCss();
	const element = document.createElement("div");
	element.className = "cesium-widget";
	container.appendChild(element);
	const canvas = document.createElement("canvas");
	canvas.id = "c";   // the globe uses a canvas#c it finds in its container (so this canvas exists for ScreenSpaceEventHandler before the globe is up)
	canvas.oncontextmenu = () => false; canvas.onselectstart = () => false;
	element.appendChild(canvas);
	const innerCreditContainer = document.createElement("div");
	innerCreditContainer.className = "cesium-widget-credits";
	const creditContainer = options.creditContainer ? getElement(options.creditContainer) : element;
	creditContainer.appendChild(innerCreditContainer);

	let resolveReady!: (m: Any) => void;
	const host: Host = { map: null, ready: new Promise(r => { resolveReady = r; }), display: null };
	this._host = host;
	this._element = element; this._container = container; this._canvas = canvas;
	this._canvasClientWidth = 0; this._canvasClientHeight = 0; this._lastDevicePixelRatio = 0;
	this._creditViewport = options.creditViewport ? getElement(options.creditViewport) : element;
	this._creditContainer = creditContainer; this._innerCreditContainer = innerCreditContainer;
	this._canRender = false; this._renderLoopRunning = false; this._showRenderLoopErrors = options.showRenderLoopErrors ?? true;
	this._resolutionScale = 1; this._useBrowserRecommendedResolution = options.useBrowserRecommendedResolution ?? true; this._forceResize = false;
	this._entityView = undefined; this._clockTrackedDataSource = undefined; this._trackedEntity = undefined; this._needTrackedEntityUpdate = false;
	this._zoomIsFlight = false; this._zoomTarget = undefined; this._zoomPromise = undefined; this._zoomOptions = undefined;
	this._trackedEntityChanged = new Event(); this._allowDataSourcesToSuspendAnimation = true;
	this._clock = options.clock ?? new Clock();
	if (options.shouldAnimate != null) this._clock.shouldAnimate = options.shouldAnimate;

	const scene = new OrthoScene(host, canvas, { scene3DOnly: options.scene3DOnly, globe: options.globe });
	this._scene = scene;
	scene.camera.constrainedAxis = Cartesian3.UNIT_Z;
	(scene.frameState as Any).creditDisplay = new CreditDisplay(innerCreditContainer, "•", this._creditViewport);   // the real one (the scene runs its frame: OrthoScene.render)
	if (options.baseLayer === false || options.globe === false) scene.imageryLayers?.removeAll?.();
	else if (options.baseLayer) scene.imageryLayers?.add(options.baseLayer);
	else { try { scene.imageryLayers?.add(ImageryLayer.fromWorldImagery({})); } catch (e) { console.warn("[csshim] base layer", e); } }
	if (options.terrainProvider) scene.terrainProvider = options.terrainProvider;
	if (options.terrain) scene.setTerrain(options.terrain);
	if (options.skyBox === false) { scene.skyBox = undefined; scene.sun = undefined; scene.moon = undefined; }
	else { try { scene.skyBox = options.skyBox ?? SkyBox.createEarthSkyBox(); } catch (e) { console.warn("[csshim] sky box", e); } }
	this._orthoSkyBox = skyBoxLayer(scene, canvas);
	if (options.skyAtmosphere === false) scene.skyAtmosphere = undefined;
	if (options.sceneMode != null && options.sceneMode !== 3) unsupported("sceneMode other than SCENE3D (the globe is 3D only)");
	this._screenSpaceEventHandler = new ScreenSpaceEventHandler(canvas);

	const dataSourceCollection = options.dataSources ?? new DataSourceCollection();
	this._destroyDataSourceCollection = !options.dataSources;
	const display = new EntityDisplay({ scene, dataSourceCollection, host });
	host.display = display;
	const eventHelper = new EventHelper();
	this._dataSourceChangedListeners = {};
	this._automaticallyTrackDataSourceClocks = options.automaticallyTrackDataSourceClocks ?? true;
	this._dataSourceCollection = dataSourceCollection; this._dataSourceDisplay = display; this._eventHelper = eventHelper;
	this._canAnimateUpdateCallback = this._updateCanAnimate;
	eventHelper.add(this._clock.onTick, RealWidget.prototype._onTick, this);
	eventHelper.add(scene.morphStart, RealWidget.prototype._clearTrackedObject, this);
	eventHelper.add(dataSourceCollection.dataSourceAdded, RealWidget.prototype._onDataSourceAdded, this);
	eventHelper.add(dataSourceCollection.dataSourceRemoved, RealWidget.prototype._onDataSourceRemoved, this);
	eventHelper.add(scene.postRender, RealWidget.prototype._postRender, this);
	for (let i = 0; i < dataSourceCollection.length; i++) this._dataSourceAdded(dataSourceCollection, dataSourceCollection.get(i));
	this._dataSourceAdded(undefined, display.defaultDataSource);
	eventHelper.add(dataSourceCollection.dataSourceAdded, RealWidget.prototype._dataSourceAdded, this);
	eventHelper.add(dataSourceCollection.dataSourceRemoved, RealWidget.prototype._dataSourceRemoved, this);
	// primitives: our tilesets go on the globe; anything else is kept (and reported) but not drawn
	const tilesets: Cesium3DTileset[] = [];
	const prims = new PrimitiveDrawer(host);
	this._orthoPrimitives = prims;
	const colls = new CollectionDrawer();
	this._orthoCollections = colls;
	const voxels = new VoxelDrawer(host, scene.context);
	this._orthoVoxels = voxels;
	(scene as Any).__voxels = voxels;
	display.extra.sources.push(colls.source);
	display.extra.lines = () => prims.lines.length && colls.lines.length ? [...prims.lines, ...colls.lines] : prims.lines.length ? prims.lines : colls.lines;
	display.extra.pickers.push((x, y) => prims.pick(x, y));
	scene.preRender.addEventListener(() => { prims.update(); colls.update(); voxels.update(); });
	(scene as Any).__tilesets = tilesets;
	const onAdd = (p: Any) => {
		if (p instanceof Cesium3DTileset) { tilesets.push(p); p.__attach(host); }
		else if (isGeometryPrimitive(p)) prims.add(p);
		else if (isCollection(p)) colls.add(p);
		else if (isVoxelPrimitive(p)) voxels.add(p);
		else if (p && typeof p.add === "function" && typeof p.get === "function" && p.primitiveAdded) { for (let i = 0; i < p.length; i++) onAdd(p.get(i)); p.primitiveAdded.addEventListener(onAdd); p.primitiveRemoved.addEventListener(onRemove); }
		else unsupported(`scene.primitives.add(${p?.constructor?.name ?? typeof p})`);
	};
	const onRemove = (p: Any) => { prims.remove(p); colls.remove(p); voxels.remove(p); if (p instanceof Cesium3DTileset) { const i = tilesets.indexOf(p); if (i >= 0) tilesets.splice(i, 1); p.__detach(); } };
	scene.primitives.primitiveAdded.addEventListener(onAdd); scene.primitives.primitiveRemoved.addEventListener(onRemove);
	scene.groundPrimitives.primitiveAdded.addEventListener(onAdd);

	// the globe
	const gopts = globeOptions(options, element);
	(host as Any).flatStart = gopts.terrain === false;   // the globe started flat: a terrain provider set later brings a DEM (scene.ts)
	const ready = createGlobe(gopts).then((map: Any) => {
		host.map = map;
		map.pinRes?.(true);   // Cesium draws every frame at full resolution (resolutionScale 1): the globe's dynamic resolution stays off
		map.clock?.setStep?.(0);   // the Cesium clock drives the globe's clock (EntityDisplay.update)
		syncImagery(scene, map);
		let base = "", atm = "", gop = -1;   // globe.baseColor → the background under the imagery (scene.backgroundColor → space: skybox.ts)
		scene.postRender.addEventListener(() => {
			// the globe's opacity: none (viewer { globe: false }, globe.show = false: the 3D Tiles are the ground), translucent (globe.translucency) or opaque
			const gb = scene.globe, tr = gb?.translucency, bd = tr?.frontFaceAlphaByDistance;
			let op = 1;
			if (!gb || gb.show === false) op = 0;
			else if (tr?.enabled) {
				op = typeof tr.frontFaceAlpha === "number" ? tr.frontFaceAlpha : 1;
				if (bd) {   // by the distance to the ground (Cesium: to each tile; here the nearer of the camera's height and its distance to the target)
					const h = scene.camera.positionCartographic?.height, d = Math.min(map.getCamera?.()?.distance ?? Infinity, Number.isFinite(h) ? Math.abs(h) : Infinity);
					const t = !Number.isFinite(d) ? 1 : bd.far > bd.near ? Math.max(0, Math.min(1, (d - bd.near) / (bd.far - bd.near))) : (d < bd.near ? 0 : 1);
					op *= bd.nearValue + (bd.farValue - bd.nearValue) * t;
				}
			}
			op = Math.round(op * 100) / 100;
			if (op !== gop) { gop = op; map.setGlobeOpacity?.(op); }
			const c = scene.globe?.baseColor?.toCssColorString?.() ?? "rgb(0,0,255)";
			if (c !== base) { base = c; map.setPaintProperty?.("__cs-base", "background-color", c); }
			// Cesium's atmosphere (the ground atmosphere seen from afar, the sky atmosphere): the globe draws them with Cesium's own formulas
			const ground = scene.globe?.show !== false && scene.globe?.showGroundAtmosphere !== false, sky = !!scene.skyAtmosphere && scene.skyAtmosphere.show !== false;
			if (`${ground}${sky}` !== atm) { atm = `${ground}${sky}`; map.setAtmosphere?.({ model: "cesium", ground, sky }); }
		});
		this._forceResize = true;
		resolveReady(map);
		return map;
	});
	ready.catch((e: unknown) => { console.error("[csshim] createGlobe", e); scene.renderError.raiseEvent(scene, e); });
	this._orthoReady = ready;
	this._useDefaultRenderLoop = undefined;
	this.useDefaultRenderLoop = options.useDefaultRenderLoop ?? true;
	this._targetFrameRate = undefined;
	this.targetFrameRate = options.targetFrameRate;
	this._onRenderError = (_s: unknown, error: unknown) => { console.error("[csshim] render error", error); };
	scene.renderError.addEventListener(this._onRenderError);
}
CesiumWidget.prototype = Object.create(RealWidget.prototype, { constructor: { value: CesiumWidget, writable: true, configurable: true } });
Object.setPrototypeOf(CesiumWidget, RealWidget);
Object.defineProperties(CesiumWidget.prototype, {
	creditDisplay: { get(this: Any) { return this._scene.frameState.creditDisplay; } },
	dataSourceDisplay: { get(this: Any) { return this._dataSourceDisplay; } },
	/** the globe (a Promise until createGlobe resolves): the escape hatch to ortho-earth's own API */
	orthoMap: { get(this: Any) { return this._host.map; } },
	orthoReady: { get(this: Any) { return this._orthoReady; } },
});
Object.assign(CesiumWidget.prototype, {
	resize(this: Any) {
		const c = this._canvas, w = c.clientWidth, h = c.clientHeight;
		if (!this._forceResize && w === this._canvasClientWidth && h === this._canvasClientHeight) return;
		this._forceResize = false;
		this._canvasClientWidth = w; this._canvasClientHeight = h;
		this._canRender = w > 0 && h > 0;
		const f = this._scene.camera.frustum;
		if (w > 0 && h > 0) { if (f.aspectRatio != null) f.aspectRatio = w / h; else { f.top = f.right * (h / w); f.bottom = -f.top; } }
	},
	render(this: Any) {
		const scene = this._scene;
		scene.initializeFrame();
		const t = this._clock.tick();
		scene.render(t);
	},
	showErrorPanel(this: Any, title: string, message?: string, error?: unknown) { console.error("[csshim]", title, message ?? "", error ?? ""); },
	destroy(this: Any) {
		const ds = this.dataSources;
		for (let i = 0; i < ds.length; i++) this._dataSourceRemoved(ds, ds.get(i));
		this._dataSourceRemoved(undefined, this._dataSourceDisplay.defaultDataSource);
		this._orthoSkyBox?.(); this._orthoPrimitives?.destroy(); this._orthoCollections?.destroy(); this._orthoVoxels?.destroy();
		this._dataSourceDisplay.destroy();
		this._scene.destroy();
		this._host.map?.destroy?.();
		this._element.remove(); this._innerCreditContainer.remove();
		this._eventHelper.removeAll();
		if (this._destroyDataSourceCollection) this._dataSourceCollection.destroy();
		this._useDefaultRenderLoop = false;
		this.isDestroyed = () => true;
	},
});

// ── Viewer ───────────────────────────────────────────────────────────────────
export function Viewer(this: Any, container: Any, options: Any = {}) {
	container = getElement(container);
	const that = this;
	const createBaseLayerPicker = options.globe !== false && options.baseLayerPicker !== false;
	const viewerContainer = document.createElement("div");
	viewerContainer.className = "cesium-viewer";
	container.appendChild(viewerContainer);
	const cesiumWidgetContainer = document.createElement("div");
	cesiumWidgetContainer.className = "cesium-viewer-cesiumWidgetContainer";
	viewerContainer.appendChild(cesiumWidgetContainer);
	const bottomContainer = document.createElement("div");
	bottomContainer.className = "cesium-viewer-bottom";
	viewerContainer.appendChild(bottomContainer);
	const scene3DOnly = options.scene3DOnly ?? false;
	let clock: Any, clockViewModel: Any, destroyClockViewModel = false;
	if (options.clockViewModel) { clockViewModel = options.clockViewModel; clock = clockViewModel.clock; }
	else { clock = new Clock(); clockViewModel = new ClockViewModel(clock); destroyClockViewModel = true; }
	const cesiumWidget: Any = new (CesiumWidget as Any)(cesiumWidgetContainer, {
		...options,
		baseLayer: options.baseLayer ?? ((createBaseLayerPicker && options.selectedImageryProviderViewModel) || options.imageryProvider ? false : undefined),
		clock, creditContainer: options.creditContainer ?? bottomContainer, scene3DOnly,
	});
	const scene = cesiumWidget.scene;
	const eventHelper = new EventHelper();
	eventHelper.add(clock.onTick, RealViewer.prototype._onTick, this);
	let selectionIndicator: Any, infoBox: Any;
	if (options.selectionIndicator !== false) {
		const c = document.createElement("div"); c.className = "cesium-viewer-selectionIndicatorContainer"; viewerContainer.appendChild(c);
		selectionIndicator = new SelectionIndicator(c, scene);
	}
	if (options.infoBox !== false) {
		const c = document.createElement("div"); c.className = "cesium-viewer-infoBoxContainer"; viewerContainer.appendChild(c);
		infoBox = new InfoBox(c);
		eventHelper.add(infoBox.viewModel.cameraClicked, RealViewer.prototype._onInfoBoxCameraClicked, this);
		eventHelper.add(infoBox.viewModel.closeClicked, RealViewer.prototype._onInfoBoxClockClicked, this);
	}
	const toolbar = document.createElement("div");
	toolbar.className = "cesium-viewer-toolbar";
	viewerContainer.appendChild(toolbar);
	let geocoder: Any, homeButton: Any, sceneModePicker: Any, projectionPicker: Any, baseLayerPicker: Any, baseLayerPickerDropDown: Any, navigationHelpButton: Any, animation: Any, timeline: Any, fullscreenButton: Any;
	if (options.geocoder !== false) {
		const c = document.createElement("div"); c.className = "cesium-viewer-geocoderContainer"; toolbar.appendChild(c);
		try {
			geocoder = new Geocoder({ container: c, geocoderServices: options.geocoder && typeof options.geocoder !== "boolean" && typeof options.geocoder !== "string" ? (Array.isArray(options.geocoder) ? options.geocoder : [options.geocoder]) : undefined, scene });
			eventHelper.add(geocoder.viewModel.search.beforeExecute, RealViewer.prototype._clearObjects, this);
		} catch (e) { console.warn("[csshim] Geocoder", e); }
	}
	if (options.homeButton !== false) {
		homeButton = new HomeButton(toolbar, scene);
		eventHelper.add(homeButton.viewModel.command.beforeExecute, RealViewer.prototype._clearTrackedObject, this);
	}
	if (!scene3DOnly && options.sceneModePicker !== false) { try { sceneModePicker = new SceneModePicker(toolbar, scene); } catch (e) { console.warn("[csshim] SceneModePicker", e); } }
	if (options.projectionPicker) {   // the button is Cesium's; the globe draws in perspective only (an orthographic frustum is reported when chosen)
		try { projectionPicker = new ProjectionPicker(toolbar, scene); projectionPicker.viewModel.switchToOrthographic.afterExecute.addEventListener(() => unsupported("orthographic frustum (ProjectionPicker)")); }
		catch (e) { console.warn("[csshim] ProjectionPicker", e); }
	}
	if (createBaseLayerPicker) {
		try {
			baseLayerPicker = new BaseLayerPicker(toolbar, {
				globe: scene.globe, imageryProviderViewModels: options.imageryProviderViewModels ?? createDefaultImageryProviderViewModels(), selectedImageryProviderViewModel: options.selectedImageryProviderViewModel,
				terrainProviderViewModels: options.terrainProviderViewModels ?? createDefaultTerrainProviderViewModels(), selectedTerrainProviderViewModel: options.selectedTerrainProviderViewModel,
			});
			baseLayerPickerDropDown = toolbar.getElementsByClassName("cesium-baseLayerPicker-dropDown")[0];
		} catch (e) { console.warn("[csshim] BaseLayerPicker", e); }
	}
	if (options.baseLayer && options.baseLayer !== false) {
		if (baseLayerPicker) baseLayerPicker.viewModel.selectedImagery = undefined;
		scene.imageryLayers.removeAll(); scene.imageryLayers.add(options.baseLayer);
	}
	if (options.navigationHelpButton !== false) {
		let showNavHelp = true;   // the widgets' Viewer: open the first time on this origin
		try { if (localStorage.getItem("cesium-hasSeenNavHelp")) showNavHelp = false; else localStorage.setItem("cesium-hasSeenNavHelp", "true"); } catch { /* no storage */ }
		try { navigationHelpButton = new NavigationHelpButton({ container: toolbar, instructionsInitiallyVisible: options.navigationInstructionsInitiallyVisible ?? showNavHelp }); } catch (e) { console.warn("[csshim] NavigationHelpButton", e); }
	}
	if (options.animation !== false) {
		const c = document.createElement("div"); c.className = "cesium-viewer-animationContainer"; viewerContainer.appendChild(c);
		animation = new Animation(c, new AnimationViewModel(clockViewModel));
	}
	if (options.timeline !== false) {
		const c = document.createElement("div"); c.className = "cesium-viewer-timelineContainer"; viewerContainer.appendChild(c);
		timeline = new Timeline(c, clock);
		timeline.addEventListener("settime", (e: Any) => { e.clock.currentTime = e.timeJulian; e.clock.shouldAnimate = false; }, false);
		timeline.zoomTo(clock.startTime, clock.stopTime);
	}
	if (options.fullscreenButton !== false) {
		const c = document.createElement("div"); c.className = "cesium-viewer-fullscreenContainer"; viewerContainer.appendChild(c);
		try { fullscreenButton = new FullscreenButton(c, options.fullscreenElement); } catch (e) { console.warn("[csshim] FullscreenButton", e); }
		if (timeline) { timeline.container.style.right = `${c.clientWidth}px`; timeline.resize(); }
	}
	if (options.vrButton) unsupported("Viewer option vrButton");
	Object.assign(this, {
		_baseLayerPickerDropDown: baseLayerPickerDropDown, _fullscreenSubscription: undefined, _vrSubscription: undefined, _vrModeSubscription: undefined,
		_dataSourceChangedListeners: {}, _container: container, _bottomContainer: bottomContainer, _element: viewerContainer, _cesiumWidget: cesiumWidget,
		_selectionIndicator: selectionIndicator, _infoBox: infoBox, _clockViewModel: clockViewModel, _destroyClockViewModel: destroyClockViewModel, _toolbar: toolbar,
		_homeButton: homeButton, _sceneModePicker: sceneModePicker, _projectionPicker: projectionPicker, _baseLayerPicker: baseLayerPicker, _navigationHelpButton: navigationHelpButton,
		_animation: animation, _timeline: timeline, _fullscreenButton: fullscreenButton, _vrButton: undefined, _geocoder: geocoder, _eventHelper: eventHelper,
		_lastWidth: 0, _lastHeight: 0, _enableInfoOrSelection: !!(infoBox || selectionIndicator), _selectedEntity: undefined, _selectedEntityChanged: new Event(),
	});
	const dataSourceCollection = cesiumWidget.dataSources, display = cesiumWidget.dataSourceDisplay;
	eventHelper.add(dataSourceCollection.dataSourceAdded, RealViewer.prototype._onDataSourceAdded, this);
	eventHelper.add(dataSourceCollection.dataSourceRemoved, RealViewer.prototype._onDataSourceRemoved, this);
	eventHelper.add(scene.postUpdate, RealViewer.prototype.resize, this);
	for (let i = 0; i < dataSourceCollection.length; i++) this._dataSourceAdded(dataSourceCollection, dataSourceCollection.get(i));
	this._dataSourceAdded(undefined, display.defaultDataSource);
	eventHelper.add(dataSourceCollection.dataSourceAdded, RealViewer.prototype._dataSourceAdded, this);
	eventHelper.add(dataSourceCollection.dataSourceRemoved, RealViewer.prototype._dataSourceRemoved, this);
	const pickEntity = (e: Any) => {
		const picked = scene.pick(e.position);
		if (!picked) return undefined;
		const id = picked.id ?? picked.primitive?.id;
		if (id instanceof Entity) return id;
		if (picked instanceof RealFeature) {
			const ids = picked.getPropertyIds();
			const name = picked.getProperty("name") ?? picked.getProperty("title") ?? picked.getProperty("id");
			return new Entity({ name: name != null ? String(name) : undefined, description: `<table class="cesium-infoBox-defaultTable"><tbody>${ids.map((k: string) => `<tr><th>${k}</th><td>${picked.getProperty(k)}</td></tr>`).join("")}</tbody></table>`, feature: picked } as Any);
		}
		return undefined;
	};
	cesiumWidget.screenSpaceEventHandler.setInputAction((e: Any) => { that.selectedEntity = pickEntity(e); }, ScreenSpaceEventType.LEFT_CLICK);
	cesiumWidget.screenSpaceEventHandler.setInputAction((e: Any) => {
		const entity = pickEntity(e);
		if (entity) { if (Property.getValueOrUndefined(entity.position, that.clock.currentTime)) that.trackedEntity = entity; else that.zoomTo(entity); }
		else if (that.trackedEntity) that.trackedEntity = undefined;
	}, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
	cesiumWidget._canAnimateUpdateCallback = this._updateCanAnimate(this);
}
Viewer.prototype = Object.create(RealViewer.prototype, { constructor: { value: Viewer, writable: true, configurable: true } });
Object.setPrototypeOf(Viewer, RealViewer);
Object.defineProperties(Viewer.prototype, {
	/** the globe (null until createGlobe resolves) */
	orthoMap: { get(this: Any) { return this._cesiumWidget.orthoMap; } },
	/** resolves to the globe when it is up */
	orthoReady: { get(this: Any) { return this._cesiumWidget.orthoReady; } },
});

export { Camera, Ellipsoid, JulianDate, Rectangle };
