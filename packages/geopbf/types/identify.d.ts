// "geopbf/identify"＝描画レス識別の素関数と格子索引（§4）
import type { GeoPBF, IdentifyAtOptions, IdentifyOptions, Projection } from "./geopbf.js";
export function identifyAt(pbf: GeoPBF, lng: number, lat: number, options?: IdentifyAtOptions): number | null;
export function contain(pbf: GeoPBF, lng: number, lat: number): number | null;
export function identify(pbf: GeoPBF, mx: number, my: number, proj: Projection, options?: IdentifyOptions): number | null;
/** 点（gint 格子単位）を含む最小のポリゴンの fid。viewBbox＝視野の bbox（null＝無視）・accept＝候補の絞り */
export function findPolygon(arcBuffer: BigUint64Array, arcMeta: Uint32Array, polyStream: Int32Array, mix: number, miy: number, polyBboxByFid?: Map<number, number[]> | null, viewBbox?: number[] | null, accept?: ((fid: number) => boolean) | null): number | null;
/** 線・面の当たり判定の格子索引（stream ごとに 1 つ・WeakMap で控える） */
export interface HitGrid { G: number; x0: number; y0: number; cw: number; ch: number; cellOff: Uint32Array; cellFid: Int32Array; big: Int32Array; n: number; cells: number; offOf(fid: number): number; bboxOf(fid: number): number[]; [key: string]: any }
export function buildHitGrid(stream: Int32Array, arcMeta: Uint32Array): HitGrid;
export function hitGridOf(stream: Int32Array, arcMeta: Uint32Array): HitGrid;
/** 検定用＝false で旧の全走査 */
export const hitGridMode: { on: boolean };
