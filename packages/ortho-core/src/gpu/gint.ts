// gint WebGPU（Phase 3）＝gl/gint/{embed,passes,textures,fbo,identify,idfill}.js の臓器移植。
// 公開面は createGintLayer と同形 { set, setSlot, setBaked, style, setVisible, paint, draw, drawn, move, leave, click, dispose, stats }。
// 共有する純CPU臓器（無改造）：drawdata.js（cam→mvp/RTE錨/LOD rank/視野bbox・状態は第一引数で受ける）・
// bake.js（メタ/境界/pivot/tier のベイク・純関数）・utility.js checkZoomRange・geopbf findPolygon（JSフォールバック識別）。
//
// 脱シングルトン（gint draw spec §10.1・2026-09-09）：gl/gint/state.js の singleton s への依存を絶ち、
// 3ブロックを仕様どおりに割った。
//  ・データ・スタイル＝**層ごと（L）**：SLOT_FIELDS 一式＋tier/perf/予算ラッチ＋UBO（gfBuf/gpBuf/styleBuf/idRBuf
//    と frame/param bind group は層所有＝多層が同一フレームで値を書いても衝突しない。queue.writeBuffer は
//    submit 前に全て適用されるため、共有 UBO だと最後の層の値で全層が描かれる）
//  ・GPU 基盤＝エンジン据え置き：device 資源（レイアウト・パイプライン・pipeSets・ダミー・texBG/bufOf キャッシュ）
//  ・識別・カーソル＝エンジン据え置き（§4.1 カーソルは常に1層）：activeId/lastMX/…・pick バッファ1枚・
//    ビュー状態 V（width/height/dpr/cam/lastViewBbox）・idTex スクラッチ
// 公開面は従来どおり「既定層への facade」＝renderworker 無改造。addLayer() が §4 addGint の土台（多層の新しい口）。
// storage/テクスチャ経路は層ごとにラッチ（L.sbOn）＝各層のパスは自己完結ゆえ同一フレームで混在しても正しい。
//
// GL との構造差：
//  ・renderer の frame（開いたエンコーダ＋MSAA color/depth-stencil）に自分の render pass を足す＝1canvas統合の WebGPU 形。
//    blend/stencil はパイプライン焼き込み＝GL の「状態切替と退避復元」の踊りが構造ごと消える。
//  ・stencil はパス先頭 stencilLoadOp:"clear"＋中間クリアは「フルスクリーン replace(0) 描き」（mid-pass clear が無いため）。
//  ・picking は非MSAA rgba8 テクスチャへ別パス→copyTextureToBuffer＋mapAsync（GL の PBO+fence 非同期読みと同族）。
import { DEF_STYLE, DEF_DASH, DEF_FILL, DEF_MASK, MOVE_THROTTLE_MS, SLOT_FIELDS, emptySlot } from "../gint/state.ts";
import { computeDrawData, zoomInRange, drapeSubs, subPlan } from "../gint/drawdata.ts";
import { checkZoomRange, SUB_NB, fidVisible, farPivotParams, farPivotGlobal, layerBboxOf, FAR_K } from "../gint/utility.ts";
import { bakeBase, bakeTier, tierPlan, gintDataOf } from "../gint/bake.ts";
import { findPolygon } from "geopbf/identify";
import { unproject, betaOf, ellipsoidOn, lonlatTo3D, sphereRayUniforms } from "../camera.ts";
import { clipDistanceM, clipPolygonDistanceM, CLIP_POLY_MAX } from "../clip.ts";   // 断面（#111 段 3）＝JS の識別（面の塗りの当たり）も切った側を返さない
import { GINT_LINE_WGSL, GINT_STENCIL_WGSL, GINT_POINT_WGSL, GINT_IDRESOLVE_WGSL, toStorageWGSL, withLayerH, quad6WGSL,
	GINT_LINE_CLIP_WGSL, GINT_STENCIL_CLIP_WGSL, GINT_POINT_CLIP_WGSL, GINT_IDRESOLVE_CLIP_WGSL } from "./gintwgsl.ts";
import { createFidExprRunner } from "./gintexprgpu.ts";   // fid 表を GPU で組む（geopbf 改良点 ⑦）
import type { GintSlot } from "../gint/state.ts";
import type { DrawData, DrawInput, ViewState, SubDep } from "../gint/drawdata.ts";
import type { ArcBuffer, EdgeChunk, WeightHist } from "../gint/utility.ts";
import type { GintData, GintPayload, BakeBaseResult, BakedTier } from "../gint/bake.ts";
import type { CameraPose, CameraState } from "../camera.ts";
import type { ClipPlane, ClipPoly } from "../clip.ts";
import type { FidExprData, FidExprJob, FidExprRunner } from "./gintexprgpu.ts";
import type { FidStyleWGSL } from "./gintexpr.ts";

/** writeTexture 1 回ぶん（texLayerWrites の計画）。from/to＝raw の u32 添字・tail＝最後の半端な 1 行（詰め物で送る） */
export interface TexLayerWrite { layer: number; y: number; rows: number; from: number; to: number; tail: boolean }
export interface TexLayerPlan { w: number; h: number; layers: number; rows: number; writes: TexLayerWrite[] }
/** renderer の frameInfo()＝開いたフレーム（エンコーダと MSAA の的） */
export interface GintFrame { enc: GPUCommandEncoder; colorView: GPUTextureView; depthView: GPUTextureView; w: number; h: number; samples: number }
/** 深度統合コンテキスト（renderer の gintCtx()・terrainDepth の間だけ非 null）。細分の計画（SubDep）も同じ物を読む */
export interface GintDepthCtx extends SubDep {
	terrainDepth?: boolean; logCoef?: number; fogFar?: number; elevView?: GPUTextureView | null; elevSampler?: GPUSampler | null;
	elevBounds?: ArrayLike<number> | null; edgeFade?: number; facesInAtlas?: boolean;
}
/** 断面（#111 段 3）＝renderer の clipInfo()（切らない時 null） */
export interface GintClipInfo { planes: ClipPlane[]; poly?: ClipPoly | null; st: CameraState }
/** host＝createRendererGPU の戻りのうち gint が読む面 */
export interface GintHost {
	device: GPUDevice; format: GPUTextureFormat; samples?: number; quad4?: boolean; gpuErrors?: string[];
	frameInfo(): GintFrame | null;
	passTS?: (tag: string) => GPURenderPassTimestampWrites | undefined;
	clipInfo?: () => GintClipInfo | null;
	gintCtx?: () => GintDepthCtx | null;
}
export interface GintGPUOptions { requestDraw?: () => void; noSB?: boolean; quad4?: boolean; layerH?: number }
/** 層のスタイル（worker の style メッセージ）＝computeDrawData のノブ＋noDepth */
export type GintStyle = Omit<DrawInput, "cam"> & { noDepth?: boolean };
type GintInput = DrawInput & { noDepth?: boolean };
/** set の入力（geopbf の gint ペイロード＋表示レンジ） */
export type GintSetData = GintPayload & { minZoom?: number | null; maxZoom?: number | null; precision?: number };
/** setBaked の入力（bakeworker の戻り） */
export interface GintBaked { gint: GintData; artifacts: BakeBaseResult; tiers?: (BakedTier | null)[] | null; minZoom?: number | null; maxZoom?: number | null; precision?: number }
export interface GintPaint { table?: ArrayLike<number> | null; count: number; overlap?: boolean }
/** paintExpr の入力（main が式を WGSL に・属性列と辞書表） */
export type GintExprPaint = FidExprData & { prog?: FidStyleWGSL | null; overlap?: boolean; table?: boolean };
export interface GintExprState { rows?: [number, ArrayLike<readonly [number, number] | null | undefined> | null][] | null; dnum?: Uint32Array | null; dcol?: Float32Array | null; zoom?: number | null; table?: boolean }
export interface GintPointer { x: number; y: number }
/** 地面アトラスの窓 1 枚（renderer.composeGround のフック） */
export interface GintAtlasTarget { enc: GPUCommandEncoder; view: GPUTextureView; size: number; win: number[]; index: number }
/** ベイクの gintData（点の表は Uint32Array・点の座標は length を持つ view） */
type GpuGintData = GintData & { pointBuffer: ArcBuffer | null; point: Uint32Array };
interface GintTier { minW: number; edgeCount: number; chunks: EdgeChunk[] | null; tex: GPUTexture }
/** スロット束（GintSlot のテクスチャ＝GPUTexture） */
interface GpuSlot extends Omit<GintSlot, "gintData" | "arcTex" | "metaTex" | "metaTexB" | "ptTex" | "ptMetaTex" | "pivotTex" | "compTex" | "lodTiers" | "metaChunks" | "subB"
	| "polyEdgeByFid" | "polyBboxByFid" | "outlineZoom" | "fidStyleTex" | "_fidStyleData"> {
	gintData: GpuGintData | null; arcTex: GPUTexture | null; metaTex: GPUTexture | null; metaTexB: GPUTexture | null; ptTex: GPUTexture | null; ptMetaTex: GPUTexture | null; pivotTex: GPUTexture | null; compTex: GPUTexture | null;
	lodTiers: GintTier[]; metaChunks: EdgeChunk[] | null; subB: number[] | null;
	polyEdgeByFid: Map<number, [number, number]> | null; polyBboxByFid: Map<number, number[]> | null; outlineZoom: number | null;
	fidStyleTex: GPUTexture | null; _fidStyleData: { u32: Uint32Array; count: number } | null;
}
type SlotKey = string | null;
type Bag = Record<string, unknown>;
/** 1 層の状態（§10.1 第1ブロック） */
interface GintLayer extends GpuSlot {
	id: string | null; order: number;
	slots: Map<SlotKey, Partial<GpuSlot>>; activeKey: SlotKey; drawStyle: GintStyle | null; visible: boolean; stylesDirty: boolean;
	idOverlapMode: boolean; tierGen: number; sbOn: boolean;
	lastDrawData: GintDraw | null; _inRange: boolean; _forceLowMove: boolean; _budgetSkipped: boolean;
	_pfLineEdges: number; _pfTierW: number; _pfRuns: number; _pfChunks: number; _pfDrawn: number; _pfFbo: number; _pfPickMs: number; _pfSubs?: number;
	_dbg: { path: string; vis: boolean; z: number; t: number } | null; _dbgRing: string[];
	_auxBG: GPUBindGroup | null; _auxKey: unknown[] | null; _idrBG: GPUBindGroup | null; _idrGen: number; _idrFid: GPUTexture | null;
	_idrA?: Map<number, { gen: number; fid: GPUTexture | null; bg: GPUBindGroup }> | null;
	_pickElev?: [GPUTextureView, GPUSampler | null | undefined] | null;
	_exprJob?: FidExprJob | null;
	gfBuf: GPUBuffer; gpBuf: GPUBuffer; styleBuf: GPUBuffer; idRBuf: GPUBuffer;
	frameBG: GPUBindGroup[]; gfBufA: GPUBuffer; frameBGA: GPUBindGroup[]; paramBG: GPUBindGroup[];
}
/** 1 層 1 フレームの描画データ（computeDrawData の戻り＋深度統合・面の省略） */
type GintDraw = Omit<DrawData, "styleTable" | "dashTable" | "fillColor" | "maskColor" | "hiliteColor" | "_forceLow"> & {
	styleTable?: ArrayLike<number> | null; dashTable?: ArrayLike<number> | null; fillColor?: ArrayLike<number> | null;
	maskColor?: ArrayLike<number> | null; hiliteColor?: ArrayLike<number> | null; _forceLow?: boolean;
	depth?: GintDepthCtx | null; noFaces?: boolean;
};
/** 窓座標モード（地面アトラスへの面焼き込み） */
interface GintAtlas { off: number[]; inv: number[]; vbb: number[] | null }
/** 可視 run＝[startEdge, edgeCount, spanX, spanY]。sub[b]＝複製行区間 */
type SubRuns = (number[][] | null)[];
type Runs = number[][] & { sub?: SubRuns | null };
interface LineSel { tex: GPUTexture | null; count: number; runs: Runs | null; minW: number; boundary?: boolean; sub?: SubRuns | null }
interface PipeOpts { ds?: GPUDepthStencilState | null; blend?: GPUBlendState; writeMask?: number; samples?: number; fmt?: GPUTextureFormat; lay?: GPUPipelineLayout }
interface GPPack { width?: number; widthAdd?: number; radius?: number; hidden?: number; dpr?: number | null; fidW?: number; activeId?: number; pass?: number; color?: ArrayLike<number> | null }
interface ClipMods { line: GPUShaderModule; stencil: GPUShaderModule; point: GPUShaderModule; lineSB: GPUShaderModule; stencilSB: GPUShaderModule; pointSB: GPUShaderModule; resolve: GPUShaderModule }
interface PipesA { stencilFan: GPURenderPipeline; cover: GPURenderPipeline; idResolve: GPURenderPipeline }
interface AtlasScratch { stTex: GPUTexture; stView: GPUTextureView; idTex: GPUTexture | null; idView: GPUTextureView | null; gen: number }

