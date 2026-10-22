// core の worker の便り（main ⇄ worker の入口）の形＝型だけ（TS 化 段 3・batch G2・実行時は空のモジュール）。
// 送り手（pipeline.ts・elevation/createGetHeight.ts・globe の gint/layers.js＝まだ JS）と受け手（workers/*.ts・elevation/worker.ts・gint/bakeworker.ts）が同じ名前で読む。
// worker の入口は別の tsc（tsconfig.worker.json・lib webworker）で検査する＝main 側と型を分け合うのはこのファイル経由だけ。
import type { Style } from "./build.ts";
import type { FetchInit } from "./decode.ts";
import type { TilePayload } from "./tilepayload.ts";
import type { BuildingsGeom, DrawOp, MergedScene } from "./scene.ts";
import type { PaintZoom } from "./paintzoom.ts";
import type { ElevTile } from "./elevation/worldatlas.ts";
import type { BakeBaseResult, BakedTier, GintData, GintPayload } from "./gint/bake.ts";
export type { MergedScene };   // scene の便り（ScenePortMessage の "scene"）の中身＝受け手（globe の renderworker）がこの口だけで読めるように

// ── ortho:tile（workers/tileworker.ts）＝fetch→decode→tessellation
/** main → tile worker：起動（style・配信圏・楕円体・形式・drape＝地形にドレープする＝線を細分する・既定 true・vt perf plan §3.2） */
export interface TileInitRequest { type: "init"; style: Style; coverage?: number[] | null; ell?: unknown; encoding?: string; drape?: boolean }
/** main → tile worker：配色テーマ／基図の生き替え（coverage は据置・形式と drape は来た時だけ） */
export interface TileSetStyleRequest { type: "setStyle"; style: Style; encoding?: string; drape?: boolean }
/** main → tile worker：視野外の in-flight を中断 */
export interface TileAbortRequest { type: "abort"; id: number }
/** main → tile worker：タイル 1 枚の要求（type 無し）。init＝{headers,credentials}・bytes＝addProtocol が main で取った本体（#37） */
export interface TileBuildRequest { type?: undefined; id: number; url: string; z: number; x: number; y: number; init?: FetchInit; bytes?: ArrayBuffer | null }
export type TileRequest = TileInitRequest | TileSetStyleRequest | TileAbortRequest | TileBuildRequest;
/** タイル 1 枚の worker 内の時間（ms・計器 e＝`vt perf plan.md` §2）：fetch＝取得＋復号（fetchMVT）・build＝組み立て（buildTilePayload）。main が要求→応答の往復から待ち時間を引き算する */
export interface TileTimings { fetch: number; build: number }
/** tile worker → main：成功＝描画の荷（op 列・建物の typed array は transfer）。t＝worker 内の時間（計器 e） */
export interface TileOkResponse extends TilePayload { id: number; ok: true; error?: undefined; t?: TileTimings }
/** tile worker → main：失敗（abort を含む＝error に "abort" の文字） */
export interface TileErrorResponse { id: number; ok: false; error: string }
export type TileResponse = TileOkResponse | TileErrorResponse;

// ── ortho:scene（workers/sceneworker.ts）＝タイル geometry の保持と結合
/** merge の order の 1 件（tilemanager の OrderItem のうち scene worker が読む分） */
export interface SceneOrderItem { key: string; origin: number[]; z?: number }
export type SceneRequest =
	| { type: "relayCtl"; msg: unknown }   // iOS轍の中継（page→scene worker→renderPort→render worker）。msg.port があれば転送
	| { type: "connect"; port: MessagePort }   // render worker への直結ポート
	| { type: "tile"; key: string; ops: DrawOp[]; buildings: BuildingsGeom | null }
	| { type: "evict"; keys: string[] }
	| { type: "debugFailNext" }
	| { type: "stats" }
	| { type: "merge"; slot: string; sig: unknown; order: SceneOrderItem[]; origin?: number[] | null; hidden?: number[] | null };
