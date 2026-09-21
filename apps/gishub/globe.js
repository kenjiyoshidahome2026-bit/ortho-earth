// 背景の地球儀＝ortho-japan エンジン（gint v2）。旧＝ortho-map（v1）の orthoMap({target:body})。
// SDK 二重構成（census2020 と同じ型）：dev＝ソース直（編集即反映）・本番＝/japan/lib/ の SDK 配布物
// ＝japan 本体と**同じ URL のエンジン**を食う（ブラウザキャッシュを共有）。URL は変数経由＝vite の import 解析を素通りさせる。
import { createGintView } from "common/gintView";

let engineP;
if (import.meta.env.PROD) {
	document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/japan/lib/ortho-japan.css" }));
	const LIB = "/japan/lib/ortho-japan.js";
	engineP = import(/* @vite-ignore */ LIB);
} else {
	engineP = import("../ortho-japan/app.js");
}

// 地球の半径＝画面短辺の 1/4（旧 v1 と同じ構図。v2 も 256px 世界＝同じ式）
export const overviewZoom = Math.log2(Math.min(innerWidth, innerHeight) / 2 * 0.5 / 256 * Math.PI * 2);

// 容れ物：.globe-bg（fixed 全面）の中の div をエンジンへ貸す（エンジンは借りた div の id を "map" へ改名する＝寸法はクラスで与える）
const frame = document.body.insertBefore(Object.assign(document.createElement("div"), { className: "globe-bg" }), document.body.firstChild);
const host = frame.appendChild(document.createElement("div"));

export const mapP = engineP.then(m => m.default({
	target: host,
	view: /^#-?\d/.test(location.hash) ? location.hash : `#${overviewZoom.toFixed(2)}/0/0`,
	lang: "en",
	countryTip: false,         // データの tip と国名 tip を混ぜない
	assetBase: __JAPAN_ASSETS__,   // 実行時アセット（plateau-sets.json 等）＝本番 /japan/・dev は ortho-japan/public を /@fs で
}));
export const viewP = mapP.then(map => createGintView(map, { overviewZoom }));

// 地図の道具（旧 v1 と同じ顔ぶれ：north→compass）。待ち受け中はパネルの下＝初めて地図に入る時に載せる
// （載せた瞬間から Z=全画面・@=現在地 等のショートカットが window で生きるため）
let tools = false;
export function mountTools(map) {
	if (tools) return; tools = true;
	map.gadget.close(); map.gadget.compass(); map.gadget.zoom(); map.gadget.full(); map.gadget.cpos(); map.gadget.measure(); map.gadget.shot();
}
