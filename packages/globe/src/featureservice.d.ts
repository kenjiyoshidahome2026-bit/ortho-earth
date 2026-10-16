// featureservice.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝featureservice.js が TS になれば消える。
import type { Feature, FeatureCollection } from "geopbf";
import type { FeatureService, openFeatureService } from "geopbf/featureservice";
import type { GlobeMap } from "./types/map.ts";

export { parseServiceUrl } from "geopbf/featureservice";
/** 丸ごと読む件数の上限（これを超えたら視野追従） */
export const WHOLE_MAX: number;
export function openService(url: string, o?: NonNullable<Parameters<typeof openFeatureService>[1]>): Promise<FeatureService>;
export function cellsFor(b: number[], z: number): unknown[];
/** 視野追従の枡の控え（IDB） */
export interface CellCache { get(key: string): Promise<Feature[] | null>; put(key: string, fc: FeatureCollection): Promise<unknown> }
/** 視野追従の手綱 */
export interface ViewFollow { ready: Promise<unknown>; update(): unknown; stats(): Record<string, number>; destroy(): void }
export function followView(svc: FeatureService, o: {
	map: GlobeMap; onData: (fc: FeatureCollection) => unknown; onStatus?: (s: string) => unknown; cache?: CellCache | null;
	maxFeatures?: number; maxInflight?: number; maxCells?: number; minZ?: number; maxZ?: number;
}): ViewFollow;
