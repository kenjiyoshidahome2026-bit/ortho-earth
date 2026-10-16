// paint の transition（MapLibre の `*-transition`・style の根の `transition`・既定 { duration: 300, delay: 0 }・B1 2026-10-12）＝main 側の「遷移の走者」。
// setPaintProperty が前の値と次の値を渡し、rAF ごとに補間値を層の描き直し（relayer）に流す＝タイルは焼き直さない。
// 補間するのは数・色・数の配列（translate）だけ。式・文字列・真偽・長さの違う配列は補間しない＝次の値をすぐ当てる（MapLibre も式は補間しない）。
// 走っている途中に同じ性質を set し直したら、その瞬間の補間値から次の遷移を始める（MapLibre の transitionable と同じ）。
import { parseRGBA, isColor, bezierEase } from "@ortho-earth/core";

/** 遷移の長さ（ms） */
export interface TransitionSpec { duration: number; delay: number }
/** 補間の種類 */
export type MixKind = "number" | "color" | "array";
/** 走者の apply＝補間値ごとに呼ぶ（false で走者から消える） */
export type TransitionApply = (v: unknown, done: boolean) => boolean | void;
/** 走者（setPaintProperty の遷移） */
export interface Transitions {
	start(key: string, from: unknown, to: unknown, spec: Partial<TransitionSpec> | undefined, apply: TransitionApply): boolean;
	current(key: string): unknown;
	cancel(key: string): boolean;
	cancelPrefix(prefix: string): void;
	clear(): void;
	readonly active: number;
	/** 検定用（時計を進めて手で刻む） */
	tick(): void;
}
interface Running { from: unknown; to: unknown; kind: MixKind; duration: number; delay: number; t0: number; apply: TransitionApply }

const DEFAULT_TRANSITION: Readonly<TransitionSpec> = Object.freeze({ duration: 300, delay: 0 });
export const EASE: (t: number) => number = bezierEase(0.25, 0.1, 0.25, 1);   // MapLibre の util.ease（遷移の既定の曲線）

// 層の `<name>-transition` → style の根の `transition` → 既定。{ duration, delay }（ms・負や数でない物は 0）
export function transitionOf(layer: { paint?: Record<string, unknown> | null } | null | undefined, name: string, styleTransition: unknown = null): TransitionSpec {
	const own = layer?.paint?.[`${name}-transition`];
	const pick = (t: unknown): TransitionSpec | null => t && typeof t === "object" ? { duration: Math.max(0, +(t as Partial<TransitionSpec>).duration! || 0), delay: Math.max(0, +(t as Partial<TransitionSpec>).delay! || 0) } : null;
	return pick(own) ?? pick(styleTransition) ?? { ...DEFAULT_TRANSITION };
}

// 性質が無指定だった時の「前の値」（spec の既定・遷移できる物だけ）。無い名前は undefined＝補間しないで当てる
export const PAINT_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
	"fill-opacity": 1, "fill-color": "#000000", "fill-translate": [0, 0],
	"line-opacity": 1, "line-color": "#000000", "line-width": 1, "line-blur": 0, "line-gap-width": 0, "line-offset": 0, "line-translate": [0, 0],
	"circle-radius": 5, "circle-color": "#000000", "circle-opacity": 1, "circle-blur": 0, "circle-stroke-width": 0, "circle-stroke-color": "#000000", "circle-stroke-opacity": 1, "circle-translate": [0, 0],
	"fill-extrusion-opacity": 1, "fill-extrusion-color": "#000000", "fill-extrusion-height": 0, "fill-extrusion-base": 0, "fill-extrusion-translate": [0, 0],
	"raster-opacity": 1, "raster-brightness-min": 0, "raster-brightness-max": 1, "raster-saturation": 0, "raster-contrast": 0, "raster-hue-rotate": 0,
	"hillshade-exaggeration": 0.5, "hillshade-shadow-color": "#000000", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#000000",
	"background-color": "#000000", "background-opacity": 1,
	"text-color": "#000000", "text-opacity": 1, "text-halo-color": "rgba(0,0,0,0)", "text-halo-width": 0, "text-halo-blur": 0, "text-translate": [0, 0],
	"icon-color": "#000000", "icon-opacity": 1, "icon-halo-color": "rgba(0,0,0,0)", "icon-halo-width": 0, "icon-halo-blur": 0, "icon-translate": [0, 0],
	"heatmap-opacity": 1, "heatmap-intensity": 1, "heatmap-radius": 30, "color-relief-opacity": 1,
});

