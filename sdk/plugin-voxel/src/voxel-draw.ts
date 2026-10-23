// voxel のオーバーレイの入口（map.overlay が URL で import() する・依存ゼロ）。@ortho-earth/plugin-voxel（2026-10-23）。
// 第 1 段＝WebGL2 の描き手（voxel-gl.ts）だけ。第 2 段で WebGPU（voxel-gpu.ts）を足し、plugin-splat の splat-draw.ts と同じく器で選ぶ。
// 描き手は import.meta.url の問い（?ov=…＝render worker がオーバーレイごとに付ける）を引き継いで import する＝二つのオーバーレイ（above と below）で実体が混ざらない。
// 届いた message は読み終わるまで溜める。frame は読み終わるまで何も描かない（false）。
import type { VoxelMessage, VoxelPickResult, CamState, VoxelApi, PickContext, OverlayHost } from "./voxel-gl.ts";

export type VoxelBackend = "webgl2";
export interface VoxelDrawOpts { depth?: boolean; backend?: VoxelBackend | "auto" }
interface GlModule { init(canvas: OffscreenCanvas, opts: { depth?: boolean }, host: OverlayHost | null): unknown; message(d: VoxelMessage): void; frame(cam: unknown, s: CamState, size: { w: number; h: number }, api: VoxelApi): boolean; pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): VoxelPickResult | null; destroy(): void }

let impl: GlModule | null = null, queue: VoxelMessage[] = [], dead = false;
const withQuery = (u: URL): string => { u.search = new URL(import.meta.url).search; return u.href; };
const GL_URL = (): string => withQuery(new URL("./voxel-gl.js", import.meta.url));

export function init(canvas: OffscreenCanvas, opts: VoxelDrawOpts = {}, h: OverlayHost | null = null): { depth: true } | undefined {
	const want = opts.depth !== false;
	(async () => {
		try {
			const mod = await import(/* @vite-ignore */ GL_URL()) as GlModule;
			if (dead) return;
			mod.init(canvas, { depth: want }, h);
			impl = mod;
			h?.post?.({ type: "backend", backend: "webgl2" });
			for (const m of queue.splice(0)) impl.message(m);
			h?.requestDraw?.();
		} catch (e) {
			h?.post?.({ type: "backend", backend: null, error: String((e as { message?: string } | null)?.message || e) });
		}
	})();
	return want && h?.depthGLSL ? { depth: true } : undefined;
}
export function message(d: VoxelMessage): void { if (impl) impl.message(d); else queue.push(d); }
export function frame(cam: unknown, s: CamState, size: { w: number; h: number }, api: VoxelApi): boolean { return impl ? impl.frame(cam, s, size, api) : false; }
export function pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): VoxelPickResult | null { return impl ? impl.pick(x, y, r, ctx) : null; }
export function destroy(): void { dead = true; queue = []; impl?.destroy(); impl = null; }
