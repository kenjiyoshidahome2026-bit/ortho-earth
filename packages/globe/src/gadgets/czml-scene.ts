// CZML の model・polyline・polygon（Cesium との機能差 P0 #5・2026-10-25）＝時刻つきの点（czml.ts＋czml-draw.ts）の外の見た目。
//   読みは geopbf（czml 属性に graphics の生の JSON が残る）。ここは純関数 czmlSceneOf（node の tests/czml-scene.mjs が読む）と、地図へ置く createCzmlScene。
//   ・polygon／rectangle＝GeoJSON の層（fill・外形線 line・extrudedHeight＝fill-extrusion で height〜extrudedHeight）。material の色・fill・outline を写す
//   ・polyline＝clampToGround か高さが全部 0＝GeoJSON の line 層（地面に沿う）。高さのある線＝czml オーバーレイの 3D の線（尾と同じ描き方）
//     arcType（既定 GEODESIC）＝大円に沿って 100 km ごとに刻む（ECEF の弦は地球を潜る）。NONE＝刻まない
//   ・model＝map.gadget.model（slot "czml:<id>"）。静止＝その場に・時刻つきの位置＝時計ごとに setTransform（位置・向き）
//     向き＝orientation の unitQuaternion（地球固定・静止か標本）か velocityReference（進む向き）。模型の +X が前（Cesium と同じ）＝heading＝前の方位 − 90°
//     （ortho の模型は heading だけ＝pitch・roll は持たない）。高さ＝heightReference（NONE＝楕円体高から地面の高さを引く・RELATIVE_TO_GROUND＝そのまま・CLAMP＝0）
//   ・出ている区間（availability）と show（区間の列）＝時計が変わるたびに引き直す（層は filter・模型は置く／外す・線はオーバーレイが引く）
import { boolAt, colorOf, ecefToLlh, inIntervalsOf, llhToEcef, numberAt, parseIntervals, positionAt } from "../czml-time.ts";
import type { CzmlFeature, CzmlTrack, Interval } from "../czml-time.ts";
import type { LonLat, ModelHandle } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

type Loose = Record<string, any>;
/** 地面の層へ写す地物の属性（_i＝通し番号・_fc/_fo＝塗り・_lc/_lo/_lw＝線・_b/_h＝押し出しの下と上） */
export interface CzmlShapeProps { _i: number; _k: "fill" | "ext" | "line"; _fc?: string; _fo?: number; _lc?: string; _lo?: number; _lw?: number; _b?: number; _h?: number; _ol?: boolean; id?: unknown; name?: unknown; [k: string]: unknown }
export interface CzmlShape { type: "Feature"; geometry: { type: string; coordinates: unknown }; properties: CzmlShapeProps; [k: string]: unknown }
/** 高さのある線（ECEF の m・刻んだ後） */
export interface CzmlLine3D { id: unknown; p: number[]; color: string; width: number; avail: Interval[] | null; show: unknown }
/** 置く模型 */
export interface CzmlModelSpec {
	id: string; name: unknown; uri: string; scale: number; heightRef: string; avail: Interval[] | null; show: unknown;
	/** 静止の位置（[lon, lat, h]）か時刻つきの軌跡 */
	at: [number, number, number] | null; track: CzmlTrack | null;
	orientation: Loose | null; animate: boolean;
}
export interface CzmlScene { shapes: CzmlShape[]; shapeAvail: Array<{ avail: Interval[] | null; show: unknown }>; lines: CzmlLine3D[]; models: CzmlModelSpec[]; used: Set<number> }

const D2R = Math.PI / 180, ARC_STEP_M = 100000, R_M = 6371008.8;
// CSS の rgba → [色（不透明）, 不透明度]（GeoJSON の層は色と不透明度を別に持つ）
const splitAlpha = (c: string): [string, number] => {
	const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(c);
	return m ? [`rgb(${m[1]},${m[2]},${m[3]})`, +m[4]] : [c, 1];
};
const isTrue = (v: unknown, dflt: boolean) => typeof v === "boolean" ? v : typeof (v as Loose)?.boolean === "boolean" ? (v as Loose).boolean : dflt;
const num = (v: unknown, dflt: number | null = null): number | null => { const n = numberAt(v, 0, null); return n == null ? dflt : n; };
const uriOf = (v: unknown): string | null => typeof v === "string" ? v : typeof (v as Loose)?.uri === "string" ? (v as Loose).uri : Array.isArray(v) ? uriOf(v[0]) : null;
const flatEle = (e: unknown): number[] => Array.isArray(e) ? e.flat(4).map(Number) : typeof e === "number" ? [e] : [];

