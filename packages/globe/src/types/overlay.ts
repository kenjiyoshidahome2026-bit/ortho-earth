// 同一フレームのオーバーレイ（map.overlay）の契約の型（2026-10-16・renderworker.ts から移す）。render worker と、URL で読まれる
// オーバーレイの正本（*-gl.ts・*-2d.ts・*-draw.ts）が共に読む。型だけ＝実行時の import は生まない（URL のモジュールは依存ゼロ）。
import type { CameraPose, CameraState } from "@ortho-earth/core/camera";
import type { ClipPlane } from "@ortho-earth/core/clip";
import type { DepthApi } from "@ortho-earth/core/depthout";
import type { ClockAnchor } from "@ortho-earth/ephem/clock";
import type { makeCustomArgs } from "../gadgets/customgl-args.ts";

export type { CameraPose, CameraState, DepthApi };
/** canvas の寸法（device px） */
export interface OverlaySize { w: number; h: number }
/** オーバーレイの host（init の 3 つ目） */
/** customArgs＝MapLibre の custom 層の args（customgl-args.ts の makeCustomArgs・この worker の楕円体の設定で）＝?url のモジュールは import を持てない（vite がそのまま置く）ので host から渡す（customgl-draw） */
export interface OverlayHost { requestDraw(): void; post(data: unknown): void; depthGLSL: string; customArgs(cam: CameraPose, w: number, h: number, projection?: string): ReturnType<typeof makeCustomArgs> }
/** オーバーレイの frame の api（main の makeProjector と同じ規約） */
export interface OverlayApi {
	project(lon: number, lat: number): number[]; projectH(lon: number, lat: number, hM?: number): number[]; clipH(lon: number, lat: number, hM?: number): number[];
	dpr: number; W: number; H: number; time: number; clock: ClockAnchor | null; depth: DepthApi | null;
	elevM(lon: number, lat: number): number; liftScale: number; terrainOn: boolean; rAx: number;
	clip: { planes: ClipPlane[]; distM(lon: number, lat: number, hM?: number): number; pack(origin: ArrayLike<number>): Float32Array } | null;
}
/** 最後に描いたフレーム（統一 picking が同じ cam で当てる） */
export interface LastOverlayFrame { cam: CameraPose; s: CameraState; size: OverlaySize; api: OverlayApi }
/** 同一フレームのオーバーレイのモジュールの契約 */
export interface OverlayModule {
	init(canvas: OffscreenCanvas, opts: object, host: OverlayHost): unknown;
	message(data: unknown): void;
	frame(cam: CameraPose, s: CameraState, size: OverlaySize, api: OverlayApi): unknown;
	destroy(): void;
	pick?(x: number, y: number, r: number, ctx: LastOverlayFrame): unknown;
	placed?(): unknown[];
}
