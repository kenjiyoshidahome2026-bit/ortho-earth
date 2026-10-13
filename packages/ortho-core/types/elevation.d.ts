// @ortho-earth/core/elevation — 標高（全球アトラス・R90 タイル・altpbf）。
export function createGetHeight(opts?: Record<string, unknown>): (lon: number, lat: number) => Promise<number | null>;
export function createTileLoader(opts?: Record<string, unknown>): unknown;
export function staleDSM(...args: unknown[]): unknown;
export function setApiUrl(url: string): void;
export function getNB(...args: unknown[]): unknown;
export function tiff2data(...args: unknown[]): unknown;
export function setWorkerFactory(fn: ((role: string, fallback: () => Worker) => Worker) | null): void;
export function encode(...args: unknown[]): unknown;
export function decode(...args: unknown[]): unknown;
export function encodeName(...args: unknown[]): string;
export function decodeName(...args: unknown[]): unknown;
export const WORLD_ATLAS: Record<string, unknown>;
export const WORLD_ATLAS_CELL: number;
export function resampleTile(...args: unknown[]): unknown;
export function bakeWorldAtlas(...args: unknown[]): unknown;
export function worldAtlasCell(lon: number, lat: number): unknown;
export function sampleWorldAtlas(...args: unknown[]): number;
