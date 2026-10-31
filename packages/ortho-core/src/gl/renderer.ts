// WebGL2 レンダラ：可視タイルを跨いで同一 style層を1バッファに結合した「シーン」を描く。
// draw call は「タイル数×層数」から「層数」へ激減し、uniform も1フレーム1回。共通のシーン原点で投影。
// fill = earcut三角形、line = capsule(SDF)。scene.layers は style層順（painter's algorithm）。
import { FILL_VS, FILL_FS, LINE_VS, LINE_FS, GLOBE_VS, GLOBE_FS, WDEPR_FS, GRAT_FS, BUILDING_VS, BUILDING_FS, TERRAIN_VS, TERRAIN_FS, STENCIL_VS, STENCIL_FS, COVER_FS, MESH_VS, MESH_FS, MESH_TEX_VS, MESH_TEX_FS, MESH_SIL_VS, MESH_SIL_FS, CONTOUR_FS, STARS_VS, STARS_FS, STARLINE_FS, NIGHT_FS, FILL_MD_VS, LINE_MD_VS, BUILDING_MD_VS, MD_MAX_DRAWS, RASTER_ATLAS_VS, RASTER_ATLAS_FS, ATLAS_FILL_VS, ATLAS_FILL_MD_VS, ATLAS_FILL_FS } from "./glsl.ts";
import { TERRAIN_CLIP_VS, TERRAIN_CLIP_FS, BUILDING_CLIP_VS, BUILDING_MD_CLIP_VS, BUILDING_CLIP_FS, MESH_CLIP_VS, MESH_TEX_CLIP_VS, MESH_CLIP_FS, MESH_TEX_CLIP_FS, FILL_CLIP_VS, FILL_MD_CLIP_VS, FILL_CLIP_FS, LINE_CLIP_VS, LINE_MD_CLIP_VS, LINE_CLIP_FS, GLOBE_CLIP_FS, CLIP_CAP_VS, CLIP_CAP_FS, shadowVS, shadowFS, castVS, CAST_FS, CAST_CLIP_FS, CAST_TEX_FS, CAST_TEX_CLIP_FS } from "./glsl.ts";
import type { ShadowFam } from "./glsl.ts";
import { sunVector, shadowWindow, shadowCascades, shadowDarkness, shadowHalfM, shadowBias, bboxInShadowWindow, SH_CAST_HMAX_M } from "../shadow.ts";   // 建物の影（点けた時だけ・P0 #3）
import type { ShadowWindow, ShadowCascade } from "../shadow.ts";   // 断面（P0 #3）＝切る間だけの派生
import { normClip, clipPlanesFor, clipPolygonFor, packClip, CLIP_F32 } from "../clip.ts";
import type { ClipNorm, ClipPlane, ClipPoly } from "../clip.ts";
import { groundWindows, groundSizes, windowsKey } from "../ground.ts";
import { csGroundFade, csFogDensity } from "../csatmo.ts";   // Cesium の大気（view.csAtmo）   // 地面アトラスの 3 段窓（RTT ドレープ）
import { cameraState, project, unproject, lonlatTo3D, betaOf, ellipsoidOn, sphereRayUniforms, anchorUV, bboxVisible, movedBbox, betaGeo, betaToLonLat } from "../camera.ts";
import { drapeMap, drapeUniforms } from "../drape.ts";   // 3D Tiles に重ねる絵（Cesium3DTileset.imageryLayers）の平面写像
import type { DrapeIn, DrapeMap } from "../drape.ts";
import { viewRays } from "../camera.ts";   // betaOf/ellipsoidOn＝setCommonUniforms の楕円体錨（WGS84化でGL2側だけimport漏れ＝GL2全描画が毎フレームReferenceErrorの実バグを2026-08-12修正）
import { buildChunkIndex, visibleChunkRuns } from "../terrainlod.ts";   // 地形メッシュのチャンク主導 index と視錐台/地平線カリング（perf plan P4 step B・WebGPU と同じ純関数）
import { ELEV_RESAMPLE_VS, ELEV_RESAMPLE_FS } from "./glsl.ts";   // 標高セルの GPU 再標本化（perf plan P1 step 1・WebGPU と同式）
import { downsampleFlipped, cropResample } from "../elevation.ts";   // 同・CPU 退避（EXT_color_buffer_float 無し・?cpuelev=1・型が想定外）
import { worldAtlasCell } from "../elevation/worldatlas.ts";
import { evalPaintZoom } from "../paintzoom.ts";   // ズーム連続（V-Ph3＝S-P1-2）＝層の色・線幅を今の z で
import { ptCovers, ptRowColor, ptRowHalf, PT_ID } from "../painttable.ts";   // paint 表の (b) 類＝setPaintProperty の地物を読む値で行を評価し直す
import type { PtLayer } from "../painttable.ts";
type PtRow = [number, string, string[], unknown[], number, number?];   // 表の行（worker-msg.ts の up.rows）
import { seaFbReal, dashIntervals } from "../scene.ts";   // 図郭外フォールバック水域の擬似li帯判定（build.js buildEmptySeaOps と対）・破線の区間（S-P1-3）
import { resolveWorldPal, fadeWorldPal } from "../worldpal.ts";   // 全球ハイプソの正準パレット（テーマ＝view.worldHypso の部分上書き）
import * as mat from "../mat.ts";
import { csViewMat, csGlUniform } from "../csshader.ts";   // Cesium の CustomShader（利用者の GLSL を模型の FS/VS に差し込む）
import type { CsSpec, CsUType, CsMeta } from "../csshader.ts";
import { meshCustomGLSL } from "./glsl.ts";
import { createDepthOutGL } from "./depthout.ts";   // シーンの深度をオーバーレイへ（#47）＝申し出がある時だけ FBO 経由で描く
import { createClassifyGL } from "./classify.ts";   // 面の貼り付け（分類・2026-10-25）＝柱（体積）を深度に当てて地形・3D Tiles の面だけ塗る
import { clockNow } from "@ortho-earth/ephem/clock";   // 共通の時計（#42）＝view.clock（{sim,wall,rate}）からその時刻。無ければ実時刻
import { gmstAt, sunSubpoint } from "@ortho-earth/ephem/sun";   // 恒星時と太陽直下点の正本（solar と同じ式）
import { FAR_PIVOT } from "./gint/utility.ts";   // 塗り扇の遠方の要の旗（?nofarpivot=1）
import type { Renderer } from "../../types/gpu.js";
import type { CameraPose, CameraState, SphereRayUniforms } from "../camera.ts";
import type { BuildingsGeom, LineTex, MergedScene } from "../scene.ts";
import type { PaintZoom } from "../paintzoom.ts";
import type { RasterDraw, RasterDrawLayer, RasterDraws, TileMesh } from "../raster.ts";
import type { CellPayload } from "../terrain.ts";
import type { ElevGrid, ElevTileGrid } from "../elevation.ts";
import type { DrawRun, TerrainChunk } from "../terrainlod.ts";
import type { OverlayRange } from "../geojson.ts";
import type { WorldPal } from "../worldpal.ts";
import type { PostProcessNormalized } from "../postfx.ts";
import type { ClockAnchor } from "@ortho-earth/ephem/clock";
import type { DepthOutGL } from "./depthout.ts";
import type { DepthGlobe } from "../depthout.ts";
import type { GintDepthCtx } from "./gint/state.ts";
import type { GintAtlasTarget } from "./gint/embed.ts";

export type { Renderer };
/** createRenderer の rOpts（renderworker が渡す） */
export interface GLRendererOptions { msaa1?: boolean; quad4?: boolean; requestDraw?: (() => void) | null; lowMem?: boolean; noMD?: boolean; cpuElev?: boolean; terrLod?: boolean }
/** draw(cam, opts) の opts */
export interface GLDrawOptions { skipMain?: boolean; skipBase?: boolean; noTerrain?: boolean; noBld?: boolean }
type Vec3T = [number, number, number];
type Vec4T = [number, number, number, number];
/** 1 フレームのカメラ＝cameraState＋f32 の mvp・霧の基準距離 */
type GLCamState = CameraState & { mvp32: Float32Array; fogDist?: number };
/** 静的な見た目（set("view")・浅マージ） */
interface GLView {
	clear: number[] | null; land: number[] | null; atmo: number[] | null; bldColor: number[] | null;
	fog?: boolean; sea?: number[] | null; baseAlpha?: number; globeAlpha?: number;
	/** 地下から見た球の裏面（Cesium の globe.undergroundColor）：color＝rgba（0..1）・nf＝α の距離 [near m, nearValue, far m, farValue] */
	underground?: { color: number[]; nf: number[] } | null;
	worldHypso?: (Record<string, unknown> & { clim?: string }) | null; worldHypsoOpacity?: number; worldHypsoZ?: number;
	clock?: ClockAnchor | null; showConst?: boolean; skySolar?: boolean; showRail?: boolean; showContour?: boolean; graticule?: boolean; night?: boolean;
	contourAlpha?: number; contourColor?: number[]; distColor?: number[]; hypso?: { color: number[]; max?: number; amount?: number } | null;
	gintFarPivot?: boolean; gintSub?: boolean;
	dashDz?: number;   // 破線（S-P1-3）の段の目盛り＝外来 style の z とエンジンの z の差（globe の STYLE_DZ・既定 1）
	csAtmo?: { ground?: boolean; sky?: boolean } | null;   // Cesium の大気（../csatmo.ts）＝点けると球の霞・リム光・sky の代わり
}
/** style の sky（B4） */
interface GLSky { sky: number[]; horizon: number[]; fog: number[]; groundBlend: number; horizonFogBlend: number; skyHorizonBlend: number; atmosphereBlend: number }
/** style の light（B3） */
interface GLLight { dir: number[]; color?: number[] | null; intensity?: number }
/** Cesium の模型の鏡面の環境（setMeshEnvironmentMap）＝size は 0 段の一辺・levels[mip] は 6 面ぶんの RGBA16F（半精度の 16 bit） */
export interface GLMeshEnv { size: number; levels: Uint16Array[] }
/** Cesium の模型の照明（@ortho-earth/cesium の setMeshLighting・2026-10-26）＝dir は世界系の単位ベクトル・color は HDR・sh は Cesium の並びの 27 値 */
interface GLMeshLight { dir: number[]; color: number[]; sh: Float32Array; ibl: number[]; invL00: number }
/** 地面の照明（setGroundLighting・Cesium の globe.enableLighting）：dir＝光へ向く単位ベクトル（世界）・lambert＝[倍率, 足す値]・fade/night＝[消える距離, 全開の距離]（m・中心から・null＝常に全開/暗くしない） */
interface GLGroundLight { dir: number[]; color: number[]; lambert: number[]; normal: string; fade: number[] | null; night: number[] | null }
/** 地面の材質（setGroundMaterial・Cesium の globe.material・2026-10-28）＝globe の api/camera.ts packGroundMaterial の形：kind 0 なし／1 標高／2 傾斜／3 方位／4 等高線だけ・ramp＝n×RGBA（1 列の色の表） */
interface GLGroundMat { kind: number; min: number; max: number; landOnly: number; contour: number[] | null; spacing: number; width: number; opacity: number; ramp: Uint8Array | null; rampN: number }
/** 局所の光源（W2・light.js localLightsPayload） */
interface GLLocalLights { n: number; data: Float32Array }
interface ElevState { bounds: number[]; scale: number; has: number; exag?: number; edgeFade?: number; liftBounds?: number[] | null }
interface FarState { bounds: number[]; has: number; edgeFade: number; maxElev?: number }   // maxElev＝遠景層の最大標高（m・terrain.ts の elevFarMax）＝地面アトラスの地平線窓を伸ばす
/** 標高アトラスの記述（terrain.js の set("elevAtlas"…)） */
interface ElevAtlasDesc { originLng: number; originLat: number; cellsX: number; cellsY: number; cellRes: number; cellSpan?: number; exag?: number; edgeFade?: number; liftBounds?: number[] | null; gMax?: number }
interface ElevCellProp { cx: number; cy: number; cellRes: number }
/** 生タイルの記述子（CellPayload の Float32Array 以外）＝tile/atlas はどちらか */
type CellSrc = Exclude<CellPayload, Float32Array> & { tile?: ElevTileGrid; atlas?: ElevGrid };
interface RawTexEntry { tex: WebGLTexture; bytes: number; kind: number; fresh: number }
interface ResampleRes { fbo: WebGLFramebuffer; progs: WebGLProgram[]; vao: WebGLVertexArrayObject }
interface TerrainMesh { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; ibo: WebGLBuffer; count: number; G: number; mesh: number[]; chunks: TerrainChunk[] }
interface CogInput { rgba: Uint8Array; w: number; h: number; bboxLL: number[]; pair?: boolean }
type GLRasterTex = { kind: "tex"; tex: WebGLTexture; bytes: number; w: number; h: number; nearest: boolean };
type GLRasterMesh = { kind: "mesh"; vao: WebGLVertexArrayObject; bufs: WebGLBuffer[]; count: number; bytes: number };
type GLRasterDraw = Omit<RasterDraw, "tex" | "mesh"> & { tex: GLRasterTex; mesh: GLRasterMesh };
type GLRasterDraws = Omit<RasterDraws, "layers"> & { layers: (Omit<RasterDrawLayer, "draws"> & { draws: GLRasterDraw[] })[] };
/** 地面アトラスの 1 窓 */
interface GndWin { tex: WebGLTexture; fbo: WebGLFramebuffer; rb: WebGLRenderbuffer; size: number; win: number[]; bytes: number }
interface GLFillDraw { kind: "fill"; li: number; vao: WebGLVertexArrayObject; count: number; idxT: number; bufs: WebGLBuffer[]; fx: number[] | null; pat: string | null; pz: PaintZoom | null }
interface GLLineDraw { kind: "line"; li: number; vao: WebGLVertexArrayObject; count: number; bufs: WebGLBuffer[]; cj: number; dash: DashU | null; fx: number[] | null; pz: PaintZoom | null; lt: LineTex | null }
// 破線（S-P1-3）の uniform の中身＝周期・区間の数・丸い端・区間 [a, b]×4（scene.ts の dashIntervals）
interface DashU { P: number; n: number; round: number; iv: Float32Array }
function dashU(dash: readonly number[] | undefined, cj: number): DashU | null {
	if (!dash) return null;
	const round = !(cj & 3), { P, iv } = dashIntervals(dash, round), a = new Float32Array(8);
	a.set(iv.length ? iv.slice(0, 8) : [-2 * P, -2 * P]);   // 線が無い（butt の [0, 2]）＝どの画素も届かない区間（区間の数 0 は「破線でない」＝実線になる）
	return { P, n: Math.max(1, Math.min(4, iv.length >> 1)), round: round ? 1 : 0, iv: a };
}
type GLDraw = GLFillDraw | GLLineDraw;
interface GLBld { vao: WebGLVertexArrayObject; count: number; bufs: WebGLBuffer[] }
/** multi_draw のシーンの 1 項（常駐プールのレンジ列） */
interface MDLayer { kind: "fill" | "line"; li: number; cj?: number; dash?: number[]; fx?: number[]; pat?: string; pz?: PaintZoom; pt?: number; lt?: LineTex; dashU?: DashU | null; origins: Float32List; counts: Int32List; offsets: Int32List; firsts: Int32List }
interface MDBldRun { origins: Float32List; firsts: Int32List; counts: Int32List }
interface GLScene { origin: ArrayLike<number>; draws: GLDraw[]; bld: GLBld | null; md?: { layers: MDLayer[]; bld: MDBldRun[] | null } | null }
interface MDPool { buf: WebGLBuffer | null; bytes: number }
interface MDState {
	ext: WEBGL_multi_draw; fillProg: WebGLProgram; lineProg: WebGLProgram; bldProg: WebGLProgram;
	fillV: MDPool; fillI: MDPool; bldV: MDPool; lineTex: WebGLTexture | null; lineTexH: number;
	fillVAO: WebGLVertexArrayObject | null; bldVAO: WebGLVertexArrayObject | null; atlasFillProg?: WebGLProgram;
}
interface MDUpload { fill?: { base: number; buf: ArrayBuffer } | null; bld?: { base: number; arr: Float32Array } | null; idx?: { base: number; arr: Uint32Array } | null; line?: { base: number; arr: Uint32Array } | null; rows?: [number, string, string[], unknown[], number][] }   // rows＝paint 表の (b) 類の行（scene worker の ptGlobal）
interface MDSceneMsg { slot: string; origin: ArrayLike<number>; layers: MDLayer[]; bld: MDBldRun[] | null }
interface MDGrowMsg { pool: string; units: number }
interface GintBldIn { lines?: BuildingsGeom | null; points?: BuildingsGeom | null; color?: number[] | null }
interface GintBldData extends GintBldIn { origin: ArrayLike<number>; batches?: GintBldIn[] | null }
interface GintBldBatch { lineVAO: WebGLVertexArrayObject | null; lineCount: number; pointVAO: WebGLVertexArrayObject | null; pointCount: number; bufs: WebGLBuffer[]; color: number[] | null }
interface StarBuf { vao: WebGLVertexArrayObject; buf: WebGLBuffer; count: number }
type MeshTexIn = { bitmap: ImageBitmap } | { bitmap?: null; rgba: Uint8Array; w: number; h: number };
/** set("meshSet", data, key) の data（建物メッシュ・模型） */
interface MeshIn {
	pos: Float32Array; idx: Uint32Array; nrm: Int8Array | Float32Array; uv?: Float32Array | null; col?: Uint8Array | null; tex?: MeshTexIn | null;
	origin?: number[] | null; alphaMode?: string; alphaCutoff?: number; bbox?: number[] | null; ward?: string; pbr?: { metallic: number; roughness: number; clearcoat?: number[] | null } | null; csLit?: string;
	lodH?: ArrayLike<number> | null; lodCounts?: ArrayLike<number> | null; twoSided?: boolean; noCull?: boolean; noLift?: boolean; drape?: boolean; keep2d?: boolean; castShadow?: boolean;
	mask?: ArrayLike<number> | null; maskCells?: ArrayLike<number> | null; maskN?: number; maskBbox?: number[] | null;
	uvm?: Float32Array | null; meta?: { props: Record<string, CsMeta>; texs: (MeshTexIn | null)[] } | null;   // property texture の texCoord と読み方・画像（fsInput.metadata）
	mc?: Float32Array | null; mcJ?: ArrayLike<number> | null; custom?: string | null; split?: number; sh?: ArrayLike<number> | null; outline?: ArrayLike<number> | null; noClip?: boolean; imagery?: string | null;   // imagery＝重ねる絵（set "meshDrape"）の id・Cesium の CustomShader：頂点の glTF 座標（xyz＋地物番号）・J＝d(世界)/d(MC)（列優先）・差し込むシェーダの id
}
interface MeshBatch {
	vao: WebGLVertexArrayObject; bufs: WebGLBuffer[]; tex: WebGLTexture | null; textured: boolean; blend: boolean; cut: number; count: number;
	origin: ArrayLike<number>; bbox: number[]; ward: string; lodH: ArrayLike<number> | null; lodCounts: ArrayLike<number> | null;
	two: number; noCull: boolean; noLift: boolean; drape: boolean; keep2d: boolean; noCast: boolean; xf?: Float32Array | null;
	pbr: { metallic: number; roughness: number; clearcoat: number[] | null } | null;   // 材質の係数（Cesium の照明が読む）・clearcoat＝KHR_materials_clearcoat [factor, roughness]
	csLit: string;   // Cesium の照明の掛け方："pbr"（既定）／"unlit"＝素の色（KHR_materials_unlit・法線無し）／"off"＝固定光（entity geometry）
	tint?: Float32Array | null;   // Cesium の Model.color（set "meshTint"）＝[r,g,b,a, blend]
	sh?: Float32Array | null;   // その模型の環境光（set "meshEnv"＝SH9・27 値）＝meshLight.sh より勝つ
	paint?: WebGLTexture | null; paintB?: number;   // 画素ごとの地物の番号から塗った絵（set "meshPaint"・photogrammetry の分類）と混ぜ方（tint と同じ数）
	sil?: Float32Array | null;   // Cesium の Model.silhouetteColor／silhouetteSize（set "meshSil"）＝[r,g,b,a, size px]
	custom?: string | null; mcJ?: Float32Array | null; mc?: boolean; split?: number; ol?: Float32Array | null; noClip?: boolean; imagery?: string | null;   // imagery＝重ねる絵の id（set "meshImagery"）・Cesium の CustomShader（set "meshCustom"）の id・J・a_mc の有無
	uvm?: boolean; meta?: { props: Record<string, CsMeta>; sig: string; texs: WebGLTexture[] } | null;   // property texture（a_uvm の有無・読み方・画像）
}
/** set("customShader", spec, id) の登録＝プログラムは初めて描く時に作る（失敗＝err＝素の模型で描く） */
interface CsEntry { spec: CsSpec & { values?: Record<string, unknown>; lighting?: string; translucency?: string }; progs: Map<string, WebGLProgram | null>; tex: Map<string, WebGLTexture> }   // progs＝束の property texture の形（sig）ごと（null＝組めない）
interface CsTexIn { name: string; tex: MeshTexIn; nearest?: boolean; repeat?: boolean }
const MC_LOC = 6, UVM_LOC = 7, CS_TEX_UNIT = 24, OL_NONE = new Float32Array(4);   // a_mc の属性番号（a_pos/a_normal/a_uv/a_col の後）・利用者のテクスチャの最初のユニット（0..20 は描き手が使う）
interface MeshMask { tex: WebGLTexture; bbox: number[]; n: number; bytes: Uint8Array }
/** overlay 系の入力（buildGeoJSONOverlay のシーン） */
interface OverlaySceneIn { fanPos: Float32Array; P1: Float32Array; P2: Float32Array; lineCol: Float32Array | Uint8Array; lineHalf?: Float32Array | null; origin: ArrayLike<number>; minZoom?: number; feats?: OverlayRange[] | null }
interface OverlaySlot {
	fanVao: WebGLVertexArrayObject; fanCount: number; lineVao: WebGLVertexArrayObject | null; lineCount: number; origin: ArrayLike<number>;
	fillColor: ArrayLike<number>; bufs: WebGLBuffer[]; minZoom: number; feats: OverlayRange[] | null; mask?: boolean;
}
/** overlayHi の prop＝配列は面塗り／{mask,color} は周辺マスク */
type HiFill = number[] | { mask?: boolean; color?: number[] | null };
interface DbgCounters { baseFill: number; baseLine: number; mainFill: number; mainLine: number; pt: number; ptw: number; skipMain: boolean; skipBase: boolean; zoom: number; terrainDepth: boolean }
interface UserAnchorPlan { host: string | null; anchors: number[]; anchorOf: (li: number) => number }
type LiPick = ((x: { li: number }) => boolean) | null;
/** ?perf=1 の計器（worker の大域） */
type PerfGlobal = { __perfElev?: unknown; __perfElevLast?: unknown; __perfElevT?: number };

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)（?quad4=0 の旧経路）
const CORNERS4 = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);            // 4 隅 A−,A+,B−,B+（perf plan P3）＝index [0,1,2,2,1,3] で旧 CORNERS の三角形 (A−,A+,B−)(B−,A+,B+) と同一（gpu/renderer.js と対）
const LINE_IDX = new Uint8Array([0, 1, 2, 2, 1, 3]);
const CLIP_GL_TARGETS = ["terrain", "buildings", "models", "vector"];   // 断面の対象（注記は切らない）

