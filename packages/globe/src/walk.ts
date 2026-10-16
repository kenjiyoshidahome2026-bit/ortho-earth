// 一人称歩行の中身（第 3 波 W3・2026-10-12）＝map.walk(opts) の builtin の実装（registry.handlers に plugin の "walk" があればそちらが勝つ＝F6 の約束どおり）。
//   足元＝deps.heightAt（描いている地形と同じ出どころ・非同期＝着くまでは前の値）・目＝足元＋eyeHeight。
//   衝突（opts.collide）＝deps.wallHeightAt(lon, lat)（基図の建物の足跡＋geojson の押し出し＝「その点に立つ壁の高さ m」）が膝（0.5 m）より高ければ進まない（簡易＝滑らない）。
//   カメラ＝注視点の流儀に写す：目から D m 先（水平）・見下ろし lookDown° の点を注視点に、pitch＝90−lookDown・distance＝D/cos(lookDown)（map.setCamera）。歩行中は maxPitch を 89° に上げ、止めたら戻す。
//   鍵（opts.keys）＝W/↑ 前・S/↓ 後・A/D 横・←/→ か Q/E 回る・R/F 見上げ/見下ろし・Shift で 3 倍・Esc で止める。文字入力中は取らない。ドラッグ＝見回す（bearing・lookDown）。
//   歩行中は地図の keyboard・dragPan・dragRotate・scrollZoom・doubleClickZoom を止め、止めたら元へ。
//   手綱（builtin の追加）＝step(forwardM, strafeM)・turn(deg)・look(deg)・position() → { lng, lat, ground, eyeHeight, bearing, lookDown }（検定・台本から動かす口）。
import { isTypingTarget } from "@ortho-earth/core";
import type { HandlerName, WalkOptions } from "../globe.d.ts";
import type { GlobeMap } from "./types/map.ts";

