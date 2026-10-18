// Gaussian splat の WebGPU の描き手（同一フレームのオーバーレイ＝map.overlay・render worker の中で地球と同じ rAF・同じ cam）。@ortho-earth/plugin-splat（2026-10-18）。
// ⚠ 依存ゼロ（実行時の import 文なし・型だけの import は消える）＝splat-draw.ts が URL で import() し、create() で実体を作る（オーバーレイごとに別の閉包）。
// 本体が WebGPU なら host.gpuDevice() の device を共有し、深度は本体の詰めた GPUTexture（api.depth.gpuTexture(device)）をそのまま束ねる（コピー・読み戻しなし＝PR #487 の three と同じ口）。
// 本体が WebGL2 なら自前の adapter/device を取り、深度は api.depth.gpuTexture(device) が writeTexture で上げた物を読む。
// 描き方（splat-gl.ts と同じ数式）＝中心・共分散・色を storage buffer に置き、一つの四角を個数ぶん instancing。頂点で 3D の共分散を画面の 2D に写し（mvp の Jacobian・EWA）、固有値で楕円の軸を出す。
// 色＝DC（colors）＋球面調和（sh・次数 1〜3・8 bit に詰めた snorm × scale）を視線の向き（錨の東北上の目の位置 → 元の軸へ rot で戻す）で評価＝実写の見え方が視点で変わる。
// 順＝GPU の数え上げの並べ替え（compute 3 段＝鍵と度数・累積・散らし・16 bit の桶）。向きが変わるたびに並べ直す（CPU に戻さない）。混ぜ＝前乗せの α。深度は書かない（本体の深度で隠れるだけ）。
// 当たり＝番号を r32uint に焼く別パス → 近傍を buffer へ写して mapAsync（非同期＝pick は Promise を返す。render worker が待つ・2026-10-18）。
// LoD＝層が画面で小さい時は重い順（rank＝importanceRank・0 が一番重い）の先頭 N 個だけ描く。N＝層の画面上の足跡（px²）× lod（1 px² あたりの個数）を 1.25 倍の段に丸め、
//   最低 4096（か n）。並べ替えは順位が N 未満の物だけを数える（keyHist／scatter が飛ばす）＝order の先頭 N 個が描く順。N が変わった時は host.post({ type:"lod", q, drawn }) で main へ。
// message は splat-gl.ts と同じ（SplatMessage）＋層の rot・shq・shScale・shDeg・shWords・rank・lod。
import type { OverlayFrameApi } from "@ortho-earth/globe";
import type { SplatMessage, SplatLayerBody, SplatPickResult, SplatAltitude, CamState, SplatApi, PickContext, OverlayHost } from "./splat-gl.ts";

// WebGPU の定数（lib.dom は名前空間の定数を持たない＝数で書く・@webgpu/types と同じ値）
const BUF = { MAP_READ: 0x01, COPY_SRC: 0x04, COPY_DST: 0x08, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const TEX = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 } as const;
const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 } as const;
const R_SPHERE = 6371000, R_ELL = 6378137, WG = 256, UB_SIZE = 192, SU_SIZE = 32, LOD_MIN = 4096, LOD_STEP = 1.25;
const D2R = Math.PI / 180;

