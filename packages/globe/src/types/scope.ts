// createGlobe の中の物（globe.js・まだ JS＝batch 3）を installer（src/api/*.ts）が受ける時の型（TS 化 段 4・batch 1・2026-10-16）。
//   GlobeScope＝createGlobe の定数・関数（deps として渡す）・GlobeLive＝createGlobe の let（live の getter／setter で読み書きする）。
//   どちらも installer が読む分だけを構造で書く（globe.js が持つ他のメンバーは書かない）。installer ごとの deps／live は install.ts が Pick で選ぶ。
//   batch 3（globe.js → globe.ts）ではここが createGlobe の中の変数の注釈の元になる。
import type { MLLayer, parseViewHash, resolveVectorSource, sourceFeatures, splitMapLibreStyle } from "@ortho-earth/core";
import type { DemSource } from "@ortho-earth/core";
import type { FlightController, InputController } from "@ortho-earth/core";
import type { CameraPose } from "@ortho-earth/core/camera";
import type { Clock } from "@ortho-earth/ephem/clock";
import type { ClipPlane } from "@ortho-earth/core/clip";
import type { DtmDecl, createGetHeight } from "@ortho-earth/core/elevation";
import type { AnnoHandle, Bbox, CameraTarget, ClipOptions, CogHandle, ColumnarLayerHandle, Gadgets, OverlayHandle, FollowHandle, GlobeOptions, LightSpecification, LonLat, MapRegistry, PaddingOptions, RasterCatalogEntry, RenderedFeature, RasterOptions, RasterSpec, SkySpecification, TerrainSourceSpec } from "../../globe.d.ts";
import type { GeoPBF, Geometry } from "geopbf";
import type { CzmlPlayer } from "../gadgets/czml.ts";
import type { Aggregate } from "../gadgets/aggregate.ts";
import type { GJLabels } from "../gadgets/gjlabels.ts";
import type { Symbols } from "../gadgets/symbols.ts";
import type { Corners } from "geopbf/edit/imagequad";
import type { DataReturn, ImagesReturn, IntakeReturn, OverlaysReturn, QueryReturn, RasterReturn, ShadowsReturn, StyleReturn, ToolsReturn } from "./install.ts";
import type { GlobeInternals, GlobeMap, RegisterGadget } from "./map.ts";
import type { VideoQuads } from "../gadgets/videoquad.ts";
import type { Requester } from "../request.ts";
import type { ScenePlayer } from "../scenes/player.ts";
import type { SpriteEntry } from "../mlsmall.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// globe.js の中の共有の部品（いくつもの installer が受ける物）
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** 描画の大きさ（device px）＝createGlobe が中身を書き換える同じ物 */
export interface DrawSize { w: number; h: number }
/** render worker へ送る（globe.js の wPost） */
export type WPost = (msg: { type: string; [k: string]: unknown }, transfer?: Transferable[]) => void;
/** destroy の時に呼ぶ関数の列（globe.js の ownDestroy） */
export type OwnDestroy = Array<() => void>;
/** map.on の購読の表（globe.js の mapOn）＝出来事の名前 → 呼ぶ関数の列（clouds・styleimagemissing・load…） */
export type MapOnTable = Record<string, Array<(e: unknown) => void>>;
/** 検証の窓（globe.js の dbgHost＝window か器）＝__* の名前で書くだけ */
export type DebugHost = Record<string, unknown>;
/** UI 文言の訳（globe.js の t） */
export type Translate = (key: string, ...args: Array<string | number>) => string;

