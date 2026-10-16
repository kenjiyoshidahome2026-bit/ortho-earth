// 共有 GL 状態（v2）。worker は singleton なので全モジュールがこの s を読み書きする。
// v1(ortho-map) の gintState を移植。唯一の差分＝d3 の lastProj を japan の cam(cameraState)へ。
// cam は identify の unproject（JSレイキャストの逆写像＝site 4）に使う。

import type { CameraState } from '../../camera.ts';
import type { GintData } from '../../gint/bake.ts';
import type { DrawData, DrawInput } from '../../gint/drawdata.ts';
import type { EdgeChunk } from '../../gint/utility.ts';
import type { GintPrograms, Uniforms } from './programs.ts';

/** LOD tier 1 段（minW 昇順の台帳）。tex＝RGBA32UI のメタ */
export interface GLTier { minW: number; edgeCount: number; chunks: EdgeChunk[] | null; tex: WebGLTexture | null }
/** ID 塗り（idfill）の能力＝浮動小数の色添付の形式 */
export interface IdCaps { internal: number; fmt: number; type: number; maxFid: number; name: string }
export interface IdPrograms { idProgram: WebGLProgram; resolveProgram: WebGLProgram; uId: Uniforms; uResolve: Uniforms }
/** paint（fid スタイル表）の CPU 控え（context restore 用） */
export interface FidStyleData { u32: Uint32Array; count: number }
/** 識別のポインタ（CSS px） */
export interface PointerData { x: number; y: number }
/** renderer.gintCtx()＝山岳ビュー（terrainDepth）の間だけの frame コンテキスト（gl/renderer.ts が作る） */
export interface GintDepthCtx {
	terrainDepth: boolean; logCoef: number; fogFar: number; elevTex: WebGLTexture | null; elevBounds: number[];
	elevScale: number; hasElev: number; edgeFade: number; meshQ: number[] | null; meshG: number; noSub: boolean; facesInAtlas: boolean;
}
/** 窓座標モード（地面アトラスへの焼き込み）＝off：原点−窓南西隅・inv：1/窓幅・size：窓の画素 */
export interface AtlasWin { off: number[] | null; inv: number[]; size: number }
/** 描画のスタイル（main が set("gintStyle") で預ける）＋描画の入力 */
export interface GintDrawStyle {
	lineWidth?: number | null; fillColor?: Float32List | null; styleTable?: Float32List | null; dashTable?: Float32List | null; maskColor?: Float32List | null;
	hiliteColor?: Float32List | null; hiliteWidth?: number | null; ptRadius?: number | null; minZoom?: number | null; maxZoom?: number | null; outlineZoom?: number | null;
	moveBudget?: number | null; noDepth?: boolean;
}
export type GLDrawInput = DrawInput & GintDrawStyle & { _forceLow?: boolean };
/** computeDrawData の戻り＋GL の描画パスが足す鍵 */
export interface GLDrawData extends DrawData {
	fillColor: Float32List | null | undefined; styleTable: Float32List | null | undefined; dashTable: Float32List | null | undefined;
	maskColor: Float32List | null | undefined; hiliteColor: Float32List | null | undefined; _forceLow: boolean | undefined;
	depth?: GintDepthCtx | null; noFaces?: boolean; facesOnly?: boolean; atlas?: AtlasWin;
}
/** 直前に同期したカメラ（実移動の判定） */
export interface SyncCam { center: [number, number]; zoom: number; pitch: number | undefined; bearing: number | undefined }

/**
 * gint の GL 状態。シングルトン s（GL 基盤・ビュー・運動）と、追加層の層状態（Object.create(s)＝データ・スタイル・perf ラッチだけを自前に持つ）の両方の形。
 * gl/programs は createGintLayer が入れるまで null。
 */
