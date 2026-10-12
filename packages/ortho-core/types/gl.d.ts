// @ortho-earth/core/gl — WebGL2 土台。
import type { Renderer } from "./gpu.js";
export function createRenderer(canvas: OffscreenCanvas | HTMLCanvasElement, rOpts?: Record<string, unknown>): Renderer;
export function createGintLayer(gl: WebGL2RenderingContext, opts?: { requestDraw?: () => void; quad4?: boolean }): { [k: string]: unknown };
