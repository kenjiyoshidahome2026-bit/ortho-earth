// @ortho-earth/core/gpu — WebGPU 土台（render worker 内で使う）。
export function createRendererGPU(canvas: OffscreenCanvas | HTMLCanvasElement, rOpts?: Record<string, unknown>): Promise<Renderer>;
/** host＝createRendererGPU の戻り（device・quad4 などを持つ renderer）。device ではない。layerH＝2D 配列の層の高さの上書き（検定用）。 */
export function createGintLayerGPU(host: Renderer, opts?: { requestDraw?: () => void; noSB?: boolean; quad4?: boolean; layerH?: number }): { [k: string]: unknown };
export interface Renderer { set(key: string, value: unknown): void; draw(...args: unknown[]): unknown; dispose(): void; quad4?: boolean; [k: string]: unknown }
