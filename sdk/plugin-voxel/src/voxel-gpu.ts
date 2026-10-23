// voxel の WebGPU の描き手（同一フレームのオーバーレイ）。@ortho-earth/plugin-voxel（第 2 段・2026-10-23）。
// ⚠ 依存ゼロ（実行時の import 文なし・型だけの import は消える）＝voxel-draw.ts が URL で import() し、create() で実体を作る。
// 本体が WebGPU なら host.gpuDevice() の device を共有し、深度は本体の詰めた GPUTexture（api.depth.gpuTexture(device)）をそのまま束ねる（コピー・読み戻しなし）。
// 本体が WebGL2 なら自前の adapter/device を取り、深度は api.depth.gpuTexture(device) が writeTexture で上げた物を読む。
// 描き方＝voxel-gl.ts と同じ数式（箱／殻の裏面＋FS の光線行進・DDA／三線形合成／等値面・断面・シーンの深度で切る）。3D テクスチャ＝r8unorm か rgba8unorm（filterable）。
// 当たり＝番号を r32uint に焼く別パス（scissor で読む画素だけ）→ buffer へ写して mapAsync（非同期＝pick は Promise）。
import type { OverlayFrameApi } from "@ortho-earth/globe";
import type { VoxelMessage, VoxelLayerBody, VoxelPickResult, VoxelAltitude, CamState, VoxelApi, PickContext, OverlayHost } from "./voxel-gl.ts";
import type { GeoGrid, Clip } from "./grid.ts";

const BUF = { MAP_READ: 0x01, COPY_SRC: 0x04, COPY_DST: 0x08, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const TEX = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 } as const;
const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2 } as const;
const R_SPHERE = 6371000, R_ELL = 6378137, D2R = Math.PI / 180, UB_SIZE = 416;
const LIGHT = ((): number[] => { const v = [-0.35, 0.45, 0.82], l = Math.hypot(...v); return v.map(x => x / l); })();

