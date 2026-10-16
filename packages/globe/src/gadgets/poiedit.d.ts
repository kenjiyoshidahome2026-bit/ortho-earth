// gadgets/poiedit.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝poiedit.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";
import type { LonLat } from "../../globe.d.ts";

/** POI 台帳の手差分編集（?poiedit=1・作者用）。デスクトップのみ・二重搭載は undefined */
export function poiedit(this: GlobeMap, opts?: {
	getPOI?: () => unknown; getOvr?: unknown; setOvr?: unknown; setClick?: (fn: ((x: number, y: number) => boolean) | null) => void;
	unprojectXY?: (x: number, y: number) => LonLat | null; makeProjector?: () => (lon: number, lat: number) => [number, number, number];
	distM?: unknown; apiBase?: unknown; name?: unknown; signal?: AbortSignal; [k: string]: unknown;
}): { close(): void } | undefined;
