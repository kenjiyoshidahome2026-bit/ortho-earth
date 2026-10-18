// 静岡県の点群（VIRTUAL SHIZUOKA・2026-10-18・熱海の点群の見本を広げた物）＝静岡県が AWS に置く図郭ごとの点群を、選んで地図に出す。
// このページは器だけ：./app.js（本番のエンジンは共有エンジン）でエンジンを起こし、案内板と配線は ./pointcloud.js（遅延 chunk）。
// 言語・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。案内板の長文の訳＝頁の辞書（i18n/pages/pointcloud.json → i18n/lang/pointcloud/<code>.json）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("pointcloud", async () => {
	const [{ default: orthoJapan }, { mountPointcloud, ATAMI_VIEW }] = await Promise.all([import("./app.ts"), import("./pointcloud.ts")]);
	// 初期視点＝熱海の見本（共有 URL の hash があればそちら）
	const map = await orthoJapan({ target: "#map", view: location.hash || ATAMI_VIEW, chips: false, instruments: ["pos", "scale", "attr"], urlHash: true, assetBase: import.meta.env.BASE_URL });
	dismissBoot();
	if (map.lang === "ja") document.title = "静岡県の点群 — ortho-japan";   // head は英語（共有カード・検索）＝日本語の読者だけ日本語の題名
	window.__map = map;   // console 検証用
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot();
	window.__pointcloud = await mountPointcloud(map, document.getElementById("side")!);
	return map;
}, { page: c => import(`./i18n/lang/pointcloud/${c}.json`) });
