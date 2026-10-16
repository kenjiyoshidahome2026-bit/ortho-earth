// 任意依存の `webgpu`（npm の Dawn＝Node の WebGPU）の型の最小限＝geopbf.ts の injectDawn() が使う分だけ。
// 未導入でも型検査が通るように置く（`import("webgpu" as string)` で逃がすと tsc が dist に拡張子書き換えの helper を足す）。
declare module "webgpu" {
	export function create(flags: string[]): GPU;
	export const globals: Record<string, unknown> | undefined;
}
