// weather.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝weather.js が TS になれば消える。
import type { CloudsSpec, LightSpecification, SunSpec } from "../globe.d.ts";

/** setSun の spec を整えた物（follow "clock"｜固定の azimuth/altitude・minAltitude は常に在る） */
export type SunSpecNorm = SunSpec & { follow: "clock" | null; minAltitude: number };
export function normSun(s: SunSpec | true): SunSpecNorm;
/** 太陽の spec と高度・方位 → setLight の形 */
export function sunToLight(spec: SunSpecNorm, pos: { azimuth?: number; altitude?: number }): LightSpecification;
/** 雲の spec（null/false＝外す）→ 既定を補った物 */
export function normClouds(c: CloudsSpec | true | false | null | undefined): Required<CloudsSpec> | null;
