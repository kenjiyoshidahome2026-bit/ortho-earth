// WebGPU レンダラ（Phase 1）＝gl/renderer.js の臓器移植の第一片：globe＋基図シーン（fill/line・classic merge 経路）。
// 公開面は createRenderer と同形 { set, draw, dispose, md, mdMax, gintCtx }＝renderworker からは同じ物に見える。
// md=false＝scene worker は CPU merge フォールバック（?nomd=1 と同じ実証済み経路）で typed array シーンを送ってくる。
// Phase 1 の非搭載（set は握り潰し・描画は素通し）：標高/地形・建物3D・PLATEAU・overlay(stencil)・星空/夜面・gint。
// ＝真俯瞰の平面地図と同じ絵が WebGPU で出る。以後の移植はここへ臓器を足す（多パス化・深度・テクスチャ）。
//
// WebGL 版との設計差（WebGPU で消える複雑さ・増える複雑さ）：
// ・uniform は per-draw の gl.uniform* でなく 1 フレーム 1 回の UBO 書込（base/main の2スロットを 256B 境界で同居）。
// ・MSAA は canvas 属性でなく明示（4x テクスチャ→resolveTarget）。動的解像度のリサイズは getCurrentTexture が
//   canvas 寸法に自動追随＝再 configure 不要。
// ・クリップ z は [0,1]＝対数深度の写像は wgsl.js logDepthZ（GL の window 深度と同値）。
import { cameraState, lonlatTo3D } from "../camera.js";
import { seaFbReal } from "../scene.js";
import * as mat from "../mat.js";
import { FILL_WGSL, LINE_WGSL, GLOBE_WGSL } from "./wgsl.js";

