// 描画バックエンドの選択（2026-09-30 本人依頼「EqualEarth の WebGPU 化」）＝globe（packages/globe/src/globe.js）と同じ掟：
// navigator.gpu があれば WebGPU が既定（Android も・2026-11-03 本人裁定で 8 月の「Android は一律 WebGL2」を解除）・
// ?gl2=1＝強制 WebGL2・?gpu=1＝WebGPU を強制。WebGPU の初期化が失敗したら同じ canvas で WebGL2 へ落ちる
//（renderer-gpu.ts は getContext("webgpu") を全部通った後に取る＝失敗時の canvas はまだ無垢）。
// WebGPU の描画は dynamic import＝WebGL2 の機体は WGSL もパイプライン作成も読まない。
import { createRenderer } from "./renderer.ts";
import type { Renderer } from "./types.ts";

export function pickBackend(q: URLSearchParams = new URLSearchParams(), search: string = location.search): "webgl2" | "webgpu" {
	const flag = (k: string): boolean => q.get(k) === "1" || new RegExp(`[?&]${k}=1`).test(search);
	if (flag("gl2") || !("gpu" in navigator)) return "webgl2";
	return "webgpu";
}

export async function createBackend(canvas: HTMLCanvasElement, q?: URLSearchParams): Promise<Renderer | null> {
	if (pickBackend(q) === "webgpu") {
		try {
			const { createRendererGPU } = await import("./renderer-gpu.ts");
			const R = await createRendererGPU(canvas);
			if (R) { console.info("[equal] backend webgpu"); return R; }
			console.warn("[equal] WebGPU unavailable -> WebGL2");
		} catch (e) { console.warn("[equal] WebGPU init failed -> WebGL2", e); }
	}
	return createRenderer(canvas);
}
