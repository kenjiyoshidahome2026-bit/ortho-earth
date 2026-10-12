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

// ── 光源の口（第 2 波 F1・2026-10-12）＝map.setLights([...])／getLights()。type ごとの spec を受けて既定を補い**保つ**。描くのは directional だけ（setLight と同じ経路）。
//   point/spot/ambient/hemisphere/ibl は受けて保つだけ（capabilities "spec"）＝後の段（実 GPU の多光源）か plugin（registry.lights に type を足し apply(map, lights) で自前描画）が描く。
//   位置は [lon, lat, alt m]・向きは [east, north, up]・角は度・距離は m・色は CSS 文字列・intensity は 0〜（directional だけ MapLibre どおり 0〜1）
export const LIGHT_TYPES = Object.freeze(["directional", "point", "spot", "ambient", "hemisphere", "ibl"]);
const fin = (v, d) => (Number.isFinite(+v) ? +v : d);
const nn = (v, d) => Math.max(0, fin(v, d));
const col = (v, d) => (typeof v === "string" && v ? v : d);
const llh = (v, d) => (Array.isArray(v) && v.length >= 2 && v.slice(0, 2).every(x => Number.isFinite(+x)) ? [+v[0], +v[1], fin(v[2], 0)] : d);
const vec = (v, d) => (Array.isArray(v) && v.length >= 3 && v.every(x => Number.isFinite(+x)) ? [+v[0], +v[1], +v[2]] : d);
// 1 つの spec → 既定を補った新しい object。type が無い物は directional と読む（setLight の形をそのまま入れられる）。知らない type は null（呼び手が registry を見る）
export function normLightSpec(l) {
	const o = l && typeof l === "object" ? l : {};
	const type = o.type == null ? "directional" : String(o.type);
	const id = typeof o.id === "string" && o.id ? o.id : undefined;
	const base = id ? { id, type } : { type };
	switch (type) {
		case "directional": return { ...base, ...normLight(o) };
		case "point": return { ...base, position: llh(o.position, [0, 0, 0]), color: col(o.color, "#ffffff"), intensity: nn(o.intensity, 1), range: nn(o.range, 0), decay: nn(o.decay, 2) };
		case "spot": {
			const out = { ...base, position: llh(o.position, [0, 0, 0]), color: col(o.color, "#ffffff"), intensity: nn(o.intensity, 1), range: nn(o.range, 0), decay: nn(o.decay, 2), angle: Math.min(90, nn(o.angle, 30)), penumbra: Math.min(1, nn(o.penumbra, 0)) };
			const tg = llh(o.target, null); if (tg) out.target = tg; else out.direction = vec(o.direction, [0, 0, -1]);
			return out;
		}
		case "ambient": return { ...base, color: col(o.color, "#ffffff"), intensity: nn(o.intensity, 0.2) };
		case "hemisphere": return { ...base, skyColor: col(o.skyColor, "#bfd4ff"), groundColor: col(o.groundColor, "#6b5a3e"), intensity: nn(o.intensity, 0.5) };
		case "ibl": return { ...base, url: typeof o.url === "string" ? o.url : null, intensity: nn(o.intensity, 1), rotation: fin(o.rotation, 0), background: !!o.background };
		default: return null;
	}
}
// 配列（か 1 つ）→ 正規化した配列。known(type)＝builtin 以外に registry が知る type。知らない type は投げる（黙って捨てない）。directional は 1 つまで（2 つ目以降は投げる）
export function normLights(list, known = () => false) {
	const arr = list == null ? [] : Array.isArray(list) ? list : [list];
	const out = []; let dir = 0;
	for (const l of arr) {
		const n = normLightSpec(l);
		if (n) { if (n.type === "directional" && ++dir > 1) throw new Error("setLights: at most one directional light (MapLibre's light)"); out.push(n); continue; }
		const type = l && typeof l === "object" ? String(l.type) : String(l);
		if (!known(type)) throw new Error(`setLights: unknown light type "${type}" (builtin: ${LIGHT_TYPES.join("/")}; plugins register via map.registry.lights)`);
		out.push({ ...(typeof l === "object" ? l : {}), type });   // plugin の type＝形は plugin の約束（そのまま保つ）
	}
	return out;
}
