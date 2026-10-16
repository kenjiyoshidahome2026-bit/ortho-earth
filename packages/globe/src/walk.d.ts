// walk.js（JS のまま）の型。src/api/terrain.ts が読む分だけ（TS 化 段 4・batch 1）＝walk.js が TS になれば消える。
import type { WalkOptions } from "../globe.d.ts";
import type { GlobeMap } from "./types/map.ts";

/** builtin の歩行の中身（map.walk の手綱が包む） */
export interface WalkInner {
	start(): void; stop(): void; readonly active: boolean;
	step(forwardM: number, strafeM?: number): number; turn(deg: number): void; look(deg: number): void;
	position(): { lng: number; lat: number; ground: number; eyeHeight: number; bearing: number; lookDown: number };
}
export function createWalk(map: GlobeMap, opts: WalkOptions, deps: { heightAt(lng: number, lat: number): Promise<number> | number; wallHeightAt?(lng: number, lat: number): number; radiusM?: number }): WalkInner;
/** 点が多角形（GeoJSON の Polygon／MultiPolygon・[lng, lat]）の中か（偶奇・穴も見る）。それ以外の geometry は false */
export function pointInPolygon(lng: number, lat: number, geom: { type: string; coordinates?: unknown } | null | undefined): boolean;
