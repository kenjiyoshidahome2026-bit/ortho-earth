// 弧の頁（issue #311）＝いちばん近い道は弧になる。deck.gl の ArcLayer・GreatCircleLayer に当たる map.addData(…, { kind: "arcs" }) を球の上で見せる。
// このページは器だけ：地球儀のホスト（@ortho-earth/globe・地域なし）を起こし、案内板・層・小さなメルカトル図は ./arcs.js（遅延 chunk）。
// データ＝首都は world の台帳（GitHub Pages）・空港と路線は OpenFlights をブラウザが直読み（Cache API に置く）・国の形は NE admin_0 50m（エンジンと同じ geopbf）。
// ?mode=here|cmp|air|csv で起動する見方・?csv=URL で表を読む。
// glOverlay＝同一フレームのオーバーレイ（弧・点・光の粒）を重ねる宣言。WebKit は本体が WebGPU だとこの 2 枚目が描かれない（sats・quakes と同じ）
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("arcs", async () => {
	const [{ createGlobe, geopbf }, { mountArcs }] = await Promise.all([import("@ortho-earth/globe"), import("./arcs.js")]);
	const map = await createGlobe({ target: "#map", view: location.hash || "#1.9/20/140", chips: false, zoomMax: 8,
		mesh: false, glOverlay: true, stars: false, countryTip: false, instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false });
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.lang();
	const q = new URLSearchParams(location.search);
	const arcs = await mountArcs(map, geopbf, { csv: q.get("csv"), mode: q.get("mode") } as Parameters<typeof mountArcs>[2]);   // 引数の型＝JS 本体の既定値からの推論（既定値の無い欄・null 既定は狭く出る）＝呼び口で JS の口に合わせる
	window.__map = map; window.__arcs = arcs;   // console 検証用
	return map;
}, { page: c => import(`./i18n/lang/arcs/${c}.json`) });
