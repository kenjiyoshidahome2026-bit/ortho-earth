// @ortho-earth/core/elevation — 標高（altpbf の R90/R10/R01 タイル・全球アトラス・高さの引き当て）。worker は役割 "ortho:height"。
import type { WorkerFactory } from "./index.js";

/** altpbf の標高タイル（data＝row0 が北・m・Int16）。 */
export interface AltTile { name: string; source: string; lng: number; lat: number; range: number; width: number; height: number; data: Int16Array }
/** 画素の格子だけ（tiff2data の戻り・resampleTile／worldAtlasCell の入力）。 */
export interface AltGrid { width: number; height: number; data: ArrayLike<number> }
/** 地域の申告（焼き直し済みの裸地 DTM の銘 brand・段 range・域 bbox=[w,s,e,n]）＝staleDSM が読む。 */
export interface DtmSpec { brand: string; range: number; bbox: number[]; [k: string]: unknown }

export interface GetHeight {
	/** 標高 m（データが無ければ 0）。zoom で段を選ぶ（< level1＝R90・< level2＝R10・他＝R01）。o.wait＝他の読込中でも順番を待って値を返す（map.getHeight 用）。 */
	(lng: number, lat: number, zoom?: number, o?: { wait?: boolean }): Promise<number>;
	/** worker を止める（map.destroy）。 */
	terminate(): void;
}
export interface GetHeightOptions { dtm?: DtmSpec | null; apiUrl?: string; level1?: number; level2?: number; onstart?: (name: string) => void; onend?: (name: string) => void }
export function createGetHeight(opts?: GetHeightOptions): Promise<GetHeight>;
export interface TileLoader {
	/** (lng0, lat0) は range 刻みの南西隅。R01 は ALOS の無い所（海等）で null。 */
	(lng0: number, lat0: number, range: number): Promise<AltTile | null>;
	/** 名前直指定（WORLD_ATLAS 等・失効判定なし）。 */
	byName(name: string): Promise<AltTile | null>;
}
export function createTileLoader(opts?: { dtm?: DtmSpec | null; apiUrl?: string }): Promise<TileLoader>;
/** IDB のタイルが失効しているか（申告域の中で brand の銘が無い物）。 */
export function staleDSM(name: string, obj: { source?: string } | null | undefined, dtm: DtmSpec | null | undefined): boolean;
export function setApiUrl(url: string): void;
/** native-bucket の口（setApiUrl の後でないと投げる）。 */
export function getNB(): { Fetch(url: string, as?: string): Promise<unknown>; Bucket(dir: string, opts?: Record<string, unknown>): Promise<unknown>; [k: string]: unknown };
/** GeoTIFF（ストリップ型・Int16）→ 格子。タイル型・壊れは null。 */
export function tiff2data(file: Blob): Promise<{ width: number; height: number; data: Int16Array } | null>;
/** core の口と同じ（役割 "ortho:scene" / "ortho:tile" / "ortho:height"）。 */
export function setWorkerFactory(fn: WorkerFactory | null): void;

// ── altpbf の形式
/** タイル → deflate-raw の圧縮バイト列（bucket/IDB に置く物）。 */
export function encode(obj: AltTile): Promise<Uint8Array>;
/** 圧縮バイト列（Blob・arrayBuffer() を持つ物）→ タイル。 */
export function decode(v: Blob): Promise<AltTile>;
/** (lng, lat, range) → "R90N000E000"。range 無し＝"N035E139"（AW3D30 の索引の名）。 */
export function encodeName(lng: number, lat: number, range?: number): string;
/** "R90N000E000" → [lng, lat, range]。 */
export function decodeName(s: string): [number, number, number];

// ── 全球アトラス（R90 8 枚 → 4096×2048 の 1 枚）
export const WORLD_ATLAS: string;
/** 90° セルあたりの texel。 */
export const WORLD_ATLAS_CELL: number;
/** タイル 1 枚を N×N へ再標本化して out（幅 W・row0=北）の (ox, oy) へ置く。 */
export function resampleTile(tile: AltGrid, N: number, out: { [i: number]: number }, W: number, ox: number, oy: number): void;
export function bakeWorldAtlas(tiles: AltTile[], N?: number): AltTile;
/** アトラスから R90 セル (cx 0..3 西から・cy 0..1 南から) を N² の Float32（row0=南・負値は 0）で。out/W/ox/oy＝大きな Float32 の一部へ直接書く。 */
export function worldAtlasCell(atlas: AltGrid, cx: number, cy: number, N: number, out?: Float32Array, W?: number, ox?: number, oy?: number): Float32Array;
/** 経緯度でバイリニア標本（m・負値は 0）。 */
export function sampleWorldAtlas(atlas: AltGrid, lon: number, lat: number): number;
