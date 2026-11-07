// 点群 → Gaussian splat の WebGPU の変換器（@ortho-earth/splat の cloud・2026-11-06）＝render worker の中（splat-gpu.ts のオーバーレイ）で本体の device を共有して走る。
// ⚠ 依存ゼロ（実行時の import 文なし＝splat-gpu.ts が静的に import する兄弟・module の状態は持たない＝above／below の 2 つのオーバーレイで共有してよい）。
// 手順（cloud.ts の CPU の参照実装と同じ式・同じ順）＝段ごとに：
//   keyHist（セルのハッシュを数える）→ scan（累積＝starts）→ scatter（order）→ leader（セルの先頭に印）→ scan（印の累積＝書き込む番号・総数）→ merge（先頭がセルをまとめて書く）→ stats（範囲・半径・order の初期化）
//   level 0 の merge は点ごとに近傍（27 セル・半径 r）の散らばりを出してから足す（点ごとの共分散の buffer を持たない＝4M 点で 128 MB を省く）。
//   level L の入力＝level L−1 の出力（ctr＝vec4(xyz, 色の bit)・cov＝vec4×2(xx xy xz yy | yz zz 重み 0)）＝そのまま描き手の層の buffer になる（GPU の外に出さない）。
// 読み戻し（read）＝OPFS／IndexedDB への保存と .spz／3D Tiles の書き出しの時だけ（mapAsync）。
import type { CloudPlan } from "./cloud.ts";

const BUF = { MAP_READ: 0x01, COPY_SRC: 0x04, COPY_DST: 0x08, UNIFORM: 0x40, STORAGE: 0x80 } as const;
const STAGE_C = 0x4, WG = 256, BLOCK = 1024, U_SIZE = 48;

