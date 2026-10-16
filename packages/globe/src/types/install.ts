// installer（src/api/*.ts）が受ける型（TS 化 段 4・batch 1・2026-10-16）。globe.js（まだ JS＝batch 3）が渡す map・live・deps の形をここに置く
//（globe.js の sibling d.ts は作らない）。deps の中身は globe.js の createGlobe の中の定数・関数＝ここでは installer が読む分だけを構造で書く。
//
// 型の作法（installer の map）：
//   installX(map: Installing<XApi>, live: XLive, deps: XDeps)
//   Installing<XApi>＝組み上がった後の GlobeMap のうち XApi の口だけ書ける物（readonly を外す）。installer が付けた関数が呼ばれるのは createGlobe が返った後＝
//   その時には全部の installer が済んでいる＝他の installer の口（map.raster・map.on…）を読めてよい。公開の型に出さない内部のメンバー（GlobeInternals）を
//   書く installer は第 2 引数でその名を挙げる（例：camera の __clouds）。これで installer が書けるのは自分の interface の口だけになる（他の口へ代入すると型の誤り）。
//   限界：install の最中に（関数の外で）まだ付いていない口を読む誤りは咎められない＝順は globe.js（batch 3 で globe.ts）の呼ぶ順が正本。
import type { GlobeInternals, GlobeMap, RegisterGadget, StyleApi } from "./map.ts";
import type { DrawSize, GlobeCam, GlobeLive, GlobeScope, InlineSourceLayer, ModelCtl, UserLayerRec, UserSource, WPost } from "./scope.ts";
import type { ClipPlane } from "@ortho-earth/core/clip";
import type { MLLayer, queryTiles } from "@ortho-earth/core";
import type { CameraState } from "@ortho-earth/core/camera";
import type { Aggregate, ClusterOpts } from "../gadgets/aggregate.ts";
import type { GJLabels } from "../gadgets/gjlabels.ts";
import type { Symbols } from "../gadgets/symbols.ts";
import type { FeatureCollection, GeoPBF } from "geopbf";
import type { ScenePlayer } from "../scenes/player.d.ts";
import type { ViewFollow } from "../featureservice.d.ts";
import type { ColumnarLayerHandle, ColumnarLayerOptions, LonLat, OverlayHandle, OverlayPick, RasterInfo } from "../../globe.d.ts";

/** readonly を外す（installer は自分の口を map に書く） */
export type Writable<T> = { -readonly [K in keyof T]: T[K] };
/** installer の中から見た map（上の説明）。Own＝この installer が付ける口・Internal＝この installer が書く内部のメンバー */
export type Installing<Own extends object, Internal extends keyof GlobeInternals = never> =
	Omit<GlobeMap, keyof Own> & Writable<Own> & Writable<Pick<GlobeInternals, Internal>>;
/** globe.js が組み立てる map（batch 3 で globe.ts になった時の受け皿）＝全部の口が書ける・内部のメンバーも書ける。どの Installing<X> にもそのまま渡せる */
export type GlobeMapBuilding = Writable<GlobeMap> & Partial<Writable<GlobeInternals>>;

/** 同一フレームのオーバーレイの worker の pick の 1 件（map.pickOverlays の答え・q／index は module の自由） */
export type OverlayHit = OverlayPick & { q?: unknown; index?: unknown };
/** オーバーレイの答えを queryRenderedFeatures の形にした物（api/overlays.ts の overlayFeature） */
export interface OverlayFeature {
	type: "Feature"; id: number | string | null; geometry: { type: "Point"; coordinates: LonLat } | null; properties: Record<string, unknown>;
	layer: { id: string; type: "overlay" }; source: string; overlay: { name: string; distance: number | undefined; q: unknown; index: unknown };
}
/** worker の撮影の答え（snapshot）のオーバーレイ画素＝名前付き */
export interface SnapOverlay { name: string; [k: string]: unknown }
/** worker の撮影の答え（globe.js の onmessage の d・type "snapshot"） */
export interface SnapFrame { overlays?: SnapOverlay[]; [k: string]: unknown }

