// adddata.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝adddata.js が TS になれば消える。
import type { GeoJSONFeatureCollection } from "../globe.d.ts";

type F32 = Float32Array<ArrayBuffer>;
/** 点 → points-gl へ送る焼き（RTE の原点からの相対） */
export interface BakedPoints { n: number; pos: F32; rgba: Uint8Array | null; size: Float32Array | null; f: Float32Array | null; origin: number[]; lngLat: Float64Array }
/** 弧 → arcs-gl */
export interface BakedArcs { n: number; src: F32; dst: F32; theta: unknown; rgba: unknown; rgba2: unknown; width: unknown; height: unknown; f: unknown; origin: number[] }
/** 軌跡 → trips-gl */
export interface BakedTrips {
	n: number; nv: number; ni: number; pos: F32; oth: F32; side: unknown; time: unknown; id: unknown; index: Uint32Array<ArrayBuffer>; rgba: unknown; width: unknown; f: unknown; origin: number[];
	tMin: number; tMax: number; trips: Array<{ i: number; lngLat: unknown; t0: number; t1: number }>;
}
export function accessor<T>(a: unknown, dflt?: T): (d: unknown, i: number) => unknown;
export function originOf(xyz: Float64Array, n: number): number[];
export function bakePoints(data: unknown, props?: Record<string, unknown>): BakedPoints;
export function bakeArcs(data: unknown, props?: Record<string, unknown>): BakedArcs;
export function bakeTrips(data: unknown, props?: Record<string, unknown>): BakedTrips;
/** 多角形のマスク（画素の表） */
export function rasterMask(polygon: unknown, o?: { w?: number; h?: number; pad?: number }): { bbox: number[]; w: number; h: number; data: Uint8Array<ArrayBuffer> } | null;
export function columnRing(lon: number, lat: number, radiusM: number, k?: number, R?: number): number[][];
/** polygons／paths／columns → GeoJSON（addSource／addLayer の既存の層経路） */
export function toGeoJSON(data: unknown, kind: string, props?: Record<string, unknown>): GeoJSONFeatureCollection;
