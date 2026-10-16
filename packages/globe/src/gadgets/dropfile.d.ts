// gadgets/dropfile.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝dropfile.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";
import type { LonLat } from "../../globe.d.ts";

export function gunzipText(bytes: BufferSource | Blob): Promise<string>;
/** 台本（シーン）のファイルか（中身を覗く） */
export function sniffScene(file: File): Promise<unknown>;
/** GIS ファイルの D&D 取り込み（loadFile＝取り込みの一本道・clearGint＝全部消す・yieldTo＝編集がドロップを持つ間は譲る） */
export function dropFile(this: GlobeMap, opts?: {
	yieldTo?: () => boolean; loadFile?: (file: File, ctx?: object) => Promise<unknown>; clearGint?: () => void; playScene?: (...a: never[]) => unknown; busy?: () => boolean;
	signal?: AbortSignal; onLoad?: (...a: unknown[]) => unknown; unprojectAt?: (clientX: number, clientY: number) => LonLat | null; [k: string]: unknown;
}): unknown;
