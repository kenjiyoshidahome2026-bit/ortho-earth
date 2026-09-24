// 背景の地球儀＝地球儀のホスト @ortho-earth/globe（地域なし＝japan の殻 app.js は通らない・LAYERS.md 掟 5）。旧＝ortho-map（v1）の orthoMap({target:body})。
// エンジンは build 時に同梱（A 裁定 2026-09-23＝内製アプリは本番で /japan/lib を実行時に食わない・census2020/world と同じ型）。
// CSS もエンジンのチャンクに付いて来る（旧＝/japan/lib/ortho-japan.css の link は不要）。
import { createGintView } from "common/gintView";

const engineP = import("@ortho-earth/globe");

// 地球の半径＝画面短辺の 1/4（旧 v1 と同じ構図。v2 も 256px 世界＝同じ式）
export const overviewZoom = Math.log2(Math.min(innerWidth, innerHeight) / 2 * 0.5 / 256 * Math.PI * 2);

// 容れ物：.globe-bg（fixed 全面）の中の div をエンジンへ貸す（エンジンは借りた div の id を "map" へ改名する＝寸法はクラスで与える）
const frame = document.body.insertBefore(Object.assign(document.createElement("div"), { className: "globe-bg" }), document.body.firstChild);
const host = frame.appendChild(document.createElement("div"));

export const mapP = engineP.then(m => m.createGlobe({   // GeoPBF のデモ＝世界の器（地域の申告なし＝LAYERS.md 段階 2 S6）。落とした地物を寄って見るので z の上限は既定のまま
	target: host,
	view: /^#-?\d/.test(location.hash) ? location.hash : `#${overviewZoom.toFixed(2)}/0/0`,
	lang: "en",
	countryTip: false,         // データの tip と国名 tip を混ぜない
	persistView: false,        // 待ち受けの自転で /japan/ の「前回の視点」（同オリジンの localStorage）を上書きしない
	keyboard: () => document.querySelector(".demo")?.classList.contains("viewing"),   // 矢印キーは地図に入っている間だけ（待ち受け中はパネル側のもの）
	assetBase: __GLOBE_ASSETS__,   // 実行時アセット（koppen-clim.png 等）＝globe の家（本番 /globe/・dev は apps/ortho-globe/public を /@fs で）
}));
export const viewP = mapP.then(map => createGintView(map, { overviewZoom }));

// 地図の道具（旧 v1 と同じ顔ぶれ：north→compass）。待ち受け中はパネルの下＝初めて地図に入る時に載せる
// （載せた瞬間から Z=全画面・@=現在地 等のショートカットが window で生きるため）
let tools = false;
export function mountTools(map) {
	if (tools) return; tools = true;
	map.gadget.close(); map.gadget.compass(); map.gadget.zoom(); map.gadget.full(); map.gadget.cpos(); map.gadget.measure(); map.gadget.shot();
}
