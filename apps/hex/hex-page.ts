// 世界の人口を H3 の六角形の柱で（issue #310・deck.gl の H3HexagonLayer／HexagonLayer 相当＝map.addH3・map.addCells を見せる頁）。
// このページは器だけ：地球儀のホスト（@ortho-earth/globe・地域の申告なし）を自分の束に焼いてエンジンを起こし、柱と案内板は ./hex.js（遅延 chunk）。
// データ＝GitHub Pages の ortho-data/globe/h3/kontur-20231101/（scripts/kontur-h3.mjs が Kontur の gpkg から焼き、world の publish-pages.mjs が置く＝r4.h3p.gz と r6/<res1 の親>.h3p.gz）。?data=URL で差し替え可。
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("hex", async () => {
	const [{ createGlobe, geopbf }, { mountHex }] = await Promise.all([import("@ortho-earth/globe"), import("./hex.ts")]);
	// 初期視点＝アジア（人口の山が一番高い所）を少し傾けて。共有 URL の hash があればそちら。z の上限 9＝解像度 6（一辺 約 3.7 km）の六角形が見える所まで
	const map = await createGlobe({ target: "#map", view: location.hash || "#3.8/20/86/55t", theme: "dark", chips: false, zoomMax: 9,
		mesh: false, instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false });
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.lang();
	const hex = await mountHex(map, { geopbf, data: new URLSearchParams(location.search).get("data") });
	window.__map = map; window.__hex = hex;   // console 検証用
	return map;
}, { page: c => import(`./i18n/lang/hex/${c}.json`) });
