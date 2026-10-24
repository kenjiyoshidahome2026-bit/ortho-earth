// voxel のオーバーレイの入口（map.overlay が URL で import() する・依存ゼロ）。@ortho-earth/voxel（2026-10-23）。
// 器を見て描き手を選ぶ：WebGPU（voxel-gpu.ts＝本体の device と深度テクスチャを共有）→ 無い・失敗＝WebGL2（voxel-gl.ts）。splat の splat-draw.ts と同じ。
// opts.backend＝"auto"（既定＝本体が WebGPU で描いている時だけ WebGPU＝device を共有）／"webgpu"（本体が WebGL2 でも自前の device で・無ければ失敗）／"webgl2"。
// 描き手は import.meta.url の問い（?ov=…＝render worker がオーバーレイごとに付ける）を引き継いで import する＝二つのオーバーレイ（above と below）で実体が混ざらない。
// 届いた message は選び終わるまで溜める。frame は選び終わるまで何も描かない（false）。pick は描き手の答え（WebGPU は Promise）をそのまま返す。
import type { VoxelMessage, VoxelPickResult, CamState, VoxelApi, PickContext, OverlayHost } from "./voxel-gl.ts";
import type { VoxelGpuModule } from "./voxel-gpu.ts";

export type VoxelBackend = "webgpu" | "webgl2";
export interface VoxelDrawOpts { depth?: boolean; backend?: VoxelBackend | "auto" }
interface GlModule { init(canvas: OffscreenCanvas, opts: { depth?: boolean }, host: OverlayHost | null): unknown; message(d: VoxelMessage): void; frame(cam: unknown, s: CamState, size: { w: number; h: number }, api: VoxelApi): boolean; pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): VoxelPickResult | null; destroy(): void }
type Impl = { kind: "webgpu"; m: VoxelGpuModule } | { kind: "webgl2"; m: GlModule };

// render worker はオーバーレイの名前ごとに一つのモジュール実体（URL の ?ov=名前）＝全部外して同じ名前で立て直すと、この実体がそのまま使い回される。
// ＝init で状態を戻し、古い init の非同期は世代（gen）で捨てる（以前は dead が true のまま残り、立て直したオーバーレイが何も描かず probe も答えなかった）
let impl: Impl | null = null, queue: VoxelMessage[] = [], gen = 0;
const withQuery = (u: URL): string => { u.search = new URL(import.meta.url).search; return u.href; };
const GPU_URL = (): string => withQuery(new URL("./voxel-gpu.js", import.meta.url)), GL_URL = (): string => withQuery(new URL("./voxel-gl.js", import.meta.url));
const hasGpu = (): boolean => !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

export function init(canvas: OffscreenCanvas, opts: VoxelDrawOpts = {}, h: OverlayHost | null = null): { depth: true } | undefined {
	const my = ++gen, dead = (): boolean => my !== gen;
	impl?.m.destroy(); impl = null; queue = [];
	const pref = opts.backend ?? "auto", want = opts.depth !== false, t0 = performance.now();
	(async () => {
		try {
			const tryGpu = pref === "webgpu" ? hasGpu() : pref === "auto" && hasGpu() && !!h?.gpuDevice?.();   // auto＝本体の device がある時だけ
			if (tryGpu) {
				try {
					const mod = await import(/* @vite-ignore */ GPU_URL()) as typeof import("./voxel-gpu.ts");
					if (dead()) return;
					const m = mod.create();
					await m.init(canvas, { depth: want }, h);
					if (dead()) { m.destroy(); return; }
					impl = { kind: "webgpu", m };
				} catch (e) {
					if (pref === "webgpu") throw e;
					console.warn("[voxel] WebGPU unavailable, drawing with WebGL2:", (e as { message?: string } | null)?.message || e);
				}
			} else if (pref === "webgpu") throw new Error("WebGPU is not available (navigator.gpu)");
			if (!impl) {
				const m = await import(/* @vite-ignore */ GL_URL()) as GlModule;
				if (dead()) return;
				m.init(canvas, { depth: want }, h);
				impl = { kind: "webgl2", m };
			}
			for (const d of queue) impl.m.message(d);
			queue = [];
			console.info(`[voxel] backend=${impl.kind}${impl.kind === "webgpu" && impl.m.shared ? " (map's device)" : ""} in ${Math.round(performance.now() - t0)}ms`);
			h?.post?.({ type: "backend", backend: impl.kind, shared: impl.kind === "webgpu" && impl.m.shared });
			h?.requestDraw?.();
		} catch (e) {
			const error = String((e as { message?: string } | null)?.message || e);
			console.error("[voxel] overlay failed", e);
			h?.post?.({ type: "backend", backend: null, error });
			for (const d of queue) if (d.type === "probe") h?.post?.({ type: "pixels", id: d.id, error });   // 検定の probe を宙吊りにしない
			queue = [];
		}
	})();
	return want ? { depth: true } : undefined;
}
export function message(d: VoxelMessage): void { if (impl) impl.m.message(d); else queue.push(d); }
export function frame(cam: unknown, s: CamState, size: { w: number; h: number }, api: VoxelApi): boolean { return impl ? impl.m.frame(cam, s, size, api) : false; }
export function pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): VoxelPickResult | null | Promise<VoxelPickResult | null> { return impl ? impl.m.pick(x, y, r, ctx) : null; }
export function destroy(): void { gen++; impl?.m.destroy(); impl = null; queue = []; }
