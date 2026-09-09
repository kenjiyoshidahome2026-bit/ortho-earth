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
import { DEF_STYLE, DEF_DASH, DEF_FILL, DEF_MASK, MOVE_THROTTLE_MS } from "../gl/gint/state.js";
import { computeDrawData, zoomInRange } from "../gl/gint/drawdata.js";
import { checkZoomRange } from "../gl/gint/utility.js";
import { bakeBase, bakeTier, tierPlan } from "../gl/gint/bake.js";
import { findPolygon } from "geopbf/identify";
import { unproject, betaOf, ellipsoidOn } from "../camera.js";
import { GINT_LINE_WGSL, GINT_STENCIL_WGSL, GINT_POINT_WGSL, GINT_IDRESOLVE_WGSL, toStorageWGSL } from "./gintwgsl.js";

const OUTLINE_ZOOM = 13;   // 既定の切替z（passes.js と同値）
const GP_SLOT = 256;
const TEX_ARC_W = 4096, TEX_META_W = 4096;   // テクスチャ経路の折り返し幅（旧 s.TEX_ARC_W/TEX_META_W）
const ROLE = { stencil: 0, fill: 1, line: 2, lineHidden: 3, hilite: 4, maskStencil: 5, maskFill: 6, point: 7, pointHi: 8, pickLine: 9, pickPoint: 10 };

