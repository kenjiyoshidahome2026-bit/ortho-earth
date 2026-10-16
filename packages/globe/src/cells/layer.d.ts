// cells/layer.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝cells/layer.js が TS になれば消える。
import type { evalExpr } from "@ortho-earth/core";
import type { DataApi, GlobeMap } from "../types/map.ts";

type Opts<K extends keyof DataApi> = NonNullable<Parameters<DataApi[K]>[1]>;
export function createCellsLayer(map: GlobeMap, src: unknown, o?: Opts<"addCells"> & { evalExpr?: typeof evalExpr | null }): ReturnType<DataApi["addCells"]>;
export function createContourLayer(map: GlobeMap, src: unknown, o?: Opts<"addContour"> & { evalExpr?: typeof evalExpr | null }): ReturnType<DataApi["addContour"]>;
export function createScreenGrid(map: GlobeMap, src: unknown, o?: Opts<"addScreenGrid"> & { evalExpr?: typeof evalExpr | null; screengridUrl?: string }): Awaited<ReturnType<DataApi["addScreenGrid"]>>;
export function addAggregate(map: GlobeMap, src: unknown, o?: Opts<"addAggregate"> & { evalExpr?: typeof evalExpr | null }, urls?: { screengrid?: string }): ReturnType<DataApi["addAggregate"]>;