/** 外来の MapLibre の source（core の MLSource＝addSource が受けた物をそのまま持つ・型は自由） */
export type MLSourceSpec = Parameters<typeof resolveVectorSource>[0];
/** 利用者の source（addSource の spec をそのまま持つ）＝installer が読む分 */
export interface UserSource extends MLSourceSpec {
	type?: string; data?: unknown; cluster?: boolean; promoteId?: string | Record<string, string> | null;
	/** BASE_SRC（基図の source の印）などの symbol の鍵 */
	[k: symbol]: unknown;
}
/** 利用者の層（addLayer の層＝MapLibre の形・custom 層は object そのまま） */
export type UserLayer = MLLayer;
/** 利用者の層の台帳の 1 件（globe.js の mlLayers の値）＝installer が読む分 */
export interface UserLayerRec {
	layer: UserLayer; src: UserSource; dz: number;
	/** 描き方（gint／vtdraw／raster／custom …＝kindOf） */
	kind?: string;
	/** getStyle の順＝どの層の前か */
	before?: string | null;
	/** worker 経路の custom 層のオーバーレイ */
	ov?: OverlayHandle | null;
	/** 載せる途中（isSourceLoaded の材料） */
	mounting?: boolean;
	/** paint の transition の走っている目標値（getPaintProperty が返す） */
	trans?: Record<string, unknown>;
}
/** vector source の読み口（vtxDescOf の戻り＝TileJSON／PMTiles を解いた物） */
export interface VtxDesc {
	tileUrl: ((z: number, x: number, y: number) => string | null | undefined) | null; pmtiles: string | null;
	minzoom?: number; maxzoom?: number; bounds?: number[] | null; promoteId?: string | Record<string, string> | null; encoding?: string; coverage?: unknown;
	vectorLayers?: Array<{ id: string; fields?: Record<string, string>; minzoom?: number; maxzoom?: number }> | null;
}
/** vector source の fill／line／circle／symbol（gadgets/vtdraw.js の戻り）＝installer が読む分 */
export interface VtdCtl {
	/** その source の出しているタイル */
	shownTiles(sid: string): Array<{ key: string; z: number }>;
	/** その source（基図の source 名も）の見えているタイルが組み上がって載ったか */
	loaded(sid: string): boolean;
	has(layerId: string): boolean;
	setVisible(layerId: string, on: boolean): void;
	/** その地物を含むタイルだけ組み直す（id 省略＝その source（sourceLayer）の全部） */
	touchFS(sid: string, sourceLayer: string | null, id: unknown): void;
	/** 層の順の鍵を振り直す（moved＝動いた層） */
	setOrder(order: string[], moved?: string): void;
}
/** vector source の fill-extrusion（gadgets/vtextrude.js の戻り）＝installer が読む分 */
export interface VtxCtl {
	/** その source の出しているタイルの鍵 */
	shownTiles(sid: string): string[];
	loaded(sid: string): boolean;
	has(layerId: string): boolean;
	setVisible(layerId: string, on: boolean): void;
	touchFS(sid: string, sourceLayer: string | null, id: unknown): void;
	/** 立体の当たり（押し出しの d＝奥行き） */
	query(geometry: [number, number] | [[number, number], [number, number]], take: (layerId: string) => boolean): Promise<Array<{ d: number; f: RenderedFeature }>>;
}
/** vector source の生のタイルの写し（vtraw.js の createRawStore の戻り）＝installer が読む分 */
export interface RawTileStore {
	keys(sid: string): string[];
	/** 解読済み（解けない＝{}・無い＝null） */
	decoded(sid: string, key: string): Parameters<typeof sourceFeatures>[0];
}
/** custom 層の canvas（custom-gl.js の createCustomGL の戻り）＝installer が読む分 */
export interface CustomCtl { readonly canvas: HTMLCanvasElement | null }
/** テーマの判定（themes.js の createThemes の戻り）＝installer は作って置くだけ */
export type Themes = object;
/** 基図の層の実行時の上書き（setPaintProperty 等・removeLayer＝removed） */
export interface BaseOverride {
	removed?: boolean; paint?: Record<string, unknown>; layout?: Record<string, unknown>; filter?: unknown;
	minzoom?: number | null; maxzoom?: number | null;
}
/** addLayer の fill/line/circle を詰めた gint の pass（globe.js の mlPasses の値）＝installer が読む分 */
export interface MlPass {
	sid: string;
	/** 描く順（大きいほど上） */
	order: number;
	pbf: GeoPBF;
	h: {
		setPaint(paint: object, x: null): unknown;
		setFeatureState(fid: number | null | undefined, state: Record<string, unknown>): unknown;
		removeFeatureState(fid: number | null | undefined): unknown;
		_shown?(zoom: number): boolean;
		_accept?(): ((fid: number) => boolean) | null;
	};
	/** drawn＝層 id → fid ごとの「描いている」 */
	holder: { pass: { layers: MLLayer[] }; drawn: Record<string, ArrayLike<unknown> | undefined> | null };
}
/** 模様・線の飾り（canvas2D の口）の 1 層（globe.js の patItems の値） */
export interface PatItem {
	fill: boolean; sid: string;
	feats: Array<{ f: { geometry: QueryGeometry; properties?: Record<string, unknown> | null }; width: number; offset: number; lines: number[][][] }>;
}
/** 当たりで読む GeoJSON の形 */
export type QueryGeometry = Geometry;
/** 模型・3D Tiles の当たり（model.js の pick・tiles3d.js の pickAll の 1 件） */
export interface MeshHit {
	distance: number; featureId?: number | string | null; properties?: Record<string, unknown> | null; lngLat: LonLat;
	state?: Record<string, unknown>; table?: unknown;
}
/** 3D Tiles（gadgets/tiles3d.js の戻り）＝installer が読む分 */
export interface T3dCtl { pickAll(x: number, y: number): Array<MeshHit & { id: string }> }
/** URL の #hash の視点（core の parseViewHash の戻り） */
export type ParsedView = NonNullable<ReturnType<typeof parseViewHash>>;
/** 外来の MapLibre の style.json（core の MLStyle） */
export type MLStyleSpec = Parameters<typeof splitMapLibreStyle>[0];
/** 外来 style の文書（loadMapLibreStyle が layers を確かめた物）＝installer が読む根の欄 */
export interface ExtStyleDoc extends MLStyleSpec {
	layers: MLLayer[]; sources: Record<string, MLSourceSpec>;
	name?: string; sprite?: string | Array<{ id?: string; url?: string }>; glyphs?: string;
	light?: LightSpecification; sky?: SkySpecification;
	terrain?: { source?: string; exaggeration?: number };
	transition?: { duration?: number; delay?: number };
	metadata?: { "ortho:sourceDz"?: Record<string, number>; [k: string]: unknown };
}
/** 外来 style を読んだ物（globe.js の loadExtStyle の戻り＝EXT） */
export interface ExtStyle {
	ms: ExtStyleDoc; split: ReturnType<typeof splitMapLibreStyle>; src: Awaited<ReturnType<typeof resolveVectorSource>> | null;
	baseUrl: string | undefined; url: string | null;
}
/** 地形の DEM の spec（setTerrain・style の terrain・?dem=）＝raster-dem か quantized-mesh。中身は core の createDemSource が整える */
export type TerrainSpec = TerrainSourceSpec;

