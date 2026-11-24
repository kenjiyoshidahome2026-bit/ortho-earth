// COPC の点群の WebGPU の描き手（2026-10-23）＝copc-gl.ts（WebGL2）の兄弟。本体が WebGPU で描いている時に copc-draw.ts が選ぶ。
//   本体の GPUDevice（host.gpuDevice()）を共有し、深度は本体の詰めた GPUTexture（api.depth.gpuTexture(device)）をそのまま束ねる
//   ＝旧（WebGL2 のオーバーレイ）は毎フレーム「深度を ImageBitmap に写す → 別の WebGL2 文脈へ texSubImage2D」の API 跨ぎの写しが要った（静岡の LAS が重い・本人 2026-10-23）。
//   数式は copc-gl.ts と同じ（地平線・距離で縮む点・色の 4 つの切り替え・lift・深度で隠れる）。点は 1 点＝1 instance の四角（6 頂点）＝WebGPU の point-list は 1 px 固定なので。
//   点の列は storage buffer（instance_index で引く）＝頂点の形式に 8/16 bit の 1 成分が無い器（WebKit）でも同じ。rgb は u32（rgba8）に詰め直す（worker の中・解く時間より小さい）。
//   uniform は 1 本の buffer に層ごとの 256 B の枡（dynamic offset）＝1 フレームに writeBuffer 1 回。深度のテクスチャは group 0（変わった時だけ bind group を作り直す）。
// 契約：copc-gl.ts と同じ message（layer / remove / vis / clear / style / probe）。init は非同期（pipeline を組んでから canvas の文脈を取る＝失敗したら WebGL2 へ落とせる）。
// 撮影（map.shot・readOverlays）は WebGPU の canvas を読まない（splat と同じ・既知）。
import type { CameraPose, CameraState, OverlayApi, OverlayHost, OverlaySize } from "../types/overlay.ts";
import type { Msg, Style } from "./copc-gl.ts";

const BUF = { MAP_READ: 0x01, COPY_SRC: 0x04, COPY_DST: 0x08, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const TEX = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 } as const;
const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2 } as const;
const SLOT = 512;       // 層ごとの uniform の枡（dynamic offset の揃え 256 の倍・304 B 使う）
const MAX_RAD = 64;     // 点の半径の上限（px・GL の ALIASED_POINT_SIZE_RANGE の代わり）
const MODES: Record<string, number> = { rgb: 0, classification: 1, intensity: 2, elevation: 3, ground: 4, heightAboveGround: 5 };