// 2 点（経緯度・高さ）の間を大円で刻む（高さは線形）＝ECEF の点列（始点を含み終点を含まない）
function greatCircle(a: number[], b: number[], none: boolean): number[] {
	// 測地の緯度・経度の向き（法線）の球で大円を引く（ECEF の向きは地心緯度＝混ぜると南北へずれる）
	const dir = (lon: number, lat: number) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)];
	const ua = dir(a[0], a[1]), ub = dir(b[0], b[1]);
	const ang = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2])));
	const n = none ? 1 : Math.max(1, Math.ceil(ang * R_M / ARC_STEP_M)), out: number[] = [];
	for (let i = 0; i < n; i++) {
		const t = i / n, s = Math.sin(ang);
		const k0 = s > 1e-12 ? Math.sin((1 - t) * ang) / s : 1 - t, k1 = s > 1e-12 ? Math.sin(t * ang) / s : t;
		const u = [ua[0] * k0 + ub[0] * k1, ua[1] * k0 + ub[1] * k1, ua[2] * k0 + ub[2] * k1];
		const lon = Math.atan2(u[1], u[0]) / D2R, lat = Math.atan2(u[2], Math.hypot(u[0], u[1])) / D2R;
		out.push(...(none ? llhToEcef(a[0], a[1], a[2]) : llhToEcef(lon, lat, a[2] + (b[2] - a[2]) * t)));
	}
	return out;
}