// ─────────────────────────────────────────────────────────────────────────────────────────────
// installer ごとの live（createGlobe の変数を読み書きする口）・deps（createGlobe の定数と関数）・戻り値
// ─────────────────────────────────────────────────────────────────────────────────────────────

export type OverlaysDeps = Pick<GlobeScope, "mapEl" | "labelCanvas" | "size" | "wPost">;
export interface OverlaysReturn {
	overlays: Map<string, OverlayHandle>;
	isOv(name: string): boolean;
	pickWait: Map<number, (hits: OverlayHit[]) => void>;
	orderSnapOverlays(d: SnapFrame): SnapFrame & { overlays: SnapOverlay[]; overlaysAbove: SnapOverlay[] };
	overlayFeature(h: OverlayHit): OverlayFeature;
}

/** installer の live＝RW は読み書き（getter と setter）・RO は読むだけ（getter） */
type LiveOf<RW extends keyof GlobeLive, RO extends keyof GlobeLive = never> = Pick<GlobeLive, RW> & Readonly<Pick<GlobeLive, RO>>;

export type TerrainLive = LiveOf<"demSpec" | "demMain" | "geGen" | "geBusy" | "geKey" | "elevGen" | "noTerr", "mlSources" | "EXT" | "style" | "baseSidNow" | "modelCtl">;
export type TerrainDeps = Pick<GlobeScope, "EARTH_M" | "cam" | "elevMemo" | "elevOf" | "heightAt" | "pluginHost" | "qmSpecOf" | "requestDraw" | "requester" | "terrLazy" | "wPost">;

export type RasterLive = LiveOf<"attrZone" | "videoCtl" | "rasterBoot", "iiifOpen">;
export type RasterDeps = Pick<GlobeScope, "LOW_MEM" | "REGION_RASTERS" | "TILE_BIAS" | "URL_OWN" | "opts" | "ownDestroy" | "rasterBootQ" | "requestDraw" | "requester" | "t" | "wPost">;
/** worker が返す画像タイルのソースの自己申告（rasterInfo）＝RasterInfo に出典・名前の生の値 */
export type RasterInfoMsg = RasterInfo & { attribution?: string | null; name?: string | null };
export interface RasterReturn {
	onRasterInfo(id: string, info: RasterInfoMsg): void;
	onRasterError(id: string, error: string): void;
	rasterStatWait: Map<number, (stats: Record<string, unknown> | null) => void>;
	rasterAttrHTML(): string;
	imageAttrs: Map<string, string>;
	rasterChanged(): void;
	/** 独自の読み口（addProtocol）が type:"image" に返す物→ImageBitmap */
	protocolBitmap(d: unknown): Promise<ImageBitmap | null>;
}

export type CameraLive = LiveOf<"maxPitchCur" | "zoomMinCur" | "camPadding" | "centerElevFixed" | "centerElevMode" | "followSt" | "mlLight" | "mlSky",
	"zoomMaxCur" | "camUpdateFn" | "minPitchCur" | "camBounds" | "dpr" | "czmlCtl" | "flying">;
export type CameraDeps = Pick<GlobeScope, "CAM_ZOOM_MIN" | "D2R" | "EARTH_M" | "MAXPITCH" | "R2D" | "animNow" | "cam" | "clock" | "flightCtl" | "flyTo" | "input" | "mapOn" | "onMove" | "opts" | "ownDestroy" | "pitchIn" | "pluginHost"
	| "reduceMotionOn" | "renderer" | "requestDraw" | "sendLight" | "sendSky" | "size" | "syncCenterAlt" | "unprojectXY" | "wPost">;
export interface CameraReturn {
	/** 毎移動の締め（setConstrain・setCameraUpdate・maxZoom・minPitch・maxBounds） */
	clampCamLimits(): void;
	/** follow の 1 歩（毎フレーム） */
	tickFollow(first?: boolean): void;
}

