// gadgets/offline.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝offline.js が TS になれば消える。
import type { GlobeMap } from "../types/map.ts";
import type { Gadgets } from "../../globe.d.ts";
import type { Bbox } from "../../globe.d.ts";

/** オフラインパックの読み口（globe が地域の申告から組む＝gadget は地域を知らない） */
export interface OfflineSources {
	basemap: { tileUrl: (z: number, x: number, y: number) => string | null | undefined; coverage: unknown; minZ: number } | null;
	dem: { byName(name: string): Promise<unknown> } | null;
	rasters: { list(): Array<{ id: string; url: string | undefined; minZoom: number; maxZoom: number; subdomains: string[] | string | null; tms: boolean }> };
	mesh: { warm(): unknown; sets(): unknown[]; prefetch(names: string[], onProg?: (p: unknown) => void): Promise<unknown> } | null;
}
export function offline(this: GlobeMap, opts?: { sources?: OfflineSources; bounds?: () => Bbox | null; onOpen?: () => void; signal?: AbortSignal; zmaxDefault?: number; [k: string]: unknown }): ReturnType<Gadgets["offline"]>;
