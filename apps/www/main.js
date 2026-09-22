import * as d3 from "d3";
import './main.scss';
import { liteGlobe } from "./globe-lite.js";
import { t, has, setLang, norm, LANGUAGES, getLang } from "./i18n.js";
//------------------------------------------------------
// 言語：?lang= → ブラウザ → 英語（26 言語）。文言は data-t（キー）/ data-t-<attr> を持つ要素を貼り替えるだけ＝HTML は英語のまま焼いてある。
// 選んだ言語（?lang= か右上の選択）はデモへのリンクへ伝搬＝www→デモの導線でも言語が保てる（LT 2026-08-24 からの作法を全リンクへ）。
const ATTRS = ["aria-label", "alt", "title", "placeholder"];
function relabel() {
	document.querySelectorAll("[data-t]").forEach(el => { el.textContent = t(el.dataset.t); });
	for (const a of ATTRS) document.querySelectorAll(`[data-t-${a}]`).forEach(el => el.setAttribute(a, t(el.getAttribute(`data-t-${a}`))));
	// キャッチの訳＝英語以外で、訳があるときだけ小さく添える（キャッチ本体は本人の文のまま）
	const tr = document.querySelector(".motto-tr");
	if (tr) tr.hidden = getLang() === "en" || !has(tr.dataset.t);
}
function propagate(lang) {
	document.querySelectorAll('a[href^="/"]:not([href^="/docs"])').forEach(a => {
		const u = new URL(a.getAttribute("href"), location.origin);
		lang && lang !== "en" ? u.searchParams.set("lang", lang) : u.searchParams.delete("lang");
		a.setAttribute("href", u.pathname + u.search + u.hash);
	});
}
{
	const asked = norm(new URLSearchParams(location.search).get("lang"));
	await setLang(asked || norm(navigator.language) || "en");
	relabel();
	document.documentElement.classList.remove("i18n-wait");   // 先頭のスクリプトが隠した本文を、貼り替えが済んだ所で出す
	if (asked) propagate(asked);
	const sel = document.querySelector("select.lang");
	for (const l of LANGUAGES) sel.append(new Option(l.name, l.code));
	sel.value = getLang();
	sel.addEventListener("change", async () => {
		const c = await setLang(sel.value);
		relabel(); propagate(c);
		const q = new URLSearchParams(location.search); c === "en" ? q.delete("lang") : q.set("lang", c);
		history.replaceState(null, "", (q.size ? "?" + q : location.pathname) + location.hash);
	});
}
// Section tabs (Demos / Technologies) — client-side; swaps the card panels over the ambient globe.
// Wired early so they respond before the globe finishes loading. #technologies deep-links the Tech tab.
const HASH = { start: "#get-started", tech: "#technologies" };
function selectTab(name) {
	d3.selectAll('.tab').each(function () {
		const on = this.dataset.tab === name;
		d3.select(this).classed('is-active', on).attr('aria-selected', on ? 'true' : 'false');
	});
	for (const p of ["demos", "start", "tech"]) d3.select(`#panel-${p}`).attr('hidden', p === name ? null : 'hidden');
}
d3.selectAll('.tab').on('click', function () {
	const name = this.dataset.tab;
	selectTab(name);
	history.replaceState(null, '', location.search + (HASH[name] ?? '') || location.pathname);
});
{ const n = Object.keys(HASH).find(k => HASH[k] === location.hash); if (n) selectTab(n); }
d3.select(".logo").html(`${await (await fetch("/favicon.svg")).text() }Ortho Earth`);
//------------------------------------------------------
// Ambient auto-rotating globe behind the overlay (background only — no interactive demo mode).
// 背景＝軽い地球（88KB の webp を正射投影の球に貼って回すだけ・globe-lite.js）。エンジン（ortho-japan SDK＋世界データ約 8MB）は
// 背景には載せない＝名刺 QR から来た携帯でもすぐ回る（2026-09-21 本人裁定「軽い webp を読み込んで、くるくる回せばいい」）。
// デモ（/japan/）の初回に要る世界データは、地球が出てページの読み込みが済み手が空いてから背後で IDB に入れる（prefetch.js）
// ＝同オリジンの /japan/ が IDB から立つ。データ節約・遅い回線では見送る。
const whenIdle = cb => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 500));
const afterLoad = cb => document.readyState === "complete" ? cb() : addEventListener("load", cb, { once: true });
const globe = liteGlobe(document.getElementById('mapContainer'), {
	src: "/earth-lite.webp",
	onFirstFrame: () => afterLoad(() => whenIdle(async () => {
		const { shouldPrefetch, prefetchJapanWorld } = await import("./prefetch.js");
		if (shouldPrefetch()) prefetchJapanWorld().catch(e => console.warn("[prefetch]", e));
		else console.info("[prefetch] skipped (save-data or slow connection)");
	})),
});
//------------------------------------------------------
// デモ＝ページを離れずにナビの下の iframe で開く（本人 2026-09-22「デモに行くと戻りづらい・ナビを残して本文を iframe に・ナビに戻る」）。
// ・カードのクリック（修飾キーなし＝新しいタブで開きたい操作は邪魔しない）を受けて iframe に入れ、履歴を一段積む（?d=<デモのパス>）
//   ＝ブラウザの戻るでも一覧へ。?d= で直接開いた時（共有・再読み込み）も同じ形。
// ・iframe は開くたびに雛形（#demoFrame）から新しく作り、閉じたら取り除く＝src の差し替えで履歴に段が積まれない（戻るが一回で済む）。
// ・ナビの「戻る」＝自分で積んだ段なら history.back、直接開いた時は一覧へ置き換え。デモの間は背景の地球を止める（GPU を取り合わない）。
// ・デモは同じオリジンのパスだけ（?d= に外のアドレスを入れても開かない）。
const tpl = document.getElementById("demoFrame"), backBtn = document.querySelector("nav .back");
let frame = null;
const demoPath = p => { try { const u = new URL(p, location.origin); return u.origin === location.origin && u.pathname !== "/" ? u.pathname + u.search + u.hash : null; } catch { return null; } };
function showDemo(path, title) {
	if (!frame || frame.dataset.path !== path) {
		frame?.remove();
		frame = tpl.cloneNode(false);
		frame.removeAttribute("id"); frame.hidden = false; frame.className = "demo-frame";
		frame.dataset.path = path; frame.title = title || "Demo"; frame.src = path;
		frame.addEventListener("load", () => { try { frame.contentWindow.focus(); } catch { /* 読み込み失敗 */ } }, { once: true });   // キー操作（矢印・Esc 等）がすぐデモに届く
		tpl.after(frame);
	}
	backBtn.hidden = false;
	document.body.classList.add("in-demo"); globe.pause();
}
function hideDemo() {
	frame?.remove(); frame = null;   // デモの GPU とメモリを返す
	backBtn.hidden = true;
	document.body.classList.remove("in-demo"); globe.resume();
}
const listUrl = () => { const q = new URLSearchParams(location.search); q.delete("d"); return (q.size ? "?" + q : location.pathname) + location.hash; };
document.addEventListener("click", e => {
	const a = e.target.closest?.("#panel-demos a.card");
	if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	if (a.dataset.frame === "0") return;   // iframe に入れないデモ（中の頁が COEP を送らない）＝普通に開く
	const path = demoPath(a.getAttribute("href")); if (!path) return;
	e.preventDefault();
	const q = new URLSearchParams(location.search); q.set("d", path);
	history.pushState({ demo: path }, "", "?" + q);
	showDemo(path, a.querySelector(".card-title")?.textContent);
});
backBtn.addEventListener("click", () => { if (history.state?.demo) history.back(); else { history.replaceState(null, "", listUrl()); hideDemo(); } });
addEventListener("popstate", e => { const p = e.state?.demo ?? demoPath(new URLSearchParams(location.search).get("d") || ""); p ? showDemo(p) : hideDemo(); });
{ const d = new URLSearchParams(location.search).get("d"); const p = d && demoPath(d); if (p) showDemo(p); }