export type IntakeLive = LiveOf<"czmlCtl" | "czmlUrlClock" | "gFollow", "annoCtl" | "rasterDropFile" | "editDocHook" | "placeImages" | "clearImages" | "autoExtrude">;
export type IntakeDeps = Pick<GlobeScope, "D2R" | "cam" | "columnarOn" | "columnarProbe" | "columnarView" | "dbgHost" | "flyTo" | "gint" | "pageHash" | "remoteUrl" | "requester" | "size">;
/** 取り込みの文脈（D&D の落とした地点・glb の向きと尺・gint:true＝列チャンク層を使わない・fit・persist） */
export interface IntakeCtx { fit?: boolean; persist?: string; at?: LonLat; heading?: number; scale?: number; gint?: boolean }
/** 取り込みの答え＝トーストが使う { length }（GeoPBF も length を持つ）・載せなかった＝null */
export type IntakeResult = { length?: number | string } | null | false;
export interface IntakeReturn {
	/** ファイル取り込みの一本道（D&D と ?g= の共用） */
	loadUserFile(file: File, ctx?: IntakeCtx): Promise<IntakeResult>;
	/** 四隅で貼る画像の属性の鍵（geopbf/edit/imagequad と同じ "@image"） */
	IMAGE_KEY: string;
}

export type DataLive = LiveOf<"attrZone" | "gFollow" | "columnarCtl", "mapEl" | "themeName" | "elevBusy" | "vtxAttrs" | "remountSource" | "annoCtl" | "czmlCtl" | "editDocHook" | "loadUserFile">;
export type DataDeps = Pick<GlobeScope, "BUILTIN_DATA_KINDS" | "CAM_ZOOM_MIN" | "ELL_ON" | "LOW_MEM" | "REGION_BLD_LABELS" | "ac" | "applyCamView" | "applyViewLayers" | "cam" | "canvas" | "dbgHost"
	| "flightCtl" | "flyView" | "gint" | "gpuBackend" | "hostWorker" | "meshMgr" | "meshOn" | "onMove" | "opts" | "overlays" | "ownDestroy" | "pluginHost" | "requestDraw" | "requester" | "saveView"
	| "setGSrc" | "switchTheme" | "themeBootV" | "themeFixed" | "viewHash">;