// 補間できる組か："number"｜"color"｜"array"（同じ長さの数の配列）｜null
export function interpolable(a: unknown, b: unknown): MixKind | null {
	if (typeof a === "number" && typeof b === "number") return Number.isFinite(a) && Number.isFinite(b) ? "number" : null;
	if (typeof a === "string" && typeof b === "string") return isColor(a) && isColor(b) ? "color" : null;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.length > 0 && a.every(x => typeof x === "number") && b.every(x => typeof x === "number") ? "array" : null;
	return null;
}
const fmtColor = (c: number[]): string => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${+c[3].toFixed(4)})`;
// 補間値（t＝0..1・曲線は呼び手が掛ける）。色は rgba(…) の文字列（style に戻せる形）
export function mix(kind: MixKind | string | null, a: unknown, b: unknown, t: number): unknown {
	if (kind === "number") return (a as number) + ((b as number) - (a as number)) * t;
	if (kind === "array") return (a as number[]).map((x, i) => x + ((b as number[])[i] - x) * t);
	if (kind === "color") { const p = parseRGBA(a as string), q = parseRGBA(b as string); return fmtColor([0, 1, 2, 3].map(i => p[i] + (q[i] - p[i]) * t)); }
	return b;
}

// 走者。now＝ms の時計・schedule＝次の刻（rAF）。start は補間できない組・duration 0 なら apply(to, true) をすぐ呼んで false
export function createTransitions({ now = () => performance.now(), schedule = (fn: () => void): unknown => requestAnimationFrame(fn) }: { now?: () => number; schedule?: (fn: () => void) => unknown } = {}): Transitions {
	const act = new Map<string, Running>();
	let queued = false;
	const valueAt = (s: Running, t: number): unknown => { const u = Math.min(1, Math.max(0, (t - s.t0 - s.delay) / s.duration)); return u >= 1 ? s.to : u <= 0 ? s.from : mix(s.kind, s.from, s.to, EASE(u)); };
	const tick = (): void => {
		queued = false;
		const t = now();
		for (const [k, s] of [...act]) {
			const done = t - s.t0 - s.delay >= s.duration, v = valueAt(s, t);
			if (done) act.delete(k);
			if (!done && t - s.t0 < s.delay) continue;   // delay の間は何もしない（前の値のまま）
			let keep = true;
			try { keep = s.apply(v, done) !== false; } catch (e) { console.error("[transition]", e); keep = false; }
			if (!keep) act.delete(k);
		}
		if (act.size && !queued) { queued = true; schedule(tick); }
	};
	return {
		start(key: string, from: unknown, to: unknown, { duration = 0, delay = 0 }: Partial<TransitionSpec> = {}, apply: TransitionApply): boolean {
			const prev = act.get(key);
			if (prev) { from = valueAt(prev, now()); act.delete(key); }   // 途中で set し直す＝その瞬間の値から
			const kind = interpolable(from, to);
			if (!kind || !(duration > 0)) { apply(to, true); return false; }
			act.set(key, { from, to, kind, duration, delay, t0: now(), apply });
			if (!queued) { queued = true; schedule(tick); }
			return true;
		},
		current(key: string): unknown { const s = act.get(key); return s ? valueAt(s, now()) : undefined; },
		cancel(key: string): boolean { return act.delete(key); },
		cancelPrefix(prefix: string): void { for (const k of [...act.keys()]) if (k.startsWith(prefix)) act.delete(k); },
		clear(): void { act.clear(); },
		get active(): number { return act.size; },
		tick,   // 検定用（時計を進めて手で刻む）
	};
}
