// 後処理の鎖（第 2 波 F3・2026-10-12）＝map.setPostChain([{ type, ...}, …])／getPostChain()。順番つきの pass の並びを受けて既定を補い**保つ**。
//   描くのは bloom・vignette（PR-8）と fxaa・tonemap・lut（第 3 波 W1・2026-10-12）＝normPost の形で renderer の "post" へ（掛ける順は固定＝fxaa → bloom → tonemap → lut → vignette）。ssr は WebGPU で描く（2026-11-01・renderer の "ssr"）。smaa/dof は受けて保つだけ（capabilities "spec"）＝plugin が描く。
//   plugin の type＝registry.postEffects.add(type, { apply(map, passes) })＝setPostChain のたびに、その type の pass の配列（無ければ []）で呼ぶ（自前の overlay／CSS filter で描く約束）。
//   setPostProcess({ bloom, vignette }) は従来どおり＝鎖の bloom→vignette の 2 段に写る。DOM 無し＝tests/postchain.mjs。
import { normPost, normStages } from "@ortho-earth/core/postfx";
import type { PostProcessNormalized, PostProcessOptions, PostStage, TonemapMode } from "@ortho-earth/core/postfx";
export const POST_TYPES: readonly string[] = Object.freeze(["bloom", "vignette", "fxaa", "smaa", "tonemap", "lut", "dof", "ssr", "silhouette", "grey", "brightness", "nightVision", "glsl", "lensFlare", "depthOfField", "cesiumBloom", "contactShadow", "heightFog", "godRays", "rain", "toon"]);   // contactShadow〜toon＝場面の効果（2026-11-01・WebGPU だけ・renderer の "sceneFx"）。 silhouette〜cesiumBloom＝画面の段（Cesium の postProcessStages 相当・2026-10-28）＝固定の鎖の後に並び順どおり
const LEGACY_KEYS = ["fxaa", "bloom", "tonemap", "lut", "vignette"];
const STAGE_TYPES = new Set(["silhouette", "grey", "brightness", "nightVision", "glsl", "lensFlare", "depthOfField", "cesiumBloom"]);   // setPostProcess({ ... }) の旧形が受ける鍵＝描く順
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
	| NormSsr | NormContact | NormFog | NormRays | NormRain | NormToon;
/** SSR（画面空間の映り込み・2026-11-01・WebGPU だけ）：intensity＝全体の強さ・maxDistance＝反射の光線を歩く長さ（m）・thickness＝当たりと見る物の厚み（m）・steps＝歩数。
 *  ocean／ground／facades＝映す面の反射率（0..1＝真上から見た時・斜めほど強い）：標高 0 m 以下の地面／上を向いた面すべて（濡れた地面）／建物と模型の立った面（ガラスの壁） */
export type NormSsr = PassBase & { intensity: number; maxDistance: number; thickness: number; steps: number; ocean: number; ground: number; facades: number };
/** 場面の効果（2026-11-01・WebGPU だけ・Cesium に無い）。
 *  contactShadow＝画面の中で太陽へ向けて落とす影（strength 0..1・length／thickness＝視距離の割合・steps 歩数）
 *  heightFog＝標高で薄くなる霧（density＝底の高さの濃さ 1/km・height＝薄くなる高さの尺 m・base＝霧の底 m・color・sun＝太陽の前方散乱・anisotropy＝散乱の尖り）
 *  godRays＝光芒（strength・decay＝遠くの光の減り・length＝太陽までの何割を集めるか・samples）
 *  rain＝雨（intensity・wetness＝地面の濡れ・darken＝濡れた地面の暗さ・streaks＝画面の雨の筋）。SSR の ground を濡れに合わせて足す（ssr が無ければ作る）
 *  toon＝イラスト風（levels＝明るさの段数・edge＝線の濃さ・threshold＝線の閾・saturation＝彩度） */