/** 視野追従の source の 1 件 */
export interface FsFollowEntry { url: string; fc: FeatureCollection | null; follow: ViewFollow | null }
export interface DataReturn {
	scenes: ScenePlayer;
	/** 出典の欄の source の行（null＝外す） */
	setSrcAttr(sid: string, html: string | null): void;
	/** fill/line/circle の層の data（サービスで件数が多い＝視野追従） */
	sourceData(sid: string, d: unknown, sp?: UserSource): Promise<unknown>;
	dropFollow(sid: string): void;
	/** 視野追従の source（sid → { url, fc, follow }） */
	fsFollow: Map<string, FsFollowEntry>;
	/** 外部 URL の門（?g= / ?scene= 共用）：gh: 短縮形→GitHub raw・https 限定（開発時のみ localhost の http）。通らなければ null */
	remoteUrl(spec: string, tag: string): URL | null;
	/** 大きさ（バイト）が列チャンク層の門を越えるか（?columnar=1|0 が勝つ） */
	columnarOn(bytes: number): boolean;
	/** 点・面の読み口（URL＝サービスなら丸ごと・文字列／Blob＝geopbf で読む・他はそのまま） */
	readGeoData<T>(d: string | Blob | T): Promise<FeatureCollection | T | undefined>;
	/** 列チャンク層の振り分け（opts.columnarRule・既定＝弧の共有が多い塗り分けは gint） */
	columnarProbe(bytes: number): (meta: ColumnarLayerHandle["meta"]) => boolean;
	/** 列チャンク層で見せる（probe が断れば null＝呼び手が gint の道へ） */
	columnarView(src: string | File | Blob | ArrayBuffer | GeoPBF, name: string, o?: ColumnarLayerOptions): Promise<{ length: number; columnar: ColumnarLayerHandle } | null>;
}
export type ImagesLive = LiveOf<"imageIds" | "imageQuads" | "aggCtl" | "gjCtl" | "symCtl", "modelCtl" | "assertMLLayer" | "dpr" | "MAP_GS">;
export type ImagesDeps = Pick<GlobeScope, "registerGadget" | "IMAGE_KEY" | "LOW_MEM" | "PUBLIC_DZ" | "ac" | "cam" | "imageAttrs" | "mapOn" | "modelCtlGet" | "ownDestroy" | "rasterChanged" | "readGeoData" | "requestDraw" | "size" | "wPost">;
export interface ImagesReturn {
	/** 四隅で貼った画像（@image つき 4 頂点の面）を画像の覆いへ・残りの図形を返す（無ければ null） */
	placeImages(pbf: GeoPBF, name: string): Promise<GeoPBF | null>;
	clearImages(): void;
	/** 高さの列を持つ面＝自動で 3D 押し出し（前の押し出しは外す） */
	autoExtrude(pbf: GeoPBF): ReturnType<ModelCtl["extrude"]> | Promise<null>;
	/** styleimagemissing を鳴らす（名前ごとに 1 回） */
	imageMissing(name: string): void;
	symGet(): Promise<Symbols>;
	/** 点の読み口（GeoJSON/GeoPBF/File/URL） */
	readPoints(src: unknown): Promise<unknown>;
	/** 中身（native）＝層は正規化済み（エンジンの目盛り） */
	clusterNative(src: unknown, opts: ClusterOpts, slot: string): Promise<{ points: number; clusters: number[] }>;
	aggGet(): Promise<Aggregate>;
	/** 足している途中の画像（層を載せる前に待つ） */
	pendingImages: Set<Promise<unknown>>;
	heatmapNative(src: unknown, layer: Partial<MLLayer>, slot: string): Promise<{ points: number }>;
	/** symbol-placement が line／line-center の層か */
	gjIsLine(layer: Partial<MLLayer>): boolean;
	gjGet(): Promise<GJLabels>;
	symbolsNative(src: unknown, layer?: Partial<MLLayer>): Promise<{ features: number } | null>;
}
export type GadgetsLive = LiveOf<"measureClick" | "measureBody" | "profileClick" | "profileBody", "mapEl" | "themeName" | "zoomMinCur" | "renderBackend">;
export type GadgetsDeps = Pick<GlobeScope, "REGION_BLD_ICON" | "REGION_BLD_LABELS" | "REGION_SEARCH" | "ZOOM_MAX" | "ac" | "cam" | "demFirst" | "flightCtl" | "frameHooks" | "getHeightP"
	| "makeProjector" | "meshMgr" | "meshOn" | "narrowMq" | "onMove" | "projectLL" | "requestDraw" | "requestSnapshot" | "saveView" | "size" | "switchTheme" | "themeFixed" | "toolClose"
	| "toolOpen" | "unprojectAt" | "unprojectXY">;
export interface GadgetsReturn {
	/** gadget の登録口（registerGadget(name, (map, ...args) => handle)）＝後の installer（shadows・images・tools）と globe.js が使う */
	registerGadget: RegisterGadget;
}
export type ShadowsLive = LiveOf<"clipByT" | "clipSpec" | "clipMain" | "poiClick", "renderBackend" | "mapLoaded" | "addSourceAt" | "addLayerAt" | "noTerr" | "EXT" | "poiReal">;
export type ShadowsDeps = Pick<GlobeScope, "registerGadget" | "BASE_SOURCE" | "D2R" | "LOW_MEM" | "REGION_DTM" | "REGION_HOME" | "REGION_PRINT_ATTR" | "TILE_MINZOOM" | "ac" | "approxViewBbox" | "attrTextNow" | "cam"
	| "dbgHost" | "makeProjector" | "mapOn" | "meshMgr" | "meshOn" | "onMove" | "ownDestroy" | "poi" | "printCapture" | "renderer" | "requestDraw" | "requestSnapshot" | "setLayer" | "t"
	| "toolClose" | "toolOpen" | "unprojectXY" | "viewHash" | "wPost" | "wakeMesh">;
export interface ShadowsReturn {
	/** 地形の升目の照会（elevGrid）の待ち＝render worker の答えで解く */
	elevGridWait: Map<number, (grid: unknown) => void>;
	/** 対象ごとの切断の面（無ければ null） */
	clipFor(t: string): ClipPlane[] | null;
	/** 画素 (x, y)（CSS px）の地面が切られた側か */
	clipCutXY(x: number, y: number): boolean;
	/** 地物の形が全部切られた側か */
	clipAllCut(g: { type: string; coordinates?: unknown; geometries?: ReadonlyArray<{ type?: string; coordinates?: unknown }> } | null | undefined, hM?: number, pl?: ClipPlane[] | null): boolean;
}

