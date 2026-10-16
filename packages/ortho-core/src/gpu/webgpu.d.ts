// WebGPU の型の補い（TS 化 段 4・2026-10-16）。lib.dom（TypeScript 6.0）は GPUDevice 等の型を持つが、
// 定数の名前空間 4 つ（GPUBufferUsage・GPUTextureUsage・GPUShaderStage・GPUMapMode）と getContext("webgpu") の overload を持たない＝src/gpu/** が使う分だけ補う。
// @webgpu/types は devDependency に無い（node_modules にあるのは deck.gl → luma.gl の peer の孫）＝入れずに最小の宣言で足す（packages/equal/src/ambient.d.ts と同じ手）。
// 形は @webgpu/types と同じ（interface＋同名の var）＝将来どこかの program で両方が読まれても宣言が合流する。
interface GPUBufferUsage {
	readonly MAP_READ: GPUFlagsConstant;
	readonly MAP_WRITE: GPUFlagsConstant;
	readonly COPY_SRC: GPUFlagsConstant;
	readonly COPY_DST: GPUFlagsConstant;
	readonly INDEX: GPUFlagsConstant;
	readonly VERTEX: GPUFlagsConstant;
	readonly UNIFORM: GPUFlagsConstant;
	readonly STORAGE: GPUFlagsConstant;
	readonly INDIRECT: GPUFlagsConstant;
	readonly QUERY_RESOLVE: GPUFlagsConstant;
}
declare var GPUBufferUsage: GPUBufferUsage;
interface GPUTextureUsage {
	readonly COPY_SRC: GPUFlagsConstant;
	readonly COPY_DST: GPUFlagsConstant;
	readonly TEXTURE_BINDING: GPUFlagsConstant;
	readonly STORAGE_BINDING: GPUFlagsConstant;
	readonly RENDER_ATTACHMENT: GPUFlagsConstant;
}
declare var GPUTextureUsage: GPUTextureUsage;
interface GPUShaderStage {
	readonly VERTEX: GPUFlagsConstant;
	readonly FRAGMENT: GPUFlagsConstant;
	readonly COMPUTE: GPUFlagsConstant;
}
declare var GPUShaderStage: GPUShaderStage;
interface GPUMapMode {
	readonly READ: GPUFlagsConstant;
	readonly WRITE: GPUFlagsConstant;
}
declare var GPUMapMode: GPUMapMode;
interface HTMLCanvasElement {
	getContext(contextId: "webgpu"): GPUCanvasContext | null;
}
interface OffscreenCanvas {
	getContext(contextId: "webgpu"): GPUCanvasContext | null;
}
