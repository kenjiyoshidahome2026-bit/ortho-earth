// 名所の 3D 模型 showcase＝写真測量スキャン（CC BY）を実在の場所に置き、一覧をクリックすると飛んで見せる（quakes/sats と同型の器）。
// このページは器だけ：./app.js（本番のエンジンは共有エンジン）でエンジンを起こし、
// 一覧と配線は ./models.js（遅延 chunk）。読み込みと描画はエンジンの model ガジェット（gadgets/model.js＝PLATEAU と同じ建物メッシュ経路）。
// 台帳＝GitHub Pages の ortho-data/japan/models.json（dev は手元の正本・vite.config の __DATA_JAPAN__。GLB 本体は bucket GIS/models/）。?m=<id> で起動時に選ぶ。
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。文言（title/description/パネル）は models.js が t() で組む
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("models", async () => {
	const [{ default: orthoJapan }, { mountModels }] = await Promise.all([import("./app.ts"), import("./models.ts")]);
	// 初期視点＝日本を眺める球（共有 URL の hash があればそちら）。建物 3D（PLATEAU）はそのまま＝模型の周りに街が立つ
	const map = await orthoJapan({ target: "#map", view: location.hash || "#3/36/138", chips: false,
		// mesh:false＝エンジンの PLATEAU 建物（LOD2）は出さない。模型が同じ建物の LOD3 版＝重なって壁の絵が明滅するため（本人 2026-09-21）
		mesh: false, instruments: ["pos", "scale", "attr"], urlHash: true, assetBase: import.meta.env.BASE_URL });
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.lang();
	const models = await mountModels(map, { catalog: `${__DATA_JAPAN__}models.json` });
	window.__map = map; window.__models = models;   // console 検証用
});
