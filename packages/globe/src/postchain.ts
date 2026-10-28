// 後処理の鎖（第 2 波 F3・2026-10-12）＝map.setPostChain([{ type, ...}, …])／getPostChain()。順番つきの pass の並びを受けて既定を補い**保つ**。
//   描くのは bloom・vignette（PR-8）と fxaa・tonemap・lut（第 3 波 W1・2026-10-12）＝normPost の形で renderer の "post" へ（掛ける順は固定＝fxaa → bloom → tonemap → lut → vignette）。smaa/dof/ssr は受けて保つだけ（capabilities "spec"）＝plugin が描く。
//   plugin の type＝registry.postEffects.add(type, { apply(map, passes) })＝setPostChain のたびに、その type の pass の配列（無ければ []）で呼ぶ（自前の overlay／CSS filter で描く約束）。
//   setPostProcess({ bloom, vignette }) は従来どおり＝鎖の bloom→vignette の 2 段に写る。DOM 無し＝tests/postchain.mjs。
import { normPost, normStages } from "@ortho-earth/core/postfx";
import type { PostProcessNormalized, PostProcessOptions, PostStage, TonemapMode } from "@ortho-earth/core/postfx";
export const POST_TYPES: readonly string[] = Object.freeze(["bloom", "vignette", "fxaa", "smaa", "tonemap", "lut", "dof", "ssr", "silhouette", "grey", "brightness", "nightVision", "glsl"]);   // silhouette〜glsl＝画面の段（Cesium の postProcessStages 相当・2026-10-28）＝固定の鎖の後に並び順どおり
const LEGACY_KEYS = ["fxaa", "bloom", "tonemap", "lut", "vignette"];
const STAGE_TYPES = new Set(["silhouette", "grey", "brightness", "nightVision", "glsl"]);   // setPostProcess({ ... }) の旧形が受ける鍵＝描く順
const fin = (v: unknown, d: number): number => (Number.isFinite(+(v as number)) ? +(v as number) : d);
const nn = (v: unknown, d: number, lo = 0, hi = Infinity): number => Math.min(hi, Math.max(lo, fin(v, d)));
// 正規化した pass（type ごとの既定を補った物）。plugin の pass（PluginPass）は受けた鍵をそのまま
type PassBase = { id?: string; type: string; enabled: boolean };
export type NormBloom = PassBase & { threshold: number; strength: number; radius: number };
export type NormVignette = PassBase & { strength: number; radius: number; softness: number };
export type NormTonemap = PassBase & { mode: TonemapMode; exposure: number };
export type NormLut = PassBase & { url: string | null; size: number; intensity: number };
export type NormStagePass = PassBase & PostStage;
export type NormBuiltinPass = NormBloom | NormVignette | NormTonemap | NormLut | NormStagePass
	| PassBase | (PassBase & { preset: string })
	| (PassBase & { focusDistance: number; focalLength: number; aperture: number; maxBlur: number })
	| (PassBase & { intensity: number; maxDistance: number; thickness: number; steps: number });