// ---- WGSL ----
// 描き（頂点＝splat-gl.ts の VS と同じ数式・SH を足す。片＝深度で隠れる・前乗せ α／当たり＝番号）
const DRAW_WGSL = /* wgsl */`
struct Uni {
	mvp: mat4x4f,     // mvp×平行移動(錨)×東北上→単位球（倍精度で掛けてから f32）
	rot: mat3x3f,     // 東北上の向き → 元の軸（SH の評価）
	eye: vec3f,       // 目の位置（錨の東北上 m）
	vp: vec2f,        // 描画面（device px）
	ddim: vec2f,      // 本体の深度テクスチャの大きさ
	logCoef: f32, eps: f32, shScale: f32, alphaMin: f32,
	base: u32, occl: u32, shDeg: u32, depthOn: u32,
	shWords: u32, pad0: u32, pad1: u32, pad2: u32,
};
@group(0) @binding(0) var<uniform> U: Uni;
@group(0) @binding(1) var<storage, read> ctr: array<vec4f>;
@group(0) @binding(2) var<storage, read> cov: array<vec4f>;
@group(0) @binding(3) var<storage, read> col: array<u32>;
@group(0) @binding(4) var<storage, read> order: array<u32>;
@group(0) @binding(5) var<storage, read> sh: array<u32>;
@group(0) @binding(6) var dep: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) p: vec2f, @location(2) w: f32, @location(3) @interpolate(flat) id: u32 }
const K = 3.0;   // 3σ まで描く
const C1 = 0.4886025119029199;
fn shv(b: u32, j: u32) -> f32 { var v = unpack4x8snorm(sh[b + (j >> 2u)]); return v[j & 3u]; }
fn sh3(b: u32, k: u32) -> vec3f { return vec3f(shv(b, k * 3u), shv(b, k * 3u + 1u), shv(b, k * 3u + 2u)); }
// 3DGS の eval_sh（DC は colors に焼いてある＝ここは次数 1 以上の分）。d＝元の軸の視線の向き（目 → 点）
fn evalSh(i: u32, d: vec3f) -> vec3f {
	let b = i * U.shWords;
	let x = d.x; let y = d.y; let z = d.z;
	var r = -C1 * y * sh3(b, 0u) + C1 * z * sh3(b, 1u) - C1 * x * sh3(b, 2u);
	if (U.shDeg >= 2u) {
		let xx = x * x; let yy = y * y; let zz = z * z; let xy = x * y; let yz = y * z; let xz = x * z;
		r += 1.0925484305920792 * xy * sh3(b, 3u) - 1.0925484305920792 * yz * sh3(b, 4u) + 0.31539156525252005 * (2.0 * zz - xx - yy) * sh3(b, 5u) - 1.0925484305920792 * xz * sh3(b, 6u) + 0.5462742152960396 * (xx - yy) * sh3(b, 7u);
		if (U.shDeg >= 3u) {
			r += -0.5900435899266435 * y * (3.0 * xx - yy) * sh3(b, 8u) + 2.890611442640554 * xy * z * sh3(b, 9u) - 0.4570457994644658 * y * (4.0 * zz - xx - yy) * sh3(b, 10u)
				+ 0.3731763325901154 * z * (2.0 * zz - 3.0 * xx - 3.0 * yy) * sh3(b, 11u) - 0.4570457994644658 * x * (4.0 * zz - xx - yy) * sh3(b, 12u) + 1.445305721320277 * z * (xx - yy) * sh3(b, 13u) - 0.5900435899266435 * x * (xx - 3.0 * yy) * sh3(b, 14u);
		}
	}
	return r * U.shScale;
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
	var o: VO;
	o.pos = vec4f(2.0, 2.0, 2.0, 1.0);   // 画面の外＝描かない
	let i = order[ii];
	var corner = vec2f(-1.0, -1.0);
	switch vi { case 1u: { corner = vec2f(1.0, -1.0); } case 2u, 4u: { corner = vec2f(1.0, 1.0); } case 5u: { corner = vec2f(-1.0, 1.0); } default: {} }
	let c = ctr[i].xyz;
	let clip = U.mvp * vec4f(c, 1.0);
	if (clip.w <= 1e-9) { return o; }
	let ndc = clip.xy / clip.w;
	if (any(abs(ndc) > vec2f(1.3))) { return o; }
	let a = cov[i * 2u]; let b = cov[i * 2u + 1u];
	let S = mat3x3f(a.x, a.y, a.z, a.y, a.w, b.x, a.z, b.x, b.y);
	let rx = vec3f(U.mvp[0][0], U.mvp[1][0], U.mvp[2][0]); let ry = vec3f(U.mvp[0][1], U.mvp[1][1], U.mvp[2][1]); let rw = vec3f(U.mvp[0][3], U.mvp[1][3], U.mvp[2][3]);
	let iw = 1.0 / clip.w;
	let jx = (rx - ndc.x * rw) * iw * 0.5 * U.vp.x; let jy = (ry - ndc.y * rw) * iw * 0.5 * U.vp.y;   // 画素の Jacobian（2×3）
	let sx = S * jx; let sy = S * jy;
	let xx = dot(jx, sx) + 0.3; let xy = dot(jx, sy); let yy = dot(jy, sy) + 0.3;   // 画素の低域（0.3）＝細すぎる楕円がちらつかない
	let mid = 0.5 * (xx + yy); let rad = length(vec2f(0.5 * (xx - yy), xy)); let l1 = mid + rad; let l2 = mid - rad;
	if (l2 <= 0.0) { return o; }
	var e1: vec2f;
	if (abs(xy) < 1e-12) { e1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), xx >= yy); } else { e1 = normalize(vec2f(xy, l1 - xx)); }
	let e2 = vec2f(-e1.y, e1.x);
	let s1 = min(sqrt(l1), 1024.0); let s2 = min(sqrt(l2), 1024.0);
	let off = (corner.x * s1 * e1 + corner.y * s2 * e2) * K;
	o.pos = vec4f(ndc + off * 2.0 / U.vp, 0.0, 1.0);
	o.p = corner * K; o.w = clip.w;
	var rgba = unpack4x8unorm(col[i]);
	if (U.shDeg > 0u) { let d = normalize(U.rot * normalize(c - U.eye)); rgba = vec4f(clamp(rgba.rgb + evalSh(i, d), vec3f(0.0), vec3f(1.0)), rgba.a); }
	o.col = rgba; o.id = U.base + i;
	return o;
}
// 本体の深度（詰めた 24 bit の対数深度・行は下から＝GL）で隠れるか。pos＝画素（上から）・w＝自分の clip w
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
	let r2 = dot(v.p, v.p); if (r2 > 9.0) { discard; }
	if (U.occl != 0u && occluded(v.pos.xy, v.w)) { discard; }
	let a = exp(-0.5 * r2) * v.col.a; if (a < 1.0 / 255.0) { discard; }
	return vec4f(v.col.rgb * a, a);
}
@fragment fn fsPick(v: VO) -> @location(0) u32 {
	let r2 = dot(v.p, v.p); if (r2 > 9.0) { discard; }
	if (U.occl != 0u && occluded(v.pos.xy, v.w)) { discard; }
	let a = exp(-0.5 * r2) * v.col.a; if (a < U.alphaMin) { discard; }
	return v.id;
}`;
// 並べ替え（奥から手前＝w の降順）＝数え上げ（16 bit の桶）を GPU で：keyHist（鍵と度数）→ scan（累積・1 workgroup）→ scatter（散らし）。桶の中の順は任意（同じ奥行き＝混ぜる順は効かない）
const SORT_WGSL = /* wgsl */`
struct SortUni { row: vec3f, lo: f32, hi: f32, n: u32, keep: u32, pad0: u32 }
@group(0) @binding(0) var<uniform> S: SortUni;
@group(0) @binding(1) var<storage, read> ctr: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> keys: array<u32>;
@group(0) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> order: array<u32>;
@group(0) @binding(5) var<storage, read> rank: array<u32>;
// LoD＝順位が keep 以上の物は数えない・散らさない（keep < n の時だけ rank を読む）
fn skip(i: u32) -> bool { return S.keep < S.n && rank[i] >= S.keep; }
@compute @workgroup_size(${WG}) fn keyHist(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x; if (i >= S.n || skip(i)) { return; }
	let d = dot(S.row, ctr[i].xyz);
	let sc = select(0.0, 65535.0 / (S.hi - S.lo), S.hi > S.lo);
	let k = u32(clamp((S.hi - d) * sc, 0.0, 65535.0));   // 奥（w が大）が小さい鍵
	keys[i] = k; atomicAdd(&counts[k], 1u);
}
var<workgroup> part: array<u32, 256>;
@compute @workgroup_size(256) fn scan(@builtin(local_invocation_id) l: vec3u) {
	let t = l.x; var s = 0u;
	for (var j = 0u; j < 256u; j++) { s += atomicLoad(&counts[t * 256u + j]); }
	part[t] = s; workgroupBarrier();
	for (var off = 1u; off < 256u; off = off << 1u) { var v = 0u; if (t >= off) { v = part[t - off]; } workgroupBarrier(); part[t] = part[t] + v; workgroupBarrier(); }
	var run = part[t] - s;   // この thread の 256 桶の前までの累積（exclusive）
	for (var j = 0u; j < 256u; j++) { let idx = t * 256u + j; let c = atomicLoad(&counts[idx]); atomicStore(&counts[idx], run); run += c; }
}
@compute @workgroup_size(${WG}) fn scatter(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x; if (i >= S.n || skip(i)) { return; }
	let p = atomicAdd(&counts[keys[i]], 1u); order[p] = i;
}`;