/** globe の cam（core の CameraPose を常に全部埋めた物＋globe が足す物）＝map.cam と同じ物 */
export interface GlobeCam extends CameraPose { pitch: number; bearing: number; roll: number; dpr: number; centerAlt?: number }

/** 基図の style（themes.js の theme.style・外来 style は extBaseStyle）＝installer が読む分 */
export interface BaseStyle {
	layers: MLLayer[];
	schema?: { buildings?: { layer: string; heightByCode?: Record<string, number>; codeKey: string; defaultHeight?: number } | null } | null;
	ext?: boolean;
	globalState?: Record<string, unknown>;
	[k: string]: unknown;
}

/** 模型の制御（gadgets/model.js の createModels の戻り）＝installer が読む分 */
export interface ModelCtl {
	/** 今の模型の名前（無ければ null） */
	readonly name?: string | null;
	/** 画面の点（CSS px）に一番手前の三角形 */
	pick(x: number, y: number): MeshHit | null;
	/** 押し出しのスロットごと（新しいスロットが後ろ） */
	readonly extrudeSets?: Array<{ slot: string; used: Array<{ f: { geometry: QueryGeometry; properties?: Record<string, unknown> | null }; h: number; base: number }>; mode: string; lift: number }>;
	extrudedFeatures?: Array<{ h: number; f?: { geometry?: { type: string; coordinates?: unknown } | null } | null }>;
	/** 押し出しを外す（slot 省略＝全部） */
	clearExtrude(slot?: string): void;
	/** 押し出し（src＝GeoJSON・opts＝{ height: 鍵名, scale, bottom, … } か MapLibre の fill-extrusion の層） */
	/** 模型を全部外す */
	clear(): void;
	extrude(src: unknown, opts?: { height?: string; scale?: number; bottom?: number | "drape" | "ground" | null; [k: string]: unknown }): ReturnType<Gadgets["extrude"]>;
}

/** CZML／GPX の再生（gadgets/czml.js の createCzmlPlayer の戻り） */
export type CzmlCtl = CzmlPlayer;
/** gint の層の束（gint/layers.js の createGintLayers の戻り）＝installer が読む分 */
export interface GintLayers {
	/** 単一スロットのユーザー層に置く（moveCamera＝bbox へ寄る） */
	applyGintData(pbf: GeoPBF, label: string, moveCamera?: boolean, opts?: { drape?: boolean; [k: string]: unknown }): unknown;
	clearUserGint(): void;
	/** 単一スロットの paint 表の visible ビット（filter）＝fid → 見えるか・表が無ければ null */
	userAccept(): ((fid: number) => boolean) | null;
	hoverTip: ((rows: string[] | null) => void) | null;
	worldTipOn: boolean;
	/** 地球儀の内部層をまとめて伏せる／戻す（検査表示） */
	setInternalHidden(v: boolean): void;
	readonly userGint: { pbf: GeoPBF; label: string; [k: string]: unknown } | null;
}
/** ?g= のフィーチャーサービスの視野追従（geopbf/featureservice の followView の戻り） */
export interface GFollow { destroy(): void }
/** 編集ボタンが開く「今の図形」を預ける口（persist＝"save"｜"keep"｜既定＝見ただけ） */
export type EditDocHook = (pbf: { arrayBuffer: ArrayBuffer } | null, name?: string, persist?: string) => void;
/** map.follow の追従の状態（手綱＝FollowHandle） */
export interface FollowState extends FollowHandle {
	lerp: number; offset: [number, number, number] | undefined; zoom: number | null; bearing: number | undefined; pitch: number | undefined; roll: number | undefined; stopOnGesture: boolean;
}

/** plugin の器（plugin.js の createPluginHost の戻り）＝installer が読む分 */
export interface PluginHost { readonly registry: MapRegistry }