/** geopbf の地物（CZML 由来）→ 地面の層・3D の線・模型。used＝ここで描く地物の番号（本道 gint へは回さない） */
export function czmlSceneOf(features: CzmlFeature[], { baseUrl = null, trackOf = () => null }: { baseUrl?: string | null; trackOf?: (f: CzmlFeature) => CzmlTrack | null } = {}): CzmlScene {
	const shapes: CzmlShape[] = [], shapeAvail: CzmlScene["shapeAvail"] = [], lines: CzmlLine3D[] = [], models: CzmlModelSpec[] = [], used = new Set<number>();
	const resolve = (u: string) => { try { return baseUrl ? new URL(u, baseUrl).href : u; } catch { return u; } };
	features.forEach((f, i) => {
		const pr: Loose = f.properties || {}, cz: Loose = pr.czml && typeof pr.czml === "object" ? pr.czml : {}, g = f.geometry;
		if (!g) return;
		const avail = parseIntervals(pr.availability);
		// 模型（静止の点・時刻つきの軌跡）
		if (cz.model && uriOf(cz.model.gltf)) {
			const track = trackOf(f), timed = !!track;
			const at = !timed && g.type === "Point" ? [...(g.coordinates as number[]).slice(0, 2), typeof pr.ele === "number" ? pr.ele : 0] as [number, number, number] : null;
			if (at || track) {
				models.push({ id: String(pr.id ?? pr.name ?? `model${i}`), name: pr.name ?? null, uri: resolve(uriOf(cz.model.gltf)!), scale: num(cz.model.scale, 1)!, heightRef: String(cz.model.heightReference ?? "NONE").toUpperCase(),
					avail, show: cz.model.show ?? true, at, track, orientation: cz.orientation && typeof cz.orientation === "object" ? cz.orientation : null, animate: isTrue(cz.model.runAnimations, true) });
				if (!timed) used.add(i);   // 時刻つき＝軌跡は czml.ts（点・尾・札・吹き出し）にも残す
			}
			return;
		}
		if (trackOf(f)) return;
		const gp: Loose | null = cz.polygon || cz.rectangle || null;
		if (gp && (g.type === "Polygon" || g.type === "MultiPolygon")) {
			used.add(i);
			const fill = isTrue(gp.fill, true), outline = isTrue(gp.outline, false);
			const [fc, fo] = splitAlpha(colorOf(gp.material, "rgba(255,255,255,1)")), [lc, lo] = splitAlpha(colorOf(gp.outlineColor, "rgba(0,0,0,1)"));
			const ext = num(gp.extrudedHeight), h0 = num(gp.height, 0)!;
			const base: Omit<CzmlShapeProps, "_i" | "_k"> = { id: pr.id ?? null, name: pr.name ?? null };
			if (fill) {
				const p: CzmlShapeProps = ext != null && Math.abs(ext - h0) > 0.01 ? { ...base, _i: shapes.length, _k: "ext", _fc: fc, _fo: fo, _b: Math.min(h0, ext), _h: Math.max(h0, ext) } : { ...base, _i: shapes.length, _k: "fill", _fc: fc, _fo: fo };
				shapes.push({ type: "Feature", geometry: g as CzmlShape["geometry"], properties: p }); shapeAvail.push({ avail, show: gp.show ?? true });
			}
			if (outline) {
				// 外形線＝環を線に（地面に沿う・Cesium の outlineWidth は WebGL の線幅の都合で多くの環境で 1）
				const rings = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as number[][][][];
				shapes.push({ type: "Feature", geometry: { type: "MultiLineString", coordinates: rings.flat() }, properties: { ...base, _i: shapes.length, _k: "line", _lc: lc, _lo: lo, _lw: num(gp.outlineWidth, 1)!, _ol: true } });
				shapeAvail.push({ avail, show: gp.show ?? true });
			}
			return;
		}
		const pl: Loose | null = cz.polyline || null;
		if (pl && (g.type === "LineString" || g.type === "MultiLineString")) {
			used.add(i);
			const color = colorOf(pl.material, "rgba(255,255,255,1)"), width = num(pl.width, 1)!, ele = flatEle(pr.ele);
			const clamp = isTrue(pl.clampToGround, false) || !ele.some(v => Math.abs(v) > 0.01);
			if (clamp) {
				const [lc, lo] = splitAlpha(color);
				shapes.push({ type: "Feature", geometry: g as CzmlShape["geometry"], properties: { id: pr.id ?? null, name: pr.name ?? null, _i: shapes.length, _k: "line", _lc: lc, _lo: lo, _lw: width } });
				shapeAvail.push({ avail, show: pl.show ?? true });
				return;
			}
			const none = String(pl.arcType ?? "GEODESIC").toUpperCase() === "NONE";
			const parts = (g.type === "LineString" ? [g.coordinates] : g.coordinates) as number[][][];
			let k = 0;
			for (const seg of parts) {
				const pts = seg.map(c => [c[0], c[1], ele[k++] ?? 0]), p: number[] = [];
				for (let j = 0; j + 1 < pts.length; j++) p.push(...greatCircle(pts[j], pts[j + 1], none));
				if (pts.length) p.push(...llhToEcef(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[pts.length - 1][2]));
				if (p.length >= 6) lines.push({ id: pr.id ?? null, p, color, width, avail, show: pl.show ?? true });
			}
		}
	});
	return { shapes, shapeAvail, lines, models, used };
}

