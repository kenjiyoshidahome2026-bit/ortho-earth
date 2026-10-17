// 世界の地震ビューア＝USGS ComCat（apps/quakes/scripts/usgs-quakes-build.mjs が作る GeoPBF）を地球儀に立体表示する。
// このページは器だけ：地球儀のホスト（@ortho-earth/globe・地域なし）を自分の束に焼いてエンジンを起こし、
// 描画と案内板は ./quakes.ts（遅延 chunk）。
// データ＝本番は apps/quakes-mirror（同一オリジン /quakes/・archive を配るだけ）の archive（確定した過去分・GeoPBF）＋直近分（archive.json の
// end〜今をブラウザが USGS FDSN から直接取り、月ごとに GeoPBF へ焼いて IDB に置く＝quakes-worker.ts）を連結。
// dev は public/dev/usgs-quakes-m2.geopbf（apps/quakes/scripts/usgs-quakes-build.mjs で作る）。?src=URL で差し替え可。
// 言語（html の lang/dir）・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。文言（title/description/パネル）は quakes.ts が t() で組む
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("quakes", async () => {
	// エンジン＝地球儀のホスト @ortho-earth/globe をこの頁の束に焼く（地域の申告なし・CSS もこのチャンクに付いて来る）
	const [{ createGlobe }, { mountQuakes }] = await Promise.all([import("@ortho-earth/globe"), import("./quakes.ts")]);
	// 初期視点＝太平洋を囲む「火の輪」が一望できる地球儀（共有 URL の hash があればそちら）
	const map = await createGlobe({ target: "#map", view: location.hash || "#2.8/18/165", theme: "dark", chips: false, zoomMax: 8,   // 世界のアプリ＝地球儀（地域の申告なし・z<8＝LAYERS.md 段階 2 S6）
		// glOverlay＝同一フレームのオーバーレイ（地震）を重ねる宣言。WebKit は本体が WebGPU だとこの 2 枚目が描かれない（本人 iPad 実機 2026-09-21）
		mesh: false, glOverlay: true, instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false });   // persistView:false＝同じオリジンの /japan/ が残した「前回の視点」を読まない・書かない（家が別）
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.lang();
	const src = new URLSearchParams(location.search).get("src")
		|| (import.meta.env.DEV ? `${import.meta.env.BASE_URL}dev/usgs-quakes-m2.geopbf` : ["/quakes/archive.geopbf", { usgs: "/quakes/archive.json" }]);
	const quakes = await mountQuakes(map, { src });
	window.__map = map; window.__quakes = quakes;   // console 検証用
});
