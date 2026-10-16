// worker の program（tsconfig.worker.json・lib webworker）だけが読む最小の宣言（TS 化 段 4・batch 3）。
// renderworker.ts は ortho-core の描画（gl/renderer・gl/gint/state・gl/gint/embed・labels2d）と gadgets/anno-draw・types/map.ts を引く＝
// それらの型は「HTMLCanvasElement | OffscreenCanvas」等の和で DOM の名を書く（main でも worker でも動く作り）。lib webworker にはその名が無い。
// worker で実際に渡るのは Offscreen の側だけ＝DOM の名は Offscreen の型の別名に置く（実行時の振る舞いは変わらない・型だけ）。
// window・DOMParser は ortho-core/types/worker-env.d.ts と同じ（native-bucket の src＝typeof で避けている・xml/html の読み口だけ）。
declare var window: EventTarget | undefined;
declare var DOMParser: { new (): { parseFromString(text: string, type: string): unknown } };
type HTMLCanvasElement = OffscreenCanvas;
type CanvasRenderingContext2D = OffscreenCanvasRenderingContext2D;
type HTMLImageElement = ImageBitmap;
interface HTMLElement extends EventTarget {}
interface WebGL2RenderingContext { readonly canvas: OffscreenCanvas }