// ── 向き ──────────────────────────────────────────────────────────────────
// ECEF のベクトル → その地点の東・北の成分の方位（北から時計回りの度）
const bearingOf = (lon: number, lat: number, v: number[]): number => {
	const a = lon * D2R, b = lat * D2R;
	const e = -Math.sin(a) * v[0] + Math.cos(a) * v[1], n = -Math.sin(b) * Math.cos(a) * v[0] - Math.sin(b) * Math.sin(a) * v[1] + Math.cos(b) * v[2];
	return Math.atan2(e, n) / D2R;
};
// 四元数（x, y, z, w）で +X を回す
const rotX = (q: number[]): number[] => { const [x, y, z, w] = q; return [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)]; };
// unitQuaternion の値（静止 [x,y,z,w]・標本 [t,x,y,z,w,…]＋epoch）→ 時刻 ms の四元数
export function quaternionAt(o: Loose | null | undefined, ms: number): number[] | null {
	const v = o?.unitQuaternion;
	if (!Array.isArray(v) || v.length < 4) return null;
	if (v.length === 4) return v.map(Number);
	const ep = Date.parse(o!.epoch ?? ""), rows: number[][] = [];
	for (let i = 0; i + 4 < v.length; i += 5) {
		const t = typeof v[i] === "string" ? Date.parse(v[i]) : (Number.isFinite(ep) ? ep : 0) + +v[i] * 1000;
		rows.push([t, +v[i + 1], +v[i + 2], +v[i + 3], +v[i + 4]]);
	}
	if (!rows.length) return null;
	if (ms <= rows[0][0]) return rows[0].slice(1);
	if (ms >= rows[rows.length - 1][0]) return rows[rows.length - 1].slice(1);
	let j = 1; while (rows[j][0] < ms) j++;
	const a = rows[j - 1], b = rows[j], t = (ms - a[0]) / (b[0] - a[0]), s = a[1] * b[1] + a[2] * b[2] + a[3] * b[3] + a[4] * b[4] < 0 ? -1 : 1;
	const q = [1, 2, 3, 4].map(k => a[k] * (1 - t) + s * b[k] * t), l = Math.hypot(...q) || 1;   // 近い方へ線形に寄せて正規化（標本の間が細かい前提＝Cesium の既定の補間も線形）
	return q.map(x => x / l);
}
/** 模型の heading（北から時計回りの度）＝前（+X）の方位 − 90。向きの指定が無い＝0 */
export function modelHeadingAt(m: Pick<CzmlModelSpec, "orientation" | "track" | "at">, ms: number, lon: number, lat: number): number {
	const o = m.orientation;
	const q = quaternionAt(o, ms);
	if (q) return bearingOf(lon, lat, rotX(q)) - 90;
	if (o?.velocityReference && m.track) {
		const tr = m.track, a = positionAt(tr, ms - 500) ?? positionAt(tr, ms), b = positionAt(tr, ms + 500) ?? positionAt(tr, ms);
		if (a && b && Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 1e-6) return bearingOf(lon, lat, [b[0] - a[0], b[1] - a[1], b[2] - a[2]]) - 90;
	}
	return 0;
}
/** その時刻に出ているか（availability と show の区間） */
export const shownAt = (x: { avail: Interval[] | null; show: unknown }, ms: number): boolean => inIntervalsOf(x.avail, ms) && boolAt(x.show, ms, true);

