// src/pbf.js（JS のまま・器＋拡張メソッドの GeoPBF）の型＝.ts の読み手（encoder/fgb・shape・preview・profile・topojson）向け sibling 宣言（TS 化 段 3・2026-10）。
// 公開面は types/geopbf.d.ts の GeoPBF（正典）＋ pbf-base.d.ts の内部の欄。pbf.js を .ts にした時はこのファイルを消す。
import type { GeoPBF as GeoPBFFull, GeoPBFOptions } from "../types/geopbf.js";
import type { GeoPBFInternals } from "./pbf-base.js";

export interface GeoPBF extends GeoPBFFull, GeoPBFInternals {}
export const GeoPBF: { new (options?: GeoPBFOptions): GeoPBF } & typeof GeoPBFFull;