export type PluginPass = { type: string; enabled: boolean; [k: string]: unknown };
export type NormPass = NormBuiltinPass | PluginPass;
// 1 つの pass → 既定を補った新しい object（knownType 以外は null）
export function normPass(p: unknown): NormBuiltinPass | null {
	const o: Record<string, unknown> = p && typeof p === "object" ? p as Record<string, unknown> : typeof p === "string" ? { type: p } : {};
	const type = String(o.type ?? ""), id = typeof o.id === "string" && o.id ? o.id : undefined, base = id ? { id, type } : { type };
	const enabled = o.enabled !== false;
	switch (type) {
		case "bloom": { const b = normPost({ bloom: { threshold: o.threshold as number, strength: o.strength as number, radius: o.radius as number } })?.bloom ?? { threshold: nn(o.threshold, 0.75, 0, 1), strength: 0, radius: nn(o.radius, 1, 0.25, 4) }; return { ...base, enabled, ...b }; }
		case "vignette": { const v = normPost({ vignette: { strength: o.strength as number, radius: o.radius as number, softness: o.softness as number } })?.vignette ?? { strength: 0, radius: nn(o.radius, 0.8, 0, 1.5), softness: nn(o.softness, 0.5, 0.01, 1.5) }; return { ...base, enabled, ...v }; }
		case "fxaa": return { ...base, enabled };
		case "smaa": return { ...base, enabled, preset: ["low", "medium", "high", "ultra"].includes(o.preset as string) ? o.preset as string : "medium" };
		case "tonemap": return { ...base, enabled, mode: ["linear", "reinhard", "aces", "agx", "filmic"].includes(o.mode as string) ? o.mode as TonemapMode : "aces", exposure: nn(o.exposure, 1, 0, 16) };
		case "lut": return { ...base, enabled, url: typeof o.url === "string" ? o.url : null, size: [16, 32, 64].includes(+(o.size as number)) ? +(o.size as number) : 32, intensity: nn(o.intensity, 1, 0, 1) };
		case "dof": return { ...base, enabled, focusDistance: nn(o.focusDistance, 500), focalLength: nn(o.focalLength, 50, 1, 1200), aperture: nn(o.aperture, 2.8, 0.5, 64), maxBlur: nn(o.maxBlur, 8, 0, 64) };
		case "ssr": return { ...base, enabled, intensity: nn(o.intensity, 0.5, 0, 1), maxDistance: nn(o.maxDistance, 2000), thickness: nn(o.thickness, 2), steps: Math.round(nn(o.steps, 32, 4, 256)) };
		case "silhouette": case "grey": case "brightness": case "nightVision": case "glsl": { const st = normStages([o])[0]; return st ? { ...base, enabled, ...st } : null; }   // 画面の段（src の無い glsl は null）
		default: return null;
	}
}
// 鎖（配列・1 つ・{ bloom, vignette } の旧形・null）→ { passes（正規化・順番どおり）, post（renderer へ渡す normPost の形＝bloom/vignette＋fxaa/tonemap/lut・無ければ null） }。知らない type は投げる（known(type) が true なら plugin の pass としてそのまま保つ）
export function normPostChain(list: unknown, known: (type: string) => boolean = () => false): { passes: NormPass[]; post: PostProcessNormalized | null } {
	let arr: unknown[];
	if (list == null || list === false) arr = [];
	else if (Array.isArray(list)) arr = list;
	else if (typeof list === "object" && !("type" in list) && LEGACY_KEYS.some(k => k in list)) arr = LEGACY_KEYS.map(k => ((list as Record<string, unknown>)[k] ? { type: k, ...((list as Record<string, unknown>)[k] === true ? {} : (list as Record<string, object>)[k]) } : null)).filter(Boolean);   // 旧形＝鍵を描く順に並べる
	else arr = [list];
	const passes: NormPass[] = [];
	for (const p of arr) {
		const n = normPass(p);
		if (n) { passes.push(n); continue; }
		const type = p && typeof p === "object" ? String((p as { type?: unknown }).type) : String(p);
		if (!known(type)) throw new Error(`setPostChain: unknown pass type "${type}" (builtin: ${POST_TYPES.join("/")}; plugins register via map.registry.postEffects)`);
		passes.push({ ...(typeof p === "object" ? p : {}), type, enabled: (p as { enabled?: unknown } | null | undefined)?.enabled !== false });
	}
	const on = (t: string) => passes.find(x => x.type === t && x.enabled);
	const bloom = on("bloom") as NormBloom | undefined, vig = on("vignette") as NormVignette | undefined, fx = on("fxaa"), tm = on("tonemap") as NormTonemap | undefined, lut = on("lut") as NormLut | undefined;
	const stages = passes.filter(x => x.enabled && STAGE_TYPES.has(x.type)).map(x => { const { id: _i, enabled: _e, ...rest } = x as NormStagePass; return rest as PostStage; });   // 画面の段＝並び順どおり（on の物だけ）
	const post = normPost(({ bloom: bloom ? { threshold: bloom.threshold, strength: bloom.strength, radius: bloom.radius } : null, vignette: vig ? { strength: vig.strength, radius: vig.radius, softness: vig.softness } : null,
		fxaa: !!fx, tonemap: tm ? { mode: tm.mode, exposure: tm.exposure } : null, lut: lut && lut.url ? { url: lut.url, size: lut.size, intensity: lut.intensity } : null, stages }) as PostProcessOptions);
	return { passes, post };
}