// ── 地図へ置く ────────────────────────────────────────────────────────────
const SRC = "__czml-shapes", LAYERS = ["__czml-fill", "__czml-ext", "__czml-line"] as const;
export interface CzmlSceneHandle {
	/** 置き直す（前の分は外す）。lines は czml オーバーレイへ（post は czml.ts が持つ） */
	show(scene: CzmlScene, postLines: (lines: CzmlLine3D[]) => void): Promise<void>;
	clear(): void;
	readonly models: ModelHandle[];
	readonly counts: { shapes: number; lines: number; models: number };
}
export function createCzmlScene(map: GlobeMap): CzmlSceneHandle {
	let scene: CzmlScene | null = null, placed = new Map<string, { m: CzmlModelSpec; h: ModelHandle | null; loading: Promise<ModelHandle | null> | null }>(), gen = 0;
	let lastVis = "", layersOn = false;
	const ids = () => LAYERS.filter(id => map.getLayer?.(id));
	const removeLayers = () => { for (const id of ids()) map.removeLayer(id); if (map.getSource?.(SRC)) map.removeSource(SRC); layersOn = false; };
	const visFilter = (ms: number) => {
		if (!scene) return null;
		const vis = scene.shapeAvail.map((a, i) => shownAt(a, ms) ? i : -1).filter(i => i >= 0), key = vis.join(",");
		if (key === lastVis) return null;
		lastVis = key;
		return vis;
	};
	// 出ている物だけを源へ（区間の変わり目だけ・filter より確か＝押し出しも焼き直す）
	const applyVis = (ms: number) => {
		const vis = visFilter(ms); if (!vis || !layersOn || !scene) return;
		const src = map.getSource?.(SRC) as { setData?(d: unknown): void } | undefined;
		src?.setData?.({ type: "FeatureCollection", features: vis.map(i => scene!.shapes[i]) });
	};
	// 模型の置き方を時刻 ms に
	const terrainAt = (lon: number, lat: number) => { const v = map.queryTerrainElevation?.(lon, lat); return Number.isFinite(v) ? v as number : 0; };
	const poseAt = (m: CzmlModelSpec, ms: number): { at: LonLat; altitude: number; heading: number } | null => {
		let llh: number[] | null = m.at;
		if (m.track) { const q = positionAt(m.track, ms); llh = q ? ecefToLlh(q[0], q[1], q[2]) : null; }
		if (!llh) return null;
		const alt = m.heightRef === "CLAMP_TO_GROUND" ? 0 : m.heightRef === "RELATIVE_TO_GROUND" ? llh[2] : llh[2] - terrainAt(llh[0], llh[1]);
		return { at: [llh[0], llh[1]], altitude: alt, heading: modelHeadingAt(m, ms, llh[0], llh[1]) };
	};
	const placeModels = (ms: number) => {
		const my = gen;
		for (const [slot, it] of placed) {
			const on = shownAt(it.m, ms), pose = on ? poseAt(it.m, ms) : null;
			if (!pose) { if (it.h) { it.h.clear(); it.h = null; } continue; }
			if (it.h) { it.h.setTransform({ at: pose.at, altitude: pose.altitude, heading: pose.heading }); continue; }
			if (it.loading) continue;
			it.loading = map.gadget.model(it.m.uri, { at: pose.at, altitude: pose.altitude, heading: pose.heading, scale: it.m.scale, slot, name: String(it.m.name ?? it.m.id), fit: false, gizmo: false })
				.then((h: ModelHandle) => {
					it.loading = null;
					if (my !== gen) { h.clear(); return null; }
					it.h = h;
					if (it.m.animate && h.animations?.length) h.play();
					placeModels(map.clock.time);   // 読む間に時計が進んだ分を合わせる（区間の外へ出ていれば外す）
					return h;
				}, (e: unknown) => { it.loading = null; console.warn("[czml] model", it.m.uri, e); return null; });
		}
	};
	const onTime = () => { const ms = map.clock.time; applyVis(ms); placeModels(ms); };
	const self: CzmlSceneHandle = {
		get models() { return [...placed.values()].map(v => v.h).filter((h): h is ModelHandle => !!h); },
		get counts() { return { shapes: scene?.shapes.length ?? 0, lines: scene?.lines.length ?? 0, models: placed.size }; },
		async show(sc, postLines) {
			self.clear();
			gen++;
			scene = sc;
			if (sc.shapes.length) {
				map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: sc.shapes.filter((_, i) => shownAt(sc.shapeAvail[i], map.clock.time)) } });
				map.addLayer({ id: "__czml-fill", type: "fill", source: SRC, filter: ["==", ["get", "_k"], "fill"], paint: { "fill-color": ["get", "_fc"], "fill-opacity": ["get", "_fo"] } });
				map.addLayer({ id: "__czml-ext", type: "fill-extrusion", source: SRC, filter: ["==", ["get", "_k"], "ext"], paint: { "fill-extrusion-color": ["get", "_fc"], "fill-extrusion-opacity": 1, "fill-extrusion-height": ["get", "_h"], "fill-extrusion-base": ["get", "_b"] } });
				map.addLayer({ id: "__czml-line", type: "line", source: SRC, filter: ["==", ["get", "_k"], "line"], paint: { "line-color": ["get", "_lc"], "line-opacity": ["get", "_lo"], "line-width": ["get", "_lw"] } });
				layersOn = true;
			}
			postLines(sc.lines);
			sc.models.forEach((m, i) => placed.set(`czml:${m.id}:${i}`, { m, h: null, loading: null }));
			lastVis = sc.shapeAvail.map((a, i) => shownAt(a, map.clock.time) ? i : -1).filter(i => i >= 0).join(",");   // 源は今の時刻の分で作った
			map.clock.on("change", onTime); map.clock.on("tick", onTime);
			onTime();
		},
		clear() {
			gen++;
			map.clock.off("change", onTime); map.clock.off("tick", onTime);
			removeLayers();
			for (const it of placed.values()) it.h?.clear();
			placed = new Map(); scene = null; lastVis = "";
		},
	};
	return self;
}
