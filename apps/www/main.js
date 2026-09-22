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
// 絞り込み（All / The round Earth / Japan's open data / …）＝サンプルが増えても一覧が長くなりすぎない
document.querySelectorAll(".chips .chip").forEach(chip => chip.addEventListener("click", () => {
	const f = chip.dataset.filter;
	document.querySelectorAll(".chips .chip").forEach(c => c.classList.toggle("is-active", c === chip));
	document.querySelectorAll(".grid .card").forEach(c => { c.hidden = f !== "all" && c.dataset.group !== f; });
}));
// Section tabs (Demos / Technologies) — client-side; swaps the card panels over the ambient globe.
// Wired early so they respond before the globe finishes loading. #technologies deep-links the Tech tab.
function selectTab(name) {
	d3.selectAll('.tab').each(function () {
		const on = this.dataset.tab === name;
		d3.select(this).classed('is-active', on).attr('aria-selected', on ? 'true' : 'false');
	});
	d3.select('#panel-demos').attr('hidden', name === 'tech' ? 'hidden' : null);
	d3.select('#panel-tech').attr('hidden', name === 'tech' ? null : 'hidden');
}
d3.selectAll('.tab').on('click', function () {
	const name = this.dataset.tab;
	selectTab(name);
	history.replaceState(null, '', name === 'tech' ? '#technologies' : location.pathname);
});
if (location.hash === '#technologies') selectTab('tech');
d3.select(".logo").html(`${await (await fetch("/favicon.svg")).text() }Ortho Earth`);
//------------------------------------------------------
// Ambient auto-rotating globe behind the overlay (background only — no interactive demo mode).
// 背景＝軽い地球（88KB の webp を正射投影の球に貼って回すだけ・globe-lite.js）。エンジン（ortho-japan SDK＋世界データ約 8MB）は
// 背景には載せない＝名刺 QR から来た携帯でもすぐ回る（2026-09-21 本人裁定「軽い webp を読み込んで、くるくる回せばいい」）。
// デモ（/japan/）の初回に要る世界データは、地球が出てページの読み込みが済み手が空いてから背後で IDB に入れる（prefetch.js）
// ＝同オリジンの /japan/ が IDB から立つ。データ節約・遅い回線では見送る。
const whenIdle = cb => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 500));
const afterLoad = cb => document.readyState === "complete" ? cb() : addEventListener("load", cb, { once: true });
liteGlobe(document.getElementById('mapContainer'), {
	src: "/earth-lite.webp",
	onFirstFrame: () => afterLoad(() => whenIdle(async () => {
		const { shouldPrefetch, prefetchJapanWorld } = await import("./prefetch.js");
		if (shouldPrefetch()) prefetchJapanWorld().catch(e => console.warn("[prefetch]", e));
		else console.info("[prefetch] skipped (save-data or slow connection)");
	})),
});
