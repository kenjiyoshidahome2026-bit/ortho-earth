// gadgets/videoquad.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝videoquad.js が TS になれば消える。
import type { CanvasHandle, LonLat, OverlayHandle, VideoHandle } from "../../globe.d.ts";

type Corners = [LonLat, LonLat, LonLat, LonLat];
/** 四隅の動画・canvas の束（map.raster.add の { video }／{ canvas }・addSource の video／canvas の source） */
export interface VideoQuads {
	add(id: string, o: { video?: HTMLVideoElement | null; urls?: string | string[] | null; canvas?: HTMLCanvasElement | OffscreenCanvas | string; corners?: Corners; opacity?: number; animate?: boolean }): VideoHandle | CanvasHandle;
	remove(id: string): boolean;
	setOpacity(id: string, opacity: number): boolean;
	get(id: string): VideoHandle | CanvasHandle | undefined;
	clear(): void;
}
export function createVideoQuads(o: { overlay: () => OverlayHandle; maxSide?: number }): VideoQuads;