// 共通の uniform（段ごとに書く）
const U_WGSL = /* wgsl */`
struct U { n: u32, mask: u32, cell: f32, inv: f32, r2: f32, fill2: f32, cap2: f32, maxNb: u32, hasCov: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> U: U;
fn cellOf(p: vec3f) -> vec3i { return vec3i(floor(p * U.inv)); }
fn hashOf(c: vec3i) -> u32 { return ((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u)) & U.mask; }
`;
// ① 鍵の度数・③ 散らし（cursor＝starts の写し）
const HASH_WGSL = U_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> order: array<u32>;
@compute @workgroup_size(${WG}) fn keyHist(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x; if (i >= U.n) { return; }
	atomicAdd(&counts[hashOf(cellOf(pos[i].xyz))], 1u);
}
@compute @workgroup_size(${WG}) fn scatter(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x; if (i >= U.n) { return; }
	let p = atomicAdd(&counts[hashOf(cellOf(pos[i].xyz))], 1u); order[p] = i;
}`;
// ② 累積（exclusive scan・in place）＝1024 個ずつの塊（256 thread × 4）→ 塊の和を 1 workgroup で累積 → 足し戻す。総数は total[0]
const SCAN_WGSL = /* wgsl */`
struct S { len: u32, blocks: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> S: S;
@group(0) @binding(1) var<storage, read_write> data: array<u32>;
@group(0) @binding(2) var<storage, read_write> sums: array<u32>;
@group(0) @binding(3) var<storage, read_write> total: array<u32>;
var<workgroup> part: array<u32, 256>;
@compute @workgroup_size(256) fn scanBlock(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) l: vec3u) {
	let t = l.x; let base = wg.x * ${BLOCK}u + t * 4u;
	var v = array<u32, 4>(0u, 0u, 0u, 0u); var s = 0u;
	for (var k = 0u; k < 4u; k++) { let idx = base + k; if (idx < S.len) { v[k] = data[idx]; } s += v[k]; }
	part[t] = s; workgroupBarrier();
	for (var off = 1u; off < 256u; off = off << 1u) { var a = 0u; if (t >= off) { a = part[t - off]; } workgroupBarrier(); part[t] = part[t] + a; workgroupBarrier(); }
	var run = part[t] - s;   // この thread の 4 個の前までの累積（exclusive）
	for (var k = 0u; k < 4u; k++) { let idx = base + k; if (idx < S.len) { data[idx] = run; } run += v[k]; }
	if (t == 255u) { sums[wg.x] = part[255]; }
}
@compute @workgroup_size(256) fn scanSums(@builtin(local_invocation_id) l: vec3u) {
	let t = l.x; var carry = 0u;
	for (var b = 0u; b < S.blocks; b += 256u) {
		let idx = b + t; var s = 0u; if (idx < S.blocks) { s = sums[idx]; }
		part[t] = s; workgroupBarrier();
		for (var off = 1u; off < 256u; off = off << 1u) { var a = 0u; if (t >= off) { a = part[t - off]; } workgroupBarrier(); part[t] = part[t] + a; workgroupBarrier(); }
		if (idx < S.blocks) { sums[idx] = carry + part[t] - s; }
		let last = part[255]; workgroupBarrier(); carry += last;
	}
	if (t == 0u) { total[0] = carry; }
}
@compute @workgroup_size(${WG}) fn scanAdd(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x; if (i >= S.len) { return; }
	data[i] = data[i] + sums[i / ${BLOCK}u];
}`;
// ④ セルの先頭（同じ run の中で同じセルの最初の物）に印・⑥ 先頭がセルをまとめて書く（level 0 は近傍の散らばり）
const MERGE_WGSL = U_WGSL + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> cov: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> starts: array<u32>;
@group(0) @binding(4) var<storage, read_write> order: array<u32>;
@group(0) @binding(5) var<storage, read_write> flags: array<u32>;
@group(0) @binding(6) var<storage, read_write> dstPos: array<vec4f>;
@group(0) @binding(7) var<storage, read_write> dstCov: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> dstCol: array<u32>;
fn leaderOf(i: u32, c: vec3i) -> u32 {   // run の中で同じセルの最初の番号
	let k = hashOf(c); let e = starts[k + 1u];
	for (var q = starts[k]; q < e; q++) { let j = order[q]; if (all(cellOf(pos[j].xyz) == c)) { return j; } }
	return i;
}
@compute @workgroup_size(${WG}) fn leader(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x; if (i >= U.n) { return; }
	flags[i] = select(0u, 1u, leaderOf(i, cellOf(pos[i].xyz)) == i);
}
// 近傍の散らばり（level 0）＝27 セル・半径 r・最大 maxNb 個（6 成分＝xx xy xz yy yz zz）
fn nbCov(i: u32, p: vec3f, c: vec3i) -> array<f32, 6> {
	var a = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0); var k = 0u;
	for (var dz = -1; dz <= 1; dz++) { for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
		let nc = c + vec3i(dx, dy, dz); let kk = hashOf(nc); let e = starts[kk + 1u];
		for (var q = starts[kk]; q < e; q++) {
			let j = order[q]; if (j == i) { continue; }
			let pj = pos[j].xyz; if (any(cellOf(pj) != nc)) { continue; }
			let d = pj - p; let d2 = dot(d, d); if (d2 > U.r2) { continue; }
			a[0] += d.x * d.x; a[1] += d.x * d.y; a[2] += d.x * d.z; a[3] += d.y * d.y; a[4] += d.y * d.z; a[5] += d.z * d.z;
			k++; if (k >= U.maxNb) { break; }
		}
		if (k >= U.maxNb) { break; }
	} if (k >= U.maxNb) { break; } } if (k >= U.maxNb) { break; } }
	if (k >= 2u) { let s = 1.0 / f32(k); for (var t = 0u; t < 6u; t++) { a[t] *= s; } }
	else { let s2 = 0.25 * U.cell * U.cell; a = array<f32, 6>(s2, 0.0, 0.0, s2, 0.0, s2); }
	return a;
}
@compute @workgroup_size(${WG}) fn merge(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x; if (i >= U.n) { return; }
	let c = cellOf(pos[i].xyz); if (leaderOf(i, c) != i) { return; }
	let k = hashOf(c); let s0 = starts[k]; let e = starts[k + 1u];
	var W = 0.0; var m = vec3f(0.0); var col = vec4f(0.0);
	for (var q = s0; q < e; q++) {
		let j = order[q]; let pj = pos[j]; if (any(cellOf(pj.xyz) != c)) { continue; }
		var w = 1.0; if (U.hasCov != 0u) { w = cov[j * 2u + 1u].z; }
		W += w; m += w * pj.xyz; col += w * unpack4x8unorm(bitcast<u32>(pj.w));
	}
	m /= W; col /= W;
	var C = array<f32, 6>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
	for (var q = s0; q < e; q++) {
		let j = order[q]; let pj = pos[j].xyz; if (any(cellOf(pj) != c)) { continue; }
		var w = 1.0; var s: array<f32, 6>;
		if (U.hasCov != 0u) { let a = cov[j * 2u]; let b = cov[j * 2u + 1u]; w = b.z; s = array<f32, 6>(a.x, a.y, a.z, a.w, b.x, b.y); } else { s = nbCov(j, pj, cellOf(pj)); }
		let d = pj - m;
		C[0] += w * (s[0] + d.x * d.x); C[1] += w * (s[1] + d.x * d.y); C[2] += w * (s[2] + d.x * d.z); C[3] += w * (s[3] + d.y * d.y); C[4] += w * (s[4] + d.y * d.z); C[5] += w * (s[5] + d.z * d.z);
	}
	let iw = 1.0 / W; for (var t = 0u; t < 6u; t++) { C[t] *= iw; }
	C[0] += U.fill2; C[3] += U.fill2; C[5] += U.fill2;
	let tr = C[0] + C[3] + C[5]; if (tr > U.cap2) { let s = U.cap2 / tr; for (var t = 0u; t < 6u; t++) { C[t] *= s; } }
	let o = flags[i];   // 累積済み＝書く番号
	let cb = pack4x8unorm(clamp(col, vec4f(0.0), vec4f(1.0)));
	dstPos[o] = vec4f(m, bitcast<f32>(cb));
	dstCov[o * 2u] = vec4f(C[0], C[1], C[2], C[3]); dstCov[o * 2u + 1u] = vec4f(C[4], C[5], W, 0.0);
	dstCol[o] = cb;
}`;
// ⑦ 範囲（min xyz・max xyz）と半径²（u32 に写した浮動小数の atomicMin／Max）・order の初期化
const STATS_WGSL = /* wgsl */`
struct T { n: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> T: T;
@group(0) @binding(1) var<storage, read_write> ctr: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> st: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> order: array<u32>;
fn key(v: f32) -> u32 { let b = bitcast<u32>(v); return select(b ^ 0xffffffffu, b | 0x80000000u, (b & 0x80000000u) == 0u); }   // 大小の順を保つ u32
@compute @workgroup_size(${WG}) fn stats(@builtin(global_invocation_id) g: vec3u) {
	let i = g.x; if (i >= T.n) { return; }
	let p = ctr[i].xyz; order[i] = i;
	atomicMin(&st[0], key(p.x)); atomicMin(&st[1], key(p.y)); atomicMin(&st[2], key(p.z));
	atomicMax(&st[3], key(p.x)); atomicMax(&st[4], key(p.y)); atomicMax(&st[5], key(p.z));
	atomicMax(&st[6], key(dot(p, p)));
}`;
const unkey = (k: number): number => { const b = (k & 0x80000000) ? (k & 0x7fffffff) : (~k >>> 0); const u = new Uint32Array([b]); return new Float32Array(u.buffer)[0]; };