const DRAPE_ALL = [-180, -90, 360, 180];   // drape のバッチ＝持ち上げの範囲を全球に（DTM 保証域の外でも地形に沿わせる）
// 対数深度係数（cameraState と同じ far＝地平線 limb×1.15+camDist）。球+局所(建物)の z-fight 対策。u_logCoef・gintCtx・深度の書き出し（#47）が同じ値を使う
const logCoefOf = (st: CameraState): number => { const limb = Math.sqrt(Math.max((1 + st.camDist) * (1 + st.camDist) - 1, 1e-12)); return 2.0 / Math.log2(limb * 1.15 + st.camDist + 1.0); };
export function createRenderer(canvas: OffscreenCanvas | HTMLCanvasElement, rOpts: GLRendererOptions = {}): Renderer {
	// antialias＝ブラウザ暗黙確保の MSAA（フルRetina面積で ~100MB級）。msaa1（LOW_MEM 既定・?msaa=0）＝1x 直描き。
	const gl = canvas.getContext("webgl2", { antialias: !rOpts.msaa1, premultipliedAlpha: true, stencil: true }) as WebGL2RenderingContext;   // "webgl2" の口＝WebGL2。null は直下で投げる（宣言関数の中へは絞り込みが届かない＝型は非 null）
	if (!gl) throw new Error("WebGL2 unavailable");

	// 切っている間（P0 #3・set("clip")）は描くプログラムを切る派生へ差し替える＝下の let は毎フレーム base か派生を指す（属性の位置は base と同じ＝VAO は共通）
	const fillProg0 = program(gl, FILL_VS, FILL_FS);
	const lineProg0 = program(gl, LINE_VS, LINE_FS);
	let fillProg = fillProg0, lineProg = lineProg0;
	// line-offset（#49）の属性を持たない VAO は既定値で描く＝既定値は位置ごとの大域状態（他の頂点属性の vertexAttrib4f と位置を
	// 共有し得る）＝線を描く直前に 0 を置き直す
	const lineOffLoc = gl.getAttribLocation(lineProg, "a_off");
	const lineL = (n: string) => loc(gl, lineProg, n);   // 今の線のプログラム（base か切る派生）の uniform
	const lineOffZero = () => { if (lineOffLoc >= 0) gl.vertexAttrib3f(lineOffLoc, 0, 0, 0); gl.uniform1f(lineL("u_cj"), 0); gl.uniform4f(lineL("u_dashP"), 0, 0, 0, 0); gl.uniform4f(lineL("u_tr"), 0, 0, 0, 0); gl.uniform2f(lineL("u_blur"), 0, 0); gl.uniform4f(lineL("u_pz"), 0, 0, 0, 0); gl.uniform2f(lineL("u_pzO"), 0, 0); gl.uniform4f(lineL("u_lt"), 0, 0, 0, 0); };   // 色の語は色（G-3）   // 丸い端・丸い継ぎ（S-P1-1 の u_cj＝0＝a_jf・a_p0・a_p3 を読まない）・破線でない（S-P1-3）・ずらさない・ぼかさない（S-P1-4/5）
	// 層の画面効果（S-P1-4/5・build.ts の layerFx＝[tx, ty, anchor, blur, rel]）：translate は今の zoom の 1px の経度（256px の世界）で地面へ。
	// anchor "viewport"＝画面に揃える＝方位だけ回して地面の東・南へ（MapLibre の translatePosMatrix と同じ）。line-blur は CSS px→画素
	const setFx = (trLoc: WebGLUniformLocation | null, blurLoc: WebGLUniformLocation | null, fx: readonly number[] | null | undefined, cam: { zoom?: number; bearing?: number; dpr?: number }): void => {
		if (!fx || !(fx[0] || fx[1])) gl.uniform4f(trLoc, 0, 0, 0, 0);
		else {
			const b = fx[2] ? cam.bearing || 0 : 0, c = Math.cos(b), s = Math.sin(b);
			gl.uniform4f(trLoc, fx[0] * c - fx[1] * s, fx[0] * s + fx[1] * c, 360 / (256 * 2 ** (cam.zoom || 0)), 0);
		}
		if (blurLoc) gl.uniform2f(blurLoc, fx ? fx[4] ? fx[3] : fx[3] * (cam.dpr || 1) : 0, fx ? fx[4] : 0);
	};
	// ズーム連続（V-Ph3＝S-P1-2・paintzoom.ts）：地物に依らない色・線幅は今の z で評価して頂点の値に差し替える。
	// 式はエンジンの z の目盛り（外来の style は splitMapLibreStyle が ["-", ["zoom"], dz] に書き換え済み＝build.ts もタイルの z をそのまま入れる）＝cam.zoom で評価。
	// 破線の尺の線幅は floor(外来の z) の値（MapLibre の floorwidth＝dashDz の段）。u_pz＝[色を差し替える, 線幅を差し替える, 半幅, 破線の尺の半幅]・u_pzC＝色・u_pzO＝[ずらしを差し替える, ずらし]（線だけ）。
	// 層の値は z が変わった時だけ評価し直す
	// setPaintProperty の速い道（build.ts paintFast・main の applyPaintNow）：基図の層の添字 → 差し替えの式（定数も）。作ったタイルの pz より先に読む＝作り直さずに今の値
	let pzOver = new Map<number, PaintZoom>();
	const pzMemo = new WeakMap<PaintZoom, { z: number; c: number[] | null; hw: number | null; hwF: number; off: number | null }>();
	const setPz = (prog: WebGLProgram, pz: PaintZoom | null | undefined, cam: { zoom?: number }): void => {
		const oL = loc(gl, prog, "u_pzO");   // 塗りは持たない（null）
		if (!pz) { gl.uniform4f(loc(gl, prog, "u_pz"), 0, 0, 0, 0); if (oL) gl.uniform2f(oL, 0, 0); return; }
		const z = cam.zoom || 0;
		let m = pzMemo.get(pz);
		if (!m || m.z !== z) {
			const v = evalPaintZoom(pz, z), dz = view.dashDz ?? 1;
			m = { z, c: v.c, hw: v.hw, hwF: v.hw == null ? 0 : evalPaintZoom({ o: pz.o, w: pz.w }, Math.floor(z - dz) + dz).hw!, off: v.off };
			pzMemo.set(pz, m);
		}
		gl.uniform4f(loc(gl, prog, "u_pz"), m.c ? 1 : 0, m.hw != null ? 1 : 0, m.hw ?? 0, m.hwF);
		if (m.c) gl.uniform4f(loc(gl, prog, "u_pzC"), m.c[0], m.c[1], m.c[2], m.c[3]);
		if (oL) gl.uniform2f(oL, m.off != null ? 1 : 0, m.off ?? 0);
	};
	// fill-pattern（S-P1-4/5）：記号帳の写し（render worker が注記層と同じ labelImage を回す）＝名前 → 画像（テクスチャは初めて描く時に作る）。
	// 模様の px＝floor(外来の z) の世界（MapLibre の tileZoom と同じ段）のメルカトルの px・位相はシーン原点で f64 に畳む（大きい世界の px を f32 に載せない）
	const pats = new Map<string, { bm: ImageBitmap; pr: number; tex: WebGLTexture | null }>();
	const PAT_UNIT = 16;   // 0〜15 は埋まっている（1 elev・2-5 mask・6 md 線・7 gint・8 far・9 cog・10・11/13-15 gnd・12 clim）＝合成の上限（32 以上）の側
	// 模様を使わない塗りでも u_patTex は FS の能動の標本器＝既定の unit 0 に整数テクスチャ（md の線分プール等）が残ると型の不一致で描画ごと無効になる
	// ＝unit 16 を常に指させ、1×1 の透明な絵を置いておく（初めの模様が来るまで）
	{ const t = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0 + PAT_UNIT); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); gl.activeTexture(gl.TEXTURE0); }
	// 線の色の見本（G-3＝line-gradient）：見本（RGBA8×LG_N）→ テクスチャ（鍵＝lt.key で覚える・古い順に捨てる）。描く直前に PAT_UNIT へ（塗りの模様と同じ unit＝塗りは自分の模様を置き直す）。
	// u_ltTex は線のプログラムを作った時に PAT_UNIT を指させる（既定の 0 番は md の線分プール＝整数の標本器と当たる）
	const ltTexs = new Map<string, WebGLTexture>();
	const ltProg = (prog: WebGLProgram): void => { gl.useProgram(prog); gl.uniform1i(loc(gl, prog, "u_ltTex"), PAT_UNIT); gl.uniform4f(loc(gl, prog, "u_lt"), 0, 0, 0, 0); };
	ltProg(lineProg0);
	// line-pattern（G-4）＝塗りの模様と同じ画像のテクスチャを PAT_UNIT へ・u_lt＝(2, 破線と同じ尺, 層の line-opacity)。false＝画像がまだ無い（描かない＝塗りの模様と同じ）
	const setLt = (prog: WebGLProgram, lt: LineTex | null | undefined, cam: { zoom?: number; center?: ArrayLike<number> }): boolean => {
		const L = loc(gl, prog, "u_lt");
		if (lt?.pat) {
			const p = patTex(lt.pat); if (!p) return false;
			gl.activeTexture(gl.TEXTURE0 + PAT_UNIT); gl.bindTexture(gl.TEXTURE_2D, p.tex); gl.activeTexture(gl.TEXTURE0);
			const z = cam.zoom || 0, zs = z - (view.dashDz ?? 1);
			gl.uniform4f(L, 2, 2 ** (z - 24 - (zs - Math.floor(zs))) * Math.cos((cam.center?.[1] || 0) * Math.PI / 180), lt.o ?? 1, 0);
			return true;
		}
		if (!lt?.lut) { gl.uniform4f(L, 0, 0, 0, 0); return true; }
		let t = ltTexs.get(lt.key);
		if (!t) {
			if (ltTexs.size >= 64) { const k0 = ltTexs.keys().next().value!; gl.deleteTexture(ltTexs.get(k0)!); ltTexs.delete(k0); }
			t = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0 + PAT_UNIT); gl.bindTexture(gl.TEXTURE_2D, t);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lt.lut.length >> 2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lt.lut);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			ltTexs.set(lt.key, t);
		} else { gl.activeTexture(gl.TEXTURE0 + PAT_UNIT); gl.bindTexture(gl.TEXTURE_2D, t); }
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform4f(L, 1, 0, 0, 0);
		return true;
	};
	const setPatImage = (d: { name: string; bitmap: ImageBitmap | null; pixelRatio?: number } | null): void => {
		if (!d?.name) return;
		const old = pats.get(d.name); if (old?.tex) gl.deleteTexture(old.tex);
		if (d.bitmap) pats.set(d.name, { bm: d.bitmap, pr: d.pixelRatio || 1, tex: null }); else pats.delete(d.name);
	};
	// 模様の画像のテクスチャ（初めて使う時に作る）。null＝画像がまだ無い・閉じた画像（差し替えの最中）＝次の labelImage を待つ
	const patTex = (name: string): { bm: ImageBitmap; pr: number; tex: WebGLTexture } | null => {
		const p = pats.get(name); if (!p) return null;
		if (!p.tex) {
			try {
				p.tex = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0 + PAT_UNIT); gl.bindTexture(gl.TEXTURE_2D, p.tex);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, p.bm);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
			} catch { if (p.tex) gl.deleteTexture(p.tex); pats.delete(name); gl.activeTexture(gl.TEXTURE0); return null; }
			gl.activeTexture(gl.TEXTURE0);
		}
		return p as { bm: ImageBitmap; pr: number; tex: WebGLTexture };
	};
	// 模様の uniform を置く。false＝画像がまだ無い（描かない＝MapLibre も画像が届くまで描かない）
	const setPat = (prog: WebGLProgram, name: string | null | undefined, o: ArrayLike<number>, cam: { zoom?: number }): boolean => {
		gl.uniform1i(loc(gl, prog, "u_patTex"), PAT_UNIT);
		if (!name) { gl.uniform4f(loc(gl, prog, "u_patP"), 0, 0, 0, 0); return true; }
		const p = patTex(name); if (!p) return false;
		const dz = view.dashDz ?? 1, fz = Math.floor((cam.zoom || 0) - dz) + dz, n = 256 * 2 ** fz, W = p.bm.width / p.pr, H = p.bm.height / p.pr;
		const X = (o[0] + 180) / 360 * n, s = Math.sin(o[1] * Math.PI / 180), Y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
		gl.activeTexture(gl.TEXTURE0 + PAT_UNIT); gl.bindTexture(gl.TEXTURE_2D, p.tex); gl.activeTexture(gl.TEXTURE0);
		gl.uniform4f(loc(gl, prog, "u_patP"), X - W * Math.floor(X / W), Y - H * Math.floor(Y / H), 1 / W, 1 / H);
		gl.uniform1f(loc(gl, prog, "u_patK"), n / 360);
		return true;
	};
	// 破線（S-P1-3）の uniform：尺 K＝模様の px（MapLibre の tileZoom＝floor(外来の z) の px）÷ z24 の px（地面・メルカトル）。
	// 画面の中心で z24 の px 1 つ＝2^(z−24)·cos φ 画素（球＝地面の実長）。外来の z の小数部だけ地面について伸びる＝MapLibre と同じ（段で元の px へ戻る）
	const setDash = (pLoc: WebGLUniformLocation | null, iLoc: WebGLUniformLocation | null, d: DashU | null, cam: { zoom?: number; center?: ArrayLike<number> }): void => {
		if (!d) { gl.uniform4f(pLoc, 0, 0, 0, 0); return; }
		const z = cam.zoom || 0, zs = z - (view.dashDz ?? 1);
		gl.uniform4f(pLoc, d.P, d.n, d.round, 2 ** (z - 24 - (zs - Math.floor(zs))) * Math.cos((cam.center?.[1] || 0) * Math.PI / 180)); gl.uniform4fv(iLoc, d.iv);
	};
	const globeProg0 = program(gl, GLOBE_VS, GLOBE_FS);
	let globeProg = globeProg0;
	const wdCoverProg = program(gl, GLOBE_VS, WDEPR_FS);   // 海面下の陸地の cover＝landK=1 強制のハイプソ本体（フルスクリーン・stencil≠0 のみ）
	const gratProg = program(gl, GLOBE_VS, GRAT_FS);       // 10度レチクル（v1 geoGraticule10 移植・フルスクリーン計算）
	const bldProg0 = program(gl, BUILDING_VS, BUILDING_FS);
	const terrainProg0 = program(gl, TERRAIN_VS, TERRAIN_FS);
	const meshProg0 = program(gl, MESH_VS, MESH_FS);   // 建物メッシュ（LOD2 等）
	const meshTexProg0 = program(gl, MESH_TEX_VS, MESH_TEX_FS);   // 模型（glb 直読み）＝同シェーダの派生（uv＋頂点色＋テクスチャ）
	const meshSilProg = programBound(gl, MESH_SIL_VS, MESH_SIL_FS, Object.fromEntries(["a_pos", "a_normal", "a_uv", "a_col"].map(n => [n, gl.getAttribLocation(meshTexProg0, n)])));   // 模型の輪郭線（Model.silhouette）＝模型の VAO をそのまま使う
	let bldProg = bldProg0, terrainProg = terrainProg0, meshProg = meshProg0, meshTexProg = meshTexProg0;
	// ── 断面とクリッピング平面の WebGL2 版（P0 #3・2026-10-25）＝WebGPU（gpu/renderer.ts の clip）と同じ面・同じ多角形・同じ縁の帯と疑似の蓋。
	// set("clip") の間だけ派生プログラム（glsl.ts *_CLIP_*）と uniform block（ClipP・binding 0）を作って使う。切らない描画は 1 本も変えない。
	// 面は描く原点からの相対（K を CPU の f64 で）＝対象と原点の組ごとに 1 スロット（フレームの初めに空にして、使う時に詰める）。
	let clip: ClipNorm | null = null;
	interface ClipProgs { fill: WebGLProgram; line: WebGLProgram; globe: WebGLProgram; bld: WebGLProgram; terrain: WebGLProgram; mesh: WebGLProgram; meshTex: WebGLProgram; mdFill: WebGLProgram | null; mdLine: WebGLProgram | null; mdBld: WebGLProgram | null }
	const CLIP_STRIDE = Math.ceil(CLIP_F32 * 4 / Math.max(256, gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number)) * Math.max(256, gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT) as number);
	const CLIP_SLOTS_MAX = 16;
	let clipUBO: WebGLBuffer | null = null;
	const clipCPU = new Float32Array(CLIP_F32);
	let clipFr: { tp: Record<string, ClipPlane[]>; tg: Record<string, ClipPoly | null>; dpr: number; slots: Map<string, number> } | null = null;
	const attrsOf = (p: WebGLProgram): Record<string, number> => {   // 派生の属性を base と同じ位置へ＝VAO を共有する
		const o: Record<string, number> = {}, n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES) as number;
		for (let i = 0; i < n; i++) { const a = gl.getActiveAttrib(p, i); if (a) o[a.name] = gl.getAttribLocation(p, a.name); }
		return o;
	};
	const clipProg = (base: WebGLProgram, vs: string, fs: string): WebGLProgram => {
		const p = programBound(gl, vs, fs, attrsOf(base)), bi = gl.getUniformBlockIndex(p, "ClipP");
		if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, bi, 0);
		return p;
	};
	// 派生の組（c＝切る・s＝影・cs＝両方）＝初めて使う時に作る。影の派生は ShadowP（binding 1）と深度の標本器 2 つ（SH_UNIT・SH_RAW_UNIT）を持つ
	const varPr = new Map<string, ClipProgs>();
	function varProgs(c: boolean, sh: boolean): ClipProgs {
		const key = (c ? "c" : "") + (sh ? "s" : "");
		let P = varPr.get(key); if (P) return P;
		const mk = (base: WebGLProgram, fam: ShadowFam, vs0: string, fs0: string, vsC: string, fsC: string): WebGLProgram => {
			let vs = c ? vsC : vs0, fs = c ? fsC : fs0;
			if (sh) { vs = shadowVS(fam, vs); fs = shadowFS(fam, fs); }
			const p = clipProg(base, vs, fs);
			if (sh) {
				const bi = gl.getUniformBlockIndex(p, "ShadowP"); if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, bi, 1);
				gl.useProgram(p); gl.uniform1i(loc(gl, p, "u_shTex"), SH_UNIT); gl.uniform1i(loc(gl, p, "u_shRaw"), SH_RAW_UNIT);
			}
			return p;
		};
		P = {
			fill: mk(fillProg0, "fill", FILL_VS, FILL_FS, FILL_CLIP_VS, FILL_CLIP_FS), line: mk(lineProg0, "line", LINE_VS, LINE_FS, LINE_CLIP_VS, LINE_CLIP_FS), globe: mk(globeProg0, "globe", GLOBE_VS, GLOBE_FS, GLOBE_VS, GLOBE_CLIP_FS),
			bld: mk(bldProg0, "bld", BUILDING_VS, BUILDING_FS, BUILDING_CLIP_VS, BUILDING_CLIP_FS), terrain: mk(terrainProg0, "terrain", TERRAIN_VS, TERRAIN_FS, TERRAIN_CLIP_VS, TERRAIN_CLIP_FS),
			mesh: mk(meshProg0, "mesh", MESH_VS, MESH_FS, MESH_CLIP_VS, MESH_CLIP_FS), meshTex: mk(meshTexProg0, "meshTex", MESH_TEX_VS, MESH_TEX_FS, MESH_TEX_CLIP_VS, MESH_TEX_CLIP_FS),
			mdFill: md0 ? ptProg(mk(md0.fill, "fill", FILL_MD_VS, FILL_FS, FILL_MD_CLIP_VS, FILL_CLIP_FS)) : null, mdLine: md0 ? ptProg(mk(md0.line, "line", LINE_MD_VS, LINE_FS, LINE_MD_CLIP_VS, LINE_CLIP_FS)) : null,
			mdBld: md0 ? mk(md0.bld, "bld", BUILDING_MD_VS, BUILDING_FS, BUILDING_MD_CLIP_VS, BUILDING_CLIP_FS) : null,
		};
		ltProg(P.line); if (P.mdLine) ltProg(P.mdLine);
		gl.useProgram(null);
		varPr.set(key, P);
		return P;
	}
	function varFree(test: (key: string) => boolean): void {
		for (const [k, P] of [...varPr]) if (test(k)) { for (const p of Object.values(P)) if (p) gl.deleteProgram(p); varPr.delete(k); }
	}
	// このフレームに描くプログラムを選ぶ（切る・影＝派生・どちらも無し＝base）
	function progSwap(c: boolean, sh: boolean): void {
		const P = c || sh ? varProgs(c, sh) : null;
		fillProg = P ? P.fill : fillProg0; lineProg = P ? P.line : lineProg0; globeProg = P ? P.globe : globeProg0; bldProg = P ? P.bld : bldProg0;
		terrainProg = P ? P.terrain : terrainProg0; meshProg = P ? P.mesh : meshProg0; meshTexProg = P ? P.meshTex : meshTexProg0;
		if (md && md0) { md.fillProg = P?.mdFill || md0.fill; md.lineProg = P?.mdLine || md0.line; md.bldProg = P?.mdBld || md0.bld; }
	}
	// 対象 target を原点 o（[lon,lat]）から測る面を binding 0 へ。切らないフレームは何もしない
	function clipBind(target: string, o: ArrayLike<number> | null | undefined): void {
		if (!clipFr) return;
		const ll = o || [0, 0], key = `${target}|${ll[0]}|${ll[1]}`;
		let i = clipFr.slots.get(key);
		if (i === undefined) {
			i = clipFr.slots.size % CLIP_SLOTS_MAX;
			const pl = clipFr.tp[target] || [], sty = clip!.style;
			packClip(pl, lonlatTo3D(ll[0], ll[1]), clipCPU, { ...sty, capOn: sty.capOn && pl.length > 0, edgeWidth: sty.edgeWidth * clipFr.dpr }, clipFr.tg[target] || null);
			gl.bindBuffer(gl.UNIFORM_BUFFER, clipUBO); gl.bufferSubData(gl.UNIFORM_BUFFER, i * CLIP_STRIDE, clipCPU);
			clipFr.slots.set(key, i);
		}
		gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, clipUBO, i * CLIP_STRIDE, CLIP_F32 * 4);
	}
	function clipFrame(dpr: number): boolean {   // フレームの初め：切るか・面と多角形・スロットを空に
		const tp = clip ? Object.fromEntries(CLIP_GL_TARGETS.map(k => [k, clipPlanesFor(clip, k)])) : null;
		const tg = clip ? Object.fromEntries(CLIP_GL_TARGETS.map(k => [k, clipPolygonFor(clip, k)])) : null;
		const on = !!tp && CLIP_GL_TARGETS.some(k => tp[k].length > 0 || !!tg![k]);
		if (on && !clipUBO) { clipUBO = gl.createBuffer(); gl.bindBuffer(gl.UNIFORM_BUFFER, clipUBO); gl.bufferData(gl.UNIFORM_BUFFER, CLIP_STRIDE * CLIP_SLOTS_MAX, gl.DYNAMIC_DRAW); }
		clipFr = on ? { tp: tp!, tg: tg!, dpr, slots: new Map() } : null;
		return on;
	}
	// 地形の蓋（WebGPU の packCap と同じ四角）：win＝窓（近＝terrain.mesh・遠＝far.bounds）・面ごとに中心の原点相対と 2 軸（窓の対角の長さ）
	let capProg: WebGLProgram | null = null;
	const capQ = new Float32Array(72);
	function drawCaps(st: GLCamState, planes: ClipPlane[], origin: number[], win: ArrayLike<number>, center: ArrayLike<number>, farPass: boolean, fog: { near: number; far: number; color: ArrayLike<number> }, land: ArrayLike<number>): void {
		if (!capProg) { capProg = program(gl, CLIP_CAP_VS, CLIP_CAP_FS); const bi = gl.getUniformBlockIndex(capProg, "ClipP"); if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(capProg, bi, 0); }
		const N = terrain!.G - 1, O = lonlatTo3D(origin[0], origin[1]);
		setCommonUniforms(capProg, st, origin, land);
		gl.uniform1f(loc(gl, capProg, "u_fogNear"), fog.near); gl.uniform1f(loc(gl, capProg, "u_fogFar"), fog.far);
		gl.uniform3f(loc(gl, capProg, "u_fogColor"), fog.color[0], fog.color[1], fog.color[2]);
		gl.uniform4f(loc(gl, capProg, "u_mesh"), win[0], win[1], win[2], win[3]);
		gl.uniform4f(loc(gl, capProg, "u_capG"), (origin[0] - win[0]) / win[2] * N, (origin[1] - win[1]) / win[3] * N, N / win[2], N / win[3]);
		gl.uniform4f(loc(gl, capProg, "u_capH"), N, farPass ? 1 : 0, 0, 0);
		const C = lonlatTo3D(center[0], center[1]), cl0 = Math.cos(center[1] * Math.PI / 180);
		const L = Math.min(1.2, Math.hypot(win[2] * cl0, win[3]) * Math.PI / 180);   // 窓の対角（単位球）
		const up = mat.norm(C), a0 = center[0] * Math.PI / 180, east = [-Math.sin(a0), 0, Math.cos(a0)];
		capQ.fill(0);
		planes.forEach(([nx, ny, nz, c], i) => {
			const n = [nx, ny, nz], dc = nx * C[0] + ny * C[1] + nz * C[2] - c;
			const P0 = [C[0] - dc * nx, C[1] - dc * ny, C[2] - dc * nz];
			const ref = Math.abs(nx * up[0] + ny * up[1] + nz * up[2]) > 0.9 ? east : up;
			const t1 = mat.norm([n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]]);
			const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
			const q = i * 12;
			capQ[q] = P0[0] - O[0]; capQ[q + 1] = P0[1] - O[1]; capQ[q + 2] = P0[2] - O[2];
			capQ[q + 4] = t1[0] * L; capQ[q + 5] = t1[1] * L; capQ[q + 6] = t1[2] * L;
			capQ[q + 8] = t2[0] * L; capQ[q + 9] = t2[1] * L; capQ[q + 10] = t2[2] * L;
		});
		gl.uniform4fv(loc(gl, capProg, "u_capQ"), capQ);
		clipBind("terrain", origin);
		gl.bindVertexArray(emptyVAO);
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, Math.min(planes.length, 6));
	}
	function clipFree(): void {
		if (capProg) gl.deleteProgram(capProg);
		capProg = null;
		if (clipUBO) gl.deleteBuffer(clipUBO);
		clipUBO = null; clipFr = null;
		varFree(k => k.includes("c"));
		progSwap(false, false);
	}	// ── 建物の影の WebGL2 版（P0 #3・2026-10-25）＝WebGPU（gpu/renderer.ts の shadow）と同じ窓・同じカスケード・同じ ShadowP の並び（shadow.ts の純関数）。
	// set("shadow", {on, time?, darkness?}) の間だけ深度の 2D 配列・FBO・派生プログラムを作る。z13 以上・太陽が地平線の上の時だけ窓が立つ。
	// 落とす側は毎フレーム描き直す（WebGPU の「窓と中身が同じなら描かない」は未移植）
	const SH_N = rOpts.lowMem ? 1024 : 2048, SH_LAYERS = rOpts.lowMem ? 2 : 3;
	const SH_UNIT = 18, SH_RAW_UNIT = 19;   // 0〜17 は埋まっている（PAT_UNIT 16・PT_UNIT 17）
	const NEAR_UNIT = 20;   // 近景層の標高（ELEV を持つ全プログラムが参照＝far の unit8 と同じ常時結合）
	const ENV_UNIT = 22;
