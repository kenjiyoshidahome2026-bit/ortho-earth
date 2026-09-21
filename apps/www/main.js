import * as d3 from "d3";
import './main.scss';
import { createSpin } from "common/gintView";
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
// 地球＝ortho-japan エンジン（gint v2）。旧＝ortho-map（v1）。SDK 二重構成（gishub/census2020 と同じ型）：
// dev＝ソース直・本番＝/japan/lib/ の SDK（japan 本体とエンジンのキャッシュを共有）。背景なので軽く：建物3D・チップ・計器（出典以外）なし、
// 矢印キーはページのもの（keyboard:false）、視点は保存しない（/japan/ の「前回の続き」を上書きしない＝persistView:false）
const zoom = Math.log2(Math.min(window.innerWidth, window.innerHeight)/2*0.8 / 256 * Math.PI * 2);
// 起動はページの load 後・手が空いてから＝カードとポスター画像（LCP）の描画を地球の読み込み（エンジン＋世界データ数 MB）と競わせない
function startGlobe() {
	let engineP;
	if (import.meta.env.PROD) {
		document.head.appendChild(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/japan/lib/ortho-japan.css" }));
		const LIB = "/japan/lib/ortho-japan.js";
		engineP = import(/* @vite-ignore */ LIB);
	} else {
		engineP = import("../ortho-japan/app.js");
	}
	const host = document.getElementById('mapContainer').appendChild(document.createElement('div'));   // エンジンに貸す容れ物（id は map へ改名される）
	engineP.then(m => m.default({
		target: host, view: `#${zoom.toFixed(2)}/0/0`, lang: "en",
		plateau: false, chips: false, instruments: ["attr"], countryTip: false,
		keyboard: false, persistView: false,
		assetBase: __JAPAN_ASSETS__,
	})).then(map => createSpin(map)(true))
		.catch(e => console.error("[www] globe failed", e));   // 地球が立たなくてもカード（本題）は生きている
}
const whenIdle = cb => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 2000 }) : setTimeout(cb, 200));
if (document.readyState === "complete") whenIdle(startGlobe);
else addEventListener("load", () => whenIdle(startGlobe), { once: true });   // 地球が立たなくてもカード（本題）は生きている
