// @ortho-earth/core/textgpu — 注記の字（線に沿う・点）と記号・標識を WebGPU で塗る（テキスト GPU 化 T-P1〜T-P3・render worker 内で使う）。
// 源（src/gpu/text.ts）は WebGPU の定数（GPUTextureUsage 等）を使う＝それを宣言しない program（globe）からはこの宣言で読む（gpu.d.ts と同じ手）。
import type { Mat2 } from "../src/labels2d.ts";
import type { TextSink } from "../src/textsink.ts";

/** 版の中の字 1 つ（版の px）。ox, oy＝字の錨（中央・middle）から箱の左上（基準の大きさの px） */
export interface SdfGlyph { x: number; y: number; w: number; h: number; ox: number; oy: number }
/** 記号の版の中の絵 1 つ（版の px）。k＝版の px／元の絵の px */
export interface GpuIcon { x: number; y: number; w: number; h: number; k: number }
export interface GpuText {
	glyph(font: string, ch: string): SdfGlyph | null | undefined;
	/** 1 フレームに字を焼く時間の予算（ms・0＝無制限）。超えた字は undefined＝次のフレームで焼く */
	setBudget(ms: number): void;
	/** このフレームで予算切れの字があった（＝もう 1 フレーム描く） */
	pending(): boolean;
	/** この起動で焼いた字と保存（glyphstore）から写した字の数 */
	bakeStats(): { baked: number; restored: number };
	fontOf(font: string): [string, number];
	begin(W: number, H: number, dpr: number): void;
	/** 次の push の行き先：null＝最前面の canvas・数＝地図のパスの中の層の添字 li の位置（T-P2） */
	target(li: number | null): void;
	push(x: number, y: number, m: Mat2, sp: SdfGlyph, k: number, fill: number, halo: number, hw: number, blur: number): void;
	/** 記号の絵を版から引く（無ければ載せる）・null＝載せられない */
	icon(src: CanvasImageSource): GpuIcon | null;
	/** 記号 1 つ（の区間）。(rx,ry,rw,rh)＝錨から見た箱（CSS px）・(u0,v0,u1,v1)＝記号の版の px */
	pushIcon(x: number, y: number, m: Mat2, rx: number, ry: number, rw: number, rh: number, u0: number, v0: number, u1: number, v1: number, o: number): void;
	end(): void;
	clearCanvas(): void;
	readPixels(): Promise<Uint8Array>;
	reset(): void;
	readonly count: number;
	readonly atlasSize: number;
	/** 地図のパスの中に描く字のある層の添字（昇順）＝直近の end() の分 */
	midAnchors(): readonly number[];
	/** 地図のパスの中で li が [lo, hi) の層の字を描く */
	drawMid(pass: GPURenderPassEncoder, lo: number, hi: number, at: MidTarget): number;
	destroy(): void;
}
/** 地図の描画パスの的（drawMid） */
export interface MidTarget { format: GPUTextureFormat; samples: number; depth: GPUTextureFormat | null; W: number; H: number; dpr: number }
/** canvas＝描く先の webgpu canvas。null＝画面に出さずテクスチャに描く（検定） */
import type { GlyphStore } from "../src/gpu/glyphstore.ts";
/** store＝焼いた字の保存（glyphstore）＝有れば焼かずに写す */
export function createGpuText(device: GPUDevice, canvas: OffscreenCanvas | HTMLCanvasElement | null, format?: GPUTextureFormat, store?: GlyphStore | null): GpuText;
/** 注記の字（線に沿う・点）を GPU へ回す受け口。attach(gt)＝GPU を据える・canvasOnly＝一時的に全部 Canvas2D（撮影） */
export interface GpuTextSink extends TextSink { attach(gt: GpuText | null): void; canvasOnly: boolean; /** 地図のパスの中へ回す層（T-P2）・null＝全部最前面 */ mid: ((li: number) => boolean) | null; /** 字を焼く予算（ms/フレーム・0＝無制限＝従来） */ setGlyphBudget(ms: number): void; /** この起動で焼いた字・保存から写した字（HUD） */ bakeStats(): { baked: number; restored: number } }
export function createGpuTextSink(base: TextSink): GpuTextSink;
