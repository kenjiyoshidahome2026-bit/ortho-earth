// 模型の置き方の取っ手（ギズモ・2026-10-18）＝生成 AI の GLB を「落として・つまんで・置く」ための DOM の部品（gadgets/model.js の handle.gizmo(true)）。
//   錨の丸＝ドラッグで移動（落とした地点の地面の点を追う・つまんだ所との差を保つ＝飛ばない）。
//   輪の上の丸＝回転（錨から見た地面の点の方位の差を heading に足す＝傾いた・回した視点でも正しい）。
//   四角＝倍率（錨からの地面の距離の比）。✓＝畳む（gizmo:"auto" の模型は模型をクリックで出し直す＝model.js）。
//   描くのは mapEl の上の SVG 1 枚（marker.js と同じく描くたび＝onFrame＋move に投影し直す）。輪は地面の円を 48 点投影した多角形＝傾けると楕円に見える（地面に貼り付いて見える）。
//   輪の半径＝模型の外接矩形の 0.6 倍（m）。画面で 36px より小さければ 36px に広げる（遠くからでもつまめる）。地図のドラッグは pointerdown の stopPropagation で止める（marker と同じ）。
import type { LonLat, ModelHandle, ModelTransform } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";

export interface Gizmo { destroy(): void; refresh(): void; readonly el: SVGSVGElement }
export interface GizmoOpts { onDone?: () => void }
type GizmoMap = Pick<GlobeMap, "mapEl" | "makeProjectorH" | "onFrame" | "on" | "off" | "unprojectXY">;

const CSS = `
.oe-gizmo{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:4;overflow:visible;--oe-gz:var(--qm-accent,#2b7de9)}
.oe-gizmo .gz-ring{fill:none;stroke:var(--oe-gz);stroke-width:1.5;stroke-dasharray:4 4;opacity:.8}
.oe-gizmo .gz-spoke{stroke:var(--oe-gz);stroke-width:1.5;opacity:.8}
.oe-gizmo .gz-knob{pointer-events:auto;touch-action:none;fill:#fff;stroke:var(--oe-gz);stroke-width:2;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
.oe-gizmo .gz-move{cursor:move;fill:var(--oe-gz);stroke:#fff}
.oe-gizmo .gz-rot{cursor:grab}
.oe-gizmo .gz-scale{cursor:nwse-resize}
.oe-gizmo .gz-knob:active{cursor:grabbing}
.oe-gizmo .gz-done{pointer-events:auto;cursor:pointer}
.oe-gizmo .gz-done rect{fill:var(--qm-surface,#fff);stroke:var(--oe-gz);stroke-width:1.5}
.oe-gizmo .gz-done text{fill:var(--oe-gz);font:bold 13px/1 system-ui,sans-serif;text-anchor:middle;dominant-baseline:central;pointer-events:none}
.oe-gizmo.gz-busy .gz-ring,.oe-gizmo.gz-busy .gz-spoke{opacity:1}`;
let cssOn = false;
const ensureCss = () => { if (cssOn) return; cssOn = true; const s = document.createElement("style"); s.textContent = CSS; document.head.append(s); };
const SVG = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const M_LAT = 110950, mLon = (lat: number) => Math.max(1e-3, 111320 * Math.cos(lat * Math.PI / 180));   // 1° の実寸（m）
/** 錨 at から東 e・北 n（m）の地面の点 */
const offsetLL = (at: LonLat, e: number, n: number): LonLat => [at[0] + e / mLon(at[1]), at[1] + n / M_LAT];
/** 錨から見た地面の点の方位（北から時計回り・度）と距離（m） */
const polar = (at: LonLat, p: LonLat) => { const e = (p[0] - at[0]) * mLon(at[1]), n = (p[1] - at[1]) * M_LAT; return { bearing: Math.atan2(e, n) * 180 / Math.PI, dist: Math.hypot(e, n) }; };
const RING_N = 48, MIN_PX = 36;

