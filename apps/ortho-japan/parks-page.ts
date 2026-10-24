// 国立公園の showcase＝環境省の区域（nps_all を溶かした外周）を球に載せ、写真の一覧から選ぶと飛んでスポットライトで指す（models と同型の器）。
// このページは器だけ：@ortho-earth/regions/app（地域の殻 orthoJapan・本番は共有エンジンの regions/app.js）でエンジンを起こし、一覧と配線は ./parks.js（遅延 chunk）。
// データ＝GitHub Pages の ortho-data/japan/（dev は手元の正本・vite.config の __DATA_JAPAN__）：台帳＝parks.json（名前 26 言語・Wikipedia・写真・面積・指定日・都道府県）／外周＝parks.geopbf。?p=<id> で起動時に選ぶ。
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。言語の切替は parks.js の案内板が持つ（select）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("parks", async () => {
	const [{ default: orthoJapan, geopbf }, { mountParks }] = await Promise.all([import("@ortho-earth/regions/app"), import("./parks.ts")]);
	// 初期視点＝日本列島を少し傾けて眺める（共有 URL の hash があればそちら）。建物 3D は出さない（公園に街は要らない・起動も軽い）
	const map = await orthoJapan({ target: "#map", view: location.hash || "#4.3/36.8/137.2/35t", chips: false,
		mesh: false, instruments: ["pos", "scale", "attr"], urlHash: true, assetBase: import.meta.env.BASE_URL });
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.lang();
	const parks = await mountParks(map, geopbf, { catalog: `${__DATA_JAPAN__}parks.json`, boundary: `${__DATA_JAPAN__}parks.geopbf` });
	window.__map = map; window.__parks = parks;   // console 検証用
});
