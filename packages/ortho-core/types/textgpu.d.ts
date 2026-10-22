// @ortho-earth/core/textgpu — 注記の字（線に沿う・点）を WebGPU で塗る（テキスト GPU 化 T-P1・T-P2・render worker 内で使う）。
// 源（src/gpu/text.ts）は WebGPU の定数（GPUTextureUsage 等）を使う＝それを宣言しない program（globe）からはこの宣言で読む（gpu.d.ts と同じ手）。
import type { Mat2 } from "../src/labels2d.ts";
import type { TextSink } from "../src/textsink.ts";

/** 版の中の字 1 つ（版の px）。ox, oy＝字の錨（中央・middle）から箱の左上（基準の大きさの px） */
export interface SdfGlyph { x: number; y: number; w: number; h: number; ox: number; oy: number }
export interface GpuText {
	glyph(font: string, ch: string): SdfGlyph | null;
	fontOf(font: string): [string, number];
	begin(W: number, H: number, dpr: number): void;
	push(x: number, y: number, m: Mat2, sp: SdfGlyph, k: number, fill: number, halo: number, hw: number, blur: number): void;
	end(): void;
	clearCanvas(): void;
	readPixels(): Promise<Uint8Array>;
	reset(): void;
	readonly count: number;
	readonly atlasSize: number;
	destroy(): void;
}
/** canvas＝描く先の webgpu canvas。null＝画面に出さずテクスチャに描く（検定） */
export function createGpuText(device: GPUDevice, canvas: OffscreenCanvas | HTMLCanvasElement | null, format?: GPUTextureFormat): GpuText;
/** 注記の字（線に沿う・点）を GPU へ回す受け口。attach(gt)＝GPU を据える・canvasOnly＝一時的に全部 Canvas2D（撮影） */
export interface GpuTextSink extends TextSink { attach(gt: GpuText | null): void; canvasOnly: boolean }
export function createGpuTextSink(base: TextSink): GpuTextSink;