export function createGizmo(mapIn: GlobeMap, h: ModelHandle, { onDone }: GizmoOpts = {}): Gizmo {
	ensureCss();
	const map = mapIn as unknown as GizmoMap;
	const svg = el("svg", { class: "oe-gizmo", "aria-hidden": "true" });
	const ring = el("path", { class: "gz-ring" }), spoke = el("line", { class: "gz-spoke" });
	const kMove = el("circle", { class: "gz-knob gz-move", r: 8 }), kRot = el("circle", { class: "gz-knob gz-rot", r: 7 }), kScale = el("rect", { class: "gz-knob gz-scale", width: 13, height: 13, rx: 2 });
	const done = el("g", { class: "gz-done" }); done.append(el("rect", { width: 22, height: 22, rx: 4 }), Object.assign(el("text", { x: 11, y: 11 }), { textContent: "✓" }));
	done.setAttribute("role", "button"); done.setAttribute("aria-label", "Done");
	svg.append(ring, spoke, kScale, kRot, kMove, done);
	map.mapEl.append(svg);
	let proj: ReturnType<GizmoMap["makeProjectorH"]> | null = null, radiusM = 10, alive = true;
	const radiusOf = (tf: ModelTransform) => {   // 輪の半径（m）＝外接矩形の 0.6 倍（倍率は bbox に畳まれている）
		const bb = h.bbox; if (!bb) return 10;
		const r = 0.6 * Math.max((bb[2] - bb[0]) * mLon(tf.at[1]), (bb[3] - bb[1]) * M_LAT);
		return Math.max(1, Math.min(5e4, r || 10));
	};
	const place = () => {
		if (!alive) return;
		const tf = h.getTransform(); if (!h.name) { svg.style.display = "none"; return; }
		proj = map.makeProjectorH({ terrain: true });
		const c = proj(tf.at[0], tf.at[1], tf.altitude);
		if (c[2] < 0) { svg.style.display = "none"; return; }
		svg.style.display = "";
		radiusM = radiusOf(tf);
		const hd = tf.heading * Math.PI / 180;
		let k = proj(...offsetLL(tf.at, radiusM * Math.sin(hd), radiusM * Math.cos(hd)), tf.altitude);
		const px = Math.hypot(k[0] - c[0], k[1] - c[1]);
		if (px < MIN_PX) { radiusM *= MIN_PX / Math.max(px, 1e-6); k = proj(...offsetLL(tf.at, radiusM * Math.sin(hd), radiusM * Math.cos(hd)), tf.altitude); }   // 遠くからでもつまめる大きさ
		let d = "";
		for (let i = 0; i <= RING_N; i++) { const a = i / RING_N * Math.PI * 2, p = proj(...offsetLL(tf.at, radiusM * Math.sin(a), radiusM * Math.cos(a)), tf.altitude); d += (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }
		ring.setAttribute("d", d);
		spoke.setAttribute("x1", c[0].toFixed(1)); spoke.setAttribute("y1", c[1].toFixed(1)); spoke.setAttribute("x2", k[0].toFixed(1)); spoke.setAttribute("y2", k[1].toFixed(1));
		kMove.setAttribute("cx", c[0].toFixed(1)); kMove.setAttribute("cy", c[1].toFixed(1));
		kRot.setAttribute("cx", k[0].toFixed(1)); kRot.setAttribute("cy", k[1].toFixed(1));
		const s = proj(...offsetLL(tf.at, radiusM * Math.sin(hd + Math.PI / 2), radiusM * Math.cos(hd + Math.PI / 2)), tf.altitude);   // 倍率の四角＝heading の右手
		kScale.setAttribute("x", (s[0] - 6.5).toFixed(1)); kScale.setAttribute("y", (s[1] - 6.5).toFixed(1));
		done.setAttribute("transform", `translate(${(c[0] + 14).toFixed(1)} ${(c[1] - 36).toFixed(1)})`);
	};
	// ドラッグ＝地面の点（unprojectXY）で測る＝傾けた・回した視点でも、指の下の地面がそのまま模型の動きになる
	const ground = (e: PointerEvent): LonLat | null => { const r = map.mapEl.getBoundingClientRect(); return map.unprojectXY(e.clientX - r.left, e.clientY - r.top); };
	const drag = (knob: SVGElement, apply: (g0: LonLat, g: LonLat, t0: ModelTransform) => Partial<ModelTransform> | null) => {
		knob.addEventListener("pointerdown", e => {
			if (!alive) return;
			e.stopPropagation(); e.preventDefault();
			const g0 = ground(e); if (!g0) return;
			const t0 = h.getTransform();
			try { knob.setPointerCapture(e.pointerId); } catch { /* 合成イベント等＝捕捉なしで続ける */ }
			svg.classList.add("gz-busy");
			const mv = (ev: PointerEvent) => { const g = ground(ev); if (!g) return; const tf = apply(g0, g, t0); if (tf) h.setTransform(tf); };
			const up = () => { knob.removeEventListener("pointermove", mv); knob.removeEventListener("pointerup", up); knob.removeEventListener("pointercancel", up); svg.classList.remove("gz-busy"); };
			knob.addEventListener("pointermove", mv); knob.addEventListener("pointerup", up); knob.addEventListener("pointercancel", up);
		});
	};
	drag(kMove, (g0, g, t0) => ({ at: [t0.at[0] + (g[0] - g0[0]), t0.at[1] + (g[1] - g0[1])] }));
	drag(kRot, (g0, g, t0) => ({ heading: t0.heading + polar(t0.at, g).bearing - polar(t0.at, g0).bearing }));
	drag(kScale, (g0, g, t0) => { const d0 = polar(t0.at, g0).dist, d = polar(t0.at, g).dist; return d0 > 1e-6 ? { scale: t0.scale * d / d0 } : null; });
	done.addEventListener("pointerdown", e => { e.stopPropagation(); });
	done.addEventListener("click", e => { e.stopPropagation(); onDone?.(); });
	const offFrame = map.onFrame(place);
	map.on("move", place);
	place();
	return {
		el: svg,
		refresh: place,
		destroy() { if (!alive) return; alive = false; offFrame?.(); try { (map as { off?: (ev: string, f: () => void) => unknown }).off?.("move", place); } catch { /* off の無い顔 */ } svg.remove(); },
	};
}
