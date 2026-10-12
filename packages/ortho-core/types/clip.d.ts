// @ortho-earth/core/clip — 切断面（鉛直・水平・箱・生の平面・最大 6 枚）。
export const CLIP_MAX: 6;
export const CLIP_TARGETS: readonly ["terrain", "buildings", "models", "vector", "labels"];
export type ClipTarget = (typeof CLIP_TARGETS)[number];
/** 平面＝[nx, ny, nz, d]（β 空間）。 */
export type ClipPlane = number[];
export interface ClipBoxSpec { center: [number, number]; size?: [number, number]; h?: [number, number]; bearing?: number }
export interface ClipStyle { capTerrain: number[]; capBuilding: number[]; edgeColor: number[]; edgeWidth: number }
export function clipPlaneVertical(a: [number, number], b: [number, number]): ClipPlane;
export function clipPlaneHorizontal(at: [number, number], h?: number, keep?: "below" | "above"): ClipPlane;
export function clipBox(spec: ClipBoxSpec): ClipPlane[];
export function clipPlanes(spec: unknown): ClipPlane[];
export function normClip(data: unknown): Record<string, unknown> | null;
export function clipPlanesFor(norm: unknown, target: ClipTarget): ClipPlane[];
export function clipPackOrigin(planes: ClipPlane[], origin: number[]): ClipPlane[];
export function parseClipParam(q: string): unknown;
export const CLIP_STYLE: ClipStyle;
export function clipStyle(spec: unknown): ClipStyle;
export const CLIP_F32: number;
export function packClip(planes: ClipPlane[], originPt: number[], out?: Float32Array, style?: ClipStyle): Float32Array;
export function clipDistanceM(planes: ClipPlane[], lon: number, lat: number, hM?: number): number;