/** builtin の歩行の中身（map.walk の手綱が包む） */
export interface WalkInner {
	start(): void; stop(): void; readonly active: boolean;
	step(forwardM: number, strafeM?: number): number; turn(deg: number): void; look(deg: number): void;
	position(): { lng: number; lat: number; ground: number; eyeHeight: number; bearing: number; lookDown: number };
	/** 検定・外の標高で足元を置き直す */
	setGround(hM: unknown): void;
}
/** 足元・壁の出どころ（描いている地形・基図の建物） */
export interface WalkDeps { heightAt(lng: number, lat: number): Promise<number> | number; wallHeightAt?(lng: number, lat: number): number; radiusM?: number }
type WalkKey = "forward" | "back" | "left" | "right" | "turnL" | "turnR" | "lookUp" | "lookDown";
const D2R = Math.PI / 180;
const KEYS: Record<WalkKey, string[]> = { forward: ["w", "W", "ArrowUp"], back: ["s", "S", "ArrowDown"], left: ["a", "A"], right: ["d", "D"], turnL: ["ArrowLeft", "q", "Q"], turnR: ["ArrowRight", "e", "E"], lookUp: ["r", "R"], lookDown: ["f", "F"] };
const KEY_ALL = new Set(Object.values(KEYS).flat());
const WALK_DEFAULTS = Object.freeze({ speed: 1.4, eyeHeight: 1.7, collide: true, keys: true, lookDown: 5, turnSpeed: 90, lookSpeed: 45, lookDistance: 30, mouse: true, run: 3 });
const KNEE_M = 0.5;
export function createWalk(map: GlobeMap, opts: WalkOptions, deps: WalkDeps): WalkInner {
	const o = { ...WALK_DEFAULTS, ...opts };
	const R = deps.radiusM || 6371000, mDeg = R * D2R;   // 1° の m（緯線は cos で割る）
	const cam0 = map.getCamera();
	const st = { lng: cam0.lng, lat: cam0.lat, bearing: cam0.heading || 0, lookDown: o.lookDown, ground: cam0.height || 0, eyeHeight: o.eyeHeight };
	let active = false, raf = 0, lastT = 0, prevMax: number | null = null, prevH: Record<string, boolean> | null = null, groundReq = 0, groundAt: number[] | null = null, ac: AbortController | null = null, drag: { x: number; y: number } | null = null;
	const held = new Set<string>(); let shift = false;
	const offset = (lng: number, lat: number, dE: number, dN: number): number[] => [lng + dE / (mDeg * Math.max(1e-6, Math.cos(lat * D2R))), lat + dN / mDeg];
	const askGround = (lng: number, lat: number, force = false): void => {
		const now = performance.now();
		if (!force && (now - groundReq < 100 || (groundAt && Math.hypot((lng - groundAt[0]) * mDeg * Math.cos(lat * D2R), (lat - groundAt[1]) * mDeg) < 1))) return;
		groundReq = now; groundAt = [lng, lat];
		Promise.resolve(deps.heightAt(lng, lat)).then(h => { if (Number.isFinite(h) && groundAt && groundAt[0] === lng && groundAt[1] === lat) st.ground = Math.max(0, h); }, () => {});
	};
	const wallAt = (lng: number, lat: number): number => { try { return o.collide && deps.wallHeightAt ? +deps.wallHeightAt(lng, lat) || 0 : 0; } catch { return 0; } };
	function place(): void {
		const ld = Math.max(-60, Math.min(80, st.lookDown)) * D2R, D = o.lookDistance, eye = st.ground + st.eyeHeight;
		const b = st.bearing * D2R, [tl, tt] = offset(st.lng, st.lat, Math.sin(b) * D, Math.cos(b) * D);
		map.setCamera({ lng: tl, lat: tt, height: eye - D * Math.tan(ld), distance: D / Math.cos(ld), heading: st.bearing, pitch: 90 - st.lookDown });
	}
	// 前・横（m）に歩く。壁があれば止まる（戻り＝動いた距離 m）
	function step(fwd: number, side?: number): number {
		if (!fwd && !side) return 0;
		const b = st.bearing * D2R, dE = Math.sin(b) * fwd + Math.cos(b) * side!, dN = Math.cos(b) * fwd - Math.sin(b) * side!;
		const len = Math.hypot(dE, dN), n = Math.max(1, Math.ceil(len / 0.5));   // 0.5 m 刻みで壁を見る（一跨ぎで抜けない）
		let moved = 0;
		for (let i = 0; i < n; i++) {
			const [nl, nt] = offset(st.lng, st.lat, dE / n, dN / n);
			if (wallAt(nl, nt) > KNEE_M) break;
			st.lng = nl; st.lat = nt; moved += len / n;
		}
		if (moved > 0) { askGround(st.lng, st.lat); if (active) place(); }
		return moved;
	}
	const turn = (deg: number): void => { st.bearing = ((st.bearing + deg) % 360 + 360) % 360; if (active) place(); };
	const look = (deg: number): void => { st.lookDown = Math.max(-60, Math.min(80, st.lookDown + deg)); if (active) place(); };
	function frame(t: number): void {
		if (!active) return;
		const dt = Math.min(0.1, lastT ? (t - lastT) / 1000 : 0); lastT = t;
		const has = (k: WalkKey): boolean => KEYS[k].some(x => held.has(x));
		const v = o.speed * (shift ? o.run : 1) * dt;
		const fwd = (has("forward") ? 1 : 0) - (has("back") ? 1 : 0), side = (has("right") ? 1 : 0) - (has("left") ? 1 : 0);
		const tr = (has("turnR") ? 1 : 0) - (has("turnL") ? 1 : 0), lk = (has("lookDown") ? 1 : 0) - (has("lookUp") ? 1 : 0);
		if (tr) st.bearing = ((st.bearing + tr * o.turnSpeed * dt) % 360 + 360) % 360;
		if (lk) st.lookDown = Math.max(-60, Math.min(80, st.lookDown + lk * o.lookSpeed * dt));
		if (fwd || side) step(fwd * v, side * v); else if (tr || lk) place();
		if (!held.size) { raf = 0; return; }   // 鍵を離したら rAF を止める（地形の到着は次の鍵か ground の更新で乗る）
		raf = requestAnimationFrame(frame);
	}
	const arm = (): void => { if (!raf && active) { lastT = 0; raf = requestAnimationFrame(frame); } };
	function onKey(e: KeyboardEvent, down: boolean): void {
		if (!active || isTypingTarget()) return;
		shift = e.shiftKey;
		if (down && e.key === "Escape") { h.stop(); return; }
		if (!KEY_ALL.has(e.key)) return;
		if (down) held.add(e.key); else held.delete(e.key);
		e.preventDefault(); e.stopImmediatePropagation();
		if (down) arm();
	}
	const el = (): HTMLElement | null | undefined => map.mapEl || (map as GlobeMap & { getCanvas?(): HTMLCanvasElement }).getCanvas?.()?.parentElement;
	function onPointer(e: PointerEvent, kind: "down" | "move" | "up"): void {
		if (!active || !o.mouse) return;
		if (kind === "down") { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY }; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); }
		else if (kind === "move") { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY }; st.bearing = ((st.bearing + dx * 0.3) % 360 + 360) % 360; st.lookDown = Math.max(-60, Math.min(80, st.lookDown - dy * 0.2)); place(); }
		else drag = null;
	}
	const HANDLERS: HandlerName[] = ["keyboard", "dragPan", "dragRotate", "scrollZoom", "doubleClickZoom"];
	const h: WalkInner = {
		get active() { return active; },
		start() {
			if (active) return;
			active = true;
			const c = map.getCamera(); st.lng = c.lng; st.lat = c.lat; st.bearing = c.heading || 0;   // 今の注視点から歩き始める（足元＝注視点）
			prevMax = map.getMaxPitch(); map.setMaxPitch(89);
			prevH = Object.fromEntries(HANDLERS.map(n => [n, map.handlerOn(n)])); for (const n of HANDLERS) map.setHandler(n, false);
			ac = new AbortController();
			if (o.keys && typeof window !== "undefined") { window.addEventListener("keydown", e => onKey(e, true), { capture: true, signal: ac.signal }); window.addEventListener("keyup", e => onKey(e, false), { capture: true, signal: ac.signal }); window.addEventListener("blur", () => held.clear(), { signal: ac.signal }); }
			const E = el();
			if (E && o.mouse) { E.addEventListener("pointerdown", e => onPointer(e, "down"), { signal: ac.signal }); E.addEventListener("pointermove", e => onPointer(e, "move"), { signal: ac.signal }); E.addEventListener("pointerup", e => onPointer(e, "up"), { signal: ac.signal }); E.addEventListener("pointercancel", e => onPointer(e, "up"), { signal: ac.signal }); }
			askGround(st.lng, st.lat, true); place();
		},
		stop() {
			if (!active) return;
			active = false; held.clear(); drag = null;
			if (raf) { cancelAnimationFrame(raf); raf = 0; }
			ac?.abort(); ac = null;
			if (prevH) for (const n of HANDLERS) map.setHandler(n, prevH[n]); prevH = null;
			if (prevMax != null) map.setMaxPitch(prevMax); prevMax = null;
		},
		step, turn, look,
		position: () => ({ lng: st.lng, lat: st.lat, ground: st.ground, eyeHeight: st.eyeHeight, bearing: st.bearing, lookDown: st.lookDown }),
		setGround: (hM: unknown) => { if (Number.isFinite(+(hM as number))) { st.ground = Math.max(0, +(hM as number)); if (active) place(); } },   // 検定・外の標高で足元を置き直す
	};
	return h;
}
// 点が多角形（GeoJSON の Polygon／MultiPolygon・[lng, lat]）の中か（偶奇・穴も見る）
export function pointInPolygon(lng: number, lat: number, geom: { type: string; coordinates?: unknown } | null | undefined): boolean {
	if (!geom) return false;
	const polys = (geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : []) as number[][][][];
	const inRing = (ring: number[][]): boolean => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi || 1e-18) + xi) c = !c; } return c; };
	for (const p of polys) { if (!p.length || !inRing(p[0])) continue; if (p.slice(1).some(inRing)) continue; return true; }
	return false;
}
