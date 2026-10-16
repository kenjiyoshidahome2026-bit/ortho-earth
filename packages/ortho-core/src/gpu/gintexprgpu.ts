// gint の fid 表を GPU で組む走者（geopbf 改良点 ⑦・2026-10-12）── gintexpr.js が吐いた compute を device に載せ、属性列・辞書表・feature-state 列を
// buffer で持ち、走らせた結果（vec4u × count）を fid 表テクスチャ（rgba32uint・幅 W）へ copyBufferToTexture する。
// gpu/gint.js の paintExpr と検定頁（globe/tests/t-gintexpr.html）が共用＝検定は本物の走者で GPU の表を読み戻して CPU（buildFidStyle）と突き合わせる。
// feature-state は 1 fid × 鍵の列をその場で writeBuffer（列の該当セル 8 B）＝CPU の全 fid 再評価を飛ばす（本題の勝ち筋）。
const WG = 64;
import type { FidStyleWGSL } from "./gintexpr.ts";

const align = (n: number, a: number): number => Math.ceil(n / a) * a;

/** create の入力（属性列・feature-state 列・geometry-type 列・辞書の表）。 */
export interface FidExprData { count: number; props?: Uint32Array | null; states?: Uint32Array | null; geom?: Uint32Array | null; dnum?: Uint32Array | null; dcol?: Float32Array | null; zoom?: number | null }
/** 1 層の走者（create の戻り）。 */
export interface FidExprJob {
	count: number; H: number; texW: number; prog: FidStyleWGSL;
	uni: GPUBuffer; props: GPUBuffer; states: GPUBuffer; geom: GPUBuffer; dnum: GPUBuffer; dcol: GPUBuffer; out: GPUBuffer;
	dictN: number; zoom: number; bg: GPUBindGroup | null; stateKeys: string[];
	/** 走らせて（必要なら）表テクスチャへ写す。enc を渡せば呼び手の encoder に相乗り */
	run(o?: { zoom?: number | null; tex?: GPUTexture | null; enc?: GPUCommandEncoder | null }): void;
	/** feature-state の差し替え＝1 fid × 鍵ごとの [t, p] */
	setState(fid: number, cells: ArrayLike<readonly [number, number] | null | undefined> | null | undefined): void;
	growDict(dnum: Uint32Array, dcol: Float32Array): void;
	setStates(states: Uint32Array): void;
	readback(): Promise<Uint32Array>;
	destroy(): void;
}
export interface FidExprRunner { create(prog: FidStyleWGSL, data: FidExprData): Promise<FidExprJob>; pipelineFor(wgsl: string): Promise<GPUComputePipeline>; dispose(): void }
export function createFidExprRunner(device: GPUDevice, { texW = 4096 }: { texW?: number } = {}): FidExprRunner {
	const pipes = new Map<string, Promise<GPUComputePipeline>>();   // wgsl → Promise<pipeline>
	const bgl = device.createBindGroupLayout({ entries: [
		{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
		...[1, 2, 3, 4, 5].map((binding): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } })),
		{ binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }] });
	const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
	async function pipelineFor(wgsl: string): Promise<GPUComputePipeline> {
		let p = pipes.get(wgsl);
		if (!p) {
			p = (async () => {
				const module = device.createShaderModule({ code: wgsl });
				const info = await module.getCompilationInfo();
				const bad = (info.messages || []).filter(x => x.type === "error").map(x => `${x.lineNum}:${x.linePos} ${x.message}`);
				if (bad.length) throw new Error("WGSL gint-expr: " + bad.join("; "));
				return device.createComputePipelineAsync({ layout, compute: { module, entryPoint: "main" } });
			})();
			pipes.set(wgsl, p);
			p.catch(() => pipes.delete(wgsl));
		}
		return p;
	}
	const mkBuf = (bytes: number, usage: GPUBufferUsageFlags, label: string) => device.createBuffer({ size: Math.max(16, align(bytes, 16)), usage, label });
	const upload = (data: Uint32Array | Float32Array, usage: GPUBufferUsageFlags, label: string, headroom = 1) => { const b = mkBuf(data.byteLength * headroom, usage | GPUBufferUsage.COPY_DST, label); if (data.byteLength) device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength); return b; };
	// prog＝compileFidStyleWGSL の戻り、data＝{ count, props(Uint32Array), states(Uint32Array), geom(Uint32Array), dnum(Uint32Array), dcol(Float32Array), zoom }
	async function create(prog: FidStyleWGSL, data: FidExprData): Promise<FidExprJob> {
		const pipeline = await pipelineFor(prog.wgsl);
		const count = data.count | 0, H = Math.max(1, Math.ceil(count / texW));
		const ST = GPUBufferUsage.STORAGE;
		const J = {
			count, H, texW, prog,
			uni: mkBuf(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, "gint-expr-uni"),
			props: upload(data.props ?? new Uint32Array(0), ST, "gint-expr-props"),
			states: upload(data.states ?? new Uint32Array(0), ST, "gint-expr-states"),
			geom: upload(data.geom ?? new Uint32Array(0), ST, "gint-expr-geom"),
			dnum: upload(data.dnum ?? new Uint32Array(0), ST, "gint-expr-dnum", 2),
			dcol: upload(data.dcol ?? new Float32Array(0), ST, "gint-expr-dcol", 2),
			out: mkBuf(texW * H * 16, ST | GPUBufferUsage.COPY_SRC, "gint-expr-out"),
			dictN: ((data.dnum?.length ?? 0) / 2) | 0, zoom: +data.zoom! || 0, bg: null, stateKeys: prog.stateKeys ?? [],
		} as FidExprJob;
		const rebind = () => { J.bg = device.createBindGroup({ layout: bgl, entries: [J.uni, J.props, J.states, J.geom, J.dnum, J.dcol, J.out].map((buffer, binding) => ({ binding, resource: { buffer } })) }); };
		rebind();
		const writeUni = () => { const u = new ArrayBuffer(16); new Uint32Array(u)[0] = count; new Float32Array(u)[1] = J.zoom; device.queue.writeBuffer(J.uni, 0, u); };
		// 走らせて（必要なら）表テクスチャへ写す。enc を渡せば呼び手の encoder に相乗り
		J.run = ({ zoom, tex, enc } = {}) => {
			if (zoom != null) J.zoom = +zoom || 0;
			writeUni();
			const E = enc ?? device.createCommandEncoder({ label: "gint-expr" });
			const pass = E.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, J.bg); pass.dispatchWorkgroups(Math.ceil(Math.max(1, count) / WG)); pass.end();
			if (tex) E.copyBufferToTexture({ buffer: J.out, bytesPerRow: texW * 16, rowsPerImage: H }, { texture: tex }, [texW, H]);
			if (!enc) device.queue.submit([E.finish()]);
		};
		// feature-state の差し替え＝1 fid × 鍵ごとの [t, p]（attrcols の encodeStateRow）を列の該当セルへ
		J.setState = (fid, cells) => {
			if (!(fid >= 0 && fid < count) || !cells) return;
			const n = J.stateKeys.length, w = new Uint32Array(2);
			for (let ki = 0; ki < n; ki++) { const c = cells[ki]; w[0] = c?.[0] ?? 0; w[1] = c?.[1] ?? 0; device.queue.writeBuffer(J.states, (ki * count + fid) * 8, w); }
		};
		// 辞書が伸びた（feature-state に新しい文字列）＝表を伸ばす（容量を超えたら作り直し→bind し直し）
		J.growDict = (dnum, dcol) => {
			const n = (dnum.length / 2) | 0; if (n <= J.dictN) { return; }
			if (dnum.byteLength > J.dnum.size) { J.dnum.destroy(); J.dnum = upload(dnum, ST, "gint-expr-dnum", 2); J.dcol.destroy(); J.dcol = upload(dcol, ST, "gint-expr-dcol", 2); rebind(); }
			else { device.queue.writeBuffer(J.dnum, 0, dnum.buffer, dnum.byteOffset, dnum.byteLength); device.queue.writeBuffer(J.dcol, 0, dcol.buffer, dcol.byteOffset, dcol.byteLength); }
			J.dictN = n;
		};
		J.setStates = (states: Uint32Array) => { if (states.byteLength > J.states.size) { J.states.destroy(); J.states = upload(states, ST, "gint-expr-states"); rebind(); } else if (states.byteLength) device.queue.writeBuffer(J.states, 0, states.buffer, states.byteOffset, states.byteLength); };
		// 表の読み戻し（main の lastTable＝ラベルの filter 連動・照会の accept が visible ビットを読む）＝count × 4 u32
		J.readback = async () => {
			const bytes = count * 16; if (!bytes) return new Uint32Array(0);
			const stg = device.createBuffer({ size: align(bytes, 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
			const E = device.createCommandEncoder(); E.copyBufferToBuffer(J.out, 0, stg, 0, align(bytes, 4)); device.queue.submit([E.finish()]);
			await stg.mapAsync(GPUMapMode.READ);
			const u32 = new Uint32Array(stg.getMappedRange().slice(0, bytes)); stg.unmap(); stg.destroy();
			return u32;
		};
		J.destroy = () => { for (const b of [J.uni, J.props, J.states, J.geom, J.dnum, J.dcol, J.out]) b.destroy(); };
		return J;
	}
	return { create, pipelineFor, dispose: () => pipes.clear() };
}