export type ToolsLive = LiveOf<"inspectHide" | "inspectReapply" | "gFollow" | "columnarCtl" | "editDocHook" | "editDropOwner",
	"lastTileOrder" | "vtdCtl" | "EXT" | "autoBldHidden" | "land" | "annoCtl" | "cogCtl" | "czmlCtl" | "modelCtl" | "readySig" | "mainDesired" | "elevBusy" | "elevN">;
export type ToolsDeps = Pick<GlobeScope, "registerGadget" | "BASEMAP_MINZOOM" | "BASE_SOURCE" | "CAM_ZOOM_MIN" | "HOME_VIEW" | "REGION_HOME" | "WORLD_VT" | "ZOOM_MIN" | "ac" | "baseSidNow" | "baseSrcSpec" | "cam"
	| "canvas" | "clearImages" | "evXY" | "flightCtl" | "flyTo" | "flyView" | "gint" | "glidePathView" | "loadUserFile" | "meshMgr" | "mlLayers" | "mlSources" | "mlVisible" | "opts"
	| "remergeBase" | "renderer" | "requestDraw" | "requester" | "scenes" | "setAutoBld" | "size" | "t" | "unprojectAt" | "vtxDescOf">;

export type StyleLive = LiveOf<"customHost" | "EXT" | "style" | "autoBldRemoved" | "bg" | "land" | "spriteList" | "mlGlyphs" | "mlLight" | "mlSky" | "themes" | "readySig" | "baseSig" | "attrZone",
	"customCtl" | "videoCtl" | "aggCtl" | "vtdQueryCache" | "MAP_GS" | "vtxCtl" | "vtdCtl" | "autoBldHidden" | "theme" | "inspectReapply" | "dpr">;
export type StyleDeps = Pick<GlobeScope, "AUTO_BLD" | "BASE_SOURCE" | "BASE_SRC" | "DEBUG_GLOBALS" | "NO_BG_WHITE" | "PUBLIC_DZ" | "R2D" | "STYLE_DZ" | "animNow" | "assertMLLayer" | "autoBldLayer" | "autoBldOn"
	| "autoBldReadOnly" | "baseOverrides" | "baseSidNow" | "baseSrcSpec" | "baseVis" | "bgOf" | "bldFillLi" | "cam" | "dbgHost" | "drawLayerOf" | "dropFollow" | "emitSourceData" | "extBaseStyle"
	| "extSourceFields" | "isVecSrc" | "kindOf" | "landDefault" | "landOf" | "loadExtStyle" | "mergeReq" | "mkThemes" | "mlFeatureState" | "mlGintData" | "mlIdOf" | "mlLayers" | "mlPasses"
	| "mlSourceDz" | "mlSources" | "mlVisible" | "mountLayer" | "onMove" | "rasterAdjust" | "rasterFade" | "rasterPaintOpts" | "rasterPend" | "rasterSampling" | "rebuildCluster"
	| "rebuildGint" | "reliefOpacity" | "renderer" | "reorderLayers" | "requestDraw" | "requester" | "seaLi" | "seaOf" | "sendLight" | "sendSky" | "sendUserAnchors" | "setAutoBld"
	| "setDataLive" | "setDataQ" | "setMapGS" | "setPipelineStyle" | "setSrcAttr" | "size" | "spriteDrop" | "spriteLoad" | "spriteNames" | "srcId" | "srcOf" | "unmountLayer" | "userBg" | "vtRaw"
	| "vtRouted" | "vtdDesc" | "vtdMounting" | "vtdOrder" | "vtxDescs" | "vtxFS" | "vtxFSKey" | "vtxStateOf" | "wPost" | "withBaseOverrides" | "withPM" | "withUserBg">;
