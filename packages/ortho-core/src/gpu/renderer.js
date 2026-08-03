// WebGPU レンダラ＝gl/renderer.js の臓器移植。
// Phase 1: globe＋基図シーン（fill/line・classic merge 経路）。Phase 2: 標高アトラス（R16F）・地形サーフェス・
// 深度（対数・尾根の遮蔽）・建物押し出し・等高線。公開面は createRenderer と同形 { set, draw, dispose, md, mdMax, gintCtx }。
// md=false＝scene worker は CPU merge フォールバック（?nomd=1 と同じ実証済み経路）で typed array シーンを送ってくる。
// 未搭載（set は握り潰し・描画は素通し）：PLATEAU・overlay(stencil)・星空/夜面・gint。
//
// WebGL 版との設計差：
// ・uniform は 1 フレーム 1 回の UBO 書込：Frame（512B×4スロット＝base/main/terrain/bld。origin と fog の違いを
//   スロットで表現＝GL の setCommonUniforms＋per-program 上書きの写し）＋DrawP（役割別 6 スロット＝seaGate/lift/色ノブ）。
// ・深度は depth24plus を常設し、パイプライン変種で GL の enable/disable/depthMask を表現
//   （fill/line: off / test-only、terrain: write+polygonOffset≒depthBias、building: test+write）。
// ・標高アトラスは r16float＝CPU で f32→f16 変換（GL は texImage2D がドライバ変換。WebGPU は生バイト渡し）。
//   r16float はコアで filterable＝GL 版が R16F を選んだ理由（全デバイス線形補間）がそのまま活きる。
// ・MSAA 4x 明示（GL の canvas antialias:true と同格）。リサイズは getCurrentTexture が canvas 寸法へ自動追随。
import { cameraState, lonlatTo3D, project } from "../camera.js";
import { seaFbReal } from "../scene.js";
import * as mat from "../mat.js";
import { FILL_WGSL, LINE_WGSL, GLOBE_WGSL, TERRAIN_WGSL, BUILDING_WGSL, CONTOUR_WGSL, PLATEAU_WGSL, SKY_WGSL, OVERLAY_WGSL } from "./wgsl.js";

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)＝gl/renderer.js と同一
const FRAME_SLOT = 512;    // frame UBO のスロット境界（実使用272B・minUniformBufferOffsetAlignment 上限256の倍数）
const FRAME_F32 = 72;      // 288B/4（wgsl.js Frame と厳密対応。詰め順は packFrame 参照。末尾 mesh vec4f 含む）
const SLOT = { base: 0, main: 1, terrain: 2, bld: 3 };   // terrain/bld は main と同 origin・fog だけ違うスロット
const PARAM_SLOT = 256;    // DrawP（3×vec4=48B）のスロット境界
const ROLE = { normal: 0, water: 1, seaFb: 2, terrain: 3, bld: 4, contour: 5, plateau: 6, fadeNormal: 7, fadeWater: 8, fadeSeaFb: 9, fadeBld: 10 };   // fade*=クロスフェード中の新シーン用（p0.w=α）
const N_ROLES = 11;
const FADE_MS = 180;   // classic merge のシーン一括差し替えをフェードに（「ポンッ」→融ける。モバイルのパラパラ感対策）
const PL_BATCH_SLOT = 256; // PLATEAU per-batch UBO（meshOrigin+cullBack, clipMesh＝32B）のスロット境界（dynamic offset）
const MAX_PL_BATCH = 512;  // 1フレームに描く可視バッチ上限（超過は log して打ち切り）
const MAX_PLATEAU_MASKS = 4;
const WATER_LIFT_M = 30;        // 水面リフト(m)：DSM帯（gl/renderer.js と同値・同意味論）
const CITY_WATER_LIFT_M = 10;   // 都市帯(z≥14・DTM)の水面リフト(m)

// f32→f16（IEEE half）。標高(m)は -500..9000 級＝half で ±0.25〜2m 精度（GL の R16F と同じ土俵）。
// 最近接丸め・Inf/NaN→0（標高データに来ない保険）・subnormal 域(6e-5m未満)は 0 へフラッシュ。
function f32ToF16(src) {
	const n = src.length, out = new Uint16Array(n);
	const u = new Uint32Array(src.buffer, src.byteOffset, n);
	for (let i = 0; i < n; i++) {
		const x = u[i], s = (x >>> 16) & 0x8000;
		let e = (x >>> 23) & 0xff, m = x & 0x7fffff;
		if (e === 0xff) { out[i] = s; continue; }
		if (e < 113) { out[i] = s; continue; }
		m = m + 0x1000;                                     // 半ULP加算＝最近接丸め
		if (m & 0x800000) { m = 0; e++; }
		out[i] = e > 142 ? (s | 0x7bff) : (s | ((e - 112) << 10) | (m >> 13));
	}
	return out;
}

