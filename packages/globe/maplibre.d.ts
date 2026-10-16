// `@ortho-earth/globe/maplibre` の型（第 2 波 F10・2026-10-12）＝MapLibre GL JS の公開面と同じ名前・同じ形の通訳の口。
// `import * as maplibregl from "@ortho-earth/globe/maplibre"` の差し替えで MapLibre のコードがこの地図で動く（src/maplibre/index.js）。
// 無い口は実行時に投げず `[mlshim] unsupported: …` を 1 回記録する＝型は MapLibre の形を保つ（呼べる・返りは undefined か this）。
// 検定＝tests/mlshim-dts.mjs（index.js の export が全部ここにある・tests/fixtures/dts/shim-usage.ts が tsc を通る）。
import type { GlobeMap, OrthoJapanOptions, MapLibreSource, MapLibreLayer, StyleExpression, LonLat, LightSpecification, SkySpecification, RasterDemSource, QuantizedMeshSource, PaddingOptions, Marker as OrthoMarker, Popup as OrthoPopup, MarkerOptions, PopupOptions, GeoJSONFeature } from "@ortho-earth/globe";
export { addProtocol, removeProtocol, Compare } from "@ortho-earth/globe";

export interface TerrainSpecification { source: string | RasterDemSource | QuantizedMeshSource; exaggeration?: number }
export interface FeatureIdentifier { source: string; sourceLayer?: string; id: number | string }

// ---- 位置 ----
export type LngLatLike = LngLat | { lng: number; lat: number } | { lon: number; lat: number } | [number, number];
export type LngLatBoundsLike = LngLatBounds | [LngLatLike, LngLatLike] | [number, number, number, number];
export type PointLike = [number, number] | { x: number; y: number };
export class LngLat {
	constructor(lng: number, lat: number);
	lng: number; lat: number;
	wrap(): LngLat; toArray(): [number, number]; toString(): string; distanceTo(o: LngLat): number; toBounds(radius?: number): LngLatBounds;
	static convert(input: LngLatLike): LngLat;
}
export class LngLatBounds {
	constructor(sw?: LngLatLike | [number, number, number, number], ne?: LngLatLike);
	setNorthEast(ne: LngLatLike): this; setSouthWest(sw: LngLatLike): this; extend(obj: LngLatLike | LngLatBoundsLike): this;
	getCenter(): LngLat; getSouthWest(): LngLat; getNorthEast(): LngLat; getNorthWest(): LngLat; getSouthEast(): LngLat;
	getWest(): number; getSouth(): number; getEast(): number; getNorth(): number;
	toArray(): [[number, number], [number, number]]; toString(): string; isEmpty(): boolean; contains(lnglat: LngLatLike): boolean;
	static convert(input: LngLatBoundsLike): LngLatBounds; static fromLngLat(center: LngLatLike, radius?: number): LngLatBounds;
}
export class MercatorCoordinate {
	constructor(x: number, y: number, z?: number);
	x: number; y: number; z: number;
	static fromLngLat(lngLatLike: LngLatLike, altitude?: number): MercatorCoordinate;
	toLngLat(): LngLat; toAltitude(): number; meterInMercatorCoordinateUnits(): number;
}
export type Quaternion = [number, number, number, number];
export class FreeCameraOptions {
	constructor(position?: MercatorCoordinate, orientation?: Quaternion);
	position?: MercatorCoordinate; orientation?: Quaternion;
	lookAtPoint(target: LngLatLike, up?: [number, number, number]): void;
	setPitchBearing(pitch: number, bearing: number): void;
}