export interface GintGLState {
	canvas: OffscreenCanvas | HTMLCanvasElement | null; gl: WebGL2RenderingContext | null; dpr: number; width: number; height: number;
	programs: GintPrograms | null;
	TEX_ARC_W: number; TEX_META_W: number;
	arcTex: WebGLTexture | null; metaTex: WebGLTexture | null; ptTex: WebGLTexture | null; ptMetaTex: WebGLTexture | null;
	metaTexB: WebGLTexture | null;
	totalEdgesB: number; polyEdgesB: number;
	fidStyleTex: WebGLTexture | null; fidStyleW: number; fidStyleCount: number; _fidStyleH?: number; _fidStyleData?: FidStyleData | null;
	pivotTex: WebGLTexture | null; pivotW: number;
	lodTiers: GLTier[];
	metaChunks: EdgeChunk[] | null;
	totalEdges: number; totalPoints: number;
	polyEdges: number;
	fillOff: boolean;
	lowFill: boolean;
	tiersDone: boolean;
	/** 最長辺スパン（e7・地形適応細分の上限。-1＝未知）・境界メタ側・境界メタの複製行区間 [b,start,count,…] */
	span?: [number, number]; spanB?: [number, number]; subB?: number[] | null;
	outlineZoom?: number | null;
	pickFBO: WebGLFramebuffer | null; pickColorTex: WebGLTexture | null; pickDepthStencilRBO: WebGLRenderbuffer | null; _pickPBO?: WebGLBuffer | null;
	lastDrawData: GLDrawData | null;
	polyEdgeByFid: Map<number, [number, number]> | null;
	polyBboxByFid: Map<number, number[]> | null;
	minZoom: number | null; maxZoom: number | null;
	requestDraw: (() => void) | null;
	activeId: number;
	gintData: GintData | null;
	lastViewBbox?: number[] | null;
	cam: CameraState | null; lastMX: number; lastMY: number;
	hitMX: number; hitMY: number;
	_isDrawing: boolean; _moveTimer: number | null; _pendingMove: PointerData | null;
	_inRange: boolean;
	// 層状態（addLayer）・スロット交替・perf の計器
	layerId?: string | null; tierGen?: number; idOverlapMode?: boolean;
	_pfLineEdges?: number; _pfTierW?: number; _pfRuns?: number; _pfChunks?: number; _pfSubs?: number;
	_forceLowMove?: boolean; _budgetSkipped?: boolean; _pickPending?: boolean; _staticN?: number;
	_lastSyncCam?: SyncCam; _pfDrawn?: number; _pfFbo?: number; _pfPickMs?: number;
	// idfill の共有スクラッチ（シングルトン所有＝GL コンテキストの資産）
	_idCaps?: IdCaps | null; _idPrograms?: IdPrograms | null; _idFBO?: WebGLFramebuffer | null; _idTex?: WebGLTexture | null; _idW?: number; _idH?: number;
}
/** 描画の時点（createGintLayer の後）の状態＝gl と programs が在る */
export type GintLive = GintGLState & { gl: WebGL2RenderingContext; programs: GintPrograms };

export const s: GintGLState = {
	// GL core
	canvas: null, gl: null, dpr: 1, width: 0, height: 0,
	programs: null,
	TEX_ARC_W: 4096, TEX_META_W: 4096,

	// Textures
	arcTex: null, metaTex: null, ptTex: null, ptMetaTex: null,
	metaTexB: null,                // 境界エッジメタ（正味0の共有arc除去。stencil単色塗り常用＋低ズーム線パス）
	totalEdgesB: 0, polyEdgesB: 0,
	fidStyleTex: null, fidStyleW: 0, fidStyleCount: 0,   // fid スタイル表（RGBA32UI・paint の実体＝idfill.js）。CPU 控えは _fidStyleData（context restore 用）
	pivotTex: null, pivotW: 0,     // stencil塗りの per-feature 扇要（fid→bbox中心 e7整数）。null=従来のクリップ原点
	lodTiers: [],                  // 段階別 LOD メタ [{minW, edgeCount, tex}] minW 昇順（粗いほど後ろ）
	metaChunks: null,              // 基準メタのチャンク台帳 [{start,end,bbox}]（可視カリング用）
	totalEdges: 0, totalPoints: 0,
	polyEdges: 0,                  // メタ先頭のポリゴン辺数（stencil 塗りはこの範囲だけ＝折れ線をファンさせない）
	fillOff: false,                // 巨大ポリゴンデータの自動ベタ塗り停止（塗り stencil は LOD/カリング非対応＝辺数がそのまま毎フレーム コスト。uploadGintTextures が判定）
	lowFill: false,                // fillOff でも低ズーム帯（z<outlineZoom）の単色塗りだけは生かす層別フラグ（geoedit 大規模モード）
	tiersDone: false,              // tier梯子の遅延構築が完了したか（未完の間だけ pickLineTier が「最細の既存tier」で代用描画）

	// FBOs
	pickFBO: null, pickColorTex: null, pickDepthStencilRBO: null,
	lastDrawData: null,

	// Polygon edge ranges — O(1) active-feature lookup.
	polyEdgeByFid: null,    // Map<featureId, [edgeStart, edgeCount]>
	polyBboxByFid: null,    // Map<featureId, [xMin,yMin,xMax,yMax]> — JS fallback（Morton整数空間）

	// Zoom range
	minZoom: null, maxZoom: null,

	requestDraw: null,

	// Identify / hover
	activeId: -1,
	gintData: null,
	lastViewBbox: null,
	cam: null, lastMX: NaN, lastMY: NaN,   // ← v1 の lastProj を cam(cameraState)へ置換
	hitMX: NaN, hitMY: NaN,                // 直近 identify の座標（click の unproject 用・draw で消えない）
	_isDrawing: false, _moveTimer: null, _pendingMove: null,
	_inRange: false,   // 現ズームが [minZoom,maxZoom] 内で実描画されているか＝identify(tip) の可否。描画されない地物にホバー tip を出さない。
};
export * from '../../gint/state.ts';   // 共通の部分（DEF_*・SLOT_FIELDS・emptySlot）
