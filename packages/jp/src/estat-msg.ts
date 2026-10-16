// e-Stat 小地域の main⇄worker の便りの形（estat.ts と estat-worker.ts が共に読む・型だけ＝実行時は空のモジュール）。
// worker の入口（estat-worker.ts）は別の tsc（tsconfig.worker.json・lib webworker）で検査する＝main 側と型を分け合うのはこのファイル経由だけ。
import type { GeoJSONOverlay } from "@ortho-earth/core/geojson";

/** buildGeoJSONOverlay（core/geojson）の返り＝2.0 は src/geojson.ts の型そのもの（Float32Array<ArrayBuffer>＝.buffer を transfer できる） */
export type OverlayBuffers = GeoJSONOverlay;
/** main → worker */
export type EstatRequest =
	| { type: "load"; codes: (string | number)[]; year?: string; style?: Record<string, unknown> | null; interiorOnly?: boolean }
	| { type: "hovertip"; lon: number; lat: number }
	| { type: "identify"; lon: number; lat: number }
	| { type: "highlight"; key: string };
/** worker → main */
export type EstatResponse =
	| { type: "loaded"; ok: false }
	| { type: "loaded"; ok: true; count: number; center: number[]; bbox: number[]; overlay: OverlayBuffers }
	| { type: "hovertip"; name: string | null; overlay?: OverlayBuffers }
	| { type: "identify"; hit: number; props?: Record<string, unknown>; overlay?: OverlayBuffers }
	| { type: "highlighted"; key: string; bbox: number[] | null; count: number; overlay?: OverlayBuffers };
