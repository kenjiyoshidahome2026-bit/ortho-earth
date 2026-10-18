// 世界の地形（山・川・湖・海・砂漠…約 1,000 件）を地球儀に。物理量（標高・長さ・面積・深さ・流量…）で記号の大きさを変え、
// 一覧（並べ替え）と比較図（高さ比べ・長さ比べ）を地図と連動させる。
// このページは器だけ：地球儀のホスト（@ortho-earth/globe・地域なし）を自分の束に焼いてエンジンを起こし、描画と案内板は ./physical.js（遅延 chunk）。
// データ＝packages/world の TerrainDB（物理量）・i18n/<lang>（名前）・ne-physical.geopbf（形状台帳）。本番は GitHub Pages（ortho-data/globe/）、dev は手元の out/（vite の __WORLD_OUT__）。?data=URL で差し替え可。
// 言語（html の lang/dir）・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。言語の切替は physical.ts の案内板が持つ（select）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("physical", async () => {
	const [{ createGlobe, geopbf }, { mountPhysical }] = await Promise.all([import("@ortho-earth/globe"), import("./physical.ts")]);
	// 初期視点＝ヒマラヤからアフリカまで（大山脈・大河・大砂漠が一度に入る）。共有 URL の hash があればそちら
	const map = await createGlobe({ target: "#map", view: location.hash || "#3.4/26/62", chips: false, zoomMax: 8,
		worldContent: { groups: ["lakes"] }, worldLines: false, night: false, countryTip: "shift",   // Shift＋ホバー＝国名（本人 2026-10-01）・ふだんは地形の tip
		 mesh: false,   // night:false＝夜の半球を減光しない（地形図＝全面を同じ明るさで・本人 2026-10-01「ハイプソが地球全面ではない」）
		   // worldLines:false＝世界帯の NE 河川を読まない（川は形状台帳で描く＝二重に描かない）   // 世界帯は湖の岸線だけ（国名・都市・道路は出さない＝地形が主役）。海岸線と国境は別系統で常に出る
		 instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false,
		debugGlobals: /[?&]debug=1/.test(location.search) });   // ?debug=1＝検証窓（__perf…）
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.lang();
	const physical = await mountPhysical(map, { geopbf, data: new URLSearchParams(location.search).get("data") });   // 省略＝dev は手元の out/・本番は GitHub Pages（ortho-data）
	window.__map = map; window.__physical = physical;   // console 検証用
});