/** 基図の出どころ（globe.js の BASE_SOURCE＝外来 style／PMTiles／地域の基図／無し）＝installer が読む分 */
export interface BaseSource {
	kind: string; url: string | null;
	/** XYZ の型紙（PMTiles は URL を返すだけ・基図なしは null） */
	tileUrl: (z: number, x: number, y: number) => string | null | undefined;
	coverage: unknown;
	info: unknown; attrHTML: string | null;
	encoding?: string;
}
/** 地域の「全体へ戻る」の着地点（地域の申告の home） */
export interface RegionHome { view: number[]; span?: number[]; icon?: string; label?: string; id?: string }
/** 建物メッシュの管理（globe.js の meshMgr＝本物が来るまでの代理の窓口）＝installer が読む分 */
export interface MeshMgr {
	/** データ管理のモーダルを開く（建物 3D の gadget のボタン） */
	openDb(): Promise<unknown>;
	readonly sets: Array<{ base: string; bbox: number[]; [k: string]: unknown }>;
	prefetch(views: unknown[], names?: string[], onProg?: (done: number, total: number, name: string | null) => void): Promise<unknown>;   // onProg＝mesh/manager.js の runPrefetch（焼けた区の数・総数・区の名）
	/** 区ごとの読み込みの進捗 */
	readonly progress: Map<string, { done?: number; scan?: number }>;
	/** これから見える区で読み込み中の物 */
	visibleLoading(): string[];
	/** 残りの台本に出ない常駐区を降ろす */
	trimForScript(views: string[]): unknown;
}
/** 地名検索の供給元（地域の申告の search・search.js の createSearch が引く） */
export interface SearchProvider { query(q: string, signal?: AbortSignal): Promise<unknown>; histKey?: string; [k: string]: unknown }
/** 計測・断面図の本体の手綱（gadgets/measure.ts・profile.ts）＝_update を描画ごとに呼ぶ */
export interface ToolBody { _update?(): void; stop?(): void }   // stop＝道具の排他（globe.js の toolClose）
/** POI 台帳（地域の申告の poi・起こすまでの代理） */
export interface PoiProxy { ready(): Promise<unknown> }
/** POI 台帳の本物（poiedit が読む分） */
export interface PoiLedger { distM: unknown; apiBase: unknown; ovrName: unknown; patchedAll(): unknown; getOvr: unknown; setOvr: unknown }

// ─────────────────────────────────────────────────────────────────────────────────────────────