const PAINT_UNIT = 23, DRAPE_UNIT = 21;   // 模型の塗る絵（meshPaint）・3D Tiles に重ねる絵（meshDrape）   // Cesium の模型の鏡面の環境（立方体図・setMeshEnvironmentMap）＝u_csEnvMap。samplerCube は既定の unit 0 に置くと 2D と衝突する＝全プログラムでここへ向ける
	const SH_PEN_K = 0.018, SH_SEARCH = 4, SH_FADE_R0 = 0.7;   // 半影の係数・遮る物を探す半径（texel）・基の窓の縁のフェード（WebGPU と同値）
	let shadow: { on: boolean; time?: number; darkness?: number } = { on: false };
	let shGL: { tex: WebGLTexture; fbos: WebGLFramebuffer[]; sampC: WebGLSampler; sampR: WebGLSampler; ubo: WebGLBuffer; cpu: Float32Array; cast: Map<string, WebGLProgram> } | null = null;
	function shadowRes(): NonNullable<typeof shGL> {
		if (shGL) return shGL;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
		gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.DEPTH_COMPONENT32F, SH_N, SH_N, SH_LAYERS);
		gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
		const fbos = Array.from({ length: SH_LAYERS }, (_, i) => {
			const f = gl.createFramebuffer()!;
			gl.bindFramebuffer(gl.FRAMEBUFFER, f);
			gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, tex, 0, i);
			gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
			return f;
		});
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		const samp = (cmp: boolean): WebGLSampler => {
			const sp = gl.createSampler()!;
			gl.samplerParameteri(sp, gl.TEXTURE_MIN_FILTER, cmp ? gl.LINEAR : gl.NEAREST); gl.samplerParameteri(sp, gl.TEXTURE_MAG_FILTER, cmp ? gl.LINEAR : gl.NEAREST);
			gl.samplerParameteri(sp, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.samplerParameteri(sp, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			if (cmp) { gl.samplerParameteri(sp, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.samplerParameteri(sp, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL); }
			return sp;
		};
		const ubo = gl.createBuffer()!;
		gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferData(gl.UNIFORM_BUFFER, 56 * 4, gl.DYNAMIC_DRAW);
		shGL = { tex, fbos, sampC: samp(true), sampR: samp(false), ubo, cpu: new Float32Array(56), cast: new Map() };
		return shGL;
	}
	function shadowFree(): void {
		if (!shGL) return;
		gl.deleteTexture(shGL.tex); for (const f of shGL.fbos) gl.deleteFramebuffer(f);
		gl.deleteSampler(shGL.sampC); gl.deleteSampler(shGL.sampR); gl.deleteBuffer(shGL.ubo);
		for (const p of shGL.cast.values()) gl.deleteProgram(p);
		shGL = null;
		varFree(k => k.includes("s"));
		progSwap(false, false);
	}
	// 落とす側の行列：z を 2z−w へ（GL の深度＝0.5·z/w＋0.5 が WebGPU の z/w と同じ 0..1 になる）
	const castMvp = (m: ArrayLike<number>): number[] => { const o = Array.from(m); for (let k = 0; k < 4; k++) o[2 + 4 * k] = 2 * m[2 + 4 * k] - m[3 + 4 * k]; return o; };
	type CastKind = "terrain" | "bld" | "mdBld" | "mesh" | "meshTex" | "meshTexCut";
	function castProg(kind: CastKind, c: boolean): WebGLProgram {
		const key = kind + (c ? "|c" : ""), S = shGL!;
		let p = S.cast.get(key); if (p) return p;
		const [base, vs0, vsC]: [WebGLProgram, string, string] = kind === "terrain" ? [terrainProg0, TERRAIN_VS, TERRAIN_CLIP_VS] : kind === "bld" ? [bldProg0, BUILDING_VS, BUILDING_CLIP_VS]
			: kind === "mdBld" ? [md0!.bld, BUILDING_MD_VS, BUILDING_MD_CLIP_VS] : kind === "mesh" ? [meshProg0, MESH_VS, MESH_CLIP_VS] : [meshTexProg0, MESH_TEX_VS, MESH_TEX_CLIP_VS];
		const fs = kind === "meshTexCut" ? (c ? CAST_TEX_CLIP_FS : CAST_TEX_FS) : (c ? CAST_CLIP_FS : CAST_FS);
		p = clipProg(base, castVS(c ? vsC : vs0), fs);
		S.cast.set(key, p);
		return p;
	}
	// 1 層の深度を描く（窓 win・層 layer）。地形（terrOn）・基図の押し出し・建物メッシュと模型（半透明・noCast・非表示の区は落とさない）
	function drawCasters(win: ShadowWindow, layer: number, st: GLCamState, opts: GLDrawOptions | null | undefined, terrOn: boolean, clipOn: boolean, land: ArrayLike<number>, mq: number[] | null, fogT: { near: number; far: number }): void {
		const S = shGL!, M = castMvp(win.mvp), sS = { ...st, mvp: Float64Array.from(M), mvp32: Float32Array.from(M) } as GLCamState;
		gl.bindFramebuffer(gl.FRAMEBUFFER, S.fbos[layer]);
		gl.viewport(0, 0, SH_N, SH_N);
		gl.disable(gl.STENCIL_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
		gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(3, 0);   // WebGPU の depthBiasSlopeScale 3 と同じ＝斜めに受ける平地（地形）の縞を消す
		gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true);
		gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
		const mo = (scenes.main.origin || [0, 0]) as number[];
		const meshQ = (p: WebGLProgram) => { gl.uniform4f(loc(gl, p, "u_meshQ"), mq ? mq[0] : 0, mq ? mq[1] : 0, mq ? mq[2] : 1, mq ? mq[3] : 1); gl.uniform1f(loc(gl, p, "u_meshG"), mq ? terrain!.G : 0); };
		if (terrOn && terrain) {
			const p = castProg("terrain", clipOn);
			setCommonUniforms(p, sS, terrOrigin, land);
			gl.uniform1f(loc(gl, p, "u_fogNear"), fogT.near); gl.uniform1f(loc(gl, p, "u_fogFar"), fogT.far);   // 地形の頂点と同じ遠景の平ら化
			const mh = terrain.mesh;
			gl.uniform4f(loc(gl, p, "u_mesh"), mh[0], mh[1], mh[2], mh[3]);
			clipBind("terrain", terrOrigin);
			gl.bindVertexArray(terrain.vao);
			gl.drawElements(gl.TRIANGLES, terrain.count, gl.UNSIGNED_INT, 0);
		}
		const noBld = !!(opts && (opts.skipMain || opts.noBld));
		if (!noBld && scenes.main.bld) {
			const p = castProg("bld", clipOn);
			setCommonUniforms(p, sS, mo, land); meshQ(p);
			clipBind("buildings", mo);
			gl.bindVertexArray((scenes.main.bld as GLBld).vao);
			gl.drawArrays(gl.TRIANGLES, 0, (scenes.main.bld as GLBld).count);
		} else if (!noBld && scenes.main.md && scenes.main.md.bld && md0) {
			const p = castProg("mdBld", clipOn);
			setCommonUniforms(p, sS, mo, land); meshQ(p);
			clipBind("buildings", mo);
			gl.bindVertexArray(md!.bldVAO);
			for (const e of scenes.main.md.bld) { gl.uniform2fv(loc(gl, p, "u_tileOff"), e.origins); md!.ext.multiDrawArraysWEBGL(gl.TRIANGLES, e.firsts, 0, e.counts, 0, e.counts.length); }
		}
		const O = lonlatTo3D(mo[0], mo[1]);
		const common = new Set<WebGLProgram>();
		for (const b of meshes.values()) {
			if (meshHidden.has(b.ward) || b.noCast || b.blend) continue;
			if (!bboxInShadowWindow(win.mvp, b.bbox, SH_CAST_HMAX_M)) continue;   // 窓に太陽方向で投げて掛からない束は落とさない
			const kind: CastKind = b.textured ? (b.cut > 0 ? "meshTexCut" : "meshTex") : "mesh", p = castProg(kind, clipOn);
			if (!common.has(p)) { common.add(p); setCommonUniforms(p, sS, [0, 0], land); } else gl.useProgram(p);
			if (kind === "meshTexCut") { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, b.tex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(loc(gl, p, "u_tex"), 7); gl.uniform1f(loc(gl, p, "u_alphaCut"), b.cut); }
			if (clipOn) { clipBind(b.textured ? "models" : "buildings", mo); gl.uniform3f(loc(gl, p, "u_clO"), b.origin[0] - O[0], b.origin[1] - O[1], b.origin[2] - O[2]); }
			const lb = b.noLift ? null : b.drape ? DRAPE_ALL : elev.liftBounds;
			gl.uniform4f(loc(gl, p, "u_liftBounds"), lb ? lb[0] : 0, lb ? lb[1] : 0, lb ? lb[2] : 0, lb ? lb[3] : 0);
			gl.uniform3f(loc(gl, p, "u_meshOrigin"), b.origin[0], b.origin[1], b.origin[2]);
			gl.uniform1f(loc(gl, p, "u_xfOn"), b.xf ? 1 : 0);
			if (b.xf) { gl.uniformMatrix3fv(loc(gl, p, "u_xfL"), false, b.xf.subarray(0, 9)); gl.uniform3f(loc(gl, p, "u_xfT"), b.xf[9], b.xf[10], b.xf[11]); }
			const cM = mat.transform(M, [b.origin[0], b.origin[1], b.origin[2], 1]);
			gl.uniform4f(loc(gl, p, "u_clipMesh"), cM[0], cM[1], cM[2], cM[3]);
			gl.bindVertexArray(b.vao);
			gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, 0);
		}
		gl.bindVertexArray(null);
	}
	// このフレームの影：窓（null＝影なし）を立て、落とす側を描き、受け手の ShadowP（binding 1）と深度（SH_UNIT・SH_RAW_UNIT）を置く
	function shadowFrame(cam: CameraPose, st: GLCamState, opts: GLDrawOptions | null | undefined, terrOn: boolean, clipOn: boolean, land: ArrayLike<number>, mq: number[] | null, fogT: { near: number; far: number }): boolean {
		const W = canvas.width, H = canvas.height;
		const win = shadow.on && cam.zoom >= 13 ? shadowWindow(sunVector(shadow.time ?? clockNow(view.clock)), cam.center, shadowHalfM(cam.zoom, cam.center[1], W, H, cam.dpr || 1), SH_N) : null;
		if (!win) return false;
		let cas: ShadowCascade[] = [];
		if (SH_LAYERS > 1) {   // カスケード＝画面の 7×7 の格子を地面へ戻し、手前の地面だけを覆う細かい窓
			const ground: number[][] = [];
			for (let j = 0; j <= 6; j++) for (let i = 0; i <= 6; i++) { const ll = unproject(st, W * i / 6, H * j / 6); if (ll) ground.push(lonlatTo3D(ll[0], ll[1])); }
			cas = shadowCascades(win, ground, st.eye, SH_N, SH_LAYERS - 1);
		}
		const S = shadowRes(), prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
		const wins: ShadowWindow[] = [win, ...cas];
		wins.forEach((w, i) => drawCasters(w, i, st, opts, terrOn, clipOn, land, mq, fogT));
		gl.disable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(0, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
		gl.viewport(0, 0, W, H);
		gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		// 受け手の錨＝窓の中心（視点の注視点）の f32 値。旧＝main の原点（u_originPt）＝基図のタイルが無い地図（@ortho-earth/cesium）では
		// 経度 0・緯度 0 のまま＝8000km 離れた錨から f32 で相対位置を取ると 1m 近くずれ、模型が 1m ずれた自分の影をまだらに被った（2026-10-27）。
		// 窓の中心なら受け手（模型の原点・球の床の当たり・地形の頂点）との差が窓の幅（km）以下＝f32 で mm。clipT は同じ f32 の錨から f64 で。
		const aC = lonlatTo3D(cam.center[0], cam.center[1]), aPt = [Math.fround(aC[0]), Math.fround(aC[1]), Math.fround(aC[2])], cT = mat.transform(win.mvp, [aPt[0], aPt[1], aPt[2], 1]), u = S.cpu;
		u.fill(0);
		u.set(win.mvp, 0);
		u[16] = cT[0]; u[17] = cT[1]; u[18] = cT[2]; u[19] = cT[3];
		u[20] = aPt[0]; u[21] = aPt[1]; u[22] = aPt[2];
		u[24] = shadowDarkness(win.alt, shadow.darkness); u[27] = SH_FADE_R0;
		const order = [...cas.map((c, k) => ({ w: c as ShadowWindow, s: c.s, ox: c.ox, oy: c.oy, layer: k + 1 })), { w: win, s: 1, ox: 0, oy: 0, layer: 0 }];
		order.forEach((e, k) => {
			u[28 + k * 4] = e.s; u[29 + k * 4] = e.ox; u[30 + k * 4] = e.oy; u[31 + k * 4] = e.layer;
			u[40 + k * 4] = shadowBias(e.w); u[41 + k * 4] = 1 / SH_N; u[42 + k * 4] = e.w.texelM; u[43 + k * 4] = Math.min(1 / Math.tan(win.alt), 6) * e.w.texelM * SH_N / win.zRangeM;
		});
		u[52] = order.length; u[53] = win.zRangeM; u[54] = SH_PEN_K; u[55] = SH_SEARCH;
		gl.bindBuffer(gl.UNIFORM_BUFFER, S.ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, u);
		gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, S.ubo);
		for (const [unit, sp] of [[SH_UNIT, S.sampC], [SH_RAW_UNIT, S.sampR]] as [number, WebGLSampler][]) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D_ARRAY, S.tex); gl.bindSampler(unit, sp); }
		gl.activeTexture(gl.TEXTURE0);
		shStat = { alt: +(win.alt * 180 / Math.PI).toFixed(1), layers: wins.length };
		return true;
	}
	let shStat: { alt: number; layers: number } | null = null;

	const rasAtlasProg = program(gl, RASTER_ATLAS_VS, RASTER_ATLAS_FS);   // 画像タイル層（raster.js）＝タイルを地面アトラスへ合成（RTT ドレープ）
	// ベクタ塗りを地面アトラスへ焼く（3D 限定）。属性位置は塗り本体の VAO（fillProg／md.fillProg で束ねた）と一致させる＝リンク前に bindAttribLocation
	const atlasFillProg = programBound(gl, ATLAS_FILL_VS, ATLAS_FILL_FS, { a_delta: gl.getAttribLocation(fillProg, "a_delta"), a_color: gl.getAttribLocation(fillProg, "a_color") });
	const drapes = new Map<string, { tex: WebGLTexture; map: DrapeMap }>(), drU = new Float32Array(12);   // 3D Tiles に重ねる絵（set "meshDrape"）＝id → 絵と窓の平面写像（drape.ts）
	const whiteTex = gl.createTexture()!;   // テクスチャ無しの模型バッチ用（頂点色×1）
	gl.bindTexture(gl.TEXTURE_2D, whiteTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255])); gl.bindTexture(gl.TEXTURE_2D, null);
	function meshTexture(t: MeshTexIn | null | undefined): WebGLTexture {   // 模型のテクスチャ（ImageBitmap か {rgba,w,h}）。無ければ白 1x1。glTF の uv 原点＝画像左上＝texImage2D の先頭行＝flip 不要
		if (!t) return whiteTex;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
		if (t.bitmap) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, t.bitmap);
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.w, t.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, t.rgba);
		gl.generateMipmap(gl.TEXTURE_2D);   // ミップ＝必須（遠景・斜めのちらつき）。WebGL2 は NPOT でも可
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		const aniso = gl.getExtension("EXT_texture_filter_anisotropic"); if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1));   // 壁面の斜め視＝異方性
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		gl.bindTexture(gl.TEXTURE_2D, null);
		return tex;
	}
	const stencilProg = program(gl, STENCIL_VS, STENCIL_FS);   // 塗りの stencil パス（fan→巻き数）
	const coverProg = program(gl, GLOBE_VS, COVER_FS);          // 塗りの cover パス（stencil≠0 を塗る）
	const contourProg = program(gl, GLOBE_VS, CONTOUR_FS);     // 等高線（真俯瞰でだけ茶の等高線を敷く）
	const starsProg = program(gl, STARS_VS, STARS_FS);         // 星空（z<4・globeパスの下敷き）
	const starLineProg = program(gl, STARS_VS, STARLINE_FS);   // 星座線（VS共用・gl.LINES）
	const nightProg = program(gl, GLOBE_VS, NIGHT_FS);         // 夜面（現在時刻の太陽＝平行光源・全レイヤの上）
	// 線の角＝index の 4 頂点（perf plan P3・既定）／旧 6 頂点（?quad4=0）。線分 1 本の VS 起動 6→4。element buffer は各 line VAO に bind（ELEMENT bind は VAO 状態）
	const QUAD4 = rOpts.quad4 !== false;
	const cornerBuf = buffer(gl, QUAD4 ? CORNERS4 : CORNERS);
	let lineIdxBuf: WebGLBuffer | null = null;
	if (QUAD4) { lineIdxBuf = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIdxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, LINE_IDX, gl.STATIC_DRAW); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null); }
	const drawLineInst = (n: number): void => { if (QUAD4) gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0, n); else gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n); };
	const emptyVAO = gl.createVertexArray();
	// 標高アトラスは R16F（half-float）。R32F は線形補間に OES_texture_float_linear が必須で、非対応GPU
	// （古い4GB機など）では NEAREST に落ちて地形が市松模様になる（R01 の高密度で顕著）。R16F は WebGL2 の
	// コアで線形フィルタ可（拡張不要）＝全デバイスで滑らか。おまけにアトラスの GPU メモリが半分（4B→2B/texel）
	// ＝jetsam にも効く。標高はメートル値を half-float で格納＝精度は十分（~4km で ±2m・低地は ±0.25m 級）。
	// 標高（GEBCO/ALOS）：テクスチャ＋地形格子メッシュ
	let elevTex: WebGLTexture | null = null, elev: ElevState = { bounds: [0, 0, 1, 0], scale: 0, has: 0 }, terrain: TerrainMesh | null = null;
	// 遠景層（far）＝近窓の外を受け持つ粗い R10 第2アトラス（terrain.js が深ズーム×チルトで常設）。unit8（2-5=メッシュマスク・6=md線・7=gint elev と不干渉）
	let farTex: WebGLTexture | null = null, far: FarState = { bounds: [0, 0, 1, 0], has: 0, edgeFade: 0 };
	let nearTex: WebGLTexture | null = null, near: FarState = { bounds: [0, 0, 1, 0], has: 0, edgeFade: 0 };   // 近景層（1 セル・順 1a 2026-10-28）＝unit NEAR_UNIT
	// 気候場テクスチャ（全球ハイプソの cross-blend 用・view.worldHypso.clim の URL から一度だけ取得）。
	// 未着の間はシェーダが緯度近似へフォールバック（u_hasClim=0）＝1-2フレームの色ズレのみ。
	let climTex: WebGLTexture | null = null, climLoading = false;
	function ensureClimTex(url: string | null | undefined): void {
		if (climTex || climLoading || !url) return;
		climLoading = true;
		fetch(url!).then(r => r.blob()).then(b => createImageBitmap(b, { premultiplyAlpha: "none" })).then(bm => {
			climTex = gl.createTexture();
			gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D, climTex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bm);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);          // 経度ラップ（±180の継ぎ目）
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.activeTexture(gl.TEXTURE0);
			bm.close(); rOpts.requestDraw?.();   // 到着フレームを一枚要求（静止中でも気候色へ差し替わる）
		}).catch(e => { console.warn("[hypso] climate texture load failed (continuing with latitude approximation)", e); });
	}
	// ユーザ COG アトラス（gadgets/cog.js が geopbf/cog の renderTo で等経緯度 RGBA に warp 済みを渡す）。
	// unit9＝空き（1=elev・2-5=メッシュマスク・6=md線・7=gint elev・8=far・12=clim と不干渉）。
	// 見比べ（pair）＝上下 2 枚組のアトラス・cogSplit＝境の経度（null＝境なし＝A だけ）
	let cogTex: WebGLTexture | null = null, cogSt = { bbox: [0, 0, 1, 1], has: 0, bytes: 0, pair: 0, half: 0 }, cogSplitLon: number | null = null;
	function setCogTex(data: CogInput | null | undefined): void {
		if (!data) {   // 解放
			if (cogTex) gl.deleteTexture(cogTex);
			cogTex = null; cogSt = { bbox: [0, 0, 1, 1], has: 0, bytes: 0, pair: 0, half: 0 };
			return;
		}
		const { rgba, w, h, bboxLL, pair } = data;   // bboxLL=[west,south,east,north]・pair＝h は 2 枚分
		if (!cogTex) cogTex = gl.createTexture();
		gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, cogTex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba.buffer || rgba, rgba.byteOffset || 0, rgba.byteLength ?? rgba.length));
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.activeTexture(gl.TEXTURE0);
		cogSt = { bbox: [bboxLL[0], bboxLL[1], bboxLL[2] - bboxLL[0], bboxLL[3] - bboxLL[1]], has: 1, bytes: w * h * 4, pair: pair ? 1 : 0, half: 0.5 / h };
	}
	// 境の u（窓の経度幅で正規化）＝境なしは 2（どの u も A 側）
	const cogSplitU = (): number => cogSplitLon == null ? 2 : (cogSplitLon - cogSt.bbox[0]) / cogSt.bbox[2];
	// ⚠サンプラは has=0 でも毎フレーム unit9 へ向ける（未設定＝unit0 整数テクスチャの轍＝elev/clim と同族）
	function bindCog(prog: WebGLProgram): void {
		gl.uniform1i(loc(gl, prog, "u_cogTex"), 9);
		gl.uniform1f(loc(gl, prog, "u_hasCog"), cogSt.has);
		gl.uniform4f(loc(gl, prog, "u_cogPair"), cogSt.pair, cogSplitU(), cogSt.half, 0);
		gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, cogSt.has ? cogTex : null); gl.activeTexture(gl.TEXTURE0);
	}
	// fill 系: COG uv＝off+dLL×inv の係数を JS の f64 で前計算（シーン原点ごと）＝f32 絶対経緯度のジッタ根治
	function setCogScene(prog: WebGLProgram, origin: ArrayLike<number> | null | undefined): void {
		if (!cogSt.has) return;
		const [W, S, sLon, sLat] = cogSt.bbox, o = origin || [0, 0];
		gl.uniform4f(loc(gl, prog, "u_cogOffInv"), (o[0] - W) / sLon, (o[1] - S) / sLat, 1 / sLon, 1 / sLat);
	}
	// terrain: メッシュ窓（u_mesh と同値）→COG uv の変換係数（f64 前計算）
	function setCogMesh(mh: ArrayLike<number>): void {
		if (!cogSt.has) return;
		const [W, S, sLon, sLat] = cogSt.bbox;
		gl.uniform4f(loc(gl, terrainProg, "u_cogMesh"), (mh[0] - W) / sLon, (mh[1] - S) / sLat, mh[2] / sLon, mh[3] / sLat);
	}
	// ── 地面アトラス（RTT ドレープ・2026-09-21）＝ラスタ基図 → ベクタ塗り（3D 時）→ ラスタ重ね を 3 段窓（近/中/遠）へ合成し、
	// 地形・球・塗りの FS が gndMix で画素標本化する（COG と同じ配線＝地形面そのものに写る）。合成は「窓（量子化）・ラスタの rev・
	// シーンの rev・ゲート」の鍵が変わった時だけ＝静止中はゼロコスト。unit10＝合成時のタイル・unit13/14/15＝窓 0/1/2。
	// raster.js の契約：rasterTex/rasterMesh/rasterFree/setRasterDraws（rd={rev,hideFills,layers}）。
	let rasterDraws: GLRasterDraws | null = null, memRaster = 0, dbgC: DbgCounters | null = null, sceneRev = 0;
	const gnd = { w: [null, null, null, null] as (GndWin | null)[], n: 0, key: "", tiles: 0, bytes: 0, rasterOn: false, fillsIn: false, faces: 0 };   // faces＝直近合成で焼いた gint 面の層数（窓の和）   // w[i]＝{ tex, fbo, size, win:[W,S,spanLon,spanLat], bytes }・段は細かい順（前景/近/中/遠・前景は強いチルト時のみ）
	function rasterTex(bitmap: ImageBitmap): GLRasterTex {
		const tex = gl.createTexture()!;
		gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // 画像の行0＝北＝メッシュ v=0（反転しない）・α は合成 FS が掛ける
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
		gl.generateMipmap(gl.TEXTURE_2D);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
		const bytes = Math.round(bitmap.width * bitmap.height * 4 * 4 / 3);
		memRaster += bytes;
		return { kind: "tex", tex, bytes, w: bitmap.width, h: bitmap.height, nearest: false };
	}
	function rasterMesh({ pos, uv, idx }: TileMesh): GLRasterMesh {
		const vao = gl.createVertexArray()!;
		const bPos = buffer(gl, pos), bUv = buffer(gl, uv);
		gl.bindVertexArray(vao);
		attrib(gl, rasAtlasProg, "a_delta", bPos, 2);
		attrib(gl, rasAtlasProg, "a_uv", bUv, 2);
		const ibo = gl.createBuffer()!;
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		const bytes = pos.byteLength + uv.byteLength + idx.byteLength;
		memRaster += bytes;
		return { kind: "mesh", vao, bufs: [bPos, bUv, ibo], count: idx.length, bytes };
	}
	function rasterFree(h: GLRasterTex | GLRasterMesh | null | undefined): void {
		if (!h) return;
		if (h.kind === "tex") { gl.deleteTexture(h.tex); }
		else { for (const b of h.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(h.vao); }
		memRaster -= h.bytes || 0;
	}
	function setRasterDraws(rd: RasterDraws | null): void { rasterDraws = rd as GLRasterDraws | null; }
	function gndAlloc(size: number): GndWin {
		const tex = gl.createTexture()!;
		gl.activeTexture(gl.TEXTURE13); gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const aniso = gl.getExtension("EXT_texture_filter_anisotropic"); if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1));
		gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
		const fbo = gl.createFramebuffer()!;
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		const rb = gl.createRenderbuffer()!;   // stencil＝gint 面の巻き数塗り（stencil-then-cover）を窓へ焼くため（STENCIL_INDEX8＝1B/px）
		gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, size, size);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
		gl.bindRenderbuffer(gl.RENDERBUFFER, null);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		const bytes = Math.round(size * size * 4 * 4 / 3) + size * size;
		gnd.bytes += bytes;
		return { tex, fbo, rb, size, win: [0, 0, 1, 1], bytes };
	}
	function gndFree1(a: GndWin | null | undefined): void { if (!a) return; gl.deleteFramebuffer(a.fbo); gl.deleteTexture(a.tex); if (a.rb) gl.deleteRenderbuffer(a.rb); gnd.bytes -= a.bytes; }
	let groundHook: ((cam: CameraPose, target: GintAtlasTarget) => number) | null = null, groundSig: (() => string) | null = null;   // gint の面を窓へ焼くフック（renderworker が bakeFaces/bakeSig を結線）：fn(cam, { fbo, win, size })・sig()＝合成鍵
	function setGroundHook(fn?: ((cam: CameraPose, target: GintAtlasTarget) => number) | null, sig?: (() => string) | null): void { groundHook = fn || null; groundSig = sig || null; }
	// ラスタタイルを窓へ（order＝"under"|"over"）
	function drawRasterInto(a: GndWin, bb: number[], order: string): void {
		gl.useProgram(rasAtlasProg);
		gl.uniform2f(loc(gl, rasAtlasProg, "u_winInv"), 1 / a.win[2], 1 / a.win[3]);
		gl.uniform1i(loc(gl, rasAtlasProg, "u_tex"), 10);
		gl.activeTexture(gl.TEXTURE10);
		for (const L of rasterDraws!.layers) {
			if (L.order !== order) continue;
			const nearest = L.resampling === "nearest";   // raster-resampling（C4）＝層の設定をテクスチャに掛ける（1 枚のテクスチャは 1 層のもの＝毎回掛け直して安い）
			for (const d of L.draws) {
				const b = d.bounds;
				if (b[2] <= bb[0] || b[0] >= bb[2] || b[3] <= bb[1] || b[1] >= bb[3]) continue;   // 窓と重ならない
				gl.uniform1f(loc(gl, rasAtlasProg, "u_opacity"), L.opacity * (d.a ?? 1));   // a＝到着フェード（raster-fade-duration）
				gl.uniform2f(loc(gl, rasAtlasProg, "u_tileOff"), d.nw[0] - a.win[0], d.nw[1] - a.win[1]);   // CPU f64 で差を取ってから f32
				gl.uniform4f(loc(gl, rasAtlasProg, "u_uvT"), d.uvT[0], d.uvT[1], d.uvT[2], d.uvT[3]);
				gl.bindTexture(gl.TEXTURE_2D, d.tex.tex);
				if (d.tex.nearest !== nearest) {   // nearest＝拡大は最近傍・縮小は最近傍の mip（MapLibre は mip 無しの NEAREST＝球では遠景が暴れるので mip は残す・文書 §4）
					d.tex.nearest = nearest;
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST_MIPMAP_NEAREST : gl.LINEAR_MIPMAP_LINEAR);
					gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
				}
				gl.bindVertexArray(d.mesh.vao);
				gl.drawElements(gl.TRIANGLES, d.mesh.count, gl.UNSIGNED_SHORT, 0);
				gnd.tiles++;
			}
		}
		gl.bindVertexArray(null); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
	}
	// ベクタ塗り（merge 済みシーン＝3D の直描きと同じバッファ）を窓へ。ゲートは直描きと同じ（海の点火・図郭外水域・3D の足元塗り）
	// lo／hi／pick＝li の範囲・利用者の群（#123＝基図の枠を差し込みの境で分けて、間に利用者の塗りを焼く）
	function drawFillsInto(a: GndWin, st: GLCamState, land: ArrayLike<number>, slots: string[], seaOff: boolean, baseA: number, lo = -Infinity, hi = Infinity, pick: LiPick = null): void {
		const inRange = (x: { li: number }): boolean => pick ? pick(x) : x.li >= lo && x.li < hi;
		// ⚠標高サンプラ（水域ゲート）は unit1/8 を引く＝直前の gint パスが整数テクスチャを残していると型不一致でドロー全体が無効＝
		// 塗りが空のアトラスになる（実際に踏んだ 2026-09-21）。draw() 本体と同じく明示的に張り直す（無ければ null＝incomplete＝黒で無害）
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (elev.has && elevTex) ? elevTex : null);
		gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, (far.has && farTex) ? farTex : null);
		gl.activeTexture(gl.TEXTURE0 + NEAR_UNIT); gl.bindTexture(gl.TEXTURE_2D, (near.has && nearTex) ? nearTex : null);
		gl.activeTexture(gl.TEXTURE0);
		for (const slot of slots) {
			const scene = scenes[slot];
			if (scene.md) {
				if (!md!.atlasFillProg) md!.atlasFillProg = ptProg(programBound(gl, ATLAS_FILL_MD_VS, ATLAS_FILL_FS, { a_delta: gl.getAttribLocation(md!.fillProg, "a_delta"), a_color: gl.getAttribLocation(md!.fillProg, "a_color") }));
				const prog = md!.atlasFillProg;
				gl.useProgram(prog); ptBind();   // paint 表の (b) 類
				setCommonUniforms(prog, st, scene.origin, land);   // u_origin（elev ゲートの絶対 ll）＋標高テクスチャ一式
				gl.uniform2f(loc(gl, prog, "u_atlOff"), scene.origin[0] - a.win[0], scene.origin[1] - a.win[1]);
				gl.uniform2f(loc(gl, prog, "u_atlInv"), 1 / a.win[2], 1 / a.win[3]);
				gl.uniform1f(loc(gl, prog, "u_baseAlpha"), baseA);
				gl.bindVertexArray(md!.fillVAO);
				for (const e of scene.md.layers) {
					if (e.kind !== "fill" || !inRange(e) || e.pat) continue;   // 模様の塗り（S-P1-4/5）は地面アトラスに焼かない（3D は次の段）
					const seaFBM = seaFbReal(e.li) != null, waterM = e.li === sea.li || e.li === sea.li2;
					if ((seaFBM || waterM) && seaOff) continue;
					if (bldFill.li >= 0 && e.li === bldFill.li) continue;   // 3D＝フットプリント塗りは伏せる（押し出しに委ねる）
					gl.uniform1f(loc(gl, prog, "u_seaGate"), seaFBM ? 1 : 0);
					gl.uniform1f(loc(gl, prog, "u_pt"), e.pt ? 1 : 0);   // paint 表の (b) 類
					gl.uniform2fv(loc(gl, prog, "u_tileOff"), e.origins);
					md!.ext.multiDrawElementsWEBGL(gl.TRIANGLES, e.counts, 0, gl.UNSIGNED_INT, e.offsets, 0, e.counts.length);
				}
				gl.bindVertexArray(null);
				continue;
			}
			if (!scene.draws.length) continue;
			const prog = atlasFillProg;
			setCommonUniforms(prog, st, scene.origin, land);
			gl.uniform2f(loc(gl, prog, "u_atlOff"), scene.origin[0] - a.win[0], scene.origin[1] - a.win[1]);
			gl.uniform2f(loc(gl, prog, "u_atlInv"), 1 / a.win[2], 1 / a.win[3]);
			gl.uniform1f(loc(gl, prog, "u_baseAlpha"), baseA);
			for (const d of scene.draws) {
				if (d.kind !== "fill" || !inRange(d) || d.pat) continue;   // 模様の塗り（S-P1-4/5）は地面アトラスに焼かない
				const seaFBC = seaFbReal(d.li) != null, waterC = d.li === sea.li || d.li === sea.li2;
				if ((seaFBC || waterC) && seaOff) continue;
				if (bldFill.li >= 0 && d.li === bldFill.li) continue;
				gl.uniform1f(loc(gl, prog, "u_seaGate"), seaFBC ? 1 : 0);
				gl.bindVertexArray(d.vao);
				if (d.idxT) gl.drawElements(gl.TRIANGLES, d.count, d.idxT, 0);
				else gl.drawArrays(gl.TRIANGLES, 0, d.count);
			}
			gl.bindVertexArray(null);
		}
	}
	// 合成の入口（draw の冒頭・鍵が変わった時だけ）。fillsIn＝3D（地形あり）＝塗りはアトラス側へ（直描きは伏せる）
	function composeGround(cam: CameraPose, st: GLCamState, land: ArrayLike<number>, fillsIn: boolean, slots: string[]): void {
		const rasterOn = !!(rasterDraws && rasterDraws.layers.length);
		const wantFills = fillsIn && !(rasterOn && rasterDraws!.hideFills);
		gnd.rasterOn = rasterOn; gnd.fillsIn = fillsIn;
		if (!rasterOn && !wantFills && !(fillsIn && groundHook)) { gnd.n = 0; gnd.key = ""; gnd.tiles = 0; gnd.faces = 0; return; }
		const wins = groundWindows(cam, canvas.width, canvas.height, far.has ? far.maxElev || 0 : 0);
		const seaOff = cam.zoom < sea.minzoom, baseA = view.baseAlpha ?? 1;
		// 利用者の vector の塗り（段 8⑤）＝基図の塗りの後・gint の面の前。ラスタ基図の hideFills と基図の濃さ（baseAlpha）には従わない（利用者のデータ）
		const userIn = fillsIn && slots.indexOf("user") >= 0, baseSlots = userIn ? slots.filter(x => x !== "user") : slots;
		const key = windowsKey(wins) + `|${rasterOn ? rasterDraws!.rev : -1}|${wantFills ? sceneRev + ":" + baseSlots.join("") : -1}|${seaOff}|${baseA}|${bldFill.li}|${fillsIn && groundHook ? (groundSig ? groundSig() : "") : -1}` + (userIn ? `|u${sceneRev}:${userAnchor.rev}` : "");   // userAnchor.rev＝差し込む位置が変わった（#123）
		if (key === gnd.key) return;
		gnd.key = key; gnd.tiles = 0; gnd.faces = 0;
		const N = rOpts.lowMem ? 1024 : 2048, sizes = groundSizes(wins, N);   // 前景・近は N（ground.ts）
		for (let i = 0; i < wins.length; i++) {
			const bb = wins[i], size = sizes[i];
			if (!gnd.w[i] || gnd.w[i]!.size !== size) { if (gnd.w[i]) gndFree1(gnd.w[i]); gnd.w[i] = gndAlloc(size); }
			const a = gnd.w[i]!; a.win = [bb[0], bb[1], bb[2] - bb[0], bb[3] - bb[1]];
			gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
			gl.viewport(0, 0, size, size);
			gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE); gl.depthMask(true); gl.colorMask(true, true, true, true);
			gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
			if (rasterOn) drawRasterInto(a, bb, "under");
			// 差し込み（#123）：基図の最後の枠（host）を境で分け、間に利用者の塗りを焼く（直描きの drawSlot と同じ計画）。表に無い物は今どおり基図の塗りの後
			const ua = userAnchorPlan(userIn && wantFills ? [...baseSlots].reverse().find(sl => sceneHasDraws(scenes[sl])) : null);
			if (wantFills) for (const sl of baseSlots) {
				if (sl !== ua.host) { drawFillsInto(a, st, land, [sl], seaOff, baseA); continue; }
				let lo = -Infinity;
				for (const an of ua.anchors) { drawFillsInto(a, st, land, [sl], seaOff, baseA, lo, an); drawFillsInto(a, st, land, ["user"], false, 1, -Infinity, Infinity, d => ua.anchorOf(d.li) === an); lo = an; }
				drawFillsInto(a, st, land, [sl], seaOff, baseA, lo, Infinity);
			}
			if (userIn) drawFillsInto(a, st, land, ["user"], false, 1, -Infinity, Infinity, ua.host ? d => ua.anchorOf(d.li) === Infinity : null);
			if (fillsIn && groundHook) {   // gint の面（基図の塗りの上・ラスタ重ねの下）。gint は自前で状態を触る＝後で戻す
				try { gnd.faces += groundHook(cam, { fbo: a.fbo, win: a.win, size }) | 0; } catch (e) { console.error("[gl] ground hook", (e as Error | null)?.message); }
				gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo); gl.viewport(0, 0, size, size);
				gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true);
				gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.blendEquation(gl.FUNC_ADD);
				gl.bindVertexArray(null);
			}
			if (rasterOn) drawRasterInto(a, bb, "over");
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.bindTexture(gl.TEXTURE_2D, a.tex); gl.generateMipmap(gl.TEXTURE_2D); gl.bindTexture(gl.TEXTURE_2D, null);   // 斜め視のちらつき防止
		}
		gnd.n = wins.length;
	}
	// ⚠サンプラは n=0 でも毎フレーム unit13/14/15/11 へ向ける（未設定＝unit0 整数テクスチャの轍＝cog/elev と同族）
	const GND_UNITS = [13, 14, 15, 11];
	function bindGnd(prog: WebGLProgram): void {
		for (let i = 0; i < 4; i++) gl.uniform1i(loc(gl, prog, "u_gnd" + i), GND_UNITS[i]);
		gl.uniform1f(loc(gl, prog, "u_gndN"), gnd.n);
		for (let i = 0; i < 4; i++) { gl.activeTexture(gl.TEXTURE0 + GND_UNITS[i]); gl.bindTexture(gl.TEXTURE_2D, i < gnd.n && gnd.w[i] ? gnd.w[i]!.tex : null); }
		gl.activeTexture(gl.TEXTURE0);
	}
	// fill 系：uv＝off+dLL×inv（シーン原点ごと f64 前計算＝cog の u_cogOffInv と同じ）
	function setGndScene(prog: WebGLProgram, origin: ArrayLike<number> | null | undefined): void {
		if (!gnd.n) return;
		const o = origin || [0, 0];
		for (let i = 0; i < gnd.n; i++) { const [W, S, sLon, sLat] = gnd.w[i]!.win; gl.uniform4f(loc(gl, prog, "u_gndOffInv" + i), (o[0] - W) / sLon, (o[1] - S) / sLat, 1 / sLon, 1 / sLat); }
	}
	// terrain：メッシュ窓（u_mesh）→アトラス uv（cog の u_cogMesh と同じ）
	function setGndMesh(mh: ArrayLike<number>): void {
		if (!gnd.n) return;
		for (let i = 0; i < gnd.n; i++) { const [W, S, sLon, sLat] = gnd.w[i]!.win; gl.uniform4f(loc(gl, terrainProg, "u_gndMesh" + i), (mh[0] - W) / sLon, (mh[1] - S) / sLat, mh[2] / sLon, mh[3] / sLat); }
	}
	function setGndGlobe(prog: WebGLProgram): void {   // 球の床の uv 係数＝原点相対（#65・anchorUV の f64 前計算）
		for (let i = 0; i < 4; i++) setUV4(prog, "u_gndOff" + i, i < gnd.n ? gnd.w[i]!.win : null);
	}
	// 気候場のサンプラ結線（globe/terrain 両プログラム共用）。⚠サンプラは常に有効unitへ向ける
	// （未設定＝unit0の整数テクスチャを掴んでドロー全体が死ぬ轍と同族）。unit12＝空き（他パス未使用）。
	function bindClim(prog: WebGLProgram): void {
		gl.uniform1i(loc(gl, prog, "u_climTex"), 12);
		gl.uniform1f(loc(gl, prog, "u_hasClim"), climTex ? 1 : 0);
		gl.activeTexture(gl.TEXTURE12); gl.bindTexture(gl.TEXTURE_2D, climTex); gl.activeTexture(gl.TEXTURE0);
	}
	// 世界パレット（view.worldHypso の参照変化でだけ再解決＝setView は浅マージでオブジェクト丸ごと差し替わる）。
	// globe/terrain/wdepr は同一フレームの同一戻り値を使う＝wdepr⇄globe の縫い目（色の bit 一致契約）が構造的に保たれる。
	let wpal = resolveWorldPal(null), wpalSrc: GLView["worldHypso"] = null, seaSrc: number[] | null = null, wpalA = 1, wpalLand: number[] | null = null;
	const worldPal = (): WorldPal => {
		const a = view.worldHypsoOpacity ?? 1;
		if (view.worldHypso !== wpalSrc || (view.sea ?? null) !== seaSrc || a !== wpalA || view.land !== wpalLand) { wpalSrc = view.worldHypso; seaSrc = view.sea ?? null; wpalA = a; wpalLand = view.land; wpal = fadeWorldPal(resolveWorldPal(wpalSrc), a, view.land || [0.96, 0.96, 0.95]); if (seaSrc) wpal.sea = seaSrc; }   // view.sea＝海の色の上書き（gpu と同じ）
		return wpal;
	};
	function bindWorldPal(prog: WebGLProgram): void {   // 要 useProgram 済み。8色＝WORLD_HYPSO チャンクの uniform
		const p = worldPal();
		gl.uniform3f(loc(gl, prog, "u_whLowH"), ...(p.lowHumid as Vec3T));
		gl.uniform3f(loc(gl, prog, "u_whLowA"), ...(p.lowArid as Vec3T));
		gl.uniform3f(loc(gl, prog, "u_whMidH"), ...(p.midHumid as Vec3T));
		gl.uniform3f(loc(gl, prog, "u_whMidA"), ...(p.midArid as Vec3T));
		gl.uniform3f(loc(gl, prog, "u_whR1"), ...(p.ramp1 as Vec3T));
		gl.uniform3f(loc(gl, prog, "u_whR2"), ...(p.ramp2 as Vec3T));
		gl.uniform3f(loc(gl, prog, "u_whPeak"), ...(p.peak as Vec3T));
		gl.uniform3f(loc(gl, prog, "u_whSnow"), ...(p.snow as Vec3T));
	}
	// ?mem=1 台帳のGPU固定常駐（自前確保分の概算）：標高アトラス（近/舞台裏/遠）＋地形メッシュ。
	// canvas antialias:true の MSAA はブラウザ暗黙確保＝ここでは数えない（HUD 側注記）。
	let memAtlas = 0, memStage = 0, memFar = 0, memMesh = 0;
	// 建物メッシュ（LOD2 等）：バッチキー "区名#i" →{ vao, bufs, count, origin, bbox }（頂点は重心相対 delta）。
	// worker が区をバッチ分割して逐次送ってくる＝完成した近傍から順に立つ。bbox は draw 時のフラスタムカリングに使う。
	// 基図建物を伏せる被覆マスクは区単位で別管理（meshMasks）＝バッチ数でシェーダの固定スロットを枯渇させない。
	const meshes = new Map<string, MeshBatch>();
	const classify = createClassifyGL(gl);   // 面の貼り付け（set("classify"・"classifyStyle")）＝メッシュの後・夜面の前に描く
	const meshKeep2d = () => { for (const p of meshes.values()) if (p.keep2d) return true; return false; };   // 真俯瞰でも描くバッチがあるか
	const meshMasks = new Map<string, MeshMask>();   // 区名 → { tex, bbox }（worker が累積スナップショットを送る度に丸ごと差し替え）
	const meshHidden = new Set<string>();  // 非表示の区名（VAO/マスクはVRAM保持＝draw skipとスロット除外だけ。再訪は meshVis 切替のみで再アップロード不要）
	const MAX_MESH_MASKS = 4;
	// 静的 view（色・見た目）：初期化時に一度 setView でアップロード。draw は毎フレーム幾何(cam)だけ受け、
	// 色は view から読む＝描画パラメータを「幾何(動的)」と「見た目(静的)」に分離。将来の worker payload 境界。
	let view: GLView = { clear: null, land: null, atmo: null, bldColor: null };
	// style の sky（B4）＝{ sky, horizon, fog:[r,g,b], groundBlend, horizonFogBlend, skyHorizonBlend, atmosphereBlend }｜null（従来＝宇宙へ抜けるリム光・霧は land 色）
	// 霧：sky の fog-color が霧の色（基図・建物・地形の遠山ブルーも）。fog-ground-blend＝濃さ（0＝霧なし・0.5＝従来の距離・1＝半分の距離から）＝view.fog:false より優先
	let sky: GLSky | null = null;
	const fogK = () => (sky ? (sky.groundBlend <= 0 ? 1e6 : 0.5 / sky.groundBlend) : view.fog === false ? 1e6 : 1);   // view.fog:false＝霧を焚かない（gpu/renderer.js と同じ・2026-09-30）
	const fogColorOf = (c: ArrayLike<number>): ArrayLike<number> => (sky ? sky.fog : c);
	function setView(v: Partial<GLView>): void { view = { ...view, ...v }; }
	let lights: GLLocalLights | null = null;   // 局所の光源（第 3 波 W2）＝{ n, data: Float32Array(8×16) }（light.js localLightsPayload）｜null＝無し。メッシュ（模型・LOD2）の陰影に足す
	let groundMat: GLGroundMat | null = null, gmTex: WebGLTexture | null = null;   // 地面の材質（setGroundMaterial・Cesium の globe.material）＝ランプは unit17 の n×1 テクスチャ
	const GM_UNIT = 17;
	function setGroundMat(m: GLGroundMat | null): void {
		groundMat = m && typeof m.kind === "number" ? m : null;
		if (groundMat?.ramp && groundMat.rampN > 0) {
			if (!gmTex) gmTex = gl.createTexture();
			gl.activeTexture(gl.TEXTURE0 + GM_UNIT); gl.bindTexture(gl.TEXTURE_2D, gmTex);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, groundMat.rampN, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, groundMat.ramp);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.activeTexture(gl.TEXTURE0);
		}
	}
	// ⚠サンプラは材質が無くても毎フレーム unit17 へ向ける（未設定＝unit0 整数テクスチャの轍＝elev/clim と同族）
	function bindGm(prog: WebGLProgram, dpr: number): void {
		const m = groundMat;
		gl.uniform4f(loc(gl, prog, "u_gm"), m ? m.kind : 0, m ? m.min : 0, m ? 1 / Math.max(1e-6, m.max - m.min) : 0, m && m.landOnly ? 1 : 0);
		const c = m?.contour; gl.uniform4f(loc(gl, prog, "u_gmC"), c ? c[0] : 0, c ? c[1] : 0, c ? c[2] : 0, c ? c[3] : 0);
		gl.uniform4f(loc(gl, prog, "u_gmP"), m ? Math.max(1e-3, m.spacing) : 1, m ? m.width * dpr : 0, m ? m.opacity : 0, 0);
		gl.uniform1i(loc(gl, prog, "u_gmRamp"), GM_UNIT);
		gl.activeTexture(gl.TEXTURE0 + GM_UNIT); gl.bindTexture(gl.TEXTURE_2D, m?.ramp ? gmTex : null); gl.activeTexture(gl.TEXTURE0);
	}
	let groundLight: GLGroundLight | null = null;   // 地面の照明（setGroundLighting）＝地形・遠景球の画像に太陽の lambert を掛ける（Cesium の globe.enableLighting）
	// Cesium の CustomShader＝id → 登録（spec・値・テクスチャ）。束は set("meshCustom", id, key) で指す
	const customs = new Map<string, CsEntry>();
	let csFrame = 0;   // czm_frameNumber
	const csOf = (p: MeshBatch): CsEntry | null => p.textured && p.custom ? customs.get(p.custom) ?? null : null;
	function csProg(e: CsEntry, p: MeshBatch): WebGLProgram | null {   // 初めて描く時に組む（GLSL はそのまま・失敗は 1 度だけ告げて素の模型で描く）。束の property texture の形ごとに 1 つ
		const sig = p.meta?.sig ?? "";
		if (e.progs.has(sig)) return e.progs.get(sig)!;
		let prog: WebGLProgram | null = null;
		try { const { vs, fs } = meshCustomGLSL(p.meta ? { ...e.spec, metadata: { ...e.spec.metadata, ...p.meta.props } } : e.spec); prog = programBound(gl, vs, fs, { ...Object.fromEntries(["a_pos", "a_normal", "a_uv", "a_col"].map(n => [n, gl.getAttribLocation(meshTexProg0, n)])), a_mc: MC_LOC, a_uvm: UVM_LOC, a_ol: gl.getAttribLocation(meshTexProg0, "a_ol") }); }
		catch (err) { console.warn("[customShader] compile failed = drawn without it:", (err as Error).message.split("\n")[0]); }
		e.progs.set(sig, prog);
		return prog;
	}
	function csFree(e: CsEntry): void { for (const p of e.progs.values()) if (p) gl.deleteProgram(p); for (const t of e.tex.values()) gl.deleteTexture(t); }
	function metaFree(p: MeshBatch): void { for (const t of p.meta?.texs || []) if (t !== whiteTex) gl.deleteTexture(t); if (p.paint) gl.deleteTexture(p.paint); p.paint = null; }
	function csTexture(t: CsTexIn): WebGLTexture {   // 利用者のテクスチャ（TextureUniform）＝NEAREST／LINEAR・REPEAT／CLAMP は Cesium の sampler から
		const tex = gl.createTexture()!, src = t.tex;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		if (src.bitmap) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.bitmap);
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, src.w, src.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, src.rgba);
		const f = t.nearest ? gl.NEAREST : gl.LINEAR, w = t.repeat === false ? gl.CLAMP_TO_EDGE : gl.REPEAT;
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w);
		gl.bindTexture(gl.TEXTURE_2D, null);
		return tex;
	}
	function setCustomShader(id: string, spec: CsEntry["spec"] | null): void {
		const old = customs.get(id);
		if (!spec) { if (old) { csFree(old); customs.delete(id); } return; }
		const same = old && old.spec.vs === spec.vs && old.spec.fs === spec.fs && JSON.stringify(old.spec.uniforms) === JSON.stringify(spec.uniforms) && JSON.stringify(old.spec.metadata) === JSON.stringify(spec.metadata);
		if (old && same) { old.spec = spec; return; }   // 値（setUniform）・照明・半透明だけ＝組み直さない
		if (old) for (const p of old.progs.values()) if (p) gl.deleteProgram(p);
		customs.set(id, { spec, progs: new Map(), tex: old ? old.tex : new Map() });
	}
	const blendOf = (p: MeshBatch): number => p.blend ? 1 : p.tint && p.tint[3] < 1 ? 2 : csOf(p)?.spec.translucency === "TRANSLUCENT" ? 2 : 0;   // CustomShader の TRANSLUCENT＝半透明の束として奥から描く   // 2＝Model.color の α だけで半透明（OPAQUE の材質＝テクスチャの α は無視）
	let splitPos = 0.5;   // scene.splitPosition (set "splitPos") for the meshes with a split side
	let meshLight: GLMeshLight | null = null;   // Cesium の模型の照明（setMeshLighting）＝有れば固定光・style の light の代わりに Cesium の式（csLit）で描く
	let envTex: WebGLTexture | null = null, envLod = 0;   // Cesium の模型の鏡面の環境（setMeshEnvironmentMap）＝RGBA16F の立方体図・mip＝粗さ×envLod
	let light: GLLight | null = null;   // style の light（B3）＝{ dir:[東,北,上], color:[r,g,b], intensity }｜null（従来の固定光）。メッシュ（押し出し・glTF・LOD2）の陰影に効く
	// 海：水レイヤ(li)を cam.zoom で一律にゲート＝ビュー単位で描く/描かない（タイル毎の presence まだらを排す）。
	// cam.zoom < minzoom では水を描かない＝海は球の基色(紙)のまま。以上で一律の色を点火。
	let sea: { li: number; minzoom: number; li2?: number } = { li: -1, minzoom: Infinity };
	// 利用者の vector の層の差し込み（#123）＝ranges [[liLo, liHi, anchor]…]：user の枠の li がその範囲の op は、基図の li が anchor 以上の項の前に描く（表に無い＝今どおり基図の上）。rev＝アトラスの鍵
	let userAnchor: { ranges: number[][]; rev: number } = { ranges: [], rev: 0 };
	// 描画ごとの差し込みの計画：host＝差し込む基図の枠（無ければ null＝全部最後）・anchors＝境の li（昇順・重なりなし）・anchorOf(user の li)＝境か Infinity
	const userAnchorPlan = (host: string | null | undefined): UserAnchorPlan => {
		const R = userAnchor.ranges;
		const anchorOf = (li: number): number => { for (const r of R) if (li >= r[0] && li <= r[1]) return r[2]; return Infinity; };
		if (!host || !R.length) return { host: null, anchors: [], anchorOf };
		return { host, anchors: [...new Set(R.map(r => r[2]))].sort((x, y) => x - y), anchorOf };
	};
	let bldFill = { li: -1 };   // 建物フットプリント塗り（基図 fill）の layer index。3D（チルト）時は伏せる＝押し出しと二重表現になるため
	let gintBld: { origin: ArrayLike<number>; batches: GintBldBatch[] } | null = null;   // gint ユーザー層（moj筆/ドロップ図形）の地形沿い境界線＝独自 origin・BUILDING_VS 再利用・GL_LINES（各頂点 anchor=自分＝自標高に乗る）
	const OVERLAY_LIFT_M = 3;   // overlay（外部ベクタ線/面）を地形から浮かせる(m)＝地形メッシュとの z-fight（境界線の明滅・消失）を断つ。gint drape(2m)同族＝高ズームで浮きが見えない最小値（15mは上げすぎ・本人指摘）。WebGPU OVERLAY_LIFT と対
	// 星空（z<4）：stars＝点（[cel.xyz, rgb, alpha, size]×8f interleaved）、constel＝星座線（[cel.xyz]×3f、LINES端点列）、
	// planets＝惑星（starsと同レイアウト・アプリが実位置を計算し10分毎に差し替え）。
	// 表示のON/OFFは view.showConst（星座線のみトグル・星と惑星は常設）。
	let stars: StarBuf | null = null, constel: StarBuf | null = null, planets: StarBuf | null = null, ecliptic: StarBuf | null = null, celeq: StarBuf | null = null;
	function setStarBuf(cur: StarBuf | null, data: Float32Array | null | undefined, stride: number, setup: () => void): StarBuf | null {
		if (cur) { gl.deleteBuffer(cur.buf); gl.deleteVertexArray(cur.vao); }
		if (!data || !data.length) return null;
		const vao = gl.createVertexArray()!; gl.bindVertexArray(vao);
		const buf = buffer(gl, data);
		setup();
		gl.bindVertexArray(null);
		return { vao, buf, count: data.length / stride };
	}
	function setStars(data: Float32Array | null | undefined): void {
		stars = setStarBuf(stars, data, 8, () => {
			gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
			gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
			gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28);
		});
	}
	function setConstellations(data: Float32Array | null | undefined): void {
		constel = setStarBuf(constel, data, 3, () => {
			gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
		});
	}
	function setPlanets(data: Float32Array | null | undefined): void {
		planets = setStarBuf(planets, data, 8, () => {
			gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 32, 0);
			gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 12);
			gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 32, 28);
		});
	}
	const lineSetup = () => { gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0); };
	function setEcliptic(data: Float32Array | null | undefined): void { ecliptic = setStarBuf(ecliptic, data, 3, lineSetup); }
	function setCelEquator(data: Float32Array | null | undefined): void { celeq = setStarBuf(celeq, data, 3, lineSetup); }
	let csFogD = 0;   // Cesium の霧の濃さ（view.csAtmo・毎フレーム・地形と模型の u_csFogD と遠景球の u_csAtm.w）
	let fogDist = 0;   // フォグ距離の基準 camDist。ズーム中は凍結（チラチラ防止）、静止で追随
	let lastCamDist = 0;   // 前のフレームの camDist（カメラが飛んだかを見る）
	let elevScaleEff = 0;   // pitchで変調した実効スケール（真俯瞰では0＝平面）
	// 地形パスの RTE の錨＝カメラの注視点（f64・毎フレーム）。旧＝main シーンの原点＝基図のタイルが無い地図（@ortho-earth/cesium）では経度 0・緯度 0 のまま＝
	// 頂点の相対ベクトルが ~1 の大きさになり、f32 の u_mvp との積が深ズームで相殺を失う＝低い目で地形が目の前で何倍にも歪んだ（Cesium 例 shadows・2026-10-28）。
	// 注視点なら相対ベクトルは常に画面の中の距離＝桁落ちなし。地形の錨を使う物（蓋・断面・影の落とし手）も同じ値を使う
	let terrOrigin: number[] = [0, 0];
	let exagMul = 1;        // 地形の誇張（setTerrain の exaggeration・既定 1＝実スケール）＝アトラスの scale に掛ける
	let gintCtx: GintDepthCtx | null = null;   // gint 埋込パス用の frame コンテキスト（terrainDepth 時のみ非null。draw() が毎フレーム更新）
	// base=粗い下書き（underlay）、main=現ズーム、overlay=外部ベクタ(geopbf等)を最前面に。
	// md（multi_draw モード）のシーンは draws でなく md={layers,bld}＝常駐プールへの参照リストだけを持つ。
	const scenes: Record<string, GLScene> = {
		base: { origin: [0, 0], draws: [], bld: null, md: null },
		main: { origin: [0, 0], draws: [], bld: null, md: null },
		overlay: { origin: [0, 0], draws: [], bld: null, md: null },
		user: { origin: [0, 0], draws: [], bld: null, md: null },   // 利用者の vector source の塗りと線（MapLibre 互換 段 8⑤・classic だけ）＝基図の塗りと線の上。空なら slots に入らない＝今までと同じ絵
	};

	// --- multi_draw タイル常駐プール ---
	// タイル geometry を GPU に常駐させ、シーンは「プール内レンジの列」＝merge の CPU memcpy と
	// setScene の全バッファ再生成を廃す。配置（アロケータ）の権限は scene worker：ここは
	// mdGrow（プール成長＝GPU内コピー）/ mdUp（タイルブロックの bufferSubData/texSubImage2D）/
	// mdScene（draw list 差し替え）を言われた通り実行するだけ。
	const MD_TEXW = 2048;   // 線分テクスチャの幅（texel）。2texel/線分＝1024線分/行
	const mdExt = rOpts.noMD ? null : gl.getExtension("WEBGL_multi_draw");
	const md: MDState | null = mdExt ? {
		ext: mdExt,
		fillProg: program(gl, FILL_MD_VS, FILL_FS),
		lineProg: program(gl, LINE_MD_VS, LINE_FS),
		bldProg: program(gl, BUILDING_MD_VS, BUILDING_FS),
		fillV: { buf: null, bytes: 0 },   // 頂点 12B: pos f32×2 + col u8×4（interleave）
		fillI: { buf: null, bytes: 0 },   // index u32（値はプール絶対頂点番号＝upload 時に再ベース済み）
		bldV: { buf: null, bytes: 0 },    // 建物頂点 24B: pos f32×3 + shade f32 + anchor f32×2
		lineTex: null, lineTexH: 0,       // RGBA32UI・2texel/線分
		fillVAO: null, bldVAO: null,
	} : null;
	const md0 = md ? { fill: md.fillProg, line: md.lineProg, bld: md.bldProg } : null;   // 切らない時の md プログラム（切る間は md.* が派生を指す）
	// paint 表の (b) 類（painttable.ts・vt perf plan §5）：RGBA32F・行ごとに 2 texel（0＝色・1＝線の半幅（x）＝表に置ける線幅の層・段 2b）・幅 PT_TEXW。行は scene worker が常駐の荷（mdUp の rows）に添える＝塊より先に着く。
	// 値＝tile worker が焼いた色（段 1＝絵は bit 同値）。setPaintProperty の (b) 類（段 2・painttable.ts の paintTableFast）は層 id → 後の式（ptOver）＝行の組を属性に戻して評価し直す
	// （後の式が読む属性を行の鍵が持つ行だけ・持たない行と上書きの無い層は焼いた色）。書き換えは描く前に一度（汚れた行の範囲）・高さが足りなければ作り直して全部
	const PT_UNIT = 17, PT_TEXW = 1024;
	const pt = { tex: null as WebGLTexture | null, h: 0, data: new Float32Array(0), lo: Infinity, hi: -1, n: 0, rows: [] as PtRow[] };
	let ptOver = new Map<string, PtLayer>();
	// feature-state（段 3）：基図の feature-state を読む層（層 id → source-layer と式＝main が style ごとに）・置かれた状態（source-layer → 地物の id（文字列）→ 状態）・
	// 地物の id → その地物の行（鍵に PT_ID を持つ行）。状態の置かれた地物の行だけ状態つきで評価する（置かれていない行は焼いた既定の状態の色）
	let ptFsL = new Map<string, { sl: string; L: PtLayer }>();
	const ptFsS = new Map<string, Map<string, Record<string, unknown>>>(), ptById = new Map<string, Set<number>>(), ptRowId: (string | undefined)[] = [];
	const ptProg = (prog: WebGLProgram): WebGLProgram => { gl.useProgram(prog); gl.uniform1i(loc(gl, prog, "u_ptTex"), PT_UNIT); return prog; };   // 既定の 0 番は他の型の標本器と当たる
	if (md) { ptProg(md.fillProg); ptProg(md.lineProg); ltProg(md.lineProg); gl.useProgram(null); }
	function ptPut(row: PtRow): void {
		const [r, id, keys, t, c, hw] = row, o = r * 8, F = ptFsL.get(id), st = F && ptRowId[r] !== undefined ? ptFsS.get(F.sl)?.get(ptRowId[r]!) : undefined;
		const Lo = ptOver.get(id), L = Lo && ptCovers(Lo, keys) ? Lo : st && ptCovers(F!.L, keys) ? F!.L : null;
		if (L) { ptRowColor(L, keys, t, pt.data, o, st); if (L.w != null) pt.data[o + 4] = ptRowHalf(L, keys, t, st); else if (hw !== undefined) pt.data[o + 4] = hw; }
		else { pt.data[o] = (c & 255) / 255; pt.data[o + 1] = (c >>> 8 & 255) / 255; pt.data[o + 2] = (c >>> 16 & 255) / 255; pt.data[o + 3] = (c >>> 24) / 255; if (hw !== undefined) pt.data[o + 4] = hw; }
		if (r < pt.lo) pt.lo = r;
		if (r > pt.hi) pt.hi = r;
	}
	function ptRows(rows: PtRow[]): void {
		for (const row of rows) {
			const r = row[0], need = (((r * 2 + 1) / PT_TEXW) | 0) + 1;
			if (need * PT_TEXW * 4 > pt.data.length) { const d = new Float32Array(Math.max(need, pt.data.length / (PT_TEXW * 4) * 2) * PT_TEXW * 4); d.set(pt.data); pt.data = d; }
			pt.rows[r] = row; if (r >= pt.n) pt.n = r + 1;
			const old = ptRowId[r], ki = row[2].indexOf(PT_ID), v = ki < 0 ? null : row[3][ki], nid = v == null ? undefined : String(v);   // 使い回された行＝前の地物の索引から外す
			if (old !== undefined) ptById.get(old)?.delete(r);
			ptRowId[r] = nid;
			if (nid !== undefined) { let S = ptById.get(nid); if (!S) ptById.set(nid, S = new Set()); S.add(r); }
			ptPut(row);
		}
	}
	function setPtOver(list: [string, PtLayer][] | null): void {   // 全部を置き換える＝上書きが外れた層の行は焼いた色へ戻す
		const prev = ptOver;
		ptOver = new Map(list ?? []);
		for (let r = 0; r < pt.n; r++) { const row = pt.rows[r]; if (row && (prev.has(row[1]) || ptOver.has(row[1]))) ptPut(row); }
	}
	function setPtFsLayers(list: [string, string, PtLayer][] | null): void {   // style ごとに全部を置き換える
		const prev = ptFsL;
		ptFsL = new Map((list ?? []).map(([id, sl, L]) => [id, { sl, L }]));
		for (let r = 0; r < pt.n; r++) { const row = pt.rows[r]; if (row && ptRowId[r] !== undefined && (prev.has(row[1]) || ptFsL.has(row[1]))) ptPut(row); }
	}
	function setPtFs(list: [string | null, string | null, Record<string, unknown> | null][]): void {   // [source-layer, 地物の id, 状態（null＝外す）]・id が null＝その source-layer（null＝全部）の状態を外す
		const touch = new Set<number>();
		for (const [sl, fid, st] of list) {
			if (fid == null) {
				for (const k of sl == null ? [...ptFsS.keys()] : [sl]) { const M = ptFsS.get(k); if (!M) continue; for (const i of M.keys()) for (const r of ptById.get(i) ?? []) touch.add(r); ptFsS.delete(k); }
				continue;
			}
			let M = ptFsS.get(sl!); if (!M) ptFsS.set(sl!, M = new Map());
			if (st && Object.keys(st).length) M.set(fid, st); else M.delete(fid);
			for (const r of ptById.get(fid) ?? []) touch.add(r);
		}
		for (const r of touch) { const row = pt.rows[r]; if (row && ptFsL.has(row[1])) ptPut(row); }
	}
	function ptFlush(): void {
		if (pt.hi < 0) return;
		const y0 = ((pt.lo * 2) / PT_TEXW) | 0, y1 = ((pt.hi * 2 + 1) / PT_TEXW) | 0, H = pt.data.length / (PT_TEXW * 4);
		gl.activeTexture(gl.TEXTURE0 + PT_UNIT);
		if (!pt.tex || H > pt.h) {
			if (pt.tex) gl.deleteTexture(pt.tex);
			pt.tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, pt.tex);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, PT_TEXW, H, 0, gl.RGBA, gl.FLOAT, pt.data);
			pt.h = H;
		} else {
			gl.bindTexture(gl.TEXTURE_2D, pt.tex);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, PT_TEXW, y1 - y0 + 1, gl.RGBA, gl.FLOAT, pt.data.subarray(y0 * PT_TEXW * 4, (y1 + 1) * PT_TEXW * 4));
		}
		gl.activeTexture(gl.TEXTURE0);
		pt.lo = Infinity; pt.hi = -1;
	}
	const ptBind = (): void => { ptFlush(); gl.activeTexture(gl.TEXTURE0 + PT_UNIT); gl.bindTexture(gl.TEXTURE_2D, pt.tex); gl.activeTexture(gl.TEXTURE0); };
	function mdRebuildFillVAO(): void {
		if (md!.fillVAO) gl.deleteVertexArray(md!.fillVAO);
		md!.fillVAO = gl.createVertexArray(); gl.bindVertexArray(md!.fillVAO);
		gl.bindBuffer(gl.ARRAY_BUFFER, md!.fillV.buf);
		let l = gl.getAttribLocation(md!.fillProg, "a_delta");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 12, 0);
		l = gl.getAttribLocation(md!.fillProg, "a_color");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 4, gl.UNSIGNED_BYTE, true, 12, 8);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, md!.fillI.buf);   // ELEMENT_ARRAY は VAO 状態
		gl.bindVertexArray(null);
	}
	function mdRebuildBldVAO(): void {
		if (md!.bldVAO) gl.deleteVertexArray(md!.bldVAO);
		md!.bldVAO = gl.createVertexArray(); gl.bindVertexArray(md!.bldVAO);
		gl.bindBuffer(gl.ARRAY_BUFFER, md!.bldV.buf);
		let l = gl.getAttribLocation(md!.bldProg, "a_pos");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 3, gl.FLOAT, false, 24, 0);
		l = gl.getAttribLocation(md!.bldProg, "a_shade");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 1, gl.FLOAT, false, 24, 12);
		l = gl.getAttribLocation(md!.bldProg, "a_anchor");
		gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 24, 16);
		gl.bindVertexArray(null);
	}
	// プール成長＝新バッファへ GPU 内コピー（CPU の再アップロード不要）。VAO は旧バッファを掴んでいるので作り直す。
	// WebGL はバッファを「element / 非element」で型ロックする（最初に COPY_WRITE に bind しただけでも非element に
	// 固定され、以後 ELEMENT_ARRAY_BUFFER に bind できない＝multiDrawElements が黙って空振り）。
	// index プールは elem=true：生成・確保を ELEMENT_ARRAY_BUFFER で行い element 型に確定させる
	// （ELEMENT bind は VAO 状態なので default VAO(null) に退避してから）。型確定後の COPY_READ/COPY_WRITE は合法。
	function mdGrowBuf(pool: MDPool, bytes: number, elem?: boolean): void {
		if (bytes <= pool.bytes) return;
		const target = elem ? gl.ELEMENT_ARRAY_BUFFER : gl.COPY_WRITE_BUFFER;
		if (elem) gl.bindVertexArray(null);
		const nb = gl.createBuffer()!;
		gl.bindBuffer(target, nb);
		gl.bufferData(target, bytes, gl.DYNAMIC_DRAW);
		if (pool.buf) {
			gl.bindBuffer(gl.COPY_READ_BUFFER, pool.buf);
			gl.copyBufferSubData(gl.COPY_READ_BUFFER, target, 0, 0, pool.bytes);
			gl.deleteBuffer(pool.buf);
		}
		gl.bindBuffer(target, null);
		pool.buf = nb; pool.bytes = bytes;
	}
	function mdGrow(pool: string, units: number): void {
		if (pool === "fillV") { mdGrowBuf(md!.fillV, units * 12); mdRebuildFillVAO(); }
		else if (pool === "fillI") { mdGrowBuf(md!.fillI, units * 4, true); mdRebuildFillVAO(); }
		else if (pool === "bldV") { mdGrowBuf(md!.bldV, units * 24); mdRebuildBldVAO(); }
		else if (pool === "line") {   // 線分テクスチャ：高さを伸ばして旧内容を FBO 経由で GPU 内コピー
			const H = Math.ceil(units * 2 / MD_TEXW);
			if (H <= md!.lineTexH) return;
			const nt = gl.createTexture()!;
			gl.bindTexture(gl.TEXTURE_2D, nt);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, MD_TEXW, H, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, null);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			if (md!.lineTex) {
				const fbo = gl.createFramebuffer();
				gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
				gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, md!.lineTex, 0);
				gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, MD_TEXW, md!.lineTexH);   // RGBA32UI→RGBA32UI＝成分型一致でコピー可
				gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
				gl.deleteFramebuffer(fbo);
				gl.deleteTexture(md!.lineTex);
			}
			md!.lineTex = nt; md!.lineTexH = H;
		}
	}
	// タイル1枚分のブロック転送。頂点系は COPY_WRITE 経由（VAO 状態を汚さない）。
	// index プールは element 型ロック済み＝ELEMENT_ARRAY_BUFFER で書く（default VAO(null) に退避してから）。
	function mdUpload(p: MDUpload): void {
		if (p.rows) ptRows(p.rows);   // paint 表の (b) 類の行（塊より先）
		if (p.fill) { gl.bindBuffer(gl.COPY_WRITE_BUFFER, md!.fillV.buf); gl.bufferSubData(gl.COPY_WRITE_BUFFER, p.fill.base * 12, new Uint8Array(p.fill.buf)); }
		if (p.bld) { gl.bindBuffer(gl.COPY_WRITE_BUFFER, md!.bldV.buf); gl.bufferSubData(gl.COPY_WRITE_BUFFER, p.bld.base * 24, p.bld.arr); }
		gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
		if (p.idx) {
			gl.bindVertexArray(null);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, md!.fillI.buf);
			gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, p.idx.base * 4, p.idx.arr);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
		}
		if (p.line) {   // 線分ブロックはテクスチャ内で行を跨ぎ得る＝先頭の欠け行・中間の全行・末尾の欠け行の最大3回に分けて書く
			gl.bindTexture(gl.TEXTURE_2D, md!.lineTex);
			gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
			let t = p.line.base * 2, arr = p.line.arr, off = 0;   // t=先頭texel、off=arr内の消化texel数
			let left = arr.length / 4;
			const put = (x: number, y: number, w: number, rows: number): void => {
				gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, rows, gl.RGBA_INTEGER, gl.UNSIGNED_INT, arr.subarray(off * 4, (off + w * rows) * 4));
				off += w * rows; t += w * rows; left -= w * rows;
			};
			const headX = t % MD_TEXW;
			if (headX) put(headX, (t / MD_TEXW) | 0, Math.min(MD_TEXW - headX, left), 1);
			const rows = (left / MD_TEXW) | 0;
			if (rows) put(0, (t / MD_TEXW) | 0, MD_TEXW, rows);
			if (left) put(0, (t / MD_TEXW) | 0, left, 1);
		}
	}
	// draw list 差し替え：GPU 転送ゼロ（参照リストの入れ替えだけ）。layers は li 昇順＝painter順。
	function mdScene(m: MDSceneMsg): void {
		sceneRev++;   // 地面アトラス（3D の塗り）の再合成の鍵
		disposeSlot(m.slot);
		scenes[m.slot] = { origin: m.origin, draws: [], bld: null, md: { layers: m.layers, bld: m.bld } };
	}
	const sceneHasDraws = (s: GLScene): boolean => s.draws.length > 0 || !!(s.md && s.md.layers.length);

	// s: { origin:[lon,lat], layers:[{kind:'fill'|'line', ...typed arrays}] }（style層順）。slot: 'base'|'main'
	function setScene(s: MergedScene, slot = "main"): void {
		sceneRev++;   // 地面アトラス（3D の塗り）の再合成の鍵
		disposeSlot(slot);
		const draws: GLDraw[] = [];
		for (const L of s.layers) {
			if (!L) continue;
			if (L.kind === "fill") {
				if (!L.pos.length) continue;
				const vao = gl.createVertexArray()!;
				const bPos = buffer(gl, L.pos), bCol = buffer(gl, L.col);
				gl.bindVertexArray(vao);
				attrib(gl, fillProg, "a_delta", bPos, 2);
				attrib(gl, fillProg, "a_color", bCol, 4, null, L.col instanceof Uint8Array);   // タイル由来=Uint8正規化／geojson由来=float32 の両対応
				const bufs = [bPos, bCol];
				let idxN = 0, idxT = 0;
				if (L.idx && L.idx.length) {   // タイル由来＝index描画（ELEMENT_ARRAY_BUFFER は VAO 状態）。geojson由来＝三角形スープのまま
					const ibo = gl.createBuffer()!;
					gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
					gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, L.idx, gl.STATIC_DRAW);
					bufs.push(ibo); idxN = L.idx.length;
					idxT = L.idx instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;   // merge後は常にUint32だが型は実物から
				}
				gl.bindVertexArray(null);
				draws.push({ kind: "fill", li: L.li, vao, count: idxN || L.pos.length / 2, idxT, bufs, fx: L.fx || null, pat: L.pat || null, pz: L.pz || null });
			} else {
				if (!L.half.length) continue;
				const vao = gl.createVertexArray()!;
				// 端と継ぎ（S-P1-1）を持つ層は P1 の前・P2 の後ろに 1 線分ぶんの余白を置き、同じバッファを 1 線分ずらして前の始点（a_p0）・次の終点（a_p3）としても読む
				const J = L.jf, pad = (a: Float32Array, head: boolean): Float32Array => { const b = new Float32Array(a.length + 2); b.set(a, head ? 2 : 0); return b; };
				const bP1 = buffer(gl, J ? pad(L.P1, true) : L.P1), bP2 = buffer(gl, J ? pad(L.P2, false) : L.P2), bCol = buffer(gl, L.col), bHalf = buffer(gl, L.half), bOff = L.off ? buffer(gl, L.off) : null;
				gl.bindVertexArray(vao);
				attrib(gl, lineProg, "a_corner", cornerBuf, 2, 0); if (lineIdxBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIdxBuf);   // P3：4 隅＋6 index（VAO 状態）
				attrib(gl, lineProg, "a_p1", bP1, 2, 1, false, J ? 8 : 0);
				attrib(gl, lineProg, "a_p2", bP2, 2, 1);
				attrib(gl, lineProg, "a_color", bCol, 4, 1, L.col instanceof Uint8Array);
				attrib(gl, lineProg, "a_half", bHalf, 1, 1);
				if (bOff) attrib(gl, lineProg, "a_off", bOff, 3, 1);   // line-offset を持つ層だけ＝[off, tS, tE]（無い層は既定値 0）
				const bDist = L.dist ? buffer(gl, L.dist) : null;
				if (bDist) attrib(gl, lineProg, "a_dist", bDist, 1, 1);   // 破線（S-P1-3）を持つ層だけ＝始点までの線に沿う距離
				const bJf = J ? buffer(gl, J) : null;
				if (bJf) {   // 端と継ぎ（S-P1-1）を持つ層だけ＝旗（u8・正規化しない）と前後の線分の端点
					attrib(gl, lineProg, "a_p0", bP1, 2, 1);
					attrib(gl, lineProg, "a_p3", bP2, 2, 1, false, 8);
					const l = gl.getAttribLocation(lineProg, "a_jf");
					if (l >= 0) { gl.bindBuffer(gl.ARRAY_BUFFER, bJf); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 1, gl.UNSIGNED_BYTE, false, 0, 0); gl.vertexAttribDivisor(l, 1); }
				}
				gl.bindVertexArray(null);
				draws.push({ kind: "line", li: L.li, vao, count: L.half.length, bufs: [bP1, bP2, bCol, bHalf, ...(bOff ? [bOff] : []), ...(bJf ? [bJf] : []), ...(bDist ? [bDist] : [])], cj: bJf ? L.cj ?? 0 : 0, dash: bDist ? dashU(L.dash, bJf ? L.cj ?? 0 : 0) : null, fx: L.fx || null, pz: L.pz || null, lt: L.lt || null });   // li＝差し込みの境で枠を分ける（#123）
			}
		}
		let bld: GLBld | null = null;
		if (s.buildings && s.buildings.pos.length) {
			const vao = gl.createVertexArray()!;
			const bPos = buffer(gl, s.buildings.pos), bSh = buffer(gl, s.buildings.shade), bAnc = buffer(gl, s.buildings.anchor);
			gl.bindVertexArray(vao);
			attrib(gl, bldProg, "a_pos", bPos, 3);
			attrib(gl, bldProg, "a_shade", bSh, 1);
			attrib(gl, bldProg, "a_anchor", bAnc, 2);
			gl.bindVertexArray(null);
			bld = { vao, count: s.buildings.pos.length / 3, bufs: [bPos, bSh, bAnc] };
		}
		scenes[slot] = { origin: s.origin, draws, bld };
	}

	// gint ユーザー層の地形沿いジオメトリを差し替え。data＝{origin, batches:[{lines,points,color}...]}（色別バッチ＝
	// 田/畑等の fid 色をドレープへ運ぶ）または旧形 { origin, lines:{pos,shade,anchor}?, points:{…}?, color? }。
	// 全て BUILDING_VS の 24B レイアウト（a_pos xyz / a_shade / a_anchor）＝bldProg で line=GL_LINES / point=GL_POINTS 描画。null=解放。
	function setGintBld(data: GintBldData | null | undefined): void {
		if (gintBld) { for (const bt of gintBld.batches) { for (const b of bt.bufs) gl.deleteBuffer(b); if (bt.lineVAO) gl.deleteVertexArray(bt.lineVAO); if (bt.pointVAO) gl.deleteVertexArray(bt.pointVAO); } gintBld = null; }
		if (!data) return;
		const mk = (g: BuildingsGeom | null | undefined): GLBld | null => {
			if (!g || !g.pos.length) return null;
			const vao = gl.createVertexArray()!;
			const bP = buffer(gl, g.pos), bS = buffer(gl, g.shade), bA = buffer(gl, g.anchor);
			gl.bindVertexArray(vao);
			attrib(gl, bldProg, "a_pos", bP, 3); attrib(gl, bldProg, "a_shade", bS, 1); attrib(gl, bldProg, "a_anchor", bA, 2);
			gl.bindVertexArray(null);
			return { vao, count: g.pos.length / 3, bufs: [bP, bS, bA] };
		};
		const batches = ((data.batches || [data]) as GintBldIn[]).map(b => {
			const L = mk(b.lines), P = mk(b.points);
			if (!L && !P) return null;
			return {
				lineVAO: L?.vao || null, lineCount: L?.count || 0,
				pointVAO: P?.vao || null, pointCount: P?.count || 0,
				bufs: [...(L?.bufs || []), ...(P?.bufs || [])], color: b.color || null,
			};
		}).filter(Boolean) as GintBldBatch[];
		if (!batches.length) return;
		gintBld = { origin: data.origin, batches };
	}

	// 標高アトラス：セル群を1枚のテクスチャに敷く。a:{originLng,originLat,cellsX,cellsY,cellRes,cellSpan}
	// cellSpan=1セルの度数（R90=90/R10=10/R01=1）。
	// R16F アトラスを確保して 0(海)で初期化。全面ぶんの Float32Array（4096²＝67MB）を毎回作らず、
	// 4MB 級の使い回しストリップを縦に流す＝窓替えのたびの巨大な一時確保を無くす（GC 圧・footprint 対策）。
	let zeroStrip: Float32Array | null = null;
	function allocZeroR16F(W: number, H: number): void {
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, W, H, 0, gl.RED, gl.FLOAT, null);
		const rows = Math.max(1, Math.min(H, (1 << 20) / W | 0));
		if (!zeroStrip || zeroStrip.length < W * rows) zeroStrip = new Float32Array(W * rows);
		for (let y = 0; y < H; y += rows) {
			const h = Math.min(rows, H - y);
			gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, W, h, gl.RED, gl.FLOAT, zeroStrip.subarray(0, W * h));
		}
	}
	function setElevationAtlas(a: ElevAtlasDesc, scale: number): void {
		const W = a.cellsX * a.cellRes, H = a.cellsY * a.cellRes, span = a.cellSpan || 10;
		memAtlas = W * H * 2;   // R16F=2B/texel
		if (!elevTex) elevTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, elevTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		allocZeroR16F(W, H);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		elev = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], scale: scale * exagMul, exag: (a.exag || 1) * exagMul, has: 1, edgeFade: a.edgeFade || 0, liftBounds: a.liftBounds || null };
		const G = Math.min(a.gMax || 1536, Math.max(768, 768 * Math.max(a.cellsX, a.cellsY)));   // gMax＝terrain.js が lowMem で 1024 に絞る（メッシュ 75→33.5MB）
		buildTerrainMesh(a.originLng, a.originLat, a.cellsX * span, a.cellsY * span, G);
	}
	// セル(cx,cy)の N×N Float32(南上げ)をアトラスへ。
	function writeCell(tex: WebGLTexture, cx: number, cy: number, data: Float32Array, cellRes: number): void {
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, cx * cellRes, cy * cellRes, cellRes, cellRes, gl.RED, gl.FLOAT, data);
	}
	function setElevationCell(cx: number, cy: number, data: CellPayload, cellRes: number): void { if (elevTex) putCellAny(elevTex, cx, cy, data, cellRes); }
	// ── 標高セルの GPU 再標本化（perf plan P1 step 1・2026-09-27・gpu/renderer.js と同式）──
	// 生タイルをテクスチャ（R16I＝Int16／R32F＝Float32・LRU）へ 1 回上げ、R16F アトラスを FBO の的にしてセル矩形へ 3 頂点 1 発＝JS の N² ループが消える。
	// R16F を描き込むには EXT_color_buffer_float が要る＝無い環境と ?cpuelev=1 は従来（terrain.js が Float32 を作る／記述子は CPU で焼く）。門＝t-elevcell?gl2=1。
	const cbFloat = !!gl.getExtension("EXT_color_buffer_float");
	const gpuResample = cbFloat && !rOpts.cpuElev;
	let rs: ResampleRes | null = null;   // { fbo, prog:[int, float], u:[…] }
	const rawLRU = new Map<ElevGrid, RawTexEntry>();   // tile(object) → { tex, bytes, kind }
	let rawBytes = 0;
	const RAW_BUDGET = (rOpts.lowMem ? 16 : 64) << 20;
	function rsInit(): ResampleRes {
		if (rs) return rs;
		const progs = [program(gl, ELEV_RESAMPLE_VS, ELEV_RESAMPLE_FS(0)), program(gl, ELEV_RESAMPLE_VS, ELEV_RESAMPLE_FS(1))];
		rs = { fbo: gl.createFramebuffer()!, progs, vao: gl.createVertexArray()! };
		return rs;
	}
	function rawTex(tile: ElevGrid): RawTexEntry | null {
		const hit = rawLRU.get(tile);
		if (hit) { rawLRU.delete(tile); rawLRU.set(tile, hit); hit.fresh = 0; return hit; }
		const d = tile.data as Int16Array | Float32Array, kind = d instanceof Int16Array ? 0 : d instanceof Float32Array ? 1 : -1;
		if (kind < 0 || tile.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || tile.height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		if (kind === 0) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, tile.width, tile.height, 0, gl.RED_INTEGER, gl.SHORT, d);
		else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, tile.width, tile.height, 0, gl.RED, gl.FLOAT, d);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const e = { tex, bytes: d.byteLength, kind, fresh: d.byteLength };
		rawLRU.set(tile, e); rawBytes += e.bytes;
		for (const [k, v] of rawLRU) { if (rawBytes <= RAW_BUDGET || k === tile) break; rawLRU.delete(k); rawBytes -= v.bytes; gl.deleteTexture(v.tex); }
		return e;
	}
	const U4 = new Uint32Array(28), F4 = new Float32Array(U4.buffer);   // gpu/renderer.js の RP と同じ詰め（dim 0-3・a 4-7・lo 8-11・o 12-15・box 16-19・ix 20-23・iy 24-27）
	function resampleCell(tex: WebGLTexture, cx: number, cy: number, N: number, src: CellSrc): boolean {
		if (!gpuResample) return false;
		const tile = (src.tile || src.atlas) as ElevTileGrid, w = tile.width, h = tile.height;
		if (!(w >= 2 && h >= 2)) return false;
		const u = U4, f = F4;
		u.fill(0);
		if (src.mode === "down") { u[20] = N; u[21] = w; u[22] = 2 * N; u[23] = 1; u[24] = N; u[25] = h; u[26] = 2 * N; u[27] = 1; u[16] = src.edge ?? 2; }   // box.x＝読まない最外周 M（既定 2・R10/R90 は 0）   // gx=(w(2i+1)−N)/2N＝画素中心（2026-10-02・elevation.js と同式）。分子に D を足し ix.w=1 で商から引く＝符号なしのまま
		else if (src.mode === "crop") {
			const rg = tile.range, dl = src.lng0 - tile.lng, dt = src.lat0 - tile.lat, sp = src.span;
			const ints = [rg, dl, dt, sp, N].every(Number.isInteger) && dl >= 0 && dt >= 0 && rg > 0 && sp > 0;
			// 画素中心：gx = ((dl + sp(i+½)/N)/rg)·w − ½ = (dl·2N·w + sp·w·(2i+1) − N·rg) / (2N·rg)。分子が負になり得る（dl=0 の西端）＝D を足して ix.w=1 で商から引く
			const Ax = dl * 2 * N * w + N * rg, Ay = dt * 2 * N * h + N * rg, Bx = sp * w, By = sp * h, D = 2 * N * rg;
			if (ints && Ax + Bx * (2 * N - 1) < 0x100000000 && Ay + By * (2 * N - 1) < 0x100000000 && D < 0x100000000) { u[3] = 2; u[20] = Ax; u[21] = Bx; u[22] = D; u[23] = 1; u[24] = Ay; u[25] = By; u[26] = D; u[27] = 1; }
			else { u[3] = 3; f[4] = dl / rg * w - 0.5; f[5] = sp / N / rg * w; f[6] = dt / rg * h - 0.5; f[7] = sp / N / rg * h; f[8] = -1e30; f[9] = 1e30; f[10] = -1e30; f[11] = 1e30; }
		}
		else if (src.mode === "world") { const C = w >> 2; if (C % N) return false; u[3] = 1; u[15] = C / N; u[16] = w; u[17] = (1 - src.cy) * C; u[18] = src.cx * C; }
		else return false;
		const e = rawTex(tile);
		if (!e) return false;
		const r = rsInit(), prog = r.progs[e.kind];
		u[0] = w; u[1] = h; u[2] = e.kind; u[12] = cx * N; u[13] = cy * N; u[14] = N;
		if (src.mode !== "world" && src.sea) u[19] = 1;   // box.w＝海底（負値を通す・mode 0/2 だけ＝mode 1 は box.w を読まない）
		// 状態＝触る物だけ退避して戻す（set() は draw() の外で呼ばれる＝次の draw() が viewport を戻すが、gint 等の同居者のために戻しておく）
		const wasBlend = gl.isEnabled(gl.BLEND), wasDepth = gl.isEnabled(gl.DEPTH_TEST), wasStencil = gl.isEnabled(gl.STENCIL_TEST), wasScissor = gl.isEnabled(gl.SCISSOR_TEST), wasCull = gl.isEnabled(gl.CULL_FACE);
		gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		gl.viewport(cx * N, cy * N, N, N); gl.enable(gl.SCISSOR_TEST); gl.scissor(cx * N, cy * N, N, N);
		gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.CULL_FACE); gl.colorMask(true, true, true, true);
		gl.useProgram(prog);
		gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, e.tex); gl.uniform1i(loc(gl, prog, "u_raw"), 0);
		gl.uniform4uiv(loc(gl, prog, "u_dim"), u.subarray(0, 4)); gl.uniform4fv(loc(gl, prog, "u_a"), f.subarray(4, 8)); gl.uniform4fv(loc(gl, prog, "u_lo"), f.subarray(8, 12));
		gl.uniform4uiv(loc(gl, prog, "u_o"), u.subarray(12, 16)); gl.uniform4uiv(loc(gl, prog, "u_box"), u.subarray(16, 20)); gl.uniform4uiv(loc(gl, prog, "u_ix"), u.subarray(20, 24)); gl.uniform4uiv(loc(gl, prog, "u_iy"), u.subarray(24, 28));
		gl.bindVertexArray(r.vao);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.bindVertexArray(null);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, canvas.width, canvas.height);
		if (!wasScissor) gl.disable(gl.SCISSOR_TEST);
		if (wasBlend) gl.enable(gl.BLEND); if (wasDepth) gl.enable(gl.DEPTH_TEST); if (wasStencil) gl.enable(gl.STENCIL_TEST); if (wasCull) gl.enable(gl.CULL_FACE);
		gl.bindTexture(gl.TEXTURE_2D, null);
		if ((self as unknown as PerfGlobal).__perfElev) (self as unknown as PerfGlobal).__perfElevLast = { f16: 0, write: 0, gpu: 1, raw: e.fresh };
		return true;
	}
	const cpuCell = (src: CellSrc, N: number): Float32Array => src.mode === "down" ? downsampleFlipped(src.tile, N, src.edge ?? 2, !!src.sea) : src.mode === "crop" ? cropResample(src.tile, src.lng0, src.lat0, src.span, N, !!src.sea) : worldAtlasCell(src.atlas, src.cx, src.cy, N);
	function putCellAny(tex: WebGLTexture, cx: number, cy: number, data: CellPayload, N: number): void {   // data＝Float32Array（従来）か生タイルの記述子（mode あり）
		if (data && (data as CellSrc).mode) { if (!resampleCell(tex, cx, cy, N, data as CellSrc)) writeCell(tex, cx, cy, cpuCell(data as CellSrc, N), N); }
		else writeCell(tex, cx, cy, data as Float32Array, N);
	}
	// 検定用（t-elevcell?gl2=1）：アトラスのセルを Float32（南上げ）で読み戻す（R16F の FBO を RGBA/FLOAT で readPixels＝EXT_color_buffer_float）
	async function readElevCell(which: string, cx: number, cy: number, N: number): Promise<Float32Array | null> {
		const tex = which === "far" ? farTex : which === "stage" ? (elevStage && elevStage.tex) : elevTex;
		if (!tex || !cbFloat) return null;
		const r = rsInit();
		gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
		const px = new Float32Array(N * N * 4);
		gl.readPixels(cx * N, cy * N, N, N, gl.RGBA, gl.FLOAT, px);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		const out = new Float32Array(N * N);
		for (let i = 0; i < N * N; i++) out[i] = px[i * 4];
		return out;
	}
	// 標高アトラスのダブルバッファ：2枚目以降の再構築は舞台裏（stage）で行い、セルが揃ったら一括スワップ。
	// 直接 elevAtlas を張り替えるとゼロ初期化の瞬間に山影が全画面でパッと消える（ズーム静止のたびに発症）。
	let elevStage: { tex: WebGLTexture; a: ElevAtlasDesc; scale: number } | null = null;   // { tex, a, scale }
	function setElevationAtlasStage(a: ElevAtlasDesc, scale: number): void {
		if (elevStage) gl.deleteTexture(elevStage.tex);
		const W = a.cellsX * a.cellRes, H = a.cellsY * a.cellRes;
		memStage = W * H * 2;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		allocZeroR16F(W, H);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		elevStage = { tex, a, scale };
	}
	function setElevationCellStage(cx: number, cy: number, data: CellPayload, cellRes: number): void { if (elevStage) putCellAny(elevStage.tex, cx, cy, data, cellRes); }
	function setTerrainExag(k: number): void {
		const m = Number.isFinite(+k) && +k > 0 ? +k : 1, r = m / exagMul;
		exagMul = m;
		if (elev.has) { elev.scale *= r; elev.exag = (elev.exag || 1) * r; }
	}
	function commitElevationStage(): void {
		if (!elevStage) return;
		if (elevTex) gl.deleteTexture(elevTex);
		elevTex = elevStage.tex;
		memAtlas = memStage; memStage = 0;
		const a = elevStage.a, span = a.cellSpan || 10;
		elev = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], scale: elevStage.scale * exagMul, exag: (a.exag || 1) * exagMul, has: 1, edgeFade: a.edgeFade || 0, liftBounds: a.liftBounds || null };
		const G = Math.min(a.gMax || 1536, Math.max(768, 768 * Math.max(a.cellsX, a.cellsY)));   // gMax＝terrain.js が lowMem で 1024 に絞る（メッシュ 75→33.5MB）
		buildTerrainMesh(a.originLng, a.originLat, a.cellsX * span, a.cellsY * span, G);
		elevStage = null;
	}
	// ── 遠景層（far）アトラス ──：ダブルバッファ無し（R10 は LRU ヒットが常＝ゼロ初期化→同フレーム書込で
	// 埋まる。terrain.js 側コメント参照）。メッシュは近窓と同じ単位格子を u_mesh で遠窓へ伸ばす＝専用メッシュ不要。
	function setElevationAtlasFar(a: ElevAtlasDesc): void {
		const W = a.cellsX * a.cellRes, H = a.cellsY * a.cellRes, span = a.cellSpan || 10;
		memFar = W * H * 2;
		if (!farTex) farTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, farTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		allocZeroR16F(W, H);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		far = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], has: 1, edgeFade: a.edgeFade || 0 };
	}
	function setElevationCellFar(cx: number, cy: number, data: CellPayload, cellRes: number): void { if (farTex) putCellAny(farTex, cx, cy, data, cellRes); }
	function clearElevationFar(): void {   // 深ズーム離脱＝GPU メモリを返す（10-16MB）
		if (farTex) gl.deleteTexture(farTex);
		farTex = null; far = { bounds: [0, 0, 1, 0], has: 0, edgeFade: 0 }; memFar = 0;
	}
	// ── 近景層（near）アトラス ──：1 セル（1024²・2MB）。terrain.ts は焼けてから「elevAtlasNear → elevCellNear」を続けて送る＝張替えの瞬間の平坦は無い。
	// has はセルが書けてから 1（主パスの discard は中身がある時だけ）。メッシュは近窓と同じ単位格子を u_mesh で近景窓へ縮める
	function setElevationAtlasNear(a: ElevAtlasDesc): void {
		const W = a.cellsX * a.cellRes, H = a.cellsY * a.cellRes, span = a.cellSpan || 0.25;
		if (!nearTex) nearTex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, nearTex);
		gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
		allocZeroR16F(W, H);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		near = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], has: 0, edgeFade: a.edgeFade || 0 };
	}
	function setElevationCellNear(cx: number, cy: number, data: CellPayload, cellRes: number): void { if (nearTex) { putCellAny(nearTex, cx, cy, data, cellRes); near.has = 1; } }
	function clearElevationNear(): void {
		if (nearTex) gl.deleteTexture(nearTex);
		nearTex = null; near = { bounds: [0, 0, 1, 0], has: 0, edgeFade: 0 };
	}
	// 地形メッシュ＝単位格子 [0,1]²（G だけに依存）。窓の原点/幅は uniform u_mesh で渡す＝
	// 標高アトラスの窓替え（パンのたび）でメッシュを作り直さない。旧実装は毎回 lon/lat を焼いた
	// 頂点配列(G=1536 で 18.9MB)＋index(56.5MB)を作って GPU へ上げ直しており、広域×高チルトの
	// パンで「1窓替えごとに 75MB の GPU バッファ再確保＋CPU 一時配列」＝GPUプロセスが単調に膨れる
	// 主因だった（実測: 陸上パン34ホップで累計 GL alloc 1.2GB・GPUプロセス 1.45→1.95GB）。
	// G が変わる時だけ作り直す＝実質「起動時に一度」。
	function buildTerrainMesh(oLng: number, oLat: number, spanLng: number, spanLat: number, G: number): void {
		if (terrain && terrain.G === G) { terrain.mesh = [oLng, oLat, spanLng, spanLat]; return; }
		const uv = new Float32Array(G * G * 2);
		for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const k = (j * G + i) * 2; uv[k] = i / (G - 1); uv[k + 1] = j / (G - 1); }
		const { idx, chunks } = buildChunkIndex(G);   // チャンク主導の index（P4 step B）＝三角形の分割・巻きは従来と同一・並びだけチャンク毎に連続
		if (terrain) { gl.deleteVertexArray(terrain.vao); gl.deleteBuffer(terrain.vbo); gl.deleteBuffer(terrain.ibo); }
		const vao = gl.createVertexArray()!, vbo = buffer(gl, uv), ibo = gl.createBuffer()!;
		gl.bindVertexArray(vao);
		attrib(gl, terrainProg, "a_uv", vbo, 2);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		memMesh = uv.byteLength + idx.byteLength;
		terrain = { vao, vbo, ibo, count: idx.length, G, mesh: [oLng, oLat, spanLng, spanLat], chunks };
	}
	// 地形チャンクのカリング（perf plan P4 step B・gpu/renderer.js と同じ純関数）：可視チャンクの区間だけ drawElements。?terrlod=0（rOpts.terrLod===false）＝従来の全量 1 draw
	let TERR_LOD = rOpts.terrLod !== false;   // set("terrLod", bool) で実行時切替（門 t-terrcull＝同じ絵の A/B）
	const terrStat = { near: { drawn: 0, of: 0 }, far: { drawn: 0, of: 0 }, fine: { drawn: 0, of: 0 } };   // fine＝近景層のパス
	const terrRuns = (mesh: ArrayLike<number>, st: GLCamState, which: "near" | "far" | "fine"): DrawRun[] => TERR_LOD ? visibleChunkRuns(terrain!.chunks, mesh, st, elev.scale, terrStat[which]) : (terrStat[which].drawn = terrStat[which].of = terrain!.chunks.length, [[0, terrain!.count]]);

	// 建物メッシュ（LOD2 等）を受ける。key=バッチキー "区名#i"（data あり）または区名（data=null＝区の全バッチ+マスク解放）。
	// data={ pos:Float32Array(xyz…), idx:Uint32Array, ward, mask, maskN, maskBbox }（頂点は ortho 単位球座標へ変換済み）。
	function setMeshSet(key: string, data: MeshIn | null | undefined): void {
		if (!data) {   // key=区名：その区の全バッチとマスクを解放
			for (const k of [...meshes.keys()]) {
				if (k !== key && !k.startsWith(key + "#")) continue;
				const p = meshes.get(k)!;
				gl.deleteVertexArray(p.vao); for (const b of p.bufs) gl.deleteBuffer(b); if (p.tex && p.tex !== whiteTex) gl.deleteTexture(p.tex); metaFree(p);
				meshes.delete(k);
			}
			const m = meshMasks.get(key);
			if (m) { gl.deleteTexture(m.tex); meshMasks.delete(key); }
			meshHidden.delete(key);
			return;
		}
		const old = meshes.get(key);
		if (old) { gl.deleteVertexArray(old.vao); for (const b of old.bufs) gl.deleteBuffer(b); if (old.tex && old.tex !== whiteTex) gl.deleteTexture(old.tex); metaFree(old); meshes.delete(key); }
		if (!data.pos?.length || !data.idx?.length) return;
		const textured = !!(data.uv && data.col), prog = textured ? meshTexProg : meshProg;   // 模型（glb 直読み）＝uv＋頂点色＋テクスチャ
		const vao = gl.createVertexArray()!, vbo = buffer(gl, data.pos), nbo = buffer(gl, data.nrm), ibo = gl.createBuffer()!;
		gl.bindVertexArray(vao);
		attrib(gl, prog, "a_pos", vbo, 3);
		if (data.nrm instanceof Int8Array) {   // v4: int8量子化法線（xyz+pad 4B/頂点）。FS が normalize するので精度 1/127 で十分
			const l = gl.getAttribLocation(prog, "a_normal");
			gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
			gl.enableVertexAttribArray(l);
			gl.vertexAttribPointer(l, 3, gl.BYTE, true, 4, 0);
			const lo = gl.getAttribLocation(prog, "a_ol");   // the 4th byte: CESIUM_primitive_outline's coordinates (3 bits)
			if (lo >= 0) { gl.enableVertexAttribArray(lo); gl.vertexAttribPointer(lo, 1, gl.BYTE, true, 4, 3); }
		} else attrib(gl, prog, "a_normal", nbo, 3);   // 旧 float32（同セッション内の残骸互換）
		let tex: WebGLTexture | null = null; const bufs = [vbo, nbo, ibo];
		if (textured) {
			const uvbo = buffer(gl, data.uv!), cbo = buffer(gl, data.col!); bufs.push(uvbo, cbo);
			attrib(gl, prog, "a_uv", uvbo, 2); attrib(gl, prog, "a_col", cbo, 4, null, true);
			tex = meshTexture(data.tex);
			if (data.mc?.length) { const mbo = buffer(gl, data.mc); bufs.push(mbo); gl.bindBuffer(gl.ARRAY_BUFFER, mbo); gl.enableVertexAttribArray(MC_LOC); gl.vertexAttribPointer(MC_LOC, 4, gl.FLOAT, false, 0, 0); }   // CustomShader の positionMC（＋地物番号）
			if (data.uvm?.length) { const ubo = buffer(gl, data.uvm); bufs.push(ubo); gl.bindBuffer(gl.ARRAY_BUFFER, ubo); gl.enableVertexAttribArray(UVM_LOC); gl.vertexAttribPointer(UVM_LOC, 2, gl.FLOAT, false, 0, 0); }   // property texture の texCoord
		}
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.idx, gl.STATIC_DRAW);
		gl.bindVertexArray(null);
		const o = data.origin || [0, 0, 0];
		// lodH/lodCounts（v4）：index は建物高さ降順＝lodCounts[k] で「高さ lodH[k] 以上だけ」を先頭打ち切り描画できる
		// α の扱い（模型）：cut＝これ未満は discard（MASK=alphaCutoff・OPAQUE=−1＝テクスチャの α を無視・BLEND=1/255）／blend＝半透明＝奥から手前・深度書き込み無し
		const blend = textured && data.alphaMode === "BLEND", cut = !textured ? -1 : data.alphaMode === "MASK" ? (data.alphaCutoff ?? 0.5) : blend ? 1 / 255 : -1;
		meshes.set(key, { vao, bufs, tex, textured, blend, cut, count: data.idx.length, origin: o, bbox: data.bbox || [1e9, 1e9, -1e9, -1e9], ward: data.ward || String(key).split("#")[0], lodH: data.lodH || null, lodCounts: data.lodCounts || null, two: data.twoSided ? 1 : 0, noCull: !!data.noCull, noLift: !!data.noLift, drape: !!data.drape, keep2d: !!data.keep2d, noCast: data.castShadow === false || (!!data.keep2d && data.castShadow !== true), pbr: data.pbr ? { metallic: data.pbr.metallic, roughness: data.pbr.roughness, clearcoat: data.pbr.clearcoat ?? null } : null, csLit: data.csLit || "pbr", custom: data.custom ?? null, split: data.split ?? 0, sh: data.sh && data.sh.length >= 27 ? Float32Array.from(data.sh) : null, ol: data.outline ? Float32Array.from(data.outline) : null, noClip: !!data.noClip, imagery: data.imagery ?? null, mcJ: data.mcJ && data.mcJ.length >= 9 ? Float32Array.from(data.mcJ) : null, mc: textured && !!data.mc?.length, uvm: textured && !!data.uvm?.length,
			meta: textured && data.meta?.props && data.meta.texs?.length ? { props: data.meta.props, sig: JSON.stringify(data.meta.props), texs: data.meta.texs.map(t => t ? csTexture({ name: "", tex: t, nearest: true, repeat: false }) : whiteTex) } : null });   // 影を落とさない（WebGPU と同じ）   // noCull＝裏面を捨てない（面の向きが揃っていない建物・間引きは残す）／noLift＝地形へ持ち上げない（平面に浮かせる）／drape＝DTM 保証域に縛らず全ズームで地形へ持ち上げる／keep2d＝真俯瞰でも描き・高さの間引きをしない（統計の押し出し・2026-09-22）
		// 被覆マスク（NEAREST・CLAMP）＝届いたバッチの断片(maskCells)だけをOR合成（gpu/renderer.js と同意味論）。
		// 旧・全量スナップショット差し替えはマスクがメッシュに先行し「矩形の隙間」を作った＝断片方式で根治。
		if (data.ward && (data.maskCells || data.mask) && (data.maskN! | 0) > 0 && data.maskBbox) {
			const N = data.maskN! | 0;
			let m = meshMasks.get(data.ward);
			if (!m || m.n !== N) {
				if (m) gl.deleteTexture(m.tex);
				m = { tex: gl.createTexture()!, bbox: data.maskBbox, n: N, bytes: new Uint8Array(N * N) };
				meshMasks.set(data.ward, m);
			}
			m.bbox = data.maskBbox;
			if (data.maskCells) { for (let i = 0; i < data.maskCells.length; i++) { const c = data.maskCells[i]; if (c < m.bytes.length) m.bytes[c] = 255; } }
			else for (let i = 0; i < data.mask!.length && i < m.bytes.length; i++) if (data.mask![i]) m.bytes[i] = 255;   // 旧worker互換（全量OR＝単調なので破壊しない）
			gl.bindTexture(gl.TEXTURE_2D, m.tex);
			gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, m.bytes);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		}
	}

	// メッシュの区単位の表示切替（GPU常駐のまま）。off＝draw skip＋被覆マスクのスロット除外（基図建物が復活する）。
	// バッファ削除ではないので on へ戻すのは無料＝視野外れの「解放」をこれに置き換えると再訪の再アップロードが消える。
	function setMeshVis(ward: string, on: unknown): void {
		if (on) meshHidden.delete(ward); else meshHidden.add(ward);
	}


	// --- overlay（外部ベクタ=geopbf/e-Stat）：stencil-then-cover 塗り＋境界線 ---
	let overlay: OverlaySlot | null = null, overlayHi: OverlaySlot | null = null, overlayHover: OverlaySlot | null = null, rail: (OverlaySlot | null)[] = [];   // overlayHover＝ホバー境界の太線（選択マスク overlayHi と別スロット）。rail＝交通の常駐オーバーレイ群（地域が申告する路線）
	let wdepr: OverlaySlot | null = null;   // 海面下の陸地（?world=1・全球ハイプソの一部）＝湖より先に描く専用スロット。whK フェードに連動
	let lakes: OverlaySlot | null = null;   // 湖（NE lakes・?world=1）＝wdepr の直後・タイルより先に描く塗り専用スロット（色は worldPal.sea 平色）
	function buildOverlaySlot(s: OverlaySceneIn | null | undefined, fillColor: ArrayLike<number>): OverlaySlot | null {
		if (!s || (!s.fanPos.length && !(s.lineHalf && s.lineHalf.length))) return null;   // 面も線も無い時だけ捨てる（純線＝N02新幹線は面ゼロで通す）
		const fanVao = gl.createVertexArray()!, bFan = buffer(gl, s.fanPos);
		gl.bindVertexArray(fanVao); attrib(gl, stencilProg, "a_delta", bFan, 2); gl.bindVertexArray(null);
		const bufs = [bFan];
		let lineVao: WebGLVertexArrayObject | null = null, lineCount = 0;
		if (s.lineHalf && s.lineHalf.length) {
			lineVao = gl.createVertexArray();
			const bP1 = buffer(gl, s.P1), bP2 = buffer(gl, s.P2), bCol = buffer(gl, s.lineCol), bHalf = buffer(gl, s.lineHalf);
			gl.bindVertexArray(lineVao);
			attrib(gl, lineProg, "a_corner", cornerBuf, 2, 0); if (lineIdxBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIdxBuf);   // P3：4 隅＋6 index（VAO 状態）
			attrib(gl, lineProg, "a_p1", bP1, 2, 1);
			attrib(gl, lineProg, "a_p2", bP2, 2, 1);
			attrib(gl, lineProg, "a_color", bCol, 4, 1, s.lineCol instanceof Uint8Array);
			attrib(gl, lineProg, "a_half", bHalf, 1, 1);
			gl.bindVertexArray(null);
			lineCount = s.lineHalf.length; bufs.push(bP1, bP2, bCol, bHalf);
		}
		return { fanVao, fanCount: s.fanPos.length / 2, lineVao, lineCount, origin: s.origin, fillColor, bufs, minZoom: s.minZoom || 0, feats: s.feats || null };   // minZoom＝シーン単位のズームゲート。feats＝feature毎レンジ+外接円（wdepr の球体カリング用）
	}
	function disposeOverlay(o: OverlaySlot | null | undefined): void { if (o) { for (const b of o.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(o.fanVao); if (o.lineVao) gl.deleteVertexArray(o.lineVao); } }
	function setOverlay(s: OverlaySceneIn | null | undefined, fillColor?: number[] | null): void { disposeOverlay(overlay); overlay = s ? buildOverlaySlot(s, fillColor || [0.20, 0.45, 0.85, 0.32]) : null; }
	// N02 交通の常駐オーバーレイ群を丸ごと差し替え。各要素は buildGeoJSONOverlay のシーン（線色は焼込済）。
	function setRail(scenes: OverlaySceneIn[] | null | undefined): void { for (const o of rail) disposeOverlay(o); rail = (scenes || []).map(s => buildOverlaySlot(s, [0, 0, 0, 0])); }
	function setOverlayHi(s: OverlaySceneIn | null | undefined, fillColor?: HiFill | null): void {   // fillColor=配列は従来の面塗り／{mask,color}は周辺マスク（外側を暗く・地物は塗らない）
		disposeOverlay(overlayHi);
		if (!s) { overlayHi = null; return; }
		const isMask = fillColor && !Array.isArray(fillColor);
		overlayHi = buildOverlaySlot(s, isMask ? (fillColor.color || [0, 0, 0, 0.15]) : ((fillColor as number[] | null | undefined) || [0.95, 0.55, 0.15, 0.6]));
		if (overlayHi) overlayHi.mask = !!(isMask && fillColor.mask);
	}
	function setOverlayHover(s: OverlaySceneIn | null | undefined): void { disposeOverlay(overlayHover); overlayHover = s ? buildOverlaySlot(s, [0, 0, 0, 0]) : null; }   // 塗り透明＝境界線のみ（太線はシーンの lineWidth）
	function drawOne(o: OverlaySlot | null, st: GLCamState, dpr: number, land: ArrayLike<number>): void {
		if (!o) return;
		if (o.fanCount) {   // 面がある時だけ stencil 塗り（純線オーバーレイ＝N02 は面ゼロでも線を描く）
			// 地球規模の地物（国＝スポットライト）は wdepr/lakes と同じ球体カリングへ回す＝裏半球の地物が
			// 手前へ punch する（球の向こうの国の形が抜けて見える）のを断つ。シーンが feats（feature毎レンジ＋
			// 外接円＝buildGeoJSONOverlay {ranges:true}）を持っている時だけ＝従来の局所ポリゴンは素通り（2026-09-23）。
			if (o.feats) stencilWorldFan(o, st, land);
			else {
				// stencil パス：fan を巻き数へ（色は書かない・FRONT+1/BACK-1、球の前後半球も相殺）
				gl.enable(gl.STENCIL_TEST);
				gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);
				gl.colorMask(false, false, false, false);
				gl.stencilMask(0xFF); gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
				gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
				gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
				setCommonUniforms(stencilProg, st, o.origin, land);
				gl.uniform1f(loc(gl, stencilProg, "u_lift"), OVERLAY_LIFT_M);   // 地形から浮かせて z-fight を断つ（面の stencil 位置）
				gl.bindVertexArray(o.fanVao); gl.drawArrays(gl.TRIANGLES, 0, o.fanCount);
			}
			// cover パス：通常＝stencil≠0(内側)を塗り0へ戻す／o.mask＝stencil==0(外側)を暗く塗り→内側stencilは後始末
			gl.colorMask(true, true, true, true);
			gl.useProgram(coverProg);
			gl.uniform4f(loc(gl, coverProg, "u_fill"), o.fillColor[0], o.fillColor[1], o.fillColor[2], o.fillColor[3]);
			if (o.mask) {
				gl.stencilFunc(gl.EQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);   // 外側(stencil==0)を暗く
				gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
				gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);   // 内側stencilを後始末（次スロット/gintのため）
			} else {
				gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);   // 内側(stencil≠0)を塗り0へ
				gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
			}
			gl.disable(gl.STENCIL_TEST);
		}
		// 線（境界線 or N02 の鉄道線）
		if (o.lineVao) {
			setCommonUniforms(lineProg, st, o.origin, land);
			gl.uniform1f(loc(gl, lineProg, "u_lift"), OVERLAY_LIFT_M);   // 地形から浮かせて z-fight を断つ（境界線が明滅・消失する件の根治）
			gl.uniform1f(loc(gl, lineProg, "u_dpr"), dpr);
			lineOffZero();
			gl.bindVertexArray(o.lineVao); drawLineInst(o.lineCount);
		}
	}
	function drawOverlay(st: GLCamState, dpr: number, land: ArrayLike<number>, zoom: number): void {
		if (view.showRail !== false) for (const o of rail) { if (zoom >= o!.minZoom) drawOne(o, st, dpr, land); }   // N02 交通（新幹線/駅）＝基図の上・identify overlay の下
		drawOne(overlay, st, dpr, land); drawOne(overlayHi, st, dpr, land); drawOne(overlayHover, st, dpr, land);   // ホバー境界は最前面
	}
	// 全球面ポリゴンの stencil 段（wdepr/lakes 共用）：fan を巻き数へ・球体カリング二段構え。
	// cover（塗り方）は呼び出し側の領分＝wdepr はハイプソ本体（WDEPR_FS）・lakes は worldPal.sea の平色。
	function stencilWorldFan(o: OverlaySlot, st: GLCamState, land: ArrayLike<number>): void {
		gl.enable(gl.STENCIL_TEST);
		gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);
		gl.colorMask(false, false, false, false);
		gl.stencilMask(0xFF); gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
		gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
		gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
		setCommonUniforms(stencilProg, st, o.origin, land);
		gl.uniform1f(loc(gl, stencilProg, "u_lift"), OVERLAY_LIFT_M);
		gl.uniform1f(loc(gl, stencilProg, "u_sphereClip"), 1);   // 跨ぎ feature の裏側頂点を地平円へクランプ（可視部だけを囲む）
		gl.bindVertexArray(o.fanVao);
		// 球体カリング二段構え：①完全裏側 feature は CPU でレンジごと描かない（対蹠点付近は VS クランプが
		// リング一周巻き＝全面+1 化する実測 2026-09-02＝クランプだけでは守れない）②地平線跨ぎは VS クランプ。
		// 可視判定＝中心方向と視線の角 − 角半径 < 地平角 ⇔ dot(C,Ê) > cos(hor+rad)（cos加法・全て事前計算値）。
		if (o.feats) {
			const E = st.eye, eLen = Math.hypot(E[0], E[1], E[2]) || 1;
			const cosH = Math.min(1, 1 / eLen), sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH));
			const ex = E[0] / eLen, ey = E[1] / eLen, ez = E[2] / eLen;
			let run0 = -1, runN = 0;
			for (const f of o.feats) {
				const vis = f.C[0] * ex + f.C[1] * ey + f.C[2] * ez > f.cosR * cosH - f.sinR * sinH;
				if (vis && run0 >= 0 && f.start === run0 + runN) { runN += f.count; continue; }   // 連続レンジは結合
				if (runN) gl.drawArrays(gl.TRIANGLES, run0, runN);
				run0 = vis ? f.start : -1; runN = vis ? f.count : 0;
			}
			if (runN) gl.drawArrays(gl.TRIANGLES, run0, runN);
		} else gl.drawArrays(gl.TRIANGLES, 0, o.fanCount);
		gl.uniform1f(loc(gl, stencilProg, "u_sphereClip"), 0);   // 共有プログラム＝通常 overlay（局所ポリゴン）へ持ち越さない
		gl.colorMask(true, true, true, true);
	}
	// 海面下の陸地（wdepr）＝stencil は drawOne と同一・cover だけ WDEPR_FS（landK=1 強制のハイプソ本体）。
	// フラット色でなく画素単位で標高ランプ×気候×hillshade を計算＝ポリゴンは「ここは海でなく陸」の粗い印
	// （海→海面下→湖→陸の描画順・2026-09-01 本人設計）。呼び出しは draw() の globe/terrain 後・lakes 前。
	function drawWdepr(st: GLCamState, land: ArrayLike<number>, whK: number): void {
		const o = wdepr;
		if (!o || !o.fanCount) return;
		stencilWorldFan(o, st, land);
		gl.useProgram(wdCoverProg);
		setRayUniforms(wdCoverProg, st);   // #65：視線の基底（f64）＋目＋c
		const atmo = view.atmo || [0.45, 0.62, 0.95, 0.6];   // draw() の既定と同値＝globe と同じ紙/大気で厳密同色
		gl.uniform4f(loc(gl, wdCoverProg, "u_land"), land[0], land[1], land[2], land[3]);
		gl.uniform4f(loc(gl, wdCoverProg, "u_atmo"), atmo[0], atmo[1], atmo[2], atmo[3]);
		gl.uniform1i(loc(gl, wdCoverProg, "u_elevTex"), 1);   // unit1＝直前に elevTex を必ずバインド済み（globe パスと同じ轍対策の共通バインド）
		gl.uniform4f(loc(gl, wdCoverProg, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
		setUV4(wdCoverProg, "u_elevOff", elev.bounds);   // 近窓の uv 係数（#65・原点相対）
		gl.uniform1f(loc(gl, wdCoverProg, "u_elevEdgeFade"), elev.edgeFade || 0);
		gl.uniform1i(loc(gl, wdCoverProg, "u_farElevTex"), 8);   // far床＝globe と同式（bit一致の掟）
		gl.uniform4f(loc(gl, wdCoverProg, "u_farBounds"), far.bounds[0], far.bounds[1], far.bounds[2], far.bounds[3]);
		gl.uniform1f(loc(gl, wdCoverProg, "u_hasFar"), far.has);
		gl.uniform1f(loc(gl, wdCoverProg, "u_ell"), ellipsoidOn() ? 1 : 0);
		gl.uniform1f(loc(gl, wdCoverProg, "u_whK"), whK);
		gl.uniform1f(loc(gl, wdCoverProg, "u_globeAlpha"), view.globeAlpha ?? 1);
		bindClim(wdCoverProg);   // 気候場 unit12（未着は u_hasClim=0＝緯度近似フォールバック・globe と同じ）
		bindWorldPal(wdCoverProg);   // globe と同一フレーム・同一パレット＝縫い目の色 bit 一致
		gl.uniform3f(loc(gl, wdCoverProg, "u_whDeep"), ...(worldPal().belowSea as Vec3T));
		// 球体カリングは VS の地平円クランプ（u_sphereClip）が担う＝裏側ポリゴンは円周に縮退（巻き数0）・
		// 地平線跨ぎは可視部だけを囲む。旧・ref=±1 方式は「跨ぎポリゴンの投影折返し」が円盤内に作る
		// ±1 斑を殺しきれなかった（GL/WebGPU で符号逆＝GL だけ幻影が残った実測 2026-09-02）。
		gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);   // 内側を塗り 0 へ後始末
		gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);   // 地平円上の縮退スライバー残渣を掃除（後段 overlay/gint を汚さない）
		gl.disable(gl.STENCIL_TEST);
	}
	// 湖（NE lakes・?world=1）＝wdepr の兄弟スロット（stencil 共用）・cover は worldPal.sea の平色一枚
	// （globe の u_seaC と単一の出所＝湖と海が同じ顔・テーマの worldHypso.sea が両方へ届く）。
	// 旧 world-water タイル層（Protomaps/OSM）の置き換え（2026-09-03 本人裁定「湖はNE経由＝B案」）＝
	// α=whK＝全球ハイプソと同時に現れ同時に消える（z≥6.5 は自動不可視・日本の湖は GSI 基図の領分）。
	function drawLakes(st: GLCamState, land: ArrayLike<number>, whK: number): void {
		const o = lakes;
		if (!o || !o.fanCount) return;
		stencilWorldFan(o, st, land);
		gl.useProgram(coverProg);
		const sc = worldPal().sea;
		gl.uniform4f(loc(gl, coverProg, "u_fill"), sc[0], sc[1], sc[2], whK * (view.globeAlpha ?? 1));   // 湖も球体の不透明度に従う
		gl.stencilFunc(gl.NOTEQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);   // 内側を塗り 0 へ後始末
		gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
		gl.clearStencil(0); gl.clear(gl.STENCIL_BUFFER_BIT);   // 縮退スライバー残渣の掃除（wdepr と同じ）
		gl.disable(gl.STENCIL_TEST);
	}

	// 全画面レイキャスト（球の床・海面下・経緯線・等高線・夜面）の視線一式（#65）：camera.js sphereRayUniforms＝f64 で作って渡す（glsl.js の RAY 節と対）
	// 錨＝シーン原点（交点は原点相対 δ で持ち、uv は anchorUV の f64 係数＝絶対経緯度を経ない）
	function setRayUniforms(prog: WebGLProgram, st: GLCamState): void {
		const u = sphereRayUniforms(st, scenes.main.origin || [0, 0]) as Required<SphereRayUniforms>;
		gl.uniform3f(loc(gl, prog, "u_rayF"), u.F[0], u.F[1], u.F[2]);
		gl.uniform3f(loc(gl, prog, "u_rayX"), u.X[0], u.X[1], u.X[2]);
		gl.uniform3f(loc(gl, prog, "u_rayY"), u.Y[0], u.Y[1], u.Y[2]);
		gl.uniform3f(loc(gl, prog, "u_rayE"), u.E[0], u.E[1], u.E[2]);
		gl.uniform1f(loc(gl, prog, "u_rayC"), u.c);
		gl.uniform3f(loc(gl, prog, "u_rayO"), u.O[0], u.O[1], u.O[2]);
		gl.uniform3f(loc(gl, prog, "u_rayEO"), u.EO[0], u.EO[1], u.EO[2]);
		gl.uniform4f(loc(gl, prog, "u_rayLL"), u.ll[0], u.ll[1], u.beta0, u.rho);
	}
	const setUV4 = (prog: WebGLProgram, name: string, win: ArrayLike<number> | null | undefined): void => { const a = anchorUV(scenes.main.origin || [0, 0], win); gl.uniform4f(loc(gl, prog, name), a[0], a[1], a[2], a[3]); };
	function setCommonUniforms(prog: WebGLProgram, st: GLCamState, origin: ArrayLike<number>, fog: ArrayLike<number>): void {
		gl.useProgram(prog);
		gl.uniformMatrix4fv(loc(gl, prog, "u_mvp"), false, st.mvp32);
		gl.uniform3f(loc(gl, prog, "u_eye"), st.eye[0], st.eye[1], st.eye[2]);
		gl.uniform2f(loc(gl, prog, "u_origin"), origin[0], origin[1]);
		// RTE の錨（MVP相殺回避）＝原点3D の clip 位置と三角比を CPU(double) で（Float32化前の st.mvp で）。
		const oPt = lonlatTo3D(origin[0], origin[1]);
		const cT = mat.transform(st.mvp, [oPt[0], oPt[1], oPt[2], 1]);
		gl.uniform4f(loc(gl, prog, "u_clipT"), cT[0], cT[1], cT[2], cT[3]);
		gl.uniform3f(loc(gl, prog, "u_originPt"), oPt[0], oPt[1], oPt[2]);
		// 楕円体＝緯度側は β（更成緯度）の三角＝deltaToRel は純球面式のまま（球＝β=φ＝従来値）。
		const lr = origin[0] * Math.PI / 180, br = betaOf(origin[1]) * Math.PI / 180;
		gl.uniform4f(loc(gl, prog, "u_originTrig"), Math.cos(lr), Math.sin(lr), Math.cos(br), Math.sin(br));
		// 楕円体 dβ 錨（原点の測地緯度の 2φ/4φ 三角・CPU double）＋変位方向ゲート。球＝全0＝シェーダ補正が厳密0
		const _ell = ellipsoidOn(), _pr = origin[1] * Math.PI / 180;
		gl.uniform4f(loc(gl, prog, "u_ellTrig"), ...((_ell ? [Math.cos(2 * _pr), Math.sin(2 * _pr), Math.cos(4 * _pr), Math.sin(4 * _pr)] : [0, 0, 0, 0]) as Vec4T));
		gl.uniform1f(loc(gl, prog, "u_ell"), _ell ? 1 : 0);
		gl.uniform2f(loc(gl, prog, "u_viewport"), canvas.width, canvas.height);
		gl.uniform1f(loc(gl, prog, "u_fogNear"), (st.fogDist || st.camDist) * 2.5 * fogK());
		gl.uniform1f(loc(gl, prog, "u_fogFar"), (st.fogDist || st.camDist) * 14.0 * fogK());
		fog = fogColorOf(fog);
		gl.uniform3f(loc(gl, prog, "u_fogColor"), fog[0], fog[1], fog[2]);
		gl.uniform1f(loc(gl, prog, "u_csFogD"), csFogD);   // Cesium の霧（地形・模型の VS が持つ・他は null＝無視）
		gl.uniform4f(loc(gl, prog, "u_csFogL"), groundLight ? groundLight.dir[0] : 0, groundLight ? groundLight.dir[1] : 0, groundLight ? groundLight.dir[2] : 1, groundLight && groundLight.night ? 1 : -1);
		// 対数深度係数（cameraState と同じ far＝地平線 limb×1.15+camDist）。球+局所(建物)の z-fight 対策。
		gl.uniform1f(loc(gl, prog, "u_logCoef"), logCoefOf(st));
		gl.uniform1i(loc(gl, prog, "u_elevTex"), 1);
		gl.uniform4f(loc(gl, prog, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
		gl.uniform1f(loc(gl, prog, "u_elevScale"), elevScaleEff);
		gl.uniform1f(loc(gl, prog, "u_hasElev"), elev.has);
		gl.uniform1f(loc(gl, prog, "u_elevEdgeFade"), elev.edgeFade || 0);   // 窓の縁のフェード幅(deg)。R90全球窓=0
		gl.uniform1i(loc(gl, prog, "u_farElevTex"), 8);   // 遠景層（unit8＝メッシュマスク2-5/md線6/gint7と不干渉）
		gl.uniform4f(loc(gl, prog, "u_farBounds"), far.bounds[0], far.bounds[1], far.bounds[2], far.bounds[3]);
		gl.uniform1f(loc(gl, prog, "u_hasFar"), far.has);
		gl.uniform1f(loc(gl, prog, "u_farEdgeFade"), far.edgeFade || 0);
		gl.uniform1i(loc(gl, prog, "u_nearElevTex"), NEAR_UNIT);   // 近景層（順 1a）
		gl.uniform1i(loc(gl, prog, "u_csEnvMap"), ENV_UNIT);   // 模型の鏡面の環境（無ければ null の立方体＝u_csEnv.x=0 で不使用）
		gl.uniform4f(loc(gl, prog, "u_nearBounds"), near.bounds[0], near.bounds[1], near.bounds[2], near.bounds[3]);
		gl.uniform1f(loc(gl, prog, "u_hasNear"), near.has);
		gl.uniform1f(loc(gl, prog, "u_nearEdgeFade"), near.edgeFade || 0);
	}

	function draw(cam: CameraPose, opts?: GLDrawOptions | null): boolean {
		gl.viewport(0, 0, canvas.width, canvas.height);
		dbgC = { baseFill: 0, baseLine: 0, mainFill: 0, mainLine: 0, pt: 0, ptw: 0, skipMain: !!(opts && opts.skipMain), skipBase: !!(opts && opts.skipBase), zoom: +(cam.zoom || 0).toFixed(1), terrainDepth: false };   // ?drawhud=1（gpu/renderer.js dbg と同形）
		const st = cameraState(cam, canvas.width, canvas.height) as GLCamState;
		st.mvp32 = Float32Array.from(st.mvp);
		lastLogCoef = logCoefOf(st); lastDpr = cam.dpr || 1; lastFovy = cam.fovy || 50 * Math.PI / 180;
		const clipOn = clipFrame(cam.dpr || 1);   // 断面（P0 #3）＝このフレームのプログラムを派生か base に   // 深度の書き出し（#47）が添える尺度＝u_logCoef・gintCtx.logCoef と同じ物
		// フォグ距離（遠山ブルーの帯・遠景平坦化dfの境界）は camDist へ滑らかに追従（臨界減衰）：
		// 直結だとホイール1ノッチ毎に霞の帯が跳んでチラチラし、凍結だとズームアウトで旧距離の霞が
		// 画面を覆ってから静止時にパッと晴れる（不自然）。ローパスなら両方向とも霞が滑らかに動く。
		// 霧を焚かない時（fogK＝1e6＝近/遠が実質無限）と、カメラが飛んだ時（1 フレームで距離が 2 倍超・半分未満＝jumpTo・初期視点）は
		// 追わずに合わせる：追っても見えない霧のために約 60 フレーム描き直していた（ベンチの起動直後の余分な描き直し・2026-10-23）
		if (!fogDist || fogK() >= 1e6 || st.camDist > lastCamDist * 2 || st.camDist * 2 < lastCamDist) fogDist = st.camDist;
		else fogDist += (st.camDist - fogDist) * 0.18;
		if (Math.abs(st.camDist - fogDist) < st.camDist * 0.002) fogDist = st.camDist;
		lastCamDist = st.camDist;
		st.fogDist = fogDist;
		csFogD = view.csAtmo && view.csAtmo.ground !== false ? csFogDensity((Math.hypot(st.eye[0], st.eye[1], st.eye[2]) - 1) * 6378137, Math.abs(Math.cos(cam.pitch || 0))) : 0;   // Cesium の霧の濃さ（csatmo.ts・800 km より下）
		const fogAnimating = fogDist !== st.camDist;   // 収束まで追加フレームを要求（呼び出し側が dirty 継続）
		// 視程下限のチルト係数（20°→46°）：真俯瞰0＝平面地図の縁を青く染めない／傾けるほど実距離の視程が効く
		const pfFog = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.35) / 0.45));
		// 真俯瞰では標高オフ、傾けるほどフェードイン（3.4°→11.5°）
		const pt = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14));
		const pf = pt * pt * (3 - 2 * pt);
		// 都市ズームの平ら化(cityFlat: z13.5→16)は撤去（2026-07-26）。あれは ALOS AW3D30=DSM 時代の名残で、
		// 「都市の起伏＝ビル天端がベクタ建物と二重になる」対策だった。現在 z≥12 の標高源は R01=DEM10B（地理院
		// 10m DTM＝裸地）＝都市の起伏は本物の地形（台地・谷・扇状地）なので全ズームで見せるのが正しい。
		// ⚠轍：都市帯の標高源を DSM 系へ戻す時はこの taper（と深度のテント問題）が再び必要になる。
		elevScaleEff = elev.scale * pf;
		{ const g = sphereRayUniforms(st); lastGlobe = { F: g.F, X: g.X, Y: g.Y, E: g.E, c: g.c }; }   // 海面の球の光線＝オーバーレイの深度に添える（depthout.ts sceneGlobeW）
		terrOrigin = [cam.center[0], cam.center[1]];   // 地形パスの錨＝注視点（上の宣言を参照）
		// 地面アトラス（RTT ドレープ）：3D（地形あり）＝ベクタ塗りもアトラスへ（直描きは伏せる）／ラスタは常にアトラス。鍵が変わった時だけ合成
		{
			const fillsIn = !!(terrain && elev.has && elevScaleEff > 1e-9) && !(opts && opts.noTerrain);   // ＝terrainActive（下で再計算される同じ式）
			const slotsG = (opts && opts.skipMain) ? ["base"] : (opts && opts.skipBase) ? ["main"] : ["base", "main"];
			if (sceneHasDraws(scenes.user)) slotsG.push("user");   // 利用者の vector の層（段 8⑤）＝空なら足さない（鍵も今と同じ）
			composeGround(cam, st, view.land || [0.96, 0.96, 0.95, 1], fillsIn, slotsG);
			gl.viewport(0, 0, canvas.width, canvas.height);   // 合成が FBO の viewport を触った
		}
		// 建物の影（P0 #3）：落とす側を太陽から描いてから受け手のプログラムを選ぶ（地形を落とすのは地形を描くフレームだけ＝真俯瞰は平ら）
		const terrOnF = !!(terrain && elev.has && elevScaleEff > 1e-9) && !(opts && opts.noTerrain);
		const shOn = shadow.on ? shadowFrame(cam, st, opts, terrOnF, clipOn, view.land || [0.96, 0.96, 0.95, 1], terrOnF ? terrain!.mesh : null, { near: Math.max(st.fogDist * 1.2, 0.008 * pfFog) * fogK(), far: Math.max(st.fogDist * 5.0, 0.026 * pfFog) * fogK() }) : false;
		progSwap(clipOn, shOn);
		// 真俯瞰(pitch≈0)＋十分な寄り＝画面全面が陸。地球の縁/大気のレイキャストは映らず無駄なので、
		// 陸色で塗りつぶす clear だけの2D高速パスへ（フルスクリーンの球シェーダを丸ごと省略）。
		const land = view.land || [0.96, 0.96, 0.95, 1], atmo = view.atmo || [0.45, 0.62, 0.95, 0.6];
		// 全球ハイプソの出現度（globe パスと terrain パスが共有＝ピッチで色が変わらない）。z5.7→6.5 でフェードアウト
		// ＝R90 全球窓の限界（z6.5 でアトラスがビュー窓へ切替）に着地し、そこで基図（BASEMAP_MINZOOM=6.5）と交代
		// 世界ハイプソの退場ズーム＝地域の基図が入場する所（日本＝6.5）。view.worldHypsoZ で動かせる＝
		// 地域の申告が無い器（apps/world の国の地図＝globe 仕様）は基図が来ない＝最後まで世界の色で描く（2026-09-23）。
		const whZ = view.worldHypsoZ ?? 6.5;
		const worldHypsoK = view.worldHypso && elev.has ? Math.max(0, Math.min(1, (whZ - cam.zoom) / 0.8)) : 0;
		const flat2d = !clipOn && !shOn && (cam.pitch || 0) < 0.02 && cam.zoom >= 9 && !cogSt.has && !gnd.rasterOn;   // 断面の間は球の床を描く（床の切れ目を消す＝WebGPU と同じ）   // COG/画像タイル層の搭載中は真俯瞰でも globe パスを通す（陸の下地に画像を敷く唯一の層）
		const c = flat2d ? [land[0], land[1], land[2], land[3] ?? 1] : (view.clear || [1, 1, 1, 1]);   // 2D の床も land の不透明度（B5）＝background 層の無い MapLibre の地図は透明
		gl.clearColor(c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		const globeA = view.globeAlpha ?? 1;   // 球体の不透明度（globe/terrain/海面下/湖/夜面に一括＝表示パネル「基図」の拡張・本人裁定 2026-09-13）
		gl.disable(gl.DEPTH_TEST);
		gl.clear(gl.DEPTH_BUFFER_BIT);

		// 星空劇場（z<5）：globe より先に描く＝陸には上書きされ・大気ハローは星の上に薄く重なり・宇宙には星が残る。
		// 深度無関係の背景（VSが clip.z=0 固定）。天球の向きは恒星時(GMST)＝実時刻の空。versor回転にもそのまま追随。
		const worldFade = !flat2d && cam.zoom < 5 ? Math.min(1, (5 - cam.zoom) / 0.5) : 0;   // 星空劇場（星・夜面）共通の出現フェード
		const starFade = (stars || constel || planets) ? worldFade : 0;
		if (starFade > 0) {
			const gmst = gmstAt(clockNow(view.clock));
			const cg = Math.cos(gmst), sg = Math.sin(gmst);
			// 遠近表現（v1移植）：天球倍率 ∝ (0.4+0.3z)＝ズームに線形（地球は2^z）。z4（フェード境界）で1に正規化
			// ＝出現時のスケールが素の投影と連続（ポップしない）。ズームアウトで星空が密に寄る＝空が「遠くなる」。
			// z1 の硬クランプ（max）は天球スケールの変化が z1 で急停止＝太陽系圏の出入りで星の動きが不連続に
			// 見えた（本人指摘 2026-09-02「上手に繋げて」）→ softplus の軟クランプ＝C∞接続：z≫1 は従来の線形・
			// z≪1 は z1 相当へ漸近凍結（無限遠の星空はズームアウトで縮まない・負zの係数反転も防ぐ＝旧仕様を保存）。
			const zx = cam.zoom - 1, zs = 1 + (zx > 0 ? zx + 0.25 * Math.log(1 + Math.exp(-zx / 0.25)) : 0.25 * Math.log(1 + Math.exp(zx / 0.25)));   // 数値安定形 softplus（幅0.25z）
			const skyK = (0.4 + 0.3 * zs) / 1.6;
			const starUniforms = (prog: WebGLProgram): void => {
				gl.uniformMatrix4fv(loc(gl, prog, "u_mvp"), false, st.mvp32);
				gl.uniform2f(loc(gl, prog, "u_gmst"), cg, sg);
				gl.uniform1f(loc(gl, prog, "u_fade"), starFade);
				gl.uniform1f(loc(gl, prog, "u_sky"), skyK);
			};
			if (stars || planets) {
				gl.useProgram(starsProg);
				starUniforms(starsProg);
				if (stars) { gl.bindVertexArray(stars.vao); gl.drawArrays(gl.POINTS, 0, stars.count); }
				if (planets) { gl.bindVertexArray(planets.vao); gl.drawArrays(gl.POINTS, 0, planets.count); }   // 惑星＝同じ点プログラム（実位置はアプリが更新）
			}
			if (view.showConst && (constel || ecliptic || celeq)) {
				gl.useProgram(starLineProg);
				starUniforms(starLineProg);
				// view.skySolar（太陽系圏 z<1・l=sky 点灯時）：黄道/天の赤道は消灯（「地球から見た空」の注記＝
				// 実位置3Dの太陽系と矛盾）・星座線は減光（本人裁定 2026-09-02「少し薄くした方が見栄えがいい」）
				const dimC = view.skySolar ? 0.55 : 1;
				const lines: [StarBuf | null, number[]][] = [   // [バッファ, 色（定数attrib＝VAO外の文脈状態）]
					[constel, [0.47, 0.63, 1.0, 0.4 * dimC]],   // 星座線＝v1と同じ青（rgba(120,160,255)）
					[view.skySolar ? null : ecliptic, [1.0, 0.8, 0.45, 0.35]],   // 黄道＝淡い黄（太陽・月・惑星の通り道）
					[view.skySolar ? null : celeq, [1.0, 0.55, 0.5, 0.32]],      // 天の赤道＝淡い紅（地球の赤道の空への投影）
				];
				for (const [b, c] of lines) {
					if (!b) continue;
					gl.bindVertexArray(b.vao);
					gl.vertexAttrib4f(1, c[0], c[1], c[2], c[3]);
					gl.drawArrays(gl.LINES, 0, b.count);
				}
			}
			gl.bindVertexArray(emptyVAO);
		}

		// 球体本体：land基色を縁(リム)まで敷く（宇宙を背に丸い地球）。2D高速パス時は clear で代替＝省略。
		if (!flat2d) {
			gl.useProgram(globeProg);
			setRayUniforms(globeProg, st);   // #65：視線の基底（f64）＋目＋c
			clipBind("terrain", scenes.main.origin);   // 球の床＝地形の面（レイは main 原点相対）
			gl.uniform4f(loc(gl, globeProg, "u_land"), land[0], land[1], land[2], land[3]);
			gl.uniform4f(loc(gl, globeProg, "u_atmo"), atmo[0], atmo[1], atmo[2], atmo[3]);
			gl.uniform1f(loc(gl, globeProg, "u_skyOn"), sky ? 1 : 0);   // style の sky（B4）＝簡易の空。無指定＝従来の絵
			if (sky) {
				gl.uniform3f(loc(gl, globeProg, "u_skyColor"), sky.sky[0], sky.sky[1], sky.sky[2]);
				gl.uniform3f(loc(gl, globeProg, "u_horizonColor"), sky.horizon[0], sky.horizon[1], sky.horizon[2]);
				gl.uniform3f(loc(gl, globeProg, "u_skyFogColor"), sky.fog[0], sky.fog[1], sky.fog[2]);
				gl.uniform4f(loc(gl, globeProg, "u_skyBlend"), sky.skyHorizonBlend, sky.horizonFogBlend, sky.atmosphereBlend, 0);
			}
			gl.uniform1f(loc(gl, globeProg, "u_globeAlpha"), globeA);
			{   // 地下から見た球の裏面（Cesium の globe.undergroundColor）：距離は m → 世界単位
				const ug = view.underground;
				gl.uniform4f(loc(gl, globeProg, "u_ugC"), ug ? ug.color[0] : 0, ug ? ug.color[1] : 0, ug ? ug.color[2] : 0, ug ? ug.color[3] : -1);
				gl.uniform4f(loc(gl, globeProg, "u_ugNF"), ug ? ug.nf[0] / 6378137 : 0, ug ? ug.nf[1] : 1, ug ? ug.nf[2] / 6378137 : 1, ug ? ug.nf[3] : 1);
			}
			{   // 地面の照明（setGroundLighting・Cesium の globe.enableLighting）：距離のフェードと夜側の明るさは CPU で（camDist＝単位球からの高さ）
				const gl_ = groundLight, dM = Math.hypot(st.eye[0], st.eye[1], st.eye[2]) * 6378137;   // Cesium の cameraDist＝地球中心からの距離
				const fk = (f: number[] | null | undefined, lo: number) => f ? Math.max(lo, Math.min(1, (dM - f[0]) / (f[1] - f[0]))) : 1;
				gl.uniform4f(loc(gl, globeProg, "u_cg"), gl_ ? gl_.dir[0] : 0, gl_ ? gl_.dir[1] : 0, gl_ ? gl_.dir[2] : 1, gl_ ? (gl_.normal === "up" ? 2 : 1) : 0);
				gl.uniform4f(loc(gl, globeProg, "u_cgP"), gl_ ? gl_.lambert[0] : 1, gl_ ? gl_.lambert[1] : 0, gl_ ? fk(gl_.fade, 0) : 0, gl_ && gl_.night ? fk(gl_.night, 0.05) : -1);
				gl.uniform3f(loc(gl, globeProg, "u_cgC"), gl_ ? gl_.color[0] : 1, gl_ ? gl_.color[1] : 1, gl_ ? gl_.color[2] : 1);
			}
			bindGm(globeProg, cam.dpr || 1);   // 地面の材質（Cesium の globe.material）＝球の床にも
			const csA = view.csAtmo;   // Cesium の大気：地面は遠くからだけ（中心から π/2·R → π·R で効く）
			gl.uniform4f(loc(gl, globeProg, "u_csAtm"), csA ? 1 : 0, csA && csA.ground !== false ? csGroundFade((1 + st.camDist) * 6378137) : 0, csA && csA.sky !== false ? 1 : 0, csFogD);
			// 全球ハイプソ（view.worldHypso＝テーマ/アプリのknob）：z5.5 まで全開→z6.3 で消灯。
			// 終端 6.3＝R90 全球窓の終わり（z6.5 でアトラスがビュー窓へ切替＝窓の外の陸が「標高0＝海」に化ける）
			// より手前。地形面（TERRAIN_FS u_whK）と同じ係数＝チルトでも色が連続。
			// ⚠サンプラは K=0 でも毎フレーム unit1 へ向ける：未設定だと既定 unit0＝同居 gint の整数テクスチャを
			// float sampler が掴み、globe ドロー全体が GL_INVALID_OPERATION で死ぬ（＝海が宇宙の黒に抜ける。
			// 下方の共通バインドと同じ轍。z>5.2 で実際に被弾 2026-08-30）。unit1 は elevTex か null（incomplete=黒で無害）。
			gl.uniform1f(loc(gl, globeProg, "u_whK"), worldHypsoK);
			// 楕円体の印は毎回（#43・2026-09-28）：床の uv（deltaLL の β→測地の補正）も読む。旧＝下の worldHypsoK>0 の枝の中だけ＝z≳6.3 で既定 0（球）のまま＝
			// 画像タイル層・COG を床に貼ると原点から遠いほどずれた（北緯 60° z15 で南へ約 450m・t-ellparity?ell=1）。球＝0＝従来と同値
			gl.uniform1f(loc(gl, globeProg, "u_ell"), ellipsoidOn() ? 1 : 0);
			gl.uniform1i(loc(gl, globeProg, "u_elevTex"), 1);
			gl.uniform1i(loc(gl, globeProg, "u_climTex"), 12);   // 気候場サンプラも常時 unit12（K=0でも。unit0整数テクスチャの轍）
			gl.uniform1i(loc(gl, globeProg, "u_farElevTex"), 8);   // far床サンプラも常時 unit8（K=0でも）。従来は flat2d(z≥9真俯瞰)で globe 自体が
			// 走らず潜伏していたが、COG 搭載で flat2d を解除すると未設定＝unit0（gint整数）を掴み Metal で draw 全滅（2026-09-06 実測）
			gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (elev.has && elevTex) ? elevTex : null); gl.activeTexture(gl.TEXTURE0);
			if (worldHypsoK > 0 || groundMat) {   // 標高の窓＝全球ハイプソと地面の材質（Cesium の globe.material＝球の床にも標高・勾配で塗る）が読む
				gl.uniform4f(loc(gl, globeProg, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
				gl.uniform1f(loc(gl, globeProg, "u_elevEdgeFade"), elev.edgeFade || 0);
				gl.uniform4f(loc(gl, globeProg, "u_farBounds"), far.bounds[0], far.bounds[1], far.bounds[2], far.bounds[3]);
				gl.uniform1f(loc(gl, globeProg, "u_hasFar"), far.has);
				gl.uniform1f(loc(gl, globeProg, "u_hasElev"), elev.has && elevTex ? 1 : 0);
			}
			if (worldHypsoK > 0) {
				const sc = worldPal().sea;   // 正準パレット（worldpal.js 既定＝NE流の淡青・knobで差し替え可）
				gl.uniform3f(loc(gl, globeProg, "u_seaC"), sc[0], sc[1], sc[2]);
				bindWorldPal(globeProg);
				ensureClimTex(view.worldHypso!.clim);   // 気候場（cross-blend）＝初回だけ取得。未着は緯度近似
				bindClim(globeProg);
			}
			bindCog(globeProg);   // ユーザ COG（has=0 でもサンプラは unit9 へ＝轍対策）
			setUV4(globeProg, "u_cogOff", cogSt.has ? cogSt.bbox : null);   // 球の床の uv 係数（#65・原点相対）
			bindGnd(globeProg); setGndGlobe(globeProg);   // 地面アトラス＝基球の床（真俯瞰 2D の下地・地形の低地フェードの穴）
			gl.bindVertexArray(emptyVAO);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		}

		// 標高テクスチャをユニット1へ（全プログラムが elev() で参照）。標高なしでも必ず「null を」バインド＝
		// 同居する gint が unit1 に RGBA32UI（metaTex/ptMetaTex＝整数）を残すため、条件付きバインドだと
		// 標高未着/noTerrain のフレームで float sampler(u_elevTex) が整数テクスチャを掴み、全ドローが
		// GL_INVALID_OPERATION「Mismatch between texture format and sampler type」を吐く（実機GPUログで確認）。
		// null＝incomplete texture は黒を返すだけでエラーにならない（u_hasElev=0 ガードで値は不使用）。
		gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, (elev.has && elevTex) ? elevTex : null);
		gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, (far.has && farTex) ? farTex : null);   // 遠景層（null＝incomplete=黒。u_hasFar=0 ガードで不使用）
		gl.activeTexture(gl.TEXTURE0 + NEAR_UNIT); gl.bindTexture(gl.TEXTURE_2D, (near.has && nearTex) ? nearTex : null);   // 近景層（同）
		gl.activeTexture(gl.TEXTURE0 + ENV_UNIT); gl.bindTexture(gl.TEXTURE_CUBE_MAP, envTex);   // 模型の鏡面の環境（null＝incomplete＝黒・u_csEnv.x=0 で不使用）
		gl.activeTexture(gl.TEXTURE0);
		const terrainActive = !!(terrain && elev.has && elevScaleEff > 1e-9) && !(opts && opts.noTerrain);   // 傾き時のみ地形あり。noTerrain=全球ビューでは矩形アトラスを描かない
		// ここから深度あり（建物同士の前後関係を共有）
		gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
		// 地形サーフェス（標高変位＋hillshade）。真俯瞰(pf≈0)では描かない＝平面地図。
		// 深度は書かない＝背景扱い：地形サーフェスが深度を書くと、その上に立つ建物(基図/建物メッシュ)と
		// 干渉し得る（DSM時代は「屋根の高さのテント」が建物を丸ごと飲んだ。現 R01=DTM でも接地誤差の
		// z-fight を避ける）。塗り・線が既にペインタ順で地形の上な設計（半透明の山）
		// に建物も合わせ、地形深度との衝突を根絶する。地形自身は凸地形の重なりが稀に透けるが設計内の割り切り。
		// 地形の深度書き＝凸地形の自遮蔽（富士の"頂上抜け"対策）＋基図・建物も尾根の向こうは隠れる。
		// 旧: z<13 限定（都市帯は ALOS DSM のビル天端が建物を飲む＝テント問題）。cityFlat 撤去（2026-07-26）と
		// ペアで全ズーム化：z≥12 の標高源は R01=DEM10B（DTM＝裸地）なのでテントは存在せず、都市帯にも起伏が
		// 出た以上、深度が無いと尾根の向こうの建物・道路が透ける（札幌 藻岩山で実測）。
		// polygonOffset で地形をわずかに奥へ＝ドレープした基図(同じ対数深度)が z-fight せず表に出る。
		const terrainDepth = terrainActive;
		dbgC.terrainDepth = !!terrainDepth;
		// 水面リフト(+30m)は DSM 帯（R10 混成があり得る z<14）限定＝DTM の都市帯で川を 30m 浮かせない。
		// 都市帯の基図接地リフト(+5m)：深度テスト×DTM起伏で、線/塗りのドレープ（頂点毎バイリニア）と
		// 地形メッシュ（72m級格子）の近似差から道路が地形面を出入りしてギザギザになる（札幌 z16.9 実測）
		// のを上へ逃がす。山岳帯(z<14)は 0＝従来の見た目。根治は RTT ドレープ（基図を地形に貼る）＝将来課題。
		// z14切替はランプ化（z13.5→14 の0.5幅で連続モーフ）＝keepFine保持のズームアウトで露出した段差ポップ対策。
		// 両端値は実測チューニングのまま＝z≥14とz≤13.5の絵は従来と完全一致。gpu/renderer.js と同式。
		const cityK = terrainDepth ? Math.max(0, Math.min(1, (cam.zoom - 13.5) / 0.5)) : 0;
		const cityLift = 5 * cityK;   // 線の接地リフト（塗りは 3D では地面アトラス側＝リフト無し・2026-09-21）
		// 3D（チルト）では建物フットプリント塗りを伏せる：押し出し建物と二重表現になり、起伏＋接地リフト下では
		// 「浮いた濃い平板」として露出する（札幌 z16.9 実測・本人指摘「3Dならフットプリント不要では」）。
		// 真俯瞰(2D)では従来どおり描く＝平面地図の建物表現はフットプリントが本体。閾値は show3d と同じ。
		const hideBldFill = bldFill.li >= 0 && (cam.pitch || 0) >= 0.02;
		// 標高パイプライン計器（?perf=1 時・2秒毎）：「高度が消える」系の切り分け用＝どの因子が0かを1行で。
		if ((self as unknown as PerfGlobal).__perfElev && performance.now() - ((self as unknown as PerfGlobal).__perfElevT || 0) > 2000) {
			(self as unknown as PerfGlobal).__perfElevT = performance.now();
			console.log('[elev] z=%s pitch=%s scale=%s pf=%s eff=%s has=%s mesh=%s active=%s depth=%s bounds=%s far=%s farBounds=%s',
				cam.zoom.toFixed(2), ((cam.pitch || 0) * 180 / Math.PI).toFixed(0),
				elev.scale?.toExponential?.(2), pf.toFixed(2), elevScaleEff?.toExponential?.(2),
				elev.has, !!terrain, terrainActive, terrainDepth, elev.bounds?.map(v => +v.toFixed(2)).join(','),
				far.has, far.bounds?.map(v => +v.toFixed(2)).join(','));
		}
		if (terrainActive) {
			gl.depthMask(terrainDepth);
			if (terrainDepth) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.0, 4.0); }
			setCommonUniforms(terrainProg, st, terrOrigin, land);   // RTE 錨＝カメラの注視点（terrOrigin）
			clipBind("terrain", terrOrigin);
			// 地形だけフォグを「遠山ブルー」に：空気遠近法＝遠くの山は青く霞む。地平線の山並みが
			// 説明不要で"山"として読める（基図の線/塗りは従来どおり紙色へフェードアウト＝浮かない）。
			// 距離も地形だけ半分に詰める＝中景の山並み（80-150km）にしっかり青が乗る。
			// 距離は camDist 比例に「実距離の下限＝視程」を併用：ズームを寄せても 50km 手前から
			// 165km（快晴の山岳視程）までは霞み切らない＝八ヶ岳から中央・北アルプスが青い山並みとして残る。
			const dc = fogColorOf(view.distColor || [0.63, 0.72, 0.83]);   // sky の fog-color（B4）が最優先
			gl.uniform3f(loc(gl, terrainProg, "u_fogColor"), dc[0], dc[1], dc[2]);
			// 視程の下限（50km/165km）はチルト連動：真俯瞰では0＝純camDist比例（見下ろす平面地図の縁が
			// 青く染まるのを防ぐ）。傾けるほど（20°→46°）横に大気を見通す＝実距離の視程が効く。
			gl.uniform1f(loc(gl, terrainProg, "u_fogNear"), Math.max(st.fogDist * 1.2, 0.008 * pfFog) * fogK());
			gl.uniform1f(loc(gl, terrainProg, "u_fogFar"), Math.max(st.fogDist * 5.0, 0.026 * pfFog) * fogK());
			gl.uniform3f(loc(gl, terrainProg, "u_land"), land[0], land[1], land[2]);
			gl.uniform1f(loc(gl, terrainProg, "u_landA"), land[3] ?? 1);   // 床の不透明度（B5）
			// 標高ティント（view.hypso={color,max,amount}＝テーマのノブ）。未指定は amount=0＝恒等（従来の単色陰影）
			const hy = view.hypso;
			gl.uniform3f(loc(gl, terrainProg, "u_hypso"), hy ? hy.color[0] : 0, hy ? hy.color[1] : 0, hy ? hy.color[2] : 0);
			gl.uniform2f(loc(gl, terrainProg, "u_hypsoP"), hy ? 1 / (hy.max || 3000) : 0, hy ? (hy.amount ?? 0.5) : 0);
			gl.uniform1f(loc(gl, terrainProg, "u_whK"), worldHypsoK);   // 全球ハイプソ（低ズーム帯）＝globe パスと同色
			gl.uniform1f(loc(gl, terrainProg, "u_globeAlpha"), globeA);
			{   // 地面の照明（setGroundLighting・Cesium の globe.enableLighting）：距離のフェードと夜側の明るさは CPU で（camDist＝単位球からの高さ）
				const gl_ = groundLight, dM = Math.hypot(st.eye[0], st.eye[1], st.eye[2]) * 6378137;   // Cesium の cameraDist＝地球中心からの距離
				const fk = (f: number[] | null | undefined, lo: number) => f ? Math.max(lo, Math.min(1, (dM - f[0]) / (f[1] - f[0]))) : 1;
				gl.uniform4f(loc(gl, terrainProg, "u_cg"), gl_ ? gl_.dir[0] : 0, gl_ ? gl_.dir[1] : 0, gl_ ? gl_.dir[2] : 1, gl_ ? (gl_.normal === "up" ? 2 : 1) : 0);
				gl.uniform4f(loc(gl, terrainProg, "u_cgP"), gl_ ? gl_.lambert[0] : 1, gl_ ? gl_.lambert[1] : 0, gl_ ? fk(gl_.fade, 0) : 0, gl_ && gl_.night ? fk(gl_.night, 0.05) : -1);
				gl.uniform3f(loc(gl, terrainProg, "u_cgC"), gl_ ? gl_.color[0] : 1, gl_ ? gl_.color[1] : 1, gl_ ? gl_.color[2] : 1);
			}
			bindGm(terrainProg, cam.dpr || 1);   // 地面の材質（Cesium の globe.material）
			if (worldHypsoK > 0) { ensureClimTex(view.worldHypso!.clim); bindClim(terrainProg); bindWorldPal(terrainProg); }
			else { gl.uniform1i(loc(gl, terrainProg, "u_climTex"), 12); gl.uniform1f(loc(gl, terrainProg, "u_hasClim"), 0); }   // サンプラは常時unit12へ（未設定=unit0整数テクスチャの轍）
			bindCog(terrainProg);   // ユーザ COG（陰影の上・フォグの下＝TERRAIN_FS 側で合成）
			bindGnd(terrainProg);   // 地面アトラス（同）
			const mh = terrain!.mesh;   // 窓の原点/幅＝単位格子メッシュを実座標へ伸ばす（メッシュ自体は使い回し）
			gl.uniform1f(loc(gl, terrainProg, "u_farPass"), 0);
			gl.uniform4f(loc(gl, terrainProg, "u_mesh"), mh[0], mh[1], mh[2], mh[3]);
			setCogMesh(mh); setGndMesh(mh);
			gl.bindVertexArray(terrain!.vao);
			for (const [f0, n] of terrRuns(terrain!.mesh, st, "near")) gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_INT, f0 * 4);   // 可視チャンクの区間だけ（P4 step B）
			if (far.has && farTex) {
				// 遠景メッシュ＝同じ単位格子を遠窓へ2度目のドロー（FS が近窓の内側を discard＝二重描画なし）。
				// 近を先に描く＝遠の被り分は深度で早期棄却。頂点コストは近と同額＝チルト×深ズーム時のみ発生。
				gl.uniform1f(loc(gl, terrainProg, "u_farPass"), 1);
				gl.uniform4f(loc(gl, terrainProg, "u_mesh"), far.bounds[0], far.bounds[1], far.bounds[2], far.bounds[3]);
				setCogMesh(far.bounds); setGndMesh(far.bounds);
				for (const [f0, n] of terrRuns(far.bounds, st, "far")) gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_INT, f0 * 4);
				gl.uniform1f(loc(gl, terrainProg, "u_farPass"), 0);
			} else { terrStat.far.drawn = 0; terrStat.far.of = 0; }
			if (near.has && nearTex) {   // 近景メッシュ＝同じ単位格子を近景層の窓へ縮めて 3 度目のドロー（主パスはその内側を discard 済み）
				gl.uniform1f(loc(gl, terrainProg, "u_farPass"), 2);
				gl.uniform4f(loc(gl, terrainProg, "u_mesh"), near.bounds[0], near.bounds[1], near.bounds[2], near.bounds[3]);
				setCogMesh(near.bounds); setGndMesh(near.bounds);
				for (const [f0, n] of terrRuns(near.bounds, st, "fine")) gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_INT, f0 * 4);
				gl.uniform1f(loc(gl, terrainProg, "u_farPass"), 0);
			} else { terrStat.fine.drawn = 0; terrStat.fine.of = 0; }
			if (clipFr && clipFr.tp.terrain.length && clip!.style.capOn) {   // 地形の蓋（断面）＝地形と同じ深度の流儀・polygonOffset は外す（蓋は地形の手前で勝つ）
				if (terrainDepth) gl.disable(gl.POLYGON_OFFSET_FILL);
				gl.depthMask(true);
				const fogT = { near: Math.max(st.fogDist * 1.2, 0.008 * pfFog) * fogK(), far: Math.max(st.fogDist * 5.0, 0.026 * pfFog) * fogK(), color: fogColorOf(view.distColor || [0.63, 0.72, 0.83]) };
				drawCaps(st, clipFr.tp.terrain, terrOrigin, terrain!.mesh, cam.center, false, fogT, land);
				if (far.has && farTex) drawCaps(st, clipFr.tp.terrain, terrOrigin, far.bounds, cam.center, true, fogT, land);
			}
			gl.depthMask(true);
			if (terrainDepth) gl.disable(gl.POLYGON_OFFSET_FILL);
		}
		// ベクタ(塗り/線)は常にペインタ順で地形の上に描く＝深度で地形と争わせない。傾き時も平面時も、
		// 陸・海・道路が地形サーフェスと z-fight して揺れる/寸断するのを根絶（地形の起伏は先に深度で解決済）。
		gl.disable(gl.DEPTH_TEST);
		// 海面下の陸地（?world=1・bucket below_sea_land）＝全球ハイプソの一部として「タイル(湖)より先」に敷く。
		// 描画順が精度を代替する設計（2026-09-01 本人指摘）：海側の境界だけ焼きが正確（admin0海岸線でクリップ）なら
		// よく、湖側（死海・カスピ沿岸）は上に乗る湖の塗りが、陸側は cover（landK=1 のハイプソ本体）が外側と同色に
		// 溶けるので広く荒くてよい。フェードは whK 連動＝ハイプソと同時に現れ同時に消える（z≥6.5 は自動不可視）。
		// ラスタ基図（under・hideFills）の間は世界帯の湖・海面下陸地・等高線も伏せる＝画像の上に自前の水面や茶線を重ねない（標準地図は等高線入り）
		const rasterBase = gnd.rasterOn && !!(rasterDraws && rasterDraws.hideFills);
		if (wdepr && worldHypsoK > 0 && !rasterBase) drawWdepr(st, land, worldHypsoK);
		// 湖（NE lakes）＝wdepr の上・タイルの下（海→海面下→湖→陸の順のまま供給源だけ NE へ 2026-09-03）
		if (lakes && worldHypsoK > 0 && !rasterBase) drawLakes(st, land, worldHypsoK);
		// 等高線：真俯瞰(チルト≈0)でだけ茶の等高線を敷く（3Dが立ち上がる前＝ちょうど入れ替わりでフェード）。ベクタの下＝道路/区界は上に乗る。
		{
			const ps = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.01) / 0.05));   // pitch 0.01→0.06rad で 3D と入れ替わり
			const zf = 1 - Math.max(0, Math.min(1, (cam.zoom - 17.5) / 1.5));        // z17.5→19 でフェードアウト（DEM過拡大＝ボケ/汚れを出さない）
			const cAlpha = (elev.has && !(opts && opts.noTerrain) && view.showContour === true && !rasterBase) ? (1 - ps * ps * (3 - 2 * ps)) * zf : 0;
			if (cAlpha > 0.003 && cam.zoom >= 9) {
				gl.useProgram(contourProg);
				setRayUniforms(contourProg, st);   // #65：視線の基底（f64）＋目＋c
				gl.uniform1i(loc(gl, contourProg, "u_elevTex"), 1);
				gl.uniform4f(loc(gl, contourProg, "u_elevBounds"), elev.bounds[0], elev.bounds[1], elev.bounds[2], elev.bounds[3]);
				setUV4(contourProg, "u_elevOff", elev.bounds);   // 標高 uv 係数（#65・原点相対）
				gl.uniform1f(loc(gl, contourProg, "u_hasElev"), elev.has);
				const iv = cam.zoom >= 15 ? 15 : cam.zoom >= 12 ? 30 : 60;   // 寄るほど細かい間隔(m)
				gl.uniform1f(loc(gl, contourProg, "u_ell"), ellipsoidOn() ? 1 : 0);   // レイ交点 β→測地の復元ゲート
				gl.uniform1f(loc(gl, contourProg, "u_interval"), iv);
				gl.uniform1f(loc(gl, contourProg, "u_major"), iv * 5.0);
				gl.uniform1f(loc(gl, contourProg, "u_alpha"), cAlpha * (view.contourAlpha || 1));
				const cc = view.contourColor || [0.42, 0.30, 0.18];   // 茶(セピア)
				gl.uniform3f(loc(gl, contourProg, "u_cColor"), cc[0], cc[1], cc[2]);
				gl.bindVertexArray(emptyVAO);
				gl.drawArrays(gl.TRIANGLES, 0, 3);
			}
		}
		gl.useProgram(lineProg); gl.uniform1f(loc(gl, lineProg, "u_dpr"), cam.dpr || 1);
		// 案A: 線・塗りのドレープ標高を地形メッシュの折れ線面に量子化（QELEV）。窓と格子 G を fill/line 系へ毎フレーム配布。
		// 地形なし（真俯瞰等）は G=0＝素の elev() へ（量子化する面が存在しない）。
		const mq = (terrainActive && terrain) ? terrain.mesh : null;
		const baseA = view.baseAlpha ?? 1;   // 基図の濃さ（表示パネル）＝fill/line の α に一括
		const setMeshQ = (prog: WebGLProgram): void => {
			gl.uniform1f(loc(gl, prog, "u_baseAlpha"), baseA);
			gl.uniform4f(loc(gl, prog, "u_meshQ"), mq ? mq[0] : 0, mq ? mq[1] : 0, mq ? mq[2] : 1, mq ? mq[3] : 1);
			gl.uniform1f(loc(gl, prog, "u_meshG"), mq ? terrain!.G : 0);
		};
		setMeshQ(lineProg);   // lineProg は直前で useProgram 済み
		if (md && md.lineProg) { gl.useProgram(md.lineProg); setMeshQ(md.lineProg); }
		gl.useProgram(stencilProg); setMeshQ(stencilProg);   // overlay 塗り（uniform はプログラム状態＝ここで年1回/フレーム）
		gl.useProgram(bldProg); setMeshQ(bldProg);           // 基図建物の足元＋gintBld ドレープ線
		if (md && md.bldProg) { gl.useProgram(md.bldProg); setMeshQ(md.bldProg); }
		// ユーザ COG＝基図の塗りに合成（ドレープは塗りの v_ll が担う）。fill 系プログラムへ毎フレーム結線（has=0 でも轍対策）
		gl.useProgram(fillProg); bindCog(fillProg); bindGnd(fillProg); setMeshQ(fillProg);
		if (md && md.fillProg) { gl.useProgram(md.fillProg); bindCog(md.fillProg); bindGnd(md.fillProg); setMeshQ(md.fillProg); }

		// 山岳ビュー＝基図(塗り/線)は地形深度でテストだけする（書かない）：尾根の向こうの道路・塗りが透けない。
		// fill/line の VS は applyLogDepth と同式の対数深度を焼いており地形と直接比較できる。
		if (terrainDepth) { gl.enable(gl.DEPTH_TEST); gl.depthMask(false); }
		// skipMain＝ズームアウト中の「古い詳細シーン」を隠し、常設の粗い下地に揃える（縮んだ細密パッチが
		// 周囲と質感違いで浮くのを防ぐ）。下地は代役なので skipBase より優先＝空白フレームを作らない。
		const slots = (opts && opts.skipMain) ? ["base"]
			: (opts && opts.skipBase) ? ["main"] : ["base", "main"];   // 静止時は下地を隠しLOD痕を消す
		if (sceneHasDraws(scenes.user)) slots.push("user");   // 利用者の vector の層（段 8⑤）＝基図の塗りと線の後
		// 塗りの直描きを伏せる条件：3D（地形あり）＝塗りは地面アトラスへ焼いてある（RTT ドレープ）／ラスタ基図（under・hideFills）＝裁定
		// （線と注記は残す）。2D のラスタ重ねはアトラスに合成済み＝塗り FS が gndMix で塗りの上に載せる（線・注記はその上）
		const rasterHide = gnd.fillsIn || !!(rasterDraws && rasterDraws.hideFills && gnd.rasterOn);
		// 線・塗りのフォグ終端は地形と同一式＝地形が完全に霞んだ先に線だけ生き残って「空に浮く白線」に
		// なるのを構造的に防ぐ。シェーダの遠景平ら化(df)も u_fogFar 基準なので、同値なら線は地形に厳密追随する。
		const fogFarCap = Math.max(st.fogDist * 5.0, 0.026 * pfFog) * fogK();   // fog:false＝無限（gpu と同じ）
		FAR_PIVOT.on = view.gintFarPivot !== false;   // 塗り扇の遠方の要（画面カリング）の逃げ道（view.gintFarPivot=false＝?nofarpivot=1・比較用）
		// gint（1canvas統合・埋込パス）向けの frame コンテキスト：山岳ビュー（terrainDepth）の間だけ、
		// 対数深度係数（setCommonUniforms の u_logCoef と同式）と標高ドレープ一式を渡す＝gint 線が
		// 基図の線と同じ高さ・同じ深度空間で地形に参加（尾根の向こうは隠線＝淡破線）。それ以外は null＝最前面。
		if (terrainDepth) {
			gintCtx = { terrainDepth: true,
				logCoef: lastLogCoef,
				fogFar: fogFarCap, elevTex, elevBounds: elev.bounds,
				elevScale: elevScaleEff, hasElev: elev.has, edgeFade: elev.edgeFade || 0,
				meshQ: mq, meshG: mq ? terrain!.G : 0,   // 案A: gint も描画メッシュ面へ量子化
				noSub: view.gintSub === false,          // 地形適応細分の逃げ道（view.gintSub=false＝?nosub=1）
				facesInAtlas: gnd.fillsIn };            // gint の面は地面アトラス側（bakeFaces）＝画面では線・点だけ
		} else gintCtx = null;
		// 下地の線は「本命(main)の線と同時に出る時だけ」伏せる＝ズーム中に太さ・形状のズレた「LODの荒い線」が
		// 透けるのを防ぐ（従来はmerge時に間引いていたがdraw時判断へ移設）。下地が主役の間（skipMain=ズームアウト
		// 退場中や本命未着）は線も描く＝低ズームは線が絵の本体なので、これが無いと引いた瞬間に真っ白になる。
		const mainLinesOn = slots.indexOf("main") >= 0 && sceneHasDraws(scenes.main);
		// 1 つの枠を描く（li が [lo, hi) の項だけ・pick があればそれで選ぶ）。#123＝基図の枠を差し込みの境で分け、間に利用者の群を描く＝呼ぶたびに枠の uniform を整え直す
		const drawSlot = (slot: string, lo = -Infinity, hi = Infinity, pick: LiPick = null): void => {
			const scene = scenes[slot];
			const inRange = (x: { li: number }): boolean => pick ? pick(x) : x.li >= lo && x.li < hi;
			if (scene.md) {   // multi_draw シーン＝常駐プールのレンジ列を li 順に流す（分岐ロジックは classic と同一）
				setCommonUniforms(md!.fillProg, st, scene.origin, land);
				clipBind("vector", scene.origin);
				gl.useProgram(md!.fillProg); setCogScene(md!.fillProg, scene.origin); setGndScene(md!.fillProg, scene.origin);
				setCommonUniforms(md!.lineProg, st, scene.origin, land);
				gl.useProgram(md!.fillProg); gl.uniform1f(loc(gl, md!.fillProg, "u_fogFar"), fogFarCap);
				gl.useProgram(md!.lineProg); gl.uniform1f(loc(gl, md!.lineProg, "u_fogFar"), fogFarCap);
				gl.uniform1f(loc(gl, md!.lineProg, "u_lift"), cityLift);
				gl.uniform1f(loc(gl, md!.lineProg, "u_dpr"), cam.dpr || 1);
				gl.uniform1i(loc(gl, md!.lineProg, "u_segTex"), 6);
				if (md!.lineTex) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, md!.lineTex); gl.activeTexture(gl.TEXTURE0); }
				ptBind();   // paint 表の (b) 類
				let curProgM: WebGLProgram | null = null;
				for (const e of scene.md.layers) {
					if (!inRange(e)) continue;
					if (e.kind === "fill") {
						if (rasterHide) continue;   // ラスタ基図＝塗りを伏せる
						const seaFBM = seaFbReal(e.li) != null;   // 図郭外フォールバック水域（標高ゲート付き全面WA）
						if ((seaFBM || e.li === sea.li || e.li === sea.li2) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（classicと同じ。フォールバックも紙の海に従う）
						if (hideBldFill && e.li === bldFill.li) continue;   // 3D時＝フットプリント塗りを伏せる（押し出しに委ねる）
						// 水面：全帯で深度テスト維持＝尾根遮蔽（深度免除は「尾根の向こうの湖が山腹に透ける」＝
						// 山中湖バグの復活＝富士 z13 で実測・撤回済み）。DSM帯(z<13)=+30m（ノイズ瘤・偽島対策）、
						// 都市帯(z≥13)=+10m（DTM の河道彫り込み・中州へ疎頂点の水ポリが潜る豊平川対策。5m では不足）。
						if (curProgM !== md!.fillProg) { gl.useProgram(md!.fillProg); gl.bindVertexArray(md!.fillVAO); curProgM = md!.fillProg; }
						gl.uniform1f(loc(gl, md!.fillProg, "u_seaGate"), seaFBM ? 1 : 0);
						gl.uniform2fv(loc(gl, md!.fillProg, "u_tileOff"), e.origins);
						setFx(loc(gl, md!.fillProg, "u_tr"), null, e.fx, cam);   // fill-translate（S-P1-4/5）
						setPz(md!.fillProg, pzOver.get(e.li) ?? e.pz, cam);   // ズーム連続の色（V-Ph3＝S-P1-2）
						gl.uniform1f(loc(gl, md!.fillProg, "u_pt"), e.pt ? 1 : 0);   // paint 表の (b) 類
						if (!setPat(md!.fillProg, e.pat, scene.origin, cam)) continue;   // fill-pattern（S-P1-4/5）＝画像がまだ無い層は描かない
						md!.ext.multiDrawElementsWEBGL(gl.TRIANGLES, e.counts, 0, gl.UNSIGNED_INT, e.offsets, 0, e.counts.length);
						if (slot === "base") dbgC!.baseFill += e.counts.length; else dbgC!.mainFill += e.counts.length;
						if (e.pt) dbgC!.pt += e.counts.length;   // 表を読んだ描く列（paint 表の (b) 類・t-painttable）
					} else {
						if (slot === "base" && mainLinesOn) continue;   // 本命の線が出ている間は下地の線を伏せる
						if (curProgM !== md!.lineProg) { gl.useProgram(md!.lineProg); gl.bindVertexArray(emptyVAO); curProgM = md!.lineProg; }
						gl.uniform2fv(loc(gl, md!.lineProg, "u_tileOff"), e.origins);
						gl.uniform1f(loc(gl, md!.lineProg, "u_cj"), e.cj || 0);   // 端と継ぎ（S-P1-1）
						if (e.dashU === undefined) e.dashU = dashU(e.dash, e.cj || 0);
						setDash(loc(gl, md!.lineProg, "u_dashP"), loc(gl, md!.lineProg, "u_dashI"), e.dashU, cam);   // 破線（S-P1-3）
						setFx(loc(gl, md!.lineProg, "u_tr"), loc(gl, md!.lineProg, "u_blur"), e.fx, cam);   // line-translate・ぼかし（S-P1-4/5）
						setPz(md!.lineProg, pzOver.get(e.li) ?? e.pz, cam);   // ズーム連続の色・線幅（V-Ph3＝S-P1-2）
						gl.uniform1f(loc(gl, md!.lineProg, "u_pt"), e.pt ?? 0);   // paint 表の (b) 類（2＝線の半幅も表・段 2b）
						if (!setLt(md!.lineProg, e.lt, cam)) continue;   // line-gradient（G-3）・line-pattern（G-4＝画像がまだ無い層は描かない）
						md!.ext.multiDrawArraysWEBGL(gl.TRIANGLES, e.firsts, 0, e.counts, 0, e.counts.length);
						if (slot === "base") dbgC!.baseLine += e.counts.length; else dbgC!.mainLine += e.counts.length;
						if (e.pt) dbgC!.pt += e.counts.length;
						if (e.pt === 2) dbgC!.ptw += e.counts.length;   // 線の半幅も表から（段 2b）
					}
				}
				gl.bindVertexArray(null);
				return;
			}
			if (!scene.draws.length) return;
			const userSlot = slot === "user";   // 利用者の vector の層（段 8⑤）＝基図の濃さとラスタ基図の hideFills に従わない（3D の塗りはアトラス側）
			setCommonUniforms(fillProg, st, scene.origin, land);
			setCommonUniforms(lineProg, st, scene.origin, land);
			clipBind("vector", scene.origin);
			gl.useProgram(fillProg); gl.uniform1f(loc(gl, fillProg, "u_fogFar"), fogFarCap); setCogScene(fillProg, scene.origin); setGndScene(fillProg, scene.origin);
			if (userSlot) gl.uniform1f(loc(gl, fillProg, "u_baseAlpha"), 1);
			gl.useProgram(lineProg); gl.uniform1f(loc(gl, lineProg, "u_fogFar"), fogFarCap);
			gl.uniform1f(loc(gl, lineProg, "u_lift"), cityLift);
			if (userSlot) gl.uniform1f(loc(gl, lineProg, "u_baseAlpha"), 1);
			lineOffZero();
			let curProg: WebGLProgram | null = null;
			for (const d of scene.draws) {
				if (!inRange(d)) continue;
				if (d.kind === "fill") {
					if (userSlot ? gnd.fillsIn : rasterHide) continue;   // ラスタ基図＝塗りを伏せる（利用者の層は 3D のアトラスに入った時だけ）
					const seaFBC = seaFbReal(d.li) != null;   // 図郭外フォールバック水域（標高ゲート付き全面WA）
					if ((seaFBC || d.li === sea.li || d.li === sea.li2) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（詳細以外は描かない＝紙の海）。li2=水系点火面
					if (hideBldFill && d.li === bldFill.li) continue;   // 3D時＝フットプリント塗りを伏せる（押し出しに委ねる）
					// 水面は「+30mリフトして深度テスト復帰」：旧・免除（後書き）はチルトで尾根の遮蔽が効かず、
					// 稜線の向こうの湖が山腹に透けた（山中湖で顕在化）。リフトが DSM の水面ノイズ瘤(±10m級)を
					// 沈め「湖の偽の島」（琵琶湖）も防ぐ＝両立。数百m級の尾根には引き続き隠される。
					if (curProg !== fillProg) { gl.useProgram(fillProg); curProg = fillProg; }
					// 水面リフト＝md 経路と同判断（深度は全帯維持・DSM帯30m/都市帯10m）
					gl.uniform1f(loc(gl, fillProg, "u_seaGate"), seaFBC ? 1 : 0);
					setFx(loc(gl, fillProg, "u_tr"), null, d.fx, cam);   // fill-translate（S-P1-4/5）
					setPz(fillProg, pzOver.get(d.li) ?? d.pz, cam);   // ズーム連続の色（V-Ph3＝S-P1-2）
					if (!setPat(fillProg, d.pat, scene.origin, cam)) continue;   // fill-pattern（S-P1-4/5）＝画像がまだ無い層は描かない
					gl.bindVertexArray(d.vao);
					if (d.idxT) gl.drawElements(gl.TRIANGLES, d.count, d.idxT, 0);
					else gl.drawArrays(gl.TRIANGLES, 0, d.count);
					if (slot === "base") dbgC!.baseFill++; else dbgC!.mainFill++;
				} else {
					if (slot === "base" && mainLinesOn) continue;   // 本命の線が出ている間は下地の線を伏せる
					if (curProg !== lineProg) { gl.useProgram(lineProg); curProg = lineProg; }
					gl.uniform1f(lineL("u_cj"), d.cj);   // 端と継ぎ（S-P1-1）
					setDash(lineL("u_dashP"), lineL("u_dashI"), d.dash, cam);   // 破線（S-P1-3）
					setFx(lineL("u_tr"), lineL("u_blur"), d.fx, cam);   // line-translate・ぼかし（S-P1-4/5）
					setPz(lineProg, pzOver.get(d.li) ?? d.pz, cam);   // ズーム連続の色・線幅（V-Ph3＝S-P1-2）
					if (!setLt(lineProg, d.lt, cam)) continue;   // line-gradient（G-3）・line-pattern（G-4＝画像がまだ無い層は描かない）
					gl.bindVertexArray(d.vao);
					drawLineInst(d.count);
					if (slot === "base") dbgC!.baseLine++; else dbgC!.mainLine++;
				}
			}
			if (userSlot) { gl.useProgram(fillProg); gl.uniform1f(loc(gl, fillProg, "u_baseAlpha"), baseA); gl.useProgram(lineProg); gl.uniform1f(loc(gl, lineProg, "u_baseAlpha"), baseA); }   // 利用者の層で 1 にした基図の濃さを戻す（後の基図の枠・後のパスが同じプログラムを使う・#123）
		};
		// 差し込み（#123）：利用者の層（user の枠）のうち表に載った物は、最後に描く基図の枠（host）の li ≥ anchor の項の前に描く。表に無い物・基図の枠が無い時は今どおり最後
		const ua = userAnchorPlan(slots.indexOf("user") >= 0 ? [...slots].reverse().find(sl => sl !== "user" && sceneHasDraws(scenes[sl])) : null);
		for (const slot of slots) {   // 粗い下書き→現ズームの順
			if (slot === "user") { drawSlot("user", -Infinity, Infinity, ua.host ? d => ua.anchorOf(d.li) === Infinity : null); continue; }
			if (slot !== ua.host) { drawSlot(slot); continue; }
			let lo = -Infinity;
			for (const a of ua.anchors) { drawSlot(slot, lo, a); drawSlot("user", -Infinity, Infinity, d => ua.anchorOf(d.li) === a); lo = a; }
			drawSlot(slot, lo, Infinity);
		}
		if (terrainDepth) { gl.disable(gl.DEPTH_TEST); gl.depthMask(true); }   // 基図の深度テストを解除（overlayは従来通り最前面）
		// overlay（外部ベクタ=geopbf/e-Stat）：stencil-then-cover で塗り（earcut不要・扇なし）＋境界線。深度off・最前面。
		drawOverlay(st, cam.dpr || 1, land, cam.zoom || 0);
		// 10度レチクル（view.graticule・v1「地図の上に Canvas2D で重ねる」と同じ最前面・ラベルの下）：
		// z1.7→2.2 で出現（v1 borders minZoom2）・z6.0→6.5 で退場（基図=日本帯へ委ねる）。白の細線＝v1と同じ。
		if (view.graticule && !flat2d) {
			const gratA = Math.max(0, Math.min(1, ((cam.zoom || 0) - 1.7) / 0.5)) * Math.max(0, Math.min(1, ((view.worldHypsoZ ?? 6.5) - (cam.zoom || 0)) / 0.5)) * 0.5;   // 罫線もハイプソと同じ帯で退場
			if (gratA > 0.003) {
				gl.useProgram(gratProg);
				setRayUniforms(gratProg, st);   // #65：視線の基底（f64）＋目＋c
				gl.uniform1f(loc(gl, gratProg, "u_ell"), ellipsoidOn() ? 1 : 0);
				gl.uniform1f(loc(gl, gratProg, "u_alpha"), gratA);
				gl.uniform4f(loc(gl, gratProg, "u_gratC"), ...(worldPal().grat as Vec4T));   // テーマのレチクル色（既定=白）
				gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3);
			}
		}
		gl.enable(gl.DEPTH_TEST);   // 建物は常に深度で前後関係を解決（地形・尾根に遮蔽される）

		// 建物（3D押し出し）：深度で前後関係を解決（地形・尾根にも遮蔽される）。
		// メッシュの区bbox 内だけ基図建物を伏せる（u_meshBboxN）＝同一体積の全面 z-fight を断ちつつ、範囲外の建物は残す。
		// マスクは区単位（meshMasks）＝最大 MAX_MESH_MASKS 区まで（シェーダのスロット数固定）。
		// 真俯瞰（チルト≈0）では基図/建物メッシュ とも建物3Dを描かない＝平面地図（閾値は flat2d と同じ 0.02rad≈1.1°）。
		const show3d = (cam.pitch || 0) >= 0.02;
		// 建物マスク bit7(0x80)＝面ドレープの深度統合（2026-08-14・WebGPU dsWriteBld と同義）：建物の見えている画素に
		// stencil bit7 を刻む→gint の cover/idResolve が「建物の陰」を画素単位でスキップ。毎フレーム bit7 だけ先に掃除
		//（前フレームの残骸＝カメラ移動で建物が動いた分の staleを断つ）。winding(0x7F) は gint 側が自前 clear＝不干渉。
		gl.stencilMask(0x80);
		gl.clearStencil(0);
		gl.clear(gl.STENCIL_BUFFER_BIT);
		const bldStencil = (on: boolean): void => {   // on＝建物ドロー中だけ REPLACE で bit7 を刻む（gintBld の線/点は対象外）
			if (on) { gl.enable(gl.STENCIL_TEST); gl.stencilFunc(gl.ALWAYS, 0x80, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE); gl.stencilMask(0x80); }
			else { gl.disable(gl.STENCIL_TEST); gl.stencilMask(0xFF); }
		};
		const mdBld = scenes.main.md && scenes.main.md.bld;   // multi_draw シーンの建物＝プールレンジ列（チャンク配列）
		const bld = show3d && !(opts && opts.skipMain) && !(opts && opts.noBld) ? (scenes.main.bld || mdBld) : null;   // 建物はmainシーンの一部＝一緒に退場。noBld=?nobld=1診断ノブ（二重壁の切り分け）
		if (bld) {
			bldStencil(true);
			const prog = scenes.main.bld ? bldProg : md!.bldProg;
			const c = view.bldColor || [0.86, 0.86, 0.85];
			setCommonUniforms(prog, st, scenes.main.origin, land);
			clipBind("buildings", scenes.main.origin);
			gl.uniform3f(loc(gl, prog, "u_bldColor"), c[0], c[1], c[2]);
			// 可視優先の4枠選抜（2026-08-04）：旧・読み込み順slice(0,4)は、全保持化(2026-08-03)でマスクが何区も
			// 溜まると「今見ている区が枠に入らない」→基図建物が伏せられずメッシュの壁と数十cm差の深度戦い＝
			// pan/zoom中だけ壁面が瞬く（対数深度係数が毎フレーム再配分・大きいビルは基図押し出しが低いぶん
			// 下部だけ・本人実機で特定）。カメラ→区bbox距離の昇順＝画面の区が必ず枠を取る（内包=距離0・
			// 同率はsort安定性でMap挿入順のまま＝フレーム間で選抜が揺れない）。
			const mcx = cam.center[0], mcy = cam.center[1], mcw = Math.cos(mcy * Math.PI / 180);
			const mdist = (m: MeshMask): number => { const bb = m.bbox; const dx = Math.max(bb[0] - mcx, 0, mcx - bb[2]) * mcw, dy = Math.max(bb[1] - mcy, 0, mcy - bb[3]); return dx * dx + dy * dy; };
			const active = [...meshMasks.entries()].filter(([w]) => !meshHidden.has(w)).map(([, m]) => m)
				.sort((a, b) => mdist(a) - mdist(b)).slice(0, MAX_MESH_MASKS);   // 非表示区のマスクはスロットに載せない＝基図建物が戻る
			gl.uniform1i(loc(gl, prog, "u_meshCount"), active.length);
			const mo = scenes.main.origin || [0, 0];
			for (let i = 0; i < MAX_MESH_MASKS; i++) {
				// スロットは (off, inv)＝FS の uv = off + rel×inv。off=(origin−bboxMin)/span を JS の f64 で前計算＝
				// FS は原点相対の小値だけ扱う（絶対経緯度 varying の f32 ジッタ＝深ズームの点描ゴースト根治）。空きは uv 圏外。
				const m = active[i], bb = m && m.bbox;
				const sx = bb ? bb[2] - bb[0] : 1, sy = bb ? bb[3] - bb[1] : 1;
				gl.uniform4f(loc(gl, prog, `u_meshBbox${i}`), bb ? (mo[0] - bb[0]) / sx : 2e9, bb ? (mo[1] - bb[1]) / sy : 2e9, bb ? 1 / sx : 0, bb ? 1 / sy : 0);
				// 空きスロットも「null を」バインド＝unit2..5 は gint（pivotTex/idTex/fidStyle＝RGBA32UI整数）と共用。
				// 残留整数テクスチャを float sampler(u_meshMask) が掴むと sampler型不整合で draw 全滅（unit1 と同病）。
				gl.activeTexture(gl.TEXTURE2 + i); gl.bindTexture(gl.TEXTURE_2D, m ? m.tex : null); gl.activeTexture(gl.TEXTURE0);
				gl.uniform1i(loc(gl, prog, `u_meshMask${i}`), 2 + i);
			}
			if (scenes.main.bld) {
				gl.bindVertexArray((bld as GLBld).vao);
				gl.drawArrays(gl.TRIANGLES, 0, (bld as GLBld).count);
			} else {
				gl.bindVertexArray(md!.bldVAO);
				for (const e of mdBld!) {
					gl.uniform2fv(loc(gl, prog, "u_tileOff"), e.origins);
					md!.ext.multiDrawArraysWEBGL(gl.TRIANGLES, e.firsts, 0, e.counts, 0, e.counts.length);
				}
			}
			bldStencil(false);   // gintBld（筆ドレープ線/点）は建物でない＝bit7 を刻まない
		}
		// gint ユーザー層（moj筆/ドロップ図形）の地形沿い境界線：各頂点が自分の標高に乗る（anchor=自分）＝辺が地形に沿う。
		// ★常時描画（show3d ゲートなし）＝平面との連続性：高さ=elev×elevScaleEff で、真俯瞰(elevScaleEff=0)は海面の平面、
		//   チルトで滑らかに地形へ立ち上がる（同じ線が elevScale でモーフ＝ポップしない）。独自 origin・深度で地形/尾根に遮蔽。
		// fillなし＝GL_LINES。メッシュマスク不要(count0)。
		if (gintBld) {
			setCommonUniforms(bldProg, st, gintBld.origin, land);
			clipBind("vector", gintBld.origin);   // 利用者の図形の地形沿いの線＝ベクタ
			gl.uniform1i(loc(gl, bldProg, "u_meshCount"), 0);
			for (let i = 0; i < MAX_MESH_MASKS; i++) {   // 空きスロットも null バインド＝残留整数texをfloat samplerが掴む事故を防ぐ（main bld と同病対策）
				gl.uniform4f(loc(gl, bldProg, `u_meshBbox${i}`), 1e9, 1e9, -1e9, -1e9);
				gl.activeTexture(gl.TEXTURE2 + i); gl.bindTexture(gl.TEXTURE_2D, null); gl.activeTexture(gl.TEXTURE0);
				gl.uniform1i(loc(gl, bldProg, `u_meshMask${i}`), 2 + i);
			}
			for (const bt of gintBld.batches) {
				const c = bt.color || view.bldColor || [0.86, 0.86, 0.85];
				gl.uniform3f(loc(gl, bldProg, "u_bldColor"), c[0], c[1], c[2]);
				if (bt.lineCount) { gl.bindVertexArray(bt.lineVAO); gl.drawArrays(gl.LINES, 0, bt.lineCount); }
				if (bt.pointCount) { gl.bindVertexArray(bt.pointVAO); gl.drawArrays(gl.POINTS, 0, bt.pointCount); }
			}
		}
		// 建物メッシュ（LOD2 等）（任意三角形・面法線陰影）。深度で地形・自身の前後を解決。
		// ※巻き順が不揃いなデータなので back-face カリングは使わない（屋根を誤って捨てる）＝両面描画。
		//   z-fight の元＝重複面は worker 側の頂点3つ組 dedup で断つ。
		// バッチ単位でフラスタムカリング＝区全体(数百万tris)のうち画面に掛かるバッチだけ頂点処理へ流す。
		// 球体が半透明（Cesium の globe.translucency）＝地面の深度を捨ててから模型を描く＝地下の模型（坑道）が地面越しに見える（地面どうしの前後は深度で済ませた後）
		if (meshes.size && globeA < 1 && terrainActive) gl.clear(gl.DEPTH_BUFFER_BIT);
		if (meshes.size && (show3d || meshKeep2d())) {   // 真俯瞰でも keep2d のバッチ（統計の押し出し）は描く＝色を平面のまま見せる
			bldStencil(true);   // 建物メッシュも建物＝bit7 を刻む
			gl.useProgram(meshProg);
			let curProg = meshProg;
			const c = view.bldColor || [0.86, 0.86, 0.85];   // 基図の押し出し建物と同色＝周辺と地続きに見せる
			const pad = 0.5 * Math.max(st.W, st.H), foot = betaGeo(st.eye);          // 高層ビルの頭のはみ出し余白（半画面）・foot＝目の足元
			// LOD打ち切りの物差し＝画面1pxが何mか（app.js approxViewBbox と同式。ortho-z は緯度非依存）。
			// 「画面上~1px未満の建物は描かない」＝見た目は変えずに頂点処理を捨てる。遠方バッチは距離で緩やかに閾値を上げる
			// （チルト時の遠景は透視で1pxがもっと大きい＝控えめ側の近似）。
			const mppx = 156543.03392 * 0.819 / Math.pow(2, cam.zoom || 0);
			const cosLat = Math.cos((cam.center[1] || 0) * Math.PI / 180);
			const vis: { p: MeshBatch; count: number }[] = [];   // 可視バッチ（カリング＋LOD 済み）＝描く順を並べ替えるため一度溜める
			for (const p of meshes.values()) {
				if (!show3d && !p.keep2d) continue;   // 真俯瞰＝建物 3D は描かない（keep2d だけ通す）
				if (meshHidden.has(p.ward)) continue;   // 常駐中の非表示区（VRAM保持・draw skip）
				if (!bboxVisible(st, movedBbox(p.bbox, p.origin, p.xf), cam.center, foot, pad, betaGeo(p.xf ? [p.origin[0] + p.xf[9], p.origin[1] + p.xf[10], p.origin[2] + p.xf[11]] : p.origin)[2])) continue;   // 重心の高さで射影（camera.ts bboxVisible）
				let count = p.count;
				// LOD打ち切りは建物のみ。橋梁（two＝両面）は「高さ3〜5m×長さ数百m」＝高さ基準だと小物と誤判定され
				// 桁が距離で歯抜けになる（横浜ベイブリッジで実測）ため適用しない。橋梁データは軽い＝全描画で問題ない。
				if (p.lodH && !p.two && !p.keep2d) {   // index は建物高さ降順＝先頭 count で「高さ閾値以上だけ」になる（keep2d＝統計＝低い値も意味がある＝間引かない）
					const dm = Math.hypot(((p.bbox[0] + p.bbox[2]) / 2 - cam.center[0]) * 111320 * cosLat, ((p.bbox[1] + p.bbox[3]) / 2 - cam.center[1]) * 111320);
					const minH = mppx * (1 + dm / 4000);
					let li = 0;
					for (let i = p.lodH.length - 1; i > 0; i--) if (p.lodH[i] <= minH) { li = i; break; }
					count = p.lodCounts![li];
					if (!count) continue;
				}
				vis.push({ p, count });
			}
			// 描く順＝素の建物メッシュ → 模型（不透明/MASK）→ 模型（BLEND＝半透明）。半透明は奥から手前（バッチ重心とカメラの距離）・深度書き込み無し・
			// 前乗算 α（既定の blendFunc ONE/ONE_MINUS_SRC_ALPHA）。バッチ内の三角形順は並べ替えない（自己重なりの前後は割り切り）
			const ex = st.eye, d2 = (p: MeshBatch): number => (p.origin[0] - ex[0]) ** 2 + (p.origin[1] - ex[1]) ** 2 + (p.origin[2] - ex[2]) ** 2;
			const order = [...vis.filter(v => !v.p.textured), ...vis.filter(v => v.p.textured && !blendOf(v.p)), ...vis.filter(v => v.p.textured && blendOf(v.p)).sort((x, y) => d2(y.p) - d2(x.p))];
			let zOff = false;
			const common = new Set();   // 共通 uniform（カメラ・霧・標高窓・建物色）を入れ終えたプログラム＝バッチ毎でなくプログラム毎に 1 回（GL の uniform はプログラムに残る）
			const sils = order.filter(v => v.p.textured && v.p.sil && !blendOf(v.p));   // 半透明の束（プロペラの円盤など）は殻を出さない＝透けて殻が見える
			if (sils.length) {   // 模型の輪郭線（Model.silhouette）＝模型より先に・深度を書かずに押し出した殻を塗る（模型が内側を塗り直す）
				const pg = meshSilProg; gl.useProgram(pg); curProg = pg; gl.depthMask(false);
				setCommonUniforms(pg, st, [0, 0], land);
				for (const { p, count } of sils) {
					const lb = p.noLift ? null : p.drape ? DRAPE_ALL : elev.liftBounds;
					gl.uniform4f(loc(gl, pg, "u_liftBounds"), lb ? lb[0] : 0, lb ? lb[1] : 0, lb ? lb[2] : 0, lb ? lb[3] : 0);
					gl.uniform4f(loc(gl, pg, "u_silColor"), p.sil![0], p.sil![1], p.sil![2], p.sil![3]); gl.uniform1f(loc(gl, pg, "u_silPx"), p.sil![4]);
					gl.uniform3f(loc(gl, pg, "u_meshOrigin"), p.origin[0], p.origin[1], p.origin[2]);
					gl.uniform3f(loc(gl, pg, "u_eyeRel"), st.eye[0] - p.origin[0], st.eye[1] - p.origin[1], st.eye[2] - p.origin[2]);
					gl.uniform1f(loc(gl, pg, "u_xfOn"), p.xf ? 1 : 0);
					if (p.xf) { gl.uniformMatrix3fv(loc(gl, pg, "u_xfL"), false, p.xf.subarray(0, 9)); gl.uniform3f(loc(gl, pg, "u_xfT"), p.xf[9], p.xf[10], p.xf[11]); }
					const cM = mat.transform(st.mvp, [p.origin[0], p.origin[1], p.origin[2], 1]);
					gl.uniform4f(loc(gl, pg, "u_clipMesh"), cM[0], cM[1], cM[2], cM[3]);
					gl.bindVertexArray(p.vao);
					gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
				}
				gl.depthMask(true);
			}
			let csV: Float32Array | null = null;   // CustomShader の世界→目（EC）の回転＝フレームに 1 度
			if (customs.size) csFrame++;
			for (const { p, count } of order) {
				const cse = csOf(p), csp = cse ? csProg(cse, p) : null;
				const pg = csp ?? (p.textured ? (clipOn && p.noClip ? (shOn ? varProgs(false, true).meshTex : meshTexProg0) : meshTexProg) : meshProg);   // 模型（uv＋頂点色＋テクスチャ）は派生プログラム＝切替は模型の分だけ・CustomShader は束ごとのプログラム
				if (pg !== curProg) { gl.useProgram(pg); curProg = pg; }
				if (cse && csp) {   // Cesium の CustomShader：J・V・照明／半透明の型・czm_frameNumber・利用者の uniform とテクスチャ
					if (!csV) { const r = st.invMvp ? viewRays(st.mvp, st.invMvp) : null; csV = r ? csViewMat(r.F, r.X, r.Y) : Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1); }
					gl.uniformMatrix3fv(loc(gl, pg, "u_csJ"), false, p.mcJ ?? Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1));
					gl.uniformMatrix3fv(loc(gl, pg, "u_csV"), false, csV);
					gl.uniform2f(loc(gl, pg, "u_csMode"), cse.spec.lighting === "UNLIT" ? 1 : cse.spec.lighting === "PBR" ? -1 : 0, cse.spec.translucency === "TRANSLUCENT" ? 1 : 0);
					gl.uniform1f(loc(gl, pg, "u_czmFrame"), csFrame);
					let unit = CS_TEX_UNIT;
					for (const [name, t] of Object.entries(cse.spec.uniforms || {}) as [string, CsUType][]) {
						if (t === "sampler2D") { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, cse.tex.get(name) ?? whiteTex); gl.uniform1i(loc(gl, pg, "cu_" + name), unit++); continue; }
						csGlUniform(gl, loc(gl, pg, "cu_" + name), t, cse.spec.values?.[name]);
					}
					(p.meta?.texs || []).forEach((t, k) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(loc(gl, pg, "csmt_" + k), unit++); });   // property texture（fsInput.metadata）
					gl.activeTexture(gl.TEXTURE0);
					if (!p.mc) gl.vertexAttrib4f(MC_LOC, 0, 0, 0, 0);   // positionMC の無い束（読み込み後に差した）＝0
					if (!p.uvm) gl.vertexAttrib2f(UVM_LOC, 0, 0);
				}
				if (clipOn && !(p.textured && p.noClip)) {   // 模型（textured）＝models・建物メッシュ＝buildings。面は main 原点から・u_clO＝メッシュ原点 − main 原点（f64）
					const O = lonlatTo3D(...((scenes.main.origin || [0, 0]) as [number, number]));
					clipBind(p.textured ? "models" : "buildings", scenes.main.origin);
					gl.uniform3f(loc(gl, pg, "u_clO"), p.origin[0] - O[0], p.origin[1] - O[1], p.origin[2] - O[2]);
				}
				if (p.textured) {
					gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, p.tex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(loc(gl, pg, "u_tex"), 7);   // unit 7＝未使用（1=elev 2..5=mask 6=line 8=far 9=cog 12=clim）
					gl.uniform1f(loc(gl, pg, "u_alphaCut"), p.cut); gl.uniform1f(loc(gl, pg, "u_blend"), blendOf(p));
					gl.uniform1f(loc(gl, pg, "u_tintB"), p.tint ? p.tint[4] : -1); if (p.tint) gl.uniform4f(loc(gl, pg, "u_tint"), p.tint[0], p.tint[1], p.tint[2], p.tint[3]);   // Cesium の Model.color（-1＝無し）
					gl.activeTexture(gl.TEXTURE0 + PAINT_UNIT); gl.bindTexture(gl.TEXTURE_2D, p.paint ?? whiteTex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(loc(gl, pg, "u_paint"), PAINT_UNIT); gl.uniform1f(loc(gl, pg, "u_paintB"), p.paint ? p.paintB ?? 0 : -1);   // 塗る絵（-1＝無し）
					const dr = p.imagery && !p.paint ? drapes.get(p.imagery) : undefined;   // 重ねる絵（Cesium3DTileset.imageryLayers）＝窓の平面写像を束の原点に合わせて（double）・塗る絵のある束には重ねない（WebGPU は同じ枠＝絵を揃える）
					drapeUniforms(drU, 0, dr?.map ?? null, p.origin);
					gl.activeTexture(gl.TEXTURE0 + DRAPE_UNIT); gl.bindTexture(gl.TEXTURE_2D, dr?.tex ?? whiteTex); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(loc(gl, pg, "u_drape"), DRAPE_UNIT);
					gl.uniform4f(loc(gl, pg, "u_drU"), drU[0], drU[1], drU[2], drU[3]); gl.uniform4f(loc(gl, pg, "u_drV"), drU[4], drU[5], drU[6], drU[7]); gl.uniform1f(loc(gl, pg, "u_drOn"), drU[8]);
				}
				gl.uniform2f(loc(gl, pg, "u_split"), p.split ? Math.sign(p.split) * (1 + splitPos) : 0, canvas.width);   // Cesium splitDirection
				const bl = p.textured && !!blendOf(p);
				if (bl !== zOff) { zOff = bl; gl.depthMask(!zOff); }   // 半透明＝深度を書かない（後ろの半透明が消えない）
				if (!common.has(pg)) {
					common.add(pg); setCommonUniforms(pg, st, [0, 0], land); gl.uniform3f(loc(gl, pg, "u_bldColor"), c[0], c[1], c[2]);
					gl.uniform1f(loc(gl, pg, "u_lightOn"), light ? 1 : 0);   // style の light（B3）＝無ければ従来の固定光
					if (light) { gl.uniform3f(loc(gl, pg, "u_lightDir"), light.dir[0], light.dir[1], light.dir[2]); gl.uniform1f(loc(gl, pg, "u_lightI"), light.intensity ?? 0.5); const lc = light.color || [1, 1, 1]; gl.uniform3f(loc(gl, pg, "u_lightColor"), lc[0], lc[1], lc[2]); }
					if (meshLight) { gl.uniform3f(loc(gl, pg, "u_csDir"), meshLight.dir[0], meshLight.dir[1], meshLight.dir[2]); gl.uniform3f(loc(gl, pg, "u_csColor"), meshLight.color[0], meshLight.color[1], meshLight.color[2]); gl.uniform3f(loc(gl, pg, "u_csIbl"), meshLight.ibl[0], meshLight.ibl[1], meshLight.invL00); gl.uniform2f(loc(gl, pg, "u_csEnv"), envTex ? 1 : 0, envLod); }
					gl.uniform1i(loc(gl, pg, "u_lightN"), lights ? lights.n : 0);   // 局所の光源（W2）＝4 本の vec4[8] をそのまま流す
					if (lights) { const d = lights.data; for (let i = 0; i < 4; i++) { const a = new Float32Array(32); for (let k = 0; k < 8; k++) a.set(d.subarray(k * 16 + i * 4, k * 16 + i * 4 + 4), k * 4); gl.uniform4fv(loc(gl, pg, ["u_lA", "u_lB", "u_lC", "u_lD"][i]), a); } }
				}
				const lb = p.noLift ? null : p.drape ? DRAPE_ALL : elev.liftBounds;   // DTM保証域（無ければ全0＝リフトなし）・noLift＝持ち上げない（平面の統計）・drape＝全域で持ち上げる
				gl.uniform4f(loc(gl, pg, "u_liftBounds"), lb ? lb[0] : 0, lb ? lb[1] : 0, lb ? lb[2] : 0, lb ? lb[3] : 0);
				gl.uniform1f(loc(gl, pg, "u_csOn"), !meshLight || p.csLit === "off" ? 0 : p.csLit === "unlit" ? 2 : 1);   // Cesium の模型の照明（setMeshLighting）：1＝csLit・2＝素の色・0＝固定光
				if (meshLight) { gl.uniform2f(loc(gl, pg, "u_csMR"), p.pbr ? p.pbr.metallic : 0, p.pbr ? p.pbr.roughness : 1); gl.uniform2f(loc(gl, pg, "u_csCC"), p.pbr?.clearcoat?.[0] ?? 0, p.pbr?.clearcoat?.[1] ?? 0); gl.uniform3fv(loc(gl, pg, "u_csSH"), p.sh ?? meshLight.sh); gl.uniform4fv(loc(gl, pg, "u_olC"), p.ol ?? OL_NONE); }   // バッチの材質と環境光（模型ごとの meshEnv が勝つ）   // バッチの材質（Cesium の照明）
				gl.uniform1f(loc(gl, pg, "u_cullBack"), p.two || p.noCull ? 0 : 1);   // 橋梁＝両面（開いた薄面が裏から消えない）・noCull＝面の向きが揃っていない建物
				gl.uniform3f(loc(gl, pg, "u_meshOrigin"), p.origin[0], p.origin[1], p.origin[2]);  // RTE 錨（頂点は重心相対 delta）
				gl.uniform3f(loc(gl, pg, "u_eyeRel"), st.eye[0] - p.origin[0], st.eye[1] - p.origin[1], st.eye[2] - p.origin[2]);   // 目 − 原点（double）＝v_toEye の錨（近接の裏面判定）
				gl.uniform1f(loc(gl, pg, "u_xfOn"), p.xf ? 1 : 0);   // バッチの剛体変換（glTF の rigid アニメ・W4）＝L（3x3 列優先）と原点相対の平行移動
				if (p.xf) { gl.uniformMatrix3fv(loc(gl, pg, "u_xfL"), false, p.xf.subarray(0, 9)); gl.uniform3f(loc(gl, pg, "u_xfT"), p.xf[9], p.xf[10], p.xf[11]); }
				const cM = mat.transform(st.mvp, [p.origin[0], p.origin[1], p.origin[2], 1]);   // clip錨を CPU(double) で（旧: シェーダ float32 で mvp*meshOrigin＝相殺）
				gl.uniform4f(loc(gl, pg, "u_clipMesh"), cM[0], cM[1], cM[2], cM[3]);
				gl.bindVertexArray(p.vao);
				gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, 0);
			}
			if (zOff) gl.depthMask(true);
			bldStencil(false);
		}
		// 面の貼り付け（分類）＝描き終えた深度（地形・建物・3D Tiles・模型）に柱を当てる。bit7（建物・メッシュの画素）を読むので建物の後
		if (classify.size) classify.draw(st, logCoefOf(st), terrain && elev.has && elev.scale > 0 ? 1 - (terrainActive ? elevScaleEff / elev.scale : 0) : 0, !terrainDepth);   // 真俯瞰の平ら化に柱を合わせる（classify.ts flatOrigin）・地面が深度を書かない時は単位球を地面に
		gl.disable(gl.DEPTH_TEST);
		// 夜面（星空劇場と同じ z<4 ゲート・同じフェード）：時計の時刻の太陽直下点（ephem/sun＝solar と同じ式・均時差込み。
		// 旧＝v1 nightJSON の赤緯正弦近似＋UTC 時刻→経度）を平行光源に、夜半球を夜紺で減光。地図の全レイヤの上に重ねる。
		// view.night＝false で描かない（MapLibre の口から起こした地図・公式例の門 段 2＝既定は描く）
		if (worldFade > 0 && view.night !== false) {
			const [sunLng, sunLat] = sunSubpoint(clockNow(view.clock));
			const cs = Math.cos(sunLat);
			gl.useProgram(nightProg);
			setRayUniforms(nightProg, st);   // #65：視線の基底（f64）＋目＋c
			gl.uniform3f(loc(gl, nightProg, "u_sun"), cs * Math.cos(sunLng), Math.sin(sunLat), cs * Math.sin(sunLng));
			gl.uniform1f(loc(gl, nightProg, "u_alpha"), 0.5 * worldFade * globeA);   // v1 の夜面 50% × 出現フェード × 球体の不透明度
			gl.bindVertexArray(emptyVAO);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		}
		gl.bindVertexArray(null);
		return fogAnimating;   // true＝フォグ距離が収束中（呼び出し側は次フレームも描く）
	}

	function disposeSlot(slot: string): void {
		for (const d of scenes[slot].draws) { for (const b of d.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(d.vao); }
		if (scenes[slot].bld) { for (const b of scenes[slot].bld.bufs) gl.deleteBuffer(b); gl.deleteVertexArray(scenes[slot].bld.vao); }
		scenes[slot] = { origin: scenes[slot].origin, draws: [], bld: null, md: null };   // md シーンは参照リストだけ＝GL資源なし（プールは常駐）
	}
	function dispose(): void { classify.dispose(); clipFree(); shadowFree(); for (const v of rawLRU.values()) gl.deleteTexture(v.tex); rawLRU.clear(); rawBytes = 0; if (rs) { gl.deleteFramebuffer(rs.fbo); gl.deleteVertexArray(rs.vao); for (const p of rs.progs) gl.deleteProgram(p); rs = null; }   // 標高セルの GPU 再標本化（P1 step 1）の資源
		for (let i = 0; i < 4; i++) { gndFree1(gnd.w[i]); gnd.w[i] = null; } gnd.n = 0; disposeSlot("base"); disposeSlot("main"); disposeSlot("user"); disposeOverlay(overlay); disposeOverlay(overlayHi); disposeOverlay(overlayHover); disposeOverlay(wdepr); disposeOverlay(lakes); for (const o of rail) disposeOverlay(o); setGintBld(null); depthOut(false); }

	// 汎用 set(cmd, data, prop)：ortho-map createLayers の set プロトコルに整合。将来 worker では
	// postMessage({ type:"set", cmd, data, prop }, transferables) にそのまま載る。prop は cmd ごとに融通。
	function set(cmd: string, data?: unknown, prop?: unknown): void {
		switch (cmd) {
			case "view":      setView(data as Partial<GLView>); break;
			case "patImage":  setPatImage(data as Parameters<typeof setPatImage>[0]); break;                       // fill-pattern の画像（S-P1-4/5・render worker が記号帳の写しを回す）                                            // data={clear,land,atmo,bldColor}
			case "groundLight": groundLight = data && Array.isArray((data as GLGroundLight).dir) ? data as GLGroundLight : null; break;   // 地面の照明（@ortho-earth/cesium の setGroundLighting）
			case "groundMaterial": setGroundMat(data as GLGroundMat | null); break;   // 地面の材質（@ortho-earth/cesium の globe.material → setGroundMaterial）
			case "meshSpecEnv": {   // Cesium の ImageBasedLighting.specularEnvironmentMaps（KTX2 の前処理済み立方体図）＝levels[mip] に 6 面（+X −X +Y −Y +Z −Z）の RGBA16F を並べた物
				if (envTex) { gl.deleteTexture(envTex); envTex = null; }
				const e = data as GLMeshEnv | null;
				if (e && e.size > 0 && e.levels?.length) {
					envTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_CUBE_MAP, envTex);
					gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
					e.levels.forEach((lv, m) => { const w = Math.max(1, e.size >> m), n = w * w * 4; for (let f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, m, gl.RGBA16F, w, w, 0, gl.RGBA, gl.HALF_FLOAT, lv.subarray(f * n, (f + 1) * n)); });
					gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_BASE_LEVEL, 0); gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, e.levels.length - 1);
					gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
					for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_CUBE_MAP, w, gl.CLAMP_TO_EDGE);
					gl.bindTexture(gl.TEXTURE_CUBE_MAP, null); envLod = e.levels.length - 1;
				}
				break;
			}
			case "meshLight": meshLight = data && Array.isArray((data as GLMeshLight).dir) && (data as GLMeshLight).sh ? data as GLMeshLight : null; break;   // Cesium の模型の照明（@ortho-earth/cesium の setMeshLighting）
			case "light":     light = data && Array.isArray((data as GLLight).dir) ? data as GLLight : null; break;      // style の light（B3・MapLibre の setLight）
			case "lights":    lights = data && (data as GLLocalLights).n > 0 && (data as GLLocalLights).data ? data as GLLocalLights : null; break;      // 局所の光源（W2・light.js localLightsPayload）
			case "sky":       sky = data && Array.isArray((data as GLSky).sky) ? data as GLSky : null; break;        // style の sky（B4・MapLibre の setSky）＝簡易の空と霧の色・濃さ
			case "sea":       sea = { ...sea, ...(data as Partial<typeof sea>) }; break;                                  // data={li, minzoom} 海の点火ゲート
			case "bldFill":   bldFill = { ...bldFill, ...(data as Partial<typeof bldFill>) }; break;
			case "ptOver":    setPtOver(data as [string, PtLayer][] | null); break;
			case "ptFsLayers": setPtFsLayers(data as [string, string, PtLayer][] | null); break;                               // feature-state を読む基図の層（段 3）＝層 id・source-layer・式
			case "ptFs":      setPtFs(data as [string | null, string | null, Record<string, unknown> | null][]); break;        // 基図の source の setFeatureState／removeFeatureState（段 3）                                        // setPaintProperty の (b) 類（painttable.ts の paintTableFast）＝層 id → 後の式（全部を置き換える）
			case "pzOver":    pzOver = new Map(data as [number, PaintZoom][] | null ?? []); break;                       // setPaintProperty の速い道（build.ts paintFast）＝基図の層の添字 → 差し替えの式（全部を置き換える）
			case "userAnchor": userAnchor = { ranges: Array.isArray((data as { ranges?: unknown } | null | undefined)?.ranges) ? (data as { ranges: number[][] }).ranges : [], rev: userAnchor.rev + 1 }; break;   // 基図の層の間への差し込み（#123）                          // data={li} 建物フットプリント塗り（3D時に伏せる）
			case "gintBld":   setGintBld(data as GintBldData | null); break;                                          // data={origin,walls,roof,color} gintユーザー層の3D押し出し（null=解放）
			case "scene":     setScene(data as MergedScene, prop as string | undefined); break;                                      // prop=slot("base"|"main")
			case "mdGrow":    mdGrow((data as MDGrowMsg).pool, (data as MDGrowMsg).units); break;                            // multi_draw: プール成長（GPU内コピー）
			case "mdUp":      mdUpload(data as MDUpload); break;                                           // multi_draw: タイルブロック転送
			case "mdScene":   mdScene(data as MDSceneMsg); break;                                            // multi_draw: draw list 差し替え（転送ゼロ）
			case "overlay":   setOverlay(data as OverlaySceneIn | null, prop as number[] | null | undefined); break;                                    // prop=fillColor(任意)
			case "overlayHi": setOverlayHi(data as OverlaySceneIn | null, prop as HiFill | null | undefined); break;
			case "overlayHover": setOverlayHover(data as OverlaySceneIn | null); break;
			case "rail":      setRail(data as OverlaySceneIn[] | null); break;                                               // data=[シーン…] 交通の常駐オーバーレイ群
			case "wdepr":     disposeOverlay(wdepr); wdepr = data ? buildOverlaySlot(data as OverlaySceneIn, [0, 0, 0, 0]) : null; break;   // 海面下の陸地（?world=1）＝タイル前に描く塗り専用シーン（色は drawWdepr の cover が画素単位で計算＝fill 不使用）
			case "lakes":     disposeOverlay(lakes); lakes = data ? buildOverlaySlot(data as OverlaySceneIn, [0, 0, 0, 0]) : null; break;   // 湖（NE lakes・?world=1）＝wdepr 直後に描く塗り専用シーン（色は worldPal.sea 平色）
			case "elevAtlas": setElevationAtlas(data as ElevAtlasDesc, prop as number); break;                             // prop=scale
			case "elevCell":  setElevationCell((prop as ElevCellProp).cx, (prop as ElevCellProp).cy, data as CellPayload, (prop as ElevCellProp).cellRes); break;    // data=セルFloat32
			case "elevAtlasStage": setElevationAtlasStage(data as ElevAtlasDesc, prop as number); break;                   // 舞台裏アトラス（ダブルバッファ）
			case "elevCellStage": setElevationCellStage((prop as ElevCellProp).cx, (prop as ElevCellProp).cy, data as CellPayload, (prop as ElevCellProp).cellRes); break;
			case "elevAtlasCommit": commitElevationStage(); break;                              // 揃ったら一括スワップ＝山影が消えない
			case "terrainExag": setTerrainExag(data as number); break;                          // 地形の誇張（既定 1）＝今のアトラスにも掛け直す
			case "elevAtlasFar": setElevationAtlasFar(data as ElevAtlasDesc); break;                             // 遠景層（R10 第2アトラス）
			case "elevCellFar": setElevationCellFar((prop as ElevCellProp).cx, (prop as ElevCellProp).cy, data as CellPayload, (prop as ElevCellProp).cellRes); break;
			case "terrLod": TERR_LOD = data !== false; break;   // 地形チャンク刈りの実行時切替（P4 step B・門 t-terrcull の A/B）
			case "elevFarMax": far.maxElev = +(data as number) || 0; break;   // 遠景層の最大標高（地平線窓）
			case "elevAtlasFarOff": clearElevationFar(); break;                                 // 深ズーム離脱＝GPUメモリ返却
			case "elevAtlasNear": setElevationAtlasNear(data as ElevAtlasDesc); break;                           // 近景層（1 セル・順 1a）
			case "elevCellNear": setElevationCellNear((prop as ElevCellProp).cx, (prop as ElevCellProp).cy, data as CellPayload, (prop as ElevCellProp).cellRes); break;
			case "elevAtlasNearOff": clearElevationNear(); break;
			case "meshSet": setMeshSet(prop as string, data as MeshIn | null); break;                             // prop=地区名(key)、data={pos,idx} 建物メッシュ（LOD2 等）（null=解放）
			case "classify": classify.set(prop as string, data as Parameters<typeof classify.set>[1]); break;   // 面の貼り付け（分類・2026-10-25）＝柱一式（null＝外す）
			case "classifyStyle": classify.style(prop as string, data as Parameters<typeof classify.style>[1]); break;
			case "meshCut": { const p = meshes.get(prop as string); if (p && p.textured && !p.blend && typeof data === "number") p.cut = data; break; }   // 不透明の束を MASK に（feature state の show:false＝α 0 の地物を抜く・読み直さない）
			case "meshSil": { const p = meshes.get(prop as string); if (p) p.sil = data && (data as ArrayLike<number>).length >= 5 && (data as ArrayLike<number>)[4] > 0 ? Float32Array.from(data as ArrayLike<number>) : null; break; }   // Cesium の Model.silhouette＝[r,g,b,a, size px]｜null
			case "meshEnv": { const p = meshes.get(prop as string); if (p) p.sh = data && (data as ArrayLike<number>).length >= 27 ? Float32Array.from(data as ArrayLike<number>) : null; break; }   // その模型の環境光（Cesium の模型ごとの環境）＝SH9（27 値）｜null
			case "meshOutline": { const p = meshes.get(prop as string); if (p) p.ol = data && (data as ArrayLike<number>).length >= 4 ? Float32Array.from(data as ArrayLike<number>) : null; break; }   // CESIUM_primitive_outline colour rgba | null (tileset.showOutline / outlineColor)
			case "meshTint": { const p = meshes.get(prop as string); if (p) p.tint = data && (data as ArrayLike<number>).length >= 5 ? Float32Array.from(data as ArrayLike<number>) : null; break; }   // Cesium の Model.color＝[r,g,b,a, blend]（blend＝0 HIGHLIGHT／1 REPLACE／間＝MIX の量）｜null
			case "customShader": setCustomShader(String(prop), data as CsEntry["spec"] | null); break;   // Cesium の CustomShader＝{vs, fs, uniforms, values, lighting, translucency}｜null（id＝prop）
			case "customShaderTex": { const e = customs.get(String(prop)), t = data as CsTexIn | null; if (e && t?.name && t.tex) { const o = e.tex.get(t.name); if (o) gl.deleteTexture(o); e.tex.set(t.name, csTexture(t)); } break; }   // TextureUniform＝{name, tex:{bitmap}|{rgba,w,h}, nearest, repeat}
			case "meshCustom": { const p = meshes.get(prop as string); if (p) p.custom = data != null && data !== "" ? String(data) : null; break; }
			case "meshNoClip": { const p = meshes.get(prop as string); if (p) p.noClip = !!data; break; }
			case "meshImagery": { const p = meshes.get(prop as string); if (p) p.imagery = data != null && data !== "" ? String(data) : null; break; }   // the batch reads the drape picture of that id
			case "meshDrape": {   // { bitmap | rgba,w,h, west, south, east, north (deg; the picture is Web Mercator) } | null, id = prop
				const id = String(prop), d = data as DrapeIn | null, old = drapes.get(id);
				if (old) gl.deleteTexture(old.tex);
				drapes.delete(id);
				const m = d ? drapeMap(d) : null, w = d ? (d.bitmap ? d.bitmap.width : d.w ?? 0) : 0, h = d ? (d.bitmap ? d.bitmap.height : d.h ?? 0) : 0;
				if (d && m && w > 0 && h > 0 && (d.bitmap || d.rgba)) {
					const t = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0 + DRAPE_UNIT); gl.bindTexture(gl.TEXTURE_2D, t);
					gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
					if (d.bitmap) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, d.bitmap);
					else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.rgba!);
					gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
					for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
					gl.activeTexture(gl.TEXTURE0); drapes.set(id, { tex: t, map: m });
				}
				d?.bitmap?.close?.();
				break;
			}   // left out of set("clip") (Cesium clippingPolygons of another tileset)
			case "meshSplit": { const p = meshes.get(prop as string); if (p) p.split = typeof data === "number" ? data : 0; break; }   // Cesium splitDirection: -1 left / +1 right of splitPos / 0 both
			case "splitPos": { splitPos = typeof data === "number" ? Math.max(0, Math.min(1, data)) : 0.5; break; }   // scene.splitPosition (fraction of the width)   // 束に差し込むシェーダの id｜null
			case "meshXf": { const p = meshes.get(prop as string); if (p) p.xf = data && (data as Float32Array).length >= 12 ? data as Float32Array : null; break; }   // バッチの剛体変換（W4）＝Float32Array(12)（L 9＋xt 3）｜null
			case "meshPaint": {   // 画素ごとの地物の番号から塗った絵＝{ w, h, rgba（α 0＝元の色）, blend }｜null（tiles3d の paintTexel）
				const p = meshes.get(prop as string), d = data as { w: number; h: number; rgba: Uint8Array; blend: number } | null;
				if (!p?.textured) break;
				if (p.paint) gl.deleteTexture(p.paint); p.paint = null;
				if (d && d.w > 0 && d.h > 0 && d.rgba?.length >= d.w * d.h * 4) {
					const t = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0 + PAINT_UNIT); gl.bindTexture(gl.TEXTURE_2D, t);
					gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, d.w, d.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, d.rgba); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
					for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
					gl.activeTexture(gl.TEXTURE0); p.paint = t; p.paintB = d.blend;
				}
				break;
			}
			case "meshCol": { const p = meshes.get(prop as string); if (p?.textured && (data as Uint8Array | null | undefined)?.length && p.bufs[4]) { gl.bindBuffer(gl.ARRAY_BUFFER, p.bufs[4]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data as Uint8Array); gl.bindBuffer(gl.ARRAY_BUFFER, null); } break; }   // 頂点色だけ書き換える（feature state の色・W7）＝Uint8Array RGBA×頂点（長さは meshSet と同じ）
			case "meshPos": {   // skin の頂点の焼き直し（2026-10-28）＝pos（原点相対・Float32・3n）と法線（Int8・4n）を同じ頂点数のまま書き換える（大きさが違えば捨てる）
				const p = meshes.get(prop as string), d = data as { pos?: Float32Array; nrm?: Int8Array } | null;
				if (!p || !d?.pos?.length) break;
				gl.bindBuffer(gl.ARRAY_BUFFER, p.bufs[0]);
				if (gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE) === d.pos.byteLength) gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.pos);
				if (d.nrm?.length) { gl.bindBuffer(gl.ARRAY_BUFFER, p.bufs[1]); if (gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE) === d.nrm.byteLength) gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.nrm); }
				gl.bindBuffer(gl.ARRAY_BUFFER, null);
				break;
			}
			case "meshVis":  setMeshVis(prop as string, data); break;                              // prop=区名、data=真偽（GPU常駐のまま表示切替＝再訪の再アップロード不要）
			case "stars":     setStars(data as Float32Array | null); break;                                           // data=Float32Array [cel.xyz,rgb,a,size]×n
			case "constellations": setConstellations(data as Float32Array | null); break;                             // data=Float32Array [cel.xyz]×2n（LINES端点列）表示は view.showConst
			case "planets":   setPlanets(data as Float32Array | null); break;                                         // data=Float32Array（starsと同8fレイアウト・惑星5点＋月）
			case "ecliptic":  setEcliptic(data as Float32Array | null); break;                                        // data=Float32Array [cel.xyz]×2n（黄道の大円・LINES）表示は view.showConst
			case "celequator": setCelEquator(data as Float32Array | null); break;                                     // data=同上（天の赤道の大円）
			case "cogSplit":  cogSplitLon = Number.isFinite(data as number) ? data as number : null; break;               // 見比べの境の経度（null＝境なし）
			case "cogTex":    setCogTex(data as CogInput | null); break;                                          // data={rgba,w,h,bboxLL}|null ユーザ COG（等経緯度整列 RGBA）
			case "post":   post = (data as PostProcessNormalized | null) || null; dOut?.setPost(post); break;
			case "cityLights": break;   // 夜の街明かり（2026-10-24）＝WebGPU だけ（map.setCityLights は GL2 では送らない・念のため黙って受ける）   // 後処理 bloom・vignette（PR-8）・fxaa/tonemap/lut（W1）＝renderworker が FBO（depthOut）を開いて end で合成
			case "clip": clip = normClip(data as Parameters<typeof normClip>[0]); if (!clip) clipFree(); break;   // 断面（P0 #3）＝WebGPU と同じ記述（clip.ts normClip）
			case "shadow": shadow = { ...shadow, ...(data as Partial<typeof shadow>) }; if (!shadow.on) shadowFree(); break;   // 建物の影（P0 #3＝WebGL2 も・旧 2026-09-24 裁定「GL2 は影をかけない」を改めた）＝消灯で資源を返す
			default: console.warn("renderer.set: unknown cmd", cmd);
		}
	}
	// md/mdMax は renderworker が scene worker へ「multi_draw モードで動け」を通知するための能力表明。mdDash＝線分プールの語 6 を破線の距離として読める（S-P1-3）・pt＝色の語を表の行として読める（paint 表の (b) 類）
	// gintCtx＝直近 draw の gint 深度統合コンテキスト（renderworker が gint パスへ渡す）
	// ?mem=1 台帳のGPU固定常駐（自前確保分の概算バイト）。msaa=0＝canvas antialias:true はブラウザ暗黙確保（HUD 注記）
	const memEstimate = () => ({ atlas: memAtlas + memStage + memFar, mesh: memMesh, msaa: 0, raster: memRaster + gnd.bytes, depthOut: dOut ? dOut.bytes() : 0 });
	// シーンの深度の書き出し（#47）：depthOut(true)＝口 { begin(), end() → { pixels, w, h, logCoef }, abort() }（初回に FBO 一式を作る）／
	// depthOut(false)＝畳む（資産を返す・従来の経路へ）。begin は renderer.draw の前・end は gint.draw の後（renderworker が挟む）
	let lastGlobe: DepthGlobe | null = null;   // 直近のフレームの海面の球の光線（depthOut の end が添える）
	let dOut: DepthOutGL | null = null, lastLogCoef = 0, lastDpr = 1, lastFovy = 50 * Math.PI / 180, post: PostProcessNormalized | null = null;   // post＝後処理の設定（PR-8・normPost 済み）＝depthOut の FBO の写しの段で掛ける
	function depthOut(on: boolean) {
		if (!on) { if (dOut) { dOut.dispose(); dOut = null; } return null; }
		if (!dOut) { dOut = createDepthOutGL(gl, canvas, () => rOpts.requestDraw?.()); dOut.setPost(post); }
		const d = dOut;
		return { begin: d.begin, abort: d.abort, end: (o?: { depth?: boolean } | null) => { const f = d.end({ ...(o || {}), logCoef: lastLogCoef, dpr: lastDpr, fovy: lastFovy }); return f ? { ...f, logCoef: lastLogCoef, globe: lastGlobe } : null; } };   // 画面の段（Cesium の postProcessStages）が使う尺を添える
	}
	return { gl, set, draw, dispose, depthOut, md: !!md, mdMax: MD_MAX_DRAWS, mdDash: true, pt: !!md, gintCtx: () => gintCtx, memEstimate, maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
		terrStats: () => terrStat,   // 地形チャンクの刈り（P4 step B）：直近フレームの near/far の描いたチャンク数/総数
		gpuResample, readElevCell,   // 標高セルの GPU 再標本化（P1 step 1）：terrain.js が記述子を渡す合図（EXT_color_buffer_float が無ければ false＝従来）／検定の読み戻し
		rasterTex, rasterMesh, rasterFree, setRasterDraws, setGroundHook, dbg: () => (dbgC ? { ...dbgC, raster: gnd.rasterOn ? gnd.tiles : 0, fillsIn: gnd.fillsIn, gndFaces: gnd.fillsIn ? gnd.faces : 0 } : null) };   // raster＝直近合成でアトラスへ描いたタイル数・fillsIn＝塗りがアトラス側   // 画像タイル層（raster.js の renderer 契約）
}

