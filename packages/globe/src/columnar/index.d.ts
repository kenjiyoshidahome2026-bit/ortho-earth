// columnar/index.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝columnar が TS になれば消える。
import type { GeoPBF } from "geopbf";
import type { ColumnarLayerHandle, ColumnarLayerOptions, GeoPBF as PublicGeoPBF } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

/** 列チャンク層を開く（probe が断れば null） */
export function createColumnarView(map: GlobeMap, src: string | File | Blob | ArrayBuffer | GeoPBF | PublicGeoPBF, opts?: ColumnarLayerOptions & {
	signal?: AbortSignal; t?: (key: string, ...args: Array<string | number>) => string; workerFactory?: (role: string) => Worker; rAx?: number; [k: string]: unknown;
}): Promise<ColumnarLayerHandle | null>;
