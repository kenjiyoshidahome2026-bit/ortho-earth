// 描画バックエンドの選択（2026-09-30 本人依頼「EqualEarth の WebGPU 化」）＝globe（packages/globe/src/globe.js）と同じ掟：
// navigator.gpu があれば WebGPU が既定・Android は一律 WebGL2（Adreno/Mali の黒画面バグ族・2026-08-03 本人裁定）・
// ?gl2=1＝強制 WebGL2・?gpu=1＝Android の封も破って WebGPU を試す。WebGPU の初期化が失敗したら同じ canvas で WebGL2 へ落ちる
//（renderer-gpu.js は getContext("webgpu") を全部通った後に取る＝失敗時の canvas はまだ無垢）。
// WebGPU の描画は dynamic import＝WebGL2 の機体は WGSL もパイプライン作成も読まない。
import { createRenderer } from "./renderer.js";

const IS_ANDROID = () => /Android/.test(navigator.userAgent) || navigator.userAgentData?.platform === "Android";

export function pickBackend(q = new URLSearchParams(), search = location.search) {
	const flag = k => q.get(k) === "1" || new RegExp(`[?&]${k}=1`).test(search);
	if (flag("gl2") || !("gpu" in navigator)) return "webgl2";
	if (flag("gpu")) return "webgpu";
	return IS_ANDROID() ? "webgl2" : "webgpu";
}

export async function createBackend(canvas, q) {
	if (pickBackend(q) === "webgpu") {
		try {
			const { createRendererGPU } = await import("./renderer-gpu.js");
			const R = await createRendererGPU(canvas);
			if (R) { console.info("[equal] backend webgpu"); return R; }
			console.warn("[equal] WebGPU unavailable -> WebGL2");
		} catch (e) { console.warn("[equal] WebGPU init failed -> WebGL2", e); }
	}
	return createRenderer(canvas);
}