export async function createRendererGPU(canvas, rOpts = {}) {
	if (typeof navigator === "undefined" || !navigator.gpu) throw new Error("WebGPU unavailable");
	const adapter = await navigator.gpu.requestAdapter(rOpts.powerPreference ? { powerPreference: rOpts.powerPreference } : undefined);
	if (!adapter) throw new Error("WebGPU adapter unavailable");
	// A/B 計測用の GPU 識別（WebGL の WEBGL_debug_renderer_info 相当）。info は環境で空の事があるので緩く。
	const ai = adapter.info || {};
	const gpuInfo = [ai.vendor, ai.architecture, ai.device, ai.description].filter(Boolean).join(" ") || "unknown";
	const wantTQ = !rOpts.noTQ && !!(adapter.features && adapter.features.has && adapter.features.has("timestamp-query"));   // noTQ＝?notq=1 の切り分けフラグ（iOS Safari 診断 2026-08-02）
	const device = await adapter.requestDevice(wantTQ ? { requiredFeatures: ["timestamp-query"] } : undefined);
	const ctx = canvas.getContext("webgpu");
	if (!ctx) throw new Error("webgpu context unavailable");
	const format = navigator.gpu.getPreferredCanvasFormat();
	// COPY_SRC＝snapshot（shot/print）が resolve 済みの canvas テクスチャを copyTextureToBuffer で読む
	ctx.configure({ device, format, alphaMode: "premultiplied", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
	const isBGRA = format === "bgra8unorm";   // Mac の既定＝readback は BGRA＝RGBA へ swizzle
	// WebKit(Safari) は GPUDevice の EventTarget 実装が無い版がある＝onuncapturederror 属性も併用（両対応・二重発火なし＝どちらか一方しか効かない環境前提）
	const onUncap = e => console.error("[gpu] uncaptured:", e.error?.message || e.error);
	if (device.addEventListener) device.addEventListener("uncapturederror", onUncap);
	else if ("onuncapturederror" in device) device.onuncapturederror = onUncap;

	// --- iOS Safari 診断（2026-08-02）：沈黙故障の可視化 ---
	// パイプラインの WGSL コンパイル失敗は非同期＝環境によっては console にも uncaptured にも出ず、
	// 無効パイプラインを含む submit が丸ごと落ちて「クリアすら出ない白画面」になる。
	// ①全シェーダの getCompilationInfo で行番号つきの失敗を暴く ②init/初回フレームを errorScope で包む。
	// 発見物は gpuErrors へ＝renderworker が frame1 後に main へ転写（モバイルでも見える）。
	const gpuErrors = [];
	let frame1Scoped = 0;
	const gpuErr = (where, msg) => { const t = `${where}: ${msg}`; gpuErrors.push(t); console.error("[gpu] " + t); };
	const mkMod = (code, label) => {
		const m = device.createShaderModule({ code });
		m.getCompilationInfo && m.getCompilationInfo().then(info => {
			for (const x of info.messages || []) if (x.type === "error") gpuErr(`WGSL ${label}`, `${x.lineNum}:${x.linePos} ${x.message}`);
		});
		return m;
	};
	device.pushErrorScope("validation");   // init 全体（pipeline/texture/buffer 作成）を包む＝pop は return 直前

	// --- GPU 実時間（timestamp-query）＝GL の EXT_disjoint_timer_query_webgl2 相当 ---
	// パス単位で begin/end を打ち（writeTimestamp は仕様から撤去済＝pass の timestampWrites 一択）、
	// flush で resolveQuerySet→staging コピー→mapAsync＝数フレーム遅れの非同期回収（GL と同じ運用）。
	// 消費者は renderworker の tqFeed：動的解像度の busyMs・GPU格付け(gpuFast＝静止時の手前詳細化)・
	// perf 行の gpuMap/gpuGint が WebGPU でも復活する。未対応 GPU は tq=null＝従来の壁時計フォールバック。
	// ⚠Chrome は値を~100µs に量子化＝ms 級のパス計測には十分（GL タイマも同程度のノイズ）。
	const TQ_N = 16;   // 1フレームの計測パス上限×2（begin/end）。枠切れは打たない＝計測を落とすだけで本業は止めない
	let tq = wantTQ ? {   // 自己修復で null 化あり（下 tqOff）
		qs: device.createQuerySet({ type: "timestamp", count: TQ_N }),
		resolve: device.createBuffer({ size: TQ_N * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
		staging: Array.from({ length: 3 }, () => ({ buf: device.createBuffer({ size: TQ_N * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }), busy: false, spans: null, n: 0 })),
		idx: 0, spans: [], ready: [],
	} : null;
	// timestampWrites を受け付けない環境（WebKit の版差等）＝初回の失敗で TQ を丸ごと畳む（以後 undefined＝無計測で本業続行）
	function tqOff(err) {
		console.warn("[gpu] timestamp-query を無効化（この環境では使えない）:", err && (err.message || err));
		try { tq && tq.qs.destroy && tq.qs.destroy(); } catch {}
		tq = null;
	}
	function passTS(tag) {   // beginRenderPass の timestampWrites（未対応/枠切れ＝undefined＝無計測）
		if (!tq || tq.idx + 2 > TQ_N) return undefined;
		const i0 = tq.idx; tq.idx += 2;
		tq.spans.push({ tag, i0 });
		return { querySet: tq.qs, beginningOfPassWriteIndex: i0, endOfPassWriteIndex: i0 + 1 };
	}

	// premultiplied 合成（gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA) と同じ）
	const BLEND = {
		color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
		alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
	};
	const SAMPLES = 4;   // WebGL 版 canvas の antialias:true と同格（MSAA 4x→resolve）
	const DEPTH = "depth24plus-stencil8";   // stencil は gint（winding 塗り）が同一アタッチメントで使う（renderer 自身は不使用＝既定 keep で不干渉）
	const target = { format, blend: BLEND };
	const ms = { count: SAMPLES };
	const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

	// 共有レイアウト：group(0)=Frame＋標高（テクスチャは VS でも引く＝ドレープ）、group(1)=DrawP（役割別）
	const bgl0 = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: VF, buffer: {} },
		{ binding: 1, visibility: VF, texture: { sampleType: "float" } },
		{ binding: 2, visibility: VF, sampler: { type: "filtering" } },
	] });
	const bgl1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
	const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });
	// building group(2)＝PLATEAU 被覆マスク（count+bbox UBO＋4テクスチャ＋sampler）。PLATEAU 無しでも count=0 で素通し
	const bglMask = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
		{ binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
		{ binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
	] });
	const bldLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bglMask] });
	// PLATEAU group(2)＝per-batch UBO（meshOrigin+cullBack, clipMesh）を dynamic offset で切替。
	// cullBack(meshOrigin.w) は FS が裏面判定に読む＝visibility は VERTEX|FRAGMENT 両方。
	const bglPlBatch = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } }] });
	const plLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1, bglPlBatch] });

	const fillMod = mkMod(FILL_WGSL, "fill");
	const lineMod = mkMod(LINE_WGSL, "line");
	const globeMod = mkMod(GLOBE_WGSL, "globe");
	const terrMod = mkMod(TERRAIN_WGSL, "terrain");
	const bldMod = mkMod(BUILDING_WGSL, "building");
	const contMod = mkMod(CONTOUR_WGSL, "contour");
	const plMod = mkMod(PLATEAU_WGSL, "plateau");
	// 深度状態の変種＝GL の enable/disable/depthMask/polygonOffset の写し（深度アタッチメントは常設）
	const dsOff = { format: DEPTH, depthWriteEnabled: false, depthCompare: "always" };
	const dsTest = { format: DEPTH, depthWriteEnabled: false, depthCompare: "less-equal" };
	const dsWrite = { format: DEPTH, depthWriteEnabled: true, depthCompare: "less-equal" };
	const dsTerrain = { ...dsWrite, depthBias: 4, depthBiasSlopeScale: 1.0 };   // gl.polygonOffset(1.0, 4.0) 相当＝ドレープした基図が z-fight せず表に出る
	const FILL_BUFS = [
		{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },   // a_delta
		{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "unorm8x4" }] },    // a_color
	];
	const LINE_BUFS = [
		{ arrayStride: 8, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },     // corner
		{ arrayStride: 8, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }] },   // p1
		{ arrayStride: 8, stepMode: "instance", attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },   // p2
		{ arrayStride: 4, stepMode: "instance", attributes: [{ shaderLocation: 3, offset: 0, format: "unorm8x4" }] },    // color
		{ arrayStride: 4, stepMode: "instance", attributes: [{ shaderLocation: 4, offset: 0, format: "float32" }] },     // half(CSS px)
	];
	const pipe = (mod, bufs, ds, fsEntry = "fs", lay = layout, cull = "none") => device.createRenderPipeline({
		layout: lay,
		vertex: { module: mod, entryPoint: "vs", buffers: bufs },
		fragment: { module: mod, entryPoint: fsEntry, targets: [target] },
		primitive: { topology: "triangle-list", cullMode: cull },
		depthStencil: ds, multisample: ms,
	});
	const fillOff = pipe(fillMod, FILL_BUFS, dsOff);
	const fillTest = pipe(fillMod, FILL_BUFS, dsTest);
	const fillTestExact = pipe(fillMod, FILL_BUFS, dsTest, "fsExact");   // 水域の厳密対数深度（琵琶湖の偽島対策）
	const lineOff = pipe(lineMod, LINE_BUFS, dsOff);
	const lineTest = pipe(lineMod, LINE_BUFS, dsTest);
	const terrainPipe = pipe(terrMod, [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }], dsTerrain);
	const bldPipe = pipe(bldMod, [
		{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },   // a_pos (dlon,dlat,hWorld)
		{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }] },      // a_shade
		{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },    // a_anchor
	], dsWrite, "fs", bldLayout);   // group(2)=PLATEAU 被覆マスク
	// PLATEAU LOD2：頂点=重心相対 pos(f32x3)＋int8量子化法線(snorm8x4・stride4)。裏面カリングは FS（両面データ）＝cullMode none
	const plateauPipe = pipe(plMod, [
		{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },   // a_pos（重心相対 delta）
		{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "snorm8x4" }] },     // a_normal（xyz+pad・FS で normalize）
	], dsWrite, "fs", plLayout);
	const contourPipe = pipe(contMod, undefined, dsOff);
	const globePipe = device.createRenderPipeline({   // globe は Frame 非依存＝専用レイアウト(auto)
		layout: "auto",
		vertex: { module: globeMod, entryPoint: "vs" },
		fragment: { module: globeMod, entryPoint: "fs", targets: [target] },
		primitive: { topology: "triangle-list" },
		depthStencil: dsOff, multisample: ms,
	});
	// 星空劇場（z<4）：Sky UBO（group0）＋星座線の色 UBO（group1）。深度無関係の背景（dsOff）
	const skyMod = mkMod(SKY_WGSL, "sky");
	const bglSky = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
	const bglSkyLine = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {} }] });
	const skyLayout = device.createPipelineLayout({ bindGroupLayouts: [bglSky] });
	const skyLineLayout = device.createPipelineLayout({ bindGroupLayouts: [bglSky, bglSkyLine] });
	const STAR_BUF = [{ arrayStride: 32, stepMode: "instance", attributes: [   // cel.xyz + rgba + size（GL の 8f interleave）
		{ shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x4" }, { shaderLocation: 2, offset: 28, format: "float32" }] }];
	const starsPipe = device.createRenderPipeline({
		layout: skyLayout, vertex: { module: skyMod, entryPoint: "vsStar", buffers: STAR_BUF },
		fragment: { module: skyMod, entryPoint: "fsStar", targets: [target] },
		primitive: { topology: "triangle-list" }, depthStencil: dsOff, multisample: ms,
	});
	const starLinePipe = device.createRenderPipeline({
		layout: skyLineLayout, vertex: { module: skyMod, entryPoint: "vsLine", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
		fragment: { module: skyMod, entryPoint: "fsLine", targets: [target] },
		primitive: { topology: "line-list" }, depthStencil: dsOff, multisample: ms,
	});
	const nightPipe = device.createRenderPipeline({
		layout: skyLayout, vertex: { module: skyMod, entryPoint: "vsNight" },
		fragment: { module: skyMod, entryPoint: "fsNight", targets: [target] },
		primitive: { topology: "triangle-list" }, depthStencil: dsOff, multisample: ms,
	});
	// overlay（外部ベクタ）：per-scene の Frame(group0)＋DrawP(group1) を dynamic offset で切替。
	// stencil-then-cover 塗り＋境界線（線は LINE_WGSL 流用）。深度 off・stencil で巻き数塗り。
	const ovMod = mkMod(OVERLAY_WGSL, "overlay");
	const bglOvFrame = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } },
		{ binding: 1, visibility: VF, texture: { sampleType: "float" } },
		{ binding: 2, visibility: VF, sampler: { type: "filtering" } },
	] });
	const bglOvParam = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { hasDynamicOffset: true } }] });
	const ovLayout = device.createPipelineLayout({ bindGroupLayouts: [bglOvFrame, bglOvParam] });
	const dsOvStencil = { format: DEPTH, depthWriteEnabled: false, depthCompare: "always",   // fan→巻き数（FRONT+1/BACK-1）
		stencilFront: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "increment-wrap" },
		stencilBack: { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "decrement-wrap" }, stencilWriteMask: 0xFF };
	const dsOvCover = { format: DEPTH, depthWriteEnabled: false, depthCompare: "always",     // stencil≠0 を塗り→0 へ戻す
		stencilFront: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "zero" },
		stencilBack: { compare: "not-equal", failOp: "keep", depthFailOp: "keep", passOp: "zero" }, stencilWriteMask: 0xFF };
	const ovStencilPipe = device.createRenderPipeline({
		layout: ovLayout, vertex: { module: ovMod, entryPoint: "vsStencil", buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
		fragment: { module: ovMod, entryPoint: "fsNull", targets: [{ format, writeMask: 0 }] },   // 色は書かない（stencil のみ）
		primitive: { topology: "triangle-list" }, depthStencil: dsOvStencil, multisample: ms,
	});
	const ovCoverPipe = device.createRenderPipeline({
		layout: ovLayout, vertex: { module: ovMod, entryPoint: "vsCover" },
		fragment: { module: ovMod, entryPoint: "fsCover", targets: [target] },
		primitive: { topology: "triangle-list" }, depthStencil: dsOvCover, multisample: ms,
	});
	const ovLinePipe = device.createRenderPipeline({   // 境界線/N02線＝LINE_WGSL 流用（dynamic frame レイアウト）
		layout: ovLayout, vertex: { module: lineMod, entryPoint: "vs", buffers: LINE_BUFS },
		fragment: { module: lineMod, entryPoint: "fs", targets: [target] },
		primitive: { topology: "triangle-list" }, depthStencil: dsOff, multisample: ms,
	});
	// gintBld（moj筆ドレープ線/点）＝BUILDING_WGSL 流用・独自 origin（dynamic frame）＋DrawP(dynamic)＋mask(count0)。
	// GL_LINES/GL_POINTS → topology line-list/point-list。深度で地形/尾根に遮蔽（建物と同じ dsWrite）。
	const gbLayout = device.createPipelineLayout({ bindGroupLayouts: [bglOvFrame, bglOvParam, bglMask] });
	const GB_BUFS = [
		{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },   // a_pos (dlon,dlat,hWorld)
		{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "float32" }] },      // a_shade
		{ arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },    // a_anchor
	];
	const gbLinePipe = device.createRenderPipeline({
		layout: gbLayout, vertex: { module: bldMod, entryPoint: "vs", buffers: GB_BUFS },
		fragment: { module: bldMod, entryPoint: "fs", targets: [target] },
		primitive: { topology: "line-list" }, depthStencil: dsWrite, multisample: ms,
	});
	const gbPointPipe = device.createRenderPipeline({
		layout: gbLayout, vertex: { module: bldMod, entryPoint: "vs", buffers: GB_BUFS },
		fragment: { module: bldMod, entryPoint: "fs", targets: [target] },
		primitive: { topology: "point-list" }, depthStencil: dsWrite, multisample: ms,
	});

	// UBO：Frame 4スロット / DrawP N_ROLESスロット / globe 専用 / PLATEAU per-batch（dynamic offset）
	const frameBuf = device.createBuffer({ size: FRAME_SLOT * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const paramBuf = device.createBuffer({ size: PARAM_SLOT * N_ROLES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const globeBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const globeBG = device.createBindGroup({
		layout: globePipe.getBindGroupLayout(0),
		entries: [{ binding: 0, resource: { buffer: globeBuf } }],
	});
	const paramBG = [];   // 役割別（静的オフセット＝dynamic offset 不要）
	for (let r = 0; r < N_ROLES; r++) paramBG.push(device.createBindGroup({
		layout: bgl1, entries: [{ binding: 0, resource: { buffer: paramBuf, offset: r * PARAM_SLOT, size: 48 } }],
	}));
	// PLATEAU per-batch UBO（dynamic offset＝1つの bind group で全バッチを切替）
	const plBatchBuf = device.createBuffer({ size: PL_BATCH_SLOT * MAX_PL_BATCH, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const plBatchBG = device.createBindGroup({ layout: bglPlBatch, entries: [{ binding: 0, resource: { buffer: plBatchBuf, offset: 0, size: 32 } }] });
	const plBatchCPU = new Float32Array(PL_BATCH_SLOT / 4 * MAX_PL_BATCH);
	// 星空劇場：Sky UBO（176B）＋星座線の色 UBO（3スロット×256B＝constel/ecliptic/celeq を静的 offset で切替）
	const skyBuf = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const skyCPU = new Float32Array(48);   // Sky（176B＝44f、192B確保でアラインメント余白）
	const skyBG = device.createBindGroup({ layout: bglSky, entries: [{ binding: 0, resource: { buffer: skyBuf } }] });
	const LINE_SLOT = 256, LINE_ROLE = { constel: 0, ecliptic: 1, celeq: 2 };
	const skyLineBuf = device.createBuffer({ size: LINE_SLOT * 3, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const skyLineCPU = new Float32Array(LINE_SLOT / 4 * 3);
	const skyLineBG = [0, 1, 2].map(i => device.createBindGroup({ layout: bglSkyLine, entries: [{ binding: 0, resource: { buffer: skyLineBuf, offset: i * LINE_SLOT, size: 16 } }] }));
	// 星座線の色（GL renderer と同値）：星座=青 / 黄道=淡黄 / 天の赤道=淡紅。fadeSky.x（出現α）は VS で掛ける
	skyLineCPU.set([0.47, 0.63, 1.0, 0.4], LINE_ROLE.constel * (LINE_SLOT / 4));
	skyLineCPU.set([1.0, 0.8, 0.45, 0.35], LINE_ROLE.ecliptic * (LINE_SLOT / 4));
	skyLineCPU.set([1.0, 0.55, 0.5, 0.32], LINE_ROLE.celeq * (LINE_SLOT / 4));
	device.queue.writeBuffer(skyLineBuf, 0, skyLineCPU);
	let stars = null, planets = null, constel = null, ecliptic = null, celeq = null;   // { buf, count }
	function setStarBuf(cur, data, stride) {
		if (cur) cur.buf.destroy();
		if (!data || !data.length) return null;
		const src = data instanceof Float32Array ? data : new Float32Array(data);
		const buf = device.createBuffer({ size: (src.byteLength + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(buf, 0, src);
		return { buf, count: src.length / stride };
	}
	// overlay：per-scene の Frame（FRAME_SLOT）＋DrawP（PARAM_SLOT）を dynamic offset で切替。最大 MAX_OV シーン/フレーム。
	// 末尾スロット GB_SLOT は gintBld（moj筆ドレープ線・独自 origin）が間借り＝同じ dynamic frame 機構を再利用。
	const MAX_OV = 32, GB_SLOT = MAX_OV, OV_SLOTS = MAX_OV + 1;
	const ovFrameBuf = device.createBuffer({ size: FRAME_SLOT * OV_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const ovParamBuf = device.createBuffer({ size: PARAM_SLOT * OV_SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const ovParamCPU = new Float32Array(PARAM_SLOT / 4 * OV_SLOTS);
	let ovFrameBG = null, ovFrameBGView = null;   // drawOverlay が elevTexView 変化時だけ作り直す（rebuildBG0 と独立）
	const ovParamBG = device.createBindGroup({ layout: bglOvParam, entries: [{ binding: 0, resource: { buffer: ovParamBuf, offset: 0, size: 48 } }] });
	function ensureOvFrameBG() {
		const v = (elev.has && elevTexView) ? elevTexView : dummyView;
		if (ovFrameBG && ovFrameBGView === v) return;
		ovFrameBGView = v;
		ovFrameBG = device.createBindGroup({ layout: bglOvFrame, entries: [
			{ binding: 0, resource: { buffer: ovFrameBuf, offset: 0, size: FRAME_SLOT } },
			{ binding: 1, resource: v }, { binding: 2, resource: elevSampler }] });
	}
	// overlay スロット：{ fanBuf, fanCount, lineBufs?, lineCount, origin, fill, minZoom }
	let overlay = null, overlayHi = null, n02 = [];
	const u8colOv = col => { const u = new Uint8Array(col.length); for (let i = 0; i < col.length; i++) u[i] = Math.max(0, Math.min(255, Math.round(col[i] * 255))); return u; };
	function buildOverlaySlot(s, fill) {
		if (!s || (!s.fanPos.length && !(s.lineHalf && s.lineHalf.length))) return null;
		const o = { origin: s.origin, fill, minZoom: s.minZoom || 0, fanCount: s.fanPos.length / 2, lineCount: 0, bufs: [] };
		if (s.fanPos.length) { o.fanBuf = makeBuf(s.fanPos, GPUBufferUsage.VERTEX); o.bufs.push(o.fanBuf); }
		if (s.lineHalf && s.lineHalf.length) {
			o.lineCount = s.lineHalf.length;
			o.bP1 = makeBuf(s.P1, GPUBufferUsage.VERTEX); o.bP2 = makeBuf(s.P2, GPUBufferUsage.VERTEX);
			o.bCol = makeBuf(u8colOv(s.lineCol), GPUBufferUsage.VERTEX); o.bHalf = makeBuf(s.lineHalf, GPUBufferUsage.VERTEX);
			o.bufs.push(o.bP1, o.bP2, o.bCol, o.bHalf);
		}
		return o;
	}
	function disposeOverlay(o) { if (o) for (const b of o.bufs) b.destroy(); }
	function setOverlay(s, fill) { disposeOverlay(overlay); overlay = s ? buildOverlaySlot(s, fill || [0.20, 0.45, 0.85, 0.32]) : null; }
	function setOverlayHi(s, fill) { disposeOverlay(overlayHi); overlayHi = s ? buildOverlaySlot(s, fill || [0.95, 0.55, 0.15, 0.6]) : null; }
	function setN02(scenes) { for (const o of n02) disposeOverlay(o); n02 = (scenes || []).map(s => buildOverlaySlot(s, [0, 0, 0, 0])); }
	// gintBld（gint ユーザー層の地形沿い境界線・点）＝独自 origin・BUILDING_WGSL 24B レイアウト・line/point 描画。null=解放。
	let gintBld = null;   // { origin, color, line?:{bPos,bSh,bAnc,count}, point?:{...} }
	function gbMesh(g) {
		if (!g || !g.pos?.length) return null;
		return { bPos: makeBuf(g.pos, GPUBufferUsage.VERTEX), bSh: makeBuf(g.shade, GPUBufferUsage.VERTEX), bAnc: makeBuf(g.anchor, GPUBufferUsage.VERTEX), count: g.pos.length / 3 };
	}
	function disposeGintBld() { if (gintBld) { for (const m of [gintBld.line, gintBld.point]) if (m) for (const b of [m.bPos, m.bSh, m.bAnc]) b.destroy(); gintBld = null; } }
	function setGintBld(data) {
		disposeGintBld();
		const line = gbMesh(data && data.lines), point = gbMesh(data && data.points);
		if (!line && !point) return;
		gintBld = { origin: data.origin, color: data.color || null, line, point };
	}
	// overlay 群を描く（基図の上・建物の下・深度off）。per-scene Frame＋DrawP を dynamic offset で切替。
	// 呼び出し側 draw() が Frame を書く（packFrame の scene origin 版）＝ここは stencil-then-cover＋線の発行だけ。
	function drawOverlay(pass, st, packF, zoom) {
		const scenes = [];
		if (view.showN02 !== false) for (const o of n02) if (o && zoom >= o.minZoom) scenes.push(o);
		if (overlay) scenes.push(overlay);
		if (overlayHi) scenes.push(overlayHi);
		if (!scenes.length) return;
		ensureOvFrameBG();
		const n = Math.min(scenes.length, MAX_OV);
		// per-scene の Frame＋DrawP を一括で書く（writeBuffer は pass より先に適用）
		ovParamCPU.fill(0);
		for (let i = 0; i < n; i++) {
			const o = scenes[i];
			device.queue.writeBuffer(ovFrameBuf, i * FRAME_SLOT, packF(o.origin));   // scene origin の Frame
			const po = i * (PARAM_SLOT / 4);
			ovParamCPU[po + 3] = 1;   // p0.w=グローバルα（LINE FS が乗算＝境界線の可視・fill(0)のままだと全消灯）
			ovParamCPU[po + 4] = o.fill[0]; ovParamCPU[po + 5] = o.fill[1]; ovParamCPU[po + 6] = o.fill[2]; ovParamCPU[po + 7] = o.fill[3];   // p1=塗り色
		}
		device.queue.writeBuffer(ovParamBuf, 0, ovParamCPU.buffer, 0, n * PARAM_SLOT);
		pass.setStencilReference(0);
		for (let i = 0; i < n; i++) {
			const o = scenes[i], fOff = i * FRAME_SLOT, pOff = i * PARAM_SLOT;
			if (o.fanCount) {   // 面：stencil fan → cover（stencil≠0 を塗り・0 へ戻す）
				pass.setPipeline(ovStencilPipe);
				pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]);
				pass.setVertexBuffer(0, o.fanBuf); pass.draw(o.fanCount);
				pass.setPipeline(ovCoverPipe);
				pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]);
				pass.draw(3);
			}
			if (o.lineCount) {   // 線（境界線 / N02 の鉄道線）＝LINE_WGSL 流用
				pass.setPipeline(ovLinePipe);
				pass.setBindGroup(0, ovFrameBG, [fOff]); pass.setBindGroup(1, ovParamBG, [pOff]);
				pass.setVertexBuffer(0, cornerBuf); pass.setVertexBuffer(1, o.bP1); pass.setVertexBuffer(2, o.bP2); pass.setVertexBuffer(3, o.bCol); pass.setVertexBuffer(4, o.bHalf);
				pass.draw(6, o.lineCount);
			}
		}
	}
	const cornerBuf = device.createBuffer({ size: CORNERS.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
	device.queue.writeBuffer(cornerBuf, 0, CORNERS);

	// 静的 view（色・見た目）と海ゲート＝gl/renderer.js と同じ意味論
	let view = { clear: null, land: null, atmo: null, bldColor: null };
	let sea = { li: -1, minzoom: Infinity };
	let bldFill = { li: -1 };   // 建物フットプリント塗りの li。3D（チルト）時は伏せる＝押し出しと二重表現になるため
	let fogDist = 0;            // フォグ距離の臨界減衰追従（gl/renderer.js と同じ）
	let elevScaleEff = 0;       // pitch で変調した実効スケール（真俯瞰では0＝平面）

	// --- 標高アトラス（r16float）＋地形メッシュ ---
	// GL 版と同じダブルバッファ：stage で舞台裏に組み、セルが揃ったら commit で一括スワップ（山影がパッと消えない）。
	const elevSampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	const dummyTex = device.createTexture({ size: [1, 1], format: "r16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummyView = dummyTex.createView();
	let elevTexObj = null, elevTexView = null, elev = { bounds: [0, 0, 1, 0], scale: 0, has: 0 }, terrain = null, elevStage = null;
	let bg0 = null;   // group(0) の4スロット bind group（elevTex 差し替えで作り直し）
	function rebuildBG0() {
		elevTexView = elevTexObj ? elevTexObj.createView() : null;   // view は1回だけ作って使い回す（gint の bind group キャッシュも view 同一性で安定）
		const view = (elev.has && elevTexView) ? elevTexView : dummyView;
		bg0 = {};
		for (const [name, idx] of Object.entries(SLOT)) bg0[name] = device.createBindGroup({
			layout: bgl0, entries: [
				{ binding: 0, resource: { buffer: frameBuf, offset: idx * FRAME_SLOT, size: FRAME_SLOT } },
				{ binding: 1, resource: view },
				{ binding: 2, resource: elevSampler },
			],
		});
	}
	rebuildBG0();
	const mkAtlasTex = (W, H) => device.createTexture({ size: [W, H], format: "r16float", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });   // 生成時ゼロ初期化＝海
	function writeCell(tex, cx, cy, data, cellRes) {
		device.queue.writeTexture({ texture: tex, origin: { x: cx * cellRes, y: cy * cellRes } },
			f32ToF16(data), { bytesPerRow: cellRes * 2 }, { width: cellRes, height: cellRes });
	}
	function atlasMeta(a, scale) {
		const span = a.cellSpan || 10;
		elev = { bounds: [a.originLng, a.originLat, a.cellsX * span, a.cellsY * span], scale, exag: a.exag || 1, has: 1, edgeFade: a.edgeFade || 0, liftBounds: a.liftBounds || null };
		const G = Math.min(1536, Math.max(768, 768 * Math.max(a.cellsX, a.cellsY)));
		buildTerrainMesh(a.originLng, a.originLat, a.cellsX * span, a.cellsY * span, G);
	}
	function setElevationAtlas(a, scale) {
		if (elevTexObj) elevTexObj.destroy();
		elevTexObj = mkAtlasTex(a.cellsX * a.cellRes, a.cellsY * a.cellRes);
		atlasMeta(a, scale);
		rebuildBG0();
	}
	function setElevationCell(cx, cy, data, cellRes) { if (elevTexObj) writeCell(elevTexObj, cx, cy, data, cellRes); }
	function setElevationAtlasStage(a, scale) {
		if (elevStage) elevStage.tex.destroy();
		elevStage = { tex: mkAtlasTex(a.cellsX * a.cellRes, a.cellsY * a.cellRes), a, scale };
	}
	function setElevationCellStage(cx, cy, data, cellRes) { if (elevStage) writeCell(elevStage.tex, cx, cy, data, cellRes); }
	function commitElevationStage() {
		if (!elevStage) return;
		if (elevTexObj) elevTexObj.destroy();
		elevTexObj = elevStage.tex;
		atlasMeta(elevStage.a, elevStage.scale);
		elevStage = null;
		rebuildBG0();
	}
	// 地形メッシュ＝単位格子 [0,1]²（G だけに依存）。窓の原点/幅は uniform（u_mesh＝Frame.mesh）で渡す
	// ＝標高アトラスの窓替え（パンのたびの atlasMeta）でメッシュを作り直さない。旧実装は毎回 lon/lat を
	// 焼いた頂点配列(G=1536 で 18.9MB)＋index(56.5MB)を作って GPU へ上げ直しており、広域×高チルトの
	// パンで「1窓替えごとに 75MB の GPU バッファ再確保」＝GPUメモリが単調に膨れる主因（GL 版 295c1e5 と同処置）。
	// G が変わる時だけ作り直す＝実質「起動時に一度」。頂点は uv 不変なので mesh 更新は Float32×4 の uniform だけ。
	function buildTerrainMesh(oLng, oLat, spanLng, spanLat, G) {
		if (terrain && terrain.G === G) { terrain.mesh = [oLng, oLat, spanLng, spanLat]; return; }
		const uv = new Float32Array(G * G * 2);
		for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const k = (j * G + i) * 2; uv[k] = i / (G - 1); uv[k + 1] = j / (G - 1); }
		const idx = new Uint32Array((G - 1) * (G - 1) * 6);
		let p = 0; for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) { const a = j * G + i, b = a + 1, c = a + G, d = c + 1; idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d; }
		if (terrain) { terrain.vbo.destroy(); terrain.ibo.destroy(); }
		const vbo = device.createBuffer({ size: uv.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
		const ibo = device.createBuffer({ size: idx.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(vbo, 0, uv);
		device.queue.writeBuffer(ibo, 0, idx);
		terrain = { vbo, ibo, count: idx.length, G, mesh: [oLng, oLat, spanLng, spanLat] };
	}

	// --- PLATEAU LOD2 建物（gl/renderer.js setPlateauMesh/setPlateauVis/plateauBboxVisible の移植）---
	// plateaux: key("区名#i") → { vbo(pos), nbo(normal), ibo, count, origin, bbox, ward, lodH, lodCounts, two }
	// plateauMasks: 区名 → { tex(r8unorm 被覆マスク), bbox }（基図建物 FS が uv 参照して footprint を伏せる）
	const plateaux = new Map();
	const plateauMasks = new Map();
	const plateauHidden = new Set();
	const maskSampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
	const dummyMask = device.createTexture({ size: [1, 1], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
	const dummyMaskView = dummyMask.createView();
	// building group(2)：mask params UBO（count vec4u + 4×bbox vec4f＝80B）＋4テクスチャ＋sampler。
	// active mask 集合が変わった時だけ作り直す（毎フレーム生成を避ける）。
	const maskParamBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const maskParamCPU = new ArrayBuffer(96);
	const maskParamU = new Uint32Array(maskParamCPU), maskParamF = new Float32Array(maskParamCPU);
	let maskBG = null, maskSig = "";
	function buildMaskBG(active, origin) {
		const sig = active.map(m => m.ward).join("|") + "@" + origin[0] + "," + origin[1];   // origin もシグネチャ＝シーン差し替えで off を焼き直す
		if (maskBG && sig === maskSig) return maskBG;   // active 集合・origin 不変＝作り直さない
		maskSig = sig;
		maskParamU[0] = active.length;
		for (let i = 0; i < MAX_PLATEAU_MASKS; i++) {
			// スロットは (off, inv)＝FS の uv = off + rel×inv。off=(origin−bboxMin)/span を JS の f64 で前計算＝
			// FS は原点相対の小値だけ扱う（絶対経緯度 varying の f32 ジッタ＝深ズームの点描ゴースト根治・gl 同文）。空きは uv 圏外。
			const bb = active[i] && active[i].bbox;
			const sx = bb ? bb[2] - bb[0] : 1, sy = bb ? bb[3] - bb[1] : 1;
			maskParamF[4 + i * 4] = bb ? (origin[0] - bb[0]) / sx : 2e9;
			maskParamF[5 + i * 4] = bb ? (origin[1] - bb[1]) / sy : 2e9;
			maskParamF[6 + i * 4] = bb ? 1 / sx : 0;
			maskParamF[7 + i * 4] = bb ? 1 / sy : 0;
		}
		device.queue.writeBuffer(maskParamBuf, 0, maskParamCPU);
		maskBG = device.createBindGroup({ layout: bglMask, entries: [
			{ binding: 0, resource: { buffer: maskParamBuf } },
			{ binding: 1, resource: active[0] ? active[0].view : dummyMaskView },
			{ binding: 2, resource: active[1] ? active[1].view : dummyMaskView },
			{ binding: 3, resource: active[2] ? active[2].view : dummyMaskView },
			{ binding: 4, resource: active[3] ? active[3].view : dummyMaskView },
			{ binding: 5, resource: maskSampler },
		] });
		return maskBG;
	}
	// gintBld 用の固定「マスク無し」BG（count=0・専用 param）＝building の maskParamBuf 共有によるフレーム毎 thrashing を避ける
	const emptyMaskParamBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });   // count=0 で初期化（createBuffer はゼロ）
	const emptyMaskBG = device.createBindGroup({ layout: bglMask, entries: [
		{ binding: 0, resource: { buffer: emptyMaskParamBuf } },
		{ binding: 1, resource: dummyMaskView }, { binding: 2, resource: dummyMaskView },
		{ binding: 3, resource: dummyMaskView }, { binding: 4, resource: dummyMaskView }, { binding: 5, resource: maskSampler },
	] });
	function freePlateauWard(ward) {
		for (const k of [...plateaux.keys()]) {
			if (k !== ward && !k.startsWith(ward + "#")) continue;
			const p = plateaux.get(k);
			p.vbo.destroy(); p.nbo.destroy(); p.ibo.destroy();
			plateaux.delete(k);
		}
		const m = plateauMasks.get(ward);
		if (m) { m.tex.destroy(); plateauMasks.delete(ward); }
		plateauHidden.delete(ward);
		maskSig = "\0";   // active 集合が変わり得る＝次フレーム再構築を強制
	}
	function setPlateauMesh(key, data) {
		if (!data) { freePlateauWard(key); return; }   // key=区名：全バッチ+マスク解放
		const old = plateaux.get(key);
		if (old) { old.vbo.destroy(); old.nbo.destroy(); old.ibo.destroy(); plateaux.delete(key); }
		if (data.pos?.length && data.idx?.length) {
			const nrm = data.nrm instanceof Int8Array ? data.nrm : Int8Array.from(data.nrm || new Int8Array(data.pos.length / 3 * 4));
			const vbo = device.createBuffer({ size: (data.pos.byteLength + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
			const nbo = device.createBuffer({ size: (nrm.byteLength + 3) & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
			const ibo = device.createBuffer({ size: (data.idx.byteLength + 3) & ~3, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
			device.queue.writeBuffer(vbo, 0, data.pos.buffer, data.pos.byteOffset, data.pos.byteLength);
			device.queue.writeBuffer(nbo, 0, nrm.buffer, nrm.byteOffset, nrm.byteLength);
			device.queue.writeBuffer(ibo, 0, data.idx.buffer, data.idx.byteOffset, data.idx.byteLength);
			plateaux.set(key, { vbo, nbo, ibo, count: data.idx.length, origin: data.origin || [0, 0, 0],
				bbox: data.bbox || [1e9, 1e9, -1e9, -1e9], ward: data.ward || String(key).split("#")[0],
				lodH: data.lodH || null, lodCounts: data.lodCounts || null, two: data.twoSided ? 1 : 0 });
		}
		// 被覆マスク（r8unorm・NEAREST）＝届いたバッチの断片(maskCells)だけをOR合成。
		// 旧・全量スナップショット差し替えはマスクがメッシュに先行し「基図は伏せたのにPLATEAUが無い」
		// 矩形の隙間を作った（demote/cancel/復元中断で顕在化）。断片方式ならマスクはメッシュと同時にしか
		// 育たず、解放は区単位（freePlateauWard＝メッシュとマスクを同時破棄）で対称＝隙間は構造的に出ない。
		if (data.ward && (data.maskCells || data.mask) && (data.maskN | 0) > 0 && data.maskBbox) {
			const N = data.maskN | 0;
			let m = plateauMasks.get(data.ward);
			if (!m || m.n !== N) {
				if (m) m.tex.destroy();
				const tex = device.createTexture({ size: [N, N], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
				m = { tex, view: tex.createView(), bbox: data.maskBbox, n: N, bytes: new Uint8Array(N * N) };
				plateauMasks.set(data.ward, m);
			}
			m.bbox = data.maskBbox;
			if (data.maskCells) { for (let i = 0; i < data.maskCells.length; i++) { const c = data.maskCells[i]; if (c < m.bytes.length) m.bytes[c] = 255; } }
			else for (let i = 0; i < data.mask.length && i < m.bytes.length; i++) if (data.mask[i]) m.bytes[i] = 255;   // 旧worker互換（全量OR＝単調なので破壊しない）
			device.queue.writeTexture({ texture: m.tex }, m.bytes, { bytesPerRow: N, rowsPerImage: N }, [N, N]);
			maskSig = "\0";   // 次フレーム再構築
		}
	}
	function setPlateauVis(ward, on) {
		if (on) plateauHidden.delete(ward); else plateauHidden.add(ward);
		maskSig = "\0";   // 非表示区はマスクスロットから外す＝基図建物が戻る（次フレーム再構築）
	}
	// バッチ bbox（経緯度deg）の可視判定＝gl/renderer.js plateauBboxVisible と同一（4隅+中心を投影）
	function plateauBboxVisible(st, bbox, center, pad) {
		if (center[0] >= bbox[0] && center[0] <= bbox[2] && center[1] >= bbox[1] && center[1] <= bbox[3]) return true;
		const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]], [(bbox[0] + bbox[2]) * 0.5, (bbox[1] + bbox[3]) * 0.5]];
		let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, nf = 0;
		for (const q of pts) {
			const [sx, sy, f] = project(st, q[0], q[1]);
			if (f < 0) continue;
			nf++;
			if (sx < minx) minx = sx; if (sx > maxx) maxx = sx;
			if (sy < miny) miny = sy; if (sy > maxy) maxy = sy;
		}
		if (!nf) return false;
		return !(maxx < -pad || minx > st.W + pad || maxy < -pad || miny > st.H + pad);
	}

	// --- シーン（classic merge）：slot → { origin, draws, bld } ---
	const scenes = {
		base: { origin: [0, 0], draws: [], bld: null },
		main: { origin: [0, 0], draws: [], bld: null },
	};
	function makeBuf(data, usage) {
		const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
		return b;
	}
	const u8col = col => col instanceof Uint8Array ? col : Uint8Array.from(col, v => Math.max(0, Math.min(255, Math.round(v * 255))));   // geojson 由来 float32 の保険
	function disposeFadePrev(slot) {
		const fp = scenes[slot].fadePrev;
		if (!fp) return;
		for (const d of fp.draws) for (const b of d.bufs) b.destroy();
		if (fp.bld) for (const b of fp.bld.bufs) b.destroy();
		scenes[slot].fadePrev = null;
	}
	function disposeSlot(slot) {
		disposeFadePrev(slot);
		for (const d of scenes[slot].draws) for (const b of d.bufs) b.destroy();
		if (scenes[slot].bld) for (const b of scenes[slot].bld.bufs) b.destroy();
		scenes[slot] = { origin: scenes[slot].origin, draws: [], bld: null };
	}
	function setScene(s, slot = "main") {
		if (!scenes[slot]) return;   // overlay 等の未知スロットは対象外
		// クロスフェード：main の同一原点差し替え（ロード流入中の典型）は旧シーンを FADE_MS だけ温存し
		// 新シーンをα昇順で重ねる＝classic merge の「ポンッ」を溶かす（モバイルのパラパラ感対策）。
		// 原点が変わる大移動は従来どおり即替え（旧シーンの Frame origin が異なり二重描画できないため）。
		let keepPrev = null;
		if (slot === "main" && scenes[slot].draws.length && scenes[slot].origin && s.origin
			&& scenes[slot].origin[0] === s.origin[0] && scenes[slot].origin[1] === s.origin[1]) {
			disposeFadePrev(slot);
			keepPrev = { draws: scenes[slot].draws, bld: scenes[slot].bld };
			scenes[slot].draws = []; scenes[slot].bld = null;   // disposeSlot に破棄させない（付け替え）
		}
		disposeSlot(slot);
		const draws = [];
		for (const L of s.layers || []) {
			if (!L) continue;
			if (L.kind === "fill") {
				if (!L.pos.length) continue;
				const bPos = makeBuf(L.pos, GPUBufferUsage.VERTEX), bCol = makeBuf(u8col(L.col), GPUBufferUsage.VERTEX);
				const hasIdx = L.idx && L.idx.length;
				const bIdx = hasIdx ? makeBuf(L.idx instanceof Uint32Array ? L.idx : Uint32Array.from(L.idx), GPUBufferUsage.INDEX) : null;
				draws.push({ kind: "fill", li: L.li, bufs: bIdx ? [bPos, bCol, bIdx] : [bPos, bCol], bPos, bCol, bIdx, count: hasIdx ? L.idx.length : L.pos.length / 2 });
			} else {
				if (!L.half.length) continue;
				const bP1 = makeBuf(L.P1, GPUBufferUsage.VERTEX), bP2 = makeBuf(L.P2, GPUBufferUsage.VERTEX);
				const bCol = makeBuf(u8col(L.col), GPUBufferUsage.VERTEX), bHalf = makeBuf(L.half, GPUBufferUsage.VERTEX);
				draws.push({ kind: "line", li: L.li, bufs: [bP1, bP2, bCol, bHalf], bP1, bP2, bCol, bHalf, count: L.half.length });
			}
		}
		let bld = null;
		if (s.buildings && s.buildings.pos.length) {
			const bPos = makeBuf(s.buildings.pos, GPUBufferUsage.VERTEX), bSh = makeBuf(s.buildings.shade, GPUBufferUsage.VERTEX), bAnc = makeBuf(s.buildings.anchor, GPUBufferUsage.VERTEX);
			bld = { bufs: [bPos, bSh, bAnc], bPos, bSh, bAnc, count: s.buildings.pos.length / 3 };
		}
		scenes[slot] = { origin: s.origin, draws, bld, fadePrev: keepPrev, fadeT0: keepPrev ? performance.now() : 0 };
	}

	// frame UBO の詰め物（wgsl.js Frame と厳密対応）。RTE 錨（clipT/originPt/trig）は CPU double で。
	const frameF32 = new Float32Array(FRAME_F32);
	function packFrame(st, origin, fogNear, fogFar, fogColor, logCoef, dpr, mesh) {
		const f = frameF32;
		f.set(st.mvp, 0);
		f.set(st.invMvp, 16);
		const oPt = lonlatTo3D(origin[0], origin[1]);
		const cT = mat.transform(st.mvp, [oPt[0], oPt[1], oPt[2], 1]);
		f[32] = cT[0]; f[33] = cT[1]; f[34] = cT[2]; f[35] = cT[3];
		const lr = origin[0] * Math.PI / 180, br = origin[1] * Math.PI / 180;
		f[36] = Math.cos(lr); f[37] = Math.sin(lr); f[38] = Math.cos(br); f[39] = Math.sin(br);
		f[40] = oPt[0]; f[41] = oPt[1]; f[42] = oPt[2]; f[43] = 0;
		f[44] = st.eye[0]; f[45] = st.eye[1]; f[46] = st.eye[2]; f[47] = 0;
		f[48] = origin[0]; f[49] = origin[1];
		f[50] = canvas.width; f[51] = canvas.height;
		f[52] = fogColor[0]; f[53] = fogColor[1]; f[54] = fogColor[2]; f[55] = 0;
		f[56] = fogNear; f[57] = fogFar; f[58] = logCoef; f[59] = dpr;
		f[60] = elev.bounds[0]; f[61] = elev.bounds[1]; f[62] = elev.bounds[2]; f[63] = elev.bounds[3];
		f[64] = elevScaleEff; f[65] = elev.has; f[66] = elev.edgeFade || 0; f[67] = 0;
		// mesh（地形メッシュの窓：原点lon/lat＋幅deg）＝terrain slot のみ。他スロットは 0（未使用）
		f[68] = mesh ? mesh[0] : 0; f[69] = mesh ? mesh[1] : 0; f[70] = mesh ? mesh[2] : 0; f[71] = mesh ? mesh[3] : 0;
		return f;
	}
	// DrawP N_ROLESスロットを一括で書く（256Bストライド・各48B使用）
	const paramF32 = new Float32Array(PARAM_SLOT / 4 * N_ROLES);
	function packParams({ cityLift, waterLift, exact, land, bldColor, contour, liftBounds, fadeK = 1 }) {
		const f = paramF32; f.fill(0);
		const at = (role, vals) => { const o = role * (PARAM_SLOT / 4); for (let i = 0; i < vals.length; i++) f[o + i] = vals[i]; };
		at(ROLE.normal, [0, cityLift, 0, 1]);
		at(ROLE.water, [0, waterLift, exact, 1]);
		at(ROLE.seaFb, [1, waterLift, exact, 1]);
		const hy = view.hypso;
		at(ROLE.terrain, [land[0], land[1], land[2], 0,
			hy ? hy.color[0] : 0, hy ? hy.color[1] : 0, hy ? hy.color[2] : 0, hy ? (hy.amount ?? 0.5) : 0,
			hy ? 1 / (hy.max || 3000) : 0, 0, 0, 0]);
		at(ROLE.bld, [bldColor[0], bldColor[1], bldColor[2], 1]);
		at(ROLE.contour, [contour.color[0], contour.color[1], contour.color[2], contour.interval,
			contour.major, contour.alpha, 0, 0]);
		// PLATEAU: p0=liftBounds（DTM保証域・無ければ全0＝リフト無し）, p1=bldColor
		const lb = liftBounds || [0, 0, 0, 0];
		at(ROLE.plateau, [lb[0], lb[1], lb[2], lb[3], bldColor[0], bldColor[1], bldColor[2], 0]);
		// クロスフェード中の新シーン用＝通常ロールの複製＋p0.w=α（旧シーンは通常ロールでα1のまま下に描く）
		at(ROLE.fadeNormal, [0, cityLift, 0, fadeK]);
		at(ROLE.fadeWater, [0, waterLift, exact, fadeK]);
		at(ROLE.fadeSeaFb, [1, waterLift, exact, fadeK]);
		at(ROLE.fadeBld, [bldColor[0], bldColor[1], bldColor[2], fadeK]);
		return f;
	}

	// MSAA カラー＋深度ターゲット（canvas 寸法に追随）。resolve 先は毎フレーム getCurrentTexture。
	let msaa = null;
	function targets(W, H) {
		if (!msaa || msaa.w !== W || msaa.h !== H) {
			if (msaa) { msaa.tex.destroy(); msaa.depth.destroy(); }
			const tex = device.createTexture({ size: [W, H], sampleCount: SAMPLES, format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
			const depth = device.createTexture({ size: [W, H], sampleCount: SAMPLES, format: DEPTH, usage: GPUTextureUsage.RENDER_ATTACHMENT });
			msaa = { tex, depth, view: tex.createView(), depthView: depth.createView(), w: W, h: H };
		}
		return msaa;
	}

	// frame＝開いたコマンドエンコーダ＋描画の的（gint が自分の render pass を足す口）。flush() で resolve→submit。
	let frame = null, gctx = null;
	function draw(cam, opts) {
		if (frame) flush();   // 保険：前フレームの flush 漏れ（例外経路）を清算してから
		const W = canvas.width, H = canvas.height;
		if (!W || !H) return false;
		const st = cameraState(cam, W, H);
		// フォグ距離の臨界減衰追従（gl/renderer.js draw と同式・同閾値）
		if (!fogDist) fogDist = st.camDist;
		else fogDist += (st.camDist - fogDist) * 0.18;
		if (Math.abs(st.camDist - fogDist) < st.camDist * 0.002) fogDist = st.camDist;
		st.fogDist = fogDist;
		const fogAnimating = fogDist !== st.camDist;
		// 視程下限のチルト係数／真俯瞰では標高オフ・傾けるほどフェードイン（gl/renderer.js と同式）
		const pfFog = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.35) / 0.45));
		const pt = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.06) / 0.14));
		const pf = pt * pt * (3 - 2 * pt);
		elevScaleEff = elev.scale * pf;
		const land = view.land || [0.96, 0.96, 0.95, 1], atmo = view.atmo || [0.45, 0.62, 0.95, 0.6];
		const flat2d = (cam.pitch || 0) < 0.02 && cam.zoom >= 9;
		const c = flat2d ? [land[0], land[1], land[2], 1] : (view.clear || [1, 1, 1, 1]);
		const _limb = Math.sqrt(Math.max((1 + st.camDist) * (1 + st.camDist) - 1, 1e-12));
		const logCoef = 2.0 / Math.log2(_limb * 1.15 + st.camDist + 1.0);
		const fogFarCap = Math.max(st.fogDist * 5.0, 0.026 * pfFog);   // fill/line/terrain 共通の終端＝線が地形に厳密追随
		const terrainActive = !!(terrain && elev.has && elevScaleEff > 1e-9) && !(opts && opts.noTerrain);
		const terrainDepth = terrainActive;   // 地形の深度書き＝尾根の遮蔽（gl/renderer.js と同じ全ズーム）
		// z14切替のランプ化：DSM帯⇄都市帯のリフト（川面30⇄10m・接地0⇄5m）を z13.5→14 の0.5幅で連続モーフ＝
		// keepFine保持のズームアウトで露出した「跨いだ瞬間の段差ポップ」対策。両端値は実測チューニングのまま
		//（z≥14とz≤13.5の絵は従来と完全一致）。gl/renderer.js と同式。
		const cityK = terrainDepth ? Math.max(0, Math.min(1, (cam.zoom - 13.5) / 0.5)) : 0;
		const cityLift = 5 * cityK;
		const waterLiftM = terrainDepth ? WATER_LIFT_M + (CITY_WATER_LIFT_M - WATER_LIFT_M) * cityK : CITY_WATER_LIFT_M;
		const hideBldFill = bldFill.li >= 0 && (cam.pitch || 0) >= 0.02;
		const dpr = cam.dpr || 1;
		const mainOrigin = scenes.main.origin || [0, 0];
		// Frame 4スロット：base/main=fill/line（fogFar=cap）、terrain=遠山ブルー、bld=既定fog(2.5×/14×)
		device.queue.writeBuffer(frameBuf, SLOT.base * FRAME_SLOT, packFrame(st, scenes.base.origin || [0, 0], st.fogDist * 2.5, fogFarCap, land, logCoef, dpr));
		device.queue.writeBuffer(frameBuf, SLOT.main * FRAME_SLOT, packFrame(st, mainOrigin, st.fogDist * 2.5, fogFarCap, land, logCoef, dpr));
		const dc = view.distColor || [0.63, 0.72, 0.83];   // 空気遠近法＝遠くの山は青く霞む
		device.queue.writeBuffer(frameBuf, SLOT.terrain * FRAME_SLOT, packFrame(st, mainOrigin, Math.max(st.fogDist * 1.2, 0.008 * pfFog), fogFarCap, dc, logCoef, dpr, terrain ? terrain.mesh : null));
		device.queue.writeBuffer(frameBuf, SLOT.bld * FRAME_SLOT, packFrame(st, mainOrigin, st.fogDist * 2.5, st.fogDist * 14.0, land, logCoef, dpr));
		// 等高線：真俯瞰でだけ茶の等高線（gl/renderer.js と同式のフェード・間隔）
		const ps = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.01) / 0.05));
		const zf = 1 - Math.max(0, Math.min(1, (cam.zoom - 17.5) / 1.5));
		const cAlpha = (elev.has && !(opts && opts.noTerrain) && view.showContour === true) ? (1 - ps * ps * (3 - 2 * ps)) * zf : 0;
		const iv = cam.zoom >= 15 ? 15 : cam.zoom >= 12 ? 30 : 60;
		// クロスフェード進行（main の同一原点差し替え）：期限切れは旧を破棄、進行中は fadeK(0→1) を fade ロールへ
		let fadeK = 1, fading = false;
		if (scenes.main.fadePrev) {
			const fa = performance.now() - scenes.main.fadeT0;
			if (fa >= FADE_MS) disposeFadePrev("main");
			else { fadeK = fa / FADE_MS; fading = true; }
		}
		device.queue.writeBuffer(paramBuf, 0, packParams({
			fadeK,
			cityLift, waterLift: waterLiftM, exact: terrainDepth ? 1 : 0,
			land, bldColor: view.bldColor || [0.86, 0.86, 0.85],
			contour: { color: view.contourColor || [0.42, 0.30, 0.18], interval: iv, major: iv * 5.0, alpha: cAlpha * (view.contourAlpha || 1) },
			liftBounds: elev.liftBounds,   // PLATEAU 接地リフトの DTM 保証域
		}));
		if (!flat2d) {
			const g = new Float32Array(24);
			g.set(st.invMvp, 0);
			g[16] = land[0]; g[17] = land[1]; g[18] = land[2]; g[19] = land[3];
			g[20] = atmo[0]; g[21] = atmo[1]; g[22] = atmo[2]; g[23] = atmo[3];
			device.queue.writeBuffer(globeBuf, 0, g);
		}
		// 星空劇場（z<5）：星/夜面共通の出現フェード（gl/renderer.js と同式）。恒星時 GMST の天球回転・太陽方位も。
		const worldFade = !flat2d && cam.zoom < 5 ? Math.min(1, (5 - cam.zoom) / 0.5) : 0;
		const starFade = (stars || constel || planets) ? worldFade : 0;
		const showConst = view.showConst && (constel || ecliptic || celeq);
		if (worldFade > 0) {
			const now = Date.now();
			const gmst = (((18.697374 + 24.0657098 * (now / 864e5 + 2440587.5 - 2451545.0)) * 15) % 360) * Math.PI / 180;
			const skyK = (0.4 + 0.3 * cam.zoom) / 1.6;   // 遠近表現（ズームに線形＝地球は 2^z）
			const dDay = now / 864e5;   // 夜面の太陽直下点（v1 nightJSON と同式）
			const sunLat = 23.4 * Math.sin((dDay / 365.24 % 1 - 0.225) * 2 * Math.PI) * Math.PI / 180;
			const sunLng = (((dDay % 1 * -360 + 360) % 360) - 180) * Math.PI / 180;
			const cs = Math.cos(sunLat);
			const s = skyCPU;
			s.set(st.mvp, 0); s.set(st.invMvp, 16);
			s[32] = Math.cos(gmst); s[33] = Math.sin(gmst);
			s[34] = starFade; s[35] = skyK;
			s[36] = W; s[37] = H;
			s[40] = cs * Math.cos(sunLng); s[41] = Math.sin(sunLat); s[42] = cs * Math.sin(sunLng);
			s[43] = 0.5 * worldFade;   // 夜面 50% × 出現フェード
			device.queue.writeBuffer(skyBuf, 0, skyCPU);
		}

		const t = targets(W, H);
		const enc = device.createCommandEncoder();
		if (!frame1Scoped) { frame1Scoped = 1; device.pushErrorScope("validation"); }   // 初回フレーム全体を包む（pop は flush）
		if (tq) { tq.idx = 0; tq.spans.length = 0; }   // フレーム開始＝計測枠をリセット（draw→gint→flush で1周）
		const passDesc = {
			timestampWrites: passTS("map"),
			colorAttachments: [{
				view: t.view,
				loadOp: "clear",
				clearValue: { r: c[0] * c[3], g: c[1] * c[3], b: c[2] * c[3], a: c[3] },
				storeOp: "store",   // gint パスが同じ的に重ねる＝resolve は flush() の終端パスで（GL の「地図の後に gint」と同順）
			}],
			depthStencilAttachment: {
				view: t.depthView,
				depthLoadOp: "clear", depthClearValue: 1.0, depthStoreOp: "store",   // gint の隠線（地形深度テスト）が読む
				stencilLoadOp: "clear", stencilStoreOp: "discard",                    // renderer 自身は stencil 不使用（gint パスが自前で clear）
			},
		};
		let pass;
		try { pass = enc.beginRenderPass(passDesc); }
		catch (err) {   // timestampWrites 非対応の環境＝TQ を畳んで同フレームを無計測で続行（絵は止めない）
			if (!tq) throw err;
			tqOff(err);
			delete passDesc.timestampWrites;
			pass = enc.beginRenderPass(passDesc);
		}
		// 星空劇場（z<5）：globe より先に描く＝陸には上書きされ・大気ハローは星の上に薄く重なり・宇宙には星が残る
		if (starFade > 0) {
			pass.setBindGroup(0, skyBG);
			if (stars) { pass.setPipeline(starsPipe); pass.setVertexBuffer(0, stars.buf); pass.draw(6, stars.count); }
			if (planets) { pass.setPipeline(starsPipe); pass.setVertexBuffer(0, planets.buf); pass.draw(6, planets.count); }
			if (showConst) {   // 星座線・黄道・天の赤道（view.showConst のみ・色は per-buffer UBO）
				pass.setPipeline(starLinePipe);
				for (const [b, role] of [[constel, LINE_ROLE.constel], [ecliptic, LINE_ROLE.ecliptic], [celeq, LINE_ROLE.celeq]]) {
					if (!b) continue;
					pass.setBindGroup(1, skyLineBG[role]);
					pass.setVertexBuffer(0, b.buf);
					pass.draw(b.count);
				}
			}
		}
		if (!flat2d) {   // 球体本体：land基色を縁(リム)まで敷く。2D高速パス時は clear で代替＝省略
			pass.setPipeline(globePipe);
			pass.setBindGroup(0, globeBG);
			pass.draw(3);
		}
		// 地形サーフェス（標高変位＋hillshade）。深度を書く＝尾根の向こうの基図・建物が隠れる
		if (terrainActive) {
			pass.setPipeline(terrainPipe);
			pass.setBindGroup(0, bg0.terrain);
			pass.setBindGroup(1, paramBG[ROLE.terrain]);
			pass.setVertexBuffer(0, terrain.vbo);
			pass.setIndexBuffer(terrain.ibo, "uint32");
			pass.drawIndexed(terrain.count);
		}
		// 等高線：真俯瞰でだけ敷く（ベクタの下＝道路/区界は上に乗る）。深度無関係
		if (cAlpha > 0.003 && cam.zoom >= 9) {
			pass.setPipeline(contourPipe);
			pass.setBindGroup(0, bg0.main);   // invMvp と elev だけ使う＝main スロットで足りる
			pass.setBindGroup(1, paramBG[ROLE.contour]);
			pass.draw(3);
		}
		// 基図（塗り/線）：ペインタ順。山岳ビュー＝地形深度でテストだけ（書かない）＝尾根の向こうが透けない
		const slots = (opts && opts.skipMain) ? ["base"] : (opts && opts.skipBase) ? ["main"] : ["base", "main"];
		const mainLinesOn = slots.indexOf("main") >= 0 && scenes.main.draws.length > 0;
		const fillPipe = terrainDepth ? fillTest : fillOff;
		const linePipe = terrainDepth ? lineTest : lineOff;
		for (const slot of slots) {
			const scene = scenes[slot];
			// フェード中の main＝旧シーン（通常ロール・α1）を先に敷き、新シーンを fade ロール（α=fadeK）で重ねる
			const passes = (slot === "main" && fading)
				? [[scene.fadePrev.draws, scene.fadePrev.bldIgnored, false], [scene.draws, null, true]]
				: [[scene.draws, null, false]];
			for (const [drawList,, useFade] of passes) {
			if (!drawList.length) continue;
			for (const d of drawList) {
				if (d.kind === "fill") {
					const seaFB = seaFbReal(d.li) != null;   // 図郭外フォールバック水域（標高ゲート付き全面WA）
					const waterC = d.li === sea.li || d.li === sea.li2;
					if ((seaFB || waterC) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（紙の海）
					if (hideBldFill && d.li === bldFill.li) continue;            // 3D時＝フットプリント塗りを伏せる
					// 水面は「リフトして深度テスト維持」＝尾根の遮蔽を保ちつつDSMノイズ瘤を沈める。厳密深度は水域のみ
					pass.setPipeline(terrainDepth && (waterC || seaFB) ? fillTestExact : fillPipe);
					pass.setBindGroup(0, bg0[slot]);
					pass.setBindGroup(1, paramBG[useFade ? (seaFB ? ROLE.fadeSeaFb : waterC ? ROLE.fadeWater : ROLE.fadeNormal) : (seaFB ? ROLE.seaFb : waterC ? ROLE.water : ROLE.normal)]);
					pass.setVertexBuffer(0, d.bPos);
					pass.setVertexBuffer(1, d.bCol);
					if (d.bIdx) { pass.setIndexBuffer(d.bIdx, "uint32"); pass.drawIndexed(d.count); }
					else pass.draw(d.count);
				} else {
					if (slot === "base" && mainLinesOn) continue;   // 本命の線が出ている間は下地の線を伏せる
					pass.setPipeline(linePipe);
					pass.setBindGroup(0, bg0[slot]);
					pass.setBindGroup(1, paramBG[useFade ? ROLE.fadeNormal : ROLE.normal]);   // 線の接地リフト＝cityLift（fill の通常塗りと同じ）
					pass.setVertexBuffer(0, cornerBuf);
					pass.setVertexBuffer(1, d.bP1);
					pass.setVertexBuffer(2, d.bP2);
					pass.setVertexBuffer(3, d.bCol);
					pass.setVertexBuffer(4, d.bHalf);
					pass.draw(6, d.count);
				}
			}
			}
		}
		// overlay（外部ベクタ=geopbf/e-Stat/N02）：基図の上・建物の下・深度off。per-scene origin の Frame を渡す
		drawOverlay(pass, st, (origin) => packFrame(st, origin, st.fogDist * 2.5, st.fogDist * 14.0, land, logCoef, dpr), cam.zoom || 0);
		// 建物（3D押し出し）：深度で前後関係を解決（地形・尾根にも遮蔽される）。真俯瞰では描かない＝平面地図
		const show3d = (cam.pitch || 0) >= 0.02;
		// PLATEAU の実フットプリントが立つ区の被覆マスク（最大4・非表示区は除外）＝基図建物を伏せる
		const activeMasks = [...plateauMasks.entries()].filter(([w]) => !plateauHidden.has(w)).map(([, m]) => m).slice(0, MAX_PLATEAU_MASKS);
		const bldMaskBG = buildMaskBG(activeMasks, scenes.main.origin || [0, 0]);
		const bld = show3d && !(opts && opts.skipMain) ? scenes.main.bld : null;
		const bldPrev = show3d && !(opts && opts.skipMain) && fading ? scenes.main.fadePrev.bld : null;
		if (bldPrev) {   // フェード中＝旧建物を通常ロール（α1）で先に（新は fadeBld で重なる＝クロスフェード）
			pass.setPipeline(bldPipe);
			pass.setBindGroup(0, bg0.bld);
			pass.setBindGroup(1, paramBG[ROLE.bld]);
			pass.setBindGroup(2, bldMaskBG);
			pass.setVertexBuffer(0, bldPrev.bPos);
			pass.setVertexBuffer(1, bldPrev.bSh);
			pass.setVertexBuffer(2, bldPrev.bAnc);
			pass.draw(bldPrev.count);
		}
		if (bld) {
			pass.setPipeline(bldPipe);
			pass.setBindGroup(0, bg0.bld);
			pass.setBindGroup(1, paramBG[fading ? ROLE.fadeBld : ROLE.bld]);
			pass.setBindGroup(2, bldMaskBG);   // PLATEAU 区の footprint を伏せる（count=0 なら素通し）
			pass.setVertexBuffer(0, bld.bPos);
			pass.setVertexBuffer(1, bld.bSh);
			pass.setVertexBuffer(2, bld.bAnc);
			pass.draw(bld.count);
		}
		// gintBld（gint ユーザー層の地形沿い境界線/点＝moj筆ドレープ）：独自 origin・深度で地形/尾根に遮蔽・マスク無し。
		// ★常時描画（show3d/skipMain ゲート無し＝GL 同等）＝真俯瞰(elevScaleEff=0)は海面の平面、チルトで地形へ立ち上がる（GL と同じモーフ）。
		if (gintBld && (gintBld.line || gintBld.point)) {
			ensureOvFrameBG();
			const gc = gintBld.color || view.bldColor || [0.86, 0.86, 0.85];
			device.queue.writeBuffer(ovFrameBuf, GB_SLOT * FRAME_SLOT, packFrame(st, gintBld.origin, st.fogDist * 2.5, st.fogDist * 14.0, land, logCoef, dpr));
			const gpo = GB_SLOT * (PARAM_SLOT / 4);
			ovParamCPU[gpo] = gc[0]; ovParamCPU[gpo + 1] = gc[1]; ovParamCPU[gpo + 2] = gc[2]; ovParamCPU[gpo + 3] = 1;   // p0=bldColor＋w=グローバルα（BUILDING FS が乗算）
			device.queue.writeBuffer(ovParamBuf, GB_SLOT * PARAM_SLOT, ovParamCPU.buffer, GB_SLOT * PARAM_SLOT, PARAM_SLOT);
			pass.setBindGroup(0, ovFrameBG, [GB_SLOT * FRAME_SLOT]);
			pass.setBindGroup(1, ovParamBG, [GB_SLOT * PARAM_SLOT]);
			pass.setBindGroup(2, emptyMaskBG);   // マスク無し（count=0＝footprint 伏せ無し・固定BGで thrashing 回避）
			if (gintBld.line) { pass.setPipeline(gbLinePipe); pass.setVertexBuffer(0, gintBld.line.bPos); pass.setVertexBuffer(1, gintBld.line.bSh); pass.setVertexBuffer(2, gintBld.line.bAnc); pass.draw(gintBld.line.count); }
			if (gintBld.point) { pass.setPipeline(gbPointPipe); pass.setVertexBuffer(0, gintBld.point.bPos); pass.setVertexBuffer(1, gintBld.point.bSh); pass.setVertexBuffer(2, gintBld.point.bAnc); pass.draw(gintBld.point.count); }
		}
		// PLATEAU LOD2 建物メッシュ（任意三角形・面法線陰影）。バッチ単位フラスタムカリング＋高さLOD打ち切り。
		// per-batch uniform（meshOrigin/clipMesh/cullBack）は dynamic offset UBO で1バッチ1スロット。
		// ⚠skipMain では消さない（GL 867 と同等）：skipMain＝ズームアウト滑走中の「古いタイルシーン退場」であり、
		// PLATEAU は別ソース＝退場対象でない。移植時にここへ !skipMain を発明していた＝滑走中に街ごと消える
		// 「シーン抜け」（gpu単独・東京駅〜丸の内で実測）の正体。基図退場中も街は立ち続けるのが GL の挙動。
		if (plateaux.size && show3d) {
			const pad = 0.5 * Math.max(st.W, st.H);   // 高層ビルの頭のはみ出し余白（半画面）
			const mppx = 156543.03392 * 0.819 / Math.pow(2, cam.zoom || 0);   // 画面1pxが何m（LOD打ち切りの物差し）
			const cosLat = Math.cos((cam.center[1] || 0) * Math.PI / 180);
			// ① CPU カリング＋LOD＝可視バッチ列を作り、per-batch uniform を一括で書く（writeBuffer は pass より先に適用）
			const draws = [];
			for (const p of plateaux.values()) {
				if (draws.length >= MAX_PL_BATCH) { console.warn(`[gpu] PLATEAU 可視バッチ ${MAX_PL_BATCH} 超過＝打ち切り`); break; }
				if (plateauHidden.has(p.ward)) continue;
				if (!plateauBboxVisible(st, p.bbox, cam.center, pad)) continue;
				let count = p.count;
				if (p.lodH && !p.two) {   // index は建物高さ降順＝先頭 count で「高さ閾値以上だけ」（橋梁 two は全描画）
					const dm = Math.hypot(((p.bbox[0] + p.bbox[2]) / 2 - cam.center[0]) * 111320 * cosLat, ((p.bbox[1] + p.bbox[3]) / 2 - cam.center[1]) * 111320);
					const minH = mppx * (1 + dm / 4000);
					let li = 0;
					for (let i = p.lodH.length - 1; i > 0; i--) if (p.lodH[i] <= minH) { li = i; break; }
					count = p.lodCounts[li];
					if (!count) continue;
				}
				const slot = draws.length, o = slot * (PL_BATCH_SLOT / 4);
				const cM = mat.transform(st.mvp, [p.origin[0], p.origin[1], p.origin[2], 1]);   // clip錨を CPU(double) で
				plBatchCPU[o] = p.origin[0]; plBatchCPU[o + 1] = p.origin[1]; plBatchCPU[o + 2] = p.origin[2]; plBatchCPU[o + 3] = p.two ? 0 : 1;   // meshOrigin.xyz + cullBack
				plBatchCPU[o + 4] = cM[0]; plBatchCPU[o + 5] = cM[1]; plBatchCPU[o + 6] = cM[2]; plBatchCPU[o + 7] = cM[3];   // clipMesh
				draws.push({ p, count, slot });
			}
			if (draws.length) {
				device.queue.writeBuffer(plBatchBuf, 0, plBatchCPU.buffer, 0, draws.length * PL_BATCH_SLOT);
				pass.setPipeline(plateauPipe);
				pass.setBindGroup(0, bg0.bld);              // フレーム共通（mvp/eye/fog/elev）は建物と同一
				pass.setBindGroup(1, paramBG[ROLE.plateau]); // p0=liftBounds, p1=bldColor
				for (const { p, count, slot } of draws) {
					pass.setBindGroup(2, plBatchBG, [slot * PL_BATCH_SLOT]);   // dynamic offset＝このバッチの uniform
					pass.setVertexBuffer(0, p.vbo);
					pass.setVertexBuffer(1, p.nbo);
					pass.setIndexBuffer(p.ibo, "uint32");
					pass.drawIndexed(count);
				}
			}
		}
		// 夜面（星空劇場と同じ z<4 ゲート・同じフェード）：現在時刻の太陽を平行光源に夜半球を夜紺で減光。
		// 基図の全レイヤの上に重ねる（この後の gint 海岸線パスは loadOp:load で夜面の上に描く＝GL と同順）。
		if (worldFade > 0) {
			pass.setPipeline(nightPipe);
			pass.setBindGroup(0, skyBG);
			pass.draw(3);
		}
		pass.end();
		frame = { enc, colorView: t.view, depthView: t.depthView, w: W, h: H };
		// gint の深度統合コンテキスト（GL renderer の gintCtx と同意味論＝terrainDepth の間だけ非null）。
		// elevView は安定参照（rebuildBG0 で1回生成）＝gint 側の bind group キャッシュが毎フレーム破れない。
		gctx = terrainDepth ? {
			terrainDepth: true, logCoef, fogFar: fogFarCap,
			elevView: (elev.has && elevTexView) ? elevTexView : null, elevSampler,
			elevBounds: elev.bounds, elevScale: elevScaleEff, hasElev: elev.has, edgeFade: elev.edgeFade || 0,
		} : null;
		return fogAnimating || fading;   // fading＝クロスフェード進行中も連続フレーム
	}
	// フレーム確定：MSAA を canvas へ resolve して submit（gint パスが足された後＝地図と同フレーム同カメラの1枚）。
	function flush() {
		if (!frame) return;
		const flushDesc = {
			timestampWrites: passTS("map"),   // resolve の実費も map に計上
			colorAttachments: [{ view: frame.colorView, resolveTarget: ctx.getCurrentTexture().createView(), loadOp: "load", storeOp: "discard" }],
		};
		let pass;
		try { pass = frame.enc.beginRenderPass(flushDesc); }
		catch (err) {
			if (!tq) throw err;
			tqOff(err);
			delete flushDesc.timestampWrites;
			pass = frame.enc.beginRenderPass(flushDesc);
		}
		pass.end();
		let st = null;
		if (tq && tq.idx) {
			frame.enc.resolveQuerySet(tq.qs, 0, tq.idx, tq.resolve, 0);
			st = tq.staging.find(s => !s.busy) || null;   // 空きが無い＝そのフレームは計測を落とす（結果詰まりで本業を止めない）
			if (st) { st.busy = true; st.spans = tq.spans.slice(); st.n = tq.idx; frame.enc.copyBufferToBuffer(tq.resolve, 0, st.buf, 0, tq.idx * 8); }
		}
		device.queue.submit([frame.enc.finish()]);
		frame = null;
		if (frame1Scoped === 1) { frame1Scoped = 2; device.popErrorScope().then(e => { if (e) gpuErr("初回フレーム検証", e.message); }).catch(() => {}); }
		// ⚠WebKit(Safari) の轍：submit と同一タスクで mapAsync を呼ぶと canvas present が黙って止まる
		//（例外・検証エラー・uncaptured 一切なし＝白画面。Playwright WebKit の二分探索で確定 2026-08-02：
		//  timestampWrites／resolveQuerySet／copyBufferToBuffer は全て無罪、同一タスクの mapAsync だけが毒）。
		// 別タスク（setTimeout 0）へ剥がすだけで全環境無害・TQ 全機能が生きる＝iOS Safari 白画面の根治。
		if (st) { setTimeout(() => {
			st.buf.mapAsync(GPUMapMode.READ).then(() => {
				const v = new BigUint64Array(st.buf.getMappedRange(0, st.n * 8));
				const sums = {};
				for (const sp of st.spans) {
					const ms = Number(v[sp.i0 + 1] - v[sp.i0]) / 1e6;
					if (ms >= 0 && ms < 1e4) sums[sp.tag] = (sums[sp.tag] || 0) + ms;   // 負値/異常値は捨てる（GL の disjoint 相当）
				}
				st.buf.unmap(); st.busy = false;
				for (const tg in sums) tq.ready.push({ tag: tg, ms: sums[tg] });
			}).catch(() => { st.busy = false; });
		}, 0); }
	}
	// 回収済み GPU 時間の引き取り口（renderworker の tqPoll から）。未対応=null＝呼び出し側が壁時計へフォールバック
	function tqTake() {
		if (!tq) return null;
		if (!tq.ready.length) return [];
		const r = tq.ready; tq.ready = [];
		return r;
	}
	// snapshot 基図読み出し（shot/print）：flush 直後（同一タスク・present 前）に current texture を
	// copyTextureToBuffer→mapAsync で読む。GL の readPixels 相当だが top-down（flip 不要）＋Mac は BGRA＝RGBA へ swizzle。
	// 戻り＝{ base: ArrayBuffer(RGBA・行パディング除去済), w, h }。呼び出し側（renderworker）は draw→gint.draw→flush の直後に await。
	async function readback() {
		const W = canvas.width, H = canvas.height;
		if (!W || !H) return null;
		const bpr = Math.ceil(W * 4 / 256) * 256;
		const buf = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
		const enc = device.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: ctx.getCurrentTexture() }, { buffer: buf, bytesPerRow: bpr, rowsPerImage: H }, { width: W, height: H });
		device.queue.submit([enc.finish()]);
		await new Promise(r => setTimeout(r, 0));   // WebKit 轍の予防：submit と同一タスクの mapAsync は present を止める（TQ で実証）
		await buf.mapAsync(GPUMapMode.READ);
		const src = new Uint8Array(buf.getMappedRange());
		const out = new Uint8Array(W * H * 4);
		for (let y = 0; y < H; y++) {
			const so = y * bpr, do2 = y * W * 4;
			if (isBGRA) for (let x = 0; x < W; x++) { const s = so + x * 4, d = do2 + x * 4; out[d] = src[s + 2]; out[d + 1] = src[s + 1]; out[d + 2] = src[s]; out[d + 3] = src[s + 3]; }
			else out.set(src.subarray(so, so + W * 4), do2);
		}
		buf.unmap(); buf.destroy();
		return { base: out.buffer, w: W, h: H };
	}

	// 未搭載の set は静かに握り潰す（初回だけ告知）＝app の呼び出しを壊さない。md 系＝classic merge 固定ゆえ無縁
	const IGNORE = new Set(["mdGrow", "mdUp", "mdScene"]);
	const ignored = new Set();
	function set(cmd, data, prop) {
		switch (cmd) {
			case "overlay":   setOverlay(data, prop); break;    // prop=fillColor（任意）
			case "overlayHi": setOverlayHi(data, prop); break;
			case "n02":       setN02(data); break;               // data=[シーン…] 交通の常駐オーバーレイ群
			case "gintBld":   setGintBld(data); break;           // data={origin,lines,points,color}／null=解放
			case "view":    view = { ...view, ...data }; break;
			case "sea":     sea = { ...sea, ...data }; break;
			case "bldFill": bldFill = { ...bldFill, ...data }; break;
			case "scene":   setScene(data, prop); break;
			case "elevAtlas": setElevationAtlas(data, prop); break;
			case "elevCell": setElevationCell(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasStage": setElevationAtlasStage(data, prop); break;
			case "elevCellStage": setElevationCellStage(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasCommit": commitElevationStage(); break;
			case "plateauMesh": setPlateauMesh(prop, data); break;   // prop=キー(区名#i)、data={pos,nrm,idx,...}／null=区解放
			case "plateauVis":  setPlateauVis(prop, data); break;    // prop=区名、data=真偽（GPU常駐のまま表示切替）
			case "stars":       stars = setStarBuf(stars, data, 8); break;         // data=Float32Array [cel.xyz,rgba,size]×n
			case "planets":     planets = setStarBuf(planets, data, 8); break;     // 惑星（starsと同8fレイアウト・アプリが実位置更新）
			case "constellations": constel = setStarBuf(constel, data, 3); break;  // [cel.xyz]×2n（LINES端点列）表示は view.showConst
			case "ecliptic":    ecliptic = setStarBuf(ecliptic, data, 3); break;   // 黄道の大円
			case "celequator":  celeq = setStarBuf(celeq, data, 3); break;         // 天の赤道の大円
			default:
				if (IGNORE.has(cmd)) { if (!ignored.has(cmd)) { ignored.add(cmd); console.log(`[gpu] set("${cmd}") は未搭載＝無視（WebGPU移植の次フェーズ）`); } }
				else console.warn("[gpu] renderer.set: unknown cmd", cmd);
		}
	}
	function dispose() {
		frame = null; gctx = null;
		disposeSlot("base"); disposeSlot("main");
		frameBuf.destroy(); paramBuf.destroy(); globeBuf.destroy(); cornerBuf.destroy();
		plBatchBuf.destroy(); maskParamBuf.destroy();
		skyBuf.destroy(); skyLineBuf.destroy();
		ovFrameBuf.destroy(); ovParamBuf.destroy(); emptyMaskParamBuf.destroy();
		disposeOverlay(overlay); disposeOverlay(overlayHi); for (const o of n02) disposeOverlay(o); disposeGintBld();
		for (const b of [stars, planets, constel, ecliptic, celeq]) if (b) b.buf.destroy();
		for (const p of plateaux.values()) { p.vbo.destroy(); p.nbo.destroy(); p.ibo.destroy(); }
		plateaux.clear();
		for (const m of plateauMasks.values()) m.tex.destroy();
		plateauMasks.clear(); plateauHidden.clear();
		dummyMask.destroy();
		if (terrain) { terrain.vbo.destroy(); terrain.ibo.destroy(); terrain = null; }
		if (elevTexObj) { elevTexObj.destroy(); elevTexObj = null; }
		if (elevStage) { elevStage.tex.destroy(); elevStage = null; }
		dummyTex.destroy();
		if (msaa) { msaa.tex.destroy(); msaa.depth.destroy(); msaa = null; }
		device.destroy();
	}
	// lost：GPU デバイス喪失（WebGL の contextlost と同じ扱いで main が立て直す）
	device.popErrorScope().then(e => { if (e) gpuErr("init検証", e.message); }).catch(() => {});
	// device/format/frameInfo/flush＝gint（createGintLayerGPU）のホスト面：開いたフレームに render pass を足す口。
	// passTS("gint")＝gint が自分のパスに GPU タイマを打つ口。tqTake/hasTQ＝renderworker の計測回収。
	return { set, draw, flush, readback, dispose, md: false, mdMax: 0, gintCtx: () => gctx, backend: "webgpu", lost: device.lost,
		device, format, gpuInfo, frameInfo: () => frame, passTS, tqTake, gpuErrors, get hasTQ() { return !!tq; } };
}
