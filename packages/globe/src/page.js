// デモ頁の共通の器（2026-10-04・デモ品質の段）＝各頁の index.html が繰り返していた 4 つの定石を 1 本に：
//   ① 言語＝setLang() → <html lang/dir>（RTL は dir=rtl）。head は英語のまま（共有カードと検索が読む・本人 2026-09-21「全ての head は英語」）
//   ② 頁の辞書（i18n/pages/<page>.json の焼き物）を本体の表に足す
//   ③ 起動画面（#boot）の退場＝地図の初回フレームの後（2 フレーム待ち）
//   ④ 起動に失敗した時＝console だけでなく画面に言葉で（紙色の面＋再読み込み）。旧＝黙って起動画面を畳む＝空の地図か黒い画面のまま
// 使い方（頁のインライン script）：
//   import { startPage } from "@ortho-earth/globe/page.js";
//   startPage("parks", async () => { …createGlobe…; return map; }, { page: c => import(`./i18n/lang/parks/${c}.json`) });
// i18n は必ず "@ortho-earth/globe/i18n.js" の名で引く＝本番の build では共有エンジンの実体（/globe/engine/<版>/i18n.js）に外出しされる
//（scripts/lib/shared-engine.mjs）。相対で引くと言語の状態が頁とエンジンで二つに割れる。
import { setLang, getLang, isRTL, loadPage, tr } from "@ortho-earth/globe/i18n.js";
const t = tr();

// ① ② 言語を決め、<html> に lang/dir を書き、頁の辞書を足す。UI を組む前に await する（モジュール評価時に t() を呼ばない掟とセット）
export async function preparePage({ page, lang } = {}) {
	await setLang(lang);
	if (page) await loadPage(page);
	const code = getLang();
	document.documentElement.lang = code;
	document.documentElement.dir = isRTL(code) ? "rtl" : "ltr";
	return code;
}

// ③ 起動画面（#boot）を畳む（地図の初回フレームが描かれてから＝空 canvas のちらつきを避ける 2 フレーム待ち）。無ければ何もしない
export function dismissBoot() {
	requestAnimationFrame(() => requestAnimationFrame(() => {
		const b = document.getElementById("boot");
		if (b) { b.classList.add("gone"); setTimeout(() => b.remove(), 250); }
	}));
}

// ④ 起動の失敗を画面に。エンジンの fatalOverlay（globe.css の #fatal）はエンジンが起きた後にしか使えない＝ここは外部 CSS に依らない自前の面。
//   tag＝console の印（"[parks]"）。target＝置き場（既定＝#map か body）。戻り＝作った要素
export function startupFailed(tag, e, { target } = {}) {
	console.error(`[${tag}] startup failed`, e);
	dismissBoot();
	const host = (typeof target === "string" ? document.querySelector(target) : target) || document.getElementById("map") || document.body;
	if (host.querySelector("#page-fatal")) return null;
	const d = document.createElement("div");
	d.id = "page-fatal"; d.setAttribute("role", "alert");
	d.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:24px;background:#f4f1ea;color:#333;font:14px/1.9 system-ui,sans-serif";
	const detail = e?.message || String(e ?? "");
	d.innerHTML = `<div style="max-width:540px">
		<div style="font-size:18px;font-weight:600;margin-bottom:10px"></div>
		<div style="color:#555"></div>
		<button type="button" style="margin-top:18px;padding:9px 22px;font-size:14px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer"></button></div>`;
	const [title, body, btn] = [d.children[0].children[0], d.children[0].children[1], d.children[0].children[2]];
	title.textContent = t("Could not start the page");
	body.textContent = t("Startup failed ($1). Reload the page — if it still fails, try another browser or check that hardware acceleration is on.", detail);
	btn.textContent = t("Reload"); btn.addEventListener("click", () => location.reload());
	host.append(d);
	return d;
}

// ①〜④ を一息で。fn（async）が地図を返す。失敗＝startupFailed。成功＝dismissBoot（fn の中で先に畳んでもよい＝二重は無害）
export async function startPage(tag, fn, { page, lang, target } = {}) {
	try {
		await preparePage({ page, lang });
		const ret = await fn();
		dismissBoot();
		return ret;
	} catch (e) { startupFailed(tag, e, { target }); return null; }
}