/** createGlobe の定数・関数（deps） */
export interface GlobeScope {
	EARTH_M: number;
	mapEl: HTMLElement; labelCanvas: HTMLCanvasElement;
	size: DrawSize;
	wPost: WPost;
	ownDestroy: OwnDestroy;
	mapOn: MapOnTable;
	dbgHost: DebugHost;
	t: Translate;
	cam: GlobeCam;
	/** DOM オーバーレイの持ち上げの標高のメモ（"lon,lat" の格子 → m・null＝照会中） */
	elevMemo: Map<string, number | null>;
	/** 1 点の標高（メモ・同期・未着は 0） */
	elevOf(lon: number, lat: number): number;
	/** 1 点の標高（描いている地形と同じ出どころ・着荷を待つ） */
	heightAt(lon: number, lat: number): Promise<number>;
	pluginHost: PluginHost;
	/** quantized-mesh の spec の url を頁基準の絶対へ */
	qmSpecOf<T extends { url?: string | null }>(sp: T): T;
	requestDraw(): void;
	requester: Requester;
	/** terrain:false の地図（DEM が来たら地形を作る） */
	terrLazy: boolean;
	/** 省メモリ端末（lowMem） */
	LOW_MEM: boolean;
	/** 地域パックの画像タイルのカタログ（region.rasters を束ねた物） */
	REGION_RASTERS: RasterCatalogEntry[];
	/** 目盛り "mercator" の画像タイルの z の倍率 */
	TILE_BIAS: number;
	/** この地図が頁の URL（hash・?r=）の持ち主 */
	URL_OWN: boolean;
	/** createGlobe の opts */
	opts: GlobeOptions;
	/** 初フレーム前の画像タイルの指示の待ち行列 */
	rasterBootQ: Array<() => void>;
	CAM_ZOOM_MIN: number; MAXPITCH: number; D2R: number; R2D: number;
	/** アニメの時刻（ms・検定で止められる） */
	animNow(): number;
	/** 共通の時計（@ortho-earth/ephem/clock） */
	clock: Clock;
	flightCtl: FlightController;
	/** 内部の位置引数の飛行（角は度・省略＝今の値） */
	flyTo(lon: number, lat: number, zoom: number, tiltDeg?: number | null, bearingDeg?: number | null): Promise<void>;
	input: InputController;
	/** カメラが動いた（締め・送信・購読者への合図） */
	onMove(): void;
	/** maxPitch の入力（度・1.6 以下のラジアンも）→ ラジアン（null/undefined はそのまま） */
	pitchIn(v: number | null | undefined): number | null | undefined;
	/** 動きを減らす（opts.reduceMotion か prefers-reduced-motion） */
	reduceMotionOn(): boolean;
	renderer: GlobeInternals["renderer"];
	sendLight(): void; sendSky(): void;
	/** 注視点の高さ（centerElevation の流儀）を cam.centerAlt へ */
	syncCenterAlt(): void;
	/** 画面の点（CSS px）→ [lon, lat]（球の外は null） */
	unprojectXY(x: number, y: number): LonLat | null;
	gint: GintLayers;
	/** 頁の hash（この地図が URL の持ち主でなければ ""） */
	pageHash: string;
	remoteUrl: DataReturn["remoteUrl"];
	columnarOn: DataReturn["columnarOn"]; columnarProbe: DataReturn["columnarProbe"]; columnarView: DataReturn["columnarView"];
	IMAGE_KEY: IntakeReturn["IMAGE_KEY"];
	/** 公開の口のズームとエンジンの z の差（zoomScale・ML 形の層を normalizeMLLayer で換算する dz） */
	PUBLIC_DZ: number;
	/** createGlobe の寿命（destroy で abort） */
	ac: AbortController;
	imageAttrs: RasterReturn["imageAttrs"]; rasterChanged: RasterReturn["rasterChanged"];
	/** 模型の制御（gadgets/model.js・遅延 chunk）を起こす */
	modelCtlGet(): Promise<ModelCtl>;
	readGeoData: DataReturn["readGeoData"];
	BASE_SOURCE: BaseSource;
	/** 裸地標高の申告（今は日本だけ） */
	REGION_DTM: DtmDecl | null;
	REGION_HOME: RegionHome | null;
	/** 印刷の出典（i18n の英語キー） */
	REGION_PRINT_ATTR: string[];
	TILE_MINZOOM: number;
	/** 画面のおおよその範囲（球外を含む時も） */
	approxViewBbox(cam: GlobeCam): Bbox;
	/** 今の圏の出典（行の列） */
	attrTextNow(): string[];
	/** 経緯度 → canvas の CSS px（[x, y, 表か]） */
	makeProjector(): (lon: number, lat: number) => [number, number, number];
	meshMgr: MeshMgr; meshOn: boolean;
	poi: PoiProxy | null;
	/** 印刷の撮影（印刷カメラへ振って readPixels） */
	printCapture(o: { zoom: number; cropCss?: unknown }): Promise<unknown>;
	requestSnapshot(): Promise<unknown>;
	setLayer(k: string, on: boolean): void;
	/** 道具の排他（名 → close）・toolOpen＝他の道具を閉じる */
	toolClose: Map<string, () => void>; toolOpen(name: string): void;
	/** 今の視点の #hash */
	viewHash(): string;
	wakeMesh(): Promise<unknown>;
	BASEMAP_MINZOOM: number; ZOOM_MIN: number;
	/** 既定の起動の視点（地域の home・無ければ世界）＝[lon, lat, zoom] */
	HOME_VIEW: number[];
	/** 世界のベクタ（Natural Earth）の帯を出すか */
	WORLD_VT: boolean;
	baseSidNow(): string;
	/** 基図の source の名前なら基図の印の spec（それ以外は undefined） */
	baseSrcSpec(id: string): UserSource | undefined;
	canvas: HTMLCanvasElement;
	clearImages: ImagesReturn["clearImages"];
	evXY: InputController["evXY"];
	/** 視点へ飛ぶ（#hash か解いた視点） */
	flyView(hash: string | ParsedView, opts?: { glide?: boolean; jump?: boolean }): unknown;
	/** 台本の連続ドリー（{ view, travel } の列） */
	glidePathView(entries: Array<string | { view: string | ParsedView; travel?: number }>): unknown;
	applyCamView(v: ParsedView): unknown; applyViewLayers(v: ParsedView): unknown;
	switchTheme(name: string): unknown;
	loadUserFile: IntakeReturn["loadUserFile"];
	mlLayers: Map<string, UserLayerRec>; mlSources: Map<string, UserSource>;
	mlVisible(v: UserLayerRec): boolean;
	remergeBase: StyleReturn["remergeBase"];
	scenes: ScenePlayer;
	/** 自動の建物を伏せる／戻す */
	setAutoBld(hidden: boolean): void;
	/** client 座標 → 経緯度（球外は null） */
	unprojectAt(clientX: number, clientY: number): LonLat | null;
	vtxDescOf(sid: string, sp: UserSource | undefined): Promise<VtxDesc | null>;
	/** addData の組み込みの kind（points／arcs／trips／polygons／paths／columns） */
	BUILTIN_DATA_KINDS: string[];
	/** 楕円体の世界（#43）か */
	ELL_ON: boolean;
	/** 建物 UI の文言（地域の申告） */
	REGION_BLD_LABELS: Record<string, string>;
	gpuBackend: boolean;
	/** worker を立てる（役割の名前つき） */
	hostWorker(role: string): Worker;
	overlays: OverlaysReturn["overlays"];
	/** 今の視点を控える（URL の #hash も） */
	saveView(): void;
	/** ?g= の出所の行（出典の欄） */
	setGSrc(txt: string): void;
	/** 起動の視点（opts.view か頁の #hash）＝在れば ?g= で寄せない */
	themeBootV: ParsedView | null;
	/** 埋め込みの焼き付け（opts.theme） */
	themeFixed: boolean;
	/** 地域の申告の地名検索の供給元（日本＝地理院・null＝無し） */
	REGION_SEARCH: SearchProvider | null;
	/** 建物データ管理ボタンの顔（地域の申告の SVG の文字列・null＝汎用） */
	REGION_BLD_ICON: string | null;
	/** 寄りの上限（opts.zoomMax・1..20） */
	ZOOM_MAX: number;
	/** 外来の DEM（setTerrain）が在ればその標高・無ければ fallback */
	demFirst(lon: number, lat: number, fallback: () => Promise<number>): Promise<number>;
	/** 描画ごとに呼ぶ関数（gadget の追従＝コンパスの針・現在地の印・吹き出し・計測の線） */
	frameHooks: Set<() => void>;
	/** 標高の引き口（ローダの到着で解ける） */
	getHeightP: ReturnType<typeof createGetHeight>;
	/** gadget の登録口（installGadgets の戻り＝後の installer と globe.js が使う） */
	registerGadget: RegisterGadget;
	/** 狭い画面（max-width: 480px）＝gadget の門の narrow */
	narrowMq: MediaQueryList;
	/** 経緯度 → 容れ物の CSS px [x, y, 表か（負＝裏半球）] */
	projectLL(lon: number, lat: number): [number, number, number];
	/** 地域の基図の自動の 3D 建物の層 id（"building-extrusion"） */
	AUTO_BLD: string;
	/** 基図の source の印（baseSrcSpec の戻りに付く） */
	BASE_SRC: symbol;
	DEBUG_GLOBALS: boolean;
	/** MapLibre の口（背景を白に畳まない＝透明） */
	NO_BG_WHITE: boolean;
	/** style.json の層と source の目盛り */
	STYLE_DZ: number;
	assertMLLayer: GlobeLive["assertMLLayer"];
	/** 自動の建物の層（getLayer／getStyle の顔・無ければ null） */
	autoBldLayer(): MLLayer | null;
	autoBldOn(): boolean;
	/** 自動の建物は出し入れだけ（投げる） */
	autoBldReadOnly(what: string): never;
	/** 基図の層の上書き（id → 上書き）・出し入れ（id → "none"） */
	baseOverrides: Map<string, BaseOverride>; baseVis: Map<string, string>;
	/** 床の色を決める background 層（無ければ null） */
	bgOf(st: BaseStyle): MLLayer | null;
	/** 建物の塗りの層の添字（伏せている間は -1） */
	bldFillLi(st: BaseStyle): number;
	/** 層の描く形（正規化済み＝エンジンの目盛り） */
	drawLayerOf(v: UserLayerRec): MLLayer;
	dropFollow: DataReturn["dropFollow"];
	/** sourcedata を鳴らす */
	emitSourceData(sid: string): void;
	/** 外来 style の基図の style */
	extBaseStyle(ext: ExtStyle): BaseStyle;
	/** BASE_SOURCE の中身（setStyle でも同じ形で差し替える） */
	extSourceFields(ext: ExtStyle): Partial<BaseSource>;
	/** vector source（基図の source 名も）か */
	isVecSrc(sid: string): boolean;
	/** 描き方（gint／vtdraw／raster／custom …） */
	kindOf(layer: MLLayer, sp: UserSource | undefined): string;
	landDefault(): number[];
	/** background 層 → 陸の色（RGBA 0..1） */
	landOf(bg: MLLayer | null, dflt: number[]): number[];
	/** 外来 style を読む（transformStyle＝MapLibre 同名） */
	loadExtStyle(spec: string | Record<string, unknown>, transformStyle?: ((previous: Record<string, unknown> | undefined, next: Record<string, unknown>) => Record<string, unknown> | undefined) | null): Promise<ExtStyle>;
	/** 結合の署名（捨てる＝結合し直す） */
	mergeReq: { main: { sig: string; at: number }; base: { sig: string; at: number } };
	mkThemes(st: BaseStyle): Themes;
	/** source → 地物の id → 状態 */
	mlFeatureState: Map<string, Map<number | string, Record<string, unknown>>>;
	/** source → gint の表（id ↔ fid） */
	mlGintData: Map<string, { idToFid?: Map<unknown, number>; fidToId?: Array<number | string | undefined> }>;
	/** fid → MapLibre の id */
	mlIdOf(sid: string, fid: number): number | string | undefined;
	mlPasses: Map<string, MlPass>;
	/** source id → dz */
	mlSourceDz: Map<string, number>;
	mountLayer(v: UserLayerRec): Promise<unknown>;
	/** raster-* の paint → 色の調整（無ければ null） */
	rasterAdjust(P: Record<string, unknown> | undefined): RasterAdjust | null;
	rasterFade(P: Record<string, unknown> | undefined): number | undefined;
	rasterPaintOpts(P: Record<string, unknown> | undefined): Pick<RasterOptions, "resampling" | "fadeDuration">;
	/** 画像タイル層の未着（層 id → 枚数） */
	rasterPend: Map<string, number>;
	rasterSampling(P: Record<string, unknown> | undefined): "nearest" | "linear" | undefined;
	rebuildCluster(sid: string): Promise<unknown>;
	rebuildGint(sidChanged?: string | null, opts?: { dataChanged?: boolean }): Promise<unknown>;
	reliefOpacity(L: MLLayer): number;
	/** 登録順を各描き方の重ね順へ */
	reorderLayers(): void;
	/** 基図の層の添字（外来 style は -1） */
	seaLi(st: BaseStyle, id: string): number;
	seaOf(bg: MLLayer | null): number[] | null;
	/** vector の描く層の差し込む位置を配る（#123） */
	sendUserAnchors(): void;
	/** setData の載せ直し（連打は畳む） */
	setDataLive(id: string): Promise<void>;
	setDataQ: Map<string, unknown>;
	setMapGS(obj: Record<string, unknown>): void;
	setPipelineStyle(st: BaseStyle): void;
	setSrcAttr: DataReturn["setSrcAttr"];
	spriteDrop(id: string): void;
	spriteLoad(id: string, url: string): Promise<unknown>;
	/** sprite の id → その sprite から読んだ記号の名前 */
	spriteNames: Map<string, string[]>;
	/** 層の source id（object の source は層 id） */
	srcId(L: { id: string; source?: unknown }): string;
	srcOf(L: MLLayer): UserSource | undefined;
	unmountLayer(v: UserLayerRec): Promise<void> | void;
	/** 実行時に足した background 層（B5） */
	userBg: MLLayer[];
	vtRaw: RawTileStore;
	/** 利用者の層の口で描く vector の層か（外来 style） */
	vtRouted(L: MLLayer, ms: ExtStyleDoc, baseSid: string | null): boolean;
	/** sid → 解いた記述子（vector の描く層） */
	vtdDesc: Map<string, VtxDesc>;
	/** sid → 記述子を待っている層の数 */
	vtdMounting: Map<string, number>;
	/** vector の描く層の順（下から） */
	vtdOrder(): string[];
	vtxDescs: Map<string, Promise<VtxDesc | null>>;
	/** vector source の feature-state（sid → 鍵 → { id, state }） */
	vtxFS: Map<string, Map<string, { id: unknown; state: Record<string, unknown> }>>;
	vtxFSKey(sourceLayer: string, id: unknown): string;
	/** 問い合わせの地物の state（無ければ {}） */
	vtxStateOf(sid: string, sourceLayer: string | null | undefined, id: unknown): Record<string, unknown>;
	withBaseOverrides(st: BaseStyle): BaseStyle;
	/** PMTiles の基図の層を足す（外来 style＝extBaseStyle） */
	withPM(st: BaseStyle): BaseStyle;
	withUserBg(st: BaseStyle): BaseStyle;
	/** 標高の誇張（実スケール＝1） */
	TERR_EXAG: number;
	clipAllCut: ShadowsReturn["clipAllCut"]; clipCutXY: ShadowsReturn["clipCutXY"]; clipFor: ShadowsReturn["clipFor"];
	/** 今伏せている基図の層の添字 */
	hiddenAll(): Set<number>;
	/** 層の出しズームの内か（maxzoom 排他） */
	inZoomML(L: MLLayer, z: number): boolean;
	isOv: OverlaysReturn["isOv"]; overlayFeature: OverlaysReturn["overlayFeature"];
	/** ?nor01=1（混成窓を切る） */
	noMixedR01: boolean;
	/** 層 id → 模様・線の飾り */
	patItems: Map<string, PatItem>;
	/** gint の内部の鍵を外した properties */
	stripMl(p: Record<string, unknown> | null | undefined): Record<string, unknown>;
	/** 地面の半径（単位球＝1・地形の持ち上げ込み） */
	vtxGround(lon: number, lat: number): number;
}
/** map.raster の色の調整（raster-hue-rotate 等） */
export type RasterAdjust = NonNullable<Extract<RasterSpec, { url: string }>["adjust"]>;

