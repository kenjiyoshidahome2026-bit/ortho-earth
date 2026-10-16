// colorrelief.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝colorrelief.js が TS になれば消える。
import type { DemSource } from "@ortho-earth/core";

/** raster-dem → 標高の段彩の画像タイル */
export interface ColorReliefProvider { port: MessagePort; stats: Record<string, unknown>; close(): void }
export function createColorReliefProvider(o: { dem: DemSource | Record<string, unknown>; color: unknown; fetchFn?: (u: string, init?: RequestInit) => Promise<Response>; name?: string; attribution?: string | null; tiles?: unknown; gs?: Record<string, unknown> }): ColorReliefProvider;