/** 変換器が作った 1 段（描き手の層の buffer＝そのまま使う・destroy は層が外れる時） */
export interface GpuLevel { n: number; cell: number; bCtr: GPUBuffer; bCov: GPUBuffer; bCol: GPUBuffer; bOrder: GPUBuffer; bb: Float32Array; radius: number }
export interface CloudBuildResult { levels: GpuLevel[]; ms: number }
export interface CloudBuilder {
	/** 点（東北上 m・n×3）と色（RGBA・n×4）→ 段の列（level 0 が一番細かい）。plan＝cloud.ts の cloudPlan */
	build(pts: Float32Array, rgba: Uint8Array, n: number, plan: CloudPlan): Promise<CloudBuildResult>;
	/** 段の buffer を読み戻す（保存・書き出し用） */
	read(L: GpuLevel): Promise<{ ctr: Float32Array<ArrayBuffer>; cov: Float32Array<ArrayBuffer>; col: Uint32Array<ArrayBuffer> }>;
	/** 読み戻した段（保存した物）を GPU に載せ直す */
	upload(d: { n: number; cell: number; ctr: Float32Array; cov: Float32Array; col: Uint32Array; bb: ArrayLike<number>; radius: number }): GpuLevel;
	destroy(): void;
}
const align4 = (b: number): number => Math.max(16, Math.ceil(b / 16) * 16);

