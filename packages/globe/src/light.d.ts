// light.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝light.js が TS になれば消える。
import type { LightSpec, LightSpecification } from "../globe.d.ts";

/** builtin の光源の type（directional・point・spot・ambient・hemisphere・ibl） */
export const LIGHT_TYPES: readonly string[];
/** 入力（部分指定・不正値）→ 既定で補った light（新しい object）。null/undefined → 既定 */
export function normLight(l: LightSpecification | LightSpec | null | undefined): Required<LightSpecification>;
/** 光源の配列（1 つでも）→ 正規化（directional は 1 つまで・知らない type は known が true の時だけ残す） */
export function normLights(list: LightSpec[] | LightSpec | null | undefined, known?: (type: string) => boolean): LightSpec[];
/** 局所の光源（point/spot/ambient/hemisphere）→ renderer の "lights" の中身 */
export function localLightsPayload(lights: LightSpec[], radiusM?: number): unknown;
