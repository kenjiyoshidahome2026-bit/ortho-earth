// i3s-loaders.js（JS のまま）の型。i3s-decode.ts が dynamic import する分だけ（TS 化 段 4・batch 3）。
//   JS のまま置く理由は mesh-loaders.d.ts と同じ（@loaders.gl/* の型の木が Node の大域を globe の型検査へ持ち込む）。
import type { LoadersGlLoader } from "./mesh-loaders.js";
export const I3SLoader: LoadersGlLoader;
/** @loaders.gl/core の parse */
export function parse(data: ArrayBuffer | Uint8Array, loader: LoadersGlLoader, options?: Record<string, unknown>, context?: { url?: string }): Promise<unknown>;
