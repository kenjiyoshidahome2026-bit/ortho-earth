// installer（src/api/*.ts）が受ける型（TS 化 段 4・batch 1・2026-10-16）。globe.js（まだ JS＝batch 3）が渡す map・live・deps の形をここに置く
//（globe.js の sibling d.ts は作らない）。deps の中身は globe.js の createGlobe の中の定数・関数＝ここでは installer が読む分だけを構造で書く。
//
// 型の作法（installer の map）：
//   installX(map: Installing<XApi>, live: XLive, deps: XDeps)
//   Installing<XApi>＝組み上がった後の GlobeMap のうち XApi の口だけ書ける物（readonly を外す）。installer が付けた関数が呼ばれるのは createGlobe が返った後＝
//   その時には全部の installer が済んでいる＝他の installer の口（map.raster・map.on…）を読めてよい。公開の型に出さない内部のメンバー（GlobeInternals）を
//   書く installer は第 2 引数でその名を挙げる（例：camera の __clouds）。これで installer が書けるのは自分の interface の口だけになる（他の口へ代入すると型の誤り）。
//   限界：install の最中に（関数の外で）まだ付いていない口を読む誤りは咎められない＝順は globe.js（batch 3 で globe.ts）の呼ぶ順が正本。
import type { GlobeInternals, GlobeMap } from "./map.ts";
import type { DrawSize, GlobeLive, GlobeScope, WPost } from "./scope.ts";
import type { GeoPBF } from "geopbf";
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

export interface DataReturn {
	/** 外部 URL の門（?g= / ?scene= 共用）：gh: 短縮形→GitHub raw・https 限定（開発時のみ localhost の http）。通らなければ null */
	remoteUrl(spec: string, tag: string): URL | null;
	/** 大きさ（バイト）が列チャンク層の門を越えるか（?columnar=1|0 が勝つ） */
	columnarOn(bytes: number): boolean;
	/** 列チャンク層の振り分け（opts.columnarRule・既定＝弧の共有が多い塗り分けは gint） */
	columnarProbe(bytes: number): (meta: ColumnarLayerHandle["meta"]) => boolean;
	/** 列チャンク層で見せる（probe が断れば null＝呼び手が gint の道へ） */
	columnarView(src: string | File | Blob | ArrayBuffer | GeoPBF, name: string, o?: ColumnarLayerOptions): Promise<{ length: number; columnar: ColumnarLayerHandle } | null>;
}
export interface ImagesReturn {
	/** 四隅で貼った画像（@image つき 4 頂点の面）を画像の覆いへ・残りの図形を返す（無ければ null） */
	placeImages(pbf: GeoPBF, name: string): Promise<GeoPBF | null>;
	clearImages(): void;
	/** 高さの列を持つ面＝自動で 3D 押し出し（前の押し出しは外す） */
	autoExtrude(pbf: GeoPBF): Promise<unknown>;
}
export interface ToolsReturn {
	/** ローカル容器（.gpkg/.mbtiles）の画像タイル＝"drop" 層（fallback＝タイル表が無ければ false） */
	rasterDropFile(file: File, fallback?: boolean): Promise<{ length: string } | false>;
}
