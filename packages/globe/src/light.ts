// style の light（MapLibre の light・setLight/getLight・B3 2026-10-12）＝既定の補完と、接地の局所系（東・北・上）の向きへの換算。
// position＝[r, azimuthal, polar]（度）：azimuthal＝光源の方位（0°＝anchor:"map" なら真北・"viewport" なら画面の上、時計回り）・polar＝天頂からの角。
// 文書の意味で実装（MapLibre の shader の軸の符号は本物と未照合）。r は向きに効かない（MapLibre も同じ）。
import { parseRGBA, lonlatTo3D } from "@ortho-earth/core";
import type { LightSpec, LightSpecification } from "../globe.d.ts";

/** 部分指定・不正値も受ける入力（中身は既定で補う） */
type Loose = Record<string, unknown>;
/** 局所の光源（normLightSpec を通った物）＝renderer へ詰める時に読む分 */
interface LocalLight { type?: string; color?: string; skyColor?: string; groundColor?: string; intensity: number; position: number[]; target?: number[] | null; direction: number[]; range?: number; decay: number; angle: number; penumbra: number }

export const LIGHT_DEFAULT: Readonly<{ anchor: "viewport"; color: string; intensity: number; position: readonly number[] }> = Object.freeze({ anchor: "viewport", color: "#ffffff", intensity: 0.5, position: Object.freeze([1.15, 210, 30]) });
const D2R = Math.PI / 180;

// 入力（部分指定・不正値）→ 既定で補った light（新しい object）。null/undefined → 既定
export function normLight(l: LightSpecification | LightSpec | Loose | null | undefined): Required<LightSpecification> {
	const o = (l && typeof l === "object" ? l : {}) as Loose;
	const pos = (Array.isArray(o.position) && o.position.length >= 3 && o.position.every(v => Number.isFinite(+v)) ? [+o.position[0], +o.position[1], +o.position[2]] : [...LIGHT_DEFAULT.position]) as [number, number, number];
	const it = Number.isFinite(+(o.intensity as number)) ? Math.max(0, Math.min(1, +(o.intensity as number))) : LIGHT_DEFAULT.intensity;
	return { anchor: o.anchor === "map" ? "map" : "viewport", color: typeof o.color === "string" ? o.color : LIGHT_DEFAULT.color, intensity: it, position: pos };
}
// 光源へ向く単位ベクトル（東・北・上）。bearingDeg＝anchor:"viewport" の時だけ効く（画面の上＝方位 bearing）
export function lightENU(light: LightSpecification | null | undefined, bearingDeg = 0): number[] {
	const L = normLight(light), az = (L.position[1] + (L.anchor === "viewport" ? bearingDeg : 0)) * D2R, polar = L.position[2] * D2R;
	const s = Math.sin(polar);
	return [Math.sin(az) * s, Math.cos(az) * s, Math.cos(polar)];
}
// renderer へ渡す形：{ dir:[e,n,u], color:[r,g,b]（0..1）, intensity }
export function lightPayload(light: LightSpecification | null | undefined, bearingDeg = 0): { dir: number[]; color: number[]; intensity: number } {
	const L = normLight(light), c = parseRGBA(L.color);
	return { dir: lightENU(L, bearingDeg), color: [c[0], c[1], c[2]], intensity: L.intensity };
}

