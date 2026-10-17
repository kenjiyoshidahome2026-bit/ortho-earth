// 世界クイズの頁＝殻。言語（<html lang/dir>）・起動画面・起動失敗の面は共通の器（@ortho-earth/globe/page.js）。中身は src/app.js（遅延 chunk）。
// 頁の辞書は i18n/lang/quiz/<code>.json（正本 i18n/pages/quiz.json・npm run i18n:build で焼く）＝本体（globe の ui.json）に足して引く。
import { startPage } from "@ortho-earth/globe/page.js";
import { tr } from "@ortho-earth/globe/i18n.js";
startPage("quiz", async () => {
	const t = tr();
	document.title = t("World quiz — flags, capitals and the globe");
	const { mountApp } = await import("./src/app.js");
	return mountApp(document.getElementById("app"));
}, { page: c => import(`./i18n/lang/quiz/${c}.json`), target: "#app" });
