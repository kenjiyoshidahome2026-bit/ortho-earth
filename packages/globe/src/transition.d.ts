// transition.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝transition.js が TS になれば消える。

/** 遷移の長さ（ms） */
export interface TransitionSpec { duration: number; delay: number }
export const EASE: (t: number) => number;
/** 層の `<name>-transition` → style の根の `transition` → 既定 */
export function transitionOf(layer: { paint?: Record<string, unknown> } | null | undefined, name: string, styleTransition?: unknown): TransitionSpec;
/** 性質が無指定だった時の「前の値」（spec の既定） */
export const PAINT_DEFAULTS: Readonly<Record<string, unknown>>;
/** 補間できる組か */
export function interpolable(a: unknown, b: unknown): "number" | "color" | "array" | null;
export function mix(kind: string | null, a: unknown, b: unknown, t: number): unknown;
/** 走者（apply＝補間値ごとに呼ぶ・false で消える） */
export interface Transitions {
	start(key: string, from: unknown, to: unknown, spec: Partial<TransitionSpec> | undefined, apply: (v: unknown, done: boolean) => boolean | void): boolean;
	current(key: string): unknown;
	cancel(key: string): boolean;
	cancelPrefix(prefix: string): void;
	clear(): void;
	readonly active: number;
	tick(): void;
}
export function createTransitions(o?: { now?: () => number; schedule?: (fn: () => void) => unknown }): Transitions;