const WGSL = /* wgsl */`
struct Uni {
	mvp: mat4x4f,        // 0
	nrm: mat3x3f,        // 16（列 4 幅）
	gradM: mat3x3f,      // 28
	eye: vec3f, R: f32,          // 40
	dims: vec3f, step: f32,      // 44
	lo: vec3f, thr: f32,         // 48
	hi: vec3f, opacity: f32,     // 52
	o: vec3f, rAx: f32,          // 56
	E: vec3f, gw: f32,           // 60
	N: vec3f, gs: f32,           // 64
	Uu: vec3f, gspanLon: f32,    // 68
	bs: vec4f,                   // 72
	gspanLat: f32, gh0: f32, gh1: f32, pad0: f32,   // 76
	vp: vec2f, ddim: vec2f,      // 80
	logCoef: f32, eps: f32, pad1: f32, pad2: f32,   // 84
	light: vec3f, pad3: f32,     // 88
	mode: u32, comps: u32, maxSteps: u32, geo: u32,   // 92
	base: u32, occl: u32, depthOn: u32, pad4: u32,    // 96
};
@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var vol: texture_3d<f32>;
@group(0) @binding(2) var cmap: texture_2d<f32>;
@group(0) @binding(3) var lin: sampler;
@group(0) @binding(4) var dep: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) p: vec3f }
@vertex fn vs(@location(0) a: vec3f) -> VO {
	var o: VO;
	let p = select(a, a * U.dims, U.geo == 0u);
	o.p = p; o.pos = U.mvp * vec4f(p, 1.0);
	return o;
}
fn cellOf(p: vec3f) -> vec3f {
	if (U.geo == 0u) { return p; }
	let P = U.o + (U.E * p.x + U.N * p.y + U.Uu * p.z) / U.R;
	let r = length(P);
	var lat = asin(clamp(P.y / r, -1.0, 1.0));
	if (U.rAx != 1.0) { lat = atan(tan(lat) / U.rAx); }
	let lon = degrees(atan2(P.z, P.x));
	let dl = (lon - U.gw) - 360.0 * floor((lon - U.gw) / 360.0);
	return vec3f(dl / U.gspanLon * U.dims.x, (degrees(lat) - U.gs) / U.gspanLat * U.dims.y, ((r - 1.0) * U.R - U.gh0) / (U.gh1 - U.gh0) * U.dims.z);
}
fn inRange(c: vec3f) -> bool { return all(c >= U.lo) && all(c < U.hi); }
fn fetchCell(c: vec3i) -> vec4f { return textureLoad(vol, c, 0); }
fn sampleAt(c: vec3f) -> vec4f { return textureSampleLevel(vol, lin, c / U.dims, 0.0); }
fn cmapAt(v: f32) -> vec4f { return textureSampleLevel(cmap, lin, vec2f(v, 0.5), 0.0); }
// セルの値（R8＝0 は空・1〜255 → 0〜1。RGBA＝そのまま・α 0 は空）＝色と solid
fn cellColor(c: vec3i) -> vec4f {
	let s = fetchCell(c);
	if (U.comps == 4u) { return s; }
	let vn = (s.r * 255.0 - 1.0) / 254.0;
	return cmapAt(vn);
}
fn cellSolid(c: vec3i) -> bool {
	let s = fetchCell(c);
	if (U.comps == 4u) { return s.a > 0.0; }
	let vn = (s.r * 255.0 - 1.0) / 254.0;
	return s.r > 0.0 && vn >= U.thr;
}
fn valueAt(c: vec3f) -> f32 {
	let s = sampleAt(c);
	if (U.comps == 4u) { return select(-1.0, s.a, s.a > 0.0); }
	return select(-1.0, (s.r * 255.0 - 1.0) / 254.0, s.r > 0.5 / 255.0);
}
fn shade(col: vec4f, ne: vec3f) -> vec4f { let l = 0.55 + 0.45 * max(0.0, dot(ne, U.light)); let a = U.opacity; return vec4f(col.rgb * l * a, a); }
fn cellId(c: vec3i) -> u32 { return U.base + u32(c.x + i32(U.dims.x) * (c.y + i32(U.dims.y) * c.z)); }
// 本体の深度（詰めた 24 bit の対数深度・行は下から＝GL）→ 光線の w（pos＝画素・上から）
fn sceneW(pos: vec2f) -> f32 {
	if (U.depthOn == 0u) { return -1.0; }
	let uv = vec2f(pos.x / U.vp.x, 1.0 - pos.y / U.vp.y);
	let t = vec2i(clamp(uv * U.ddim, vec2f(0.0), U.ddim - 1.0));
	let c = floor(textureLoad(dep, t, 0).rgb * 255.0 + 0.5);
	let s = dot(c, vec3f(65536.0, 256.0, 1.0)) / 16777215.0;
	if (s >= 1.0) { return -1.0; }
	return exp2(2.0 * s / U.logCoef) - 1.0;
}
struct Hit { ok: bool, col: vec4f, id: u32 }
fn march(pos: vec2f, vp: vec3f, pick: bool) -> Hit {
	var h: Hit; h.ok = false; h.col = vec4f(0.0); h.id = 0u;
	let ro = U.eye; let rd = normalize(vp - ro);
	var t0 = 0.0; var t1 = 0.0; var axis0 = -1; var inside = false;
	if (U.geo == 0u) {
		let inv = 1.0 / rd;
		let ta = (U.lo - ro) * inv; let tb = (U.hi - ro) * inv; let tmin = min(ta, tb); let tmax = max(ta, tb);
		t0 = max(max(tmin.x, tmin.y), tmin.z); t1 = min(min(tmax.x, tmax.y), tmax.z);
		axis0 = select(select(2, 1, t0 == tmin.y), 0, t0 == tmin.x);
		inside = t0 < 0.0; t0 = max(t0, 0.0);
	} else {
		t1 = length(vp - ro);
		let oc = ro - U.bs.xyz; let b = dot(oc, rd); let c = dot(oc, oc) - U.bs.w * U.bs.w; let disc = b * b - c;
		t0 = select(0.0, max(0.0, -b - sqrt(disc)), disc > 0.0);
	}
	if (U.occl != 0u) {
		let ws = sceneW(pos);
		if (ws >= 0.0) {
			let w0 = dot(vec4f(ro, 1.0), vec4f(U.mvp[0][3], U.mvp[1][3], U.mvp[2][3], U.mvp[3][3])); let dw = dot(rd, vec3f(U.mvp[0][3], U.mvp[1][3], U.mvp[2][3]));
			if (dw > 1e-12) { t1 = min(t1, (ws - w0) / dw); }
		}
	}
	if (t1 <= t0) { return h; }
	if (U.mode == 0u && U.geo == 0u) {   // box の blocks＝DDA
		let p = ro + rd * (t0 + 1e-4);
		var c = clamp(vec3i(floor(p)), vec3i(floor(U.lo)), vec3i(ceil(U.hi)) - 1);
		let st = vec3i(sign(rd));
		let inv = 1.0 / rd;
		var tMax = (vec3f(c) + vec3f(rd > vec3f(0.0)) - ro) * inv; let tDelta = abs(inv);
		var axis = select(axis0, -1, inside);
		for (var i = 0u; i < 1024u; i++) {
			if (i >= U.maxSteps) { break; }
			if (cellSolid(c)) {
				if (pick) { h.ok = true; h.id = cellId(c); return h; }
				var nc = -rd;
				if (axis == 0) { nc = vec3f(-f32(st.x), 0.0, 0.0); } else if (axis == 1) { nc = vec3f(0.0, -f32(st.y), 0.0); } else if (axis == 2) { nc = vec3f(0.0, 0.0, -f32(st.z)); }
				h.ok = true; h.col = shade(cellColor(c), normalize(U.nrm * nc)); return h;
			}
			if (tMax.x < tMax.y && tMax.x < tMax.z) { if (tMax.x > t1) { break; } c.x += st.x; tMax.x += tDelta.x; axis = 0; }
			else if (tMax.y < tMax.z) { if (tMax.y > t1) { break; } c.y += st.y; tMax.y += tDelta.y; axis = 1; }
			else { if (tMax.z > t1) { break; } c.z += st.z; tMax.z += tDelta.z; axis = 2; }
			if (any(c < vec3i(0)) || any(c >= vec3i(U.dims))) { break; }
		}
		return h;
	}
	let jit = fract(sin(dot(pos, vec2f(12.9898, 78.233))) * 43758.5453);
	var t = t0 + U.step * (0.25 + 0.5 * jit);
	var acc = vec4f(0.0);
	var prevC = vec3i(-1); var prevV = -1.0; var prevT = t0; var havePrev = false;
	for (var i = 0u; i < 4096u; i++) {
		if (i >= U.maxSteps || t >= t1) { break; }
		let p = ro + rd * t; let c = cellOf(p);
		if (inRange(c)) {
			if (U.mode == 0u) {
				let ci = vec3i(floor(c));
				if (cellSolid(ci)) {
					if (pick) { h.ok = true; h.id = cellId(ci); return h; }
					var nc = -rd;
					if (havePrev) { let d = ci - prevC; if (d.x != 0) { nc = vec3f(-f32(sign(d.x)), 0.0, 0.0); } else if (d.y != 0) { nc = vec3f(0.0, -f32(sign(d.y)), 0.0); } else if (d.z != 0) { nc = vec3f(0.0, 0.0, -f32(sign(d.z))); } }
					h.ok = true; h.col = shade(cellColor(ci), normalize(U.nrm * nc)); return h;
				}
				prevC = ci; havePrev = true;
			} else if (U.mode == 1u) {
				let s = sampleAt(c);
				var col = vec4f(0.0); var a = 0.0;
				if (U.comps == 4u) { col = s; a = s.a; }
				else { let vn = (s.r * 255.0 - 1.0) / 254.0; if (s.r > 0.5 / 255.0 && vn >= U.thr) { col = cmapAt(max(vn, 0.0)); a = col.a; } }
				if (a > 0.0) {
					a = 1.0 - pow(1.0 - min(a * U.opacity, 0.999), select(1.0, U.step, U.geo == 0u));
					acc = vec4f(acc.rgb + (1.0 - acc.a) * col.rgb * a, acc.a + (1.0 - acc.a) * a);
					if (pick) { if (acc.a >= 0.5) { h.ok = true; h.id = cellId(clamp(vec3i(floor(c)), vec3i(0), vec3i(U.dims) - 1)); return h; } }
					else if (acc.a > 0.98) { break; }
				}
			} else {
				let v = valueAt(c);
				if (havePrev && (prevV - U.thr) * (v - U.thr) < 0.0) {
					var a = prevT; var b = t; var va = prevV;
					for (var k = 0u; k < 6u; k++) { let m = 0.5 * (a + b); let vm = valueAt(cellOf(ro + rd * m)); if ((vm - U.thr) * (va - U.thr) < 0.0) { b = m; } else { a = m; va = vm; } }
					let ch = cellOf(ro + rd * b);
					if (pick) { h.ok = true; h.id = cellId(clamp(vec3i(floor(ch)), vec3i(0), vec3i(U.dims) - 1)); return h; }
					let g = vec3f(valueAt(ch + vec3f(0.5, 0.0, 0.0)) - valueAt(ch - vec3f(0.5, 0.0, 0.0)), valueAt(ch + vec3f(0.0, 0.5, 0.0)) - valueAt(ch - vec3f(0.0, 0.5, 0.0)), valueAt(ch + vec3f(0.0, 0.0, 0.5)) - valueAt(ch - vec3f(0.0, 0.0, 0.5)));
					var ne = U.gradM * g; ne = select(-rd, normalize(ne), dot(ne, ne) > 1e-12);
					if (dot(ne, U.nrm * rd) > 0.0) { ne = -ne; }
					let col = select(cmapAt(U.thr), sampleAt(ch), U.comps == 4u);
					h.ok = true; h.col = shade(col, ne); return h;
				}
				prevV = v; prevT = t; havePrev = true;
			}
		} else { havePrev = false; }
		t += U.step;
	}
	if (U.mode == 1u && !pick && acc.a >= 1.0 / 255.0) { h.ok = true; h.col = acc; }
	return h;
}
@fragment fn fs(v: VO) -> @location(0) vec4f { let h = march(v.pos.xy, v.p, false); if (!h.ok) { discard; } return h.col; }
@fragment fn fsPick(v: VO) -> @location(0) u32 { let h = march(v.pos.xy, v.p, true); if (!h.ok) { discard; } return h.id; }`;

