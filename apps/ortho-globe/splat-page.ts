// Gaussian splat の見本（/globe/splat・2026-10-21）＝@ortho-earth/plugin-splat を地球儀の上で見せる頁（3D Tiles の KHR_gaussian_splatting と 1 本の .spz・WebGPU の球面調和・自分のファイル）。
// このページは器だけ：地球儀のホスト（@ortho-earth/globe・地域の申告なし）を自分の束に焼いてエンジンを起こし、splat と案内板は ./splat.ts（遅延 chunk＝plugin もそこで束ねる）。
// データ＝GitHub Pages の ortho-data/globe/splat/<scene>/（scripts/splat-tiles.mjs が Niantic の .spz から焼き、world の publish-pages.mjs が置く）。?data=URL で差し替え可。
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("splat", async () => {
	const [{ createGlobe }, { mountSplat, SITE }] = await Promise.all([import("@ortho-earth/globe"), import("./splat.ts")]);
	// 初期視点＝東京駅 丸の内駅前広場の 2 体を南東から見下ろす（共有 URL の hash があればそちら）。mountSplat が lookAt で寄せる
	const map = await createGlobe({ target: "#map", view: location.hash || `#19.5/${SITE[1]}/${SITE[0]}/60t`, theme: "dark", chips: false,
		instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false });
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.lang();
	const q = new URLSearchParams(location.search);
	const splat = await mountSplat(map, { data: q.get("data"), mode: q.get("mode"), fly: !location.hash });
	window.__map = map; window.__splat = splat;   // console 検証用（verify-prod の合図＝__splat.ready・__splat.tiles.shown）
	return map;
}, { page: c => import(`./i18n/lang/splat/${c}.json`) });
