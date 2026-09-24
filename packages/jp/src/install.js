// 日本の地域パックが起動後の map に足す物（LAYERS.md 段階 2 S3・2026-09-23）。ホストの拡張面（host）だけを使う。
//   host＝{ opts, renderer, cam, size, dpr, requestDraw, overlay(globe の選択/識別の器), spawnWorker, ownTip, hooks, t, dbg, assetBase, onDestroy, unproject, cameraState }
// 今は e-Stat 小地域（map.estat）。map.overlay.* への同名は互換（旧 9/20 までの口）。
import { createEstat } from "./estat.js";
import { installMojDebug } from "./moj-dbg.js";   // 法務省地図の開発用の手（静的 import＝仮想時間の検定でも解決する）
import { unproject, cameraState } from "@ortho-earth/core";

export function installJapan(map, host) {
	const estat = createEstat({ renderer: host.renderer, cam: host.cam, size: host.size, dpr: host.dpr, requestDraw: host.requestDraw,
		tip: host.ownTip, say: host.overlay.say, t: host.t, spawnWorker: host.spawnWorker, hiMask: host.overlay.HI_MASK, unproject, cameraState });
	host.overlay.use({ active: estat.isEstatActive, identify: estat.identify, clear: estat.clear });   // クリック識別と clearOverlay を e-Stat が引き受ける
	// ホバー：smallAreaHover（census2020 限定）＝estat 中は町丁目を点in面で識別し名前 tip＋境界太線（ミスは gint へフォールバック）
	host.hooks.hover.push((x, y) => !!host.opts.smallAreaHover && estat.isEstatActive() && estat.hoverAt(x, y));
	// 消費者の口＝map.estat（census2020：loadEstat / highlightKey / setIdentifyHandler / clearOverlay / setSelectionMask）
	const facade = { loadEstat: estat.loadEstat, highlightKey: estat.highlightKey, hoverAt: estat.hoverAt, isEstatActive: estat.isEstatActive, setIdentifyHandler: estat.setIdentifyHandler,
		clearOverlay: host.overlay.clearOverlay, setSelectionMask: host.overlay.setSelectionMask, loadOverlay: host.overlay.loadOverlay };
	map.estat = facade;
	Object.assign(map.overlay, facade);   // ★互換：map.overlay.loadEstat 等（9/20 までの口）＝次の大版まで
	host.dbg.__loadEstat = estat.loadEstat;
	host.dbg.__tokyo = () => estat.loadEstat(Array.from({ length: 23 }, (_, i) => 13101 + i));   // 東京23区の小地域（コンソールの道具）
	installMojDebug(map, host);
	host.onDestroy(() => { estat.destroy(); delete host.dbg.__loadEstat; delete host.dbg.__tokyo; });   // e-Stat worker（立っていれば）・自分が生やした手は自分で片付ける
}