interface Layer {
	q: string; shape: "box" | "region"; dims: [number, number, number]; comps: 1 | 4; n: number; anchor: [number, number, number]; alt: VoxelAltitude; A: Float64Array; Ainv: Float64Array; radius: number;
	mode: 0 | 1 | 2; thr: number; step: number; opacity: number; occl: boolean; clip: Clip | null; properties: Record<string, unknown> | null; range: [number, number];
	tex: GPUTexture; cmap: GPUTexture; vb: GPUBuffer; nVerts: number; ub: GPUBuffer; bg: GPUBindGroup | null; bgDep: GPUTexture | null;
	on: boolean; base: number; dist: number; nrm: Float32Array; gradM: Float32Array; geo: GeoGrid | null;
}
export interface VoxelGpuModule {
	init(canvas: OffscreenCanvas, opts: { depth?: boolean }, host: OverlayHost | null): Promise<void>;
	message(d: VoxelMessage): void;
	frame(cam: unknown, s: CamState, size: { w: number; h: number }, api: VoxelApi): boolean;
	pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): Promise<VoxelPickResult | null>;
	destroy(): void;
	readonly shared: boolean;
}
export interface EnuBasis { E: number[]; N: number[]; U: number[]; u: number[] }
const unit = (lon: number, lat: number, rAx: number): number[] => { const a = lon * D2R; let b = lat * D2R; if (rAx !== 1) b = Math.atan(rAx * Math.tan(b)); const cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; };
export function enuBasis(lon: number, lat: number, rAx = 1): EnuBasis {
	const u = unit(lon, lat, rAx), cl = Math.hypot(u[0], u[2]), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL);
	const E = cl < 1e-12 ? [1, 0, 0] : [-u[2] / cl, 0, u[0] / cl], N = [E[1] * u[2] - E[2] * u[1], E[2] * u[0] - E[0] * u[2], E[0] * u[1] - E[1] * u[0]];
	return { E: E.map(v => v * k), N: N.map(v => v * k), U: u.map(v => v * k), u };
}
function inv3(m: ArrayLike<number>): Float64Array {
	const [a, b, c, d, e, f, g, h, i] = Array.from(m, Number);
	const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C, k = 1 / det;
	return Float64Array.from([A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k]);
}
const BOX = ((): Float32Array => {
	const f = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
	const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
	const out: number[] = [];
	for (const [a, b, c, d] of f) for (const i of [a, c, b, a, d, c]) out.push(...v[i]);
	return new Float32Array(out);
})();
const stepsOf = (L: Layer): { step: number; maxSteps: number } => {
	if (L.geo) { const cm = Math.min(...L.geo.cellM), step = (L.mode === 0 ? Math.min(L.step, 0.25) : L.step) * cm; return { step, maxSteps: Math.min(4096, Math.ceil(2 * L.geo.bs[3] / step) + 2) }; }
	if (L.mode === 0) return { step: L.step, maxSteps: L.dims[0] + L.dims[1] + L.dims[2] + 2 };
	return { step: L.step, maxSteps: Math.min(4096, Math.ceil(Math.hypot(L.dims[0], L.dims[1], L.dims[2]) / L.step) + 2) };
};
const align256 = (v: number): number => Math.ceil(v / 256) * 256;

