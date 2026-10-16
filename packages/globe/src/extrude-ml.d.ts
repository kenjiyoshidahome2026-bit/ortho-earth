// extrude-ml.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝extrude-ml.js が TS になれば消える。
import type { ExtEnv } from "./types/install.ts";

/** 押し出しの立体の当たり（屋根と壁）。polys＝面の列（環の列・[lon, lat] の列）・q＝点 { pt } か箱 { box: [x0, y0, x1, y1] }（CSS px）。
 *  戻り＝当たった所の奥行き w（小さいほど手前）か null */
export function hitExtrusion(polys: number[][][][], bottom: number, top: number, q: { pt?: number[]; box?: number[] }, env: ExtEnv): number | null;
