// 打ち上げ花火＝シーンの深度（#47）の見本。器だけ：./app.js（本番のエンジンは共有エンジン）でエンジンを起こし、
// UI と合図は ./fireworks.js（遅延 chunk）、描画は ./fireworks-gl.js（レンダーワーカー内のオーバーレイ）。建物 3D（PLATEAU）はそのまま＝花火を隠す側。
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("fireworks", async () => {
	const [{ default: orthoJapan }, { mountFireworks }] = await Promise.all([import("./app.ts"), import("./fireworks.ts")]);
	// 初期視点＝隅田川の上空（共有 URL の hash があればそちら）。glOverlay＝WebKit では本体を WebGL2 に（WebGPU 本体＋WebGL2 オーバーレイは合成されない）
	const map = await orthoJapan({ target: "#map", view: location.hash || "#14/35.716/139.807", chips: false, theme: "dark",
		instruments: ["pos", "scale", "attr"], urlHash: true, glOverlay: true, assetBase: import.meta.env.BASE_URL });
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.clock?.(); map.gadget.lang();
	const fw = await mountFireworks(map);
	window.__map = map; window.__fw = fw;   // console 検証用
});