const CORNERS = new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]); // 6頂点×(end,side)＝gl/renderer.js と同一
const FRAME_SLOT = 256;   // frame UBO のスロット境界（minUniformBufferOffsetAlignment の仕様上限）
const FRAME_F32 = 44;     // 実使用 176B（wgsl.js Frame と厳密対応：mvp16+clipT4+trig4+originPt3(+1)+eye3(+1)+origin2+viewport2+fogColor3(+1)+params4）

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
	const target = { format, blend: BLEND };
	const ms = { count: SAMPLES };

	const fillMod = device.createShaderModule({ code: FILL_WGSL });
	const lineMod = device.createShaderModule({ code: LINE_WGSL });
	const globeMod = device.createShaderModule({ code: GLOBE_WGSL });
	const fillPipe = device.createRenderPipeline({
		layout: "auto",
		vertex: { module: fillMod, entryPoint: "vs", buffers: [
			{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },   // a_delta
			{ arrayStride: 4, attributes: [{ shaderLocation: 1, offset: 0, format: "unorm8x4" }] },    // a_color
		] },
		fragment: { module: fillMod, entryPoint: "fs", targets: [target] },
		primitive: { topology: "triangle-list" },
		multisample: ms,
	});
	const linePipe = device.createRenderPipeline({
		layout: "auto",
		vertex: { module: lineMod, entryPoint: "vs", buffers: [
			{ arrayStride: 8, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },     // corner
			{ arrayStride: 8, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }] },   // p1
			{ arrayStride: 8, stepMode: "instance", attributes: [{ shaderLocation: 2, offset: 0, format: "float32x2" }] },   // p2
			{ arrayStride: 4, stepMode: "instance", attributes: [{ shaderLocation: 3, offset: 0, format: "unorm8x4" }] },    // color
			{ arrayStride: 4, stepMode: "instance", attributes: [{ shaderLocation: 4, offset: 0, format: "float32" }] },     // half(CSS px)
		] },
		fragment: { module: lineMod, entryPoint: "fs", targets: [target] },
		primitive: { topology: "triangle-list" },
		multisample: ms,
	});
	const globePipe = device.createRenderPipeline({
		layout: "auto",
		vertex: { module: globeMod, entryPoint: "vs" },
		fragment: { module: globeMod, entryPoint: "fs", targets: [target] },
		primitive: { topology: "triangle-list" },
		multisample: ms,
	});

	// frame UBO：base/main の2スロット（各 176B・256B 境界）。globe は invMvp+色の専用 UBO。
	const frameBuf = device.createBuffer({ size: FRAME_SLOT * 2, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const globeBuf = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const mkFrameBG = (pipe, off) => device.createBindGroup({
		layout: pipe.getBindGroupLayout(0),
		entries: [{ binding: 0, resource: { buffer: frameBuf, offset: off, size: FRAME_SLOT } }],
	});
	// fill/line は layout:"auto" でも同一 Frame 構造＝それぞれの layout で同じバッファ領域を掴む
	const slotBG = {
		base: { fill: mkFrameBG(fillPipe, 0), line: mkFrameBG(linePipe, 0) },
		main: { fill: mkFrameBG(fillPipe, FRAME_SLOT), line: mkFrameBG(linePipe, FRAME_SLOT) },
	};
	const globeBG = device.createBindGroup({
		layout: globePipe.getBindGroupLayout(0),
		entries: [{ binding: 0, resource: { buffer: globeBuf } }],
	});
	const cornerBuf = device.createBuffer({ size: CORNERS.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
	device.queue.writeBuffer(cornerBuf, 0, CORNERS);

	// 静的 view（色・見た目）と海ゲート＝gl/renderer.js と同じ意味論
	let view = { clear: null, land: null, atmo: null, bldColor: null };
	let sea = { li: -1, minzoom: Infinity };
	let bldFill = { li: -1 };   // Phase 1 は建物押し出し未搭載＝フットプリントは常時描く（伏せない）
	let fogDist = 0;            // フォグ距離の臨界減衰追従（gl/renderer.js と同じ）

	// シーン（classic merge）：slot → { origin, draws:[{kind,li,バッファ…}] }
	const scenes = {
		base: { origin: [0, 0], draws: [] },
		main: { origin: [0, 0], draws: [] },
	};
	function makeBuf(data, usage) {
		const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
		return b;
	}
	const u8col = col => col instanceof Uint8Array ? col : Uint8Array.from(col, v => Math.max(0, Math.min(255, Math.round(v * 255))));   // geojson 由来 float32 の保険
	function disposeSlot(slot) {
		for (const d of scenes[slot].draws) for (const b of d.bufs) b.destroy();
		scenes[slot] = { origin: scenes[slot].origin, draws: [] };
	}
	function setScene(s, slot = "main") {
		if (!scenes[slot]) return;   // overlay 等の未知スロットは Phase 1 対象外
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
		scenes[slot] = { origin: s.origin, draws };
		// s.buildings（3D押し出し）は Phase 1 未搭載＝捨てる（バッファ化しない）
	}

	// frame UBO の詰め物（wgsl.js Frame と厳密対応）。RTE 錨（clipT/originPt/trig）は CPU double で。
	const frameF32 = new Float32Array(FRAME_F32);
	function packFrame(st, origin, fogNear, fogFar, logCoef, dpr) {
		const f = frameF32;
		f.set(st.mvp, 0);
		const oPt = lonlatTo3D(origin[0], origin[1]);
		const cT = mat.transform(st.mvp, [oPt[0], oPt[1], oPt[2], 1]);
		f[16] = cT[0]; f[17] = cT[1]; f[18] = cT[2]; f[19] = cT[3];
		const lr = origin[0] * Math.PI / 180, br = origin[1] * Math.PI / 180;
		f[20] = Math.cos(lr); f[21] = Math.sin(lr); f[22] = Math.cos(br); f[23] = Math.sin(br);
		f[24] = oPt[0]; f[25] = oPt[1]; f[26] = oPt[2]; f[27] = 0;
		f[28] = st.eye[0]; f[29] = st.eye[1]; f[30] = st.eye[2]; f[31] = 0;
		f[32] = origin[0]; f[33] = origin[1];
		f[34] = canvas.width; f[35] = canvas.height;
		const fc = view.land || [0.96, 0.96, 0.95];
		f[36] = fc[0]; f[37] = fc[1]; f[38] = fc[2]; f[39] = 0;
		f[40] = fogNear; f[41] = fogFar; f[42] = logCoef; f[43] = dpr;
		return f;
	}

	// MSAA ターゲット（canvas 寸法に追随）。resolve 先は毎フレーム getCurrentTexture。
	let msaa = null;
	function msaaView(W, H) {
		if (!msaa || msaa.w !== W || msaa.h !== H) {
			if (msaa) msaa.tex.destroy();
			const tex = device.createTexture({ size: [W, H], sampleCount: SAMPLES, format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
			msaa = { tex, view: tex.createView(), w: W, h: H };
		}
		return msaa.view;
	}

	function draw(cam, opts) {
		const W = canvas.width, H = canvas.height;
		if (!W || !H) return false;
		const st = cameraState(cam, W, H);
		// フォグ距離の臨界減衰追従（gl/renderer.js draw と同式・同閾値）
		if (!fogDist) fogDist = st.camDist;
		else fogDist += (st.camDist - fogDist) * 0.18;
		if (Math.abs(st.camDist - fogDist) < st.camDist * 0.002) fogDist = st.camDist;
		st.fogDist = fogDist;
		const fogAnimating = fogDist !== st.camDist;
		const pfFog = Math.max(0, Math.min(1, ((cam.pitch || 0) - 0.35) / 0.45));
		const land = view.land || [0.96, 0.96, 0.95, 1], atmo = view.atmo || [0.45, 0.62, 0.95, 0.6];
		const flat2d = (cam.pitch || 0) < 0.02 && cam.zoom >= 9;
		const c = flat2d ? [land[0], land[1], land[2], 1] : (view.clear || [1, 1, 1, 1]);
		const _limb = Math.sqrt(Math.max((1 + st.camDist) * (1 + st.camDist) - 1, 1e-12));
		const logCoef = 2.0 / Math.log2(_limb * 1.15 + st.camDist + 1.0);
		// fill/line のフォグ終端は地形と同一式（gl/renderer.js fogFarCap と同じ）
		const fogNear = st.fogDist * 2.5;
		const fogFarCap = Math.max(st.fogDist * 5.0, 0.026 * pfFog);
		device.queue.writeBuffer(frameBuf, 0, packFrame(st, scenes.base.origin || [0, 0], fogNear, fogFarCap, logCoef, cam.dpr || 1));
		device.queue.writeBuffer(frameBuf, FRAME_SLOT, packFrame(st, scenes.main.origin || [0, 0], fogNear, fogFarCap, logCoef, cam.dpr || 1));
		if (!flat2d) {
			const g = new Float32Array(24);
			g.set(st.invMvp, 0);
			g[16] = land[0]; g[17] = land[1]; g[18] = land[2]; g[19] = land[3];
			g[20] = atmo[0]; g[21] = atmo[1]; g[22] = atmo[2]; g[23] = atmo[3];
			device.queue.writeBuffer(globeBuf, 0, g);
		}

		const enc = device.createCommandEncoder();
		const pass = enc.beginRenderPass({
			colorAttachments: [{
				view: msaaView(W, H),
				resolveTarget: ctx.getCurrentTexture().createView(),
				loadOp: "clear",
				clearValue: { r: c[0] * c[3], g: c[1] * c[3], b: c[2] * c[3], a: c[3] },
				storeOp: "discard",   // MSAA 実体は保存不要（resolve 先が本体）
			}],
		});
		if (!flat2d) {   // 球体本体：land基色を縁(リム)まで敷く。2D高速パス時は clear で代替＝省略
			pass.setPipeline(globePipe);
			pass.setBindGroup(0, globeBG);
			pass.draw(3);
		}
		// skipMain＝ズームアウト退場・skipBase＝静止時の下地隠し（gl/renderer.js と同じ分岐）
		const slots = (opts && opts.skipMain) ? ["base"] : (opts && opts.skipBase) ? ["main"] : ["base", "main"];
		const mainLinesOn = slots.indexOf("main") >= 0 && scenes.main.draws.length > 0;
		for (const slot of slots) {
			const scene = scenes[slot];
			if (!scene.draws.length) continue;
			for (const d of scene.draws) {
				if (d.kind === "fill") {
					// 海：ビュー一律ゲート（詳細以外は描かない＝紙の海）。フォールバック水域(擬似li)も同じ掟
					if ((seaFbReal(d.li) != null || d.li === sea.li || d.li === sea.li2) && cam.zoom < sea.minzoom) continue;
					pass.setPipeline(fillPipe);
					pass.setBindGroup(0, slotBG[slot].fill);
					pass.setVertexBuffer(0, d.bPos);
					pass.setVertexBuffer(1, d.bCol);
					if (d.bIdx) { pass.setIndexBuffer(d.bIdx, "uint32"); pass.drawIndexed(d.count); }
					else pass.draw(d.count);
				} else {
					if (slot === "base" && mainLinesOn) continue;   // 本命の線が出ている間は下地の線を伏せる
					pass.setPipeline(linePipe);
					pass.setBindGroup(0, slotBG[slot].line);
					pass.setVertexBuffer(0, cornerBuf);
					pass.setVertexBuffer(1, d.bP1);
					pass.setVertexBuffer(2, d.bP2);
					pass.setVertexBuffer(3, d.bCol);
					pass.setVertexBuffer(4, d.bHalf);
					pass.draw(6, d.count);
				}
			}
		}
		pass.end();
		device.queue.submit([enc.finish()]);
		return fogAnimating;
	}

	// Phase 1 で未搭載の set は静かに握り潰す（初回だけ告知）＝app/terrain の呼び出しを壊さない
	const IGNORE = new Set(["overlay", "overlayHi", "n02", "gintBld", "elevAtlas", "elevCell", "elevAtlasStage", "elevCellStage", "elevAtlasCommit",
		"plateauMesh", "plateauVis", "stars", "constellations", "planets", "ecliptic", "celequator", "mdGrow", "mdUp", "mdScene"]);
	const ignored = new Set();
	function set(cmd, data, prop) {
		switch (cmd) {
			case "view":    view = { ...view, ...data }; break;
			case "sea":     sea = { ...sea, ...data }; break;
			case "bldFill": bldFill = { ...bldFill, ...data }; break;
			case "scene":   setScene(data, prop); break;
			default:
				if (IGNORE.has(cmd)) { if (!ignored.has(cmd)) { ignored.add(cmd); console.log(`[gpu] set("${cmd}") は Phase 1 未搭載＝無視`); } }
				else console.warn("[gpu] renderer.set: unknown cmd", cmd);
		}
	}
	function dispose() {
		disposeSlot("base"); disposeSlot("main");
		frameBuf.destroy(); globeBuf.destroy(); cornerBuf.destroy();
		if (msaa) { msaa.tex.destroy(); msaa = null; }
		device.destroy();
	}
	// lost：GPU デバイス喪失（WebGL の contextlost と同じ扱いで main が立て直す）
	return { set, draw, dispose, md: false, mdMax: 0, gintCtx: () => null, backend: "webgpu", lost: device.lost };
}
