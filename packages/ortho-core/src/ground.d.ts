// ground.js（JS のまま＝gl 側の段で TS 化）の型。gpu/renderer.ts が読むための橋（TS 化 段 4・WebGPU 側）。
// ground.js が ground.ts になったら、この橋を消して gpu/renderer.ts の import を "../ground.ts" に向ける。
import type { CameraPose } from "./camera.ts";
/** 地面アトラスの窓（細かい順・各 [w, s, e, n] の経緯度）。 */
export function groundWindows(cam: CameraPose, W: number, H: number): number[][];
export const windowsKey: (wins: number[][]) => string;
