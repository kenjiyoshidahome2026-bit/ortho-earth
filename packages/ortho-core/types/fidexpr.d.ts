// @ortho-earth/core/fidexpr — gint の paint/filter 式を WGSL へ（WebGPU・opt-in gpuExpr）。属性列（attrcols）を組む道具も同じ口。
/** 層ごとの文字列辞書（id 0 は ""）。 */
export class Dict { list: string[]; map: Map<string, number>; intern(s: string): number; readonly size: number }
/** 列の統計（型の混在を compile 時に知る）。 */
export interface ColumnKinds { undef: boolean; nul: boolean; num: boolean; bool: boolean; str: boolean; numStr: boolean; other: boolean }
/** 式が読む鍵。dyn＝鍵が式（列にできない）。 */
export interface ExprKeys { props: Set<string>; states: Set<string>; geom: boolean; zoom: boolean; dyn: boolean }
export function paintKeys(paint: Record<string, unknown> | null | undefined, filter?: unknown): ExprKeys;
export interface FeatureLike { properties?: Record<string, unknown> | null; geometry?: { type?: string } | null; [k: string]: unknown }
/** 属性列（鍵 keys の順・列優先・1 セル＝[型, 中身] の u32×2）。 */
export function buildPropColumns(features: FeatureLike[], keys: string[], dict: Dict): { data: Uint32Array; kinds: Map<string, ColumnKinds>; count: number };
/** feature-state 列（states＝Map<fid, state>）。 */
export function buildStateColumns(states: Map<number, Record<string, unknown>> | null | undefined, keys: string[], count: number, dict: Dict): Uint32Array;
/** geometry-type 列（辞書 id・1 fid 1 u32）。 */
export function buildGeomColumn(features: FeatureLike[], dict: Dict): Uint32Array;
/** 1 fid の state → 鍵ごとの [型, 中身]。 */
export function encodeStateRow(st: Record<string, unknown> | null | undefined, keys: string[], dict: Dict): [number, number][];
/** 辞書の表（dnum＝Number(s) の f32 ビットと NaN 旗・dcol＝parseRGBA(s)）。 */
export function dictTables(dict: Dict): { dnum: Uint32Array; dcol: Float32Array };
export interface FidStyleWGSL { wgsl: string; slots: number; propKeys: string[]; stateKeys: string[]; usesZoom: boolean; usesState: boolean; filterUsesState: boolean; filterUsesZoom: boolean; usesGeom: boolean }
/** 載せられない式は { error }（呼び手は CPU の buildFidStyle へ）。 */
export function compileFidStyleWGSL(paint?: Record<string, unknown>, filter?: unknown, opts?: { propKeys?: string[]; stateKeys?: string[]; kinds?: Map<string, ColumnKinds>; dict?: Dict; origin?: "ml" | "native" }): FidStyleWGSL | { error: string };
