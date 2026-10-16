// gadgets/measure-stub.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 2）＝measure-stub.js が TS になれば消える。
import type { PathGadgetStub } from "../../globe.d.ts";
import type { ToolBody } from "../types/scope.ts";
import type { GlobeMap } from "../types/map.ts";

/** 計測の入口（本体 measure.js は初回に import）。戻り値＝no-op の関数＋open（本体の手綱で解ける）／close */
export function measure(this: GlobeMap, opts?: {
	makeProjector?: () => (lon: number, lat: number) => [number, number, number]; unprojectXY?: (x: number, y: number) => [number, number] | null; signal?: AbortSignal;
	setClick?: (fn: ((x: number, y: number) => unknown) | null) => void; requestDraw?: () => void; onBody?: (body: ToolBody) => void; [k: string]: unknown;
}): PathGadgetStub;
