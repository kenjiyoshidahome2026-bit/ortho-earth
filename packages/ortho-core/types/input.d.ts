// @ortho-earth/core — 入力（versor パン・anchoredAt ズーム・2 本指の語彙・キーボード）。
import type { CameraPose } from "./camera.js";
export const isTypingTarget: (el?: Element | null) => boolean;
export interface InputController {
	/** 事象 → canvas ローカルの CSS px。 */
	evXY(e: { clientX: number; clientY: number }): [number, number];
	/** カーソル下の地点を固定したまま fn で cam を変える。 */
	anchoredAt(x: number, y: number, fn: () => void): void;
	setMaxPitch(v: number): void;
	setZoomMin(v: number): void;
}
export function createInput(opts: {
	canvas: HTMLCanvasElement;
	cam: CameraPose;
	size: { w: number; h: number };
	dpr: number;
	maxPitch: number;
	zoomMin?: number;
	zoomMax?: number;
	onMove: () => void;
	onGesture?: () => void;
	onClick?: (x: number, y: number, e?: PointerEvent) => void;
	onHover?: (x: number, y: number, e?: PointerEvent) => void;
	blocked?: () => boolean;
	signal?: AbortSignal;
	wheelZoom?: "linear" | "maplibre";
}): InputController;
