// Gaussian splat のオーバーレイの入口（map.overlay が URL で import() する・依存ゼロ）。@ortho-earth/plugin-splat（2026-10-18）。
// 器を見て描き手を選ぶ：WebGPU（splat-gpu.ts＝SH・GPU の並べ替え・本体の device と深度を共有）→ 無い・失敗＝WebGL2（splat-gl.ts＝DC の色だけ・CPU の並べ替え）。
// opts.backend＝"auto"（既定）／"webgpu"（無ければ失敗）／"webgl2"。選んだら host.post({ type: "backend", backend }) で main（index.ts の手綱 backend）へ。
// 描き手は import.meta.url の問い（?ov=…＝render worker がオーバーレイごとに付ける）を引き継いで import する＝二つのオーバーレイ（above と below）で実体が混ざらない。
// 届いた message は選び終わるまで溜める。frame は選び終わるまで何も描かない（false）。pick は描き手の答え（WebGPU は Promise）をそのまま返す。
import type { SplatMessage, SplatPickResult, CamState, SplatApi, PickContext, OverlayHost } from "./splat-gl.ts";
import type { SplatGpuModule } from "./splat-gpu.ts";

export type SplatBackend = "webgpu" | "webgl2";
export interface SplatDrawOpts { depth?: boolean; backend?: SplatBackend | "auto" }
/** WebGL2 の描き手（splat-gl.ts）の口＝module の export */
interface GlModule { init(canvas: OffscreenCanvas, opts: { depth?: boolean }, host: OverlayHost | null): unknown; message(d: SplatMessage): void; frame(cam: unknown, s: CamState, size: { w: number; h: number }, api: SplatApi): boolean; pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): SplatPickResult | null; destroy(): void }
type Impl = { kind: "webgpu"; m: SplatGpuModule } | { kind: "webgl2"; m: GlModule };

let impl: Impl | null = null, queue: SplatMessage[] = [], dead = false;
// 兄弟のモジュールの URL（.js の字面＝npm の dist では実体・repo の中では Vite が .ts に読み替える＝new URL の中は字面のまま書く）に、自分の問い（?ov=…）を引き継ぐ
const withQuery = (u: URL): string => { u.search = new URL(import.meta.url).search; return u.href; };
const GPU_URL = (): string => withQuery(new URL("./splat-gpu.js", import.meta.url)), GL_URL = (): string => withQuery(new URL("./splat-gl.js", import.meta.url));
const hasGpu = (): boolean => !!(globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;

export function init(canvas: OffscreenCanvas, opts: SplatDrawOpts = {}, h: OverlayHost | null = null): { depth: true } | undefined {
	const pref = opts.backend ?? "auto", want = opts.depth !== false;
	(async () => {
		try {
			if (pref !== "webgl2" && hasGpu()) {
				try {
					const mod = await import(/* @vite-ignore */ GPU_URL()) as typeof import("./splat-gpu.ts");
					if (dead) return;
					const m = mod.create();
					await m.init(canvas, { depth: want }, h);
					if (dead) { m.destroy(); return; }
					impl = { kind: "webgpu", m };
				} catch (e) {
					if (pref === "webgpu") throw e;
					console.warn("[plugin-splat] WebGPU unavailable, drawing with WebGL2:", (e as { message?: string } | null)?.message || e);
				}
			} else if (pref === "webgpu") throw new Error("WebGPU is not available (navigator.gpu)");
			if (!impl) {
				const m = await import(/* @vite-ignore */ GL_URL()) as GlModule;
				if (dead) return;
				m.init(canvas, { depth: want }, h);
				impl = { kind: "webgl2", m };
			}
			for (const d of queue) impl.m.message(d);
			queue = [];
			h?.post?.({ type: "backend", backend: impl.kind, shared: impl.kind === "webgpu" && impl.m.shared });
			h?.requestDraw?.();
		} catch (e) {
			const error = String((e as { message?: string } | null)?.message || e);
			console.error("[plugin-splat] overlay failed", e);
			h?.post?.({ type: "backend", backend: null, error });
			for (const d of queue) if (d.type === "probe") h?.post?.({ type: "pixels", id: d.id, error });   // 検定の probe を宙吊りにしない
			queue = [];
		}
	})();
	return want ? { depth: true } : undefined;
}
export function message(d: SplatMessage): void { if (impl) impl.m.message(d); else queue.push(d); }
export function frame(cam: unknown, s: CamState, size: { w: number; h: number }, api: SplatApi): boolean { return impl ? impl.m.frame(cam, s, size, api) : false; }
export function pick(x: number, y: number, r: number, ctx: PickContext | null | undefined): SplatPickResult | null | Promise<SplatPickResult | null> { return impl ? impl.m.pick(x, y, r, ctx) : null; }
export function destroy(): void { dead = true; impl?.m.destroy(); impl = null; queue = []; }
