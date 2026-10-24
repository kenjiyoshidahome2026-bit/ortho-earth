// エンジンは @ortho-earth/regions/app（地域の殻 orthoJapan）＝本番の globe・i18n・core・geopbf は共有エンジン（/globe/engine/<版>/・2026-09-30）。
//   エディタ本体（editor.ts）はこのアプリのチャンク。
// 言語（26 言語・<html lang/dir>）・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。head は英語（共有カード・検索）＝起動後に読む人の言語へ
import { startPage } from "@ortho-earth/globe/page.js";
import { mountSceneEditor } from "./editor.ts";
startPage("scene", async () => {
	const orthoJapan = (await import("@ortho-earth/regions/app")).default;   // dev＝ソース直／本番＝エンジンは共有エンジン・束には orthoJapan と jp パックだけ
	const map = await orthoJapan({ target: "#map" });   // フル機能の japan（PLATEAU・waitLoading の実物の上で編集する）
	if (map.lang === "ja") document.title = "scenes エディタ — ortho-japan";   // head は英語（共有カード・検索）＝日本語の読者だけ日本語の題名（題は .js に無い＝i18n の走査器の外）
	map.gadget.demo({ player: true });   // 素のプレーヤー（▶なし）＝map.playScenes の器（scene-format.md §7）
	map.gadget.lang();
	mountSceneEditor({ map, stageEl: document.getElementById("sc-stage")!, panelEl: document.getElementById("sc-panel")! });
	window.__map = map;   // console 検証用
}, { target: "#sc-stage" });
