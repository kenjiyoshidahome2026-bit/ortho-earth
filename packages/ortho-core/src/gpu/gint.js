// gint WebGPU（Phase 3）＝gl/gint/{embed,passes,textures,fbo,identify,idfill}.js の臓器移植。
// 公開面は createGintLayer と同形 { set, setSlot, setBaked, style, setVisible, paint, draw, drawn, move, leave, click, dispose, stats }。
// 共有する純CPU臓器（無改造）：state.js の s（単一バックエンド前提の singleton）・drawdata.js（cam→mvp/RTE錨/LOD rank/視野bbox）・
// bake.js（メタ/境界/pivot/tier のベイク）・utility.js checkZoomRange・geopbf findPolygon（JSフォールバック識別）。
// GL との構造差：
//  ・renderer の frame（開いたエンコーダ＋MSAA color/depth-stencil）に自分の render pass を足す＝1canvas統合の WebGPU 形。
//    blend/stencil はパイプライン焼き込み＝GL の「状態切替と退避復元」の踊りが構造ごと消える。
//  ・stencil はパス先頭 stencilLoadOp:"clear"＋中間クリアは「フルスクリーン replace(0) 描き」（mid-pass clear が無いため）。
//  ・picking は非MSAA rgba8 テクスチャへ別パス→copyTextureToBuffer＋mapAsync（GL の PBO+fence 非同期読みと同族）。
//  ・idfill（コロプレスIDバッファ塗り）は未移植＝paint は線スタイル（fid表）だけ効き、塗りは単色 stencil へフォールバック。
import { s, DEF_STYLE, DEF_DASH, DEF_FILL, DEF_MASK, MOVE_THROTTLE_MS } from "../gl/gint/state.js";
import { computeDrawData, zoomInRange } from "../gl/gint/drawdata.js";
import { checkZoomRange } from "../gl/gint/utility.js";
import { bakeBase, bakeTier, tierPlan } from "../gl/gint/bake.js";
import { findPolygon } from "geopbf/identify";
import { unproject, betaOf, ellipsoidOn } from "../camera.js";
import { GINT_LINE_WGSL, GINT_STENCIL_WGSL, GINT_POINT_WGSL, GINT_IDRESOLVE_WGSL } from "./gintwgsl.js";

const OUTLINE_ZOOM = 13;   // 既定の切替z（passes.js と同値）
const GP_SLOT = 256;
const ROLE = { stencil: 0, fill: 1, line: 2, lineHidden: 3, hilite: 4, maskStencil: 5, maskFill: 6, point: 7, pointHi: 8, pickLine: 9, pickPoint: 10 };

