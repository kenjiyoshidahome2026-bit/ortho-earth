// 共有エンジンの入口 equal.js（/globe/engine/<版>/equal.js・2026-10-15）＝Equal Earth の部品 createEqual（packages/equal）。
// 2 つ以上のアプリ（ortho-globe・ortho-japan の div 重ね・equal の頁）が使う物は各アプリに焼かず、ここを共に読む（本人 2026-10-14）。
// CSS＝regions-app.js と同じ手（1 つ上の階の globe.css を 1 回だけ貼る・equal の .eq 規則もそこに入る）。気候場の既定は globe と同じ同梱の 1 枚。
const css = "./globe.css";   // この入口は <版>/ 直下（regions/app.js は 1 階下なので ../）
if (!document.querySelector("link[data-ortho-engine]")) {
	const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL(css, import.meta.url).href });
	link.setAttribute("data-ortho-engine", "");
	document.head.appendChild(link);
}
// worker＝エンジンの部品（geopbf・core の標高）は「作らない版」で焼いてある（apps/engine の vite.config.js の engineAliases）＝ふだんは globe.js が
// 起動時に自分の入口 worker.js を口に渡す。equal の頁は globe.js を読まない＝部品を自前で起こす時（geopbf:true）だけ、同じ worker.js を口に渡す
// （globe・japan の上に重ねる時は geopbf:false＝globe が渡した口のまま）。
import { setWorkerFactory } from "geopbf";
import { setWorkerFactory as setCoreWorkerFactory } from "@ortho-earth/core/elevation";
import { createEqual as create } from "@ortho-earth/equal";
const hostWorker = role => new Worker(new URL("@ortho-earth/globe/worker.js", import.meta.url), /* @vite-ignore */ { type: "module", name: role });
export * from "@ortho-earth/equal";
export function createEqual(opts = {}) {
	if (opts.geopbf !== false) { setWorkerFactory(hostWorker); setCoreWorkerFactory(hostWorker); }
	return create(opts);
}
