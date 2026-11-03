// GPU の選び方（powerPreference）＝既定は "high-performance"（2026-11-03）。
// 内蔵 GPU と NVIDIA 等の外付け GPU を両方持つノート PC では、何も言わないとブラウザが内蔵の遅い方を選ぶ事がある。
// 地球儀は重い描画なので速い方を頼む。電池を優先したい頁は createGlobe({ powerPreference: "low-power" }) か ?lowpower=1。
// 値はスレッド（realm）ごとに 1 つ＝main は globe が、描画 worker は init の値で setPowerPreference する。
// ブラウザへの「お願い」に過ぎない（OS やブラウザの設定が勝つ事がある）。
export type GpuPowerPreference = "high-performance" | "low-power" | "default";

let pref: GpuPowerPreference = "high-performance";

/** 以後に作る WebGPU アダプタ／WebGL2 コンテキストの希望を変える（未知の値は既定へ戻す） */
export function setPowerPreference(p: GpuPowerPreference | null | undefined): void {
	pref = p === "low-power" || p === "default" ? p : "high-performance";
}
/** いまの希望 */
export function powerPreference(): GpuPowerPreference { return pref; }
/** getContext("webgl2", glAttrs({...})) ＝ WebGL の属性に powerPreference を足す（呼び手が明示した値が勝つ） */
export function glAttrs(attrs?: WebGLContextAttributes): WebGLContextAttributes {
	return { powerPreference: pref, ...attrs };
}
/** WebGPU の requestAdapter に渡す形（"default" は WebGPU に無い＝何も言わない） */
export function gpuAdapterOptions(p: GpuPowerPreference = pref): GPURequestAdapterOptions | undefined {
	return p === "default" ? undefined : { powerPreference: p };
}
