// geoedit＝GeoPBF トポロジカルエディタ（旧 apps/geoedit＝独立アプリ → ortho-japan のガジェット gadgets/geoedit（9/4）→ packages/geoedit＝geoedit（npm）（MIT・9/20））。
// このページは器だけ：@ortho-earth/regions/app（地域の殻 orthoJapan・本番は共有エンジンの regions/app.js）でエンジンを起こし、
// 編集に要る最小限のガジェット＋ map.gadget.geoedit()（遅延chunk）を載せる。
// 言語（26 言語・<html lang/dir>）・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。head は英語（共有カード・検索）＝起動後に読む人の言語へ
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
import { geoeditTable } from "./geoedit-table.ts";   // 地物一覧の表（common/bigtable・一覧を開いた時に遅延 import）
startPage("geoedit", async () => {
	const orthoJapan = (await import("@ortho-earth/regions/app")).default;   // dev＝ソース直／本番＝エンジンは共有エンジン（/globe/engine/<版>/・2026-09-30）・束には orthoJapan と jp パックだけ
	// hash（共有ビュー）優先、無ければ列島俯瞰。エディタはチルトなし（maxPitch:0）＝真上からの編集専用（ガジェットも搭載時に真上へ固定する）
	const map = await orthoJapan({ target: "#map", view: location.hash || "#5.1/38.2/136.9", maxPitch: 0, assetBase: import.meta.env.BASE_URL });
	dismissBoot();
	if (map.lang === "ja") document.title = "geoedit — GeoPBFエディタ";   // head は英語（共有カード・検索）＝日本語の読者だけ日本語の題名
	window.__map = map;   // console 検証用（デバッグの手すり）
	map.gadget.search(); map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot(); map.gadget.lang();   // 編集に要る最小限（右クリックメニューはエディタ本体が編集アクション付きで載せる）
	if (/[?&]verify=1/.test(location.search)) return map;   // 検定ゲート（verify-prod）＝エンジン起動だけを見る静穏モード
	window.__editor = await map.gadget.geoedit({ table: geoeditTable });
	return map;
});
