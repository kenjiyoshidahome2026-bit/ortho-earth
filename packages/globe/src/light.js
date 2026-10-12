// style の light（MapLibre の light・setLight/getLight・B3 2026-10-12）＝既定の補完と、接地の局所系（東・北・上）の向きへの換算。
// position＝[r, azimuthal, polar]（度）：azimuthal＝光源の方位（0°＝anchor:"map" なら真北・"viewport" なら画面の上、時計回り）・polar＝天頂からの角。
// 文書の意味で実装（MapLibre の shader の軸の符号は本物と未照合）。r は向きに効かない（MapLibre も同じ）。
import { parseRGBA } from "@ortho-earth/core";

export const LIGHT_DEFAULT = Object.freeze({ anchor: "viewport", color: "#ffffff", intensity: 0.5, position: Object.freeze([1.15, 210, 30]) });
const D2R = Math.PI / 180;

// 入力（部分指定・不正値）→ 既定で補った light（新しい object）。null/undefined → 既定
export function normLight(l) {
	const o = l && typeof l === "object" ? l : {};
	const pos = Array.isArray(o.position) && o.position.length >= 3 && o.position.every(v => Number.isFinite(+v)) ? [+o.position[0], +o.position[1], +o.position[2]] : [...LIGHT_DEFAULT.position];
	const it = Number.isFinite(+o.intensity) ? Math.max(0, Math.min(1, +o.intensity)) : LIGHT_DEFAULT.intensity;
	return { anchor: o.anchor === "map" ? "map" : "viewport", color: typeof o.color === "string" ? o.color : LIGHT_DEFAULT.color, intensity: it, position: pos };
}
// 光源へ向く単位ベクトル（東・北・上）。bearingDeg＝anchor:"viewport" の時だけ効く（画面の上＝方位 bearing）
export function lightENU(light, bearingDeg = 0) {
	const L = normLight(light), az = (L.position[1] + (L.anchor === "viewport" ? bearingDeg : 0)) * D2R, polar = L.position[2] * D2R;
	const s = Math.sin(polar);
	return [Math.sin(az) * s, Math.cos(az) * s, Math.cos(polar)];
}
// renderer へ渡す形：{ dir:[e,n,u], color:[r,g,b]（0..1）, intensity }
export function lightPayload(light, bearingDeg = 0) {
	const L = normLight(light), c = parseRGBA(L.color);
	return { dir: lightENU(L, bearingDeg), color: [c[0], c[1], c[2]], intensity: L.intensity };
}