export type SceneResponse =
	| { type: "relayCtlN"; n: number }   // iOS診断：hop1 の受信数
	| { type: "merged"; slot: string; sig: unknown };   // fallback（CPU 結合）の ack

/** プールの名（単位は要素数＝renderer 側が unit→byte/texel を知る） */
export type ScenePoolName = "fillV" | "fillI" | "line" | "bldV";
/** multi_draw の draw list の 1 束（fill＝offsets・line＝firsts） */
export interface SceneDrawLayer { kind: "fill" | "line"; li: number; cj?: number; dash?: number[]; fx?: number[]; pat?: string; pz?: PaintZoom; pt?: number; offsets?: Int32Array<ArrayBuffer>; firsts?: Int32Array<ArrayBuffer>; counts: Int32Array<ArrayBuffer>; origins: Float32Array<ArrayBuffer> }
export interface SceneDrawBld { firsts: Int32Array<ArrayBuffer>; counts: Int32Array<ArrayBuffer>; origins: Float32Array<ArrayBuffer> }
/** scene worker → render worker（直結ポート・FIFO＝grow → up → dl の順が崩れない） */
export type ScenePortMessage =
	| { type: "grow"; pool: ScenePoolName; units: number }
	| { type: "up"; key: string; fill?: { base: number; buf: ArrayBuffer }; idx?: { base: number; arr: Uint32Array<ArrayBuffer> }; line?: { base: number; arr: Uint32Array<ArrayBuffer> }; bld?: { base: number; arr: Float32Array<ArrayBuffer> }; rows?: [number, string, string[], unknown[], number, number?][] }   // rows＝新しい表の行・色か半幅が変わった行 [通しの行, 層 id, 鍵の名, 組, 焼いた色（RGBA8 の語）, 焼いた線の半幅（表に置ける線幅の層＝段 2b）]（paint 表の (b) 類）
	| { type: "dl"; slot: string; sig: unknown; origin: number[]; layers: SceneDrawLayer[]; bld: SceneDrawBld[] | null }
	| { type: "scene"; slot: string; scene: MergedScene }
	| { type: "relayCtl"; msg: unknown };
/** render worker → scene worker（直結ポート）：renderer の能力表明 */
export interface RenderModeMessage { type: "mode"; md?: boolean; maxDraws?: number; perf?: boolean; mdDash?: boolean; pt?: boolean }   // pt＝色の語を表の行として読める（paint 表の (b) 類・GL2 の md）   // mdDash＝線分プールの語 6 の距離をシェーダが読む（S-P1-3・GL2）。無ければ scene worker が刻んでから常駐させる

// ── ortho:height（elevation/worker.ts）＝標高タイルの復号
export interface HeightRequest { name: string; apiUrl?: string }
/** 復号済みタイル（data は transfer）｜null＝失敗 */
export type HeightResponse = ElevTile | null;

// ── gintbake（gint/bakeworker.ts・globe の worker.js の役 "gintbake"）＝GintBUF のメタ／tier 梯子の全ベイク
export interface GintBakeRequest { id: number; data: GintPayload }
/** bakeBase の戻りから下流不要の weightHist を落としたもの */
export type GintBakeArtifacts = Omit<BakeBaseResult, "weightHist">;
export type GintBakeResponse =
	| { id: number; kind: "done"; gint: GintData; artifacts: GintBakeArtifacts; tiers: BakedTier[] }   // 全 TypedArray は transfer（SAB の view は共有のまま）
	| { id: number; kind: "error"; message: string };   // 呼び手は同期経路へフォールバック

/** 役割 → { request, response }（WorkerRole の 3 つ＋globe が立てる gintbake） */
export interface WorkerMessages {
	"ortho:tile": { request: TileRequest; response: TileResponse };
	"ortho:scene": { request: SceneRequest; response: SceneResponse };
	"ortho:height": { request: HeightRequest; response: HeightResponse };
	"gintbake": { request: GintBakeRequest; response: GintBakeResponse };
}