/** 層（GPU に載せた物） */
interface Layer {
	q: string; n: number; anchor: [number, number, number]; alt: SplatAltitude; radius: number; occl: boolean; properties: Record<string, unknown> | null;
	lod: number; bRank: GPUBuffer | null; drawn: number; sortedN: number;   // LoD＝密度（0＝全部）・順位・今描く個数・並べ替えた時の個数
	ctr: Float32Array;   // 東北上の中心（m・CPU 側に持つ＝当たりの経緯度はここから。GPU から読み戻さない）
	bb: Float32Array;   // 東北上の箱（min xyz・max xyz）＝奥行きの範囲は箱の 8 隅で決まる（線形）
	bCtr: GPUBuffer; bCov: GPUBuffer; bCol: GPUBuffer; bOrder: GPUBuffer; bKeys: GPUBuffer; bSh: GPUBuffer | null; ub: GPUBuffer; su: GPUBuffer;
	shDeg: number; shWords: number; shScale: number; rot: Float32Array;
	sortBG: GPUBindGroup; drawBG: GPUBindGroup | null; drawTex: GPUTexture | null;
	dir: number[] | null; on: boolean; base: number;
}
/** LoD の個数＝足跡（px²）× 密度を 1.25 倍の段に丸める（最低 LOD_MIN か n）。密度 0＝全部 */
export function lodCount(areaPx: number, n: number, density: number): number {
	if (!(density > 0) || n <= LOD_MIN) return n;
	const want = Math.max(LOD_MIN, areaPx * density);
	if (want >= n) return n;
	return Math.min(n, Math.round(Math.pow(LOD_STEP, Math.ceil(Math.log(want) / Math.log(LOD_STEP)))));
}
/** 錨の所の画素／m（mvp＝錨の東北上 m → clip・画面 w×h px）＝頂点の Jacobian と同じ式。錨が目の後ろ＝0 */
export function pixelsPerMeter(mvp: ArrayLike<number>, w: number, h: number): number {
	const cw = mvp[15]; if (!(cw > 1e-9)) return 0;
	const nx = mvp[12] / cw, ny = mvp[13] / cw; let best = 0;
	for (let j = 0; j < 3; j++) { const dx = (mvp[j * 4] - nx * mvp[j * 4 + 3]) / cw * 0.5 * w, dy = (mvp[j * 4 + 1] - ny * mvp[j * 4 + 3]) / cw * 0.5 * h, l = Math.hypot(dx, dy); if (l > best) best = l; }
	return best;
}
export interface SplatGpuModule {
	/** device（host.gpuDevice() か自前）・pipeline・canvas の文脈を整える。失敗＝reject（canvas の文脈は取っていない＝splat-draw.ts が WebGL2 へ落とせる） */
	init(canvas: OffscreenCanvas, opts: { depth?: boolean }, host: OverlayHost | null): Promise<void>;
	message(d: SplatMessage): void;
	frame(cam: unknown, s: CamState, size: { w: number; h: number }, api: SplatApi): boolean;
	pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): Promise<SplatPickResult | null>;
	destroy(): void;
	/** 本体の device を共有しているか（検定・診断） */
	readonly shared: boolean;
}
export interface EnuBasis { E: number[]; N: number[]; U: number[]; u: number[] }
const unit = (lon: number, lat: number, rAx: number): number[] => { const a = lon * D2R; let b = lat * D2R; if (rAx !== 1) b = Math.atan(rAx * Math.tan(b)); const cb = Math.cos(b); return [cb * Math.cos(a), Math.sin(b), cb * Math.sin(a)]; };
// 錨の東北上 m → 単位球（列＝東・北・上×1/R）＝splat-gl.ts と同じ
export function enuBasis(lon: number, lat: number, rAx = 1): EnuBasis {
	const u = unit(lon, lat, rAx), cl = Math.hypot(u[0], u[2]), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL);
	const E = cl < 1e-12 ? [1, 0, 0] : [-u[2] / cl, 0, u[0] / cl], N = [E[1] * u[2] - E[2] * u[1], E[2] * u[0] - E[0] * u[2], E[0] * u[1] - E[1] * u[0]];
	return { E: E.map(v => v * k), N: N.map(v => v * k), U: u.map(v => v * k), u };
}
/** 奥行き（row·c）の範囲＝箱の 8 隅（線形なので隅で決まる） */
export function depthRange(bb: ArrayLike<number>, row: ArrayLike<number>): [number, number] {
	let lo = Infinity, hi = -Infinity;
	for (let k = 0; k < 8; k++) { const v = row[0] * bb[k & 1 ? 3 : 0] + row[1] * bb[k & 2 ? 4 : 1] + row[2] * bb[k & 4 ? 5 : 2]; if (v < lo) lo = v; if (v > hi) hi = v; }
	return [lo, hi];
}
const align256 = (v: number): number => Math.ceil(v / 256) * 256;

