// 日本の地域パックが起動後の map に足す物（LAYERS.md 段階 2 S3・2026-09-23）。ホストの拡張面（host）だけを使う。
//   host＝{ opts, renderer, cam, size, dpr, requestDraw, overlay(globe の選択/識別の器), spawnWorker, ownTip, hooks, t, dbg, assetBase, onDestroy, unproject, cameraState }
// 今は e-Stat 小地域（map.estat）。map.overlay.* への同名は互換（旧 9/20 までの口）。
import { createEstat } from "./estat.ts";
import type { Estat } from "./estat.ts";
import { installMojDebug } from "./moj-dbg.ts";   // 法務省地図の開発用の手（静的 import＝仮想時間の検定でも解決する）
import type { MojDbg, MojDbgMap } from "./moj-dbg.ts";
import { unproject, cameraState } from "@ortho-earth/core";
import type { CameraPose, Renderer } from "@ortho-earth/core";

/** globe の選択／識別の器（host.overlay）のうち使う物 */
export interface OverlayHost {
	say(s: string): void;
	HI_MASK: unknown;
	use(ext: { active(): boolean; identify(lon: number, lat: number): void; clear(): void }): void;
	clearOverlay: unknown;
	setSelectionMask: unknown;
	loadOverlay: unknown;
}
/** ホストの拡張面（globe が install(map, host) に渡す物）のうち使う物 */
export interface JpHost {
	opts: { smallAreaHover?: boolean };
	renderer: Renderer;
	cam: CameraPose;
	size: { w: number; h: number };
	dpr: number;
	requestDraw(): void;
	overlay: OverlayHost;
	ownTip?: ((s: string | null) => void) | null;
	hooks: { hover: ((x: number, y: number) => boolean)[] };
	t(key: string, ...args: unknown[]): string;
	dbg: MojDbg;
	assetBase: string;
	onDestroy(fn: () => void): void;
}
/** 消費者の口 map.estat（census2020：loadEstat / highlightKey / setIdentifyHandler / clearOverlay / setSelectionMask） */
export interface EstatFacade {
	loadEstat: Estat["loadEstat"]; highlightKey: Estat["highlightKey"]; hoverAt: Estat["hoverAt"]; isEstatActive: Estat["isEstatActive"]; setIdentifyHandler: Estat["setIdentifyHandler"];
	clearOverlay: unknown; setSelectionMask: unknown; loadOverlay: unknown;
}
export interface JpMap extends MojDbgMap { estat?: EstatFacade; overlay: Record<string, unknown> }

export function installJapan(map: JpMap, host: JpHost): void {
	const estat = createEstat({ renderer: host.renderer, cam: host.cam, size: host.size, dpr: host.dpr, requestDraw: host.requestDraw,
		tip: host.ownTip, say: host.overlay.say, t: host.t, hiMask: host.overlay.HI_MASK, unproject, cameraState });
	host.overlay.use({ active: estat.isEstatActive, identify: estat.identify, clear: estat.clear });   // クリック識別と clearOverlay を e-Stat が引き受ける
	// ホバー：smallAreaHover（census2020 限定）＝estat 中は町丁目を点in面で識別し名前 tip＋境界太線（ミスは gint へフォールバック）
	host.hooks.hover.push((x, y) => !!host.opts.smallAreaHover && estat.isEstatActive() && estat.hoverAt(x, y));
	// 消費者の口＝map.estat（census2020：loadEstat / highlightKey / setIdentifyHandler / clearOverlay / setSelectionMask）
	const facade: EstatFacade = { loadEstat: estat.loadEstat, highlightKey: estat.highlightKey, hoverAt: estat.hoverAt, isEstatActive: estat.isEstatActive, setIdentifyHandler: estat.setIdentifyHandler,
		clearOverlay: host.overlay.clearOverlay, setSelectionMask: host.overlay.setSelectionMask, loadOverlay: host.overlay.loadOverlay };
	map.estat = facade;
	Object.assign(map.overlay, facade);   // ★互換：map.overlay.loadEstat 等（9/20 までの口）＝次の大版まで
	host.dbg.__loadEstat = estat.loadEstat;
	host.dbg.__tokyo = () => estat.loadEstat(Array.from({ length: 23 }, (_, i) => 13101 + i));   // 東京23区の小地域（コンソールの道具）
	installMojDebug(map, host);
	host.onDestroy(() => { estat.destroy(); delete host.dbg.__loadEstat; delete host.dbg.__tokyo; });   // e-Stat worker（立っていれば）・自分が生やした手は自分で片付ける
}
