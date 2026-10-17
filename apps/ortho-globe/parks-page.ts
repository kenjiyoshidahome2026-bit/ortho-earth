// アメリカ合衆国の国立公園 63 の showcase＝NPS の境界を球に載せ、写真の一覧から選ぶと飛んでスポットライトで指す（/japan/parks と同型の器・世界側）。
// このページは器だけ：地球儀のホスト（@ortho-earth/globe・地域の申告なし＝米国に地域パックは無く、世界帯の州境・都市で足りる）を自分の束に焼いてエンジンを起こし、一覧と配線は ./parks.js（遅延 chunk）。
// データ＝GitHub Pages の ortho-data/us/（dev は手元の正本・vite.config の __DATA_US__）：台帳＝parks-us.json（名前 26 言語・Wikipedia・写真・面積・指定日・来訪者・州）／外周＝parks-us.geopbf／他の NPS ユニット＝nps-units.geopbf。?p=<id> で起動時に選ぶ。
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。言語の切替は parks.ts の案内板が持つ（select）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("parks", async () => {
	const [{ createGlobe, geopbf }, { mountParks }] = await Promise.all([import("@ortho-earth/globe"), import("./parks.ts")]);
	// 初期視点＝北米を少し傾けて眺める（アラスカからフロリダまで・共有 URL の hash があればそちら）。建物 3D は出さない（公園に街は要らない・起動も軽い）
	const map = await createGlobe({ target: "#map", view: location.hash || "#2.3/44/-112/20t", chips: false,
		worldContent: true, mesh: false, instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false });
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint();
	const D = __DATA_US__;
	const parks = await mountParks(map, geopbf, { catalog: `${D}parks-us.json`, boundary: `${D}parks-us.geopbf`, units: `${D}nps-units.geopbf` });
	window.__map = map; window.__parks = parks;   // console 検証用
	return map;
}, { page: c => import(`./i18n/lang/parks/${c}.json`) });
