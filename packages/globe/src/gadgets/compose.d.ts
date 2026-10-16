// gadgets/compose.js（JS のまま・gadget の群 B）の型。群 C（shot・print）が読む分だけ（TS 化 段 4・batch 2）＝compose.js が TS になれば消える。

/** 同じフレームの重ね（生ピクセル RGBA・flip＝GL の上下反転を戻す） */
export interface SnapLayer { buf: ArrayBuffer; w: number; h: number; flip?: boolean }
/** 撮影の写し（requestSnapshot の戻り）＝W×H（device px）・render＝基図（GL／WebGPU）・ラベル（2D）・重ね */
export interface Snapshot {
	W: number; H: number;
	render?: {
		base?: ArrayBuffer | null; w: number; h: number; flip?: boolean;
		labels?: ArrayBuffer | null; lw: number; lh: number;
		overlays?: SnapLayer[]; overlaysAbove?: SnapLayer[];
	} | null;
	[k: string]: unknown;
}
/** 写しの各層（＋計測の 2D canvas）を 1 枚の canvas へ重ねる */
export function composeLayersToCanvas(snap: Snapshot, measureCanvas?: HTMLCanvasElement | null): OffscreenCanvas;