// ── 光源の口（第 2 波 F1・2026-10-12）＝map.setLights([...])／getLights()。type ごとの spec を受けて既定を補い**保つ**。描くのは directional だけ（setLight と同じ経路）。
//   point/spot/ambient/hemisphere は第 3 波 W2（2026-10-12）で描く（下の localLightsPayload → renderer "lights"・メッシュ＝模型・LOD2 建物の陰影に足す・上限 8 灯）。ibl は受けて保つだけ（"spec"）＝plugin（registry.lights に type を足し apply(map, lights) で自前描画）が描く。
//   位置は [lon, lat, alt m]・向きは [east, north, up]・角は度・距離は m・色は CSS 文字列・intensity は 0〜（directional だけ MapLibre どおり 0〜1）
export const LIGHT_TYPES: readonly string[] = Object.freeze(["directional", "point", "spot", "ambient", "hemisphere", "ibl"]);
const fin = (v: unknown, d: number): number => (Number.isFinite(+(v as number)) ? +(v as number) : d);
const nn = (v: unknown, d: number): number => Math.max(0, fin(v, d));
const col = (v: unknown, d: string): string => (typeof v === "string" && v ? v : d);
const llh = <D>(v: unknown, d: D): number[] | D => (Array.isArray(v) && v.length >= 2 && v.slice(0, 2).every(x => Number.isFinite(+x)) ? [+v[0], +v[1], fin(v[2], 0)] : d);
const vec = <D>(v: unknown, d: D): number[] | D => (Array.isArray(v) && v.length >= 3 && v.every(x => Number.isFinite(+x)) ? [+v[0], +v[1], +v[2]] : d);
// 1 つの spec → 既定を補った新しい object。type が無い物は directional と読む（setLight の形をそのまま入れられる）。知らない type は null（呼び手が registry を見る）
export function normLightSpec(l: unknown): LightSpec | null {
	const o = (l && typeof l === "object" ? l : {}) as Loose;
	const type = o.type == null ? "directional" : String(o.type);
	const id = typeof o.id === "string" && o.id ? o.id : undefined;
	const base: { id?: string; type: string } = id ? { id, type } : { type };
	switch (type) {
		case "directional": return { ...base, ...normLight(o) };
		case "point": return { ...base, position: llh(o.position, [0, 0, 0]), color: col(o.color, "#ffffff"), intensity: nn(o.intensity, 1), range: nn(o.range, 0), decay: nn(o.decay, 2) };
		case "spot": {
			const out: Loose = { ...base, position: llh(o.position, [0, 0, 0]), color: col(o.color, "#ffffff"), intensity: nn(o.intensity, 1), range: nn(o.range, 0), decay: nn(o.decay, 2), angle: Math.min(90, nn(o.angle, 30)), penumbra: Math.min(1, nn(o.penumbra, 0)) };
			const tg = llh(o.target, null); if (tg) out.target = tg; else out.direction = vec(o.direction, [0, 0, -1]);
			return out as LightSpec;
		}
		case "ambient": return { ...base, color: col(o.color, "#ffffff"), intensity: nn(o.intensity, 0.2) };
		case "hemisphere": return { ...base, skyColor: col(o.skyColor, "#bfd4ff"), groundColor: col(o.groundColor, "#6b5a3e"), intensity: nn(o.intensity, 0.5) };
		case "ibl": return { ...base, url: typeof o.url === "string" ? o.url : null, intensity: nn(o.intensity, 1), rotation: fin(o.rotation, 0), background: !!o.background };
		default: return null;
	}
}
// 配列（か 1 つ）→ 正規化した配列。known(type)＝builtin 以外に registry が知る type。知らない type は投げる（黙って捨てない）。directional は 1 つまで（2 つ目以降は投げる）
export function normLights(list: unknown, known: (type: string) => boolean = () => false): LightSpec[] {
	const arr = list == null ? [] : Array.isArray(list) ? list : [list];
	const out: LightSpec[] = []; let dir = 0;
	for (const l of arr) {
		const n = normLightSpec(l);
		if (n) { if (n.type === "directional" && ++dir > 1) throw new Error("setLights: at most one directional light (MapLibre's light)"); out.push(n); continue; }
		const type = l && typeof l === "object" ? String((l as Loose).type) : String(l);
		if (!known(type)) throw new Error(`setLights: unknown light type "${type}" (builtin: ${LIGHT_TYPES.join("/")}; plugins register via map.registry.lights)`);
		out.push({ ...(typeof l === "object" ? l as Loose : {}), type });   // plugin の type＝形は plugin の約束（そのまま保つ）
	}
	return out;
}

