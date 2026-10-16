// src/extension/dissolve.js（JS のまま）の型＝.ts の読み手（decoder/json・ndjson・shape）向け sibling 宣言（TS 化 段 3・2026-10）。dissolve.js を .ts にした時は消す
import type { GeoPBFBase } from "../../types/geopbf.js";
/** 同じ属性（key＝その鍵だけ・true＝全部同じ・false＝全属性）の地物を併合して同じインスタンスを返す */
export function dissolve<T extends GeoPBFBase>(pbfInstance: T, key?: string | boolean): Promise<T>;
