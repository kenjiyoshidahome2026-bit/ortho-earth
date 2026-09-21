import * as d3 from "d3";
import './main.scss';
import { liteGlobe } from "./globe-lite.js";
//------------------------------------------------------
// ?lang=xx でトップへ来たら、アプリ行きリンク（/japan・/nl）へ伝搬＝www→デモの導線でも字幕言語が保てる
//（LT 2026-08-24：www を先に出し ?lang=en → featured カードから英語字幕のデモへ）。globe の await より前＝リンクは即使える。
{
	const lang = new URLSearchParams(location.search).get("lang");
	if (lang) document.querySelectorAll('a[href^="/japan"], a[href^="/nl"]').forEach(a => {
		const u = new URL(a.getAttribute("href"), location.origin);
		u.searchParams.set("lang", lang);
		a.setAttribute("href", u.pathname + u.search + u.hash);
	});
}
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
