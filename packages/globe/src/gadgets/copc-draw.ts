// COPC の点群のオーバーレイの入口（render worker の BUILTIN_OVERLAYS "copc"・2026-10-23）＝器を見て描き手を選ぶ。
//   本体が WebGPU で描いている（host.gpuDevice() がある）＝copc-gpu.ts（本体の device と深度を共有＝API 跨ぎの写しなし）。
//   本体が WebGL2・WebGPU の準備に失敗＝copc-gl.ts（従来）。plugin-splat の splat-draw.ts と同じ形。
//   選び終わるまで message は溜め、frame は何も描かない。選んだら host.post({ type:"backend", backend }) で main（gadgets/copc.ts の手綱 backend）へ。
//   ?copcgl=1（頁の URL）＝WebGPU でも WebGL2 で描く（比較・逃げ道）＝render worker には location が無いので main が opts.gl で渡す。
import type { CameraPose, CameraState, OverlayApi, OverlayHost, OverlaySize, OverlayModule } from "../types/overlay.ts";
import type { Msg } from "./copc-gl.ts";
import type { CopcGpuModule } from "./copc-gpu.ts";
import { create as createGl } from "./copc-gl.ts";

type GlModule = ReturnType<typeof createGl>;
type Impl = { kind: "webgpu"; m: CopcGpuModule } | { kind: "webgl2"; m: GlModule };
export type CopcBackend = Impl["kind"];

export function create(): OverlayModule {
	let impl: Impl | null = null, queue: Msg[] = [], dead = false;
	function init(canvas: OffscreenCanvas, opts: { depth?: boolean; gl?: boolean } = {}, h: OverlayHost | null = null): { depth: true } | undefined {
		const want = opts.depth !== false, t0 = performance.now();
		(async () => {
			try {
				if (!opts.gl && h?.gpuDevice?.()) {
					try {
						const m = (await import("./copc-gpu.ts")).create();
						await m.init(canvas, { depth: want }, h);
						if (dead) { m.destroy(); return; }
						impl = { kind: "webgpu", m };
					} catch (e) { console.warn("[copc] WebGPU drawer unavailable, drawing with WebGL2:", (e as Error)?.message || e); }
				}
				if (dead) return;
				if (!impl) { const m = createGl(); m.init(canvas, { depth: want }, h); impl = { kind: "webgl2", m }; }
				for (const d of queue) impl.m.message(d);
				queue = [];
				console.info(`[copc] backend=${impl.kind} in ${Math.round(performance.now() - t0)}ms`);
				h?.post?.({ type: "backend", backend: impl.kind });
				h?.requestDraw?.();
			} catch (e) {
				const error = String((e as Error)?.message || e);
				console.error("[copc] overlay failed", e);
				h?.stage?.("failed", { error });
				h?.post?.({ type: "backend", backend: null, error });
				for (const d of queue) if (d.type === "probe") h?.post?.({ type: "pixels", id: d.id, error });   // 検定の probe を宙吊りにしない
				queue = [];
			}
		})();
		return want ? { depth: true } : undefined;
	}
	function message(d: unknown): void { if (impl) impl.m.message(d as Msg); else queue.push(d as Msg); }
	function frame(cam: CameraPose, s: CameraState, size: OverlaySize, api: OverlayApi): boolean { return impl ? !!impl.m.frame(cam, s, size, api) : false; }
	function destroy(): void { dead = true; impl?.m.destroy(); impl = null; queue = []; }
	return { init, message, frame, destroy };
}
