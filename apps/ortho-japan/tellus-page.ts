// Tellus × ortho-earth＝Tellus（さくらインターネットの衛星データPF）の衛星データを、サーバもタイル化もなしに
// ブラウザで直接読んで 3D 地球儀へ載せる専用ビューア（2026-09-16・Tellus の方々に見せて次の一手を相談するための一枚）。
// このページは器だけ：@ortho-earth/regions/app（地域の殻 orthoJapan・本番は共有エンジンの regions/app.js）でエンジンを起こし、
// 案内板と配線は ./tellus.js（遅延 chunk）。
// 言語（<html lang/dir>）・起動画面・起動失敗の表示＝共通の器（@ortho-earth/globe/page.js）。head は英語（共有カード・検索）＝起動後に読む人の言語へ
// 案内板の長文の訳＝頁の辞書（i18n/pages/tellus.json → i18n/lang/tellus/<code>.json）。言語の切替は案内板の select（?lang= で読み直す）
import { startPage, dismissBoot } from "@ortho-earth/globe/page.js";
startPage("tellus", async () => {
	const [{ default: orthoJapan }, { mountTellus }] = await Promise.all([import("@ortho-earth/regions/app"), import("./tellus.ts")]);
	// 初期視点＝共有 URL の hash 優先、無ければ東京を少し傾けて（SAR を地形に載せた立体感が第一印象）
	const map = await orthoJapan({ target: "#map", view: location.hash || "#9.2/35.62/139.55/48t", chips: false, instruments: ["pos", "scale", "attr"], urlHash: true, assetBase: import.meta.env.BASE_URL });
	dismissBoot();
	if (map.lang === "ja") document.title = "Tellus × ortho-earth — 衛星データを地球儀へ";   // head は英語（共有カード・検索）＝日本語の読者だけ日本語の題名
	window.__map = map;   // console 検証用（デバッグの手すり）
	map.gadget.zoom(); map.gadget.compass(); map.gadget.full(); map.gadget.shot();
	window.__tellus = await mountTellus(map, document.getElementById("side")!);   // console 検証用（search/load/items）
	return map;
}, { page: c => import(`./i18n/lang/tellus/${c}.json`) });
