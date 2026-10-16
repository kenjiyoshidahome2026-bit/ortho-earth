// createGlobe の中の物（globe.js・まだ JS＝batch 3）を installer（src/api/*.ts）が受ける時の型（TS 化 段 4・batch 1・2026-10-16）。
//   GlobeScope＝createGlobe の定数・関数（deps として渡す）・GlobeLive＝createGlobe の let（live の getter／setter で読み書きする）。
//   どちらも installer が読む分だけを構造で書く（globe.js が持つ他のメンバーは書かない）。installer ごとの deps／live は install.ts が Pick で選ぶ。
//   batch 3（globe.js → globe.ts）ではここが createGlobe の中の変数の注釈の元になる。
import type { resolveVectorSource, splitMapLibreStyle } from "@ortho-earth/core";
import type { DemSource } from "@ortho-earth/core";
import type { FlightController, InputController } from "@ortho-earth/core";
import type { CameraPose } from "@ortho-earth/core/camera";
import type { Clock } from "@ortho-earth/ephem/clock";
import type { AnnoHandle, Bbox, CameraTarget, FollowHandle, GlobeOptions, LightSpecification, LonLat, MapRegistry, PaddingOptions, RasterCatalogEntry, SkySpecification, TerrainSourceSpec } from "../../globe.d.ts";
import type { GeoPBF } from "geopbf";
import type { CzmlPlayer } from "../gadgets/czml.d.ts";
import type { DataReturn, ImagesReturn, IntakeReturn, ToolsReturn } from "./install.ts";
import type { GlobeInternals, GlobeMap } from "./map.ts";
import type { VideoQuads } from "../gadgets/videoquad.d.ts";
import type { Requester } from "../request.d.ts";

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
/** 外来の MapLibre の style.json（core の MLStyle） */
export type MLStyleSpec = Parameters<typeof splitMapLibreStyle>[0];
/** 外来 style を読んだ物（globe.js の loadExtStyle の戻り＝EXT） */
export interface ExtStyle {
	ms: MLStyleSpec; split: ReturnType<typeof splitMapLibreStyle>; src: Awaited<ReturnType<typeof resolveVectorSource>> | null;
	baseUrl: string | undefined; url: string | null;
}
/** 地形の DEM の spec（setTerrain・style の terrain・?dem=）＝raster-dem か quantized-mesh。中身は core の createDemSource が整える */
export type TerrainSpec = TerrainSourceSpec;

/** globe の cam（core の CameraPose を常に全部埋めた物＋globe が足す物）＝map.cam と同じ物 */
export interface GlobeCam extends CameraPose { pitch: number; bearing: number; roll: number; dpr: number; centerAlt?: number }

/** 基図の style（themes.js の theme.style・外来 style は extBaseStyle）＝installer が読む分 */
export interface BaseStyle {
	layers: Array<{ id: string; type: string; [k: string]: unknown }>;
	schema?: { buildings?: { layer: string; heightByCode?: Record<string, number>; codeKey: string; defaultHeight?: number } | null } | null;
	ext?: boolean;
	globalState?: Record<string, unknown>;
	[k: string]: unknown;
}

/** 模型の制御（gadgets/model.js の createModels の戻り）＝installer が読む分 */
export interface ModelCtl {
	extrudedFeatures?: Array<{ h: number; f?: { geometry?: { type: string; coordinates?: unknown } | null } | null }>;
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
}

/** createGlobe の let（live） */
export interface GlobeLive {
	mlSources: Map<string, MLSourceSpec>;
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
}