// --- GL ヘルパ ---
// リンク前に属性位置を固定して作る（他プログラムで束ねた VAO を共用する時＝地面アトラスの塗り焼き）
function programBound(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string, locs: Record<string, number>): WebGLProgram {
	const p = gl.createProgram()!;
	gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vsSrc));
	gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fsSrc));
	for (const [name, l] of Object.entries(locs)) if (l >= 0) gl.bindAttribLocation(p, l, name);
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
	return p;
}
function program(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
	const p = gl.createProgram()!;
	gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vsSrc));
	gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fsSrc));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
	return p;
}
function shader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
	const s = gl.createShader(type)!;
	gl.shaderSource(s, src); gl.compileShader(s);
	if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("compile: " + gl.getShaderInfoLog(s) + "\n" + src);
	return s;
}
function buffer(gl: WebGL2RenderingContext, data: AllowSharedBufferSource): WebGLBuffer {
	const b = gl.createBuffer()!;
	gl.bindBuffer(gl.ARRAY_BUFFER, b);
	gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
	return b;
}
const _locCache = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
function loc(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string): WebGLUniformLocation | null {
	let m = _locCache.get(prog); if (!m) _locCache.set(prog, m = new Map());
	if (!m.has(name)) m.set(name, gl.getUniformLocation(prog, name));
	return m.get(name) as WebGLUniformLocation | null;
}
// u8=true で UNSIGNED_BYTE 正規化（頂点色は Uint8×4＝float32×4 の1/4。シェーダは同じ 0..1 を受ける）
function attrib(gl: WebGL2RenderingContext, prog: WebGLProgram, name: string, buf: WebGLBuffer, size: number, divisor?: number | null, u8?: boolean, offset = 0): void {
	const l = gl.getAttribLocation(prog, name);
	if (l < 0) return;
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.enableVertexAttribArray(l);
	gl.vertexAttribPointer(l, size, u8 ? gl.UNSIGNED_BYTE : gl.FLOAT, !!u8, 0, offset);
	if (divisor != null) gl.vertexAttribDivisor(l, divisor);
}
