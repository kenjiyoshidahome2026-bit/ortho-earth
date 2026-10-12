// @ortho-earth/core/expr — MapLibre 形の式の評価器（出自 "ml"＝MapLibre の意味・"native"＝寛容）。

export type Expression = unknown[] | string | number | boolean | null | Record<string, unknown>;

export interface ExprContext {
	/** 評価する z（公開の目盛りは呼び手が揃える）。 */
	zoom?: number;
	/** 地物の属性。 */
	props?: Record<string, unknown>;
	/** "Point" | "LineString" | "Polygon" … */
	geom?: string;
	/** 地物の id（["id"]）。 */
	id?: string | number | null;
	/** feature-state（["feature-state", k]）。 */
	state?: Record<string, unknown> | null;
	/** line-progress・heatmap-density・accumulated・elevation の値。 */
	vars?: Record<string, unknown>;
	/** "ml"＝MapLibre の意味（型違いは undefined）・既定 "native"。 */
	origin?: "ml" | "native";
}

export interface FormatSection {
	t: string;
	fs: number | null;
	col: unknown | null;
	fnt: string[] | null;
	img: string | null;
}

export function evalExpr<T = unknown>(e: Expression, ctx: ExprContext): T;
export function truthy(v: unknown): boolean;
/** ["format", …] の区間（text-field の根が format の時だけ）。それ以外は null。 */
export function formatSections(e: Expression, ctx: ExprContext): FormatSection[] | null;
export const ORIGIN_KEY: "ortho:origin";
export function originOfLayer(L: { metadata?: Record<string, unknown> } | null | undefined): "ml" | undefined;
export const originOfCtx: (ctx: ExprContext | null | undefined) => "ml" | "native";
/** 評価器が知っている演算子。 */
export const KNOWN_OPS: Set<string>;
/** 式の中の知らない演算子を集める（式の位置だけを見る）。 */
export function unknownOps(e: Expression, out?: Set<string>): Set<string>;
export function setGlobalState(obj: Record<string, unknown> | null | undefined): void;
export function getGlobalState(): Record<string, unknown>;
export function usesGlobalState(x: unknown): boolean;
