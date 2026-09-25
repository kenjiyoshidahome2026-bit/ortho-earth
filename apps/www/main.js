import * as d3 from "d3";
import './main.scss';
import { liteGlobe } from "./globe-lite.js";
import { t, has, setLang, norm, LANGUAGES, getLang } from "./i18n.js";
//------------------------------------------------------
// 言語：?lang= → ブラウザ → 英語（26 言語）。文言は data-t（キー）/ data-t-<attr> を持つ要素を貼り替えるだけ＝HTML は英語のまま焼いてある。
// 選んだ言語（?lang= か右上の選択）はデモへのリンクへ伝搬＝www→デモの導線でも言語が保てる（LT 2026-08-24 からの作法を全リンクへ）。
const ATTRS = ["aria-label", "alt", "title", "placeholder"];
// クエリの書き出し＝URLSearchParams.toString() は / ? : = まで %xx にする（?d=%2Fjapan%2F…）。読める形で出す：
// 意味を持つ & # + % と空白だけ符号化（読み側は URLSearchParams.get のままで同じ値に戻る）。
const enc = s => encodeURIComponent(s).replace(/%(2F|3F|3A|3D|40|2C)/gi, decodeURIComponent);
const qs = q => [...q].map(([k, v]) => enc(k) + "=" + enc(v)).join("&");
function relabel() {
	document.querySelectorAll("[data-t]").forEach(el => { el.textContent = t(el.dataset.t); });
	for (const a of ATTRS) document.querySelectorAll(`[data-t-${a}]`).forEach(el => el.setAttribute(a, t(el.getAttribute(`data-t-${a}`))));
	// キャッチの訳＝英語以外で、訳があるときだけ小さく添える（キャッチ本体は本人の文のまま）
	const tr = document.querySelector(".motto-tr");
	if (tr) tr.hidden = getLang() === "en" || !has(tr.dataset.t);
}
// デモへ持ち回る言語（本人 2026-09-24「lang はデモページへ持ち回って」）＝www に出ている言語そのもの。
// ブラウザの言語で選んだ時も付ける（付けないとデモ側が自分で推し量り直す）。英語は自分で選んだ時だけ付ける（ブラウザが英語なら素の URL のまま）
let chosen = false;
const carried = () => getLang() !== "en" || chosen ? getLang() : null;
const withLang = href => {
	const u = new URL(href, location.origin), l = carried();
	l ? u.searchParams.set("lang", l) : u.searchParams.delete("lang");
	return u.pathname + (u.searchParams.size ? "?" + qs(u.searchParams) : "") + u.hash;
};
const propagate = () => document.querySelectorAll('a[href^="/"]:not([href^="/docs"])').forEach(a => a.setAttribute("href", withLang(a.getAttribute("href"))));
{
	const asked = norm(new URLSearchParams(location.search).get("lang"));
	chosen = !!asked;
	await setLang(asked || norm(navigator.language) || "en");
	relabel();
	document.documentElement.classList.remove("i18n-wait");   // 先頭のスクリプトが隠した本文を、貼り替えが済んだ所で出す
	propagate();
	const sel = document.querySelector("select.lang");
	for (const l of LANGUAGES) sel.append(new Option(l.name, l.code));
	sel.value = getLang();
	sel.addEventListener("change", async () => {
		const c = await setLang(sel.value);
		chosen = true; relabel(); propagate();
		const q = new URLSearchParams(location.search); c === "en" ? q.delete("lang") : q.set("lang", c);
		history.replaceState(null, "", (q.size ? "?" + qs(q) : location.pathname) + location.hash);
	});
}
// Section tabs (Gallery / Get started / Technologies・Gallery の中身は id "demos" のまま) — client-side; swaps the card panels over the ambient globe.
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
// 各アプリ（/japan/・/equal/・/world/…）がほぼ必ず読む世界データは、地球が出てページの読み込みが済み手が空いてから背後で IDB に入れる（prefetch.js）
// ＝同オリジンのアプリが IDB から立つ。データ節約・遅い回線では見送る・デモの iframe を開いている間は止まる。
const whenIdle = cb => (window.requestIdleCallback ? requestIdleCallback(cb, { timeout: 3000 }) : setTimeout(cb, 500));
const afterLoad = cb => document.readyState === "complete" ? cb() : addEventListener("load", cb, { once: true });
const globe = liteGlobe(document.getElementById('mapContainer'), {
	src: "/earth-lite.webp",
	onFirstFrame: () => afterLoad(() => whenIdle(async () => {
		const { shouldPrefetch, prefetchWorldData } = await import("./prefetch.js");
		if (shouldPrefetch()) prefetchWorldData().catch(e => console.warn("[prefetch]", e));
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
const tpl = document.getElementById("demoFrame"), backBtn = document.querySelector("nav .back"), logo = document.querySelector("nav .logo"), popout = document.querySelector("nav .popout");
let frame = null;
// ?d= には lang を書かない（www 自身の ?lang= が言語の正本＝開く時に withLang で付ける）
const demoPath = p => { try { const u = new URL(p, location.origin); u.searchParams.delete("lang"); return u.origin === location.origin && u.pathname !== "/" ? u.pathname + (u.searchParams.size ? "?" + qs(u.searchParams) : "") + u.hash : null; } catch { return null; } };
function showDemo(path, title) {
	if (!frame || frame.dataset.path !== path) {
		frame?.remove();
		frame = tpl.cloneNode(false);
		frame.removeAttribute("id"); frame.hidden = false; frame.className = "demo-frame";
		frame.dataset.path = path; frame.title = title || "Demo"; frame.src = withLang(path);   // ?d= で直接来た時も言語を付ける
		frame.addEventListener("load", () => { try { frame.contentWindow.focus(); } catch { /* 読み込み失敗 */ } }, { once: true });   // キー操作（矢印・Esc 等）がすぐデモに届く
		tpl.after(frame);
	}
	backBtn.hidden = false;
	popout.hidden = false; popout.href = withLang(path);
	logo.setAttribute("role", "button"); logo.tabIndex = 0; logo.title = backBtn.textContent.replace("←", "").trim();   // デモの間はロゴも「戻る」
	document.body.classList.add("in-demo"); globe?.pause();   // globe＝WebGL の無い端末では null（B11・旧＝ここで TypeError でデモが開かなかった）
}
function hideDemo() {
	frame?.remove(); frame = null;   // デモの GPU とメモリを返す
	backBtn.hidden = true;
	popout.hidden = true;
	logo.removeAttribute("role"); logo.removeAttribute("tabindex"); logo.removeAttribute("title");
	document.body.classList.remove("in-demo"); globe?.resume();
}
const listUrl = () => { const q = new URLSearchParams(location.search); q.delete("d"); return (q.size ? "?" + qs(q) : location.pathname) + location.hash; };
document.addEventListener("click", e => {
	const a = e.target.closest?.("#panel-demos a.card");
	if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
	if (a.dataset.frame === "0") return;   // iframe に入れないデモ（中の頁が COEP を送らない）＝普通に開く
	const path = demoPath(a.getAttribute("href")); if (!path) return;
	e.preventDefault();
	const q = new URLSearchParams(location.search); q.set("d", path);
	history.pushState({ demo: path }, "", "?" + qs(q));
	showDemo(path, a.querySelector(".card-title")?.textContent);
});
// 戻る＝ナビの「戻る」ボタンとロゴ（Ortho Earth）の両方（本人 2026-09-24「ロゴを押しても戻る」）。ロゴは一覧を見ている間は何もしない
const backToList = () => { if (history.state?.demo) history.back(); else { history.replaceState(null, "", listUrl()); hideDemo(); } };
backBtn.addEventListener("click", backToList);
// 別ウィンドウで開く（本人 2026-09-24）＝押した瞬間の iframe の中の URL（同じオリジン＝デモの中で動いた先・視点の URL 等）を開く。読めなければ開いた時のパス
popout.addEventListener("click", () => {
	try { const u = frame?.contentWindow?.location; if (u && u.origin === location.origin && u.pathname !== "blank") popout.href = /[?&]lang=/.test(u.search) ? u.pathname + u.search + u.hash : withLang(u.pathname + u.search + u.hash); } catch { /* 読めない＝開いた時のパスのまま */ }   // デモが URL を書き換えて lang を落としていたら付け直す
});
logo.addEventListener("click", () => { if (frame) backToList(); });
logo.addEventListener("keydown", e => { if (frame && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); backToList(); } });
addEventListener("popstate", e => { const p = e.state?.demo ?? demoPath(new URLSearchParams(location.search).get("d") || ""); p ? showDemo(p) : hideDemo(); });
{ const d = new URLSearchParams(location.search).get("d"); const p = d && demoPath(d); if (p) showDemo(p); }

// 始める：依頼文の「Copy」＝直前の pre をそのままクリップボードへ（2026-09-25）
document.addEventListener("click", async e => {
	const b = e.target.closest?.(".copy-btn"); if (!b) return;
	const text = b.previousElementSibling?.textContent ?? "";
	let ok = false;
	try { await navigator.clipboard.writeText(text); ok = true; }
	catch {   // クリップボード API を拒む環境（埋め込み・権限）＝選択して旧来の copy。それも駄目なら選択したまま見せる
		const r = document.createRange(); r.selectNodeContents(b.previousElementSibling); getSelection().removeAllRanges(); getSelection().addRange(r);
		try { ok = document.execCommand("copy"); } catch {}
	}
	if (!ok) return;
	b.textContent = t("Copied");
	setTimeout(() => { b.textContent = t("Copy"); }, 1600);
});
