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
	/** handler の on/off（A2）。 */
	setHandler(name: HandlerName, on: boolean): void;
	handlerOn(name: HandlerName): boolean;
	/** 慣性・ズームの滑りを止める。 */
	stop(): void;
	setZoomSnap(v: number): void;
	zoomSnap(): number;
}
export type HandlerName = "scrollZoom" | "dragPan" | "dragRotate" | "keyboard" | "doubleClickZoom" | "boxZoom" | "touchZoomRotate" | "touchRotate" | "touchPitch" | "cooperativeGestures";
export const HANDLER_NAMES: readonly HandlerName[];
export interface InertiaOptions { linearity: number; maxSpeed: number; deceleration: number; ease: [number, number, number, number] }
/** MapLibre の慣性の定数（pan＝px・rotate/pitch＝度）。 */
export const INERTIA: { pan: InertiaOptions; rotate: InertiaOptions; pitch: InertiaOptions };
export const INERTIA_WINDOW_MS: number;
export function bezierEase(x1: number, y1: number, x2: number, y2: number): (x: number) => number;
export function inertiaOf(records: { t: number; v: number }[], now: number, o?: InertiaOptions): { dur: number; amount: number; ease: (x: number) => number } | null;
export function inertiaOf2(records: { t: number; vx: number; vy: number }[], now: number, o?: InertiaOptions): { dur: number; ax: number; ay: number; ease: (x: number) => number } | null;
export function snapZoom(z: number, snap: number): number;
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
	/** handler ごとの初期 on/off（A2）。 */
	handlers?: Partial<Record<HandlerName, boolean>>;
	/** false＝全部 off。 */
	interactive?: boolean;
	cooperativeGestures?: boolean;
	zoomSnap?: number;
	/** ボックスズーム（shift＋ドラッグ）。end の bbox＝[w,s,e,n]（west>east＝±180 跨ぎ）。 */
	onBoxZoom?: (phase: "start" | "end" | "cancel", d: { bbox?: [number, number, number, number]; x0?: number; y0?: number; x1?: number; y1?: number }) => void;
	/** 協調モードで止めた操作。 */
	onBlocked?: (kind: "wheel" | "touch") => void;
}): InputController;