/** createGlobe の let（live） */
export interface GlobeLive {
	mlSources: Map<string, UserSource>;
	EXT: ExtStyle | null;
	demSpec: TerrainSpec | null;
	demMain: DemSource | null;
	geGen: number; geBusy: boolean; geKey: string;
	elevGen: number;
	noTerr: boolean;
	style: BaseStyle;
	baseSidNow: () => string;
	modelCtl: ModelCtl | null;
	/** 出典の圏（"region"｜"world"｜"sky"・null＝次の描画で決め直す） */
	attrZone: string | null;
	/** 四隅の動画・canvas（遅延 chunk・使うまで null） */
	videoCtl: VideoQuads | null;
	/** IIIF の基準点の注記を読む（geopbf/georef・遅延） */
	iiifOpen(src: string | object, attribution?: string | null): Promise<{ maps: unknown[]; attribution: string | null; fallback: string | null }>;
	/** 画像タイルの指示（初フレーム前は待ち行列へ・後は即） */
	rasterBoot: (fn: () => void) => void;
	maxPitchCur: number; zoomMinCur: number; zoomMaxCur: number; minPitchCur: number;
	camPadding: PaddingOptions;
	/** setCameraUpdate の関数（null＝無し） */
	camUpdateFn: Parameters<GlobeMap["setCameraUpdate"]>[0];
	/** 注視点の固定の高さ（m・null＝未指定）・流儀（"ground"＝地面・数＝固定・undefined＝既定） */
	centerElevFixed: number | null; centerElevMode: "ground" | number | undefined;
	/** setMaxBounds の可動域 */
	camBounds: Bbox | null;
	dpr: number;
	czmlCtl: CzmlCtl | null;
	followSt: FollowState | null;
	/** 飛行中 */
	flying: boolean;
	/** style の light（正規化済み）・sky（正規化済み） */
	mlLight: Required<LightSpecification> | null; mlSky: Required<SkySpecification> | null;
	/** 起動の URL の t=／s=（CZML の clock より URL が勝つ＝最初の 1 回だけ） */
	czmlUrlClock: boolean;
	annoCtl: AnnoHandle | null;
	gFollow: GFollow | null;
	editDocHook: EditDocHook | null;
	rasterDropFile: ToolsReturn["rasterDropFile"];
	placeImages: ImagesReturn["placeImages"]; clearImages: ImagesReturn["clearImages"]; autoExtrude: ImagesReturn["autoExtrude"];
	loadUserFile: IntakeReturn["loadUserFile"];
	/** 四隅で貼った画像の id と四隅（queryRenderedFeatures の画像層） */
	imageIds: string[]; imageQuads: Array<{ id: string; corners: Corners | null; properties: Record<string, unknown> }>;
	aggCtl: Aggregate | null; gjCtl: GJLabels | null; symCtl: Symbols | null;
	/** 地図の global-state（setGlobalStateProperty・style の state） */
	MAP_GS: Record<string, unknown>;
	/** 知らない演算子を含む層は投げる（MapLibre と同じ）＝createGlobe で installImages より後に宣言される */
	assertMLLayer(L: Partial<MLLayer>, where: string): void;
	/** 切断（setClipping）＝対象ごとの面・公開面の写し・main 側の面（vector＝識別と問い合わせ） */
	clipByT: Record<string, ClipPlane[] | null> | null; clipSpec: ClipOptions | ClipOptions[] | null; clipMain: ClipPlane[] | null;
	/** 初描画で確定（"webgpu"／"webgl2"） */
	renderBackend: "webgpu" | "webgl2" | null;
	/** 計測・断面図の経路指定の間だけ＝クリックの横取り（null＝していない） */
	measureClick: ((x: number, y: number) => unknown) | null; profileClick: ((x: number, y: number) => unknown) | null;
	/** 計測・断面図の本体（遅延 chunk・着いたら）＝_update を描画ごとに */
	measureBody: ToolBody | null; profileBody: ToolBody | null;
	mapLoaded: boolean;
	addSourceAt: StyleReturn["addSourceAt"]; addLayerAt: StyleReturn["addLayerAt"];
	poiReal: PoiLedger | null;
	/** POI 台帳編集の armed 中だけ（クリックの横取り） */
	poiClick: ((x: number, y: number) => unknown) | null;
	/** 直近フレームで描いた基図タイル */
	lastTileOrder: Array<{ key: string; z: number }>;
	vtdCtl: VtdCtl | null;
	/** 検査表示の下地（伏せている間）・テーマを替えた後の掛け直し */
	inspectHide: boolean; inspectReapply: () => void;
	autoBldHidden: boolean;
	/** 陸の色（RGBA 0..1） */
	land: number[];
	cogCtl: CogHandle | null;
	columnarCtl: ColumnarLayerHandle | null;
	/** 編集ガジェットがドロップを所有中 */
	editDropOwner: boolean;
	/** 基図の描き終わりの署名（readySig が mainDesired に追いつく＝穴なし） */
	readySig: string; mainDesired: string;
	/** 標高タイルの読込中・枚数 */
	elevBusy: boolean; elevN: number;
	mapEl: HTMLElement;
	themeName: string;
	/** 出典の欄の source ごとの行（消毒済み HTML） */
	vtxAttrs: Map<string, string>;
	remountSource: StyleReturn["remountSource"];
	/** custom 層の onAdd/render に渡す map（null＝この map） */
	customHost: object | null;
	customCtl: CustomCtl | null;
	/** 自動の建物を removeLayer した */
	autoBldRemoved: boolean;
	/** 床の色の background 層 */
	bg: MLLayer | null;
	/** setSprite 等の後の sprite の一覧・glyphs */
	spriteList: SpriteEntry[] | null; mlGlyphs: string | null;
	themes: Themes;
	/** 基図の結合の署名 */
	baseSig: string;
	vtdQueryCache: QueryReturn["vtdQueryCache"];
	vtxCtl: VtxCtl | null;
	/** 今のテーマ（style＝地域の基図の style） */
	theme: { style: BaseStyle };
	t3dCtl: T3dCtl | null;
}
