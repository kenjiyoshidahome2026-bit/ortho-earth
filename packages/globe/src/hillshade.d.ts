// hillshade.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝hillshade.js が TS になれば消える。
import type { DemSource } from "@ortho-earth/core";

/** raster-dem → 陰影の画像タイル（port＝render worker の画像タイルの提供口） */
export interface HillshadeProvider { port: MessagePort; stats: Record<string, unknown>; setPaint(paint: Record<string, unknown> | undefined): void; close(): void }
export function createHillshadeProvider(o: { dem: DemSource | Record<string, unknown>; paint?: Record<string, unknown>; fetchFn?: (u: string, init?: RequestInit) => Promise<Response>; name?: string; attribution?: string | null; warn?: ((m: string) => void) | null; tiles?: unknown }): HillshadeProvider;