export function createGintLayerGPU(host, { requestDraw } = {}) {
	const { device, format } = host;   // host＝createRendererGPU（frameInfo() で開いたフレームの的を貸す）
	s.embedded = true;
	s.requestDraw = requestDraw ?? null;
	s.gl = null;   // GL は不在（識別の readPixels 等が誤って走らないよう明示）

	// ── パイプライン ─────────────────────────────────────────────
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
	const layout = device.createPipelineLayout({ bindGroupLayouts: [bglFrame, bglParam, bglTex2, bglAux] });
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
	// gint は straight alpha（GL blendFuncSeparate(SRC_ALPHA, 1-SA, ONE, 1-SA) と同じ）
	const SBLEND = {
		color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
		alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
	};
	const DS = "depth24plus-stencil8";   // renderer と共有する深度・ステンシル
	const keepDS = { format: DS, depthWriteEnabled: false, depthCompare: "always" };
	const pipe = (mod, vs, fs, { ds = keepDS, blend = SBLEND, writeMask, samples = host.samples || 4, fmt = format } = {}) =>   // 既定＝renderer の MSAA 段数（?msaa=0＝1x に追随）
		device.createRenderPipeline({
			layout,
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
	const stencilFanPipe = pipe(stencilMod, "vsStencil", "fsNull", { ds: stFan, blend: undefined, writeMask: 0 });
	// VS_STENCIL_MASK 系は GL 側でも現行パスで未使用（drawHighlight の mask fan は stencilProgram＝レンジ描画）＝パイプライン化しない
	const coverPipe = pipe(stencilMod, "vsFull", "fsFill", { ds: stCoverNE });
	const coverEqPipe = pipe(stencilMod, "vsFull", "fsFill", { ds: stCoverEQ });
	const zeroPipe = pipe(stencilMod, "vsFull", "fsNull", { ds: stZero, blend: undefined, writeMask: 0 });
	const occludePipe = pipe(stencilMod, "vsFull", "fsNull", { ds: stOcc, blend: undefined, writeMask: 0 });   // 建物 bit7→winding 消し込み
	const linePipe = pipe(lineMod, "vsRender", "fsRender");
	const lineTestPipe = pipe(lineMod, "vsRender", "fsRender", { ds: { ...keepDS, depthCompare: "less-equal" } });
	const lineHiddenPipe = pipe(lineMod, "vsRender", "fsRender", { ds: { ...keepDS, depthCompare: "greater" } });
	const pointPipe = pipe(pointMod, "vsPoint", "fsPoint");
	const pickLinePipe = pipe(lineMod, "vsPickLine", "fsPick", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm" });
	const pickPointPipe = pipe(pointMod, "vsPickPoint", "fsPickPoint", { ds: null, blend: undefined, samples: 1, fmt: "rgba8unorm" });
	// コロプレス ID 塗り（idfill.js）：① winding 和を ID テクスチャへ加算蓄積（fan 幾何・単一サンプル・深度なし）
	// ② 解決＝ID 画素→fid→スタイル表→色を main パスへ。
	// ★蓄積は fid+1 の winding 和＝市区町村1919個では fid+1 最大1920＋加算途中和が半精度(rg16float)の整数正確域
	//   (2048)を超えて精度崩壊し塗りに穴が出る（境界線は無傷なのに塗りだけ欠ける・2026-08-12実機で判明）。
	//   float32-blendable があれば rg32float（整数1600万まで正確）で根治。無ければ rg16float へ縮退（穴リスク残・
	//   ?gl2=1 で EXT_float_blend の RG32F 経路へ逃げられる）。GL 経路の RG32F/RG16F 選択と同じ判断。
	const canIdF32 = !!device.features?.has?.("float32-blendable");
	const ID_MAX_FID = canIdF32 ? (1 << 20) : 2047, ID_FMT = canIdF32 ? "rg32float" : "rg16float";
	if (!canIdF32) console.warn("[gint] float32-blendable 無し＝idfill は rg16float（大fid市区町村コロプレスで塗り穴の恐れ）");
	const idAccumPipe = device.createRenderPipeline({
		layout, vertex: { module: stencilMod, entryPoint: "vsId" },
		fragment: { module: stencilMod, entryPoint: "fsId", targets: [{ format: ID_FMT, blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } } }] },
		primitive: { topology: "triangle-list" }, multisample: { count: 1 },
	});
	const idResolveMod = mkMod(GINT_IDRESOLVE_WGSL, "idresolve");
	const bglIdResolve = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },   // idTex rg16float
		{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "uint" } },                 // fidTex RGBA32UI
		{ binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: {} },                                      // R uniform
	] });
	const mkIdResolve = ds => device.createRenderPipeline({
		layout: device.createPipelineLayout({ bindGroupLayouts: [bglIdResolve] }),
		vertex: { module: idResolveMod, entryPoint: "vs" },
		fragment: { module: idResolveMod, entryPoint: "fs", targets: [{ format, blend: SBLEND }] },
		primitive: { topology: "triangle-list" }, depthStencil: ds, multisample: { count: host.samples || 4 },   // main パスへ描く＝renderer の段数に追随（?msaa=0）
	});
	const idResolvePipe = mkIdResolve(keepDS);
	// ドレープ塗り時＝建物 bit7 が立つ画素をスキップ（ref 0・equal・readMask 0x80＝(v&0x80)==0 のみ塗る）
	const idResolveOccPipe = mkIdResolve({ ...keepDS, stencilFront: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilBack: { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" }, stencilReadMask: 0x80, stencilWriteMask: 0 });

	// ── UBO（GF 4スロット＝(rank, rank0)×(pivot有効, 境界メタ=単一要・カリング無効)・GP 役割別・style表）──
	// 境界メタは「多数 fid の arc 寄せ集め」＝per-fid 扇要では閉ループが閉じず巻き数が漏れる＝GL 版
	// bindPivotBoundary（has_pivot=0/use_vbb=0）の写し。スロット：0=線(rank,pivot) 1=塗り(rank0,pivot)
	// 2=線境界(rank,無効) 3=塗り境界(rank0,無効)。
	const GF_LINE = 0, GF_FILL = 1, GF_LINE_B = 2, GF_FILL_B = 3;
	const gfBuf = device.createBuffer({ size: 1024, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const gpBuf = device.createBuffer({ size: GP_SLOT * 11, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const styleBuf = device.createBuffer({ size: 8192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const frameBG = [0, 256, 512, 768].map(off => device.createBindGroup({ layout: bglFrame, entries: [
		{ binding: 0, resource: { buffer: gfBuf, offset: off, size: 256 } },
		{ binding: 1, resource: { buffer: styleBuf } },
	] }));
	const paramBG = [];
	for (let r = 0; r < 11; r++) paramBG.push(device.createBindGroup({ layout: bglParam, entries: [{ binding: 0, resource: { buffer: gpBuf, offset: r * GP_SLOT, size: 48 } }] }));
	// ダミー（未搭載スロットの束縛穴埋め＝layout は常に4テクスチャを要求する）
	const dummyU32 = device.createTexture({ size: [1, 1], format: "r32uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummyF32 = device.createTexture({ size: [1, 1], format: "r16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummySamp = device.createSampler({ magFilter: "linear", minFilter: "linear" });
	// idfill：ID テクスチャ（rg16float・canvas 同寸・単一サンプル）＋解決 uniform（fid_w,count,overlap）＋bind group。
	let idTex = null, idTexView = null, idW = 0, idH = 0, idResolveBG = null, idResolveFid = null;
	const idRBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const idRCPU = new Uint32Array(4);
	function ensureIdTex() {
		if (idTex && idW === s.width && idH === s.height) { if (idResolveFid !== s.fidStyleTex) rebuildIdResolveBG(); return !!idResolveBG; }
		if (idTex) idTex.destroy();
		idTex = device.createTexture({ size: [s.width, s.height], format: ID_FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
		idTexView = idTex.createView(); idW = s.width; idH = s.height;
		rebuildIdResolveBG();
		return !!idResolveBG;
	}
	function rebuildIdResolveBG() {
		idResolveFid = s.fidStyleTex;
		idResolveBG = s.fidStyleTex ? device.createBindGroup({ layout: bglIdResolve, entries: [
			{ binding: 0, resource: idTexView }, { binding: 1, resource: s.fidStyleTex.createView() }, { binding: 2, resource: { buffer: idRBuf } }] }) : null;
	}
	// コロプレス塗りが使えるか（idfill.js canUseIdFill）：paint(fid表)あり・ポリゴンあり・fillOff でない・fid が rg16float 上限内。
	function canUseIdFill() { return !!s.fidStyleTex && s.polyEdges > 0 && !s.fillOff && !!s.arcTex && s.fidStyleCount <= ID_MAX_FID; }

	// group(2)＝(arc|pt, meta|ptMeta) の bind group キャッシュ（テクスチャ差し替えで自然無効化）
	const texBGs = new WeakMap();
	const texBG = (a, b) => {
		let m = texBGs.get(a); if (!m) texBGs.set(a, m = new WeakMap());
		let bg = m.get(b);
		if (!bg) m.set(b, bg = device.createBindGroup({ layout: bglTex2, entries: [
			{ binding: 0, resource: a.createView() }, { binding: 1, resource: b.createView() }] }));
		return bg;
	};
	// group(3)＝pivot/fidStyle/標高（何かが差し替わった時だけ作り直す）
	let auxBG = null, auxKey = null;
	function auxGroup(elevView, elevSamp) {
		const p = s.pivotTex || dummyU32, f = s.fidStyleTex || dummyU32;
		const ev = elevView || dummyF32.createView(), es = elevSamp || dummySamp;
		const key = [p, f, elevView || dummyF32, es];
		if (auxBG && auxKey && auxKey.every((v, i) => v === key[i])) return auxBG;
		auxKey = key;
		return auxBG = device.createBindGroup({ layout: bglAux, entries: [
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
		const h = Math.ceil(edgeCount / s.TEX_META_W);
		const pad = new Uint32Array(s.TEX_META_W * h * 4);
		pad.set(metaU32);
		return texU32(pad, s.TEX_META_W, h, "rgba32uint", 4);
	}
	function applyArtifacts(art) {
		const { gintData } = s;
		const { arcBuffer: ab, pointBuffer: pb } = gintData;
		if (s.arcTex) s.arcTex.destroy();
		s.arcTex = null;
		if (ab?.length) {
			const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
			const arcH = Math.ceil(arcU32.length / 2 / s.TEX_ARC_W);
			const arcPad = new Uint32Array(s.TEX_ARC_W * arcH * 2);
			arcPad.set(arcU32);
			s.arcTex = texU32(arcPad, s.TEX_ARC_W, arcH, "rg32uint", 2);
		}
		if (s.metaTex) s.metaTex.destroy();
		s.metaTex = null;
		s.totalEdges = art.base.edgeCount;
		s.polyEdges = art.base.polyEdgeCount;
		s.polyEdgeByFid = art.base.polyEdgeByFid;
		s.metaChunks = art.base.chunks;
		s.polyBboxByFid = art.polyBboxByFid;
		s.outlineZoom = art.outlineZoom;
		s.fillOff = art.fillOff;
		console.debug("[gint/gpu] edges=%d chunks=%d", s.totalEdges, s.metaChunks?.length ?? 0);
		if (s.totalEdges > 0) s.metaTex = uploadMetaTex(art.base.metaU32, s.totalEdges);
		if (s.pivotTex) { s.pivotTex.destroy(); s.pivotTex = null; }
		s.pivotW = 0;
		if (art.pivot && art.pivot.w <= s.TEX_ARC_W) {
			s.pivotTex = texU32(art.pivot.px, art.pivot.w, art.pivot.h, "rgba32uint", 4);
			s.pivotW = art.pivot.w;
		}
		if (s.metaTexB) s.metaTexB.destroy();
		s.metaTexB = null;
		s.totalEdgesB = 0; s.polyEdgesB = 0;
		if (art.boundary) {
			s.totalEdgesB = art.boundary.edgeCount;
			s.polyEdgesB = art.boundary.polyEdgeCount;
			s.metaTexB = uploadMetaTex(art.boundary.metaU32, art.boundary.edgeCount);
		}
		if (s.ptTex) { s.ptTex.destroy(); s.ptTex = null; }
		if (s.ptMetaTex) { s.ptMetaTex.destroy(); s.ptMetaTex = null; }
		if (pb?.length) {
			const ptU32 = new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4);
			s.totalPoints = ptU32.length / 2;
			const ptH = Math.ceil(s.totalPoints / s.TEX_ARC_W);
			const ptPad = new Uint32Array(s.TEX_ARC_W * ptH * 2);
			ptPad.set(ptU32);
			s.ptTex = texU32(ptPad, s.TEX_ARC_W, ptH, "rg32uint", 2);
			const ptMetaPad = new Uint32Array(s.TEX_ARC_W * ptH);
			ptMetaPad.set(gintData.point.subarray(0, s.totalPoints));
			s.ptMetaTex = texU32(ptMetaPad, s.TEX_ARC_W, ptH, "r32uint", 1);
		} else s.totalPoints = 0;
		if (s.lodTiers?.length) s.lodTiers.forEach(t => t.tex.destroy());
		s.lodTiers = [];
		s.tiersDone = false;
	}
	function scheduleTierBuild({ weightHist = null } = {}) {
		const { gintData } = s;
		const ab = gintData?.arcBuffer;
		const gen = s.tierGen = (s.tierGen ?? 0) + 1;
		if (!ab?.length || s.totalEdges <= 200_000) { s.tiersDone = true; return; }
		let plan = null;
		const buildPlan = () => {
			const have = new Set((s.lodTiers ?? []).map(t => t.minW));
			const p = tierPlan(gintData, s.totalEdges, weightHist, have);
			const rank = s.lastDrawData?.lodRank ?? 0;
			const usable = p.filter(w => w <= rank);
			const first = usable.length ? Math.max(...usable) : null;
			return [...(first != null ? [first] : []), ...p.filter(w => w !== first).reverse()];
		};
		s.tiersDone = false;
		const buildNext = () => {
			if (gen !== s.tierGen || s.gintData?.arcBuffer !== ab) return;
			if (s._isDrawing) { setTimeout(buildNext, 120); return; }
			plan ??= buildPlan();
			const w = plan.shift();
			if (w == null) {
				s.tiersDone = true;
				postMessage({ action: "tiers", tiers: s.lodTiers.map(t => ({ minW: t.minW, edgeCount: t.edgeCount })) });
				s.requestDraw?.();
				return;
			}
			const r = bakeTier(gintData, w, s.polyBboxByFid);
			if (r.edgeCount) {
				s.lodTiers.push({ minW: r.minW, edgeCount: r.edgeCount, chunks: r.chunks, tex: uploadMetaTex(r.metaU32, r.edgeCount) });
				s.lodTiers.sort((a, b) => a.minW - b.minW);
			}
			setTimeout(buildNext, 0);
		};
		setTimeout(buildNext, 0);
	}
	function deleteTextures() {
		for (const f of ["arcTex", "metaTex", "metaTexB", "ptTex", "ptMetaTex", "pivotTex"]) if (s[f]) { s[f].destroy(); s[f] = null; }
		if (s.lodTiers?.length) s.lodTiers.forEach(t => t.tex.destroy());
		s.lodTiers = [];
		s.metaChunks = null;
		s.totalEdgesB = s.polyEdgesB = 0;
		s.pivotW = 0;
	}

	// ── fid スタイル表（idfill.js uploadFidStyle の WebGPU 版＝線スタイルのみ。ID塗りは未移植）──
	function uploadFidStyle(table, count) {
		const u32 = table instanceof Uint32Array ? table : new Uint32Array(table);
		if (!count || u32.length < count * 4) { clearFidStyle(); return; }
		const W = Math.min(4096, s.TEX_ARC_W), H = Math.ceil(count / W);
		if (s.fidStyleTex) s.fidStyleTex.destroy();
		const pad = new Uint32Array(W * H * 4);
		pad.set(u32.subarray(0, count * 4));
		s.fidStyleTex = texU32(pad, W, H, "rgba32uint", 4);
		s.fidStyleW = W; s._fidStyleH = H; s.fidStyleCount = count; s._fidStyleData = { u32, count };
	}
	function clearFidStyle() {
		if (s.fidStyleTex) s.fidStyleTex.destroy();
		s.fidStyleTex = null; s.fidStyleW = 0; s._fidStyleH = 0; s.fidStyleCount = 0; s._fidStyleData = null;
	}

	// ── スロット束（embed.js と同形＝ベイク済み GPU/台帳資産のキャッシュ）────────
	const SLOT_FIELDS = [
		"gintData", "arcTex", "metaTex", "metaTexB", "ptTex", "ptMetaTex", "pivotTex", "pivotW",
		"totalEdges", "totalPoints", "polyEdges", "totalEdgesB", "polyEdgesB",
		"fillOff", "tiersDone", "lodTiers", "metaChunks",
		"polyEdgeByFid", "polyBboxByFid", "outlineZoom", "minZoom", "maxZoom",
		"fidStyleTex", "fidStyleW", "_fidStyleH", "fidStyleCount", "_fidStyleData",
	];
	const emptySlot = () => ({ gintData: null, arcTex: null, metaTex: null, metaTexB: null, ptTex: null, ptMetaTex: null,
		pivotTex: null, pivotW: 0, totalEdges: 0, totalPoints: 0, polyEdges: 0, totalEdgesB: 0, polyEdgesB: 0,
		fillOff: false, tiersDone: false, lodTiers: [], metaChunks: null,
		polyEdgeByFid: null, polyBboxByFid: null, outlineZoom: null, minZoom: null, maxZoom: null,
		fidStyleTex: null, fidStyleW: 0, _fidStyleH: 0, fidStyleCount: 0, _fidStyleData: null });
	const slots = new Map();
	let activeKey = null;
	let drawStyle = null;
	let visible = true;
	const saveActive = () => {
		if (activeKey == null) return;
		const b = slots.get(activeKey) ?? {};
		for (const f of SLOT_FIELDS) b[f] = s[f];
		slots.set(activeKey, b);
	};
	const loadBundle = (b) => {
		for (const f of SLOT_FIELDS) s[f] = b[f];
		s.tierGen = (s.tierGen ?? 0) + 1;
		s.activeId = -1; s.lastDrawData = null;
		s._pfLineEdges = 0; s._pfTierW = -1;
	};
	const deleteBundleTextures = (b) => {
		for (const f of ["arcTex", "metaTex", "metaTexB", "ptTex", "ptMetaTex", "pivotTex", "fidStyleTex"])
			if (b[f]) { b[f].destroy(); b[f] = null; }
		if (b.lodTiers?.length) b.lodTiers.forEach(t => t.tex.destroy());
		b.lodTiers = [];
	};
	function setSlot(key) {
		if (key === activeKey) return;
		saveActive();
		loadBundle(slots.get(key) ?? emptySlot());
		activeKey = slots.has(key) ? key : null;
		if (activeKey != null && !s.tiersDone && s.totalEdges > 0) scheduleTierBuild();
		s.requestDraw?.();
	}
	function set(data, key) {
		key = key ?? "user";
		if (data) {
			saveActive();
			const old = slots.get(key);
			if (old && key !== activeKey) deleteBundleTextures(old);
			if (key === activeKey) deleteTextures();
			loadBundle(emptySlot());
			activeKey = key;
			s.gintData = {
				arcBuffer: data.arcBuffer ?? null,
				arcMeta: data.arcMeta ?? null,
				polyStream: data.polyStream?.length ? data.polyStream : null,
				lineStream: data.lineStream?.length ? data.lineStream : null,
				pointBuffer: data.pointBuffer?.length ? data.pointBuffer : null,
				point: data.point ?? null,
				polyCompBbox: data.polyCompBbox ?? null,
			};
			const art = bakeBase(s.gintData);
			applyArtifacts(art);
			scheduleTierBuild({ weightHist: art.weightHist });
			({ minZoom: s.minZoom, maxZoom: s.maxZoom } = checkZoomRange({
				arcMeta: s.gintData.arcMeta, minZoom: data.minZoom ?? null, maxZoom: data.maxZoom ?? null, precision: data.precision ?? 6,
			}));
			slots.set(key, {});
		} else if (key === activeKey) {
			deleteTextures();
			loadBundle(emptySlot());
			slots.delete(key);
			activeKey = null;
		} else {
			const b = slots.get(key);
			if (b) { deleteBundleTextures(b); slots.delete(key); }
		}
		s.activeId = -1; s.lastDrawData = null;
		s.requestDraw?.();
	}
	function setBaked(p, key) {
		key = key ?? "user";
		if (!p) return set(null, key);
		const prevKey = activeKey;
		saveActive();
		const old = slots.get(key);
		if (old && key !== activeKey) deleteBundleTextures(old);
		if (key === activeKey) deleteTextures();
		loadBundle(emptySlot());
		activeKey = key;
		s.gintData = p.gint;
		applyArtifacts(p.artifacts);
		for (const t of p.tiers ?? []) {
			if (t?.edgeCount) {
				s.lodTiers.push({ minW: t.minW, edgeCount: t.edgeCount, chunks: t.chunks, tex: uploadMetaTex(t.metaU32, t.edgeCount) });
			}
		}
		s.lodTiers.sort((a, b) => a.minW - b.minW);
		s.tiersDone = true;
		postMessage({ action: "tiers", tiers: s.lodTiers.map(t => ({ minW: t.minW, edgeCount: t.edgeCount })) });
		({ minZoom: s.minZoom, maxZoom: s.maxZoom } = checkZoomRange({
			arcMeta: s.gintData.arcMeta, minZoom: p.minZoom ?? null, maxZoom: p.maxZoom ?? null, precision: p.precision ?? 6,
		}));
		slots.set(key, {});
		s.activeId = -1; s.lastDrawData = null;
		if (prevKey !== key) setSlot(prevKey);
		s.requestDraw?.();
	}
	function style(data) { drawStyle = data ?? null; stylesDirty = true; s.requestDraw?.(); }
	function setVisible(v) { visible = !!v; s.requestDraw?.(); }
	function paint(data) {
		if (data?.table && data.count > 0) uploadFidStyle(data.table, data.count);
		else clearFidStyle();
		s.idOverlapMode = !!data?.overlap;
		s.requestDraw?.();
	}

	// ── tier 選択・可視 run（passes.js の純JS部を逐語で携行）────────────────
	function pickLineTier(rank, baseTex, baseCount) {
		let nominal = null, finest = null;
		for (const t of s.lodTiers ?? []) {
			if (t.minW <= rank && (!nominal || t.edgeCount < nominal.edgeCount)) nominal = t;
			if (!finest || t.minW < finest.minW) finest = t;
		}
		const sel = nominal
			? { tex: nominal.tex, count: nominal.edgeCount, runs: visibleRuns(nominal.edgeCount, nominal.chunks), minW: nominal.minW }
			: { tex: baseTex, count: baseCount, runs: visibleRuns(baseCount, s.metaChunks), minW: 0 };
		s._pfRuns = sel.runs.length; s._pfChunks = (nominal ? nominal.chunks : s.metaChunks)?.length ?? 0;
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
		const vb = s.lastViewBbox;
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

	// ── UBO 詰め物 ─────────────────────────────────────────
	const gfAB = new ArrayBuffer(1024);
	const gfF = new Float32Array(gfAB), gfU = new Uint32Array(gfAB), gfI = new Int32Array(gfAB);
	function packGF(off, d, lodRank, noPivot = false) {
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
		gfF[o + 34] = s.width; gfF[o + 35] = s.height;
		gfU[o + 36] = (Math.round((lon + 180) * 1e7)) >>> 0;
		gfU[o + 37] = (Math.round((d.origin[1] + 90) * 1e7)) >>> 0;
		gfI[o + 38] = s.TEX_ARC_W; gfI[o + 39] = s.TEX_META_W;
		const ell = ellipsoidOn(), pr = d.origin[1] * Math.PI / 180;
		gfF[o + 40] = d.originZr ?? 0; gfF[o + 41] = lodRank;
		gfF[o + 42] = ell ? Math.cos(2 * pr) : 0; gfF[o + 43] = ell ? Math.sin(2 * pr) : 0;   // ellT2（旧 _pad0）
		const vb = s.lastViewBbox;
		if (vb) {
			gfU[o + 44] = Math.max(0, vb[0] - 10000); gfU[o + 45] = Math.max(0, vb[1] - 10000);
			gfU[o + 46] = Math.min(0xFFFFFFFF, vb[2] + 10000); gfU[o + 47] = Math.min(0xFFFFFFFF, vb[3] + 10000);
		} else { gfU[o + 44] = gfU[o + 45] = gfU[o + 46] = gfU[o + 47] = 0; }
		gfU[o + 48] = (!noPivot && s.pivotTex) ? 1 : 0;
		gfU[o + 49] = (!noPivot && s.pivotTex && vb) ? 1 : 0;
		gfU[o + 50] = s.pivotW || 1;
		gfU[o + 51] = s.fidStyleTex ? (s.fidStyleW || 1) : 0;
		gfF[o + 52] = dep?.logCoef ?? 0; gfF[o + 53] = dep?.fogFar ?? 1e9; gfF[o + 54] = dep?.elevScale ?? 0; gfF[o + 55] = dep?.hasElev ?? 0;
		const b = dep?.elevBounds;
		gfF[o + 56] = b?.[0] ?? 0; gfF[o + 57] = b?.[1] ?? 0; gfF[o + 58] = b?.[2] ?? 1; gfF[o + 59] = b?.[3] ?? 1;
		gfF[o + 60] = dep?.edgeFade ?? 0;   // elevP = (edgeFade, cos4φ0, sin4φ0, ell)＝予備3枠へ dβ 錨の残りとゲート
		gfF[o + 61] = ell ? Math.cos(4 * pr) : 0; gfF[o + 62] = ell ? Math.sin(4 * pr) : 0; gfF[o + 63] = ell ? 1 : 0;
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
	let stylesDirty = true;
	const styleAB = new Float32Array(2048);
	function uploadStyles(data) {
		const st = data.styleTable ?? DEF_STYLE, da = data.dashTable ?? DEF_DASH;
		styleAB.set(st, 0);
		for (let i = 0; i < 256; i++) { styleAB[1024 + i * 4] = da[i * 2]; styleAB[1024 + i * 4 + 1] = da[i * 2 + 1]; }
		device.queue.writeBuffer(styleBuf, 0, styleAB);
		stylesDirty = false;
	}

	// ── 描画（embed.js draw ＋ passes.js renderCleanScene/drawHighlight の統合）──────
	let fboW = 0, fboH = 0, pickTex = null;
	function draw(cam, ctx) {
		const fr = host.frameInfo();
		if (!fr) return;
		if (!visible && !s.polyBboxByFid && s.totalPoints === 0) { s._inRange = false; s.lastDrawData = null; return; }
		s.width = fr.w;
		s.height = fr.h;
		s.dpr = cam.dpr || 1;
		const l = s._lastSyncCam;
		const moved = !l || l.center[0] !== cam.center[0] || l.center[1] !== cam.center[1]
			|| l.zoom !== cam.zoom || l.pitch !== cam.pitch || l.bearing !== cam.bearing;
		s._lastSyncCam = { center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch, bearing: cam.bearing };
		if (moved) {
			s._isDrawing = true;
			clearTimeout(s._moveTimer); s._moveTimer = null; s._pendingMove = null;
			s._staticN = 0;
			if (s.activeId !== -1) { s.activeId = -1; postMessage({ action: "identify", featureId: null }); }
		} else {
			s._isDrawing = false;
			s._staticN = (s._staticN ?? 0) + 1;
		}
		s.lastMX = NaN; s.lastMY = NaN;
		const MOVE_EDGE_BUDGET = drawStyle?.moveBudget ?? 250_000;
		if ((s._pfLineEdges ?? 0) > MOVE_EDGE_BUDGET && s._staticN < 4) {
			s.lastDrawData = null;
			s._budgetSkipped = true;
			return;
		}
		const data = { cam, ...(drawStyle || {}) };
		if (!zoomInRange(data)) { s._inRange = false; s.lastDrawData = null; s._pfLineEdges = 0; s._pfTierW = -1; return; }
		s._inRange = true;
		if (s.totalEdges === 0 && s.totalPoints === 0) { s.lastDrawData = null; s._pfLineEdges = 0; s._pfTierW = -1; return; }
		s._budgetSkipped = false;
		const drawData = computeDrawData(data);
		if (ctx && ctx.terrainDepth) drawData.depth = ctx;

		if (visible) renderScene(drawData, fr, ctx);
		s.lastDrawData = drawData;
		if (s._pickPending) { s._pickPending = false; drawn(); }
	}

	function renderScene(data, fr, ctx) {
		const dep = data.depth;
		// UBO を先に確定（queue.writeBuffer は submit 前に順序どおり適用される）
		packGF(GF_LINE * 256, data, data.lodRank ?? 0);
		packGF(GF_FILL * 256, data, 0);                     // 塗り stencil＝全密度（rank0）
		packGF(GF_LINE_B * 256, data, data.lodRank ?? 0, true);   // 境界メタ線＝単一要・カリング無効
		packGF(GF_FILL_B * 256, data, 0, true);                   // 境界メタ塗り＝同上
		device.queue.writeBuffer(gfBuf, 0, gfAB);
		if (stylesDirty) uploadStyles(data);

		// renderCleanScene の判定（逐語）
		const st = data.styleTable ?? DEF_STYLE;
		const zoomV = data.zoom ?? 99, oz = s.outlineZoom ?? OUTLINE_ZOOM;
		const lowZoom = zoomV < oz;
		const moving = s._isDrawing || (s._staticN ?? 99) < 4;
		const lowZoomEff = lowZoom || (moving && zoomV < oz + 1.5);
		if (!s._isDrawing && moving && !lowZoom && lowZoomEff) s.requestDraw?.();
		const hasPoly = (s.polyBboxByFid?.size ?? 0) > 0 && !s.fillOff;
		const fillA = st[3] * 0.8 * Math.max(0, Math.min(1, ((oz + 1.2) - zoomV) / 1.2));
		const fc = data.fillColor ?? (hasPoly && (lowZoomEff || fillA > 0.004) ? [st[0], st[1], st[2], fillA] : DEF_FILL);
		const hasB = !!(s.metaTexB && s.polyEdgesB > 0);
		const stTex = hasB ? s.metaTexB : s.metaTex, stCount = hasB ? s.polyEdgesB : s.polyEdges;
		const doFill = fc[3] > 0 && stCount > 0 && s.arcTex;
		// コロプレス（paint 時）＝ID バッファ塗り。能力あり＝単色 stencil でなく idfill（優先）。基準メタ固定（fid 重み）
		const idFill = canUseIdFill() && ensureIdTex();
		// 線 tier 選択（passes.js と同判断）
		let lnSel = null;
		if (s.totalEdges > 0 && s.arcTex) {
			const finestT = s.lodTiers?.length ? s.lodTiers[0] : null;
			const lnB = lowZoomEff && s.metaTexB && s.polyEdgesB > 0
				&& (finestT ? s.totalEdgesB <= finestT.edgeCount * 1.5 : s.totalEdgesB <= 600_000);
			lnSel = lnB
				? { tex: s.metaTexB, count: s.totalEdgesB, runs: null, minW: -2, boundary: true }
				: { ...pickLineTier(data.lodRank ?? 0, s.metaTex, s.totalEdges), boundary: false };
		}
		// GP スロット確定
		const lw = data.lineWidth ?? 1.0;
		packGP(ROLE.stencil, {});
		packGP(ROLE.fill, { color: fc });
		packGP(ROLE.line, { width: lw, activeId: s.activeId, pass: 0 });
		packGP(ROLE.lineHidden, { width: lw, activeId: s.activeId, pass: 0, hidden: 1 });
		packGP(ROLE.hilite, { width: lw + 2.0, widthAdd: 2.0, radius: data.hiliteWidth || 0, activeId: s.activeId, pass: 1, color: data.hiliteColor });   // radius欄でホバー全幅(device px)を運ぶ＝指定時は shader が lw を上書き（overlay 町丁目線と一致）。hiliteColor＝ホバー線色（未指定＝素の線色を不透明）
		packGP(ROLE.maskStencil, { activeId: s.activeId });
		packGP(ROLE.maskFill, { color: data.maskColor ?? DEF_MASK });
		packGP(ROLE.point, { radius: data.ptRadius ?? 1.5, activeId: -1 });
		packGP(ROLE.pointHi, { radius: data.ptRadius ?? 1.5, activeId: s.activeId });
		device.queue.writeBuffer(gpBuf, 0, gpAB);

		const aux = auxGroup(ctx?.elevView, ctx?.elevSampler);
		// ① ID 蓄積パス（main パスより前・fr.enc の別 render pass）＝winding 和を rg16float へ。基準メタ・rank0・pivot 有効
		if (idFill) {
			idRCPU[0] = s.fidStyleW || 1; idRCPU[1] = s.fidStyleCount; idRCPU[2] = s.idOverlapMode ? 1 : 0; idRCPU[3] = 0;
			device.queue.writeBuffer(idRBuf, 0, idRCPU);
			const idPass = fr.enc.beginRenderPass({ timestampWrites: host.passTS?.("gint"), colorAttachments: [{ view: idTexView, loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
			idPass.setPipeline(idAccumPipe);
			idPass.setBindGroup(0, frameBG[GF_FILL]); idPass.setBindGroup(1, paramBG[ROLE.stencil]);
			idPass.setBindGroup(2, texBG(s.arcTex, s.metaTex)); idPass.setBindGroup(3, aux);
			idPass.draw(s.polyEdges * 3);
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
		pass.setBindGroup(1, paramBG[ROLE.stencil]);
		pass.setBindGroup(3, aux);

		// ② 塗り：コロプレス（idfill）＝解決パスを描画／それ以外＝stencil-then-cover 単色（境界メタ優先）
		// occ＝面ドレープの深度統合：チルト（elevScale>0）でのみ建物 bit7 で塗りをスキップ＝真俯瞰は全塗り維持（裁定）
		const occ = !!(dep && (dep.elevScale ?? 0) > 0 && dep.hasElev);
		if (idFill) {   // ID 画素→fid→スタイル表→色（②の解決＝①で蓄積した idTex を読む）
			pass.setPipeline(occ ? idResolveOccPipe : idResolvePipe);   // occ＝建物画素(bit7)を stencil equal(readMask 0x80) で除外
			pass.setBindGroup(0, idResolveBG);
			pass.draw(3);
		} else if (doFill) {
			pass.setBindGroup(0, frameBG[hasB ? GF_FILL_B : GF_FILL]);   // rank0＝全密度（自己交差斑点の根治）。境界メタ＝単一要・カリング無効
			pass.setBindGroup(2, texBG(s.arcTex, stTex));
			pass.setPipeline(stencilFanPipe);
			pass.draw(stCount * 3);
			if (occ) {   // 建物 bit7 の画素の winding を 0 へ（ref 0x80・equal・replace は 0x80&0x7F=0 を書く）→cover(≠0) が陰を跳ぶ
				pass.setStencilReference(0x80);
				pass.setPipeline(occludePipe);
				pass.draw(3);
				pass.setStencilReference(0);
			}
			pass.setPipeline(coverPipe);
			pass.setBindGroup(1, paramBG[ROLE.fill]);
			pass.draw(3);
			pass.setPipeline(zeroPipe);   // winding を毎回自前でゼロ（pass の stencil clear を bit7 持ち込みの load に替えた代償）
			pass.draw(3);
		}
		if (idFill) pass.setBindGroup(3, aux);   // idResolvePipe は別レイアウト＝bind group がリセットされる＝後続の線/点用に group3(aux) を張り直す
		// ── 線（tier＋可視 run。深度統合時はテストのみ→GREATER 隠線）──
		if (lnSel) {
			pass.setBindGroup(0, frameBG[lnSel.boundary ? GF_LINE_B : GF_LINE]);
			pass.setBindGroup(2, texBG(s.arcTex, lnSel.tex));
			pass.setPipeline(dep ? lineTestPipe : linePipe);
			pass.setBindGroup(1, paramBG[ROLE.line]);
			let pfEdges = 0;
			for (const [est, cnt] of (lnSel.runs ?? [[0, lnSel.count]])) {
				pfEdges += cnt;
				pass.draw(cnt * 6, 1, est * 6);
			}
			s._pfLineEdges = pfEdges; s._pfTierW = lnSel.minW ?? -1;
			if (dep && !s._isDrawing && pfEdges < 100_000) {
				pass.setPipeline(lineHiddenPipe);
				pass.setBindGroup(1, paramBG[ROLE.lineHidden]);
				for (const [est, cnt] of (lnSel.runs ?? [[0, lnSel.count]])) pass.draw(cnt * 6, 1, est * 6);
			}
		}
		// ── 点 ──
		if (s.totalPoints > 0 && s.ptTex && s.ptMetaTex) {
			pass.setPipeline(pointPipe);
			pass.setBindGroup(0, frameBG[GF_LINE]);
			pass.setBindGroup(1, paramBG[ROLE.point]);
			pass.setBindGroup(2, texBG(s.ptTex, s.ptMetaTex));
			pass.draw(s.totalPoints * 6);
		}
		// ── ハイライト（activeId≥0＝毎フレーム inline。深度免除・ドレープのみ＝GL drawHighlight と同順）──
		if (s.activeId !== -1 && (s.arcTex || s.ptTex)) {
			const range = s.polyEdgeByFid?.get(s.activeId);
			const eStart = range?.[0] ?? null, eCount = range?.[1] ?? null;
			const hasRange = eStart != null && eCount > 0;
			if (s.totalEdges > 0 && s.metaTex) {
				pass.setPipeline(linePipe);
				pass.setBindGroup(0, frameBG[GF_LINE]);
				pass.setBindGroup(1, paramBG[ROLE.hilite]);
				pass.setBindGroup(2, texBG(s.arcTex, s.metaTex));
				if (hasRange) pass.draw(eCount * 6, 1, eStart * 6);
				else pass.draw(s.totalEdges * 6);
			}
			if (s.totalPoints > 0 && s.ptTex && s.ptMetaTex) {
				pass.setPipeline(pointPipe);
				pass.setBindGroup(1, paramBG[ROLE.pointHi]);
				pass.setBindGroup(2, texBG(s.ptTex, s.ptMetaTex));
				pass.draw(s.totalPoints * 6);
			}
			const mc = data.maskColor ?? DEF_MASK;
			if (mc[3] > 0 && hasRange && s.metaTex) {
				pass.setPipeline(zeroPipe);   // stencil を 0 へ（mid-pass clear の代替）
				pass.setBindGroup(1, paramBG[ROLE.maskStencil]);
				pass.draw(3);
				pass.setPipeline(stencilFanPipe);
				pass.setBindGroup(0, frameBG[GF_LINE]);   // GL は実 rank＋per-fid 扇要（bindPivot）＝lodSnap 込みの mask fan
				pass.setBindGroup(2, texBG(s.arcTex, s.metaTex));
				pass.draw(eCount * 3, 1, eStart * 3);
				pass.setPipeline(coverEqPipe);   // stencil==0＝地物の外を暗く
				pass.setBindGroup(1, paramBG[ROLE.maskFill]);
				pass.draw(3);
				pass.setPipeline(zeroPipe);   // mask winding を後始末（stencil load 化＝後続レイヤへ持ち越さない）
				pass.draw(3);
			}
		}
		pass.end();
	}

	// ── settle（picking buffer 構築）＝非MSAA rgba8 テクスチャへ別パス ────────────
	function drawn() {
		s._isDrawing = false;
		s._pfDrawn = (s._pfDrawn ?? 0) + 1;
		if (!s.lastDrawData) {
			if (s._budgetSkipped) { s._budgetSkipped = false; s._staticN = 4; s._pickPending = true; s.requestDraw?.(); }
			return;
		}
		if (!s.polyBboxByFid && s.totalPoints === 0) return;
		if (!pickTex || fboW !== s.width || fboH !== s.height) {
			if (pickTex) pickTex.destroy();
			pickTex = device.createTexture({ size: [s.width, s.height], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
			fboW = s.width; fboH = s.height;
			s._pfFbo = (s._pfFbo ?? 0) + 1;
		}
		const t0 = performance.now();
		const data = s.lastDrawData;
		const pickMargin = 12 * (s.dpr ?? 1);
		packGF(0, data, data.lodRank ?? 0);   // 非表示層（識別だけ生存）は renderScene が GF を書いていない＝ここで確定
		device.queue.writeBuffer(gfBuf, 0, gfAB, 0, 256);
		packGP(ROLE.pickLine, { width: (data.lineWidth ?? 1.0) + pickMargin });
		packGP(ROLE.pickPoint, { radius: Math.max(data.ptRadius ?? 1.5, pickMargin * 0.5) });
		device.queue.writeBuffer(gpBuf, ROLE.pickLine * GP_SLOT, gpAB, ROLE.pickLine * GP_SLOT, GP_SLOT * 2);
		const aux = auxGroup(null, null);
		const enc = device.createCommandEncoder();
		const pass = enc.beginRenderPass({
			colorAttachments: [{ view: pickTex.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }],
		});
		pass.setBindGroup(0, frameBG[GF_LINE]);
		pass.setBindGroup(3, aux);
		if (s.totalEdges > 0 && s.metaTex && s.arcTex) {
			const pkSel = pickLineTier(data.lodRank ?? 0, s.metaTex, s.totalEdges);
			pass.setPipeline(pickLinePipe);
			pass.setBindGroup(1, paramBG[ROLE.pickLine]);
			pass.setBindGroup(2, texBG(s.arcTex, pkSel.tex));
			for (const [est, cnt] of (pkSel.runs ?? [[0, pkSel.count]])) pass.draw(cnt * 6, 1, est * 6);
		}
		if (s.totalPoints > 0 && s.ptTex && s.ptMetaTex) {
			pass.setPipeline(pickPointPipe);
			pass.setBindGroup(1, paramBG[ROLE.pickPoint]);
			pass.setBindGroup(2, texBG(s.ptTex, s.ptMetaTex));
			pass.draw(s.totalPoints * 6);
		}
		pass.end();
		device.queue.submit([enc.finish()]);
		s._pfPickMs = (s._pfPickMs ?? 0) + (performance.now() - t0);
		if (s._pendingMove) { const m = s._pendingMove; s._pendingMove = null; doIdentify(m); }
	}

	// ── 識別（identify.js の WebGPU 版＝copyTextureToBuffer + mapAsync 非同期読み）────
	let pickBuf = null, prInFlight = null;
	function doIdentify(data) {
		if (data.x === s.lastMX && data.y === s.lastMY) return;
		s.lastMX = data.x; s.lastMY = data.y;
		if (!pickTex) return;
		// ★クランプは pickTex の実サイズ(fboW/fboH)で行う＝s.width/s.height（現canvas）ではない。
		// canvasリサイズ（census2020の6:4パネル開閉等）直後は pickTex が旧サイズのまま（settleで作り直すまで）。
		// 現サイズでクランプすると旧pickTexの範囲外を copyTextureToBuffer→コマンドバッファ無効→フレーム落ち＝
		// 「スパッと切れた穴」の連鎖になる（2026-08-12 実機WebGPUで実証）。実サイズでクランプで根治。
		const pickX = Math.max(0, Math.min(fboW - 1, Math.round(data.x * s.dpr)));
		const pickY = Math.max(0, Math.min(fboH - 1, Math.round(data.y * s.dpr)));   // WebGPU は原点左上＝GL の上下反転は不要
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
			if (pr.next) { s.lastMX = NaN; doIdentify(pr.next.data); }
		}).catch(() => { prInFlight = null; }), 0);   // destroy 中の map 失敗は握る
	}
	function finishIdentify(px, data) {
		const fid1 = px[0] | (px[1] << 8) | (px[2] << 16);
		let featureId = fid1 === 0 ? null : fid1 - 1;
		if (fid1 === 0 && s.gintData?.polyStream && s.cam) {
			const geo = unproject(s.cam, data.x * s.dpr, data.y * s.dpr);
			if (geo) {
				const SE = 1e7;
				featureId = findPolygon(
					s.gintData.arcBuffer, s.gintData.arcMeta, s.gintData.polyStream,
					Math.round((geo[0] + 180) * SE), Math.round((geo[1] + 90) * SE),
					s.polyBboxByFid, s.lastViewBbox,
				);
			}
		}
		const newId = featureId ?? -1;
		if (newId === s.activeId) return;
		s.activeId = newId;
		postMessage({ action: "identify", featureId: featureId ?? null, x: data.x, y: data.y });
		s.requestDraw?.();
	}
	function move(data) {
		if (!s._inRange) { leave(); return; }
		// 自己修復：pick 未構築のまま最初のホバーが来た＝settle(gintDrawn)が一度も来ていない
		//（?area=＋hash 復元はカメラを一切動かさない＝onMove の settle タイマーが発火しない）。
		// ここで一度だけ構築すれば以後は通常経路。従来は doIdentify が !pickTex で黙って無反応＝
		// 「カメラを動かすまでホバー/クリック識別が死んでいる」元々のバグ（本人報告 2026-08-14）の根治。
		if (!pickTex && s.lastDrawData && !s._isDrawing) drawn();
		if (!s.cam || !s.gintData || s._isDrawing) {
			if (s._isDrawing) s._pendingMove = data;
			return;
		}
		if (s._moveTimer !== null) { s._pendingMove = data; return; }
		doIdentify(data);
		s._moveTimer = setTimeout(() => {
			s._moveTimer = null;
			if (s._pendingMove) { doIdentify(s._pendingMove); s._pendingMove = null; }
		}, MOVE_THROTTLE_MS);
	}
	function leave() {
		clearTimeout(s._moveTimer); s._moveTimer = null;
		s._pendingMove = null;
		if (s.activeId === -1) return;
		s.activeId = -1;
		postMessage({ action: "identify", featureId: null });
		s.requestDraw?.();
	}
	function click() {
		if (s.activeId === -1) return;
		const geo = s.cam ? unproject(s.cam, s.lastMX * s.dpr, s.lastMY * s.dpr) : null;
		postMessage({ action: "click", featureId: s.activeId, x: s.lastMX, y: s.lastMY, lng: geo?.[0] ?? null, lat: geo?.[1] ?? null });
	}
	function dispose() {
		saveActive();
		for (const b of slots.values()) deleteBundleTextures(b);
		slots.clear(); activeKey = null;
		deleteTextures();
		clearFidStyle();
		if (pickTex) { pickTex.destroy(); pickTex = null; }
		if (pickBuf) { pickBuf.destroy(); pickBuf = null; }
		if (idTex) { idTex.destroy(); idTex = null; }
		gfBuf.destroy(); gpBuf.destroy(); styleBuf.destroy(); idRBuf.destroy();
		dummyU32.destroy(); dummyF32.destroy();
		s.gintData = null;
		s.polyEdgeByFid = null; s.polyBboxByFid = null; s.fillOff = false;
		s.totalEdges = s.totalPoints = s.polyEdges = 0;
		s.activeId = -1; s.lastDrawData = null;
	}
	function stats() {
		return { drawn: s._pfDrawn ?? 0, fbo: s._pfFbo ?? 0, pickMs: s._pfPickMs ?? 0,
			rank: s.lastDrawData?.lodRank ?? -1, tierW: s._pfTierW ?? -1, edges: s._pfLineEdges ?? 0,
			tiers: s.lodTiers?.length ?? 0, tiersDone: !!s.tiersDone, total: s.totalEdges,
			runs: s._pfRuns ?? -1, chunks: s._pfChunks ?? -1, vb: s.lastViewBbox };
	}
	return { set, setSlot, setBaked, style, setVisible, paint, draw, drawn, move, leave, click, dispose, stats };
}
