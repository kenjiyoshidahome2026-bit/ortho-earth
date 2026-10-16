// sky-spec.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝sky-spec.js が TS になれば消える。
import type { SkySpecification } from "../globe.d.ts";

/** 入力（部分指定・不正値）→ 既定で補った sky（式はそのまま）。null/undefined → 既定 */
export function normSky(s: SkySpecification | null | undefined): Required<SkySpecification>;
/** sky の値に式（["zoom"] など）を含むか */
export function skyHasExpr(s: SkySpecification | null | undefined): boolean;
/** renderer の "sky" の中身（式は zoom で評価） */
export function skyPayload(s: SkySpecification | null | undefined, zoom?: number): Record<string, number | number[]>;