export type NormContact = PassBase & { strength: number; length: number; thickness: number; steps: number };
export type NormFog = PassBase & { density: number; height: number; base: number; color: number[]; sun: number; anisotropy: number };
export type NormRays = PassBase & { strength: number; decay: number; length: number; samples: number };
export type NormRain = PassBase & { intensity: number; wetness: number; darken: number; streaks: number };
export type NormToon = PassBase & { levels: number; edge: number; threshold: number; saturation: number };
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
		case "ssr": return { ...base, enabled, intensity: nn(o.intensity, 1, 0, 1), maxDistance: nn(o.maxDistance, 2000, 1, 1e6), thickness: nn(o.thickness, 2, 0, 1e4), steps: Math.round(nn(o.steps, 32, 4, 256)),
			ocean: nn(o.ocean, 0.5, 0, 1), ground: nn(o.ground, 0, 0, 1), facades: nn(o.facades, 0, 0, 1) };   // SSR（2026-11-01・WebGPU）＝何が映すか：ocean＝標高 0 m 以下の地面・ground＝上を向いた面すべて・facades＝建物と模型の立った面
		case "contactShadow": return { ...base, enabled, strength: nn(o.strength, 0.6, 0, 1), length: nn(o.length, 0.15, 0.001, 1), thickness: nn(o.thickness, 0.03, 0.001, 1), steps: Math.round(nn(o.steps, 16, 4, 64)) };
		case "heightFog": { const c = Array.isArray(o.color) && o.color.length >= 3 ? (o.color as unknown[]).slice(0, 3).map(v => nn(v, 0.85, 0, 1)) : [0.82, 0.86, 0.9];
			return { ...base, enabled, density: nn(o.density, 0.4, 0, 1e3), height: nn(o.height, 150, 1, 1e5), base: nn(o.base, 0, -500, 1e4), color: c, sun: nn(o.sun, 0.6, 0, 4), anisotropy: nn(o.anisotropy, 0.75, 0, 0.95) }; }
		case "godRays": return { ...base, enabled, strength: nn(o.strength, 0.6, 0, 4), decay: nn(o.decay, 0.96, 0.5, 1), length: nn(o.length, 0.85, 0.05, 1), samples: Math.round(nn(o.samples, 32, 8, 96)) };
		case "rain": return { ...base, enabled, intensity: nn(o.intensity, 1, 0, 1), wetness: nn(o.wetness, 0.8, 0, 1), darken: nn(o.darken, 0.35, 0, 0.9), streaks: nn(o.streaks, 0.6, 0, 1) };
		case "toon": return { ...base, enabled, levels: Math.round(nn(o.levels, 4, 2, 16)), edge: nn(o.edge, 1, 0, 1), threshold: nn(o.threshold, 0.004, 1e-5, 1), saturation: nn(o.saturation, 1.15, 0, 3) };
		case "silhouette": case "grey": case "brightness": case "nightVision": case "glsl": case "lensFlare": case "depthOfField": case "cesiumBloom": { const st = normStages([o])[0]; return st ? { ...base, enabled, ...st } : null; }   // 画面の段（src の無い glsl は null）
		default: return null;
	}
}
// 鎖（配列・1 つ・{ bloom, vignette } の旧形・null）→ { passes（正規化・順番どおり）, post（renderer へ渡す normPost の形＝bloom/vignette＋fxaa/tonemap/lut・無ければ null） }。知らない type は投げる（known(type) が true なら plugin の pass としてそのまま保つ）
export function normPostChain(list: unknown, known: (type: string) => boolean = () => false): { passes: NormPass[]; post: PostProcessNormalized | null; ssr: SsrNormalized | null; sceneFx: SceneFxNormalized | null } {
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
	const sp = on("ssr") as NormSsr | undefined;   // SSR＝renderer の "ssr"（"post" とは別の口＝WebGL2 は読まない）。映す面が 1 つも無ければ null
	const ssr = sp && sp.intensity > 0 && (sp.ocean > 0 || sp.ground > 0 || sp.facades > 0) ? { intensity: sp.intensity, maxDistance: sp.maxDistance, thickness: sp.thickness, steps: sp.steps, ocean: sp.ocean, ground: sp.ground, facades: sp.facades } : null;
	// 場面の効果＝renderer の "sceneFx"（どれも無ければ null）。雨は SSR の ground を濡れに合わせて足す（ssr が無い・ground が弱い時）
	const strip = <T extends PassBase>(p: T | undefined): Omit<T, "id" | "type" | "enabled"> | null => { if (!p) return null; const { id: _i, type: _t, enabled: _e, ...rest } = p; return rest; };
	const cs = on("contactShadow") as NormContact | undefined, fg = on("heightFog") as NormFog | undefined, gr = on("godRays") as NormRays | undefined, rn = on("rain") as NormRain | undefined, tn = on("toon") as NormToon | undefined;
	const rain = rn && rn.intensity > 0 ? strip(rn) : null;
	const scene = { contact: cs && cs.strength > 0 ? strip(cs) : null, fog: fg && fg.density > 0 ? strip(fg) : null, rays: gr && gr.strength > 0 ? strip(gr) : null, rain, toon: tn ? strip(tn) : null };
	const sceneFx = scene.contact || scene.fog || scene.rays || scene.rain || scene.toon ? scene : null;
	let ssrOut: SsrNormalized | null = ssr;
	if (rain && rain.wetness > 0) {
		const b = ssrOut ?? { intensity: 1, maxDistance: 2000, thickness: 2, steps: 32, ocean: 0.5, ground: 0, facades: 0 };
		ssrOut = { ...b, ground: Math.max(b.ground, 0.5 * rain.wetness), rain: rain.intensity * rain.wetness };
	}
	return { passes, post, ssr: ssrOut, sceneFx };
}
/** renderer.set("sceneFx", …) の形（正規化済み・null の効果は掛けない）。 */
export type SceneFxNormalized = { contact: Omit<NormContact, "id" | "type" | "enabled"> | null; fog: Omit<NormFog, "id" | "type" | "enabled"> | null; rays: Omit<NormRays, "id" | "type" | "enabled"> | null; rain: Omit<NormRain, "id" | "type" | "enabled"> | null; toon: Omit<NormToon, "id" | "type" | "enabled"> | null };
/** renderer.set("ssr", …) の形（正規化済み・id/enabled/type 無し）。 */
export type SsrNormalized = Omit<NormSsr, "id" | "type" | "enabled"> & { rain?: number };   // rain＝雨の濡れ（rain の pass が足す）