export function create(): VoxelGpuModule {
	let device: GPUDevice | null = null, ctx: GPUCanvasContext | null = null, host: OverlayHost | null = null, format: GPUTextureFormat = "rgba8unorm";
	let shared = false, wantDepth = false, dead = false;
	let drawPipe: GPURenderPipeline | null = null, pickPipe: GPURenderPipeline | null = null, layout: GPUBindGroupLayout | null = null, sampler: GPUSampler | null = null, dummyDep: GPUTexture | null = null, boxVb: GPUBuffer | null = null;
	let pickTex: GPUTexture | null = null, pickW = 0, pickH = 0;
	const layers = new Map<string, Layer>(), probes: unknown[] = [];
	const uData = new ArrayBuffer(UB_SIZE), uF = new Float32Array(uData), uU = new Uint32Array(uData);
	const mvpL = new Float64Array(16), mvpC = new Float64Array(16), eyeC = [0, 0, 0], geoU = { o: [0, 0, 0], E: [0, 0, 0], N: [0, 0, 0], U: [0, 0, 0], R: 0, rAx: 1 };

	const mkBuf = (data: ArrayBufferView, usage: number, label: string): GPUBuffer => {
		const size = Math.max(16, Math.ceil(data.byteLength / 16) * 16);
		const b = device!.createBuffer({ label, size, usage, mappedAtCreation: true });
		new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); b.unmap();
		return b;
	};
	async function compile(code: string, label: string): Promise<GPUShaderModule> {
		const m = device!.createShaderModule({ code, label });
		const info = await m.getCompilationInfo();
		const bad = (info.messages || []).filter(x => x.type === "error").map(x => `${x.lineNum}:${x.linePos} ${x.message}`);
		if (bad.length) throw new Error(`plugin-voxel WGSL ${label}: ${bad.join("; ")}`);
		return m;
	}
	async function init(canvas: OffscreenCanvas, opts: { depth?: boolean } = {}, h: OverlayHost | null = null): Promise<void> {
		host = h;
		const gpu = (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
		if (!gpu) throw new Error("WebGPU is not available (navigator.gpu)");
		const sharedDev = h?.gpuDevice?.() ?? null;
		if (sharedDev) { device = sharedDev; shared = true; }
		else { const ad = await gpu.requestAdapter(); if (!ad) throw new Error("WebGPU adapter unavailable"); device = await ad.requestDevice(); }
		if (dead) return;
		wantDepth = opts.depth !== false;
		format = gpu.getPreferredCanvasFormat();
		layout = device.createBindGroupLayout({ label: "voxel", entries: [
			{ binding: 0, visibility: STAGE.VERTEX | STAGE.FRAGMENT, buffer: { type: "uniform" } },
			{ binding: 1, visibility: STAGE.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
			{ binding: 2, visibility: STAGE.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
			{ binding: 3, visibility: STAGE.FRAGMENT, sampler: { type: "filtering" } },
			{ binding: 4, visibility: STAGE.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } }] });
		const m = await compile(WGSL, "voxel");
		if (dead) return;
		const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
		const blend: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } };
		const vertex: GPUVertexState = { module: m, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] };
		const primitive: GPUPrimitiveState = { topology: "triangle-list", cullMode: "front", frontFace: "ccw" };
		[drawPipe, pickPipe] = await Promise.all([
			device.createRenderPipelineAsync({ label: "voxel-draw", layout: pl, vertex, fragment: { module: m, entryPoint: "fs", targets: [{ format, blend }] }, primitive }),
			device.createRenderPipelineAsync({ label: "voxel-pick", layout: pl, vertex, fragment: { module: m, entryPoint: "fsPick", targets: [{ format: "r32uint" }] }, primitive }),
		]);
		if (dead) return;
		sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", addressModeW: "clamp-to-edge" });
		dummyDep = device.createTexture({ label: "voxel-dep0", size: [1, 1], format: "rgba8unorm", usage: TEX.TEXTURE_BINDING | TEX.COPY_DST });
		boxVb = mkBuf(BOX, BUF.VERTEX, "voxel-box");
		const c = canvas.getContext("webgpu" as "2d") as unknown as GPUCanvasContext | null;
		if (!c) throw new Error("webgpu canvas context unavailable");
		c.configure({ device, format, alphaMode: "premultiplied", usage: TEX.RENDER_ATTACHMENT | TEX.COPY_SRC });
		ctx = c;
	}
	const upCmap = (t: GPUTexture, cmap: Uint8Array): void => { device!.queue.writeTexture({ texture: t }, cmap, { bytesPerRow: 1024 }, [256, 1]); };
	function build(d: VoxelLayerBody, q: string): Layer {
		const [nx, ny, nz] = d.dims, max3d = device!.limits.maxTextureDimension3D || 256;
		if (nx > max3d || ny > max3d || nz > max3d) throw new Error(`plugin-voxel: dims ${d.dims.join("×")} exceed maxTextureDimension3D ${max3d}`);
		const tex = device!.createTexture({ label: `voxel-${q}`, size: [nx, ny, nz], dimension: "3d", format: d.comps === 4 ? "rgba8unorm" : "r8unorm", usage: TEX.TEXTURE_BINDING | TEX.COPY_DST });
		device!.queue.writeTexture({ texture: tex }, d.tex, { bytesPerRow: nx * d.comps, rowsPerImage: ny }, [nx, ny, nz]);
		const cmap = device!.createTexture({ label: `voxel-cmap-${q}`, size: [256, 1], format: "rgba8unorm", usage: TEX.TEXTURE_BINDING | TEX.COPY_DST });
		upCmap(cmap, d.cmap);
		const A = Float64Array.from(d.A as ArrayLike<number>), Ainv = inv3(A), nrm = new Float32Array(9), gradM = new Float32Array(9);
		for (let c = 0; c < 3; c++) { const l = Math.hypot(A[c], A[3 + c], A[6 + c]) || 1; nrm[c * 3] = A[c] / l; nrm[c * 3 + 1] = A[3 + c] / l; nrm[c * 3 + 2] = A[6 + c] / l; }
		for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) gradM[c * 3 + r] = Ainv[c * 3 + r];
		const geo = d.shape === "region" ? d.geo ?? null : null;
		const vb = geo ? mkBuf(geo.shell, BUF.VERTEX, `voxel-shell-${q}`) : boxVb!, nVerts = geo ? geo.shell.length / 3 : 36;
		const ub = device!.createBuffer({ label: `voxel-u-${q}`, size: UB_SIZE, usage: BUF.UNIFORM | BUF.COPY_DST });
		return { q, shape: geo ? "region" : "box", dims: [nx, ny, nz], comps: d.comps, n: nx * ny * nz, anchor: d.anchor, alt: d.alt || "relative", A, Ainv, radius: d.radius || 0, mode: d.mode, thr: d.thr || 0, step: d.step || 0.5, opacity: d.opacity ?? 1, occl: d.depthTest !== false, clip: d.clip ?? null, properties: d.properties ?? null, range: d.range, tex, cmap, vb, nVerts, ub, bg: null, bgDep: null, on: d.on !== false, base: 0, dist: 0, nrm, gradM, geo };
	}
	const drop = (L: Layer | undefined): void => { if (!L) return; L.tex.destroy(); L.cmap.destroy(); L.ub.destroy(); if (L.vb !== boxVb) L.vb.destroy(); };
	function rebase(): void { let b = 1; for (const L of layers.values()) { L.base = b; b += L.n; } }
	function message(d: VoxelMessage): void {
		if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
		if (!device) return;
		if (d.type === "layer") {
			drop(layers.get(d.q)); layers.delete(d.q);
			try { layers.set(d.q, build(d, d.q)); } catch (e) { host?.post?.({ type: "error", q: d.q, error: String((e as { message?: string } | null)?.message || e) }); }
			rebase(); host?.requestDraw?.();
		}
		else if (d.type === "style") {
			const L = layers.get(d.q); if (!L) return;
			if (d.mode != null) L.mode = d.mode; if (d.thr != null) L.thr = d.thr; if (d.step != null) L.step = d.step; if (d.opacity != null) L.opacity = d.opacity;
			if (d.clip !== undefined) L.clip = d.clip ?? null; if (d.depthTest != null) L.occl = d.depthTest; if (d.properties !== undefined) L.properties = d.properties ?? null;
			if (d.cmap) upCmap(L.cmap, d.cmap);
			host?.requestDraw?.();
		}
		else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); host?.requestDraw?.(); }
		else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; host?.requestDraw?.(); }
		else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); host?.requestDraw?.(); }
	}
	function place(L: Layer, s: CamState, api: VoxelApi | null | undefined): boolean {
		const rAx = api?.rAx || 1, [lon, lat, alt] = L.anchor, B = enuBasis(lon, lat, rAx), R = rAx === 1 ? R_SPHERE : R_ELL, k = 1 / R;
		const ls = L.alt !== "absolute" ? (api?.liftScale || 0) : 0, r = 1 + (ls > 0 ? (api!.elevM(lon, lat) || 0) * ls : 0) + (alt || 0) * k;
		const o = [B.u[0] * r, B.u[1] * r, B.u[2] * r], M = s.mvp, cols = [B.E, B.N, B.U];
		for (let j = 0; j < 3; j++) for (let row = 0; row < 4; row++) mvpL[j * 4 + row] = M[row] * cols[j][0] + M[4 + row] * cols[j][1] + M[8 + row] * cols[j][2];
		for (let row = 0; row < 4; row++) mvpL[12 + row] = M[row] * o[0] + M[4 + row] * o[1] + M[8 + row] * o[2] + M[12 + row];
		const E = s.eye;
		if (!E) return false;
		const d = [E[0] - o[0], E[1] - o[1], E[2] - o[2]], enu = [0, 0, 0];
		for (let j = 0; j < 3; j++) enu[j] = (d[0] * cols[j][0] + d[1] * cols[j][1] + d[2] * cols[j][2]) * R * R;
		if (L.geo) {
			for (let i = 0; i < 16; i++) mvpC[i] = mvpL[i];
			for (let i = 0; i < 3; i++) { eyeC[i] = enu[i]; geoU.o[i] = o[i]; geoU.E[i] = cols[0][i] * R; geoU.N[i] = cols[1][i] * R; geoU.U[i] = cols[2][i] * R; }
			geoU.R = R; geoU.rAx = rAx;
		} else {
			const A = L.A;
			for (let c = 0; c < 3; c++) for (let row = 0; row < 4; row++) mvpC[c * 4 + row] = mvpL[row] * A[c] + mvpL[4 + row] * A[3 + c] + mvpL[8 + row] * A[6 + c];
			for (let row = 0; row < 4; row++) mvpC[12 + row] = mvpL[12 + row];
			const Ai = L.Ainv;
			for (let i = 0; i < 3; i++) eyeC[i] = Ai[i * 3] * enu[0] + Ai[i * 3 + 1] * enu[1] + Ai[i * 3 + 2] * enu[2];
		}
		L.dist = Math.hypot(d[0], d[1], d[2]);
		const rr = L.radius * k;
		const behind = o[0] * d[0] + o[1] * d[1] + o[2] * d[2] < -rr * Math.hypot(...o) - 1e-9;
		return !behind;
	}
	function writeU(L: Layer, w: number, h: number, dep: { tex: GPUTexture; w: number; h: number; logCoef: number } | null, pick: boolean): void {
		const { step, maxSteps } = stepsOf(L);
		for (let i = 0; i < 16; i++) uF[i] = mvpC[i];
		for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) { uF[16 + c * 4 + r] = L.nrm[c * 3 + r]; uF[28 + c * 4 + r] = L.gradM[c * 3 + r]; }
		uF[40] = eyeC[0]; uF[41] = eyeC[1]; uF[42] = eyeC[2]; uF[43] = geoU.R;
		uF[44] = L.dims[0]; uF[45] = L.dims[1]; uF[46] = L.dims[2]; uF[47] = step;
		for (let i = 0; i < 3; i++) { uF[48 + i] = (L.clip ? L.clip[i * 2] : 0) * L.dims[i]; uF[52 + i] = (L.clip ? L.clip[i * 2 + 1] : 1) * L.dims[i]; }
		uF[51] = L.thr; uF[55] = L.opacity;
		for (let i = 0; i < 3; i++) { uF[56 + i] = geoU.o[i]; uF[60 + i] = geoU.E[i]; uF[64 + i] = geoU.N[i]; uF[68 + i] = geoU.U[i]; }
		uF[59] = geoU.rAx; uF[63] = L.geo?.west ?? 0; uF[67] = L.geo?.south ?? 0; uF[71] = L.geo?.spanLon ?? 1;
		const bs = L.geo?.bs ?? [0, 0, 0, 0]; uF[72] = bs[0]; uF[73] = bs[1]; uF[74] = bs[2]; uF[75] = bs[3];
		uF[76] = L.geo?.spanLat ?? 1; uF[77] = L.geo?.h0 ?? 0; uF[78] = L.geo?.h1 ?? 1;
		uF[80] = w; uF[81] = h; uF[82] = dep ? dep.w : 1; uF[83] = dep ? dep.h : 1;
		uF[84] = dep ? dep.logCoef : 1; uF[85] = 2e-6;
		uF[88] = LIGHT[0]; uF[89] = LIGHT[1]; uF[90] = LIGHT[2];
		uU[92] = L.mode; uU[93] = L.comps; uU[94] = maxSteps; uU[95] = L.geo ? 1 : 0;
		uU[96] = L.base; uU[97] = L.occl ? 1 : 0; uU[98] = dep && !pick ? 1 : 0;
		device!.queue.writeBuffer(L.ub, 0, uData);
		const tex = dep && !pick ? dep.tex : dummyDep!;
		if (!L.bg || L.bgDep !== tex) {
			L.bg = device!.createBindGroup({ layout: layout!, entries: [{ binding: 0, resource: { buffer: L.ub } }, { binding: 1, resource: L.tex.createView({ dimension: "3d" }) }, { binding: 2, resource: L.cmap.createView() }, { binding: 3, resource: sampler! }, { binding: 4, resource: tex.createView() }] });
			L.bgDep = tex;
		}
	}
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
		const ids = probes.splice(0), ls = [...layers].map(([q, L]) => ({ q, on: L.on, n: L.n, dims: L.dims, mode: L.mode, shape: L.shape, dist: +L.dist.toFixed(4), anchor: L.anchor, alt: L.alt }));
		readCanvas(w, h).then(data => { for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: false, layers: ls, data: id === ids[ids.length - 1] ? data : data.slice() }); })
			.catch(e => { for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as { message?: string } | null)?.message || e) }); });
	}
	function frame(cam: unknown, s: CamState, { w, h }: { w: number; h: number }, api: VoxelApi): boolean {
		if (!device || !ctx || !drawPipe) return false;
		const d = api?.depth, dep = wantDepth && d ? { tex: d.gpuTexture(device), w: d.w, h: d.h, logCoef: d.logCoef } : null;
		const vis: Layer[] = [];
		for (const L of layers.values()) { if (!L.on || !L.n || !place(L, s, api)) continue; vis.push(L); }
		vis.sort((a, b) => b.dist - a.dist);
		const enc = device.createCommandEncoder({ label: "voxel-frame" });
		const pass = enc.beginRenderPass({ label: "voxel-draw", colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
		if (vis.length) { pass.setPipeline(drawPipe); for (const L of vis) { place(L, s, api); writeU(L, w, h, dep, false); pass.setBindGroup(0, L.bg!); pass.setVertexBuffer(0, L.vb); pass.draw(L.nVerts); } }
		pass.end();
		device.queue.submit([enc.finish()]);
		answerProbes(w, h);
		return false;
	}
	async function pick(x: number, y: number, r: number, ctx0: PickContext | null | undefined): Promise<VoxelPickResult | null> {
		if (!device || !pickPipe || !layers.size || !ctx0?.s) return null;
		const { w, h } = ctx0.size;
		if (!pickTex || pickW !== w || pickH !== h) { pickTex?.destroy(); pickTex = device.createTexture({ label: "voxel-pick", size: [w, h], format: "r32uint", usage: TEX.RENDER_ATTACHMENT | TEX.COPY_SRC }); pickW = w; pickH = h; }
		const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = Math.round(y) - rr;
		const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
		if (!(cx1 > cx0 && cy1 > cy0)) return null;
		const vis: Layer[] = [];
		for (const L of layers.values()) { if (!L.on || !L.n || !place(L, ctx0.s, ctx0.api)) continue; vis.push(L); }
		vis.sort((a, b) => b.dist - a.dist);
		const enc = device.createCommandEncoder({ label: "voxel-pick" });
		const pass = enc.beginRenderPass({ colorAttachments: [{ view: pickTex.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
		pass.setScissorRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
		if (vis.length) { pass.setPipeline(pickPipe); for (const L of vis) { place(L, ctx0.s, ctx0.api); writeU(L, w, h, null, true); pass.setBindGroup(0, L.bg!); pass.setVertexBuffer(0, L.vb); pass.draw(L.nVerts); } }
		pass.end();
		const cw = cx1 - cx0, ch = cy1 - cy0, bpr = align256(cw * 4);
		const buf = device.createBuffer({ size: bpr * ch, usage: BUF.MAP_READ | BUF.COPY_DST });
		enc.copyTextureToBuffer({ texture: pickTex, origin: [cx0, cy0] }, { buffer: buf, bytesPerRow: bpr }, [cw, ch]);
		device.queue.submit([enc.finish()]);
		await buf.mapAsync(BUF.MAP_READ);
		const u8 = new Uint8Array(buf.getMappedRange());
		let best: { id: number; distance: number } | null = null;
		for (let j = 0; j < ch; j++) { const row = new Uint32Array(u8.buffer, u8.byteOffset + j * bpr, cw); for (let i = 0; i < cw; i++) { const id = row[i]; if (!id) continue; const dd = Math.hypot(cx0 + i - (x0 + rr), cy0 + j - (y0 + rr)); if (!best || dd < best.distance) best = { id, distance: dd }; } }
		buf.unmap(); buf.destroy();
		if (!best) return null;
		for (const [q, L] of layers) if (best.id >= L.base && best.id < L.base + L.n) {
			const index = best.id - L.base, [nx, ny] = L.dims, i = index % nx, j = Math.floor(index / nx) % ny, k = Math.floor(index / (nx * ny)), cc = [i + 0.5, j + 0.5, k + 0.5], cell: [number, number, number] = [i, j, k];
			let lngLat: [number, number];
			if (L.geo) lngLat = [((L.geo.west + L.geo.spanLon * cc[0] / nx + 180) % 360 + 360) % 360 - 180, L.geo.south + L.geo.spanLat * cc[1] / ny];
			else { const A = L.A, e = A[0] * cc[0] + A[1] * cc[1] + A[2] * cc[2], nn = A[3] * cc[0] + A[4] * cc[1] + A[5] * cc[2], a = L.anchor; lngLat = [a[0] + e / (Math.cos(a[1] * D2R) * D2R * R_SPHERE), a[1] + nn / (D2R * R_SPHERE)]; }
			return { id: best.id, q, layer: q, index, cell, value: null, distance: best.distance, lngLat, properties: { ...(L.properties || {}), index, cell, value: null } };
		}
		return null;
	}
	function destroy(): void {
		dead = true;
		layers.forEach(drop); layers.clear();
		dummyDep?.destroy(); pickTex?.destroy(); boxVb?.destroy();
		try { ctx?.unconfigure(); } catch { /* 古い実装 */ }
		if (device && !shared) device.destroy();
		device = null; ctx = null;
	}
	return { init, message, frame, pick, destroy, get shared() { return shared; } };
}
