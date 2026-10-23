// voxel の見本（/globe/voxel・2026-10-23）＝@ortho-earth/plugin-voxel を地球儀の上で見せる頁（雲＝体積・トーラス＝等値面・富士山＝ブロック・地震の密度＝地下の体積）。
// このページは器だけ：地球儀のホスト（@ortho-earth/globe・地域の申告なし）を自分の束に焼いてエンジンを起こし、格子と案内板は ./voxel.ts（遅延 chunk＝plugin もそこで束ねる）。
// データ＝合成（ブラウザで作る）・富士山の地形（map.sampleTerrain＝既定の DTM）・地震＝/quakes/archive.geopbf（apps/quakes-mirror・dev は本番を直読み）。
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("voxel", async () => {
	const [{ createGlobe }, { mountVoxel, SCENES, viewHash }] = await Promise.all([import("@ortho-earth/globe"), import("./voxel.ts")]);
	// 場面＝?v=cloud|torus|fuji|quakes（?scene= は本体の scenes（JSON の場面）の口＝使えない）
	const q = new URLSearchParams(location.search), scene = (SCENES as readonly string[]).includes(q.get("v") ?? "") ? q.get("v") as typeof SCENES[number] : "cloud";
	// 初期視点＝場面ごとの定位置（共有 URL の hash があればそちら）。場面を変える時は mountVoxel が easeTo で寄せる
	const map = await createGlobe({ target: "#map", view: location.hash || viewHash(scene), theme: "dark", chips: false,
		instruments: ["pos", "scale", "attr"], urlHash: true, persistView: false });
	dismissBoot();
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.hint(); map.gadget.lang();
	const voxel = await mountVoxel(map, { scene, fly: false });
	window.__map = map; window.__voxel = voxel;   // console 検証用（verify-prod の合図＝__voxel.ready・__voxel.n）
	return map;
}, { page: c => import(`./i18n/lang/voxel/${c}.json`) });
