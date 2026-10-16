// gadgets/profile-stub.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝profile-stub.js が TS になれば消える。
import type { LonLat, PathGadgetStub } from "../../globe.d.ts";
import type { ToolBody } from "../types/scope.ts";
import type { GlobeMap } from "../types/map.ts";

/** 断面図の入口（本体 profile.js は初回に import）。戻り値＝no-op の関数＋open（本体の手綱で解ける）／close */
export function profile(this: GlobeMap, opts?: {
	makeProjector?: () => (lon: number, lat: number) => [number, number, number]; unprojectXY?: (x: number, y: number) => [number, number] | null; signal?: AbortSignal;
	setClick?: (fn: ((x: number, y: number) => unknown) | null) => void; sampleHeight?: (lon: number, lat: number) => Promise<number>; onBody?: (body: ToolBody) => void;
	canCut?: () => boolean; cut?: (a: LonLat | null, b: LonLat, flip?: boolean) => unknown;   // a＝null は外す（b は見ない） [k: string]: unknown;
}): PathGadgetStub;
