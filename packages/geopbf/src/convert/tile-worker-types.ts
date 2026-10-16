// convert/tile-worker-types.ts ── tile-worker と pool が交わすメッセージの形（型だけ・両方の realm から import type する）。
import type { AssembleStatic, AssembleJob } from "./assemble.ts";
import type { TileItem } from "./pmtiles.ts";

export interface TileWorkerInit { type: "init"; S: AssembleStatic; id?: number }
export interface TileWorkerJob { type: "job"; J: AssembleJob; gzip: boolean; id?: number }
export type TileWorkerRequest = TileWorkerInit | TileWorkerJob;

export interface TileWorkerReady { type: "ready"; id?: undefined; error?: undefined }
export interface TileWorkerResult { id: number | undefined; tiles: TileItem[]; contents: [string, Uint8Array][]; error?: undefined }
export interface TileWorkerError { id: number | undefined; error: string }
export type TileWorkerResponse = TileWorkerReady | TileWorkerResult | TileWorkerError;