// ---- 事象 ----
export interface MapEvent { type: string; target: Map; originalEvent?: Event }
export interface MapMouseEvent extends MapEvent { point: { x: number; y: number }; lngLat: LngLat; originalEvent: MouseEvent; features?: GeoJSONFeature[]; preventDefault(): void; defaultPrevented: boolean }
export interface MapTouchEvent extends MapEvent { point: { x: number; y: number }; lngLat: LngLat; points: { x: number; y: number }[]; lngLats: LngLat[]; originalEvent: TouchEvent; features?: GeoJSONFeature[]; preventDefault(): void }
export interface MapDataEvent extends MapEvent { dataType: "source" | "style"; sourceId?: string; isSourceLoaded?: boolean; sourceDataType?: string; tile?: unknown }
export interface MapStyleImageMissingEvent extends MapEvent { id: string }
export interface MapLayerEventMap { click: MapMouseEvent; dblclick: MapMouseEvent; mousedown: MapMouseEvent; mouseup: MapMouseEvent; mousemove: MapMouseEvent; mouseenter: MapMouseEvent; mouseleave: MapMouseEvent; mouseover: MapMouseEvent; mouseout: MapMouseEvent; contextmenu: MapMouseEvent; touchstart: MapTouchEvent; touchend: MapTouchEvent; touchcancel: MapTouchEvent }
export interface MapEventMap extends MapLayerEventMap {
	load: MapEvent; "style.load": MapEvent; styledata: MapDataEvent; data: MapDataEvent; sourcedata: MapDataEvent; idle: MapEvent; error: MapEvent & { error: Error }; resize: MapEvent; remove: MapEvent; render: MapEvent; styleimagemissing: MapStyleImageMissingEvent;
	move: MapEvent; movestart: MapEvent; moveend: MapEvent; zoom: MapEvent; zoomstart: MapEvent; zoomend: MapEvent; rotate: MapEvent; rotatestart: MapEvent; rotateend: MapEvent; pitch: MapEvent; pitchstart: MapEvent; pitchend: MapEvent; roll: MapEvent; rollstart: MapEvent; rollend: MapEvent;
	dragstart: MapEvent; drag: MapEvent; dragend: MapEvent; boxzoomstart: MapEvent; boxzoomend: MapEvent; boxzoomcancel: MapEvent; cooperativegestureprevented: MapEvent; wheel: MapEvent & { originalEvent: WheelEvent };
}
export type Listener<T = any> = (ev: T) => void;

// ---- 視点 ----
export interface CameraOptions { center?: LngLatLike; zoom?: number; bearing?: number; pitch?: number; roll?: number; elevation?: number; around?: LngLatLike; padding?: PaddingOptions | number }
export interface AnimationOptions { duration?: number; easing?: (t: number) => number; offset?: PointLike; animate?: boolean; essential?: boolean; freezeElevation?: boolean }
export type EaseToOptions = CameraOptions & AnimationOptions;
export interface FlyToOptions extends EaseToOptions { curve?: number; minZoom?: number; speed?: number; screenSpeed?: number; maxDuration?: number }
export interface FitBoundsOptions extends EaseToOptions { linear?: boolean; maxZoom?: number; maxDuration?: number }
export interface CameraForBoundsOptions extends CameraOptions { maxZoom?: number }
export interface QueryRenderedFeaturesOptions { layers?: string[]; filter?: StyleExpression | unknown[]; validate?: boolean; availableImages?: string[] }
export interface QuerySourceFeatureOptions { sourceLayer?: string; filter?: unknown[]; validate?: boolean }
export interface StyleSetterOptions { validate?: boolean }
export interface StyleSwapOptions { diff?: boolean; transformStyle?: (previous: StyleSpecification | undefined, next: StyleSpecification) => StyleSpecification }
export interface TransitionOptions { duration?: number; delay?: number }
export interface StyleSpecification {
	version: 8; name?: string; metadata?: unknown; center?: number[]; zoom?: number; bearing?: number; pitch?: number; roll?: number;
	light?: LightSpecification; sky?: SkySpecification; terrain?: TerrainSpecification; projection?: { type?: string | unknown[] }; sprite?: string | { id: string; url: string }[]; glyphs?: string;
	transition?: TransitionOptions; sources: Record<string, MapLibreSource>; layers: MapLibreLayer[]; state?: Record<string, unknown>;
}
export type RequestTransformFunction = (url: string, resourceType?: string) => { url: string; headers?: Record<string, string>; credentials?: "same-origin" | "include" } | undefined;
export interface MapOptions {
	container: string | HTMLElement; style?: StyleSpecification | string; center?: LngLatLike; zoom?: number; bearing?: number; pitch?: number; roll?: number; hash?: boolean | string;
	minZoom?: number; maxZoom?: number; minPitch?: number; maxPitch?: number; maxBounds?: LngLatBoundsLike; interactive?: boolean; attributionControl?: boolean | { compact?: boolean; customAttribution?: string | string[] };
	scrollZoom?: boolean | { around?: "center" }; boxZoom?: boolean; dragRotate?: boolean; dragPan?: boolean | Record<string, unknown>; keyboard?: boolean; doubleClickZoom?: boolean; touchZoomRotate?: boolean | { around?: "center" }; touchPitch?: boolean | Record<string, unknown>;
	cooperativeGestures?: boolean; bearingSnap?: number; pitchWithRotate?: boolean; rollEnabled?: boolean; renderWorldCopies?: boolean; maxTileCacheSize?: number; maxTileCacheZoomLevels?: number; transformRequest?: RequestTransformFunction;
	transformCameraUpdate?: (next: CameraUpdateTransformFunctionArgs) => CameraUpdateTransformFunctionArgs; locale?: Record<string, string>; fadeDuration?: number; crossSourceCollisions?: boolean; collectResourceTiming?: boolean; clickTolerance?: number;
	maplibreLogo?: boolean; logoPosition?: ControlPosition; failIfMajorPerformanceCaveat?: boolean; preserveDrawingBuffer?: boolean; antialias?: boolean; refreshExpiredTiles?: boolean; trackResize?: boolean; pixelRatio?: number; validateStyle?: boolean; maxCanvasSize?: [number, number]; cancelPendingTileRequestsWhileZooming?: boolean;
	centerClampedToGround?: boolean; elevation?: number; zoomSnap?: number;
	/** この地図だけの起動オプション（createGlobe の options への逃げ道＝夜面・星空・時計・zoomScale…） */ ortho?: Partial<Omit<OrthoJapanOptions, "target">> & { zoomScale?: "mercator" | "maplibre" };
}
export interface CameraUpdateTransformFunctionArgs { center: LngLat; zoom: number; roll: number; pitch: number; bearing: number; elevation: number }
export interface Transform { center: LngLat; zoom: number; bearing: number; pitch: number; roll: number; width: number; height: number; [k: string]: unknown }