const OUTLINE_ZOOM = 13;   // 既定の切替z（passes.js と同値）
const GP_SLOT = 256;
const TEX_ARC_W = 4096, TEX_META_W = 4096;   // テクスチャ経路の折り返し幅（旧 s.TEX_ARC_W/TEX_META_W）
// group(2) のテクスチャは 2D 配列＝層ごと TEX_LAYER_H 行（4096×4096＝arc 128 MiB・meta 256 MiB）で分けて送る（2026-10-12・改良点 ⑤）。
// 旧＝1 枚の 2D（高さ ≤ maxTextureDimension2D＝8192 で arc 268 MB が天井・超えると createTexture が即死）。層数の上限は
// maxTextureArrayLayers（≥256）＝実質無限。層の高さは maxTextureDimension2D の最小保証 8192 の内＝どの機でも載る。
// 送りは層ごと＝丸ごとの padding 済み写し（旧 arcPad＝生配列と同じ大きさをもう 1 本）を作らない（端の 1 行だけ詰める）
const TEX_LAYER_H = 4096;
// 分割送りの計画（純関数＝tests/gint-texlayers.mjs が検める）: raw（u32 の個数 rawLen・texel = comps 個）を幅 w・層 LH 行へ。
// 戻り＝{ w, h, layers, rows, writes }。writes＝writeTexture 1 回ぶん { layer, y, rows, from, to, tail }（from/to＝raw の u32 添字）。
// 満杯の行は raw の view をそのまま、最後の半端な 1 行だけ tail＝小さな詰め物で送る。minTexels＝載せる texel 数の下限（meta の複製行）
export function texLayerWrites(rawLen: number, comps: number, w: number, LH: number, minTexels = 0): TexLayerPlan {
	const texels = Math.max(minTexels, Math.ceil(rawLen / comps));
	const rows = Math.max(1, Math.ceil(texels / w)), layers = Math.ceil(rows / LH), h = layers > 1 ? LH : rows;
	const rowLen = w * comps, fullRows = Math.floor(rawLen / rowLen), tailLen = rawLen - fullRows * rowLen;
	const writes: TexLayerWrite[] = [];
	for (let l = 0; l < layers; l++) {
		const r0 = l * LH, r1 = Math.min(rows, r0 + LH), f1 = Math.min(r1, fullRows);
		if (f1 > r0) writes.push({ layer: l, y: 0, rows: f1 - r0, from: r0 * rowLen, to: f1 * rowLen, tail: false });
		if (tailLen && fullRows >= r0 && fullRows < r1) writes.push({ layer: l, y: fullRows - r0, rows: 1, from: fullRows * rowLen, to: rawLen, tail: true });
	}
	return { w, h, layers, rows, writes };
}
// raw は SharedArrayBuffer 裏の view のことがある（geopbf ゼロコピー・2026-10-11）。writeBuffer/writeTexture は AllowSharedBufferSource＝
// 今の Chrome/Safari は受けるが、受けない版は TypeError＝その時だけ写して渡す（黙って写さない）
const plainOr = (v: Uint32Array, f: (v: Uint32Array) => void): void => { try { return f(v); } catch (e) { if (!(e instanceof TypeError) || !(typeof SharedArrayBuffer !== "undefined" && v.buffer instanceof SharedArrayBuffer)) throw e; return f(v.slice()); } };
// 2D 配列テクスチャの分割送り（texLayerWrites の計画どおりに writeTexture）。満杯の行は raw の view のまま・半端な 1 行だけ詰め物。
// 検定頁 globe/tests/t-gintlayers.html がこの関数そのものを使う（アクセサ WGSL との対＝層・行・列の添字が合うことを実機で読み戻す）
export function uploadTexArrU32(device: GPUDevice, raw: Uint32Array, w: number, fmt: GPUTextureFormat, comps: number, LH = TEX_LAYER_H, minTexels = 0): GPUTexture {
	const { h, layers, writes } = texLayerWrites(raw.length, comps, w, LH, minTexels);
	const tex = device.createTexture({ size: [w, h, layers], format: fmt, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const bpr = w * comps * 4;
	for (const x of writes) {
		let v = raw.subarray(x.from, x.to);
		if (x.tail) { const t = new Uint32Array(w * comps); t.set(v); v = t; }   // 半端な 1 行だけ詰め物（残りは createTexture の零）
		plainOr(v, d => device.queue.writeTexture({ texture: tex, origin: [0, x.y, x.layer] }, d, { bytesPerRow: bpr, rowsPerImage: x.rows }, [w, x.rows, 1]));
	}
	return tex;
}
const ROLE = { stencil: 0, fill: 1, line: 2, lineHidden: 3, hilite: 4, maskStencil: 5, maskFill: 6, point: 7, pointHi: 8, pickLine: 9, pickPoint: 10 };

export function createGintLayerGPU(host: GintHost, { requestDraw, noSB, quad4 = host.quad4 !== false, layerH = 0 }: GintGPUOptions = {}) {   // layerH＝2D 配列の層の高さの上書き（検定用・?gintlh=）   // quad4＝線・点を index の 4 頂点で描く（perf plan P3・既定 true・?quad4=0 で旧 6 頂点）
	const { device, format } = host;
	let bakeRev = 0;   // 地面アトラスへ焼いた面の失効世代（内容・スタイル・表示・層構成が変わるたび +1＝renderer の合成鍵）
	const bump = () => { bakeRev++; requestDraw?.(); };
	// ── storage buffer 経路（?gintsb=0 で従来のテクスチャ経路へ）──────────────
	// group(2)（頂点 arc・辺メタ）だけを storage buffer にする。テクスチャ経路は GL2 の制約の形で、
	// WebGPU では線形添字の `% w` / `/ w`（整数除算）を頂点シェーダの最内側で毎回払う羽目になる。
	// 実測: 実シェーダは ALU 支配で 5-10% の微益（VS律速時）／帯域・フラグメント律速では差なし。
	// ⚠ group(2) は line/stencil と point が1レイアウトを共有＝arc/meta/tier/pt/ptMeta の6種まとめて切替。
	// ⚠ storage の binding 上限は 128MB（テクスチャ経路の 268MB より狭い）＝超える層はテクスチャへ落とす。
	const SB_LIMIT = device.limits?.maxStorageBufferBindingSize ?? 0;
	const SB = !noSB && SB_LIMIT > 0 && (device.limits?.maxStorageBuffersPerShaderStage ?? 0) >= 2;   // host＝createRendererGPU（frameInfo() で開いたフレームの的を貸す）

	// ── パイプライン（エンジン共有＝device 資源）──────────────────────────
	const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
	const bglFrame = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: VF, buffer: {} },
		{ binding: 1, visibility: VF, buffer: {} },
	] });
	const bglParam = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
	const bglTex2 = device.createBindGroupLayout({ entries: [   // group(2)＝2D 配列（texArrU32・層ごと分割送り）
		{ binding: 0, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint", viewDimension: "2d-array" } },
		{ binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint", viewDimension: "2d-array" } },
	] });
	const bglAux = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } },
		{ binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } },
		{ binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "float" } },
		{ binding: 3, visibility: GPUShaderStage.VERTEX, sampler: { type: "filtering" } },
		{ binding: 4, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } },   // compTex（辺→塗り扇の鍵・R32UI・多片地物の層だけ・無い層は dummy）
	] });
	const bglBuf2 = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
		{ binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
	] });
	const layout = device.createPipelineLayout({ bindGroupLayouts: [bglFrame, bglParam, bglTex2, bglAux] });
	const layoutSB = device.createPipelineLayout({ bindGroupLayouts: [bglFrame, bglParam, bglBuf2, bglAux] });
	const mkMod = (code: string, label: string): GPUShaderModule => {   // WGSL コンパイル失敗の可視化（renderer.js mkMod と同文・host.gpuErrors へ合流）
		const m = device.createShaderModule({ code });
		m.getCompilationInfo && m.getCompilationInfo().then(info => {
			for (const x of info.messages || []) if (x.type === "error") { const t = `WGSL gint-${label}: ${x.lineNum}:${x.linePos} ${x.message}`; host.gpuErrors && host.gpuErrors.push(t); console.error("[gpu] " + t); }
		});
		return m;
	};
	// 線・点の VS は原本＝index の 4 頂点（P3）。?quad4=0 は quad6WGSL で旧 6 頂点へ機械変換（二重管理をしない・変換漏れは例外）
	const LH = (layerH | 0) > 0 ? Math.min(layerH | 0, TEX_LAYER_H) : TEX_LAYER_H;   // 層の高さ（検定で小さくして複数層を踏む）
	const QW = quad4 ? (c: string) => withLayerH(c, LH) : (c: string) => withLayerH(quad6WGSL(c), LH);
	const LINE_SRC = QW(GINT_LINE_WGSL), POINT_SRC = QW(GINT_POINT_WGSL), STENCIL_SRC = withLayerH(GINT_STENCIL_WGSL, LH);
	const lineMod = mkMod(LINE_SRC, "line");
	const stencilMod = mkMod(STENCIL_SRC, "stencil");
	const pointMod = mkMod(POINT_SRC, "point");
	// storage 版は原本の機械変換＝二重管理をしない（toStorageWGSL が変換漏れを例外で知らせる）
	const lineModSB = SB ? mkMod(toStorageWGSL(LINE_SRC), "line-sb") : null!;   // *SB＝SB の時だけ読む（null! ＝型の上では常に在る）
	const stencilModSB = SB ? mkMod(toStorageWGSL(STENCIL_SRC), "stencil-sb") : null!;
	const pointModSB = SB ? mkMod(toStorageWGSL(POINT_SRC), "point-sb") : null!;
	// gint は straight alpha（GL blendFuncSeparate(SRC_ALPHA, 1-SA, ONE, 1-SA) と同じ）
	const SBLEND: GPUBlendState = {
		color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
		alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
	};
	const DS = "depth24plus-stencil8";   // renderer と共有する深度・ステンシル
	const keepDS: GPUDepthStencilState = { format: DS, depthWriteEnabled: false, depthCompare: "always" };
	const pipe = (mod: GPUShaderModule, vs: string, fs: string, { ds = keepDS, blend = SBLEND, writeMask, samples = host.samples || 4, fmt = format, lay = layout }: PipeOpts = {}): GPURenderPipeline =>   // 既定＝renderer の MSAA 段数（?msaa=0＝1x に追随）
		device.createRenderPipeline({
			layout: lay,
			vertex: { module: mod, entryPoint: vs },
			fragment: { module: mod, entryPoint: fs, targets: [{ format: fmt, blend, writeMask }] },
			primitive: { topology: "triangle-list" },
			...(ds ? { depthStencil: ds } : {}),
			multisample: { count: samples },
		});
	const wind: GPUStencilFaceState = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "increment-wrap" };
	const windB: GPUStencilFaceState = { ...wind, passOp: "decrement-wrap" };
	// stencil bit7(0x80)＝renderer の建物マスク（bld/mesh が刻む・面ドレープの深度統合 2026-08-14）＝winding は
	// ビット0-6（±63で十分）に閉じ込め、cover/mask の比較・書きも 0x7F に限定して bit7 を汚さない。
	const stFan: GPUDepthStencilState = { ...keepDS, stencilFront: wind, stencilBack: windB, stencilWriteMask: 0x7F };
	const stCoverNE: GPUDepthStencilState = { ...keepDS, stencilFront: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilBack: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilReadMask: 0x7F, stencilWriteMask: 0 };
	const stCoverEQ: GPUDepthStencilState = { ...keepDS, stencilFront: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilBack: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilReadMask: 0x7F, stencilWriteMask: 0 };
	const stZero: GPUDepthStencilState = { ...keepDS, stencilFront: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "replace" }, stencilBack: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "replace" }, stencilWriteMask: 0x7F };
	// 遮蔽消し込み（ドレープ塗り時のみ）：建物 bit7 が立つ画素の winding を 0 へ（ref 0x80・replace は ref&0x7F=0 を書く）
	//＝cover(≠0) が建物の陰を自然にスキップ。ドレープ面＝地形面そのものなので「建物が見えている画素」の判定だけで正しい。
	const stOcc: GPUDepthStencilState = { ...keepDS, stencilFront: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "replace" }, stencilBack: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "replace" }, stencilReadMask: 0x80, stencilWriteMask: 0x7F };
	const pickLinePipe = pipe(lineMod, "vsPickLine", "fsPick", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm" });
	const pickPointPipe = pipe(pointMod, "vsPickPoint", "fsPickPoint", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm" });
	// pick は 1x 固定＝pipeSets の外だが、group(2) のレイアウトはパイプラインと bind group で一致必須＝storage 版も対で持つ
	const pickLinePipeSB = SB ? pipe(lineModSB, "vsPickLine", "fsPick", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm", lay: layoutSB }) : null!;
	const pickPointPipeSB = SB ? pipe(pointModSB, "vsPickPoint", "fsPickPoint", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm", lay: layoutSB }) : null!;
	// ── 断面とクリッピング平面（#111 段 3）＝切っている時だけの派生（gintwgsl.js gintClipWGSL・素のパイプラインは不変）。
	// 面は host.clipInfo()（renderer が毎フレーム {planes, st}／切らない時 null）＝GF の末尾へ gint の原点で詰める（packGF）。地面アトラスへ焼く経路は素のまま（地形の派生で切れる）
	const clipInfo = () => host.clipInfo?.() || null;
	let clipM: ClipMods | null = null;
	const clipMods = () => clipM ??= (() => {
		const Ls = QW(GINT_LINE_CLIP_WGSL), Ps = QW(GINT_POINT_CLIP_WGSL), Ss = withLayerH(GINT_STENCIL_CLIP_WGSL, LH);
		return { line: mkMod(Ls, "line-clip"), stencil: mkMod(Ss, "stencil-clip"), point: mkMod(Ps, "point-clip"),
			lineSB: SB ? mkMod(toStorageWGSL(Ls), "line-clip-sb") : null!, stencilSB: SB ? mkMod(toStorageWGSL(Ss), "stencil-clip-sb") : null!,
			pointSB: SB ? mkMod(toStorageWGSL(Ps), "point-clip-sb") : null!, resolve: mkMod(GINT_IDRESOLVE_CLIP_WGSL, "idresolve-clip") };
	})();
	const pickClip: { t?: GPURenderPipeline[]; b?: GPURenderPipeline[] } = {};
	const pickPipesFor = (sb: boolean, clip: boolean): GPURenderPipeline[] => {   // 拾い（1x・rgba8）＝素か切る派生
		if (!clip) return sb ? [pickLinePipeSB, pickPointPipeSB] : [pickLinePipe, pickPointPipe];
		const k = sb ? "b" : "t";
		if (!pickClip[k]) { const m = clipMods(), o: PipeOpts = { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm", ...(sb ? { lay: layoutSB } : {}) };
			pickClip[k] = [pipe(sb ? m.lineSB : m.line, "vsPickLine", "fsPick", o), pipe(sb ? m.pointSB : m.point, "vsPickPoint", "fsPickPoint", o)]; }
		return pickClip[k]!;
	};
	// コロプレス ID 塗り（idfill.js）：① winding 和を ID テクスチャへ加算蓄積（fan 幾何・単一サンプル・深度なし）
	// ② 解決＝ID 画素→fid→スタイル表→色を main パスへ。
	// ★蓄積は fid+1 の winding 和＝市区町村1919個では fid+1 最大1920＋加算途中和が半精度(rg16float)の整数正確域
	//   (2048)を超えて精度崩壊し塗りに穴が出る（境界線は無傷なのに塗りだけ欠ける・2026-08-12実機で判明）。
	//   float32-blendable があれば rg32float（整数1600万まで正確）で根治。無ければ rg16float へ縮退（穴リスク残・
	//   ?gl2=1 で EXT_float_blend の RG32F 経路へ逃げられる）。GL 経路の RG32F/RG16F 選択と同じ判断。
	const canIdF32 = !!device.features?.has?.("float32-blendable");
	const ID_MAX_FID = canIdF32 ? (1 << 20) : 2047, ID_FMT = canIdF32 ? "rgba32float" : "rgba16float";   // α＝前向き扇の最大 fid+1（MAX blend）＝重複画素の後勝ち（2026-09-15）
	if (!canIdF32) console.warn("[gint] no float32-blendable = idfill uses rg16float (fill holes possible in large-fid municipality choropleth)");
	const mkIdAccum = (mod: GPUShaderModule, lay: GPUPipelineLayout): GPURenderPipeline => device.createRenderPipeline({
		layout: lay, vertex: { module: mod, entryPoint: "vsId" },
		fragment: { module: mod, entryPoint: "fsId", targets: [{ format: ID_FMT, blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "max" } } }] },
		primitive: { topology: "triangle-list" }, multisample: { count: 1 },
	});
	const idAccumPipe = mkIdAccum(stencilMod, layout);
	const idAccumPipeSB = SB ? mkIdAccum(stencilModSB, layoutSB) : null!;
	const idResolveMod = mkMod(GINT_IDRESOLVE_WGSL, "idresolve");
	const bglIdResolve = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },   // idTex rg16float
		{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },                 // fidTex RGBA32UI
		{ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },                                      // R uniform
	] });
	const idResolveLayout = device.createPipelineLayout({ bindGroupLayouts: [bglIdResolve] });
	const mkIdResolve = (ds: GPUDepthStencilState, sc: number, mod = idResolveMod): GPURenderPipeline => device.createRenderPipeline({
		layout: idResolveLayout,
		vertex: { module: mod, entryPoint: "vs" },
		fragment: { module: mod, entryPoint: "fs", targets: [{ format, blend: SBLEND }] },
		primitive: { topology: "triangle-list" }, depthStencil: ds, multisample: { count: sc },   // main パスへ描く＝renderer のフレーム段数に追随
	});
	// ドレープ塗り時（Occ）＝建物 bit7 が立つ画素をスキップ（ref 0・equal・readMask 0x80＝(v&0x80)==0 のみ塗る）
	const stIdOcc: GPUDepthStencilState = { ...keepDS, stencilFront: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilBack: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilReadMask: 0x80, stencilWriteMask: 0 };
	// ── main パス行きパイプラインのセット（遷移時AA）：renderer のフレーム段数（frameInfo().samples＝遷移中1x／
	// 静止4x）に multisample count を揃える＝焼き込みゆえセット取替。sampleCount 毎に遅延生成・恒久キャッシュ。
	// pick 系（別パス・rgba8・非MSAA）と idAccum（rg16/32float 蓄積）は従来どおり 1x 固定＝セット外。
	// マスク専用の stencil シェーダ（旧 GL の VS_STENCIL_MASK）は持たない：drawHighlight の mask fan は stencilProgram＝レンジ描画（GL 側の未使用の写しも撤去済み）
	const buildPipes = (sc: number, sb: boolean, clip: boolean) => { const cm = clip ? clipMods() : null;   // clip＝断面の派生（#111 段 3）
		const [lm, sm, pm, lay] = sb ? (cm ? [cm.lineSB, cm.stencilSB, cm.pointSB, layoutSB] : [lineModSB, stencilModSB, pointModSB, layoutSB]) : (cm ? [cm.line, cm.stencil, cm.point, layout] : [lineMod, stencilMod, pointMod, layout]);
		const rm = cm ? cm.resolve : idResolveMod; return ({
		stencilFan: pipe(sm, "vsStencil", "fsNull", { ds: stFan, blend: undefined, writeMask: 0, samples: sc, lay }),
		cover: pipe(sm, "vsFull", "fsFill", { ds: stCoverNE, samples: sc, lay }),
		coverEq: pipe(sm, "vsFull", "fsFill", { ds: stCoverEQ, samples: sc, lay }),
		zero: pipe(sm, "vsFull", "fsNull", { ds: stZero, blend: undefined, writeMask: 0, samples: sc, lay }),
		occlude: pipe(sm, "vsFull", "fsNull", { ds: stOcc, blend: undefined, writeMask: 0, samples: sc, lay }),   // 建物 bit7→winding 消し込み
		line: pipe(lm, "vsRender", "fsRender", { samples: sc, lay }),
		lineTest: pipe(lm, "vsRender", "fsRender", { ds: { ...keepDS, depthCompare: "less-equal" }, samples: sc, lay }),
		lineHidden: pipe(lm, "vsRender", "fsRender", { ds: { ...keepDS, depthCompare: "greater" }, samples: sc, lay }),
		point: pipe(pm, "vsPoint", "fsPoint", { samples: sc, lay }),
		idResolve: mkIdResolve(keepDS, sc, rm),
		idResolveOcc: mkIdResolve(stIdOcc, sc, rm),
	}); };
	const pipeSets = new Map<string, ReturnType<typeof buildPipes>>();
	// キーは (storage か) × MSAA 段＝層ごとに経路が変わっても互いのキャッシュを潰さない
	const pipesFor = (sc: number, sb: boolean, clip = false) => { const k = `${sb ? "b" : "t"}#${sc}${clip ? "#c" : ""}`; let p = pipeSets.get(k); if (!p) { p = buildPipes(sc, sb, clip); pipeSets.set(k, p); } return p; };   // #c＝断面の派生
	pipesFor(host.samples || 4, false);
	if (SB) pipesFor(host.samples || 4, true);   // 品質段は生成時に先行コンパイル（renderworker の gint init検証スコープで検札）。1x は初の遷移フレームで遅延生成

	// ── ビュー状態 V（§10.1 第3ブロック＝据え置き。drawdata.js が第一引数で読む/書く）──
	const V: ViewState = { width: 0, height: 0, dpr: 1, cam: null, lastViewBbox: null };
	// ── カーソル（§4.1 常に1層＝エンジン所有）────────────────────────────
	let activeId = -1, lastMX = NaN, lastMY = NaN, moveTimer: ReturnType<typeof setTimeout> | null = null, pendingMove: GintPointer | null = null;
	let hitMX = NaN, hitMY = NaN;   // 直近 identify の座標（click の unproject 用）。lastMX/MY は draw ごとの dedupe リセットで NaN に戻る
	let isDrawing = false, staticN = 0, lastSyncCam: CameraPose | null = null, pickPending = false;
	// ダミー（未搭載スロットの束縛穴埋め＝layout は常に4テクスチャを要求する）
	const dummyU32 = device.createTexture({ size: [1, 1], format: "r32uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummyF32 = device.createTexture({ size: [1, 1], format: "r16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummySamp = device.createSampler({ magFilter: "linear", minFilter: "linear" });
	// ── index の 4 頂点/辺（perf plan P3・2026-09-27）──
	// 固定パターン [4k,4k+1,4k+2, 4k,4k+2,4k+3]×QK を 1 本持ち、run は drawIndexed の baseVertex＝est×4 で位置を選ぶ（VS は vi/4 で辺・vi%4 で角）。
	// 辺 1 本の VS 起動が 6→4 回（同じ index は post-transform cache が拾う）。VS が復号・投影・ドレープを両端点ぶん毎回やる gint では VS 律速＝直に効く。
	// instance（地形適応細分の N と s＝firstInstance の上位 16bit）はそのまま。QK を超える run は割る（run は 16384 辺チャンクの連結＝割ってよい）。
	// ?quad4=0＝旧 6 頂点の draw（VS も quad6WGSL の版）＝A/B と切り分けの逃げ道。
	const QK = 1 << 17;
	let quadIdx: GPUBuffer | null = null;
	const quadIdxBuf = () => {
		if (quadIdx) return quadIdx;
		const a = new Uint32Array(QK * 6);
		for (let k = 0, o = 0; k < QK; k++, o += 6) { const b = k * 4; a[o] = b; a[o + 1] = b + 1; a[o + 2] = b + 2; a[o + 3] = b; a[o + 4] = b + 2; a[o + 5] = b + 3; }
		quadIdx = device.createBuffer({ size: a.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(quadIdx, 0, a);
		return quadIdx;
	};
	const bindQuads = (pass: GPURenderPassEncoder) => { if (quad4) pass.setIndexBuffer(quadIdxBuf(), "uint32"); };   // パスの頭で 1 回（stencil 扇の draw は index を見ない＝同居してよい）
	const drawQuads = (pass: GPURenderPassEncoder, count: number, first: number, inst = 1, firstInst = 0) => {   // count 辺（点）を first から。inst/firstInst＝細分の N・s の運び方は不変
		if (!quad4) { pass.draw(count * 6, inst, first * 6, firstInst); return; }
		for (let e = 0; e < count; e += QK) pass.drawIndexed(Math.min(QK, count - e) * 6, inst, 0, (first + e) * 4, firstInst);
	};
	// idfill：ID テクスチャ（rg16float・canvas 同寸・単一サンプル）＝エンジン共有スクラッチ。
	// 各層は「自分の idPass →直後に自分の解決」の順で符号化される＝パス実行も符号化順ゆえ共有で衝突しない。
	// 解決 bind group は層ごと（fidStyleTex が層の物）＝idGen（idTex 作り直し世代）で失効管理。
	let idTex: GPUTexture | null = null, idTexView: GPUTextureView | null = null, idW = 0, idH = 0, idGen = 0;
	function ensureIdTex() {
		if (idTex && idW === V.width && idH === V.height) return true;
		if (idTex) idTex.destroy();
		idTex = device.createTexture({ size: [V.width, V.height], format: ID_FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
		idTexView = idTex.createView(); idW = V.width; idH = V.height; idGen++;
		return true;
	}
	function idResolveBGFor(L: GintLayer): GPUBindGroup | null {
		if (L._idrBG && L._idrGen === idGen && L._idrFid === L.fidStyleTex) return L._idrBG;
		L._idrGen = idGen; L._idrFid = L.fidStyleTex;
		return L._idrBG = L.fidStyleTex ? device.createBindGroup({ layout: bglIdResolve, entries: [
			{ binding: 0, resource: idTexView! }, { binding: 1, resource: L.fidStyleTex.createView() }, { binding: 2, resource: { buffer: L.idRBuf } }] }) : null;
	}
	// コロプレス塗りが使えるか（idfill.js canUseIdFill）：paint(fid表)あり・ポリゴンあり・fillOff でない・fid が rg16float 上限内。
	const canUseIdFill = (L: GintLayer) => !!L.fidStyleTex && L.polyEdges > 0 && !L.fillOff && !!L.arcTex && L.fidStyleCount <= ID_MAX_FID;

	// ── storage buffer の並走（エンジン共有の対応表）─────────────────────────
	// テクスチャ1枚につき同内容の storage buffer を1本持ち、対応表で引く＝描画側の呼び出し
	// （texBG(sb, L.arcTex, lnSel.tex) 等）を書き換えずにモードを切り替えられる。
	const bufOf = new WeakMap<GPUTexture, GPUBuffer>();   // texture → 同内容の storage buffer
	const bufU32 = (raw: Uint32Array) => { const b = device.createBuffer({ size: Math.max(4, raw.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); plainOr(raw, v => device.queue.writeBuffer(b, 0, v)); return b; };
	// raw＝padding 前の生配列（storage は 4096 幅の折り返しが要らない）。binding 上限（既定 128 MiB・renderer がアダプタの実力値を要求＝Apple は 4 GiB 級）を超える層はテクスチャ（2D 配列）のまま。
	const regBuf = (tex: GPUTexture, raw: Uint32Array | null | undefined) => { if (SB && raw && raw.byteLength <= SB_LIMIT) bufOf.set(tex, bufU32(raw)); return tex; };
	// 破棄はテクスチャと対で（WeakMap の自然回収待ち＝GC まで VRAM を掴む）。buffer の無いテクスチャにも安全
	const dropTex = (tex: GPUTexture | null | undefined) => { if (!tex) return; const b = bufOf.get(tex); if (b) { b.destroy(); bufOf.delete(tex); } tex.destroy(); };
	// この層が storage 経路で描けるか（group(2) の全資源に buffer が揃っているか）＝各層の draw/pick 入口でラッチ
	const sbReady = (L: GintLayer) => SB
		&& (!L.arcTex || bufOf.has(L.arcTex)) && (!L.metaTex || bufOf.has(L.metaTex))
		&& (!L.metaTexB || bufOf.has(L.metaTexB)) && (!L.ptTex || bufOf.has(L.ptTex))
		&& (!L.ptMetaTex || bufOf.has(L.ptMetaTex)) && (L.lodTiers ?? []).every(t => bufOf.has(t.tex));

	// group(2)＝(arc|pt, meta|ptMeta) の bind group キャッシュ（テクスチャ差し替えで自然無効化）
	const texBGs = new WeakMap<GPUTexture, WeakMap<GPUTexture, GPUBindGroup>>(), bufBGs = new WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>();
	const texBG = (sb: boolean, a: GPUTexture | null, b: GPUTexture | null): GPUBindGroup => {   // a/b＝呼び手が搭載済みを確かめた層の資源（null は来ない）
		if (sb) {   // storage 経路＝対応する buffer で bind（レイアウトは bglBuf2・パイプラインも storage 版）
			const ba = bufOf.get(a!), bb = bufOf.get(b!);
			if (ba && bb) {
				let m = bufBGs.get(ba); if (!m) bufBGs.set(ba, m = new WeakMap());
				let bg = m.get(bb);
				if (!bg) m.set(bb, bg = device.createBindGroup({ layout: bglBuf2, entries: [
					{ binding: 0, resource: { buffer: ba } }, { binding: 1, resource: { buffer: bb } }] }));
				return bg;
			}
		}
		let m = texBGs.get(a!); if (!m) texBGs.set(a!, m = new WeakMap());
		let bg = m.get(b!);
		if (!bg) m.set(b!, bg = device.createBindGroup({ layout: bglTex2, entries: [   // 1 層でも 2d-array の view（既定は 2d＝レイアウト不一致）
			{ binding: 0, resource: a!.createView({ dimension: "2d-array" }) }, { binding: 1, resource: b!.createView({ dimension: "2d-array" }) }] }));
		return bg;
	};
	// group(3)＝pivot/fidStyle/標高（層ごとキャッシュ＝何かが差し替わった時だけ作り直す）
	function auxGroup(L: GintLayer, elevView: GPUTextureView | null | undefined, elevSamp: GPUSampler | null | undefined): GPUBindGroup {
		const p = L.pivotTex || dummyU32, f = L.fidStyleTex || dummyU32, c = L.compTex || dummyU32;
		const ev = elevView || dummyF32.createView(), es = elevSamp || dummySamp;
		const key = [p, f, elevView || dummyF32, es, c];
		if (L._auxBG && L._auxKey && L._auxKey.every((v, i) => v === key[i])) return L._auxBG;
		L._auxKey = key;
		return L._auxBG = device.createBindGroup({ layout: bglAux, entries: [
			{ binding: 0, resource: p.createView() }, { binding: 1, resource: f.createView() },
			{ binding: 2, resource: ev }, { binding: 3, resource: es }, { binding: 4, resource: c.createView() }] });
	}

	// ── テクスチャ搭載（textures.js の WebGPU 版）────────────────────────
	function texU32(data: Uint32Array, w: number, h: number, fmt: GPUTextureFormat, comps: number): GPUTexture {
		const tex = device.createTexture({ size: [w, h], format: fmt, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: w * comps * 4, rowsPerImage: h }, [w, h]);
		return tex;
	}
	// group(2) の 2D 配列＝raw（u32 の生配列・texel = comps 個）を幅 w・層 LH 行で分割送り。minTexels＝載せる texel 数の下限（meta の複製行）
	// 丸ごとの padding 済み写しは作らない（uploadTexArrU32＝満杯の行は raw の view をそのまま writeTexture、端の半端な 1 行だけ詰め物）
	const texArrU32 = (raw: Uint32Array, w: number, fmt: GPUTextureFormat, comps: number, minTexels = 0) => uploadTexArrU32(device, raw, w, fmt, comps, LH, minTexels);
	function uploadMetaTex(metaU32: Uint32Array, edgeCount: number): GPUTexture {
		return regBuf(texArrU32(metaU32, TEX_META_W, "rgba32uint", 4, edgeCount), metaU32);   // 複製行（長辺の細分用・メタ末尾）も載せる＝minTexels は edgeCount
	}
	function applyArtifacts(L: GintLayer, art: BakeBaseResult) {
		const { gintData } = L as { gintData: GpuGintData };
		const { arcBuffer: ab, pointBuffer: pb } = gintData;
		dropTex(L.arcTex);
		L.arcTex = null;
		if (ab?.length) {
			const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
			L.arcTex = regBuf(texArrU32(arcU32, TEX_ARC_W, "rg32uint", 2), arcU32);
		}
		dropTex(L.metaTex);
		L.metaTex = null;
		L.totalEdges = art.base.edgeCount;
		L.polyEdges = art.base.polyEdgeCount;
		L.polyEdgeByFid = art.base.polyEdgeByFid;
		L.metaChunks = art.base.chunks;
		L.span = [art.base.spanX ?? -1, art.base.spanY ?? -1];   // 最長辺スパン（e7・地形適応細分の上限。-1=未知）
		L.polyBboxByFid = art.polyBboxByFid;
		L.outlineZoom = art.outlineZoom;
		L.fillOff = art.fillOff;
		L.lowFill = !!art.lowFill;   // fillOff でも低ズーム帯の単色塗りだけ生かす層別フラグ（geoedit 大規模モード）
		console.debug("[gint/gpu] edges=%d chunks=%d", L.totalEdges, L.metaChunks?.length ?? 0);
		if (L.totalEdges > 0) L.metaTex = uploadMetaTex(art.base.metaU32, L.totalEdges);
		if (L.pivotTex) { L.pivotTex.destroy(); L.pivotTex = null; }
		L.pivotW = 0;
		if (art.pivot && art.pivot.w <= TEX_ARC_W) {
			L.pivotTex = texU32(art.pivot.px, art.pivot.w, art.pivot.h, "rgba32uint", 4);
			L.pivotW = art.pivot.w;
		}
		// compTex: ポリゴン辺→塗り扇の鍵（R32UI）。多片地物の層だけ（GL textures.ts と対）＝扇の要と裏側カリングを構成ポリゴン単位に
		if (L.compTex) { L.compTex.destroy(); L.compTex = null; }
		L.compW = 0;
		if (L.pivotTex && art.comp && art.comp.w <= TEX_ARC_W) {
			L.compTex = texU32(art.comp.keys, art.comp.w, art.comp.h, "r32uint", 1);
			L.compW = art.comp.w;
		}
		dropTex(L.metaTexB);
		L.metaTexB = null;
		L.totalEdgesB = 0; L.polyEdgesB = 0; L.spanB = [-1, -1]; L.subB = null;
		if (art.boundary) {
			L.totalEdgesB = art.boundary.edgeCount;
			L.polyEdgesB = art.boundary.polyEdgeCount;
			L.spanB = [art.boundary.spanX ?? -1, art.boundary.spanY ?? -1];
			L.subB = art.boundary.sub ?? null;   // 境界メタの複製行区間 [b,start,count,…]
			L.metaTexB = uploadMetaTex(art.boundary.metaU32, art.boundary.edgeCount);
		}
		dropTex(L.ptTex); L.ptTex = null;
		dropTex(L.ptMetaTex); L.ptMetaTex = null;
		if (pb?.length) {
			const ptU32 = new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4);
			L.totalPoints = ptU32.length / 2;
			L.ptTex = regBuf(texArrU32(ptU32, TEX_ARC_W, "rg32uint", 2), ptU32);
			const ptMetaRaw = gintData.point.subarray(0, L.totalPoints);
			L.ptMetaTex = regBuf(texArrU32(ptMetaRaw, TEX_ARC_W, "r32uint", 1), ptMetaRaw);
		} else L.totalPoints = 0;
		if (L.lodTiers?.length) L.lodTiers.forEach(t => dropTex(t.tex));
		L.lodTiers = [];
		L.tiersDone = false;
	}
	function scheduleTierBuild(L: GintLayer, { weightHist = null }: { weightHist?: WeightHist | null } = {}) {
		const { gintData } = L;
		const ab = gintData?.arcBuffer;
		const gen = L.tierGen = (L.tierGen ?? 0) + 1;
		if (!ab?.length || L.totalEdges <= 200_000) { L.tiersDone = true; return; }
		let plan: number[] | null = null;
		const buildPlan = () => {
			const have = new Set((L.lodTiers ?? []).map(t => t.minW));
			const p = tierPlan(gintData!, L.totalEdges, weightHist, have);
			const rank = L.lastDrawData?.lodRank ?? 0;
			const usable = p.filter(w => w <= rank);
			const first = usable.length ? Math.max(...usable) : null;
			return [...(first != null ? [first] : []), ...p.filter(w => w !== first).reverse()];
		};
		L.tiersDone = false;
		const buildNext = () => {
			if (gen !== L.tierGen || L.gintData?.arcBuffer !== ab) return;
			if (isDrawing) { setTimeout(buildNext, 120); return; }
			plan ??= buildPlan();
			const w = plan.shift();
			if (w == null) {
				L.tiersDone = true;
				postMessage({ action: "tiers", layer: L.id, tiers: L.lodTiers.map(t => ({ minW: t.minW, edgeCount: t.edgeCount })) });
				requestDraw?.();
				return;
			}
			const r = bakeTier(gintData!, w, L.polyBboxByFid);
			if (r.edgeCount) {
				L.lodTiers.push({ minW: r.minW, edgeCount: r.edgeCount, chunks: r.chunks, tex: uploadMetaTex(r.metaU32, r.edgeCount) });
				L.lodTiers.sort((a, b) => a.minW - b.minW);
			}
			setTimeout(buildNext, 0);
		};
		setTimeout(buildNext, 0);
	}
	function deleteTextures(L: GintLayer) {
		for (const f of ["arcTex", "metaTex", "metaTexB", "ptTex", "ptMetaTex", "pivotTex", "compTex"] as const) { dropTex(L[f]); L[f] = null; }
		if (L.lodTiers?.length) L.lodTiers.forEach(t => dropTex(t.tex));
		L.lodTiers = [];
		L.metaChunks = null;
		L.totalEdgesB = L.polyEdgesB = 0;
		L.pivotW = 0; L.compW = 0;
	}

	// ── fid スタイル表（idfill.js uploadFidStyle の WebGPU 版）──────────────
	function uploadFidStyle(L: GintLayer, table: ArrayLike<number>, count: number) {
		const u32 = table instanceof Uint32Array ? table : new Uint32Array(table);
		if (!count || u32.length < count * 4) { clearFidStyle(L); return; }
		const W = Math.min(4096, TEX_ARC_W), H = Math.ceil(count / W);
		if (L.fidStyleTex) L.fidStyleTex.destroy();
		const pad = new Uint32Array(W * H * 4);
		pad.set(u32.subarray(0, count * 4));
		L.fidStyleTex = texU32(pad, W, H, "rgba32uint", 4);
		L.fidStyleW = W; L._fidStyleH = H; L.fidStyleCount = count; L._fidStyleData = { u32, count };
	}
	function clearFidStyle(L: GintLayer) {
		if (L.fidStyleTex) L.fidStyleTex.destroy();
		L.fidStyleTex = null; L.fidStyleW = 0; L._fidStyleH = 0; L.fidStyleCount = 0; L._fidStyleData = null;
		dropExpr(L);
	}
	// ── fid 表を GPU で組む（geopbf 改良点 ⑦・2026-10-12）＝main が式を WGSL に（gpu/gintexpr.js）・属性列と辞書表を送り、ここで compute → fidStyleTex へ copy。
	// feature-state の差し替え（exprState）は列の該当セルを writeBuffer して走らせ直すだけ＝CPU の全 fid 再評価が無い。zoom の差し替えも同じ（uniform 1 本）
	let exprRunner: FidExprRunner | null = null;
	const dropExpr = (L: GintLayer) => { if (L._exprJob) { L._exprJob.destroy(); L._exprJob = null; } };
	async function paintExpr(L: GintLayer, d: GintExprPaint | null | undefined): Promise<Uint32Array | null> {   // d＝{ prog, count, props, states, geom, dnum, dcol, zoom, overlap, table }（table＝表を読み戻して返す＝main の lastTable）
		if (!d?.prog || !(d.count > 0)) { clearFidStyle(L); L.idOverlapMode = !!d?.overlap; bump(); return null; }
		exprRunner ||= createFidExprRunner(device, { texW: Math.min(4096, TEX_ARC_W) });
		const job = await exprRunner.create(d.prog!, d);   // WGSL のエラーは throw（呼び手が ack の error に載せ、main は CPU の表へ落ちる）
		dropExpr(L); L._exprJob = job;
		const W = job.texW, H = job.H;
		if (!L.fidStyleTex || L.fidStyleW !== W || L._fidStyleH !== H) {
			if (L.fidStyleTex) L.fidStyleTex.destroy();
			L.fidStyleTex = device.createTexture({ size: [W, H], format: "rgba32uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		}
		job.run({ tex: L.fidStyleTex });
		L.fidStyleW = W; L._fidStyleH = H; L.fidStyleCount = d.count; L._fidStyleData = null;
		L.idOverlapMode = !!d.overlap;
		bump();
		return d.table ? job.readback() : null;
	}
	function exprState(L: GintLayer, d: GintExprState | null | undefined): Promise<Uint32Array | null> | null {   // d＝{ rows: [[fid, cells]…], dnum?, dcol?（辞書が伸びた時）, zoom?, table }。走者が無い（CPU の表の層）＝false＝main が CPU 経路へ
		const job = L._exprJob; if (!job || !L.fidStyleTex) return null;
		if (d?.dnum) job.growDict(d.dnum, d.dcol!);
		if (d?.rows) for (const [fid, cells] of d.rows) job.setState(fid, cells);
		job.run({ tex: L.fidStyleTex, zoom: d?.zoom });
		bump();
		return d?.table ? job.readback() : Promise.resolve(null);
	}

	// ── 層状態（§10.1 第1ブロック＝層ごとに割る）とスロット束 ────────────────
	// SLOT_FIELDS／emptySlot＝スロット束が退避/復元する層のデータ・スタイル面（gint/state.js・GL と共通＝ベイク済み GPU/台帳資産のキャッシュ）
	const layers: GintLayer[] = [];       // 描画順（後の層が上）
	let act: GintLayer | null = null;          // カーソルを持つ層（§4.1 常に1層。既定＝最後に addLayer した層）
	const GF_LINE = 0, GF_FILL = 1, GF_LINE_B = 2, GF_FILL_B = 3;
	const GF_SLOT = 1792;   // 多角形（P0 #4）＝派生の GF の末尾 float 140〜403 で 1616B → 1792B（256 の倍数・それまで 768B）。   // 案A: meshQ/meshP 追加で 64f 超過＝512B→遠方の要（float 128〜139）で 768B ストライド（dynamic offset は 256 倍数制約）
	function makeLayer(): GintLayer {
		const L: Omit<GintLayer, "frameBG" | "gfBufA" | "frameBGA" | "paramBG"> & Partial<GintLayer> = {
			...emptySlot() as GpuSlot,
			id: null,   // 層の名（worker プロトコルの layer キー。既定層＝null＝従来メッセージと同形）
			order: 0,   // 重ね順（小さいほど下・同値は追加順）。トグル順に依らない決定的な z-order（§4 追記 2026-09-09）
			// スロット束・スタイル・表示（層ごと）
			slots: new Map<SlotKey, Partial<GpuSlot>>(), activeKey: null, drawStyle: null, visible: true, stylesDirty: true,
			idOverlapMode: false, tierGen: 0, sbOn: false,
			// 実行時ラッチ・計器（層ごと）
			lastDrawData: null, _inRange: false, _forceLowMove: false, _budgetSkipped: false,
			_pfLineEdges: 0, _pfTierW: -1, _pfRuns: -1, _pfChunks: -1, _pfDrawn: 0, _pfFbo: 0, _pfPickMs: 0,
			_dbg: null, _dbgRing: [],
			_auxBG: null, _auxKey: null, _idrBG: null, _idrGen: -1, _idrFid: null,
			// UBO（層所有＝多層同フレームの値衝突を構造で封じる）：GF 4スロット＝(rank, rank0)×(pivot有効,
			// 境界メタ=単一要・カリング無効)・GP 役割別・style表。境界メタは「多数 fid の arc 寄せ集め」＝
			// per-fid 扇要では閉ループが閉じず巻き数が漏れる＝GL 版 bindPivotBoundary（has_pivot=0/use_vbb=0）の写し。
			gfBuf: device.createBuffer({ size: GF_SLOT * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
			gpBuf: device.createBuffer({ size: GP_SLOT * 11, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
			styleBuf: device.createBuffer({ size: 8192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
			idRBuf: device.createBuffer({ size: 1280, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),   // 素＝R（16B）・断面の派生＝RC（224B・#111 段 3）
		};
		L.frameBG = [0, GF_SLOT, GF_SLOT * 2, GF_SLOT * 3].map(off => device.createBindGroup({ layout: bglFrame, entries: [
			{ binding: 0, resource: { buffer: L.gfBuf, offset: off, size: GF_SLOT } },
			{ binding: 1, resource: { buffer: L.styleBuf } },
		] }));
		// 地面アトラス焼き込み用 GF（窓 4 × {fill, fillB}）＝同じ submit に並ぶ 4 窓の writeBuffer が互いを潰さない
		L.gfBufA = device.createBuffer({ size: GF_SLOT * 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		L.frameBGA = [0, 1, 2, 3, 4, 5, 6, 7].map(k => device.createBindGroup({ layout: bglFrame, entries: [
			{ binding: 0, resource: { buffer: L.gfBufA!, offset: k * GF_SLOT, size: GF_SLOT } },
			{ binding: 1, resource: { buffer: L.styleBuf } },
		] }));
		L.paramBG = [];
		for (let r = 0; r < 11; r++) L.paramBG.push(device.createBindGroup({ layout: bglParam, entries: [{ binding: 0, resource: { buffer: L.gpBuf, offset: r * GP_SLOT, size: 48 } }] }));
		return L as GintLayer;
	}

	const saveActive = (L: GintLayer) => {
		if (L.activeKey == null) return;
		const b = L.slots.get(L.activeKey) ?? {};
		for (const f of SLOT_FIELDS) (b as Bag)[f] = (L as unknown as Bag)[f];
		L.slots.set(L.activeKey, b);
	};
	const loadBundle = (L: GintLayer, b: Partial<GpuSlot>) => {
		for (const f of SLOT_FIELDS) (L as unknown as Bag)[f] = (b as Bag)[f];
		L.tierGen = (L.tierGen ?? 0) + 1;
		if (L === act) activeId = -1;
		L.lastDrawData = null;
		L._pfLineEdges = 0; L._pfTierW = -1;
	};
	const deleteBundleTextures = (b: Partial<GpuSlot>) => {
		for (const f of ["arcTex", "metaTex", "metaTexB", "ptTex", "ptMetaTex", "pivotTex", "compTex", "fidStyleTex"] as const)
			{ dropTex(b[f]); b[f] = null; }
		if (b.lodTiers?.length) b.lodTiers.forEach(t => dropTex(t.tex));
		b.lodTiers = [];
	};
	function setSlot(L: GintLayer, key: SlotKey) {
		if (key === L.activeKey) return;
		saveActive(L);
		loadBundle(L, L.slots.get(key) ?? emptySlot() as GpuSlot);
		L.activeKey = L.slots.has(key) ? key : null;
		if (L.activeKey != null && !L.tiersDone && L.totalEdges > 0) scheduleTierBuild(L);
		bump();
	}
	function set(L: GintLayer, data: GintSetData | null | undefined, key?: SlotKey) {
		key = key ?? "user";
		if (data) {
			saveActive(L);
			const old = L.slots.get(key);
			if (old && key !== L.activeKey) deleteBundleTextures(old);
			if (key === L.activeKey) deleteTextures(L);
			loadBundle(L, emptySlot() as GpuSlot);
			L.activeKey = key;
			L.gintData = gintDataOf(data) as GpuGintData;
			const art = bakeBase(L.gintData);
			applyArtifacts(L, art);
			scheduleTierBuild(L, { weightHist: art.weightHist });
			({ minZoom: L.minZoom, maxZoom: L.maxZoom } = checkZoomRange({
				arcMeta: L.gintData.arcMeta, minZoom: data.minZoom ?? null, maxZoom: data.maxZoom ?? null, precision: data.precision ?? 6,
			}));
			L.slots.set(key, {});
		} else if (key === L.activeKey) {
			deleteTextures(L);
			loadBundle(L, emptySlot() as GpuSlot);
			L.slots.delete(key);
			L.activeKey = null;
		} else {
			const b = L.slots.get(key);
			if (b) { deleteBundleTextures(b); L.slots.delete(key); }
		}
		if (L === act) activeId = -1;
		L.lastDrawData = null;
		bump();
	}
	function setBaked(L: GintLayer, p: GintBaked | null | undefined, key?: SlotKey): void {
		key = key ?? "user";
		if (!p) return set(L, null, key);
		const prevKey = L.activeKey;
		saveActive(L);
		const old = L.slots.get(key);
		if (old && key !== L.activeKey) deleteBundleTextures(old);
		if (key === L.activeKey) deleteTextures(L);
		loadBundle(L, emptySlot() as GpuSlot);
		L.activeKey = key;
		L.gintData = p.gint as GpuGintData;
		applyArtifacts(L, p.artifacts);
		for (const t of p.tiers ?? []) {
			if (t?.edgeCount) {
				L.lodTiers.push({ minW: t.minW, edgeCount: t.edgeCount, chunks: t.chunks, tex: uploadMetaTex(t.metaU32, t.edgeCount) });
			}
		}
		L.lodTiers.sort((a, b) => a.minW - b.minW);
		L.tiersDone = true;
		postMessage({ action: "tiers", layer: L.id, tiers: L.lodTiers.map(t => ({ minW: t.minW, edgeCount: t.edgeCount })) });
		({ minZoom: L.minZoom, maxZoom: L.maxZoom } = checkZoomRange({
			arcMeta: L.gintData.arcMeta, minZoom: p.minZoom ?? null, maxZoom: p.maxZoom ?? null, precision: p.precision ?? 6,
		}));
		L.slots.set(key, {});
		if (L === act) activeId = -1;
		L.lastDrawData = null;
		if (prevKey !== key) setSlot(L, prevKey);
		bump();
	}
	function style(L: GintLayer, data: GintStyle | null | undefined) { L.drawStyle = data ?? null; L.stylesDirty = true; bump(); }
	function setVisible(L: GintLayer, v: unknown) { L.visible = !!v; bump(); }
	function paint(L: GintLayer, data: GintPaint | null | undefined) {
		if (data?.table && data.count > 0) { dropExpr(L); uploadFidStyle(L, data.table, data.count); }   // CPU の表＝GPU の走者は捨てる（⑦）
		else clearFidStyle(L);
		L.idOverlapMode = !!data?.overlap;
		bump();
	}

	// ── tier 選択・可視 run（passes.js の純JS部を逐語で携行）────────────────
	function pickLineTier(L: GintLayer, rank: number, baseTex: GPUTexture | null, baseCount: number): LineSel & { runs: Runs } {
		let nominal: GintTier | null = null, finest: GintTier | null = null;
		for (const t of L.lodTiers ?? []) {
			if (t.minW <= rank && (!nominal || t.edgeCount < nominal.edgeCount)) nominal = t;
			if (!finest || t.minW < finest.minW) finest = t;
		}
		const sel = nominal
			? { tex: nominal.tex, count: nominal.edgeCount, runs: visibleRuns(nominal.edgeCount, nominal.chunks), minW: nominal.minW }
			: { tex: baseTex, count: baseCount, runs: visibleRuns(baseCount, L.metaChunks, L.span), minW: 0 };
		L._pfRuns = sel.runs.length; L._pfChunks = (nominal ? nominal.chunks : L.metaChunks)?.length ?? 0;
		if (!nominal && finest) {
			let visibleN = 0;
			for (const r of sel.runs) visibleN += r[1];
			if (visibleN > finest.edgeCount * 1.5)
				return { tex: finest.tex, count: finest.edgeCount, runs: visibleRuns(finest.edgeCount, finest.chunks), minW: finest.minW };
		}
		if (!nominal && !finest) {
			const CAP = 600_000;
			let acc = 0;
			for (let i = 0; i < sel.runs.length; i++) {
				if (acc + sel.runs[i][1] > CAP) {
					sel.runs = sel.runs.slice(0, i + 1);
					sel.runs[i] = [sel.runs[i][0], Math.max(0, CAP - acc)];
					sel.minW = -3;
					break;
				}
				acc += sel.runs[i][1];
			}
		}
		return sel;
	}
	// run＝[startEdge, edgeCount, spanX, spanY]（passes.js visibleRuns と同型）。spanX/Y＝run 内の最長辺スパン（e7・未知=-1）。
	// runs.sub[b]＝可視チャンクの複製行区間（長辺の細分用・bucket-major/chunk-minor＝連続チャンクは 1 区間に併合）
	function visibleRuns(totalCount: number, chunks: EdgeChunk[] | null | undefined, span: number[] | null = null): Runs {
		const vb = V.lastViewBbox;
		if (!chunks?.length) { const r: Runs = [[0, totalCount, span?.[0] ?? -1, span?.[1] ?? -1]]; r.sub = null; return r; }
		const mg = 10000;
		const vx0 = vb ? vb[0] - mg : 0, vy0 = vb ? vb[1] - mg : 0, vx1 = vb ? vb[2] + mg : 0, vy1 = vb ? vb[3] + mg : 0;
		const runs: Runs = [], sub: SubRuns = new Array(SUB_NB).fill(null);
		let curStart = -1, curEnd = 0, sx = -1, sy = -1;
		const mergeSpan = (c: EdgeChunk) => { if (c.sx == null || c.sx < 0 || sx === -2) { sx = -2; return; } if (c.sx > sx) sx = c.sx; if (c.sy > sy) sy = c.sy; };
		const addSub = (c: EdgeChunk) => { const a = c.sub; if (!a) return;
			for (let i = 0; i < a.length; i += 3) { const b = a[i], st = a[i + 1], n = a[i + 2]; const L = (sub[b] ??= []); const last = L[L.length - 1];
				if (last && last[0] + last[1] === st) last[1] += n; else L.push([st, n]); } };
		for (const c of chunks) {
			const b = c.bbox;
			const vis = !vb || !(b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1);   // vb 無し＝全チャンク可視
			if (vis) { if (curStart < 0) { curStart = c.start; sx = -1; sy = -1; } curEnd = c.end; mergeSpan(c); addSub(c); }
			else if (curStart >= 0) { runs.push([curStart, curEnd - curStart, sx < 0 ? -1 : sx, sx < 0 ? -1 : sy]); curStart = -1; }
		}
		if (curStart >= 0) runs.push([curStart, curEnd - curStart, sx < 0 ? -1 : sx, sx < 0 ? -1 : sy]);
		runs.sub = sub;
		return runs;
	}
	function subListRuns(list: number[] | null): SubRuns | null {   // 台帳無しメタ（境界メタ）の [b,start,count,…] → runs.sub 形式
		if (!list) return null;
		const sub: SubRuns = new Array(SUB_NB).fill(null);
		for (let i = 0; i < list.length; i += 3) (sub[list[i]] ??= []).push([list[i + 1], list[i + 2]]);
		return sub;
	}

	// ── UBO 詰め物（CPU 側スクラッチはエンジン共有＝逐次処理ゆえ安全。書き先は層の buffer）──
	const gfAB = new ArrayBuffer(GF_SLOT * 4);
	const gfF = new Float32Array(gfAB), gfU = new Uint32Array(gfAB), gfI = new Int32Array(gfAB);
	function packGF(L: GintLayer, off: number, d: GintDraw, lodRank: number, noPivot = false, skipE7 = 0, atlas: GintAtlas | null = null) {
		const o = off >> 2, dep = d.depth;
		gfF.set(d.mvp, o);
		gfF[o + 16] = d.clipT[0]; gfF[o + 17] = d.clipT[1]; gfF[o + 18] = d.clipT[2]; gfF[o + 19] = d.clipT[3];
		const lon = ((d.origin[0] % 360) + 540) % 360 - 180;
		// 楕円体＝緯度側は β（更成緯度）の三角＋dβ 錨（2φ/4φ 三角は GF の予備枠へ。球＝β=φ・錨は全0）
		const lr = lon * Math.PI / 180, br = betaOf(d.origin[1]) * Math.PI / 180;
		gfF[o + 20] = Math.cos(lr); gfF[o + 21] = Math.sin(lr); gfF[o + 22] = Math.cos(br); gfF[o + 23] = Math.sin(br);
		gfF[o + 24] = d.eye[0]; gfF[o + 25] = d.eye[1]; gfF[o + 26] = d.eye[2]; gfF[o + 27] = 0;
		gfF[o + 28] = d.originPt[0]; gfF[o + 29] = d.originPt[1]; gfF[o + 30] = d.originPt[2]; gfF[o + 31] = 0;
		gfF[o + 32] = lon; gfF[o + 33] = d.origin[1];
		gfF[o + 34] = V.width; gfF[o + 35] = V.height;
		gfU[o + 36] = (Math.round((lon + 180) * 1e7)) >>> 0;
		gfU[o + 37] = (Math.round((d.origin[1] + 90) * 1e7)) >>> 0;
		gfI[o + 38] = TEX_ARC_W; gfI[o + 39] = TEX_META_W;
		const ell = ellipsoidOn(), pr = d.origin[1] * Math.PI / 180;
		gfF[o + 40] = d.originZr ?? 0; gfF[o + 41] = lodRank;
		gfF[o + 42] = ell ? Math.cos(2 * pr) : 0; gfF[o + 43] = ell ? Math.sin(2 * pr) : 0;   // ellT2（旧 _pad0）
		const vb = atlas ? atlas.vbb : V.lastViewBbox;   // 窓座標モード＝窓 bbox で刈る（縫い目跨ぎ＝null＝刈らない）
		if (vb) {
			gfU[o + 44] = Math.max(0, vb[0] - 10000); gfU[o + 45] = Math.max(0, vb[1] - 10000);
			gfU[o + 46] = Math.min(0xFFFFFFFF, vb[2] + 10000); gfU[o + 47] = Math.min(0xFFFFFFFF, vb[3] + 10000);
		} else { gfU[o + 44] = gfU[o + 45] = gfU[o + 46] = gfU[o + 47] = 0; }
		gfU[o + 48] = (!noPivot && L.pivotTex) ? 1 : 0;
		gfU[o + 49] = (!noPivot && L.pivotTex && vb) ? 1 : 0;
		gfU[o + 50] = L.pivotW || 1;
		gfU[o + 51] = L.fidStyleTex ? (L.fidStyleW || 1) : 0;
		gfF[o + 52] = dep?.logCoef ?? 0; gfF[o + 53] = dep?.fogFar ?? 1e9; gfF[o + 54] = dep?.elevScale ?? 0; gfF[o + 55] = (dep?.hasElev ?? 0) as number;
		const b = dep?.elevBounds;
		gfF[o + 56] = b?.[0] ?? 0; gfF[o + 57] = b?.[1] ?? 0; gfF[o + 58] = b?.[2] ?? 1; gfF[o + 59] = b?.[3] ?? 1;
		gfF[o + 60] = dep?.edgeFade ?? 0;   // elevP = (edgeFade, cos4φ0, sin4φ0, ell)＝予備3枠へ dβ 錨の残りとゲート
		gfF[o + 61] = ell ? Math.cos(4 * pr) : 0; gfF[o + 62] = ell ? Math.sin(4 * pr) : 0; gfF[o + 63] = ell ? 1 : 0;
		const mq = dep?.meshQ;   // 案A: 描画メッシュ面への量子化（無ければ G=0＝素の elevAt）
		gfF[o + 64] = mq?.[0] ?? 0; gfF[o + 65] = mq?.[1] ?? 0; gfF[o + 66] = mq?.[2] ?? 1; gfF[o + 67] = mq?.[3] ?? 1;
		gfF[o + 68] = dep?.meshG ?? 0; gfF[o + 69] = d.near?.[0] ?? 0; gfF[o + 70] = d.near?.[1] ?? 0; gfF[o + 71] = skipE7;
		gfF[o + 72] = atlas ? atlas.off[0] : 0; gfF[o + 73] = atlas ? atlas.off[1] : 0; gfF[o + 74] = atlas ? atlas.inv[0] : 1; gfF[o + 75] = atlas ? atlas.inv[1] : 1;
		gfF[o + 76] = atlas ? 1 : 0; gfF[o + 77] = 0; gfF[o + 78] = 0; gfF[o + 79] = 0;
		// 遠方の要（塗り扇の画面カリング・float 128〜139＝断面の予約欄 80〜127 の後ろ）：per-fid の要は pivot 有効の時だけ（線の GF は要を使わない＝書いても無害）
		// 単一要（noPivot＝境界メタ）は層が視野よりずっと大きい時だけ遠方の 1 点（farPivotGlobal・環は fid を跨いで閉じる＝巻き数不変）
		const dd = atlas ? { atlas } : d;
		const fp = (!noPivot && L.pivotTex) ? farPivotParams(dd, vb) : null;
		const gP = noPivot ? farPivotGlobal(dd, vb, layerBboxOf(L.polyBboxByFid)) : null;
		if (fp) { gfF[o + 128] = fp.axes[0]; gfF[o + 129] = fp.axes[1]; gfF[o + 130] = fp.axes[2]; gfF[o + 131] = fp.axes[3]; }
		else if (gP) { gfF[o + 128] = gP[0]; gfF[o + 129] = gP[1]; gfF[o + 130] = 0; gfF[o + 131] = 0; }
		gfF[o + 132] = fp ? fp.q[0] : 0; gfF[o + 133] = fp ? fp.q[1] : 0; gfF[o + 134] = fp ? 1 : gP ? 2 : 0; gfF[o + 135] = FAR_K;
		gfU[o + 136] = fp ? fp.big[0] : 0; gfU[o + 137] = fp ? fp.big[1] : 0;
		gfU[o + 138] = (!noPivot && L.pivotTex && L.compTex) ? (L.compW || 1) : 0;   // farBig.z＝辺→塗り扇の鍵の表の幅（0＝表なし＝鍵は fid）。境界メタ（noPivot）は読まない
		gfU[o + 139] = 0;
		const ci = clipInfo();   // 断面（#111 段 3）＝派生の GF だけが読む末尾（float 80〜127）
		if (ci) packClip(gfF, o + 80, d.origin, ci, o + 140);   // atlasQ.x＝窓座標モード   // meshP.yz＝地形適応細分の近傍窓（deg 半幅・0=集中なし）・w＝メイン描画が飛ばす長辺の下限スパン（e7・S0·2^b は f32 で厳密）
	}
	// 面と全画面レイを f に詰める（base から：clipPl 24・clipP 4・rayF/X/Y・eyeC・eyeO＝GF の末尾と ID 塗りの解決 RC で同じ並び）。K＝n·(gint の原点) − c を f64 で
	// 多角形（P0 #4）は pbase へ（cpe・cpn・辺 64＝264 float）。辺の数と inverse は clipP.zw
	function packClip(f: Float32Array, base: number, origin: number[], ci: GintClipInfo, pbase: number) {
		const O = lonlatTo3D(origin[0], origin[1]), n = Math.min(ci.planes.length, 6);
		f.fill(0, base, base + 48);
		const pg = ci.poly;
		if (pg && pg.edges.length) {
			const d = [O[0] - pg.C[0], O[1] - pg.C[1], O[2] - pg.C[2]], m = Math.min(pg.edges.length, CLIP_POLY_MAX);
			f[base + 26] = m; f[base + 27] = pg.inverse ? 1 : 0;
			f.set([pg.e[0], pg.e[1], pg.e[2], pg.e[0] * d[0] + pg.e[1] * d[1] + pg.e[2] * d[2], pg.n[0], pg.n[1], pg.n[2], pg.n[0] * d[0] + pg.n[1] * d[1] + pg.n[2] * d[2]], pbase);
			for (let i = 0; i < m; i++) f.set(pg.edges[i], pbase + 8 + i * 4);
		}
		for (let i = 0; i < n; i++) { const [x, y, z, c] = ci.planes[i]; f[base + i * 4] = x; f[base + i * 4 + 1] = y; f[base + i * 4 + 2] = z; f[base + i * 4 + 3] = x * O[0] + y * O[1] + z * O[2] - c; }
		f[base + 24] = n;
		const u = sphereRayUniforms(ci.st, origin);
		f.set([...u.F, 0, ...u.X, 0, ...u.Y, 0, ...u.E, u.c, ...u.EO!, 0], base + 28);
	}
	const gpAB = new ArrayBuffer(GP_SLOT * 11);
	const gpF = new Float32Array(gpAB), gpI = new Int32Array(gpAB);
	function packGP(role: number, { width = 0, widthAdd = 0, radius = 0, hidden = 0, dpr = null, fidW = 0, activeId = -1, pass = 0, color = null }: GPPack = {}) {
		const o = role * (GP_SLOT >> 2);
		gpF[o] = width; gpF[o + 1] = widthAdd; gpF[o + 2] = radius; gpF[o + 3] = dpr ?? hidden;   // a.w＝線ロール hidden / 点ロール dpr（表の 1/4px 半径→device px）
		gpI[o + 4] = activeId; gpI[o + 5] = pass; gpI[o + 7] = 0;
		if (fidW) gpF[o + 6] = fidW; else gpI[o + 6] = 0;   // b.z＝表の line-width の倍率（f32 のビットを i32 欄に＝WGSL が bitcast・0＝1）
		if (color) { gpF[o + 8] = color[0]; gpF[o + 9] = color[1]; gpF[o + 10] = color[2]; gpF[o + 11] = color[3]; }
		else { gpF[o + 8] = gpF[o + 9] = gpF[o + 10] = gpF[o + 11] = 0; }
	}
	const styleAB = new Float32Array(2048);
	function uploadStyles(L: GintLayer, data: GintDraw) {
		const st = data.styleTable ?? DEF_STYLE, da = data.dashTable ?? DEF_DASH;
		styleAB.set(st, 0);
		for (let i = 0; i < 256; i++) { styleAB[1024 + i * 4] = da[i * 2]; styleAB[1024 + i * 4 + 1] = da[i * 2 + 1]; }
		device.queue.writeBuffer(L.styleBuf, 0, styleAB);
		L.stylesDirty = false;
	}

	// ── 描画（embed.js draw ＋ passes.js renderCleanScene/drawHighlight の統合）──────
	let fboW = 0, fboH = 0, pickTex: GPUTexture | null = null;
	function draw(cam: CameraPose, ctx?: GintDepthCtx | null) {
		const fr = host.frameInfo();
		if (!fr) { for (const L of layers) mark(L, cam, "noFrame"); return; }
		V.width = fr.w;
		V.height = fr.h;
		V.dpr = cam.dpr || 1;
		// カメラ運動の判定＝フレームに1回（旧・層内判定をエンジンへ）。層別の予算ラッチは層側に残る
		const l = lastSyncCam;
		const moved = !l || l.center[0] !== cam.center[0] || l.center[1] !== cam.center[1]
			|| l.zoom !== cam.zoom || l.pitch !== cam.pitch || l.bearing !== cam.bearing;
		lastSyncCam = { center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing };
		if (moved) {
			isDrawing = true;
			clearTimeout(moveTimer!); moveTimer = null; pendingMove = null;
			staticN = 0;
			if (activeId !== -1) { activeId = -1; postMessage({ action: "identify", featureId: null, layer: act?.id ?? null }); }
		} else {
			isDrawing = false;
			staticN = (staticN ?? 0) + 1;
		}
		lastMX = NaN; lastMY = NaN;
		for (const L of layers) drawLayer(L, cam, fr, ctx);   // layers は order 昇順を維持＝後ろの層が上（order 未指定＝追加順）
	}
	function mark(L: GintLayer, cam: CameraPose, path: string) {   // 計器（stats.dbg）＋直近フレームのリング（操作中に何が起きたかを事後に読む）
		L._dbg = { path, vis: L.visible, z: +(cam.zoom ?? 0).toFixed(2), t: Date.now() % 100000 };
		(L._dbgRing ??= []).push(`${path[0]}${L.visible ? "" : "!"}z${(cam.zoom ?? 0).toFixed(1)}w${L._pfTierW ?? "?"}e${((L._pfLineEdges ?? 0) / 1000) | 0}k`);
		if (L._dbgRing.length > 90) L._dbgRing.shift();
	}
	function drawLayer(L: GintLayer, cam: CameraPose, fr: GintFrame, ctx: GintDepthCtx | null | undefined) {
		L.sbOn = sbReady(L);   // 経路（storage/テクスチャ）は層のフレーム頭で確定＝pipesFor と texBG が同じ側を向く（層のパス内で揺らさない）
		if (!L.visible && !L.polyBboxByFid && L.totalPoints === 0) { mark(L, cam, "hidden"); L._inRange = false; L.lastDrawData = null; return; }
		const MOVE_EDGE_BUDGET = L.drawStyle?.moveBudget ?? 250_000;
		// 移動中の予算超え＝従来は丸ごとスキップ（層が消える）。境界メタ（共有arc正味0排除＝外郭のみ）が
		// 予算内ならば「安い表現」（境界線＋低ズーム帯なら単色塗り）へ落として描き続ける＝動いても消えない。
		// 判定は _forceLowMove でラッチ（安い表現の実測辺数で予算判定が翻ると全/安が明滅するため）＝静止4フレームで解除。
		if (staticN >= 4) L._forceLowMove = false;
		else if ((L._pfLineEdges ?? 0) > MOVE_EDGE_BUDGET) L._forceLowMove = true;
		if (L._forceLowMove) {
			// 安い表現の成立条件：境界線が予算内 or 境界stencil塗り（頂点扇のみ＝線パスより軽い）が予算×4内。
			// ZCTA型（共有arc相殺＝境界は海岸線だけ）は内陸ビューで境界線が視界に無い＝塗りのシルエットが本体。
			const canLines = L.metaTexB && L.totalEdgesB > 0 && L.totalEdgesB <= MOVE_EDGE_BUDGET;
			const canFill = (L.polyBboxByFid?.size ?? 0) > 0 && (!L.fillOff || L.lowFill) && L.polyEdgesB > 0 && L.polyEdgesB <= MOVE_EDGE_BUDGET * 8;   // ×8＝stencil扇は頂点のみ＝線パスより桁軽い。実ZCTA境界=1.03Mを通す実測裁定
			if (!canLines && !canFill) {   // 境界も塗りも重い（孤立ポリ系）＝従来どおりスキップ
				mark(L, cam, "budget");
				L.lastDrawData = null;
				L._budgetSkipped = true;
				return;
			}
			if (!isDrawing) requestDraw?.();   // 静止後も自前でフレーム継続＝staticN を進めて正表現へ必ず収束（相乗りしない原則）
		}
		const data: GintInput = { cam, ...(L.drawStyle || {}) };
		if (L._forceLowMove) data._forceLow = true;
		if (!zoomInRange(L, data)) { mark(L, cam, "range"); L._inRange = false; L.lastDrawData = null; L._pfLineEdges = 0; L._pfTierW = -1; return; }
		L._inRange = true;
		if (L.totalEdges === 0 && L.totalPoints === 0) { L.lastDrawData = null; L._pfLineEdges = 0; L._pfTierW = -1; return; }
		L._budgetSkipped = false;
		const drawData = computeDrawData(V, data) as GintDraw;
		if (ctx && ctx.terrainDepth && !data.noDepth) drawData.depth = ctx;   // noDepth＝地形深度に参加しない（admin0 世界図＝gl/embed.js と同型）
		if (ctx && ctx.facesInAtlas) drawData.noFaces = true;   // 面は地面アトラス側（bakeFaces）＝画面では線・点だけ

		if (L.visible) renderScene(L, drawData, fr, ctx);
		mark(L, cam, L.visible ? "drew" : "invisible");
		L.lastDrawData = drawData;
		if (L === act && pickPending) { pickPending = false; drawn(); }
	}

	// 塗り（面）の計画（renderCleanScene の判定＝逐語）。noFaces＝面は地面アトラス側（bakeFaces）＝画面では描かない
	function fillPlan(L: GintLayer, data: GintDraw, atlas = false) {   // atlas＝窓座標モード（bakeFaces）＝境界メタを使わない（下）
		const st = data.styleTable ?? DEF_STYLE;
		const zoomV = data.zoom ?? 99, oz = data.outlineZoom ?? L.outlineZoom ?? OUTLINE_ZOOM;   // スタイル側上書き（gl/passes.js と同型＝admin0 の境界メタ縮退切り）
		const lowZoom = zoomV < oz;
		const moving = isDrawing || (staticN ?? 99) < 4;
		const lowZoomEff = lowZoom || (moving && zoomV < oz + 1.5) || !!data._forceLow;
		const hasPoly = (L.polyBboxByFid?.size ?? 0) > 0 && (!L.fillOff || L.lowFill);   // lowFill＝低ズーム帯の単色塗りは生かす（fillA フェードが z<oz+1.2 に閉じ込める）
		const fillA = data._forceLow ? st[3] * 0.8   // 安表現中＝フェード無効（内陸ビューでも面のシルエットを残す）
			: st[3] * 0.8 * Math.max(0, Math.min(1, ((oz + 1.2) - zoomV) / 1.2));
		const fc = data.fillColor ?? (hasPoly && (lowZoomEff || fillA > 0.004) ? [st[0], st[1], st[2], fillA] : DEF_FILL);
		// 窓座標モードは境界メタを使わない：fid 混成ループには環ごとの bbox が無く、原点±180° を跨ぐループを連続に置けない
		//（vsStencil の atlasFanVertex＝鍵の bbox 中心の周りで連続）＝基準メタ（鍵＝構成ポリゴン）で焼く（gl/passes.ts と対）
		const hasB = !!(L.metaTexB && L.polyEdgesB > 0) && !atlas;
		const stTex = hasB ? L.metaTexB : L.metaTex, stCount = hasB ? L.polyEdgesB : L.polyEdges;
		const doFill = !data.noFaces && fc[3] > 0 && stCount > 0 && L.arcTex
			&& !(data._forceLow && stCount > (data.moveBudget ?? 250_000) * 8);   // 安表現中の塗り予算（sync の canFill と同じ物差し）
		const idFill = !data.noFaces && !data._forceLow && canUseIdFill(L);   // 安い表現中は idfill（全密度扇）を止める
		return { lowZoom, lowZoomEff, moving, fc, hasB, stTex, stCount, doFill, idFill };
	}
	function renderScene(L: GintLayer, data: GintDraw, fr: GintFrame, ctx: GintDepthCtx | null | undefined) {
		const dep = data.depth;
		const P = pipesFor(fr.samples || host.samples || 4, L.sbOn, !!clipInfo());   // 遷移時AA＝renderer のフレーム段数にセットごと追随・断面の間は派生のセット
		// UBO を先に確定（queue.writeBuffer は submit 前に順序どおり適用される。書き先は層の buffer＝他層と衝突しない）
		packGF(L, GF_LINE * GF_SLOT, data, data.lodRank ?? 0);
		packGF(L, GF_FILL * GF_SLOT, data, 0);                     // 塗り stencil＝全密度（rank0）
		packGF(L, GF_LINE_B * GF_SLOT, data, data.lodRank ?? 0, true);   // 境界メタ線＝単一要・カリング無効
		packGF(L, GF_FILL_B * GF_SLOT, data, 0, true);                   // 境界メタ塗り＝同上
		device.queue.writeBuffer(L.gfBuf, 0, gfAB);
		if (L.stylesDirty) uploadStyles(L, data);

		// renderCleanScene の判定（逐語）＝fillPlan（画面と地面アトラスの焼き込みで同じ判定）
		const st = data.styleTable ?? DEF_STYLE;
		const fp = fillPlan(L, data);
		const { lowZoom, lowZoomEff, moving, fc, hasB, stTex, stCount, doFill } = fp;
		if (!isDrawing && moving && !lowZoom && lowZoomEff) requestDraw?.();
		// コロプレス（paint 時）＝ID バッファ塗り。能力あり＝単色 stencil でなく idfill（優先）。基準メタ固定（fid 重み）
		const idFill = fp.idFill && ensureIdTex() && !!idResolveBGFor(L);
		// 線 tier 選択（passes.js と同判断）
		let lnSel: LineSel | null = null;
		if (L.totalEdges > 0 && L.arcTex) {
			const finestT = L.lodTiers?.length ? L.lodTiers[0] : null;
			const lnB = data._forceLow ? !!(L.metaTexB && L.totalEdgesB > 0 && L.totalEdgesB <= (data.moveBudget ?? 250_000))   // 強制安表現＝境界一択・予算超は線なし（塗りシルエットのみ）
				: lowZoomEff && L.metaTexB && L.polyEdgesB > 0
				&& (finestT ? L.totalEdgesB <= finestT.edgeCount * 1.5 : L.totalEdgesB <= 600_000);
			lnSel = lnB
				? { tex: L.metaTexB, count: L.totalEdgesB, runs: null, minW: -2, boundary: true, sub: subListRuns(L.subB) }
				: data._forceLow ? null   // 安表現中に境界が予算超＝線パスは出さない（フル tier へ落とさない）
				: { ...pickLineTier(L, data.lodRank ?? 0, L.metaTex, L.totalEdges), boundary: false };
		}
		if (!lnSel && data._forceLow) { L._pfLineEdges = 0; L._pfTierW = -4; }   // perf印: -4＝安表現で線パス抑止（塗りシルエットのみ）
		// GP スロット確定（カーソル＝アクティブ層のみ。§4.1）
		const aId = L === act ? activeId : -1;
		const lw = data.lineWidth ?? 1.0;
		packGP(ROLE.stencil, {});
		packGP(ROLE.fill, { color: fc });
		packGP(ROLE.line, { width: lw, activeId: aId, pass: 0, fidW: V.dpr });   // fidW＝表の line-width（CSS px）→ device px（U1）
		packGP(ROLE.lineHidden, { width: lw, activeId: aId, pass: 0, hidden: 1, fidW: V.dpr });
		packGP(ROLE.hilite, { width: lw + 2.0, widthAdd: 2.0, radius: data.hiliteWidth || 0, activeId: aId, pass: 1, color: data.hiliteColor, fidW: V.dpr });   // radius欄でホバー全幅(device px)を運ぶ＝指定時は shader が lw を上書き（overlay 町丁目線と一致）。hiliteColor＝ホバー線色（未指定＝素の線色を不透明）
		packGP(ROLE.maskStencil, { activeId: aId });
		packGP(ROLE.maskFill, { color: data.maskColor ?? DEF_MASK });
		packGP(ROLE.point, { radius: data.ptRadius ?? 1.5, activeId: -1, dpr: V.dpr });
		packGP(ROLE.pointHi, { radius: data.ptRadius ?? 1.5, activeId: aId, dpr: V.dpr });
		device.queue.writeBuffer(L.gpBuf, 0, gpAB);

		const aux = auxGroup(L, ctx?.elevView, ctx?.elevSampler);
		L._pickElev = ctx?.elevView ? [ctx.elevView, ctx.elevSampler] : null;   // pick の点も描画と同じ標高で地形へ乗せる（点 VS のドレープ）
		// ① ID 蓄積パス（main パスより前・fr.enc の別 render pass）＝winding 和を rg16float へ。基準メタ・rank0・pivot 有効
		if (idFill) {
			idRCPU[0] = L.fidStyleW || 1; idRCPU[1] = L.fidStyleCount; idRCPU[2] = L.idOverlapMode ? 1 : 0; idRCPU[3] = 0;
			const ci = clipInfo();   // 断面（#111 段 3）＝解決の派生が読む（RC：r の後ろに面と全画面レイ・画面の大きさ）
			if (ci) { packClip(idRF, 4, data.origin, ci, 56); idRF[52] = V.width; idRF[53] = V.height; }
			device.queue.writeBuffer(L.idRBuf, 0, idRCPU);
			const idPass = fr.enc.beginRenderPass({ timestampWrites: host.passTS?.("gint"), colorAttachments: [{ view: idTexView!, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
			idPass.setPipeline(L.sbOn ? idAccumPipeSB : idAccumPipe);
			idPass.setBindGroup(0, L.frameBG[GF_FILL]); idPass.setBindGroup(1, L.paramBG[ROLE.stencil]);
			idPass.setBindGroup(2, texBG(L.sbOn, L.arcTex, L.metaTex)); idPass.setBindGroup(3, aux);
			idPass.draw(L.polyEdges * 3);
			idPass.end();
		}
		const pass = fr.enc.beginRenderPass({
			timestampWrites: host.passTS?.("gint"),   // GPU 実時間＝renderworker の gint スパン（GL の tqSpan("gint") と同格）
			colorAttachments: [{ view: fr.colorView, loadOp: "load", storeOp: "store" }],
			depthStencilAttachment: {
				view: fr.depthView,
				depthLoadOp: "load", depthStoreOp: "store",   // 地形深度に参加（隠線）＝消さない
				stencilLoadOp: "load", stencilStoreOp: "store",   // bit7=renderer の建物マスクを持ち込む（winding は 0x7F 内で自前ゼロ管理）
			},
		});
		pass.setStencilReference(0);
		pass.setBindGroup(1, L.paramBG[ROLE.stencil]);
		pass.setBindGroup(3, aux);
		bindQuads(pass);   // 線・点の index（P3）

		// ② 塗り：コロプレス（idfill）＝解決パスを描画／それ以外＝stencil-then-cover 単色（境界メタ優先）
		// occ＝面ドレープの深度統合：チルト（elevScale>0）でのみ建物 bit7 で塗りをスキップ＝真俯瞰は全塗り維持（裁定）
		const occ = !!(dep && (dep.elevScale ?? 0) > 0 && dep.hasElev);
		if (idFill) {   // ID 画素→fid→スタイル表→色（②の解決＝①で蓄積した idTex を読む）
			pass.setPipeline(occ ? P.idResolveOcc : P.idResolve);   // occ＝建物画素(bit7)を stencil equal(readMask 0x80) で除外
			pass.setBindGroup(0, idResolveBGFor(L));
			pass.draw(3);
		} else if (doFill) {
			pass.setBindGroup(0, L.frameBG[hasB ? GF_FILL_B : GF_FILL]);   // rank0＝全密度（自己交差斑点の根治）。境界メタ＝単一要・カリング無効
			pass.setBindGroup(2, texBG(L.sbOn, L.arcTex, stTex));
			pass.setPipeline(P.stencilFan);
			pass.draw(stCount * 3);
			if (occ) {   // 建物 bit7 の画素の winding を 0 へ（ref 0x80・equal・replace は 0x80&0x7F=0 を書く）→cover(≠0) が陰を跳ぶ
				pass.setStencilReference(0x80);
				pass.setPipeline(P.occlude);
				pass.draw(3);
				pass.setStencilReference(0);
			}
			pass.setPipeline(P.cover);
			pass.setBindGroup(1, L.paramBG[ROLE.fill]);
			pass.draw(3);
			pass.setPipeline(P.zero);   // winding を毎回自前でゼロ（pass の stencil clear を bit7 持ち込みの load に替えた代償）
			pass.draw(3);
		}
		if (idFill) pass.setBindGroup(3, aux);   // idResolve は別レイアウト＝bind group がリセットされる＝後続の線/点用に group3(aux) を張り直す
		// ── 線（tier＋可視 run。深度統合時はテストのみ→GREATER 隠線）──
		if (lnSel) {
			pass.setBindGroup(0, L.frameBG[lnSel.boundary ? GF_LINE_B : GF_LINE]);
			pass.setBindGroup(2, texBG(L.sbOn, L.arcTex, lnSel.tex));
			pass.setPipeline(dep ? P.lineTest : P.line);
			pass.setBindGroup(1, L.paramBG[ROLE.line]);
			// 地形適応細分（dep 時のみ）：メイン描画は skipE7（GF meshP.w）以上の長辺を VS で飛ばし、バケット b の複製行を
			// N[b] インスタンスで描く。N は firstInstance の上位16bit で運ぶ（instance_index＝firstInstance+i＝VS が
			// N=ii>>16・s=ii&0xFFFF と復元＝UBO をバケットごとに書き換えない）。2D/地形なし＝plan は N 全1・skip 0＝従来のまま。
			const runsL = lnSel.runs ?? [[0, lnSel.count]];
			const subRuns = lnSel.runs ? lnSel.runs.sub : lnSel.sub;
			const plan = subPlan(dep, subRuns, isDrawing);   // 移動中は細分を半分（静止で全密度）
			if (plan.skipE7 > 0) {   // skip 下限を GF（線スロット）へ＝plan 確定後に線スロットだけ書き直す（writeBuffer は submit 前に順序どおり）
				packGF(L, GF_LINE * GF_SLOT, data, data.lodRank ?? 0, false, plan.skipE7);
				packGF(L, GF_LINE_B * GF_SLOT, data, data.lodRank ?? 0, true, plan.skipE7);
				device.queue.writeBuffer(L.gfBuf, 0, gfAB);
			}
			const drawRuns = () => {
				for (const [est, cnt] of runsL) drawQuads(pass, cnt, est);
				if (plan.skipE7 > 0 && subRuns) for (let b = 0; b < SUB_NB; b++) {
					const n = plan.N[b], Ls = subRuns[b];
					if (n <= 1 || !Ls) continue;
					for (const [st, cnt] of Ls) drawQuads(pass, cnt, st, n, n << 16);
				}
			};
			let pfEdges = 0;
			for (const r of runsL) pfEdges += r[1];
			drawRuns();
			L._pfLineEdges = pfEdges; L._pfSubs = plan.total; L._pfTierW = lnSel.minW ?? -1;
			if (dep && !isDrawing && pfEdges < 100_000) {
				pass.setPipeline(P.lineHidden);
				pass.setBindGroup(1, L.paramBG[ROLE.lineHidden]);
				drawRuns();   // 同じ細分＝実線と隠線が同じ折れ線
			}
		}
		// ── 点 ──
		if (L.totalPoints > 0 && L.ptTex && L.ptMetaTex) {
			pass.setPipeline(P.point);
			pass.setBindGroup(0, L.frameBG[GF_LINE]);
			pass.setBindGroup(1, L.paramBG[ROLE.point]);
			pass.setBindGroup(2, texBG(L.sbOn, L.ptTex, L.ptMetaTex));
			drawQuads(pass, L.totalPoints, 0);
		}
		// ── ハイライト（activeId≥0＝毎フレーム inline。アクティブ層のみ。深度免除・ドレープのみ＝GL drawHighlight と同順）──
		if (aId !== -1 && (L.arcTex || L.ptTex)) {
			const range = L.polyEdgeByFid?.get(aId);
			const eStart = range?.[0] ?? null, eCount = range?.[1] ?? null;
			const hasRange = eStart != null && eCount! > 0;
			if (L.totalEdges > 0 && L.metaTex) {
				pass.setPipeline(P.line);
				pass.setBindGroup(0, L.frameBG[GF_LINE]);
				pass.setBindGroup(1, L.paramBG[ROLE.hilite]);
				pass.setBindGroup(2, texBG(L.sbOn, L.arcTex, L.metaTex));
				const nH = drapeSubs(dep, [[0, hasRange ? eCount! : L.totalEdges, L.span?.[0] ?? -1, L.span?.[1] ?? -1]])[0];   // 清描画と同じ折れ線に乗る
				if (hasRange) drawQuads(pass, eCount!, eStart, nH, nH << 16);
				else drawQuads(pass, L.totalEdges, 0, nH, nH << 16);
			}
			if (L.totalPoints > 0 && L.ptTex && L.ptMetaTex) {
				pass.setPipeline(P.point);
				pass.setBindGroup(1, L.paramBG[ROLE.pointHi]);
				pass.setBindGroup(2, texBG(L.sbOn, L.ptTex, L.ptMetaTex));
				drawQuads(pass, L.totalPoints, 0);
			}
			const mc = data.maskColor ?? DEF_MASK;
			if (mc[3] > 0 && hasRange && L.metaTex) {
				pass.setPipeline(P.zero);   // stencil を 0 へ（mid-pass clear の代替）
				pass.setBindGroup(1, L.paramBG[ROLE.maskStencil]);
				pass.draw(3);
				pass.setPipeline(P.stencilFan);
				pass.setBindGroup(0, L.frameBG[GF_LINE]);   // GL は実 rank＋per-fid 扇要（bindPivot）＝lodSnap 込みの mask fan
				pass.setBindGroup(2, texBG(L.sbOn, L.arcTex, L.metaTex));
				pass.draw(eCount! * 3, 1, eStart * 3);
				pass.setPipeline(P.coverEq);   // stencil==0＝地物の外を暗く
				pass.setBindGroup(1, L.paramBG[ROLE.maskFill]);
				pass.draw(3);
				pass.setPipeline(P.zero);   // mask winding を後始末（stencil load 化＝後続レイヤへ持ち越さない）
				pass.draw(3);
			}
		}
		pass.end();
	}
	const idRAB = new ArrayBuffer(1280), idRCPU = new Uint32Array(idRAB), idRF = new Float32Array(idRAB);   // 素は先頭 16B（R）・断面の派生は 1280B（RC＝面と全画面レイ 224B＋多角形 1056B）

	// ── settle（picking buffer 構築）＝非MSAA rgba8 テクスチャへ別パス。pick は1枚＝アクティブ層のみ（§4.1）──
	function drawn() {
		isDrawing = false;
		const L = act;
		if (!L) return;
		L._pfDrawn = (L._pfDrawn ?? 0) + 1;
		if (!L.lastDrawData) {
			if (L._budgetSkipped) { L._budgetSkipped = false; staticN = 4; pickPending = true; requestDraw?.(); }
			return;
		}
		if (!L.polyBboxByFid && L.totalPoints === 0) return;
		L.sbOn = sbReady(L);   // draw と別タスク＝set で資源が入れ替わっていることがある＝再ラッチ
		if (!pickTex || fboW !== V.width || fboH !== V.height) {
			if (pickTex) pickTex.destroy();
			pickTex = device.createTexture({ size: [V.width, V.height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
			fboW = V.width; fboH = V.height;
			L._pfFbo = (L._pfFbo ?? 0) + 1;
		}
		const t0 = performance.now();
		const data = L.lastDrawData;
		const pickMargin = 12 * (V.dpr ?? 1);
		packGF(L, 0, data, data.lodRank ?? 0);   // 非表示層（識別だけ生存）は renderScene が GF を書いていない＝ここで確定
		device.queue.writeBuffer(L.gfBuf, 0, gfAB, 0, GF_SLOT);
		packGP(ROLE.pickLine, { width: (data.lineWidth ?? 1.0) + pickMargin });
		packGP(ROLE.pickPoint, { radius: Math.max(data.ptRadius ?? 1.5, pickMargin * 0.5), dpr: V.dpr });
		device.queue.writeBuffer(L.gpBuf, ROLE.pickLine * GP_SLOT, gpAB, ROLE.pickLine * GP_SLOT, GP_SLOT * 2);
		const aux = auxGroup(L, L._pickElev?.[0] ?? null, L._pickElev?.[1] ?? null);   // 点の pick＝描画と同じドレープ（線の pick はドレープしない＝標高を読まない）
		const enc = device.createCommandEncoder();
		const pass = enc.beginRenderPass({
			colorAttachments: [{ view: pickTex.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
		});
		pass.setBindGroup(0, L.frameBG[GF_LINE]);
		pass.setBindGroup(3, aux);
		bindQuads(pass);   // 線・点の index（P3）＝pick も描画と同じ 4 頂点
		if (L.totalEdges > 0 && L.metaTex && L.arcTex) {
			const pkSel = pickLineTier(L, data.lodRank ?? 0, L.metaTex, L.totalEdges);
			pass.setPipeline(pickPipesFor(L.sbOn, !!clipInfo())[0]);
			pass.setBindGroup(1, L.paramBG[ROLE.pickLine]);
			pass.setBindGroup(2, texBG(L.sbOn, L.arcTex, pkSel.tex));
			for (const [est, cnt] of (pkSel.runs ?? [[0, pkSel.count]])) drawQuads(pass, cnt, est);
		}
		if (L.totalPoints > 0 && L.ptTex && L.ptMetaTex) {
			pass.setPipeline(pickPipesFor(L.sbOn, !!clipInfo())[1]);
			pass.setBindGroup(1, L.paramBG[ROLE.pickPoint]);
			pass.setBindGroup(2, texBG(L.sbOn, L.ptTex, L.ptMetaTex));
			drawQuads(pass, L.totalPoints, 0);
		}
		pass.end();
		device.queue.submit([enc.finish()]);
		L._pfPickMs = (L._pfPickMs ?? 0) + (performance.now() - t0);
		if (pendingMove) { const m = pendingMove; pendingMove = null; doIdentify(m); }
	}

	// ── 識別（identify.js の WebGPU 版＝copyTextureToBuffer + mapAsync 非同期読み）────
	let pickBuf: GPUBuffer | null = null, prInFlight: { data: GintPointer; next?: { data: GintPointer } } | null = null;
	function doIdentify(data: GintPointer) {
		if (data.x === lastMX && data.y === lastMY) return;
		lastMX = data.x; lastMY = data.y;
		hitMX = data.x; hitMY = data.y;
		if (!pickTex) return;
		// ★クランプは pickTex の実サイズ(fboW/fboH)で行う＝V.width/V.height（現canvas）ではない。
		// canvasリサイズ（census2020の6:4パネル開閉等）直後は pickTex が旧サイズのまま（settleで作り直すまで）。
		// 現サイズでクランプすると旧pickTexの範囲外を copyTextureToBuffer→コマンドバッファ無効→フレーム落ち＝
		// 「スパッと切れた穴」の連鎖になる（2026-08-12 実機WebGPUで実証）。実サイズでクランプで根治。
		const pickX = Math.max(0, Math.min(fboW - 1, Math.round(data.x * V.dpr)));
		const pickY = Math.max(0, Math.min(fboH - 1, Math.round(data.y * V.dpr)));   // WebGPU は原点左上＝GL の上下反転は不要
		if (prInFlight) { prInFlight.next = { data }; return; }
		if (!pickBuf) pickBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const enc = device.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: pickTex, origin: { x: pickX, y: pickY } }, { buffer: pickBuf, bytesPerRow: 256 }, { width: 1, height: 1 });
		device.queue.submit([enc.finish()]);
		prInFlight = { data };
		// WebKit 轍の予防：submit と同一タスクの mapAsync は canvas present を黙って止める（renderer.js の TQ で実証）＝別タスクへ
		setTimeout(() => pickBuf!.mapAsync(GPUMapMode.READ).then(() => {
			const px = new Uint8Array(pickBuf!.getMappedRange(0, 4)).slice();
			pickBuf!.unmap();
			const pr = prInFlight; prInFlight = null;
			if (!pr) return;
			finishIdentify(px, pr.data);
			if (pr.next) { lastMX = NaN; doIdentify(pr.next.data); }
		}).catch(() => { prInFlight = null; }), 0);   // destroy 中の map 失敗は握る
	}
	function finishIdentify(px: Uint8Array, data: GintPointer) {
		const L = act;
		if (!L) return;
		const fid1 = px[0] | (px[1] << 8) | (px[2] << 16);
		let featureId = fid1 === 0 ? null : fid1 - 1;
		if (fid1 === 0 && L.gintData?.polyStream && V.cam) {
			const geo = unproject(V.cam, data.x * V.dpr, data.y * V.dpr);
			const ci = clipInfo();
			if (geo && !(ci && (clipDistanceM(ci.planes, geo[0], geo[1], 0) < 0 || (ci.poly && clipPolygonDistanceM(ci.poly, geo[0], geo[1]) < 0)))) {   // 断面で切られた側の面は当てない（#111 段 3・塗りの当たりは海抜 0 の点）
				const SE = 1e7;
				featureId = findPolygon(
					L.gintData.arcBuffer as BigUint64Array, L.gintData.arcMeta!, L.gintData.polyStream,
					Math.round((geo[0] + 180) * SE), Math.round((geo[1] + 90) * SE),
					L.polyBboxByFid, V.lastViewBbox, fidVisible(L),   // filter で隠した面はホバーしない（GL と同じ・§4.5）
				);
			}
		}
		const newId = featureId ?? -1;
		if (newId === activeId) return;
		activeId = newId;
		postMessage({ action: "identify", featureId: featureId ?? null, x: data.x, y: data.y, layer: L.id });
		requestDraw?.();
	}
	function move(data: GintPointer) {
		const L = act;
		if (!L) return;
		if (!L._inRange) { leave(); return; }
		// 自己修復：pick 未構築のまま最初のホバーが来た＝settle(gintDrawn)が一度も来ていない
		//（?area=＋hash 復元はカメラを一切動かさない＝onMove の settle タイマーが発火しない）。
		// ここで一度だけ構築すれば以後は通常経路。従来は doIdentify が !pickTex で黙って無反応＝
		// 「カメラを動かすまでホバー/クリック識別が死んでいる」元々のバグ（本人報告 2026-08-14）の根治。
		if (!pickTex && L.lastDrawData && !isDrawing) drawn();
		if (!V.cam || !L.gintData || isDrawing) {
			if (isDrawing) pendingMove = data;
			return;
		}
		if (moveTimer !== null) { pendingMove = data; return; }
		doIdentify(data);
		moveTimer = setTimeout(() => {
			moveTimer = null;
			if (pendingMove) { doIdentify(pendingMove); pendingMove = null; }
		}, MOVE_THROTTLE_MS);
	}
	function leave() {
		clearTimeout(moveTimer!); moveTimer = null;
		pendingMove = null;
		if (activeId === -1) return;
		activeId = -1;
		postMessage({ action: "identify", featureId: null, layer: act?.id ?? null });
		requestDraw?.();
	}
	function click() {
		if (activeId === -1) return;
		const geo = V.cam ? unproject(V.cam, hitMX * V.dpr, hitMY * V.dpr) : null;   // hitMX＝直近 identify の座標（lastMX は draw で NaN）
		postMessage({ action: "click", featureId: activeId, x: hitMX, y: hitMY, lng: geo?.[0] ?? null, lat: geo?.[1] ?? null, layer: act?.id ?? null });
	}
	function disposeLayer(L: GintLayer) {
		saveActive(L);
		for (const b of L.slots.values()) deleteBundleTextures(b);
		L.slots.clear(); L.activeKey = null;
		deleteTextures(L);
		clearFidStyle(L);
		L.gfBuf.destroy(); L.gpBuf.destroy(); L.styleBuf.destroy(); L.idRBuf.destroy(); L.gfBufA?.destroy(); L._idrA = null;
		L.gintData = null;
		L.polyEdgeByFid = null; L.polyBboxByFid = null; L.fillOff = false; L.lowFill = false;
		L.totalEdges = L.totalPoints = L.polyEdges = 0;
		L.lastDrawData = null;
	}
	function dispose() {
		for (const L of layers) disposeLayer(L);
		layers.length = 0; act = null; activeId = -1;
		if (pickTex) { pickTex.destroy(); pickTex = null; }
		if (pickBuf) { pickBuf.destroy(); pickBuf = null; }
		if (idTex) { idTex.destroy(); idTex = null; }
		for (const sc of scratchA.values()) { sc.stTex.destroy(); sc.idTex?.destroy(); }
		scratchA.clear();
		dummyU32.destroy(); dummyF32.destroy();
	}
	function statsFor(L: GintLayer) {
		return { drawn: L._pfDrawn ?? 0, fbo: L._pfFbo ?? 0, pickMs: L._pfPickMs ?? 0, sb: SB ? (L.sbOn ? 1 : 0) : -1, quad4: quad4 ? 1 : 0,
			rank: L.lastDrawData?.lodRank ?? -1, tierW: L._pfTierW ?? -1, edges: L._pfLineEdges ?? 0, dbg: L._dbg ?? null, ring: (L._dbgRing ?? []).slice(-40).join(" "),
			style: L.drawStyle ? { oz: L.drawStyle.outlineZoom, mb: L.drawStyle.moveBudget, nd: L.drawStyle.noDepth, lw: L.drawStyle.lineWidth } : null,
			tiers: L.lodTiers?.length ?? 0, tiersDone: !!L.tiersDone, total: L.totalEdges,
			expr: L._exprJob ? 1 : 0, layers: Math.max(L.arcTex?.depthOrArrayLayers ?? 0, L.metaTex?.depthOrArrayLayers ?? 0, L.ptTex?.depthOrArrayLayers ?? 0), layerH: LH, sbLimit: SB_LIMIT,   // 2D 配列の層数（分割送りの検札）
			runs: L._pfRuns ?? -1, chunks: L._pfChunks ?? -1, vb: V.lastViewBbox };
	}
	// 層ハンドル（§4 addGint の土台＝データ・スタイル面の動詞を層に束ねる。カーソルはエンジン＝activate で移す）
	function layerHandle(L: GintLayer) {
		return {
			set: (d: GintSetData | null | undefined, k?: SlotKey) => set(L, d, k), setSlot: (k: SlotKey) => setSlot(L, k), setBaked: (p: GintBaked | null | undefined, k?: SlotKey) => setBaked(L, p, k),
			style: (d: GintStyle | null | undefined) => style(L, d), setVisible: (v: unknown) => setVisible(L, v), paint: (d: GintPaint | null | undefined) => paint(L, d),
			paintExpr: (d: GintExprPaint | null | undefined) => paintExpr(L, d), exprState: (d: GintExprState | null | undefined) => exprState(L, d),   // fid 表を GPU で組む（⑦）・feature-state／zoom の差し替え
			stats: () => statsFor(L),
			range: () => ({ minZoom: L.minZoom ?? null, maxZoom: L.maxZoom ?? null }),   // 実描画レンジ（データ導出×指定）＝main の照会が「見えている層」を判定する物差し（ack で返す）
			activate: () => { if (act !== L) { act = L; activeId = -1; } },
			setOrder: (n: number) => {   // 実行時の重ね順変更（moveLayer 相当）＝安定位置へ差し直し
				const i = layers.indexOf(L);
				if (i < 0) return;
				layers.splice(i, 1);
				L.order = n;
				const at = layers.findIndex(x => x.order > n);
				layers.splice(at < 0 ? layers.length : at, 0, L);
				bump();
			},
			remove: () => {
				const i = layers.indexOf(L);
				if (i < 0) return;
				layers.splice(i, 1);
				disposeLayer(L);
				if (act === L) { act = layers.length ? layers[layers.length - 1] : null; activeId = -1; }
				bump();
			},
		};
	}
	let orderSeq = 0;
	function addLayer({ id = null, order = null }: { id?: string | null; order?: number | null } = {}) {
		const L = makeLayer();
		L.id = id;
		L.order = order ?? ++orderSeq;   // 既定＝追加順（従来と同じ重なり）。指定＝トグル順に依らない決定的な重ね順
		const at = layers.findIndex(x => x.order > L.order);   // 安定挿入（同 order は追加順を保つ）
		layers.splice(at < 0 ? layers.length : at, 0, L);
		act = L; activeId = -1;   // 既定のアクティブ＝最後に足した層（§4.1「今載せたデータを見たい」）
		bakeRev++;
		return layerHandle(L);
	}

	// ── 地面アトラスへの面焼き込み（RTT ドレープ・2026-09-21）＝renderer.composeGround のフックから窓ごとに呼ばれる ──
	// target={ enc, view, size, win:[W,S,spanLon,spanLat], index }。窓 FBO（rgba8unorm・1x）へ塗り扇（stencil-then-cover／
	// idfill）だけを窓座標モード（GF.atlasQ.x=1）で描く＝球面投影・地平クランプ・ドレープ無し（地形には FS の標本化で乗る）。
	// stencil は窓寸の stencil8 を寸法ごとに 1 枚共有（窓・層ごとに pass 先頭で clear）。画面側 draw は ctx.facesInAtlas で面を省く。
	const stA: GPUDepthStencilState = { format: "stencil8", depthWriteEnabled: false, depthCompare: "always" };
	const pipeA = (mod: GPUShaderModule, vs: string, fs: string, ds: GPUDepthStencilState, lay: GPUPipelineLayout, blend: GPUBlendState | undefined, writeMask: number | undefined) => device.createRenderPipeline({ layout: lay, vertex: { module: mod, entryPoint: vs },
		fragment: { module: mod, entryPoint: fs, targets: [{ format: "rgba8unorm", blend, writeMask }] }, primitive: { topology: "triangle-list" }, depthStencil: ds, multisample: { count: 1 } });
	const pipesA = new Map<boolean, PipesA>();
	const pipesAFor = (sb: boolean) => {
		let p = pipesA.get(sb);
		if (!p) {
			const [sm, lay] = sb ? [stencilModSB, layoutSB] : [stencilMod, layout];
			const ne: GPUStencilFaceState = { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
			p = {
				stencilFan: pipeA(sm, "vsStencil", "fsNull", { ...stA, stencilFront: wind, stencilBack: windB, stencilWriteMask: 0xFF }, lay, undefined, 0),
				cover: pipeA(sm, "vsFull", "fsFill", { ...stA, stencilFront: ne, stencilBack: ne, stencilReadMask: 0xFF, stencilWriteMask: 0 }, lay, SBLEND, undefined),
				idResolve: device.createRenderPipeline({ layout: idResolveLayout, vertex: { module: idResolveMod, entryPoint: "vs" },
					fragment: { module: idResolveMod, entryPoint: "fs", targets: [{ format: "rgba8unorm", blend: SBLEND }] }, primitive: { topology: "triangle-list" }, depthStencil: stA, multisample: { count: 1 } }),
			};
			pipesA.set(sb, p);
		}
		return p;
	};
	const scratchA = new Map<number, AtlasScratch>();   // size → { stView, idTex, idView, gen }（窓は 2 寸法＝2 組）
	function scratchFor(size: number): AtlasScratch {
		let sc = scratchA.get(size);
		if (!sc) {
			const stTex = device.createTexture({ size: [size, size], format: "stencil8", usage: GPUTextureUsage.RENDER_ATTACHMENT });
			sc = { stTex, stView: stTex.createView(), idTex: null, idView: null, gen: 0 };
			scratchA.set(size, sc);
		}
		return sc;
	}
	function idViewA(sc: AtlasScratch, size: number): GPUTextureView {
		if (!sc.idTex) { sc.idTex = device.createTexture({ size: [size, size], format: ID_FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }); sc.idView = sc.idTex.createView(); sc.gen++; }
		return sc.idView!;
	}
	function idResolveBGAFor(L: GintLayer, sc: AtlasScratch, size: number): GPUBindGroup {
		const m = L._idrA ??= new Map();
		const c = m.get(size);
		if (c && c.gen === sc.gen && c.fid === L.fidStyleTex) return c.bg;
		const bg = device.createBindGroup({ layout: bglIdResolve, entries: [
			{ binding: 0, resource: idViewA(sc, size) }, { binding: 1, resource: L.fidStyleTex!.createView() }, { binding: 2, resource: { buffer: L.idRBuf } }] });
		m.set(size, { gen: sc.gen, fid: L.fidStyleTex, bg });
		return bg;
	}
	function bakeFaces(cam: CameraPose, { enc, view, size, win: w, index }: GintAtlasTarget): number {
		if (!V.width) return 0;   // 初回 draw 前（ビュー寸法なし）は焼かない
		const sc = scratchFor(size);
		const seam = w[0] < -180 || w[0] + w[2] > 180;   // 窓 bbox（e7・lastViewBbox と同じ物差し）＝feature bbox カリングを窓で。縫い目跨ぎ＝null＝刈らない
		const vbb = seam ? null : [Math.round((w[0] + 180) * 1e7), Math.round((Math.max(-90, w[1]) + 90) * 1e7), Math.round((w[0] + w[2] + 180) * 1e7), Math.round((Math.min(90, w[1] + w[3]) + 90) * 1e7)];
		const gctx = host.gintCtx?.();
		let n = 0;
		for (const L of layers) {
			if (!L.visible || (L.polyBboxByFid?.size ?? 0) === 0 || !L.arcTex) continue;
			const data: GintInput = { cam, ...(L.drawStyle || {}) };
			if (L._forceLowMove) data._forceLow = true;
			if (!zoomInRange(L, data) || L.totalEdges === 0) continue;
			const dd = computeDrawData(V, data) as GintDraw;
			const fp = fillPlan(L, dd, true);
			const idFill = fp.idFill && !!L.fidStyleTex;
			if (!idFill && !fp.doFill) continue;
			L.sbOn = sbReady(L);
			const lon = ((dd.origin[0] % 360) + 540) % 360 - 180;
			let off = lon - w[0]; off -= 360 * Math.round((off - w[2] / 2) / 360);   // 原点−窓南西隅（CPU f64・経度は窓中心へ最寄りの周回）
			const atlas = { off: [off, dd.origin[1] - w[1]], inv: [1 / w[2], 1 / w[3]], vbb };
			packGF(L, 0, dd, 0, false, 0, atlas); packGF(L, GF_SLOT, dd, 0, true, 0, atlas);
			device.queue.writeBuffer(L.gfBufA, index * 2 * GF_SLOT, gfAB, 0, GF_SLOT * 2);
			if (L.stylesDirty) uploadStyles(L, dd);
			const aux = auxGroup(L, gctx?.elevView, gctx?.elevSampler);   // 窓座標モードは標高を読まない＝bind group キャッシュを画面側と共有するだけ
			const PA = pipesAFor(L.sbOn);
			if (idFill) {
				idRCPU[0] = L.fidStyleW || 1; idRCPU[1] = L.fidStyleCount; idRCPU[2] = L.idOverlapMode ? 1 : 0; idRCPU[3] = 0;
				device.queue.writeBuffer(L.idRBuf, 0, idRCPU);
				const idPass = enc.beginRenderPass({ colorAttachments: [{ view: idViewA(sc, size), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
				idPass.setPipeline(L.sbOn ? idAccumPipeSB : idAccumPipe);
				idPass.setBindGroup(0, L.frameBGA[index * 2]); idPass.setBindGroup(1, L.paramBG[ROLE.stencil]);
				idPass.setBindGroup(2, texBG(L.sbOn, L.arcTex, L.metaTex)); idPass.setBindGroup(3, aux);
				idPass.draw(L.polyEdges * 3, 2);   // インスタンス 1＝原点±180° を跨ぐ環の写し（vsId・窓座標モードだけ）
				idPass.end();
			} else {
				packGP(ROLE.fill, { color: fp.fc });
				device.queue.writeBuffer(L.gpBuf, ROLE.fill * GP_SLOT, gpAB, ROLE.fill * GP_SLOT, GP_SLOT);
			}
			const pass = enc.beginRenderPass({
				colorAttachments: [{ view, loadOp: "load", storeOp: "store" }],
				depthStencilAttachment: { view: sc.stView, stencilLoadOp: "clear", stencilClearValue: 0, stencilStoreOp: "discard" },
			});
			pass.setStencilReference(0);
			if (idFill) {
				pass.setPipeline(PA.idResolve); pass.setBindGroup(0, idResolveBGAFor(L, sc, size)); pass.draw(3);
			} else {
				pass.setBindGroup(0, L.frameBGA[index * 2 + (fp.hasB ? 1 : 0)]); pass.setBindGroup(1, L.paramBG[ROLE.stencil]);
				pass.setBindGroup(2, texBG(L.sbOn, L.arcTex, fp.stTex)); pass.setBindGroup(3, aux);
				pass.setPipeline(PA.stencilFan); pass.draw(fp.stCount * 3, 2);   // インスタンス 1＝原点±180° を跨ぐ環の写し（vsStencil・窓座標モードだけ）
				pass.setPipeline(PA.cover); pass.setBindGroup(1, L.paramBG[ROLE.fill]); pass.draw(3);
			}
			pass.end();
			n++;
		}
		return n;   // 焼いた層数（renderer の計器 gndFaces）
	}
	// 焼き込みの署名＝renderer の合成鍵の一部（変わったら窓を焼き直す）：内容世代＋運動状態（安表現/移動中の塗り判定が変わる）
	// 署名の運動ビットは facePlan の moving（isDrawing || staticN<4）と同じ 1 ビット（#58・2026-09-27）。旧＝isDrawing と staticN<4 の 2 ビット＝
	// worker の rAF が同じ cam を繰り返すと isDrawing だけが瞬いて表現は同じまま署名が変わり、地面アトラスの全窓を焼き直していた
	const bakeSig = () => `${bakeRev}|${(isDrawing || (staticN ?? 99) < 4) ? 1 : 0}|${layers.map(L => L._forceLowMove ? 1 : 0).join("")}`;

	// ── 公開面：既定層への facade（従来 API と同形＝renderworker 無改造）＋ addLayer（多層の新しい口）──
	const L0h = addLayer();
	return {
		set: L0h.set, setSlot: L0h.setSlot, setBaked: L0h.setBaked,
		style: L0h.style, setVisible: L0h.setVisible, paint: L0h.paint, stats: L0h.stats, activate: L0h.activate,
		draw, drawn, move, leave, click, dispose,
		addLayer, bakeFaces, bakeSig,
	};
}