/** 外来 style の基図以外の層の控え（画像層・利用者の層・source・settle の購読の解除・振り分けの途中） */
export interface ExtExtras { raster: string[]; layers: string[]; sources: string[]; offs: Array<() => void>; mounting: number }
/** 全部の層の順の 1 件（基図の style の層｜利用者の層｜その他の層｜自動の建物） */
export interface StyleOrderEntry { id: string; base?: MLLayer; v?: UserLayerRec; other?: MLLayer; auto?: boolean }
export interface StyleReturn {
	extExtras: ExtExtras;
	/** MapLibre の style の順（getStyle と #123 の差し込みが共有） */
	styleOrder(): StyleOrderEntry[];
	/** この source を使う層を載せ直す（setData・視野追従の読み足し） */
	remountSource(id: string, dataChanged?: boolean): Promise<void>;
	/** 基図を結合し直す（利用者の層の出し入れ・検査表示） */
	remergeBase(): void;
	/** addSource の中身（dz＝この source の層のズームの目盛り・内部は 0 を明示）。spec＝addSource の spec か style.json の source */
	addSourceAt(id: string, spec: UserSource, dz: number): GlobeMap;
	/** addLayer の中身（dz を明示）。層＝addLayer の層か style.json の層（source に object も＝その id で source を足す） */
	addLayerAt(layer: MLLayer | InlineSourceLayer, beforeId: string | null | undefined, dz: number): ReturnType<StyleApi["addLayer"]>;
}
export type QueryLive = LiveOf<never, "MAP_GS" | "aggCtl" | "clipMain" | "demSpec" | "dpr" | "imageQuads" | "lastTileOrder" | "modelCtl" | "noTerr" | "style" | "symCtl" | "t3dCtl" | "vtdCtl" | "vtxCtl">;
export type QueryDeps = Pick<GlobeScope, "BASE_SOURCE" | "D2R" | "EARTH_M" | "ELL_ON" | "IMAGE_KEY" | "PUBLIC_DZ" | "R2D" | "REGION_DTM" | "TERR_EXAG" | "ac" | "baseSidNow" | "cam" | "canvas" | "clipAllCut"
	| "clipCutXY" | "clipFor" | "drawLayerOf" | "evXY" | "gint" | "hiddenAll" | "inZoomML" | "input" | "isOv" | "mlIdOf" | "mlLayers" | "mlPasses" | "mlVisible" | "noMixedR01" | "overlayFeature"
	| "patItems" | "requester" | "size" | "srcId" | "stripMl" | "unprojectXY" | "vtdDesc" | "vtdOrder" | "vtxGround" | "vtxStateOf">;
/** 押し出しの当たりの口（extrude-ml.js の env）＝地面 gnd の上の画面の点・屋根の面 */
export interface ExtEnv {
	vtx(lon: number, lat: number, hM: number): [number, number, number] | null;
	roof(x: number, y: number, hM: number, lon0: number, lat0: number): { ll: LonLat; w: number } | null;
}
/** 今の視点の当たりの口（extView の戻り） */
export interface ExtViewNow {
	st: CameraState; W: number; H: number; k: number; f: number;
	pos(u: ArrayLike<number>, m: ArrayLike<number> | null, R: number): ArrayLike<number>;
	clipOf(p: ArrayLike<number>): [number, number, number];
	envOf(gnd: (lon: number, lat: number) => number): ExtEnv;
}
/** 模型・3D Tiles の当たりの環境（meshPickEnv の戻り） */
export interface MeshPickEnv {
	view: { mvp: Float64Array; W: number; H: number; eye: ArrayLike<number> };
	show3d: boolean;
	/** 束の中心 → 持ち上げ（世界単位） */
	lift(o: ArrayLike<number>, mode?: string): number;
}
export interface QueryReturn {
	extView(): ExtViewNow;
	meshPickEnv(): MeshPickEnv;
	/** "sid|source-layer の組" → "z/x/y" → 解読済みタイル（vector source の描く層） */
	vtdQueryCache: Map<string, NonNullable<Parameters<typeof queryTiles>[0]["cache"]>>;
}
export interface ToolsReturn {
	/** ローカル容器（.gpkg/.mbtiles）の画像タイル＝"drop" 層（fallback＝タイル表が無ければ false） */
	rasterDropFile(file: File, fallback?: boolean): Promise<{ length: string } | false>;
}
