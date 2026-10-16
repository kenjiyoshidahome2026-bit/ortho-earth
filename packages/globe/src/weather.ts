// 太陽・雲の口の spec の正規化（第 2 波 F2・2026-10-12）。DOM 無し＝tests/weather.mjs で検める。
//   setSun：{ follow: "clock" }（共通の時計の太陽に directional の光を追わせる）か { azimuth, altitude }（固定・度）。intensity/color を指定すれば高度からの自動を上書き
//   setClouds：受けて保つだけ（capabilities "clouds" は spec）。plugin が registry.clouds に { apply(map, clouds) } を足せば描く約束
import type { CloudsSpec, LightSpecification, SunSpec } from "../globe.d.ts";

/** setSun の spec を整えた物（follow "clock"｜固定の azimuth/altitude・minAltitude は常に在る） */
export type SunSpecNorm = SunSpec & { follow: "clock" | null; minAltitude: number };
type Loose = Record<string, unknown>;

const fin = (v: unknown, d: number): number => (Number.isFinite(+(v as number)) ? +(v as number) : d);
const clamp01 = (v: unknown, d: number): number => Math.max(0, Math.min(1, fin(v, d)));
export function normSun(s: SunSpec | true | null | undefined): SunSpecNorm {
	const o = (s === true ? {} : s && typeof s === "object" ? s : {}) as Loose;
	const fixed = Number.isFinite(+(o.azimuth as number)) || Number.isFinite(+(o.altitude as number));
	const out = (fixed ? { follow: null, azimuth: ((fin(o.azimuth, 180) % 360) + 360) % 360, altitude: Math.max(-90, Math.min(90, fin(o.altitude, 45))) } : { follow: "clock" }) as SunSpecNorm;
	if (o.intensity != null) out.intensity = clamp01(o.intensity, 0.5);
	if (typeof o.color === "string" && o.color) out.color = o.color;
	out.minAltitude = Math.max(0, Math.min(89, fin(o.minAltitude, 2)));   // 地平の下でも光の向きはこの高度で止める（真横からの光＝陰影が消えないため）
	return out;
}
// 高度（度）→ 色と強さの自動：高い太陽は白く強く・地平で橙に弱く・地平の下は薄い青（夜の環境光の代わり）
export function sunLightColor(altDeg: number): string {
	if (altDeg <= 0) return "#7f8cb0";
	const k = Math.min(1, altDeg / 25);   // 25° で白
	const r = 255, g = Math.round(176 + (255 - 176) * k), b = Math.round(112 + (255 - 112) * k);
	return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}
export const sunLightIntensity = (altDeg: number): number => altDeg <= 0 ? 0.12 : 0.2 + 0.6 * Math.sin(Math.min(90, altDeg) * Math.PI / 180);
// 太陽の spec と（follow の時は）今の高度・方位 → setLight の形（anchor map＝方位は真北 0・時計回り、polar＝天頂からの角）
export function sunToLight(spec: SunSpecNorm, { azimuth, altitude }: { azimuth?: number; altitude?: number }): LightSpecification {
	const alt = Math.max(spec.minAltitude ?? 2, altitude!);
	return { anchor: "map", color: spec.color ?? sunLightColor(altitude!), intensity: spec.intensity ?? sunLightIntensity(altitude!), position: [1.15, azimuth!, 90 - alt] };
}
export function normClouds(c: CloudsSpec | boolean | null | undefined): Required<CloudsSpec> | null {
	if (c == null || c === false) return null;
	const o = (c === true ? {} : typeof c === "object" ? c : {}) as Loose;
	const p = o.precipitation as Loose | null | undefined;
	const url = typeof o.url === "string" && o.url ? o.url : null;
	return ({
		// type "image"（W6・builtin）＝全球の雲量の画像（等経緯度）を altitude の殻として描く。url が無ければ type は null（手続きの雲＝spec のまま）
		type: o.type === "image" && url ? "image" : o.type === "image" ? null : (o.type ?? (url ? "image" : null)), url,
		opacity: clamp01(o.opacity, 1), alphaFrom: o.alphaFrom === "alpha" || o.alphaFrom === "luminance" ? o.alphaFrom : "auto",
		coverage: clamp01(o.coverage, 0.5), altitude: Math.max(0, fin(o.altitude, 2000)), thickness: Math.max(1, fin(o.thickness, 800)), density: clamp01(o.density, 0.6),
		color: typeof o.color === "string" && o.color ? o.color : "#ffffff", wind: Array.isArray(o.wind) && o.wind.length >= 2 ? [fin(o.wind[0], 0), fin(o.wind[1], 0)] : [0, 0],
		precipitation: p && typeof p === "object" && (p.type === "rain" || p.type === "snow") ? { type: p.type, intensity: clamp01(p.intensity, 0.5) } : null,
	}) as Required<CloudsSpec>;
}