const WGSL = /* wgsl */`
struct Uni {
	mvp: mat4x4f,                    // mvp·T(origin)（倍精度で掛けてから f32）
	origin: vec3f, spacing: f32,     // 節の原点（単位球）・この節の点の間隔（世界単位）
	eye: vec3f, focal: f32,          // 目（単位球）・焦点距離（px）
	vp: vec2f, ddim: vec2f,          // 描画面（device px）・本体の深度テクスチャの大きさ
	elev: vec2f, intRange: vec2f,    // 段彩の範囲（m）・強度の範囲
	size: f32, atten: f32, maxRad: f32, opacity: f32,
	lift: f32, liftM: f32, logCoef: f32, eps: f32,
	mode: u32, depthOn: u32, hasRgb: u32, pad: u32,
	gLon: vec3f, gndN: f32,          // 節の原点からの変位（世界単位）→ 経度の差（度）の行・地面アトラスの窓の数（0..4）
	gLat: vec3f, gSplit: f32,        // 同じく緯度の行・左右 2 枚のアトラス（1＝左半分）
	elevUV: vec4f,                   // 標高アトラス：uv＝xy ＋ 経緯度の差 × zw（原点の分は倍精度で前計算）
	gw: array<vec4f, 4>,             // 地面アトラスの窓 k：uv＝xy ＋ 経緯度の差 × zw（細かい順）
	gp: vec4f,                       // x＝標高アトラスあり・y＝点の間隔（度・ミップの段を選ぶ）
};
@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var dep: texture_2d<f32>;
// 本体の地面（共通化 段 3）＝同じ GPUDevice の地面アトラス（前乗算 RGBA・v は北が 0）と標高アトラス（r16float・m）
@group(0) @binding(2) var gSamp: sampler;
@group(0) @binding(3) var gTex0: texture_2d<f32>;
@group(0) @binding(4) var gTex1: texture_2d<f32>;
@group(0) @binding(5) var gTex2: texture_2d<f32>;
@group(0) @binding(6) var gTex3: texture_2d<f32>;
@group(0) @binding(7) var eTex: texture_2d<f32>;
@group(1) @binding(0) var<storage, read> P: array<f32>;     // 位置（原点相対・x y z）
@group(1) @binding(1) var<storage, read> RGB: array<u32>;   // 色（rgba8・無い層は 1 語のダミー）
@group(1) @binding(2) var<storage, read> INT: array<u32>;   // 強度（u16 を 2 つずつ）
@group(1) @binding(3) var<storage, read> CLS: array<u32>;   // 分類（u8 を 4 つずつ）
@group(1) @binding(4) var<storage, read> ELEV: array<f32>;  // 標高（m）
fn inWin(uv: vec2f) -> bool { return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)); }
fn gUV(uv: vec2f) -> vec2f { var t = vec2f(uv.x, 1.0 - uv.y); if (U.gSplit > 0.5) { t.x = clamp(t.x * 0.5, 0.002, 0.498); } return t; }
fn gLod(span: f32, dim: f32) -> f32 { return max(0.0, log2(max(1e-12, U.gp.y * dim / max(1e-12, span)))); }
// 地面アトラスの色（点を含む一番細かい窓・前乗算）＝a は覆いの濃さ（0＝何も描いていない所）
fn groundAt(dll: vec2f) -> vec4f {
	let n = U.gndN;
	let u0 = U.gw[0].xy + dll * U.gw[0].zw;
	if (n > 0.5 && inWin(u0)) { return textureSampleLevel(gTex0, gSamp, gUV(u0), gLod(1.0 / U.gw[0].w, f32(textureDimensions(gTex0).y))); }
	let u1 = U.gw[1].xy + dll * U.gw[1].zw;
	if (n > 1.5 && inWin(u1)) { return textureSampleLevel(gTex1, gSamp, gUV(u1), gLod(1.0 / U.gw[1].w, f32(textureDimensions(gTex1).y))); }
	let u2 = U.gw[2].xy + dll * U.gw[2].zw;
	if (n > 2.5 && inWin(u2)) { return textureSampleLevel(gTex2, gSamp, gUV(u2), gLod(1.0 / U.gw[2].w, f32(textureDimensions(gTex2).y))); }
	let u3 = U.gw[3].xy + dll * U.gw[3].zw;
	if (n > 3.5 && inWin(u3)) { return textureSampleLevel(gTex3, gSamp, gUV(u3), gLod(1.0 / U.gw[3].w, f32(textureDimensions(gTex3).y))); }
	return vec4f(0.0);
}
struct VO { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) p: vec2f, @location(2) rad: f32, @location(3) w: f32 }
fn ramp(t0: f32) -> vec3f {   // 標高の段彩（青→緑→黄→赤）＝copc-gl.ts と同じ
	let t = clamp(t0, 0.0, 1.0);
	if (t < 0.33) { return mix(vec3f(0.17, 0.35, 0.75), vec3f(0.20, 0.65, 0.35), t / 0.33); }
	if (t < 0.66) { return mix(vec3f(0.20, 0.65, 0.35), vec3f(0.95, 0.85, 0.25), (t - 0.33) / 0.33); }
	return mix(vec3f(0.95, 0.85, 0.25), vec3f(0.80, 0.22, 0.15), (t - 0.66) / 0.34);
}
fn clsColor(k: u32) -> vec3f {   // ASPRS LAS 1.4 の分類
	switch k {
		case 2u: { return vec3f(0.63, 0.47, 0.30); }
		case 3u: { return vec3f(0.62, 0.84, 0.45); }
		case 4u: { return vec3f(0.35, 0.70, 0.30); }
		case 5u: { return vec3f(0.13, 0.50, 0.18); }
		case 6u: { return vec3f(0.90, 0.35, 0.25); }
		case 7u, 18u: { return vec3f(0.85, 0.20, 0.85); }
		case 9u: { return vec3f(0.20, 0.45, 0.90); }
		case 10u: { return vec3f(0.45, 0.35, 0.55); }
		case 11u: { return vec3f(0.55, 0.55, 0.58); }
		case 17u: { return vec3f(0.95, 0.65, 0.20); }
		default: { return vec3f(0.72, 0.72, 0.72); }
	}
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> VO {
	var o: VO;
	o.pos = vec4f(2.0, 2.0, 2.0, 1.0); o.col = vec4f(0.0); o.p = vec2f(0.0); o.rad = 0.0; o.w = 1.0;   // 画面の外＝描かない
	let p0 = vec3f(P[i * 3u], P[i * 3u + 1u], P[i * 3u + 2u]);
	let pos = p0 + normalize(p0 + U.origin) * U.lift;   // 高さの足し込み（球の法線）
	let d = (pos + U.origin) - U.eye;   // 地平線の向こう（球の裏側）は描かない
	let a = dot(d, d); let b = dot(U.eye, d); let c = dot(U.eye, U.eye) - 1.0; let disc = b * b - a * c;
	if (disc > 0.0) { let s = sqrt(disc); let t0 = (-b - s) / a; if (t0 > 1e-4 && t0 < 1.0 - 1e-4) { return o; } }
	let cpos = U.mvp * vec4f(pos, 1.0);
	if (cpos.w <= 0.0) { return o; }
	var rad = U.size;
	if (U.atten > 0.5) { rad = clamp(0.5 * U.spacing * U.focal / max(1e-9, sqrt(a)), 1.0, U.size * 2.0); }
	rad = min(rad, U.maxRad);
	var corner = vec2f(-1.0, -1.0);
	switch vi { case 1u: { corner = vec2f(1.0, -1.0); } case 2u, 4u: { corner = vec2f(1.0, 1.0); } case 5u: { corner = vec2f(-1.0, 1.0); } default: {} }
	let half = rad + 1.0;   // GL の gl_PointSize＝rad×2＋2 と同じ
	let ndc = cpos.xy / cpos.w;
	o.pos = vec4f(ndc + corner * half * 2.0 / U.vp, 0.0, 1.0);   // z＝0（深度は書かない・GL 向きの mvp の z を WebGPU の [0,1] で切らせない）
	o.p = corner * half; o.rad = rad; o.w = cpos.w;
	var col = vec3f(0.85);
	if (U.mode == 0u) { if (U.hasRgb != 0u) { col = unpack4x8unorm(RGB[i]).rgb; } }
	else if (U.mode == 1u) { col = clsColor((CLS[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu); }
	else if (U.mode == 2u) { let v = f32((INT[i >> 1u] >> ((i & 1u) * 16u)) & 0xffffu); col = vec3f(clamp((v - U.intRange.x) / max(1e-6, U.intRange.y - U.intRange.x), 0.0, 1.0)); }
	else if (U.mode == 3u) { col = ramp((ELEV[i] + U.liftM - U.elev.x) / max(1e-6, U.elev.y - U.elev.x)); }
	else {
		let dll = vec2f(dot(p0, U.gLon), dot(p0, U.gLat));   // 節の原点からの経緯度の差（度）
		if (U.mode == 4u) {   // 地面の色（オルソ等）＝無い所は点の RGB（無ければ灰）
			let g = groundAt(dll);
			var base = vec3f(0.72);
			if (U.hasRgb != 0u) { base = unpack4x8unorm(RGB[i]).rgb; }
			col = g.rgb + base * (1.0 - g.a);
		} else {   // 地面からの高さ（標高アトラス）＝段彩の範囲は m（0..）。アトラスが無ければ標高の段彩
			var h = ELEV[i] + U.liftM;
			let eu = U.elevUV.xy + dll * U.elevUV.zw;
			if (U.gp.x > 0.5 && inWin(eu)) { h = h - textureSampleLevel(eTex, gSamp, eu, 0.0).r; }
			col = ramp((h - U.elev.x) / max(1e-6, U.elev.y - U.elev.x));
		}
	}
	o.col = vec4f(col, U.opacity);
	return o;
}
// 本体の深度（詰めた 24 bit の対数深度・行は下から＝GL）で隠れるか＝splat と同じ
fn occluded(pos: vec2f, w: f32) -> bool {
	if (U.depthOn == 0u) { return false; }
	let uv = vec2f(pos.x / U.vp.x, 1.0 - pos.y / U.vp.y);
	let t = vec2i(clamp(uv * U.ddim, vec2f(0.0), U.ddim - 1.0));
	let c = floor(textureLoad(dep, t, 0).rgb * 255.0 + 0.5);
	let s = dot(c, vec3f(65536.0, 256.0, 1.0)) / 16777215.0;
	let d = 0.5 * log2(max(1.0 + w, 1e-6)) * U.logCoef;
	return s < 1.0 && d > s + U.eps;
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
	let cov = clamp(v.rad + 0.5 - length(v.p), 0.0, 1.0);
	if (cov <= 0.0) { discard; }
	if (occluded(v.pos.xy, v.w)) { discard; }
	let a = v.col.a * cov;
	return vec4f(v.col.rgb * a, a);
}`;