export function createGintLayerGPU(host, { requestDraw, noSB } = {}) {
	const { device, format } = host;
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
	const bglTex2 = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } },
		{ binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } },
	] });
	const bglAux = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } },
		{ binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "uint" } },
		{ binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: "float" } },
		{ binding: 3, visibility: GPUShaderStage.VERTEX, sampler: { type: "filtering" } },
	] });
	const bglBuf2 = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
		{ binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
	] });
	const layout = device.createPipelineLayout({ bindGroupLayouts: [bglFrame, bglParam, bglTex2, bglAux] });
	const layoutSB = device.createPipelineLayout({ bindGroupLayouts: [bglFrame, bglParam, bglBuf2, bglAux] });
	const mkMod = (code, label) => {   // WGSL コンパイル失敗の可視化（renderer.js mkMod と同文・host.gpuErrors へ合流）
		const m = device.createShaderModule({ code });
		m.getCompilationInfo && m.getCompilationInfo().then(info => {
			for (const x of info.messages || []) if (x.type === "error") { const t = `WGSL gint-${label}: ${x.lineNum}:${x.linePos} ${x.message}`; host.gpuErrors && host.gpuErrors.push(t); console.error("[gpu] " + t); }
		});
		return m;
	};
	const lineMod = mkMod(GINT_LINE_WGSL, "line");
	const stencilMod = mkMod(GINT_STENCIL_WGSL, "stencil");
	const pointMod = mkMod(GINT_POINT_WGSL, "point");
	// storage 版は原本の機械変換＝二重管理をしない（toStorageWGSL が変換漏れを例外で知らせる）
	const lineModSB = SB ? mkMod(toStorageWGSL(GINT_LINE_WGSL), "line-sb") : null;
	const stencilModSB = SB ? mkMod(toStorageWGSL(GINT_STENCIL_WGSL), "stencil-sb") : null;
	const pointModSB = SB ? mkMod(toStorageWGSL(GINT_POINT_WGSL), "point-sb") : null;
	// gint は straight alpha（GL blendFuncSeparate(SRC_ALPHA, 1-SA, ONE, 1-SA) と同じ）
	const SBLEND = {
		color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
		alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
	};
	const DS = "depth24plus-stencil8";   // renderer と共有する深度・ステンシル
	const keepDS = { format: DS, depthWriteEnabled: false, depthCompare: "always" };
	const pipe = (mod, vs, fs, { ds = keepDS, blend = SBLEND, writeMask, samples = host.samples || 4, fmt = format, lay = layout } = {}) =>   // 既定＝renderer の MSAA 段数（?msaa=0＝1x に追随）
		device.createRenderPipeline({
			layout: lay,
			vertex: { module: mod, entryPoint: vs },
			fragment: { module: mod, entryPoint: fs, targets: [{ format: fmt, blend, writeMask }] },
			primitive: { topology: "triangle-list" },
			...(ds ? { depthStencil: ds } : {}),
			multisample: { count: samples },
		});
	const wind = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "increment-wrap" };
	const windB = { ...wind, passOp: "decrement-wrap" };
	// stencil bit7(0x80)＝renderer の建物マスク（bld/plateau が刻む・面ドレープの深度統合 2026-08-14）＝winding は
	// ビット0-6（±63で十分）に閉じ込め、cover/mask の比較・書きも 0x7F に限定して bit7 を汚さない。
	const stFan = { ...keepDS, stencilFront: wind, stencilBack: windB, stencilWriteMask: 0x7F };
	const stCoverNE = { ...keepDS, stencilFront: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilBack: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilReadMask: 0x7F, stencilWriteMask: 0 };
	const stCoverEQ = { ...keepDS, stencilFront: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilBack: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilReadMask: 0x7F, stencilWriteMask: 0 };
	const stZero = { ...keepDS, stencilFront: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "replace" }, stencilBack: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "replace" }, stencilWriteMask: 0x7F };
	// 遮蔽消し込み（ドレープ塗り時のみ）：建物 bit7 が立つ画素の winding を 0 へ（ref 0x80・replace は ref&0x7F=0 を書く）
	//＝cover(≠0) が建物の陰を自然にスキップ。ドレープ面＝地形面そのものなので「建物が見えている画素」の判定だけで正しい。
	const stOcc = { ...keepDS, stencilFront: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "replace" }, stencilBack: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "replace" }, stencilReadMask: 0x80, stencilWriteMask: 0x7F };
	const pickLinePipe = pipe(lineMod, "vsPickLine", "fsPick", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm" });
	const pickPointPipe = pipe(pointMod, "vsPickPoint", "fsPickPoint", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm" });
	// pick は 1x 固定＝pipeSets の外だが、group(2) のレイアウトはパイプラインと bind group で一致必須＝storage 版も対で持つ
	const pickLinePipeSB = SB ? pipe(lineModSB, "vsPickLine", "fsPick", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm", lay: layoutSB }) : null;
	const pickPointPipeSB = SB ? pipe(pointModSB, "vsPickPoint", "fsPickPoint", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm", lay: layoutSB }) : null;
	// コロプレス ID 塗り（idfill.js）：① winding 和を ID テクスチャへ加算蓄積（fan 幾何・単一サンプル・深度なし）
	// ② 解決＝ID 画素→fid→スタイル表→色を main パスへ。
	// ★蓄積は fid+1 の winding 和＝市区町村1919個では fid+1 最大1920＋加算途中和が半精度(rg16float)の整数正確域
	//   (2048)を超えて精度崩壊し塗りに穴が出る（境界線は無傷なのに塗りだけ欠ける・2026-08-12実機で判明）。
	//   float32-blendable があれば rg32float（整数1600万まで正確）で根治。無ければ rg16float へ縮退（穴リスク残・
	//   ?gl2=1 で EXT_float_blend の RG32F 経路へ逃げられる）。GL 経路の RG32F/RG16F 選択と同じ判断。
	const canIdF32 = !!device.features?.has?.("float32-blendable");
	const ID_MAX_FID = canIdF32 ? (1 << 20) : 2047, ID_FMT = canIdF32 ? "rg32float" : "rg16float";
	if (!canIdF32) console.warn("[gint] float32-blendable 無し＝idfill は rg16float（大fid市区町村コロプレスで塗り穴の恐れ）");
	const mkIdAccum = (mod, lay) => device.createRenderPipeline({
		layout: lay, vertex: { module: mod, entryPoint: "vsId" },
		fragment: { module: mod, entryPoint: "fsId", targets: [{ format: ID_FMT, blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } } }] },
		primitive: { topology: "triangle-list" }, multisample: { count: 1 },
	});
	const idAccumPipe = mkIdAccum(stencilMod, layout);
	const idAccumPipeSB = SB ? mkIdAccum(stencilModSB, layoutSB) : null;
	const idResolveMod = mkMod(GINT_IDRESOLVE_WGSL, "idresolve");
	const bglIdResolve = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },   // idTex rg16float
		{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },                 // fidTex RGBA32UI
		{ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },                                      // R uniform
	] });
	const idResolveLayout = device.createPipelineLayout({ bindGroupLayouts: [bglIdResolve] });
	const mkIdResolve = (ds, sc) => device.createRenderPipeline({
		layout: idResolveLayout,
		vertex: { module: idResolveMod, entryPoint: "vs" },
		fragment: { module: idResolveMod, entryPoint: "fs", targets: [{ format, blend: SBLEND }] },
		primitive: { topology: "triangle-list" }, depthStencil: ds, multisample: { count: sc },   // main パスへ描く＝renderer のフレーム段数に追随
	});
	// ドレープ塗り時（Occ）＝建物 bit7 が立つ画素をスキップ（ref 0・equal・readMask 0x80＝(v&0x80)==0 のみ塗る）
	const stIdOcc = { ...keepDS, stencilFront: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilBack: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilReadMask: 0x80, stencilWriteMask: 0 };
	// ── main パス行きパイプラインのセット（遷移時AA）：renderer のフレーム段数（frameInfo().samples＝遷移中1x／
	// 静止4x）に multisample count を揃える＝焼き込みゆえセット取替。sampleCount 毎に遅延生成・恒久キャッシュ。
	// pick 系（別パス・rgba8・非MSAA）と idAccum（rg16/32float 蓄積）は従来どおり 1x 固定＝セット外。
	// VS_STENCIL_MASK 系は GL 側でも現行パスで未使用（drawHighlight の mask fan は stencilProgram＝レンジ描画）＝パイプライン化しない
	const buildPipes = (sc, sb) => { const [lm, sm, pm, lay] = sb ? [lineModSB, stencilModSB, pointModSB, layoutSB] : [lineMod, stencilMod, pointMod, layout]; return ({
		stencilFan: pipe(sm, "vsStencil", "fsNull", { ds: stFan, blend: undefined, writeMask: 0, samples: sc, lay }),
		cover: pipe(sm, "vsFull", "fsFill", { ds: stCoverNE, samples: sc, lay }),
		coverEq: pipe(sm, "vsFull", "fsFill", { ds: stCoverEQ, samples: sc, lay }),
		zero: pipe(sm, "vsFull", "fsNull", { ds: stZero, blend: undefined, writeMask: 0, samples: sc, lay }),
		occlude: pipe(sm, "vsFull", "fsNull", { ds: stOcc, blend: undefined, writeMask: 0, samples: sc, lay }),   // 建物 bit7→winding 消し込み
		line: pipe(lm, "vsRender", "fsRender", { samples: sc, lay }),
		lineTest: pipe(lm, "vsRender", "fsRender", { ds: { ...keepDS, depthCompare: "less-equal" }, samples: sc, lay }),
		lineHidden: pipe(lm, "vsRender", "fsRender", { ds: { ...keepDS, depthCompare: "greater" }, samples: sc, lay }),
		point: pipe(pm, "vsPoint", "fsPoint", { samples: sc, lay }),
		idResolve: mkIdResolve(keepDS, sc),
		idResolveOcc: mkIdResolve(stIdOcc, sc),
	}); };
	const pipeSets = new Map();
	// キーは (storage か) × MSAA 段＝層ごとに経路が変わっても互いのキャッシュを潰さない
	const pipesFor = (sc, sb) => { const k = `${sb ? "b" : "t"}#${sc}`; let p = pipeSets.get(k); if (!p) { p = buildPipes(sc, sb); pipeSets.set(k, p); } return p; };
	pipesFor(host.samples || 4, false);
	if (SB) pipesFor(host.samples || 4, true);   // 品質段は生成時に先行コンパイル（renderworker の gint init検証スコープで検札）。1x は初の遷移フレームで遅延生成

	// ── ビュー状態 V（§10.1 第3ブロック＝据え置き。drawdata.js が第一引数で読む/書く）──
	const V = { width: 0, height: 0, dpr: 1, cam: null, lastViewBbox: null };
	// ── カーソル（§4.1 常に1層＝エンジン所有）────────────────────────────
	let activeId = -1, lastMX = NaN, lastMY = NaN, moveTimer = null, pendingMove = null;
	let isDrawing = false, staticN = 0, lastSyncCam = null, pickPending = false;
	// ダミー（未搭載スロットの束縛穴埋め＝layout は常に4テクスチャを要求する）
	const dummyU32 = device.createTexture({ size: [1, 1], format: "r32uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummyF32 = device.createTexture({ size: [1, 1], format: "r16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummySamp = device.createSampler({ magFilter: "linear", minFilter: "linear" });
	// idfill：ID テクスチャ（rg16float・canvas 同寸・単一サンプル）＝エンジン共有スクラッチ。
	// 各層は「自分の idPass →直後に自分の解決」の順で符号化される＝パス実行も符号化順ゆえ共有で衝突しない。
	// 解決 bind group は層ごと（fidStyleTex が層の物）＝idGen（idTex 作り直し世代）で失効管理。
	let idTex = null, idTexView = null, idW = 0, idH = 0, idGen = 0;
	function ensureIdTex() {
		if (idTex && idW === V.width && idH === V.height) return true;
		if (idTex) idTex.destroy();
		idTex = device.createTexture({ size: [V.width, V.height], format: ID_FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
		idTexView = idTex.createView(); idW = V.width; idH = V.height; idGen++;
		return true;
	}
	function idResolveBGFor(L) {
		if (L._idrBG && L._idrGen === idGen && L._idrFid === L.fidStyleTex) return L._idrBG;
		L._idrGen = idGen; L._idrFid = L.fidStyleTex;
		return L._idrBG = L.fidStyleTex ? device.createBindGroup({ layout: bglIdResolve, entries: [
			{ binding: 0, resource: idTexView }, { binding: 1, resource: L.fidStyleTex.createView() }, { binding: 2, resource: { buffer: L.idRBuf } }] }) : null;
	}
	// コロプレス塗りが使えるか（idfill.js canUseIdFill）：paint(fid表)あり・ポリゴンあり・fillOff でない・fid が rg16float 上限内。
	const canUseIdFill = L => !!L.fidStyleTex && L.polyEdges > 0 && !L.fillOff && !!L.arcTex && L.fidStyleCount <= ID_MAX_FID;

	// ── storage buffer の並走（エンジン共有の対応表）─────────────────────────
	// テクスチャ1枚につき同内容の storage buffer を1本持ち、対応表で引く＝描画側の呼び出し
	// （texBG(sb, L.arcTex, lnSel.tex) 等）を書き換えずにモードを切り替えられる。
	const bufOf = new WeakMap();   // texture → 同内容の storage buffer
	const bufU32 = raw => { const b = device.createBuffer({ size: Math.max(4, raw.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(b, 0, raw); return b; };
	// raw＝padding 前の生配列（storage は 4096 幅の折り返しが要らない）。128MB を超える層はテクスチャのまま。
	const regBuf = (tex, raw) => { if (SB && raw && raw.byteLength <= SB_LIMIT) bufOf.set(tex, bufU32(raw)); return tex; };
	// 破棄はテクスチャと対で（WeakMap の自然回収待ち＝GC まで VRAM を掴む）。buffer の無いテクスチャにも安全
	const dropTex = tex => { if (!tex) return; const b = bufOf.get(tex); if (b) { b.destroy(); bufOf.delete(tex); } tex.destroy(); };
	// この層が storage 経路で描けるか（group(2) の全資源に buffer が揃っているか）＝各層の draw/pick 入口でラッチ
	const sbReady = L => SB
		&& (!L.arcTex || bufOf.has(L.arcTex)) && (!L.metaTex || bufOf.has(L.metaTex))
		&& (!L.metaTexB || bufOf.has(L.metaTexB)) && (!L.ptTex || bufOf.has(L.ptTex))
		&& (!L.ptMetaTex || bufOf.has(L.ptMetaTex)) && (L.lodTiers ?? []).every(t => bufOf.has(t.tex));

	// group(2)＝(arc|pt, meta|ptMeta) の bind group キャッシュ（テクスチャ差し替えで自然無効化）
	const texBGs = new WeakMap(), bufBGs = new WeakMap();
	const texBG = (sb, a, b) => {
		if (sb) {   // storage 経路＝対応する buffer で bind（レイアウトは bglBuf2・パイプラインも storage 版）
			const ba = bufOf.get(a), bb = bufOf.get(b);
			if (ba && bb) {
				let m = bufBGs.get(ba); if (!m) bufBGs.set(ba, m = new WeakMap());
				let bg = m.get(bb);
				if (!bg) m.set(bb, bg = device.createBindGroup({ layout: bglBuf2, entries: [
					{ binding: 0, resource: { buffer: ba } }, { binding: 1, resource: { buffer: bb } }] }));
				return bg;
			}
		}
		let m = texBGs.get(a); if (!m) texBGs.set(a, m = new WeakMap());
		let bg = m.get(b);
		if (!bg) m.set(b, bg = device.createBindGroup({ layout: bglTex2, entries: [
			{ binding: 0, resource: a.createView() }, { binding: 1, resource: b.createView() }] }));
		return bg;
	};
	// group(3)＝pivot/fidStyle/標高（層ごとキャッシュ＝何かが差し替わった時だけ作り直す）
	function auxGroup(L, elevView, elevSamp) {
		const p = L.pivotTex || dummyU32, f = L.fidStyleTex || dummyU32;
		const ev = elevView || dummyF32.createView(), es = elevSamp || dummySamp;
		const key = [p, f, elevView || dummyF32, es];
		if (L._auxBG && L._auxKey && L._auxKey.every((v, i) => v === key[i])) return L._auxBG;
		L._auxKey = key;
		return L._auxBG = device.createBindGroup({ layout: bglAux, entries: [
			{ binding: 0, resource: p.createView() }, { binding: 1, resource: f.createView() },
			{ binding: 2, resource: ev }, { binding: 3, resource: es }] });
	}

	// ── テクスチャ搭載（textures.js の WebGPU 版）────────────────────────
	function texU32(data, w, h, fmt, comps) {
		const tex = device.createTexture({ size: [w, h], format: fmt, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
		device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: w * comps * 4, rowsPerImage: h }, [w, h]);
		return tex;
	}
	function uploadMetaTex(metaU32, edgeCount) {
		const h = Math.ceil(edgeCount / TEX_META_W);
		const pad = new Uint32Array(TEX_META_W * h * 4);
		pad.set(metaU32);
		return regBuf(texU32(pad, TEX_META_W, h, "rgba32uint", 4), metaU32);
	}
	function applyArtifacts(L, art) {
		const { gintData } = L;
		const { arcBuffer: ab, pointBuffer: pb } = gintData;
		dropTex(L.arcTex);
		L.arcTex = null;
		if (ab?.length) {
			const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
			const arcH = Math.ceil(arcU32.length / 2 / TEX_ARC_W);
			const arcPad = new Uint32Array(TEX_ARC_W * arcH * 2);
			arcPad.set(arcU32);
			L.arcTex = regBuf(texU32(arcPad, TEX_ARC_W, arcH, "rg32uint", 2), arcU32);
		}
		dropTex(L.metaTex);
		L.metaTex = null;
		L.totalEdges = art.base.edgeCount;
		L.polyEdges = art.base.polyEdgeCount;
		L.polyEdgeByFid = art.base.polyEdgeByFid;
		L.metaChunks = art.base.chunks;
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
		dropTex(L.metaTexB);
		L.metaTexB = null;
		L.totalEdgesB = 0; L.polyEdgesB = 0;
		if (art.boundary) {
			L.totalEdgesB = art.boundary.edgeCount;
			L.polyEdgesB = art.boundary.polyEdgeCount;
			L.metaTexB = uploadMetaTex(art.boundary.metaU32, art.boundary.edgeCount);
		}
		dropTex(L.ptTex); L.ptTex = null;
		dropTex(L.ptMetaTex); L.ptMetaTex = null;
		if (pb?.length) {
			const ptU32 = new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4);
			L.totalPoints = ptU32.length / 2;
			const ptH = Math.ceil(L.totalPoints / TEX_ARC_W);
			const ptPad = new Uint32Array(TEX_ARC_W * ptH * 2);
			ptPad.set(ptU32);
			L.ptTex = regBuf(texU32(ptPad, TEX_ARC_W, ptH, "rg32uint", 2), ptU32);
			const ptMetaRaw = gintData.point.subarray(0, L.totalPoints);
			const ptMetaPad = new Uint32Array(TEX_ARC_W * ptH);
			ptMetaPad.set(ptMetaRaw);
			L.ptMetaTex = regBuf(texU32(ptMetaPad, TEX_ARC_W, ptH, "r32uint", 1), ptMetaRaw);
		} else L.totalPoints = 0;
		if (L.lodTiers?.length) L.lodTiers.forEach(t => dropTex(t.tex));
		L.lodTiers = [];
		L.tiersDone = false;
	}
	function scheduleTierBuild(L, { weightHist = null } = {}) {
		const { gintData } = L;
		const ab = gintData?.arcBuffer;
		const gen = L.tierGen = (L.tierGen ?? 0) + 1;
		if (!ab?.length || L.totalEdges <= 200_000) { L.tiersDone = true; return; }
		let plan = null;
		const buildPlan = () => {
			const have = new Set((L.lodTiers ?? []).map(t => t.minW));
			const p = tierPlan(gintData, L.totalEdges, weightHist, have);
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
			const r = bakeTier(gintData, w, L.polyBboxByFid);
			if (r.edgeCount) {
				L.lodTiers.push({ minW: r.minW, edgeCount: r.edgeCount, chunks: r.chunks, tex: uploadMetaTex(r.metaU32, r.edgeCount) });
				L.lodTiers.sort((a, b) => a.minW - b.minW);
			}
			setTimeout(buildNext, 0);
		};
		setTimeout(buildNext, 0);
	}
	function deleteTextures(L) {
		for (const f of ["arcTex", "metaTex", "metaTexB", "ptTex", "ptMetaTex", "pivotTex"]) { dropTex(L[f]); L[f] = null; }
		if (L.lodTiers?.length) L.lodTiers.forEach(t => dropTex(t.tex));
		L.lodTiers = [];
		L.metaChunks = null;
		L.totalEdgesB = L.polyEdgesB = 0;
		L.pivotW = 0;
	}

	// ── fid スタイル表（idfill.js uploadFidStyle の WebGPU 版）──────────────
	function uploadFidStyle(L, table, count) {
		const u32 = table instanceof Uint32Array ? table : new Uint32Array(table);
		if (!count || u32.length < count * 4) { clearFidStyle(L); return; }
		const W = Math.min(4096, TEX_ARC_W), H = Math.ceil(count / W);
		if (L.fidStyleTex) L.fidStyleTex.destroy();
		const pad = new Uint32Array(W * H * 4);
		pad.set(u32.subarray(0, count * 4));
		L.fidStyleTex = texU32(pad, W, H, "rgba32uint", 4);
		L.fidStyleW = W; L._fidStyleH = H; L.fidStyleCount = count; L._fidStyleData = { u32, count };
	}
	function clearFidStyle(L) {
		if (L.fidStyleTex) L.fidStyleTex.destroy();
		L.fidStyleTex = null; L.fidStyleW = 0; L._fidStyleH = 0; L.fidStyleCount = 0; L._fidStyleData = null;
	}

	// ── 層状態（§10.1 第1ブロック＝層ごとに割る）とスロット束 ────────────────
	// SLOT_FIELDS＝スロット束が退避/復元する層のデータ・スタイル面（embed.js と同形＝ベイク済み GPU/台帳資産のキャッシュ）
	const SLOT_FIELDS = [
		"gintData", "arcTex", "metaTex", "metaTexB", "ptTex", "ptMetaTex", "pivotTex", "pivotW",
		"totalEdges", "totalPoints", "polyEdges", "totalEdgesB", "polyEdgesB",
		"fillOff", "lowFill", "tiersDone", "lodTiers", "metaChunks",
		"polyEdgeByFid", "polyBboxByFid", "outlineZoom", "minZoom", "maxZoom",
		"fidStyleTex", "fidStyleW", "_fidStyleH", "fidStyleCount", "_fidStyleData",
	];
	const emptySlot = () => ({ gintData: null, arcTex: null, metaTex: null, metaTexB: null, ptTex: null, ptMetaTex: null,
		pivotTex: null, pivotW: 0, totalEdges: 0, totalPoints: 0, polyEdges: 0, totalEdgesB: 0, polyEdgesB: 0,
		fillOff: false, lowFill: false, tiersDone: false, lodTiers: [], metaChunks: null,
		polyEdgeByFid: null, polyBboxByFid: null, outlineZoom: null, minZoom: null, maxZoom: null,
		fidStyleTex: null, fidStyleW: 0, _fidStyleH: 0, fidStyleCount: 0, _fidStyleData: null });
	const layers = [];       // 描画順（後の層が上）
	let act = null;          // カーソルを持つ層（§4.1 常に1層。既定＝最後に addLayer した層）
	const GF_LINE = 0, GF_FILL = 1, GF_LINE_B = 2, GF_FILL_B = 3;
	const GF_SLOT = 512;   // 案A: meshQ/meshP 追加で 64f 超過＝512B ストライド（dynamic offset は 256 倍数制約）
	function makeLayer() {
		const L = {
			...emptySlot(),
			id: null,   // 層の名（worker プロトコルの layer キー。既定層＝null＝従来メッセージと同形）
			order: 0,   // 重ね順（小さいほど下・同値は追加順）。トグル順に依らない決定的な z-order（§4 追記 2026-09-09）
			// スロット束・スタイル・表示（層ごと）
			slots: new Map(), activeKey: null, drawStyle: null, visible: true, stylesDirty: true,
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
			idRBuf: device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
		};
		L.frameBG = [0, GF_SLOT, GF_SLOT * 2, GF_SLOT * 3].map(off => device.createBindGroup({ layout: bglFrame, entries: [
			{ binding: 0, resource: { buffer: L.gfBuf, offset: off, size: GF_SLOT } },
			{ binding: 1, resource: { buffer: L.styleBuf } },
		] }));
		L.paramBG = [];
		for (let r = 0; r < 11; r++) L.paramBG.push(device.createBindGroup({ layout: bglParam, entries: [{ binding: 0, resource: { buffer: L.gpBuf, offset: r * GP_SLOT, size: 48 } }] }));
		return L;
	}

	const saveActive = (L) => {
		if (L.activeKey == null) return;
		const b = L.slots.get(L.activeKey) ?? {};
		for (const f of SLOT_FIELDS) b[f] = L[f];
		L.slots.set(L.activeKey, b);
	};
	const loadBundle = (L, b) => {
		for (const f of SLOT_FIELDS) L[f] = b[f];
		L.tierGen = (L.tierGen ?? 0) + 1;
		if (L === act) activeId = -1;
		L.lastDrawData = null;
		L._pfLineEdges = 0; L._pfTierW = -1;
	};
	const deleteBundleTextures = (b) => {
		for (const f of ["arcTex", "metaTex", "metaTexB", "ptTex", "ptMetaTex", "pivotTex", "fidStyleTex"])
			{ dropTex(b[f]); b[f] = null; }
		if (b.lodTiers?.length) b.lodTiers.forEach(t => dropTex(t.tex));
		b.lodTiers = [];
	};
	function setSlot(L, key) {
		if (key === L.activeKey) return;
		saveActive(L);
		loadBundle(L, L.slots.get(key) ?? emptySlot());
		L.activeKey = L.slots.has(key) ? key : null;
		if (L.activeKey != null && !L.tiersDone && L.totalEdges > 0) scheduleTierBuild(L);
		requestDraw?.();
	}
	function set(L, data, key) {
		key = key ?? "user";
		if (data) {
			saveActive(L);
			const old = L.slots.get(key);
			if (old && key !== L.activeKey) deleteBundleTextures(old);
			if (key === L.activeKey) deleteTextures(L);
			loadBundle(L, emptySlot());
			L.activeKey = key;
			L.gintData = {
				arcBuffer: data.arcBuffer ?? null,
				arcMeta: data.arcMeta ?? null,
				polyStream: data.polyStream?.length ? data.polyStream : null,
				lineStream: data.lineStream?.length ? data.lineStream : null,
				pointBuffer: data.pointBuffer?.length ? data.pointBuffer : null,
				point: data.point ?? null,
				polyCompBbox: data.polyCompBbox ?? null,
				fillMaxEdges: data.fillMaxEdges ?? null,   // 同期経路でも層別の塗り上限/低ズーム塗りを落とさない（gl/worker.js と同修理）
				lowFill:      data.lowFill      ?? false,
			};
			const art = bakeBase(L.gintData);
			applyArtifacts(L, art);
			scheduleTierBuild(L, { weightHist: art.weightHist });
			({ minZoom: L.minZoom, maxZoom: L.maxZoom } = checkZoomRange({
				arcMeta: L.gintData.arcMeta, minZoom: data.minZoom ?? null, maxZoom: data.maxZoom ?? null, precision: data.precision ?? 6,
			}));
			L.slots.set(key, {});
		} else if (key === L.activeKey) {
			deleteTextures(L);
			loadBundle(L, emptySlot());
			L.slots.delete(key);
			L.activeKey = null;
		} else {
			const b = L.slots.get(key);
			if (b) { deleteBundleTextures(b); L.slots.delete(key); }
		}
		if (L === act) activeId = -1;
		L.lastDrawData = null;
		requestDraw?.();
	}
	function setBaked(L, p, key) {
		key = key ?? "user";
		if (!p) return set(L, null, key);
		const prevKey = L.activeKey;
		saveActive(L);
		const old = L.slots.get(key);
		if (old && key !== L.activeKey) deleteBundleTextures(old);
		if (key === L.activeKey) deleteTextures(L);
		loadBundle(L, emptySlot());
		L.activeKey = key;
		L.gintData = p.gint;
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
		requestDraw?.();
	}
	function style(L, data) { L.drawStyle = data ?? null; L.stylesDirty = true; requestDraw?.(); }
	function setVisible(L, v) { L.visible = !!v; requestDraw?.(); }
	function paint(L, data) {
		if (data?.table && data.count > 0) uploadFidStyle(L, data.table, data.count);
		else clearFidStyle(L);
		L.idOverlapMode = !!data?.overlap;
		requestDraw?.();
	}

	// ── tier 選択・可視 run（passes.js の純JS部を逐語で携行）────────────────
	function pickLineTier(L, rank, baseTex, baseCount) {
		let nominal = null, finest = null;
		for (const t of L.lodTiers ?? []) {
			if (t.minW <= rank && (!nominal || t.edgeCount < nominal.edgeCount)) nominal = t;
			if (!finest || t.minW < finest.minW) finest = t;
		}
		const sel = nominal
			? { tex: nominal.tex, count: nominal.edgeCount, runs: visibleRuns(nominal.edgeCount, nominal.chunks), minW: nominal.minW }
			: { tex: baseTex, count: baseCount, runs: visibleRuns(baseCount, L.metaChunks), minW: 0 };
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
	function visibleRuns(totalCount, chunks) {
		const vb = V.lastViewBbox;
		if (!chunks?.length || !vb) return [[0, totalCount]];
		const mg = 10000;
		const vx0 = vb[0] - mg, vy0 = vb[1] - mg, vx1 = vb[2] + mg, vy1 = vb[3] + mg;
		const runs = [];
		let curStart = -1, curEnd = 0;
		for (const c of chunks) {
			const b = c.bbox;
			const vis = !(b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1);
			if (vis) { if (curStart < 0) curStart = c.start; curEnd = c.end; }
			else if (curStart >= 0) { runs.push([curStart, curEnd - curStart]); curStart = -1; }
		}
		if (curStart >= 0) runs.push([curStart, curEnd - curStart]);
		return runs;
	}

	// ── UBO 詰め物（CPU 側スクラッチはエンジン共有＝逐次処理ゆえ安全。書き先は層の buffer）──
	const gfAB = new ArrayBuffer(GF_SLOT * 4);
	const gfF = new Float32Array(gfAB), gfU = new Uint32Array(gfAB), gfI = new Int32Array(gfAB);
	function packGF(L, off, d, lodRank, noPivot = false) {
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
		const vb = V.lastViewBbox;
		if (vb) {
			gfU[o + 44] = Math.max(0, vb[0] - 10000); gfU[o + 45] = Math.max(0, vb[1] - 10000);
			gfU[o + 46] = Math.min(0xFFFFFFFF, vb[2] + 10000); gfU[o + 47] = Math.min(0xFFFFFFFF, vb[3] + 10000);
		} else { gfU[o + 44] = gfU[o + 45] = gfU[o + 46] = gfU[o + 47] = 0; }
		gfU[o + 48] = (!noPivot && L.pivotTex) ? 1 : 0;
		gfU[o + 49] = (!noPivot && L.pivotTex && vb) ? 1 : 0;
		gfU[o + 50] = L.pivotW || 1;
		gfU[o + 51] = L.fidStyleTex ? (L.fidStyleW || 1) : 0;
		gfF[o + 52] = dep?.logCoef ?? 0; gfF[o + 53] = dep?.fogFar ?? 1e9; gfF[o + 54] = dep?.elevScale ?? 0; gfF[o + 55] = dep?.hasElev ?? 0;
		const b = dep?.elevBounds;
		gfF[o + 56] = b?.[0] ?? 0; gfF[o + 57] = b?.[1] ?? 0; gfF[o + 58] = b?.[2] ?? 1; gfF[o + 59] = b?.[3] ?? 1;
		gfF[o + 60] = dep?.edgeFade ?? 0;   // elevP = (edgeFade, cos4φ0, sin4φ0, ell)＝予備3枠へ dβ 錨の残りとゲート
		gfF[o + 61] = ell ? Math.cos(4 * pr) : 0; gfF[o + 62] = ell ? Math.sin(4 * pr) : 0; gfF[o + 63] = ell ? 1 : 0;
		const mq = dep?.meshQ;   // 案A: 描画メッシュ面への量子化（無ければ G=0＝素の elevAt）
		gfF[o + 64] = mq?.[0] ?? 0; gfF[o + 65] = mq?.[1] ?? 0; gfF[o + 66] = mq?.[2] ?? 1; gfF[o + 67] = mq?.[3] ?? 1;
		gfF[o + 68] = dep?.meshG ?? 0; gfF[o + 69] = 0; gfF[o + 70] = 0; gfF[o + 71] = 0;
	}
	const gpAB = new ArrayBuffer(GP_SLOT * 11);
	const gpF = new Float32Array(gpAB), gpI = new Int32Array(gpAB);
	function packGP(role, { width = 0, widthAdd = 0, radius = 0, hidden = 0, activeId = -1, pass = 0, color = null } = {}) {
		const o = role * (GP_SLOT >> 2);
		gpF[o] = width; gpF[o + 1] = widthAdd; gpF[o + 2] = radius; gpF[o + 3] = hidden;
		gpI[o + 4] = activeId; gpI[o + 5] = pass; gpI[o + 6] = 0; gpI[o + 7] = 0;
		if (color) { gpF[o + 8] = color[0]; gpF[o + 9] = color[1]; gpF[o + 10] = color[2]; gpF[o + 11] = color[3]; }
		else { gpF[o + 8] = gpF[o + 9] = gpF[o + 10] = gpF[o + 11] = 0; }
	}
	const styleAB = new Float32Array(2048);
	function uploadStyles(L, data) {
		const st = data.styleTable ?? DEF_STYLE, da = data.dashTable ?? DEF_DASH;
		styleAB.set(st, 0);
		for (let i = 0; i < 256; i++) { styleAB[1024 + i * 4] = da[i * 2]; styleAB[1024 + i * 4 + 1] = da[i * 2 + 1]; }
		device.queue.writeBuffer(L.styleBuf, 0, styleAB);
		L.stylesDirty = false;
	}

	// ── 描画（embed.js draw ＋ passes.js renderCleanScene/drawHighlight の統合）──────
	let fboW = 0, fboH = 0, pickTex = null;
	function draw(cam, ctx) {
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
			clearTimeout(moveTimer); moveTimer = null; pendingMove = null;
			staticN = 0;
			if (activeId !== -1) { activeId = -1; postMessage({ action: "identify", featureId: null, layer: act?.id ?? null }); }
		} else {
			isDrawing = false;
			staticN = (staticN ?? 0) + 1;
		}
		lastMX = NaN; lastMY = NaN;
		for (const L of layers) drawLayer(L, cam, fr, ctx);   // layers は order 昇順を維持＝後ろの層が上（order 未指定＝追加順）
	}
	function mark(L, cam, path) {   // 計器（stats.dbg）＋直近フレームのリング（操作中に何が起きたかを事後に読む）
		L._dbg = { path, vis: L.visible, z: +(cam.zoom ?? 0).toFixed(2), t: Date.now() % 100000 };
		(L._dbgRing ??= []).push(`${path[0]}${L.visible ? "" : "!"}z${(cam.zoom ?? 0).toFixed(1)}w${L._pfTierW ?? "?"}e${((L._pfLineEdges ?? 0) / 1000) | 0}k`);
		if (L._dbgRing.length > 90) L._dbgRing.shift();
	}
	function drawLayer(L, cam, fr, ctx) {
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
		const data = { cam, ...(L.drawStyle || {}) };
		if (L._forceLowMove) data._forceLow = true;
		if (!zoomInRange(L, data)) { mark(L, cam, "range"); L._inRange = false; L.lastDrawData = null; L._pfLineEdges = 0; L._pfTierW = -1; return; }
		L._inRange = true;
		if (L.totalEdges === 0 && L.totalPoints === 0) { L.lastDrawData = null; L._pfLineEdges = 0; L._pfTierW = -1; return; }
		L._budgetSkipped = false;
		const drawData = computeDrawData(V, data);
		if (ctx && ctx.terrainDepth && !data.noDepth) drawData.depth = ctx;   // noDepth＝地形深度に参加しない（admin0 世界図＝gl/embed.js と同型）

		if (L.visible) renderScene(L, drawData, fr, ctx);
		mark(L, cam, L.visible ? "drew" : "invisible");
		L.lastDrawData = drawData;
		if (L === act && pickPending) { pickPending = false; drawn(); }
	}

	function renderScene(L, data, fr, ctx) {
		const dep = data.depth;
		const P = pipesFor(fr.samples || host.samples || 4, L.sbOn);   // 遷移時AA＝renderer のフレーム段数にセットごと追随
		// UBO を先に確定（queue.writeBuffer は submit 前に順序どおり適用される。書き先は層の buffer＝他層と衝突しない）
		packGF(L, GF_LINE * GF_SLOT, data, data.lodRank ?? 0);
		packGF(L, GF_FILL * GF_SLOT, data, 0);                     // 塗り stencil＝全密度（rank0）
		packGF(L, GF_LINE_B * GF_SLOT, data, data.lodRank ?? 0, true);   // 境界メタ線＝単一要・カリング無効
		packGF(L, GF_FILL_B * GF_SLOT, data, 0, true);                   // 境界メタ塗り＝同上
		device.queue.writeBuffer(L.gfBuf, 0, gfAB);
		if (L.stylesDirty) uploadStyles(L, data);

		// renderCleanScene の判定（逐語）
		const st = data.styleTable ?? DEF_STYLE;
		const zoomV = data.zoom ?? 99, oz = data.outlineZoom ?? L.outlineZoom ?? OUTLINE_ZOOM;   // スタイル側上書き（gl/passes.js と同型＝admin0 の境界メタ縮退切り）
		const lowZoom = zoomV < oz;
		const moving = isDrawing || (staticN ?? 99) < 4;
		const lowZoomEff = lowZoom || (moving && zoomV < oz + 1.5) || !!data._forceLow;
		if (!isDrawing && moving && !lowZoom && lowZoomEff) requestDraw?.();
		const hasPoly = (L.polyBboxByFid?.size ?? 0) > 0 && (!L.fillOff || L.lowFill);   // lowFill＝低ズーム帯の単色塗りは生かす（fillA フェードが z<oz+1.2 に閉じ込める）
		const fillA = data._forceLow ? st[3] * 0.8   // 安表現中＝フェード無効（内陸ビューでも面のシルエットを残す）
			: st[3] * 0.8 * Math.max(0, Math.min(1, ((oz + 1.2) - zoomV) / 1.2));
		const fc = data.fillColor ?? (hasPoly && (lowZoomEff || fillA > 0.004) ? [st[0], st[1], st[2], fillA] : DEF_FILL);
		const hasB = !!(L.metaTexB && L.polyEdgesB > 0);
		const stTex = hasB ? L.metaTexB : L.metaTex, stCount = hasB ? L.polyEdgesB : L.polyEdges;
		const doFill = fc[3] > 0 && stCount > 0 && L.arcTex
			&& !(data._forceLow && stCount > (data.moveBudget ?? 250_000) * 8);   // 安表現中の塗り予算（sync の canFill と同じ物差し）
		// コロプレス（paint 時）＝ID バッファ塗り。能力あり＝単色 stencil でなく idfill（優先）。基準メタ固定（fid 重み）
		const idFill = !data._forceLow && canUseIdFill(L) && ensureIdTex() && !!idResolveBGFor(L);   // 安い表現中は idfill（全密度扇）を止める
		// 線 tier 選択（passes.js と同判断）
		let lnSel = null;
		if (L.totalEdges > 0 && L.arcTex) {
			const finestT = L.lodTiers?.length ? L.lodTiers[0] : null;
			const lnB = data._forceLow ? !!(L.metaTexB && L.totalEdgesB > 0 && L.totalEdgesB <= (data.moveBudget ?? 250_000))   // 強制安表現＝境界一択・予算超は線なし（塗りシルエットのみ）
				: lowZoomEff && L.metaTexB && L.polyEdgesB > 0
				&& (finestT ? L.totalEdgesB <= finestT.edgeCount * 1.5 : L.totalEdgesB <= 600_000);
			lnSel = lnB
				? { tex: L.metaTexB, count: L.totalEdgesB, runs: null, minW: -2, boundary: true }
				: data._forceLow ? null   // 安表現中に境界が予算超＝線パスは出さない（フル tier へ落とさない）
				: { ...pickLineTier(L, data.lodRank ?? 0, L.metaTex, L.totalEdges), boundary: false };
		}
		if (!lnSel && data._forceLow) { L._pfLineEdges = 0; L._pfTierW = -4; }   // perf印: -4＝安表現で線パス抑止（塗りシルエットのみ）
		// GP スロット確定（カーソル＝アクティブ層のみ。§4.1）
		const aId = L === act ? activeId : -1;
		const lw = data.lineWidth ?? 1.0;
		packGP(ROLE.stencil, {});
		packGP(ROLE.fill, { color: fc });
		packGP(ROLE.line, { width: lw, activeId: aId, pass: 0 });
		packGP(ROLE.lineHidden, { width: lw, activeId: aId, pass: 0, hidden: 1 });
		packGP(ROLE.hilite, { width: lw + 2.0, widthAdd: 2.0, radius: data.hiliteWidth || 0, activeId: aId, pass: 1, color: data.hiliteColor });   // radius欄でホバー全幅(device px)を運ぶ＝指定時は shader が lw を上書き（overlay 町丁目線と一致）。hiliteColor＝ホバー線色（未指定＝素の線色を不透明）
		packGP(ROLE.maskStencil, { activeId: aId });
		packGP(ROLE.maskFill, { color: data.maskColor ?? DEF_MASK });
		packGP(ROLE.point, { radius: data.ptRadius ?? 1.5, activeId: -1 });
		packGP(ROLE.pointHi, { radius: data.ptRadius ?? 1.5, activeId: aId });
		device.queue.writeBuffer(L.gpBuf, 0, gpAB);

		const aux = auxGroup(L, ctx?.elevView, ctx?.elevSampler);
		// ① ID 蓄積パス（main パスより前・fr.enc の別 render pass）＝winding 和を rg16float へ。基準メタ・rank0・pivot 有効
		if (idFill) {
			idRCPU[0] = L.fidStyleW || 1; idRCPU[1] = L.fidStyleCount; idRCPU[2] = L.idOverlapMode ? 1 : 0; idRCPU[3] = 0;
			device.queue.writeBuffer(L.idRBuf, 0, idRCPU);
			const idPass = fr.enc.beginRenderPass({ timestampWrites: host.passTS?.("gint"), colorAttachments: [{ view: idTexView, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
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
			let pfEdges = 0;
			for (const [est, cnt] of (lnSel.runs ?? [[0, lnSel.count]])) {
				pfEdges += cnt;
				pass.draw(cnt * 6, 1, est * 6);
			}
			L._pfLineEdges = pfEdges; L._pfTierW = lnSel.minW ?? -1;
			if (dep && !isDrawing && pfEdges < 100_000) {
				pass.setPipeline(P.lineHidden);
				pass.setBindGroup(1, L.paramBG[ROLE.lineHidden]);
				for (const [est, cnt] of (lnSel.runs ?? [[0, lnSel.count]])) pass.draw(cnt * 6, 1, est * 6);
			}
		}
		// ── 点 ──
		if (L.totalPoints > 0 && L.ptTex && L.ptMetaTex) {
			pass.setPipeline(P.point);
			pass.setBindGroup(0, L.frameBG[GF_LINE]);
			pass.setBindGroup(1, L.paramBG[ROLE.point]);
			pass.setBindGroup(2, texBG(L.sbOn, L.ptTex, L.ptMetaTex));
			pass.draw(L.totalPoints * 6);
		}
		// ── ハイライト（activeId≥0＝毎フレーム inline。アクティブ層のみ。深度免除・ドレープのみ＝GL drawHighlight と同順）──
		if (aId !== -1 && (L.arcTex || L.ptTex)) {
			const range = L.polyEdgeByFid?.get(aId);
			const eStart = range?.[0] ?? null, eCount = range?.[1] ?? null;
			const hasRange = eStart != null && eCount > 0;
			if (L.totalEdges > 0 && L.metaTex) {
				pass.setPipeline(P.line);
				pass.setBindGroup(0, L.frameBG[GF_LINE]);
				pass.setBindGroup(1, L.paramBG[ROLE.hilite]);
				pass.setBindGroup(2, texBG(L.sbOn, L.arcTex, L.metaTex));
				if (hasRange) pass.draw(eCount * 6, 1, eStart * 6);
				else pass.draw(L.totalEdges * 6);
			}
			if (L.totalPoints > 0 && L.ptTex && L.ptMetaTex) {
				pass.setPipeline(P.point);
				pass.setBindGroup(1, L.paramBG[ROLE.pointHi]);
				pass.setBindGroup(2, texBG(L.sbOn, L.ptTex, L.ptMetaTex));
				pass.draw(L.totalPoints * 6);
			}
			const mc = data.maskColor ?? DEF_MASK;
			if (mc[3] > 0 && hasRange && L.metaTex) {
				pass.setPipeline(P.zero);   // stencil を 0 へ（mid-pass clear の代替）
				pass.setBindGroup(1, L.paramBG[ROLE.maskStencil]);
				pass.draw(3);
				pass.setPipeline(P.stencilFan);
				pass.setBindGroup(0, L.frameBG[GF_LINE]);   // GL は実 rank＋per-fid 扇要（bindPivot）＝lodSnap 込みの mask fan
				pass.setBindGroup(2, texBG(L.sbOn, L.arcTex, L.metaTex));
				pass.draw(eCount * 3, 1, eStart * 3);
				pass.setPipeline(P.coverEq);   // stencil==0＝地物の外を暗く
				pass.setBindGroup(1, L.paramBG[ROLE.maskFill]);
				pass.draw(3);
				pass.setPipeline(P.zero);   // mask winding を後始末（stencil load 化＝後続レイヤへ持ち越さない）
				pass.draw(3);
			}
		}
		pass.end();
	}
	const idRCPU = new Uint32Array(4);

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
		packGP(ROLE.pickPoint, { radius: Math.max(data.ptRadius ?? 1.5, pickMargin * 0.5) });
		device.queue.writeBuffer(L.gpBuf, ROLE.pickLine * GP_SLOT, gpAB, ROLE.pickLine * GP_SLOT, GP_SLOT * 2);
		const aux = auxGroup(L, null, null);
		const enc = device.createCommandEncoder();
		const pass = enc.beginRenderPass({
			colorAttachments: [{ view: pickTex.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
		});
		pass.setBindGroup(0, L.frameBG[GF_LINE]);
		pass.setBindGroup(3, aux);
		if (L.totalEdges > 0 && L.metaTex && L.arcTex) {
			const pkSel = pickLineTier(L, data.lodRank ?? 0, L.metaTex, L.totalEdges);
			pass.setPipeline(L.sbOn ? pickLinePipeSB : pickLinePipe);
			pass.setBindGroup(1, L.paramBG[ROLE.pickLine]);
			pass.setBindGroup(2, texBG(L.sbOn, L.arcTex, pkSel.tex));
			for (const [est, cnt] of (pkSel.runs ?? [[0, pkSel.count]])) pass.draw(cnt * 6, 1, est * 6);
		}
		if (L.totalPoints > 0 && L.ptTex && L.ptMetaTex) {
			pass.setPipeline(L.sbOn ? pickPointPipeSB : pickPointPipe);
			pass.setBindGroup(1, L.paramBG[ROLE.pickPoint]);
			pass.setBindGroup(2, texBG(L.sbOn, L.ptTex, L.ptMetaTex));
			pass.draw(L.totalPoints * 6);
		}
		pass.end();
		device.queue.submit([enc.finish()]);
		L._pfPickMs = (L._pfPickMs ?? 0) + (performance.now() - t0);
		if (pendingMove) { const m = pendingMove; pendingMove = null; doIdentify(m); }
	}

	// ── 識別（identify.js の WebGPU 版＝copyTextureToBuffer + mapAsync 非同期読み）────
	let pickBuf = null, prInFlight = null;
	function doIdentify(data) {
		if (data.x === lastMX && data.y === lastMY) return;
		lastMX = data.x; lastMY = data.y;
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
		setTimeout(() => pickBuf.mapAsync(GPUMapMode.READ).then(() => {
			const px = new Uint8Array(pickBuf.getMappedRange(0, 4)).slice();
			pickBuf.unmap();
			const pr = prInFlight; prInFlight = null;
			if (!pr) return;
			finishIdentify(px, pr.data);
			if (pr.next) { lastMX = NaN; doIdentify(pr.next.data); }
		}).catch(() => { prInFlight = null; }), 0);   // destroy 中の map 失敗は握る
	}
	function finishIdentify(px, data) {
		const L = act;
		if (!L) return;
		const fid1 = px[0] | (px[1] << 8) | (px[2] << 16);
		let featureId = fid1 === 0 ? null : fid1 - 1;
		if (fid1 === 0 && L.gintData?.polyStream && V.cam) {
			const geo = unproject(V.cam, data.x * V.dpr, data.y * V.dpr);
			if (geo) {
				const SE = 1e7;
				featureId = findPolygon(
					L.gintData.arcBuffer, L.gintData.arcMeta, L.gintData.polyStream,
					Math.round((geo[0] + 180) * SE), Math.round((geo[1] + 90) * SE),
					L.polyBboxByFid, V.lastViewBbox,
				);
			}
		}
		const newId = featureId ?? -1;
		if (newId === activeId) return;
		activeId = newId;
		postMessage({ action: "identify", featureId: featureId ?? null, x: data.x, y: data.y, layer: L.id });
		requestDraw?.();
	}
	function move(data) {
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
		clearTimeout(moveTimer); moveTimer = null;
		pendingMove = null;
		if (activeId === -1) return;
		activeId = -1;
		postMessage({ action: "identify", featureId: null, layer: act?.id ?? null });
		requestDraw?.();
	}
	function click() {
		if (activeId === -1) return;
		const geo = V.cam ? unproject(V.cam, lastMX * V.dpr, lastMY * V.dpr) : null;
		postMessage({ action: "click", featureId: activeId, x: lastMX, y: lastMY, lng: geo?.[0] ?? null, lat: geo?.[1] ?? null, layer: act?.id ?? null });
	}
	function disposeLayer(L) {
		saveActive(L);
		for (const b of L.slots.values()) deleteBundleTextures(b);
		L.slots.clear(); L.activeKey = null;
		deleteTextures(L);
		clearFidStyle(L);
		L.gfBuf.destroy(); L.gpBuf.destroy(); L.styleBuf.destroy(); L.idRBuf.destroy();
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
		dummyU32.destroy(); dummyF32.destroy();
	}
	function statsFor(L) {
		return { drawn: L._pfDrawn ?? 0, fbo: L._pfFbo ?? 0, pickMs: L._pfPickMs ?? 0, sb: SB ? (L.sbOn ? 1 : 0) : -1,
			rank: L.lastDrawData?.lodRank ?? -1, tierW: L._pfTierW ?? -1, edges: L._pfLineEdges ?? 0, dbg: L._dbg ?? null, ring: (L._dbgRing ?? []).slice(-40).join(" "),
			style: L.drawStyle ? { oz: L.drawStyle.outlineZoom, mb: L.drawStyle.moveBudget, nd: L.drawStyle.noDepth, lw: L.drawStyle.lineWidth } : null,
			tiers: L.lodTiers?.length ?? 0, tiersDone: !!L.tiersDone, total: L.totalEdges,
			runs: L._pfRuns ?? -1, chunks: L._pfChunks ?? -1, vb: V.lastViewBbox };
	}
	// 層ハンドル（§4 addGint の土台＝データ・スタイル面の動詞を層に束ねる。カーソルはエンジン＝activate で移す）
	function layerHandle(L) {
		return {
			set: (d, k) => set(L, d, k), setSlot: k => setSlot(L, k), setBaked: (p, k) => setBaked(L, p, k),
			style: d => style(L, d), setVisible: v => setVisible(L, v), paint: d => paint(L, d),
			stats: () => statsFor(L),
			activate: () => { if (act !== L) { act = L; activeId = -1; } },
			remove: () => {
				const i = layers.indexOf(L);
				if (i < 0) return;
				layers.splice(i, 1);
				disposeLayer(L);
				if (act === L) { act = layers.length ? layers[layers.length - 1] : null; activeId = -1; }
				requestDraw?.();
			},
		};
	}
	let orderSeq = 0;
	function addLayer({ id = null, order = null } = {}) {
		const L = makeLayer();
		L.id = id;
		L.order = order ?? ++orderSeq;   // 既定＝追加順（従来と同じ重なり）。指定＝トグル順に依らない決定的な重ね順
		const at = layers.findIndex(x => x.order > L.order);   // 安定挿入（同 order は追加順を保つ）
		layers.splice(at < 0 ? layers.length : at, 0, L);
		act = L; activeId = -1;   // 既定のアクティブ＝最後に足した層（§4.1「今載せたデータを見たい」）
		return layerHandle(L);
	}

	// ── 公開面：既定層への facade（従来 API と同形＝renderworker 無改造）＋ addLayer（多層の新しい口）──
	const L0h = addLayer();
	return {
		set: L0h.set, setSlot: L0h.setSlot, setBaked: L0h.setBaked,
		style: L0h.style, setVisible: L0h.setVisible, paint: L0h.paint, stats: L0h.stats, activate: L0h.activate,
		draw, drawn, move, leave, click, dispose,
		addLayer,
	};
}
