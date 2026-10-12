// @ortho-earth/core/gpu — WebGPU 土台（render worker 内で使う）。
export function createRendererGPU(canvas: OffscreenCanvas | HTMLCanvasElement, rOpts?: Record<string, unknown>): Promise<Renderer>;
export function createGintLayerGPU(device: unknown, opts?: Record<string, unknown>): { [k: string]: unknown };
export interface Renderer { set(key: string, value: unknown): void; draw(...args: unknown[]): unknown; dispose(): void; [k: string]: unknown }