// ── 局所の光源の renderer への形（第 3 波 W2・2026-10-12）＝point/spot/ambient/hemisphere を上限 LOCAL_LIGHT_MAX 灯、1 灯 4 つの vec4 に詰める（GL2 の uniform 配列・WebGPU の PB.lt と同じ並び）。
//   A＝(位置 xyz（単位球の世界座標＝lonlatTo3D×(1+alt/R)）, kind 1 point・2 spot・3 ambient・4 hemisphere)
//   B＝(色 rgb 0..1, intensity)　C＝(spot の向き xyz（世界・単位）／hemisphere の地面色 rgb, range（世界単位＝m/R・0＝減衰なし））　D＝(cos(angle), cos(angle×(1−penumbra)), decay, 0)
//   減衰＝range>0 なら (1−dist/range)^decay を 0..1 に畳む・range=0 なら 1。spot＝cos で smoothstep(cosOuter, cosInner)。
//   陰影への足し方＝d（従来の陰影の係数）に足す＝色×(d＋Σ光)。ambient は向きに依らず・hemisphere は法線の上向き具合で空色と地面色を混ぜる。
//   戻り＝{ n, data: Float32Array(LOCAL_LIGHT_MAX×16) }（n＝詰めた数・data は常に満杯の長さ＝renderer が uniform にそのまま流す）。ibl・directional・plugin の type は飛ばす
export const LOCAL_LIGHT_MAX = 8;
const LOCAL_KIND: Record<string, number> = { point: 1, spot: 2, ambient: 3, hemisphere: 4 };
export function localLightsPayload(lights: ReadonlyArray<object> | null | undefined, radiusM = 6371000): { n: number; data: Float32Array<ArrayBuffer> } {
	const data = new Float32Array(LOCAL_LIGHT_MAX * 16); let n = 0;
	const rgb = (c: string | undefined): number[] => { const v = parseRGBA(c); return [v[0], v[1], v[2]]; };
	const world = ([lon, lat, alt]: number[]): number[] => { const p = lonlatTo3D(lon, lat), k = 1 + (alt || 0) / radiusM; return [p[0] * k, p[1] * k, p[2] * k]; };
	for (const l of (lights || []) as LocalLight[]) {
		const kind = LOCAL_KIND[l?.type!]; if (!kind) continue;
		if (n >= LOCAL_LIGHT_MAX) { console.warn(`setLights: more than ${LOCAL_LIGHT_MAX} local lights; the rest are not rendered`); break; }
		const o = n * 16, A = data.subarray(o, o + 4), B = data.subarray(o + 4, o + 8), C = data.subarray(o + 8, o + 12), D = data.subarray(o + 12, o + 16);
		A[3] = kind;
		if (kind === 3) { B.set(rgb(l.color)); B[3] = l.intensity; }
		else if (kind === 4) { B.set(rgb(l.skyColor)); B[3] = l.intensity; C.set(rgb(l.groundColor)); }
		else {
			const P = world(l.position); A.set(P); B.set(rgb(l.color)); B[3] = l.intensity; C[3] = (l.range || 0) / radiusM; D[2] = l.decay;
			if (kind === 2) {
				let dir: number[];
				if (l.target) { const T = world(l.target); dir = [T[0] - P[0], T[1] - P[1], T[2] - P[2]]; }
				else {   // direction＝[east, north, up] → 世界（光源の位置の局所系）
					const up = P.map((v, i) => v / Math.hypot(P[0], P[1], P[2]) || 0), e0 = [-up[2], 0, up[0]];   // cross((0,1,0), up)
					const el = Math.hypot(e0[0], e0[1], e0[2]), east = el < 1e-9 ? [1, 0, 0] : e0.map(v => v / el);
					const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
					const [de, dn, du] = l.direction; dir = [0, 1, 2].map(i => east[i] * de + north[i] * dn + up[i] * du);
				}
				const len = Math.hypot(dir[0], dir[1], dir[2]) || 1; C.set(dir.map(v => v / len));
				const ang = l.angle * D2R; D[0] = Math.cos(ang); D[1] = Math.cos(ang * (1 - l.penumbra));
			}
		}
		n++;
	}
	return { n, data };
}