/** 層（q ごと＝COPC の節） */
interface Layer { n: number; bufs: GPUBuffer[]; bg: GPUBindGroup; origin: ArrayLike<number>; spacing: number; on: boolean; hasRgb: boolean }
export interface CopcGpuModule {
	init(canvas: OffscreenCanvas, opts: { depth?: boolean }, host: OverlayHost | null): Promise<void>;
	message(d: Msg): void;
	frame(cam: CameraPose, s: CameraState, size: OverlaySize, api: OverlayApi): boolean;
	destroy(): void;
	readonly shared: boolean;
}
const R2D = 180 / Math.PI;
const align256 = (v: number): number => Math.ceil(v / 256) * 256;

export function create(): CopcGpuModule {
	let device: GPUDevice | null = null, ctx: GPUCanvasContext | null = null, host: OverlayHost | null = null, format: GPUTextureFormat = "rgba8unorm";
	let shared = false, wantDepth = false, dead = false;
	let pipe: GPURenderPipeline | null = null, l0: GPUBindGroupLayout | null = null, l1: GPUBindGroupLayout | null = null;
	let ub: GPUBuffer | null = null, ubSlots = 0, uData = new ArrayBuffer(0), dummyDep: GPUTexture | null = null, dummyRgb: GPUBuffer | null = null;
	let bg0: GPUBindGroup | null = null, bg0Tex: GPUTexture | null = null, bg0Ub: GPUBuffer | null = null, bg0Views: (GPUTextureView | null)[] = [];
	let dummyView: GPUTextureView | null = null, gSamp: GPUSampler | null = null;
	const jac = new WeakMap<Layer, { rAx: number; lon0: number; lat0: number; gLon: number[]; gLat: number[] }>();
	const layers = new Map<string, Layer>(), probes: unknown[] = [];
	let style: Style = { mode: "rgb", size: 2, attenuation: true, elevRange: [0, 100], intensityRange: [0, 65535], opacity: 1, lift: 0, liftM: 0 };
	const mvpL = new Float64Array(16);

	const mkBuf = (data: ArrayBufferView, usage: number, label: string): GPUBuffer => {
		const size = Math.max(16, Math.ceil(data.byteLength / 16) * 16);
		const b = device!.createBuffer({ label, size, usage, mappedAtCreation: true });
		new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); b.unmap();
		return b;
	};
	async function init(canvas: OffscreenCanvas, opts: { depth?: boolean } = {}, h: OverlayHost | null = null): Promise<void> {
		host = h;
		const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
		if (!gpu) throw new Error("WebGPU is not available (navigator.gpu)");
		const sharedDev = h?.gpuDevice?.() ?? null;
		if (!sharedDev) throw new Error("map is not drawing with WebGPU (no shared device)");   // 自前の device は立てない（本体が GL2＝この器では WebGPU を諦めている）
		device = sharedDev; shared = true;
		if (dead) return;
		wantDepth = opts.depth !== false;
		format = gpu.getPreferredCanvasFormat();
		// pipeline を先に組む（失敗したら canvas の文脈を取らずに投げる＝WebGL2 へ落とせる）
		l0 = device.createBindGroupLayout({ label: "copc-u", entries: [{ binding: 0, visibility: STAGE.VERTEX | STAGE.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } }, { binding: 1, visibility: STAGE.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
			{ binding: 2, visibility: STAGE.VERTEX, sampler: { type: "filtering" } }, ...[3, 4, 5, 6, 7].map(binding => ({ binding, visibility: STAGE.VERTEX, texture: { sampleType: "float" as GPUTextureSampleType, viewDimension: "2d" as GPUTextureViewDimension } }))] });
		l1 = device.createBindGroupLayout({ label: "copc-pts", entries: [0, 1, 2, 3, 4].map(binding => ({ binding, visibility: STAGE.VERTEX, buffer: { type: "read-only-storage" as GPUBufferBindingType } })) });
		const m = device.createShaderModule({ code: WGSL, label: "copc" });
		const info = await m.getCompilationInfo();
		const bad = (info.messages || []).filter(x => x.type === "error").map(x => `${x.lineNum}:${x.linePos} ${x.message}`);
		if (bad.length) throw new Error(`copc WGSL: ${bad.join("; ")}`);
		if (dead) return;
		const blend: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } };
		pipe = await device.createRenderPipelineAsync({ label: "copc-draw", layout: device.createPipelineLayout({ bindGroupLayouts: [l0, l1] }), vertex: { module: m, entryPoint: "vs" }, fragment: { module: m, entryPoint: "fs", targets: [{ format, blend }] }, primitive: { topology: "triangle-list" } });
		if (dead) return;
		dummyDep = device.createTexture({ label: "copc-dep0", size: [1, 1], format: "rgba8unorm", usage: TEX.TEXTURE_BINDING | TEX.COPY_DST });
		dummyView = dummyDep.createView();
		gSamp = device.createSampler({ label: "copc-ground", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
		dummyRgb = device.createBuffer({ label: "copc-rgb0", size: 16, usage: BUF.STORAGE });
		ensureUb(64);
		const c = canvas.getContext("webgpu" as "2d") as unknown as GPUCanvasContext | null;   // lib.dom の OffscreenCanvas は "webgpu" の overload を持たない
		if (!c) throw new Error("webgpu canvas context unavailable");
		c.configure({ device, format, alphaMode: "premultiplied", usage: TEX.RENDER_ATTACHMENT | TEX.COPY_SRC });
		ctx = c;
	}
	// 層の uniform の枡（足りなくなったら倍に）
	function ensureUb(slots: number): void {
		if (slots <= ubSlots) return;
		let n = Math.max(64, ubSlots); while (n < slots) n *= 2;
		ub?.destroy();
		ub = device!.createBuffer({ label: "copc-ub", size: n * SLOT, usage: BUF.UNIFORM | BUF.COPY_DST });
		ubSlots = n; uData = new ArrayBuffer(n * SLOT);
	}
	const drop = (L: Layer | undefined): void => { if (!L) return; for (const b of L.bufs) b.destroy(); };
	function message(d: Msg): void {
		if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
		if (!device || !ctx) return;
		if (d.type === "layer") {
			drop(layers.get(d.q));
			let rgb: GPUBuffer | null = null;
			if (d.rgb) { const u = new Uint32Array(d.n); for (let i = 0, j = 0; i < d.n; i++, j += 3) u[i] = 0xff000000 | (d.rgb[j + 2] << 16) | (d.rgb[j + 1] << 8) | d.rgb[j]; rgb = mkBuf(u, BUF.STORAGE, "copc-rgb"); }
			const bufs = [mkBuf(d.pos, BUF.STORAGE, "copc-pos"), mkBuf(d.intensity, BUF.STORAGE, "copc-int"), mkBuf(d.cls, BUF.STORAGE, "copc-cls"), mkBuf(d.elev, BUF.STORAGE, "copc-elev")];
			if (rgb) bufs.push(rgb);
			const bg = device.createBindGroup({ layout: l1!, entries: [{ binding: 0, resource: { buffer: bufs[0] } }, { binding: 1, resource: { buffer: rgb ?? dummyRgb! } }, { binding: 2, resource: { buffer: bufs[1] } }, { binding: 3, resource: { buffer: bufs[2] } }, { binding: 4, resource: { buffer: bufs[3] } }] });
			layers.set(d.q, { n: d.n, bufs, bg, origin: d.origin, spacing: d.spacing || 0, on: true, hasRgb: !!rgb });
		} else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); }
		else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; }
		else if (d.type === "clear") { layers.forEach(drop); layers.clear(); }
		else if (d.type === "style") { style = { ...style, ...d }; }
		host?.requestDraw?.();
	}
	// 検定の probe＝canvas の今の絵を buffer へ写して読む（行は上から・BGRA は RGBA へ）
	async function readCanvas(w: number, h: number): Promise<Uint8Array> {
		const tex = ctx!.getCurrentTexture(), bpr = align256(w * 4);
		const buf = device!.createBuffer({ size: bpr * h, usage: BUF.MAP_READ | BUF.COPY_DST });
		const enc = device!.createCommandEncoder();
		enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
		device!.queue.submit([enc.finish()]);
		await buf.mapAsync(BUF.MAP_READ);
		const src = new Uint8Array(buf.getMappedRange()), out = new Uint8Array(w * h * 4), bgra = /^bgra/.test(format);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * bpr + x * 4, o = (y * w + x) * 4; out[o] = src[i + (bgra ? 2 : 0)]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + (bgra ? 0 : 2)]; out[o + 3] = src[i + 3]; }
		buf.unmap(); buf.destroy();
		return out;
	}
	function answerProbes(w: number, h: number): void {
		if (!probes.length) return;
		const ids = probes.splice(0), info = { layers: layers.size, depth: wantDepth, backend: "webgpu" };
		readCanvas(w, h).then(data => { for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: false, info, data: id === ids[ids.length - 1] ? data : data.slice() }); })
			.catch(e => { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as Error)?.message || e) }); });
	}
	// 節の原点の経緯度と「原点からの変位（世界単位）→ 経緯度の差（度）」の 2 行（接平面への擬似逆行列）＝点ごとの atan2 を避け、f32 でも 0.2 m の画素に合う
	//   世界座標＝meshdecode の geoWorld（球 rAx＝1／楕円体＝β 単位球）。節は数百 m＝曲率の 2 次の誤差は mm
	function layerJac(L: Layer, rAx: number) {
		const c = jac.get(L);
		if (c && c.rAx === rAx) return c;
		const o = L.origin, hz = Math.hypot(o[0], o[2]);
		const lon = Math.atan2(o[2], o[0]), lat = Math.atan(o[1] / (rAx * hz));
		const W = (lo: number, la: number) => { const cb = Math.cos(la), sp = Math.sin(la), w = Math.hypot(cb, rAx * sp), h = cb / w; return [h * Math.cos(lo), rAx * sp / w, h * Math.sin(lo)]; };
		const e = 1e-6, a = W(lon + e, lat), b = W(lon - e, lat), c2 = W(lon, lat + e), d = W(lon, lat - e);
		const Jl = [0, 1, 2].map(i => (a[i] - b[i]) / (2 * e * R2D)), Jp = [0, 1, 2].map(i => (c2[i] - d[i]) / (2 * e * R2D));   // 1 度あたりの世界の変位
		const ll = Jl[0] * Jl[0] + Jl[1] * Jl[1] + Jl[2] * Jl[2], pp = Jp[0] * Jp[0] + Jp[1] * Jp[1] + Jp[2] * Jp[2], lp = Jl[0] * Jp[0] + Jl[1] * Jp[1] + Jl[2] * Jp[2], det = ll * pp - lp * lp;
		const gLon = [0, 1, 2].map(i => (pp * Jl[i] - lp * Jp[i]) / det), gLat = [0, 1, 2].map(i => (ll * Jp[i] - lp * Jl[i]) / det);   // (JᵀJ)⁻¹Jᵀ
		const r = { rAx, lon0: lon * R2D, lat0: lat * R2D, gLon, gLat };
		jac.set(L, r);
		return r;
	}
	function frame(cam: CameraPose, s: CameraState, { w, h }: OverlaySize, api: OverlayApi): boolean {
		if (!device || !ctx || !pipe) return false;
		const vis = [...layers.values()].filter(L => L.on && L.n);
		const enc = device.createCommandEncoder({ label: "copc-frame" });
		if (vis.length) {
			const dep = wantDepth && api?.depth ? { tex: api.depth.gpuTexture(device), w: api.depth.w, h: api.depth.h, logCoef: api.depth.logCoef } : null;
			const tex = dep ? dep.tex : dummyDep!;
			ensureUb(vis.length);
			// 地面（段 3）＝地面の色・地面からの高さの時だけ本体の資源を問う（view は毎フレーム・窓の作り直しで替わる）
			const gm = style.mode === "ground" || style.mode === "heightAboveGround";
			const gg = gm ? host?.groundGpu?.() ?? null : null;
			const gw = gg && style.mode === "ground" ? gg.windows.slice(0, 4) : [], ge = gg && style.mode === "heightAboveGround" ? gg.elev : null;
			const views: (GPUTextureView | null)[] = [0, 1, 2, 3].map(k => gw[k]?.view ?? null); views.push(ge?.view ?? null);
			if (!bg0 || bg0Tex !== tex || bg0Ub !== ub || views.some((v, k) => v !== bg0Views[k])) {
				bg0 = device.createBindGroup({ layout: l0!, entries: [{ binding: 0, resource: { buffer: ub!, size: SLOT } }, { binding: 1, resource: tex.createView() }, { binding: 2, resource: gSamp! }, ...views.map((v, k) => ({ binding: 3 + k, resource: v ?? dummyView! }))] });
				bg0Tex = tex; bg0Ub = ub; bg0Views = views;
			}
			const rAx = api?.rAx || 1;
			const dpr = cam.dpr || 1, M = s.mvp, F = new Float32Array(uData), I = new Uint32Array(uData);
			const mode = MODES[style.mode] ?? 0, size = Math.max(0.5, style.size * dpr);
			vis.forEach((L, k) => {
				const o = L.origin, f = k * (SLOT / 4);   // mvp·T(o)＝4 列目だけが変わる（倍精度で掛ける）
				for (let i = 0; i < 12; i++) mvpL[i] = M[i];
				for (let r = 0; r < 4; r++) mvpL[12 + r] = M[r] * o[0] + M[4 + r] * o[1] + M[8 + r] * o[2] + M[12 + r];
				for (let i = 0; i < 16; i++) F[f + i] = mvpL[i];
				F[f + 16] = o[0]; F[f + 17] = o[1]; F[f + 18] = o[2]; F[f + 19] = L.spacing;
				F[f + 20] = s.eye[0]; F[f + 21] = s.eye[1]; F[f + 22] = s.eye[2]; F[f + 23] = s.focal;
				F[f + 24] = w; F[f + 25] = h; F[f + 26] = dep ? dep.w : 1; F[f + 27] = dep ? dep.h : 1;
				F[f + 28] = style.elevRange[0]; F[f + 29] = style.elevRange[1]; F[f + 30] = style.intensityRange[0]; F[f + 31] = style.intensityRange[1];
				F[f + 32] = size; F[f + 33] = style.attenuation ? 1 : 0; F[f + 34] = MAX_RAD; F[f + 35] = style.opacity ?? 1;
				F[f + 36] = style.lift || 0; F[f + 37] = style.liftM || 0; F[f + 38] = dep ? dep.logCoef : 1; F[f + 39] = 2e-6;
				I[f + 40] = mode; I[f + 41] = dep ? 1 : 0; I[f + 42] = L.hasRgb ? 1 : 0; I[f + 43] = 0;
				if (mode >= 4) {
					const J = layerJac(L, rAx), ll0 = [J.lon0, J.lat0];
					F[f + 44] = J.gLon[0]; F[f + 45] = J.gLon[1]; F[f + 46] = J.gLon[2]; F[f + 47] = gw.length;
					F[f + 48] = J.gLat[0]; F[f + 49] = J.gLat[1]; F[f + 50] = J.gLat[2]; F[f + 51] = gg?.split ? 1 : 0;
					// 原点の分（経緯度 − 窓の角）は倍精度で引いてから f32＝0.2 m の画素でもずれない
					if (ge) { const b = ge.bounds; F[f + 52] = (ll0[0] - b[0]) / b[2]; F[f + 53] = (ll0[1] - b[1]) / b[3]; F[f + 54] = 1 / b[2]; F[f + 55] = 1 / b[3]; }
					for (let k = 0; k < 4; k++) {
						const a = gw[k], o4 = f + 56 + k * 4;
						if (a) { F[o4] = (ll0[0] - a.win[0]) / a.win[2]; F[o4 + 1] = (ll0[1] - a.win[1]) / a.win[3]; F[o4 + 2] = 1 / a.win[2]; F[o4 + 3] = 1 / a.win[3]; }
						else { F[o4] = -1; F[o4 + 1] = -1; F[o4 + 2] = 0; F[o4 + 3] = 0; }
					}
					F[f + 72] = ge ? 1 : 0; F[f + 73] = L.spacing * R2D; F[f + 74] = 0; F[f + 75] = 0;
				}
			});
			device.queue.writeBuffer(ub!, 0, uData, 0, vis.length * SLOT);
		}
		const pass = enc.beginRenderPass({ label: "copc-draw", colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
		if (vis.length) { pass.setPipeline(pipe); vis.forEach((L, k) => { pass.setBindGroup(0, bg0!, [k * SLOT]); pass.setBindGroup(1, L.bg); pass.draw(6, L.n); }); }
		pass.end();
		device.queue.submit([enc.finish()]);
		answerProbes(w, h);
		return false;
	}
	function destroy(): void {
		dead = true;
		layers.forEach(drop); layers.clear();
		ub?.destroy(); dummyDep?.destroy(); dummyRgb?.destroy(); bg0Views = [];
		try { ctx?.unconfigure(); } catch { /* 古い実装 */ }
		device = null; ctx = null; bg0 = null;   // device は本体の物＝壊さない
	}
	return { init, message, frame, destroy, get shared() { return shared; } };
}