export function create(): SplatGpuModule {
	let device: GPUDevice | null = null, ctx: GPUCanvasContext | null = null, host: OverlayHost | null = null, format: GPUTextureFormat = "rgba8unorm";
	let shared = false, wantDepth = false, dead = false;
	let drawPipe: GPURenderPipeline | null = null, pickPipe: GPURenderPipeline | null = null, drawLayout: GPUBindGroupLayout | null = null, sortLayout: GPUBindGroupLayout | null = null;
	let pKey: GPUComputePipeline | null = null, pScan: GPUComputePipeline | null = null, pScatter: GPUComputePipeline | null = null;
	let counts: GPUBuffer | null = null, dummySh: GPUBuffer | null = null, dummyRank: GPUBuffer | null = null, dummyDep: GPUTexture | null = null;
	let pickTex: GPUTexture | null = null, pickW = 0, pickH = 0;
	const layers = new Map<string, Layer>(), probes: unknown[] = [];
	const uData = new ArrayBuffer(UB_SIZE), uF = new Float32Array(uData), uU = new Uint32Array(uData), sData = new ArrayBuffer(SU_SIZE), sF = new Float32Array(sData), sU = new Uint32Array(sData);
	const mvpL = new Float64Array(16), eyeL = [0, 0, 0];

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
		if (bad.length) throw new Error(`plugin-splat WGSL ${label}: ${bad.join("; ")}`);
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
		// pipeline を先に組む（失敗したら canvas の文脈を取らずに投げる＝WebGL2 へ落とせる）
		const sbuf = (binding: number, type: GPUBufferBindingType, visibility: number): GPUBindGroupLayoutEntry => ({ binding, visibility, buffer: { type } });
		drawLayout = device.createBindGroupLayout({ label: "splat-draw", entries: [sbuf(0, "uniform", STAGE.VERTEX | STAGE.FRAGMENT), sbuf(1, "read-only-storage", STAGE.VERTEX), sbuf(2, "read-only-storage", STAGE.VERTEX), sbuf(3, "read-only-storage", STAGE.VERTEX), sbuf(4, "read-only-storage", STAGE.VERTEX), sbuf(5, "read-only-storage", STAGE.VERTEX),
			{ binding: 6, visibility: STAGE.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } }] });
		sortLayout = device.createBindGroupLayout({ label: "splat-sort", entries: [sbuf(0, "uniform", STAGE.COMPUTE), sbuf(1, "read-only-storage", STAGE.COMPUTE), sbuf(2, "storage", STAGE.COMPUTE), sbuf(3, "storage", STAGE.COMPUTE), sbuf(4, "storage", STAGE.COMPUTE), sbuf(5, "read-only-storage", STAGE.COMPUTE)] });
		const [dm, sm] = await Promise.all([compile(DRAW_WGSL, "draw"), compile(SORT_WGSL, "sort")]);
		if (dead) return;
		const dl = device.createPipelineLayout({ bindGroupLayouts: [drawLayout] }), sl = device.createPipelineLayout({ bindGroupLayouts: [sortLayout] });
		const blend: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } };
		[drawPipe, pickPipe, pKey, pScan, pScatter] = await Promise.all([
			device.createRenderPipelineAsync({ label: "splat-draw", layout: dl, vertex: { module: dm, entryPoint: "vs" }, fragment: { module: dm, entryPoint: "fs", targets: [{ format, blend }] }, primitive: { topology: "triangle-list" } }),
			device.createRenderPipelineAsync({ label: "splat-pick", layout: dl, vertex: { module: dm, entryPoint: "vs" }, fragment: { module: dm, entryPoint: "fsPick", targets: [{ format: "r32uint" }] }, primitive: { topology: "triangle-list" } }),
			device.createComputePipelineAsync({ label: "splat-keyHist", layout: sl, compute: { module: sm, entryPoint: "keyHist" } }),
			device.createComputePipelineAsync({ label: "splat-scan", layout: sl, compute: { module: sm, entryPoint: "scan" } }),
			device.createComputePipelineAsync({ label: "splat-scatter", layout: sl, compute: { module: sm, entryPoint: "scatter" } }),
		]);
		if (dead) return;
		counts = device.createBuffer({ label: "splat-counts", size: 65536 * 4, usage: BUF.STORAGE | BUF.COPY_DST });
		dummySh = device.createBuffer({ label: "splat-sh0", size: 16, usage: BUF.STORAGE });
		dummyRank = device.createBuffer({ label: "splat-rank0", size: 16, usage: BUF.STORAGE });
		dummyDep = device.createTexture({ label: "splat-dep0", size: [1, 1], format: "rgba8unorm", usage: TEX.TEXTURE_BINDING | TEX.COPY_DST });
		const c = canvas.getContext("webgpu" as "2d") as unknown as GPUCanvasContext | null;   // lib.dom の OffscreenCanvas は "webgpu" の overload を持たない
		if (!c) throw new Error("webgpu canvas context unavailable");
		c.configure({ device, format, alphaMode: "premultiplied", usage: TEX.RENDER_ATTACHMENT | TEX.COPY_SRC });
		ctx = c;
	}
	// 層を GPU に載せる（ctr＝vec4 の列・cov＝vec4×2 の列・色＝u32・順＝0..n-1・SH＝u32 の列・LoD の順位＝u32 の列）
	function build(q: string, d: SplatLayerBody): Layer {
		const n = d.n, C = new Float32Array(n * 4), V = new Float32Array(n * 8), bb = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
		for (let i = 0; i < n; i++) {
			const x = d.ctr[i * 3], y = d.ctr[i * 3 + 1], z = d.ctr[i * 3 + 2];
			C[i * 4] = x; C[i * 4 + 1] = y; C[i * 4 + 2] = z;
			if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z; if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
			V.set(d.cov.subarray(i * 6, i * 6 + 6), i * 8);
		}
		if (!n) bb.fill(0);
		const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
		const sh = d.shq && d.shDeg && d.shWords ? d.shq : null;
		const bCtr = mkBuf(C, BUF.STORAGE, "splat-ctr"), bCov = mkBuf(V, BUF.STORAGE, "splat-cov"), bCol = mkBuf(new Uint8Array(d.rgba.buffer, d.rgba.byteOffset, n * 4), BUF.STORAGE, "splat-col");
		const bOrder = mkBuf(order, BUF.STORAGE, "splat-order"), bKeys = device!.createBuffer({ label: "splat-keys", size: Math.max(16, n * 4), usage: BUF.STORAGE });
		const bSh = sh ? mkBuf(sh, BUF.STORAGE, "splat-sh") : null;
		const lod = d.lod && d.rank && d.rank.length === n ? d.lod : 0, bRank = lod ? mkBuf(d.rank!, BUF.STORAGE, "splat-rank") : null;
		const ub = device!.createBuffer({ label: "splat-u", size: UB_SIZE, usage: BUF.UNIFORM | BUF.COPY_DST }), su = device!.createBuffer({ label: "splat-su", size: SU_SIZE, usage: BUF.UNIFORM | BUF.COPY_DST });
		const sortBG = device!.createBindGroup({ layout: sortLayout!, entries: [{ binding: 0, resource: { buffer: su } }, { binding: 1, resource: { buffer: bCtr } }, { binding: 2, resource: { buffer: bKeys } }, { binding: 3, resource: { buffer: counts! } }, { binding: 4, resource: { buffer: bOrder } }, { binding: 5, resource: { buffer: bRank ?? dummyRank! } }] });
		return { q, n, anchor: d.anchor, alt: d.alt || "relative", radius: d.radius || 0, occl: d.depthTest !== false, properties: d.properties ?? null, ctr: d.ctr, bb, lod, bRank, drawn: n, sortedN: 0,
			bCtr, bCov, bCol, bOrder, bKeys, bSh, ub, su, shDeg: sh ? d.shDeg! : 0, shWords: sh ? d.shWords! : 0, shScale: d.shScale ?? 1, rot: d.rot && d.rot.length === 9 ? d.rot : new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
			sortBG, drawBG: null, drawTex: null, dir: null, on: true, base: 0 };
	}
	const drop = (L: Layer | undefined): void => { if (!L) return; for (const b of [L.bCtr, L.bCov, L.bCol, L.bOrder, L.bKeys, L.bSh, L.bRank, L.ub, L.su]) b?.destroy(); };
	function rebase(): void { let b = 1; for (const L of layers.values()) { L.base = b; b += L.n; } }
	function message(d: SplatMessage): void {
		if (d.type === "probe") { probes.push(d.id); host?.requestDraw?.(); return; }
		if (!device || !ctx) return;
		if (d.type === "layer") { drop(layers.get(d.q)); layers.set(d.q, build(d.q, d)); rebase(); host?.requestDraw?.(); }
		else if (d.type === "remove") { drop(layers.get(d.q)); layers.delete(d.q); rebase(); host?.requestDraw?.(); }
		else if (d.type === "vis") { const L = layers.get(d.q); if (L) L.on = !!d.on; host?.requestDraw?.(); }
		else if (d.type === "clear") { layers.forEach(drop); layers.clear(); rebase(); host?.requestDraw?.(); }
	}
	// 錨の位置（relative＝地形の高さ×持ち上げ＋高さ）と層の mvp（倍精度）・目の位置（錨の東北上 m）。戻り＝見える（地平線の向こうでない）
	function place(L: Layer, s: CamState, api: SplatApi | null | undefined): boolean {
		const rAx = api?.rAx || 1, [lon, lat, alt] = L.anchor, B = enuBasis(lon, lat, rAx), k = 1 / (rAx === 1 ? R_SPHERE : R_ELL);
		const ls = L.alt !== "absolute" ? (api?.liftScale || 0) : 0, r = 1 + (ls > 0 ? (api!.elevM(lon, lat) || 0) * ls : 0) + (alt || 0) * k;
		const o = [B.u[0] * r, B.u[1] * r, B.u[2] * r], M = s.mvp, cols = [B.E, B.N, B.U];
		for (let j = 0; j < 3; j++) for (let row = 0; row < 4; row++) mvpL[j * 4 + row] = M[row] * cols[j][0] + M[4 + row] * cols[j][1] + M[8 + row] * cols[j][2];
		for (let row = 0; row < 4; row++) mvpL[12 + row] = M[row] * o[0] + M[4 + row] * o[1] + M[8 + row] * o[2] + M[12 + row];
		const E = s.eye, rr = L.radius * k;
		if (E) { const dx = E[0] - o[0], dy = E[1] - o[1], dz = E[2] - o[2]; for (let j = 0; j < 3; j++) eyeL[j] = (dx * cols[j][0] + dy * cols[j][1] + dz * cols[j][2]) / (k * k); }
		const behind = E ? o[0] * (E[0] - o[0]) + o[1] * (E[1] - o[1]) + o[2] * (E[2] - o[2]) < -rr * Math.hypot(...o) - 1e-9 : false;
		return !behind;
	}
	// 描きの uniform（place の後に呼ぶ）
	function writeU(L: Layer, w: number, h: number, dep: { tex: GPUTexture; w: number; h: number; logCoef: number } | null, pick: boolean): void {
		for (let i = 0; i < 16; i++) uF[i] = mvpL[i];
		for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) uF[16 + c * 4 + r] = L.rot[r * 3 + c];   // 行優先 → 列優先（列の幅は 16 byte）
		uF[28] = eyeL[0]; uF[29] = eyeL[1]; uF[30] = eyeL[2];
		uF[32] = w; uF[33] = h; uF[34] = dep ? dep.w : 1; uF[35] = dep ? dep.h : 1;
		uF[36] = dep ? dep.logCoef : 1; uF[37] = 2e-6; uF[38] = L.shScale; uF[39] = 0.2;
		uU[40] = L.base; uU[41] = L.occl ? 1 : 0; uU[42] = L.shDeg; uU[43] = dep && !pick ? 1 : 0; uU[44] = L.shWords;
		device!.queue.writeBuffer(L.ub, 0, uData);
		const tex = dep && !pick ? dep.tex : dummyDep!;
		if (!L.drawBG || L.drawTex !== tex) {
			L.drawBG = device!.createBindGroup({ layout: drawLayout!, entries: [{ binding: 0, resource: { buffer: L.ub } }, { binding: 1, resource: { buffer: L.bCtr } }, { binding: 2, resource: { buffer: L.bCov } }, { binding: 3, resource: { buffer: L.bCol } }, { binding: 4, resource: { buffer: L.bOrder } }, { binding: 5, resource: { buffer: L.bSh ?? dummySh! } }, { binding: 6, resource: tex.createView() }] });
			L.drawTex = tex;
		}
	}
	// LoD の個数（place の後＝mvpL が層の物）
	function lodOf(L: Layer, w: number, h: number): number {
		if (!L.lod || !L.bRank) return L.n;
		const ppm = pixelsPerMeter(mvpL, w, h); if (!ppm) return L.n;
		const r = L.radius * ppm, area = Math.min(Math.PI * r * r, w * h);
		return lodCount(area, L.n, L.lod);
	}
	// 向きが変わった・描く個数が変わったら GPU で並べ直す（3 段の compute を enc に積む）
	function sortIfTurned(L: Layer, enc: GPUCommandEncoder, keep: number): void {
		const row = [mvpL[3], mvpL[7], mvpL[11]], l = Math.hypot(...row) || 1, dir = row.map(v => v / l);
		if (L.dir && L.sortedN === keep && dir[0] * L.dir[0] + dir[1] * L.dir[1] + dir[2] * L.dir[2] > 0.99995) return;
		if (!L.n) { L.dir = dir; L.sortedN = keep; return; }
		const [lo, hi] = depthRange(L.bb, dir);
		sF[0] = dir[0]; sF[1] = dir[1]; sF[2] = dir[2]; sF[3] = lo; sF[4] = hi; sU[5] = L.n; sU[6] = keep;
		device!.queue.writeBuffer(L.su, 0, sData);
		enc.clearBuffer(counts!);
		const groups = Math.ceil(L.n / WG);
		const p = enc.beginComputePass({ label: "splat-sort" });
		p.setBindGroup(0, L.sortBG);
		p.setPipeline(pKey!); p.dispatchWorkgroups(groups);
		p.setPipeline(pScan!); p.dispatchWorkgroups(1);
		p.setPipeline(pScatter!); p.dispatchWorkgroups(groups);
		p.end();
		L.dir = dir; L.sortedN = keep;
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
		const ids = probes.splice(0);
		readCanvas(w, h).then(data => { for (const id of ids) host?.post?.({ type: "pixels", id, w, h, flipY: false, data: id === ids[ids.length - 1] ? data : data.slice() }); })
			.catch(e => { console.warn("[plugin-splat] probe failed", e); for (const id of ids) host?.post?.({ type: "pixels", id, error: String((e as { message?: string } | null)?.message || e) }); });
	}
	function frame(cam: unknown, s: CamState, { w, h }: { w: number; h: number }, api: SplatApi): boolean {
		if (!device || !ctx || !drawPipe) return false;
		const d = api?.depth, dep = wantDepth && d ? { tex: d.gpuTexture(device), w: d.w, h: d.h, logCoef: d.logCoef } : null;
		const enc = device.createCommandEncoder({ label: "splat-frame" });
		const vis: Layer[] = [];
		for (const L of layers.values()) {
			if (!L.on || !L.n || !place(L, s, api)) continue;
			const keep = lodOf(L, w, h);
			if (keep !== L.drawn) { L.drawn = keep; host?.post?.({ type: "lod", q: L.q, drawn: keep, n: L.n }); }
			sortIfTurned(L, enc, keep);
			writeU(L, w, h, dep, false);
			vis.push(L);
		}
		const pass = enc.beginRenderPass({ label: "splat-draw", colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
		if (vis.length) { pass.setPipeline(drawPipe); for (const L of vis) { pass.setBindGroup(0, L.drawBG!); pass.draw(6, L.drawn); } }
		pass.end();
		device.queue.submit([enc.finish()]);
		answerProbes(w, h);
		return false;
	}
	// 統一 picking：番号を r32uint に焼いて近傍を読む（非同期）。順は最後に描いた並び（ctx.s は最後のフレームの cam＝同じ向き）
	async function pick(x: number, y: number, r: number, ctx0: PickContext | null | undefined): Promise<SplatPickResult | null> {
		if (!device || !pickPipe || !layers.size || !ctx0?.s) return null;
		const { w, h } = ctx0.size;
		if (!pickTex || pickW !== w || pickH !== h) { pickTex?.destroy(); pickTex = device.createTexture({ label: "splat-pick", size: [w, h], format: "r32uint", usage: TEX.RENDER_ATTACHMENT | TEX.COPY_SRC }); pickW = w; pickH = h; }
		const enc = device.createCommandEncoder({ label: "splat-pick" });
		const vis: Layer[] = [];
		for (const L of layers.values()) { if (!L.on || !L.n || !place(L, ctx0.s, ctx0.api)) continue; writeU(L, w, h, null, true); vis.push(L); }
		const pass = enc.beginRenderPass({ colorAttachments: [{ view: pickTex.createView(), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: "store" }] });
		if (vis.length) { pass.setPipeline(pickPipe); for (const L of vis) { pass.setBindGroup(0, L.drawBG!); pass.draw(6, L.sortedN || L.n); } }
		pass.end();
		const rr = Math.max(0, Math.round(r)), side = rr * 2 + 1, x0 = Math.round(x) - rr, y0 = Math.round(y) - rr;
		const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x0 + side), cy1 = Math.min(h, y0 + side);
		if (!(cx1 > cx0 && cy1 > cy0)) { device.queue.submit([enc.finish()]); return null; }
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
			const index = best.id - L.base, a = L.anchor, e = L.ctr[index * 3], nn = L.ctr[index * 3 + 1];
			// 中心の経緯度（当たりの答え）＝錨の東北上から（WebGL2 の描き手と同じ式）
			const lngLat: [number, number] = [a[0] + e / (Math.cos(a[1] * D2R) * D2R * R_SPHERE), a[1] + nn / (D2R * R_SPHERE)];
			return { id: best.id, q, layer: q, index, distance: best.distance, lngLat, properties: { ...(L.properties || {}), index } };
		}
		return null;
	}
	function destroy(): void {
		dead = true;
		layers.forEach(drop); layers.clear();
		for (const b of [counts, dummySh, dummyRank]) b?.destroy();
		dummyDep?.destroy(); pickTex?.destroy();
		try { ctx?.unconfigure(); } catch { /* 古い実装 */ }
		if (device && !shared) device.destroy();
		device = null; ctx = null;
	}
	return { init, message, frame, pick, destroy, get shared() { return shared; } };
}