// ---- 操作ハンドラ（MapLibre と同名・enable/disable は旗・isActive は常に false） ----
export interface HandlerLike { enable(opts?: unknown): void; disable(): void; isEnabled(): boolean; isActive(): boolean; [k: string]: (...a: any[]) => any }
export interface TouchZoomRotateHandler extends HandlerLike { enableRotation(): void; disableRotation(): void }

export type ControlPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export interface IControl { onAdd(map: Map): HTMLElement; onRemove(map: Map): void; getDefaultPosition?(): ControlPosition }
export type SourceLike = MapLibreSource & { setData?(data: unknown): Promise<void> | void; getClusterExpansionZoom?(id: number): Promise<number>; getClusterChildren?(id: number): Promise<GeoJSONFeature[]>; getClusterLeaves?(id: number, limit: number, offset: number): Promise<GeoJSONFeature[]>; setCoordinates?(c: number[][]): void; setTiles?(t: string[]): void; setUrl?(u: string): void; updateImage?(o: { url?: string; coordinates?: number[][] }): void; getCanvas?(): HTMLCanvasElement; getVideo?(): HTMLVideoElement; play?(): void; pause?(): void; [k: string]: unknown };
export type ImageLike = HTMLImageElement | ImageBitmap | ImageData | { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

export class Map {
	constructor(options: MapOptions);
	on<K extends keyof MapEventMap>(type: K, listener: Listener<MapEventMap[K]>): this;
	on<K extends keyof MapLayerEventMap>(type: K, layerId: string | string[], listener: Listener<MapLayerEventMap[K]>): this;
	on(type: string, listener: Listener): this; on(type: string, layerId: string | string[], listener: Listener): this;
	off<K extends keyof MapEventMap>(type: K, listener: Listener<MapEventMap[K]>): this;
	off<K extends keyof MapLayerEventMap>(type: K, layerId: string | string[], listener: Listener<MapLayerEventMap[K]>): this;
	off(type: string, listener: Listener): this; off(type: string, layerId: string | string[], listener: Listener): this;
	once<K extends keyof MapEventMap>(type: K, listener: Listener<MapEventMap[K]>): this; once<K extends keyof MapEventMap>(type: K): Promise<MapEventMap[K]>;
	once(type: string, layerId: string | string[], listener: Listener): this; once(type: string, layerId: string | string[]): Promise<any>; once(type: string, listener: Listener): this; once(type: string): Promise<any>;
	listens(type: string): boolean; fire(type: string | { type: string }, properties?: unknown): this;
	getCenter(): LngLat; getZoom(): number; getBearing(): number; getPitch(): number; getRoll(): number; setRoll(roll: number, eventData?: unknown): this;
	getVerticalFieldOfView(): number; setVerticalFieldOfView(fov: number, eventData?: unknown): this;
	setCenter(center: LngLatLike, eventData?: unknown): this; setZoom(zoom: number, eventData?: unknown): this; setBearing(bearing: number, eventData?: unknown): this; setPitch(pitch: number, eventData?: unknown): this;
	jumpTo(options: CameraOptions, eventData?: unknown): this; easeTo(options: EaseToOptions, eventData?: unknown): this; flyTo(options: FlyToOptions, eventData?: unknown): this;
	panTo(lnglat: LngLatLike, options?: AnimationOptions, eventData?: unknown): this; panBy(offset: PointLike, options?: AnimationOptions, eventData?: unknown): this;
	zoomTo(zoom: number, options?: AnimationOptions, eventData?: unknown): this; zoomIn(options?: AnimationOptions, eventData?: unknown): this; zoomOut(options?: AnimationOptions, eventData?: unknown): this;
	rotateTo(bearing: number, options?: AnimationOptions, eventData?: unknown): this; resetNorth(options?: AnimationOptions, eventData?: unknown): this; resetNorthPitch(options?: AnimationOptions, eventData?: unknown): this; snapToNorth(options?: AnimationOptions, eventData?: unknown): this;
	fitBounds(bounds: LngLatBoundsLike, options?: FitBoundsOptions, eventData?: unknown): this;
	cameraForBounds(bounds: LngLatBoundsLike, options?: CameraForBoundsOptions): (CameraOptions & { center: LngLat; zoom: number; bearing: number }) | undefined;
	getBounds(): LngLatBounds; setMaxBounds(bounds?: LngLatBoundsLike | null): this; getMaxBounds(): LngLatBounds | null;
	setMinZoom(z?: number | null): this; getMinZoom(): number; setMaxZoom(z?: number | null): this; getMaxZoom(): number; setMinPitch(p?: number | null): this; getMinPitch(): number; setMaxPitch(p?: number | null): this; getMaxPitch(): number;
	setPadding(padding: PaddingOptions, eventData?: unknown): this; getPadding(): PaddingOptions;
	fitScreenCoordinates(p0: PointLike, p1: PointLike, bearing: number, options?: FitBoundsOptions, eventData?: unknown): this;
	setCenterClampedToGround(on: boolean): this; getCenterClampedToGround(): boolean; setCenterElevation(m: number, eventData?: unknown): this; getCenterElevation(): number; getCameraTargetElevation(): number;
	setTransformConstrain(fn?: ((tr: Transform) => { center?: LngLatLike; zoom?: number } | undefined) | null): this;
	getFreeCameraOptions(): FreeCameraOptions; setFreeCameraOptions(options: FreeCameraOptions, eventData?: unknown): this;
	calculateCameraOptionsFromCameraLngLatAltRotation(cameraLngLat: LngLatLike, cameraAlt: number, bearing: number, pitch: number, roll?: number): CameraOptions;
	calculateCameraOptionsFromTo(from: LngLatLike, altitudeFrom: number, to: LngLatLike, altitudeTo?: number): CameraOptions;
	isMoving(): boolean; isZooming(): boolean; isRotating(): boolean; stop(): this;
	project(lnglat: LngLatLike): { x: number; y: number }; unproject(point: PointLike): LngLat;
	setStyle(style: StyleSpecification | string | null, options?: StyleSwapOptions & StyleSetterOptions): this; getStyle(): StyleSpecification; isStyleLoaded(): boolean; loaded(): boolean; areTilesLoaded(): boolean;
	addSource(id: string, source: MapLibreSource): this; removeSource(id: string): this; getSource<T extends SourceLike = SourceLike>(id: string): T | undefined; isSourceLoaded(id: string): boolean;
	addLayer(layer: MapLibreLayer | (Record<string, unknown> & { id: string; type: string }), beforeId?: string): this; removeLayer(id: string): this; getLayer(id: string): MapLibreLayer | undefined; getLayersOrder(): string[]; moveLayer(id: string, beforeId?: string): this;
	setPaintProperty(layerId: string, name: string, value: unknown, options?: StyleSetterOptions): this; getPaintProperty(layerId: string, name: string): unknown;
	setLayoutProperty(layerId: string, name: string, value: unknown, options?: StyleSetterOptions): this; getLayoutProperty(layerId: string, name: string): unknown;
	setFilter(layerId: string, filter?: unknown[] | null, options?: StyleSetterOptions): this; getFilter(layerId: string): unknown[] | undefined; setLayerZoomRange(layerId: string, minzoom: number, maxzoom: number): this;
	setGlobalStateProperty(name: string, value: unknown): this; getGlobalState(): Record<string, unknown>;
	setFeatureState(feature: FeatureIdentifier, state: Record<string, unknown>): this; removeFeatureState(feature: FeatureIdentifier, key?: string): this; getFeatureState(feature: FeatureIdentifier): Record<string, unknown>;
	queryRenderedFeatures(geometry?: PointLike | [PointLike, PointLike] | QueryRenderedFeaturesOptions, options?: QueryRenderedFeaturesOptions): GeoJSONFeature[];
	querySourceFeatures(sourceId: string, parameters?: QuerySourceFeatureOptions): GeoJSONFeature[];
	queryTerrainElevation(lngLat: LngLatLike): number | null;
	setTerrain(terrain: TerrainSpecification | null): this; getTerrain(): TerrainSpecification | null;
	setLight(light: LightSpecification, options?: StyleSetterOptions): this; getLight(): LightSpecification;
	setSky(sky: SkySpecification | null, options?: StyleSetterOptions): this; getSky(): SkySpecification;
	getSprite(): { id: string; url: string }[]; setSprite(sprite: string | null, options?: StyleSetterOptions): this; addSprite(id: string, url: string, options?: StyleSetterOptions): this; removeSprite(id: string): this;
	getImage(id: string): unknown; getGlyphs(): string | null; setGlyphs(url: string | null, options?: StyleSetterOptions): this; getStyleUrl(): string | null; getFontFaces(): unknown; setFontFaces(f: unknown): this;
	refreshTiles(sourceId: string, tileIds?: { x: number; y: number; z: number }[]): void; coveringTiles(options?: unknown): unknown[]; setSourceTileLodParams(maxZoomLevelsOnScreen: number, tileCountMaxMinRatio: number): this;
	setTransformCameraUpdate(fn?: ((next: CameraUpdateTransformFunctionArgs) => CameraUpdateTransformFunctionArgs) | null): this; setTransformRequest(fn: RequestTransformFunction | null): this;
	setPixelRatio(ratio: number): void; getPixelRatio(): number; setZoomSnap(z: number): this; getZoomSnap(): number; setAnisotropicFilterPitch(p: number): this; getAnisotropicFilterPitch(): number; setEventedParent(parent?: unknown, data?: unknown): this;
	showTileBoundaries: boolean; showPadding: boolean; showCollisionBoxes: boolean; showOverdrawInspector: boolean; vertices: boolean; repaint: boolean;
	setProjection(projection: { type: string | unknown[] }): this; getProjection(): { type: string } | undefined; getRenderWorldCopies(): boolean; setRenderWorldCopies(on?: boolean): this;
	readonly style: unknown; readonly transform: Transform; readonly version: string;
	addImage(id: string, image: ImageLike, options?: { pixelRatio?: number; sdf?: boolean; stretchX?: [number, number][]; stretchY?: [number, number][]; content?: [number, number, number, number]; textFitWidth?: string; textFitHeight?: string }): this;
	updateImage(id: string, image: ImageLike): this; hasImage(id: string): boolean; removeImage(id: string): this; listImages(): string[]; loadImage(url: string): Promise<{ data: ImageBitmap | HTMLImageElement | ImageData; cacheControl?: string; expires?: string }>;
	setMissingStyleImageResolver(fn?: ((id: string) => ImageLike | Promise<ImageLike> | undefined) | null): this;
	getContainer(): HTMLElement; getCanvasContainer(): HTMLElement; getCanvas(): HTMLCanvasElement; triggerRepaint(): void; redraw(): this; resize(eventData?: unknown): this; remove(): void;
	addControl(control: IControl, position?: ControlPosition): this; removeControl(control: IControl): this; hasControl(control: IControl): boolean;
	scrollZoom: HandlerLike; boxZoom: HandlerLike; dragRotate: HandlerLike; dragPan: HandlerLike; keyboard: HandlerLike; doubleClickZoom: HandlerLike; touchZoomRotate: TouchZoomRotateHandler; touchPitch: HandlerLike; cooperativeGestures: HandlerLike;
}

// ---- Marker / Popup（この地図の DOM の物に MapLibre の LngLat の形を足す） ----
export class Marker extends OrthoMarker {
	constructor(options?: MarkerOptions | HTMLElement, legacyOptions?: MarkerOptions);
	addTo(map: Map | GlobeMap): this; setLngLat(ll: LngLatLike): this; getLngLat(): LngLat | null;
}
export class Popup extends OrthoPopup {
	constructor(options?: PopupOptions);
	addTo(map: Map | GlobeMap): this; setLngLat(ll: LngLatLike): this; getLngLat(): LngLat | null;
}

// ---- 操作部品（IControl） ----
declare class Ctrl implements IControl { options: Record<string, unknown>; onAdd(map: Map): HTMLElement; onRemove(map: Map): void; getDefaultPosition(): ControlPosition }
export class NavigationControl extends Ctrl { constructor(options?: { showCompass?: boolean; showZoom?: boolean; visualizePitch?: boolean; visualizeRoll?: boolean }) }
export class FullscreenControl extends Ctrl { constructor(options?: { container?: HTMLElement }) }
export class GeolocateControl extends Ctrl {
	constructor(options?: { positionOptions?: PositionOptions; fitBoundsOptions?: FitBoundsOptions; trackUserLocation?: boolean; showAccuracyCircle?: boolean; showUserLocation?: boolean });
	trigger(): boolean; on(type: string, listener: Listener): this; off(type: string, listener: Listener): this;
}
export class ScaleControl extends Ctrl { constructor(options?: { maxWidth?: number; unit?: "imperial" | "metric" | "nautical" }); setUnit(unit: "imperial" | "metric" | "nautical"): void }
export class AttributionControl extends Ctrl { constructor(options?: { compact?: boolean; customAttribution?: string | string[] }) }
export class LogoControl extends Ctrl { constructor(options?: { compact?: boolean }) }
export class GlobeControl extends Ctrl { constructor(options?: Record<string, unknown>) }
export class TerrainControl extends Ctrl { constructor(options: TerrainSpecification) }
/** maplibre-gl-inspect と同じ形（中身は gadget inspect への通訳） */
export class MaplibreInspect implements IControl {
	constructor(options?: { showInspectButton?: boolean; showInspectMap?: boolean; showMapPopup?: boolean; showMapPopupOnHover?: boolean; showInspectMapPopup?: boolean; showInspectMapPopupOnHover?: boolean; blockHoverPopupOnClick?: boolean; backgroundColor?: string; assignLayerColor?: (layerId: string, alpha: number) => string; buildInspectStyle?: unknown; renderPopup?: (features: GeoJSONFeature[]) => string | HTMLElement; popup?: Popup; selectThreshold?: number; useInspectStyle?: boolean; queryParameters?: unknown; sources?: Record<string, string[]>; toggleCallback?: (showInspectMap: boolean) => void });
	options: Record<string, unknown>;
	onAdd(map: Map): HTMLElement; onRemove(map: Map): void; getDefaultPosition(): ControlPosition; toggleInspector(): void;
}

// ---- custom 層のタイル格子（MapLibre 同名） ----
export interface CreateTileMeshOptions { granularity?: number; generateBorders?: boolean; extendToNorthPole?: boolean; extendToSouthPole?: boolean }
export interface TileMesh { vertices: ArrayBuffer; indices: ArrayBuffer; uses32bitIndices: boolean }
export function createTileMesh(options?: CreateTileMeshOptions, forceIndicesSize?: "16bit" | "32bit"): TileMesh;
export class SubdivisionGranularityExpression { constructor(baseZoomGranularity: number, minGranularity: number); getGranularityForZoomLevel(zoomLevel: number): number }
export class SubdivisionGranularitySetting {
	constructor(options: { fill: SubdivisionGranularityExpression; line: SubdivisionGranularityExpression; tile: SubdivisionGranularityExpression; stencil: SubdivisionGranularityExpression; circle: number });
	fill: SubdivisionGranularityExpression; line: SubdivisionGranularityExpression; tile: SubdivisionGranularityExpression; stencil: SubdivisionGranularityExpression; circle: number;
}

// ---- 名前空間の付き物（受け取るだけ） ----
export function getVersion(): string;
export function setRTLTextPlugin(url: string, lazy?: boolean): Promise<void>;
export function getRTLTextPluginStatus(): string;
export function prewarm(): void; export function clearPrewarmedResources(): void;
export function setWorkerCount(n: number): void; export function getWorkerCount(): number;
export function setMaxParallelImageRequests(n: number): void; export function getMaxParallelImageRequests(): number;
export function setWorkerUrl(url: string): void; export function getWorkerUrl(): string;
