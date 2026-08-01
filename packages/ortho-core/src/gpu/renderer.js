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
import { cameraState, lonlatTo3D } from "../camera.js";
import { seaFbReal } from "../scene.js";
import * as mat from "../mat.js";
import { FILL_WGSL, LINE_WGSL, GLOBE_WGSL, TERRAIN_WGSL, BUILDING_WGSL, CONTOUR_WGSL } from "./wgsl.js";

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)＝gl/renderer.js と同一
const FRAME_SLOT = 512;    // frame UBO のスロット境界（実使用272B・minUniformBufferOffsetAlignment 上限256の倍数）
const FRAME_F32 = 72;      // 288B/4（wgsl.js Frame と厳密対応。詰め順は packFrame 参照。末尾 mesh vec4f 含む）
const SLOT = { base: 0, main: 1, terrain: 2, bld: 3 };   // terrain/bld は main と同 origin・fog だけ違うスロット
const PARAM_SLOT = 256;    // DrawP（3×vec4=48B）のスロット境界
const ROLE = { normal: 0, water: 1, seaFb: 2, terrain: 3, bld: 4, contour: 5 };
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
	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) throw new Error("WebGPU adapter unavailable");
	const device = await adapter.requestDevice();
	const ctx = canvas.getContext("webgpu");
	if (!ctx) throw new Error("webgpu context unavailable");
	const format = navigator.gpu.getPreferredCanvasFormat();
	ctx.configure({ device, format, alphaMode: "premultiplied" });
	device.addEventListener?.("uncapturederror", e => console.error("[gpu] uncaptured:", e.error?.message || e.error));

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

	const fillMod = device.createShaderModule({ code: FILL_WGSL });
	const lineMod = device.createShaderModule({ code: LINE_WGSL });
	const globeMod = device.createShaderModule({ code: GLOBE_WGSL });
	const terrMod = device.createShaderModule({ code: TERRAIN_WGSL });
	const bldMod = device.createShaderModule({ code: BUILDING_WGSL });
	const contMod = device.createShaderModule({ code: CONTOUR_WGSL });
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
	const pipe = (mod, bufs, ds, fsEntry = "fs") => device.createRenderPipeline({
		layout,
		vertex: { module: mod, entryPoint: "vs", buffers: bufs },
		fragment: { module: mod, entryPoint: fsEntry, targets: [target] },
		primitive: { topology: "triangle-list" },
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
	], dsWrite);
	const contourPipe = pipe(contMod, undefined, dsOff);
	const globePipe = device.createRenderPipeline({   // globe は Frame 非依存＝専用レイアウト(auto)
		layout: "auto",
		vertex: { module: globeMod, entryPoint: "vs" },
		fragment: { module: globeMod, entryPoint: "fs", targets: [target] },
		primitive: { topology: "triangle-list" },
		depthStencil: dsOff, multisample: ms,
	});

	// UBO：Frame 4スロット / DrawP 6スロット / globe 専用
	const frameBuf = device.createBuffer({ size: FRAME_SLOT * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const paramBuf = device.createBuffer({ size: PARAM_SLOT * 6, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const globeBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const globeBG = device.createBindGroup({
		layout: globePipe.getBindGroupLayout(0),
		entries: [{ binding: 0, resource: { buffer: globeBuf } }],
	});
	const paramBG = [];   // 役割別（静的オフセット＝dynamic offset 不要）
	for (let r = 0; r < 6; r++) paramBG.push(device.createBindGroup({
		layout: bgl1, entries: [{ binding: 0, resource: { buffer: paramBuf, offset: r * PARAM_SLOT, size: 48 } }],
	}));
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
	function disposeSlot(slot) {
		for (const d of scenes[slot].draws) for (const b of d.bufs) b.destroy();
		if (scenes[slot].bld) for (const b of scenes[slot].bld.bufs) b.destroy();
		scenes[slot] = { origin: scenes[slot].origin, draws: [], bld: null };
	}
	function setScene(s, slot = "main") {
		if (!scenes[slot]) return;   // overlay 等の未知スロットは対象外
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
		scenes[slot] = { origin: s.origin, draws, bld };
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
	// DrawP 6スロットを一括で書く（256Bストライド・各48B使用）
	const paramF32 = new Float32Array(PARAM_SLOT / 4 * 6);
	function packParams({ cityLift, waterLift, exact, land, bldColor, contour }) {
		const f = paramF32; f.fill(0);
		const at = (role, vals) => { const o = role * (PARAM_SLOT / 4); for (let i = 0; i < vals.length; i++) f[o + i] = vals[i]; };
		at(ROLE.normal, [0, cityLift, 0, 0]);
		at(ROLE.water, [0, waterLift, exact, 0]);
		at(ROLE.seaFb, [1, waterLift, exact, 0]);
		const hy = view.hypso;
		at(ROLE.terrain, [land[0], land[1], land[2], 0,
			hy ? hy.color[0] : 0, hy ? hy.color[1] : 0, hy ? hy.color[2] : 0, hy ? (hy.amount ?? 0.5) : 0,
			hy ? 1 / (hy.max || 3000) : 0, 0, 0, 0]);
		at(ROLE.bld, [bldColor[0], bldColor[1], bldColor[2], 0]);
		at(ROLE.contour, [contour.color[0], contour.color[1], contour.color[2], contour.interval,
			contour.major, contour.alpha, 0, 0]);
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
		const dsmLift = terrainDepth && cam.zoom < 14;
		const cityLift = terrainDepth && cam.zoom >= 14 ? 5 : 0;
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
		device.queue.writeBuffer(paramBuf, 0, packParams({
			cityLift, waterLift: dsmLift ? WATER_LIFT_M : CITY_WATER_LIFT_M, exact: terrainDepth ? 1 : 0,
			land, bldColor: view.bldColor || [0.86, 0.86, 0.85],
			contour: { color: view.contourColor || [0.42, 0.30, 0.18], interval: iv, major: iv * 5.0, alpha: cAlpha * (view.contourAlpha || 1) },
		}));
		if (!flat2d) {
			const g = new Float32Array(24);
			g.set(st.invMvp, 0);
			g[16] = land[0]; g[17] = land[1]; g[18] = land[2]; g[19] = land[3];
			g[20] = atmo[0]; g[21] = atmo[1]; g[22] = atmo[2]; g[23] = atmo[3];
			device.queue.writeBuffer(globeBuf, 0, g);
		}

		const t = targets(W, H);
		const enc = device.createCommandEncoder();
		const pass = enc.beginRenderPass({
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
		});
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
			if (!scene.draws.length) continue;
			for (const d of scene.draws) {
				if (d.kind === "fill") {
					const seaFB = seaFbReal(d.li) != null;   // 図郭外フォールバック水域（標高ゲート付き全面WA）
					const waterC = d.li === sea.li || d.li === sea.li2;
					if ((seaFB || waterC) && cam.zoom < sea.minzoom) continue;   // 海：ビュー一律ゲート（紙の海）
					if (hideBldFill && d.li === bldFill.li) continue;            // 3D時＝フットプリント塗りを伏せる
					// 水面は「リフトして深度テスト維持」＝尾根の遮蔽を保ちつつDSMノイズ瘤を沈める。厳密深度は水域のみ
					pass.setPipeline(terrainDepth && (waterC || seaFB) ? fillTestExact : fillPipe);
					pass.setBindGroup(0, bg0[slot]);
					pass.setBindGroup(1, paramBG[seaFB ? ROLE.seaFb : waterC ? ROLE.water : ROLE.normal]);
					pass.setVertexBuffer(0, d.bPos);
					pass.setVertexBuffer(1, d.bCol);
					if (d.bIdx) { pass.setIndexBuffer(d.bIdx, "uint32"); pass.drawIndexed(d.count); }
					else pass.draw(d.count);
				} else {
					if (slot === "base" && mainLinesOn) continue;   // 本命の線が出ている間は下地の線を伏せる
					pass.setPipeline(linePipe);
					pass.setBindGroup(0, bg0[slot]);
					pass.setBindGroup(1, paramBG[ROLE.normal]);     // 線の接地リフト＝cityLift（fill の通常塗りと同じ）
					pass.setVertexBuffer(0, cornerBuf);
					pass.setVertexBuffer(1, d.bP1);
					pass.setVertexBuffer(2, d.bP2);
					pass.setVertexBuffer(3, d.bCol);
					pass.setVertexBuffer(4, d.bHalf);
					pass.draw(6, d.count);
				}
			}
		}
		// 建物（3D押し出し）：深度で前後関係を解決（地形・尾根にも遮蔽される）。真俯瞰では描かない＝平面地図
		const show3d = (cam.pitch || 0) >= 0.02;
		const bld = show3d && !(opts && opts.skipMain) ? scenes.main.bld : null;
		if (bld) {
			pass.setPipeline(bldPipe);
			pass.setBindGroup(0, bg0.bld);
			pass.setBindGroup(1, paramBG[ROLE.bld]);
			pass.setVertexBuffer(0, bld.bPos);
			pass.setVertexBuffer(1, bld.bSh);
			pass.setVertexBuffer(2, bld.bAnc);
			pass.draw(bld.count);
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
		return fogAnimating;
	}
	// フレーム確定：MSAA を canvas へ resolve して submit（gint パスが足された後＝地図と同フレーム同カメラの1枚）。
	function flush() {
		if (!frame) return;
		const pass = frame.enc.beginRenderPass({
			colorAttachments: [{ view: frame.colorView, resolveTarget: ctx.getCurrentTexture().createView(), loadOp: "load", storeOp: "discard" }],
		});
		pass.end();
		device.queue.submit([frame.enc.finish()]);
		frame = null;
	}

	// 未搭載の set は静かに握り潰す（初回だけ告知）＝app の呼び出しを壊さない
	const IGNORE = new Set(["overlay", "overlayHi", "n02", "gintBld", "plateauMesh", "plateauVis",
		"stars", "constellations", "planets", "ecliptic", "celequator", "mdGrow", "mdUp", "mdScene"]);
	const ignored = new Set();
	function set(cmd, data, prop) {
		switch (cmd) {
			case "view":    view = { ...view, ...data }; break;
			case "sea":     sea = { ...sea, ...data }; break;
			case "bldFill": bldFill = { ...bldFill, ...data }; break;
			case "scene":   setScene(data, prop); break;
			case "elevAtlas": setElevationAtlas(data, prop); break;
			case "elevCell": setElevationCell(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasStage": setElevationAtlasStage(data, prop); break;
			case "elevCellStage": setElevationCellStage(prop.cx, prop.cy, data, prop.cellRes); break;
			case "elevAtlasCommit": commitElevationStage(); break;
			default:
				if (IGNORE.has(cmd)) { if (!ignored.has(cmd)) { ignored.add(cmd); console.log(`[gpu] set("${cmd}") は未搭載＝無視（WebGPU移植の次フェーズ）`); } }
				else console.warn("[gpu] renderer.set: unknown cmd", cmd);
		}
	}
	function dispose() {
		frame = null; gctx = null;
		disposeSlot("base"); disposeSlot("main");
		frameBuf.destroy(); paramBuf.destroy(); globeBuf.destroy(); cornerBuf.destroy();
		if (terrain) { terrain.vbo.destroy(); terrain.ibo.destroy(); terrain = null; }
		if (elevTexObj) { elevTexObj.destroy(); elevTexObj = null; }
		if (elevStage) { elevStage.tex.destroy(); elevStage = null; }
		dummyTex.destroy();
		if (msaa) { msaa.tex.destroy(); msaa.depth.destroy(); msaa = null; }
		device.destroy();
	}
	// lost：GPU デバイス喪失（WebGL の contextlost と同じ扱いで main が立て直す）
	// device/format/frameInfo/flush＝gint（createGintLayerGPU）のホスト面：開いたフレームに render pass を足す口。
	return { set, draw, flush, dispose, md: false, mdMax: 0, gintCtx: () => gctx, backend: "webgpu", lost: device.lost,
		device, format, frameInfo: () => frame };
}