/** 変換器を作る（device＝本体の物・compile＝WGSL の検め＝splat-gpu.ts の物） */
export async function createCloudBuilder(device: GPUDevice, compile: (code: string, label: string) => Promise<GPUShaderModule>): Promise<CloudBuilder> {
	const sb = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: STAGE_C, buffer: { type: "storage" } }), ub = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: STAGE_C, buffer: { type: "uniform" } });
	const hashL = device.createBindGroupLayout({ label: "cloud-hash", entries: [ub(0), sb(1), sb(2), sb(3)] });
	const scanL = device.createBindGroupLayout({ label: "cloud-scan", entries: [ub(0), sb(1), sb(2), sb(3)] });
	const mergeL = device.createBindGroupLayout({ label: "cloud-merge", entries: [ub(0), sb(1), sb(2), sb(3), sb(4), sb(5), sb(6), sb(7), sb(8)] });
	const statsL = device.createBindGroupLayout({ label: "cloud-stats", entries: [ub(0), sb(1), sb(2), sb(3)] });
	const [hm, sm, mm, tm] = await Promise.all([compile(HASH_WGSL, "cloud-hash"), compile(SCAN_WGSL, "cloud-scan"), compile(MERGE_WGSL, "cloud-merge"), compile(STATS_WGSL, "cloud-stats")]);
	const pl = (l: GPUBindGroupLayout) => device.createPipelineLayout({ bindGroupLayouts: [l] });
	const cp = (label: string, layout: GPUPipelineLayout, module: GPUShaderModule, entryPoint: string) => device.createComputePipelineAsync({ label, layout, compute: { module, entryPoint } });
	const hashPL = pl(hashL), scanPL = pl(scanL), mergePL = pl(mergeL), statsPL = pl(statsL);
	const [pKey, pScatter, pScanBlock, pScanSums, pScanAdd, pLeader, pMerge, pStats] = await Promise.all([
		cp("cloud-keyHist", hashPL, hm, "keyHist"), cp("cloud-scatter", hashPL, hm, "scatter"),
		cp("cloud-scanBlock", scanPL, sm, "scanBlock"), cp("cloud-scanSums", scanPL, sm, "scanSums"), cp("cloud-scanAdd", scanPL, sm, "scanAdd"),
		cp("cloud-leader", mergePL, mm, "leader"), cp("cloud-merge", mergePL, mm, "merge"), cp("cloud-stats", statsPL, tm, "stats"),
	]);
	const mk = (size: number, usage: number, label: string): GPUBuffer => device.createBuffer({ label, size: align4(size), usage });
	const mkData = (data: ArrayBufferView, usage: number, label: string): GPUBuffer => {
		const b = device.createBuffer({ label, size: align4(data.byteLength), usage, mappedAtCreation: true });
		new Uint8Array(b.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); b.unmap();
		return b;
	};
	const uData = new ArrayBuffer(U_SIZE), uF = new Float32Array(uData), uU = new Uint32Array(uData), sData = new ArrayBuffer(16), sU = new Uint32Array(sData);
	const dummy = mk(16, BUF.STORAGE, "cloud-dummy"), total = mk(16, BUF.STORAGE | BUF.COPY_SRC | BUF.COPY_DST, "cloud-total"), stBuf = mk(32, BUF.STORAGE | BUF.COPY_SRC | BUF.COPY_DST, "cloud-stats");
	const readU32 = async (src: GPUBuffer, bytes: number): Promise<Uint32Array> => {
		const rb = device.createBuffer({ size: align4(bytes), usage: BUF.MAP_READ | BUF.COPY_DST });
		const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(src, 0, rb, 0, align4(bytes)); device.queue.submit([enc.finish()]);
		await rb.mapAsync(BUF.MAP_READ); const out = new Uint32Array(rb.getMappedRange().slice(0, bytes)); rb.unmap(); rb.destroy();
		return out;
	};
	// 累積（in place）＝len は 1024 の倍数まで詰めた buffer（余りは 0）
	const scan = (enc: GPUCommandEncoder, data: GPUBuffer, len: number, sums: GPUBuffer, su: GPUBuffer): void => {
		const blocks = Math.ceil(len / BLOCK);
		const bg = device.createBindGroup({ layout: scanL, entries: [{ binding: 0, resource: { buffer: su } }, { binding: 1, resource: { buffer: data } }, { binding: 2, resource: { buffer: sums } }, { binding: 3, resource: { buffer: total } }] });
		const p = enc.beginComputePass({ label: "cloud-scan" }); p.setBindGroup(0, bg);
		p.setPipeline(pScanBlock); p.dispatchWorkgroups(blocks); p.setPipeline(pScanSums); p.dispatchWorkgroups(1); p.setPipeline(pScanAdd); p.dispatchWorkgroups(Math.ceil(len / WG)); p.end();
	};
	async function build(pts: Float32Array, rgba: Uint8Array, n: number, plan: CloudPlan): Promise<CloudBuildResult> {
		const t0 = performance.now();
		const H = 1 << plan.hashBits, mask = H - 1;
		// level 0 の入力＝vec4(xyz, 色の bit)
		const pos0 = new Float32Array(n * 4), pu = new Uint32Array(pos0.buffer), cu = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
		for (let i = 0; i < n; i++) { pos0[i * 4] = pts[i * 3]; pos0[i * 4 + 1] = pts[i * 3 + 1]; pos0[i * 4 + 2] = pts[i * 3 + 2]; pu[i * 4 + 3] = cu[i]; }
		let bPos = mkData(pos0, BUF.STORAGE | BUF.COPY_SRC, "cloud-pos0"), bCov: GPUBuffer | null = null, cnt = n, own0 = true;
		const counts = mk((H + BLOCK) * 4, BUF.STORAGE | BUF.COPY_DST | BUF.COPY_SRC, "cloud-counts"), starts = mk((H + BLOCK) * 4, BUF.STORAGE | BUF.COPY_DST | BUF.COPY_SRC, "cloud-starts");
		const order = mk(n * 4, BUF.STORAGE, "cloud-order"), flags = mk((n + BLOCK) * 4, BUF.STORAGE | BUF.COPY_DST, "cloud-flags");
		const sumsH = mk(Math.ceil(H / BLOCK) * 4, BUF.STORAGE, "cloud-sumsH"), sumsN = mk(Math.ceil(n / BLOCK) * 4, BUF.STORAGE, "cloud-sumsN");
		const suH = mk(16, BUF.UNIFORM | BUF.COPY_DST, "cloud-suH"), suN = mk(16, BUF.UNIFORM | BUF.COPY_DST, "cloud-suN"), ubuf = mk(U_SIZE, BUF.UNIFORM | BUF.COPY_DST, "cloud-u"), tu = mk(16, BUF.UNIFORM | BUF.COPY_DST, "cloud-tu");
		sU[0] = H; sU[1] = Math.ceil(H / BLOCK); device.queue.writeBuffer(suH, 0, sData);
		const levels: GpuLevel[] = [];
		try {
			for (let L = 0; L < plan.levels; L++) {
				const c = plan.cell0 * 2 ** L;
				uU[0] = cnt; uU[1] = mask; uF[2] = c; uF[3] = 1 / c; uF[4] = plan.r * plan.r; uF[5] = (plan.fill * c) ** 2; uF[6] = (plan.cap * c) ** 2; uU[7] = plan.maxNb; uU[8] = bCov ? 1 : 0;
				device.queue.writeBuffer(ubuf, 0, uData);
				sU[0] = cnt; sU[1] = Math.ceil(cnt / BLOCK); device.queue.writeBuffer(suN, 0, sData);
				const groups = Math.ceil(cnt / WG);
				// ① 度数 → ② 累積（counts → starts）→ ③ 散らし（cursor＝counts の写し）
				let enc = device.createCommandEncoder({ label: "cloud-hash" });
				enc.clearBuffer(counts); enc.clearBuffer(flags);
				const hashBG = device.createBindGroup({ layout: hashL, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: bPos } }, { binding: 2, resource: { buffer: counts } }, { binding: 3, resource: { buffer: order } }] });
				let p = enc.beginComputePass(); p.setBindGroup(0, hashBG); p.setPipeline(pKey); p.dispatchWorkgroups(groups); p.end();
				scan(enc, counts, H, sumsH, suH);
				enc.copyBufferToBuffer(counts, 0, starts, 0, H * 4); enc.copyBufferToBuffer(total, 0, starts, H * 4, 4);   // starts[H]＝総数（最後の run の終わり）
				p = enc.beginComputePass(); p.setBindGroup(0, hashBG); p.setPipeline(pScatter); p.dispatchWorkgroups(groups); p.end();
				// ④ 先頭の印 → ⑤ 累積（書く番号・総数）
				const mergeBG = (dPos: GPUBuffer, dCov: GPUBuffer, dCol: GPUBuffer) => device.createBindGroup({ layout: mergeL, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: bPos } }, { binding: 2, resource: { buffer: bCov ?? dummy } }, { binding: 3, resource: { buffer: starts } }, { binding: 4, resource: { buffer: order } }, { binding: 5, resource: { buffer: flags } }, { binding: 6, resource: { buffer: dPos } }, { binding: 7, resource: { buffer: dCov } }, { binding: 8, resource: { buffer: dCol } }] });
				p = enc.beginComputePass(); p.setBindGroup(0, mergeBG(dummy, dummy, dummy)); p.setPipeline(pLeader); p.dispatchWorkgroups(groups); p.end();
				scan(enc, flags, cnt, sumsN, suN);
				device.queue.submit([enc.finish()]);
				const m = (await readU32(total, 4))[0];
				if (!(m > 0)) throw new Error("splat: cloud produced no splats");
				// ⑥ まとめて書く → ⑦ 範囲・半径・order
				const dPos = mk(m * 16, BUF.STORAGE | BUF.COPY_SRC, `cloud-ctr${L}`), dCov = mk(m * 32, BUF.STORAGE | BUF.COPY_SRC, `cloud-cov${L}`), dCol = mk(m * 4, BUF.STORAGE | BUF.COPY_SRC, `cloud-col${L}`), dOrder = mk(m * 4, BUF.STORAGE, `cloud-order${L}`);
				enc = device.createCommandEncoder({ label: "cloud-merge" });
				p = enc.beginComputePass(); p.setBindGroup(0, mergeBG(dPos, dCov, dCol)); p.setPipeline(pMerge); p.dispatchWorkgroups(groups); p.end();
				const init = new Uint32Array([0xffffffff, 0xffffffff, 0xffffffff, 0, 0, 0, 0, 0]); device.queue.writeBuffer(stBuf, 0, init);
				sU[0] = m; device.queue.writeBuffer(tu, 0, sData);
				const statsBG = device.createBindGroup({ layout: statsL, entries: [{ binding: 0, resource: { buffer: tu } }, { binding: 1, resource: { buffer: dPos } }, { binding: 2, resource: { buffer: stBuf } }, { binding: 3, resource: { buffer: dOrder } }] });
				p = enc.beginComputePass(); p.setBindGroup(0, statsBG); p.setPipeline(pStats); p.dispatchWorkgroups(Math.ceil(m / WG)); p.end();
				device.queue.submit([enc.finish()]);
				const st = await readU32(stBuf, 28);
				const bb = new Float32Array([unkey(st[0]), unkey(st[1]), unkey(st[2]), unkey(st[3]), unkey(st[4]), unkey(st[5])]);
				levels.push({ n: m, cell: c, bCtr: dPos, bCov: dCov, bCol: dCol, bOrder: dOrder, bb, radius: Math.sqrt(Math.max(0, unkey(st[6]))) });
				if (own0) { bPos.destroy(); own0 = false; }
				bPos = dPos; bCov = dCov; cnt = m;
				if (m <= 1) break;
			}
		} catch (e) { for (const L of levels) for (const b of [L.bCtr, L.bCov, L.bCol, L.bOrder]) b.destroy(); throw e; }
		finally { if (own0) bPos.destroy(); for (const b of [counts, starts, order, flags, sumsH, sumsN, suH, suN, ubuf, tu]) b.destroy(); }
		return { levels, ms: performance.now() - t0 };
	}
	async function read(L: GpuLevel): Promise<{ ctr: Float32Array<ArrayBuffer>; cov: Float32Array<ArrayBuffer>; col: Uint32Array<ArrayBuffer> }> {
		const rd = async (b: GPUBuffer, bytes: number): Promise<ArrayBuffer> => {
			const rb = device.createBuffer({ size: align4(bytes), usage: BUF.MAP_READ | BUF.COPY_DST });
			const enc = device.createCommandEncoder(); enc.copyBufferToBuffer(b, 0, rb, 0, align4(bytes)); device.queue.submit([enc.finish()]);
			await rb.mapAsync(BUF.MAP_READ); const out = rb.getMappedRange().slice(0, bytes); rb.unmap(); rb.destroy(); return out;
		};
		const [c, v, k] = await Promise.all([rd(L.bCtr, L.n * 16), rd(L.bCov, L.n * 32), rd(L.bCol, L.n * 4)]);
		return { ctr: new Float32Array(c), cov: new Float32Array(v), col: new Uint32Array(k) };
	}
	function upload(d: { n: number; cell: number; ctr: Float32Array; cov: Float32Array; col: Uint32Array; bb: ArrayLike<number>; radius: number }): GpuLevel {
		const n = d.n, order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
		return { n, cell: d.cell, bCtr: mkData(d.ctr, BUF.STORAGE | BUF.COPY_SRC, "cloud-ctr"), bCov: mkData(d.cov, BUF.STORAGE | BUF.COPY_SRC, "cloud-cov"), bCol: mkData(d.col, BUF.STORAGE | BUF.COPY_SRC, "cloud-col"), bOrder: mkData(order, BUF.STORAGE, "cloud-order"), bb: Float32Array.from(d.bb), radius: d.radius };
	}
	return { build, read, upload, destroy() { for (const b of [dummy, total, stBuf]) b.destroy(); } };
}
