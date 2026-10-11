// Wikipedia の共通の芯（2026-10-03・アプリ横断の統一）。census2020・world・ortho-globe（physical）・ortho-japan（parks）が
// 別々に持っていた「記事の URL を組む・冒頭（REST summary）を取る・記事を頁の上の iframe で読む・候補を探す」を 1 本に。
// 辞書（どの地物がどの記事か）と置き場所・見た目の寸法は各アプリに残す＝ここは「探す・取る・開く」だけ（i18n/core.js と同じ分け方）。
//
//   import { createWikiFrame, summaryIn, wikiUrl } from "@ortho-earth/globe/wiki.js";
//   const frame = createWikiFrame({ host: map.mapEl, className: "my-wiki", labels: { newTab: t("Open in a new tab"), close: t("Close") } });
//   frame.link(anchor, wikiUrl("富士山", "ja"), "富士山");      // クリック＝枠で開く（修飾キー・非対応ブラウザ＝別タブ）
//   const s = await summaryIn({ ja: "富士山", en: "Mount Fuji" }, ["fr", "en", "ja"]);   // 言語の順で最初に見つかった冒頭
//
// 契約：
//   ・表示は iframe（「frame」・Kenji 2026-10-03）。記事は m. 版（狭い枠でも読みやすい）、↗ は通常版を別タブで
//   ・頁が COEP credentialless でも素の iframe は Wikipedia が CORP/COEP を返さず遮断される＝<iframe credentialless>（Chrome/Edge）で免除。
//     非対応（Safari・Firefox）＝CAN_FRAME=false＝open() は別タブへ逃がす（link() はリンクの既定に任せる）
//   ・summary＝Wikimedia REST page/summary（CORS 開放・資格情報なし）。IDB（native-bucket の Cache）に 30 日・失敗時は期限切れでも出す
//   ・この file に t("…") を書かない（i18n の走査器は packages/globe/src を本体として読む）＝文言は呼び手が labels で渡す
import { Cache } from "native-bucket";

export const LOGO = "https://upload.wikimedia.org/wikipedia/commons/8/80/Wikipedia-logo-v2.svg";
export const CAN_FRAME = typeof HTMLIFrameElement !== "undefined" && "credentialless" in HTMLIFrameElement.prototype;
export const DEFAULT_FALLBACK = ["en", "ja"];   // 自分の言語に記事が無い時の順（parks と同じ：英語 → 日本語）

// ── URL ──
export const wikiTitle = title => String(title ?? "").trim().replace(/ /g, "_");
export const wikiUrl = (title, lang = "en", { mobile = false } = {}) => `https://${lang}${mobile ? ".m" : ""}.wikipedia.org/wiki/${encodeURIComponent(wikiTitle(title))}`;
export const toMobile = url => String(url).replace(/^(https?:\/\/[a-z-]+)\.wikipedia\.org\//, "$1.m.wikipedia.org/");
export const toDesktop = url => String(url).replace(/^(https?:\/\/[a-z-]+)\.m\.wikipedia\.org\//, "$1.wikipedia.org/");
export const parseWikiUrl = url => {
	const m = String(url ?? "").match(/^https?:\/\/([a-z-]+?)(?:\.m)?\.wikipedia\.org\/wiki\/([^?#]+)/);
	if (!m) return null;
	let title = m[2]; try { title = decodeURIComponent(title); } catch { /* 壊れた %＝そのまま */ }
	return { lang: m[1], title: title.replace(/_/g, " ") };
};
// 言語の順（自分の言語 → 控え）。重複と空は落とす
export const langChain = (lang, fallback = DEFAULT_FALLBACK) => [...new Set([lang, ...fallback].filter(Boolean))];
// { lang: 記事名 } から langs の順で最初の記事（無ければ null）
export const pickTitle = (titles, langs) => { for (const l of langs || []) { const t = titles?.[l]; if (t) return { lang: l, title: t }; } return null; };

// ── 冒頭（REST summary）──
const TTL = 30 * 24 * 3600 * 1000;
const mem = new Map();          // 同じ頁の中では 1 回だけ取る
let _idb = null;                // IDB は遅延で開く（private mode 等で開けなければメモリだけで続ける）
const idb = () => _idb ||= Cache("wiki/summary").catch(() => null);
const sumKey = (title, lang) => `${lang}::${wikiTitle(title)}`;
export const SUMMARY_URL = (title, lang) => `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiTitle(title))}`;
const shape = (j, title, lang) => ({
	lang, title: j.title || String(title),
	extract: j.extract || "", extractHtml: j.extract_html || "", description: j.description || "",
	thumbnail: j.thumbnail?.source || null,
	url: j.content_urls?.desktop?.page || wikiUrl(title, lang),
});
// 記事の冒頭。戻り＝{ lang, title, extract, extractHtml, description, thumbnail, url }／無い・取れない＝null
export async function summary(title, lang = "en", { ttl = TTL, signal, fetch: f = globalThis.fetch } = {}) {
	if (!title) return null;
	const key = sumKey(title, lang);
	if (mem.has(key)) return mem.get(key);
	const store = await idb();
	const hit = store ? await store(key).catch(() => null) : null;
	if (hit?.data && Date.now() - hit.t < ttl) { mem.set(key, hit.data); return hit.data; }
	let data = null;
	try {
		const r = await f(SUMMARY_URL(title, lang), { credentials: "omit", headers: { Accept: "application/json" }, signal });
		if (r.ok) data = shape(await r.json(), title, lang);
		else if (r.status !== 404) data = hit?.data ?? null;   // 失敗時は期限切れでも出す（無いよりまし）。404＝記事なし
	} catch (e) { if (e?.name === "AbortError") throw e; data = hit?.data ?? null; }
	if (data) { mem.set(key, data); store?.(key, { t: Date.now(), data }).catch(() => {}); }
	return data;
}
// { lang: 記事名 } を langs の順に試し、最初に取れた冒頭（無ければ null）
export async function summaryIn(titles, langs, opts) {
	for (const l of langs || []) {
		const t = titles?.[l]; if (!t) continue;
		const s = await summary(t, l, opts);
		if (s?.extract) return s;
	}
	return null;
}

// ── 候補を探す（action=opensearch・CORS は origin=*）。戻り＝[{ title, description, url }] ──
export async function search(query, lang = "en", { limit = 10, signal, fetch: f = globalThis.fetch } = {}) {
	const q = String(query ?? "").trim(); if (!q) return [];
	const u = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&format=json&origin=*&namespace=0&limit=${limit}&search=${encodeURIComponent(q)}`;
	const r = await f(u, { credentials: "omit", signal });
	if (!r.ok) return [];
	const [, titles = [], descs = [], urls = []] = await r.json();
	return titles.map((title, i) => ({ title, description: descs[i] || "", url: urls[i] || wikiUrl(title, lang) }));
}

// ── 記事の枠（頁の上の iframe）──
// host の末尾に append＝DOM 順で地図の上。位置・寸法は呼び手の className の CSS で（既定＝host いっぱい・10px の余白）。
//   labels … { newTab, close }（呼び手の t() で訳して渡す）。関数なら open() の度に引く（言語を切り替える頁）
//   mobile … iframe は m. 版（既定 true）。↗ は常に通常版
//   esc    … Escape で閉じる（既定 true）。自前の Escape 管理を持つ頁（world）は false にして onOpen/onClose で繋ぐ
//   onOpen(url, name) / onClose() … 音・Escape の積み直し等
let _cssDone = false;
const BASE_CSS = `
.oe-wiki{position:absolute;inset:10px;z-index:30;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;
 background:#fff;color:#1b2333;border-radius:var(--oe-wiki-radius,12px);border:1px solid var(--oe-wiki-border,rgba(0,0,0,.18));box-shadow:var(--oe-wiki-shadow,0 14px 48px rgba(0,0,0,.45));
 font:13px/1.4 var(--oe-wiki-font,system-ui,sans-serif)}
.oe-wiki[hidden]{display:none}
.oe-wiki-bar{flex:none;display:flex;align-items:center;gap:8px;min-height:36px;padding:4px 6px 4px 10px;background:var(--oe-wiki-bar-bg,#0e1530);color:var(--oe-wiki-bar-fg,#cdd6e6)}
.oe-wiki-logo{flex:none;height:22px;width:22px;object-fit:contain;background:#fff;border-radius:50%}
.oe-wiki-title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oe-wiki-newtab,.oe-wiki-close{flex:none;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:1;cursor:pointer;text-decoration:none;padding:0}
.oe-wiki-newtab:hover,.oe-wiki-close:hover{background:rgba(255,255,255,.14)}
.oe-wiki-frame{flex:1;min-height:0;width:100%;border:0;background:#fff}`;
const ensureCss = () => {
	if (_cssDone || typeof document === "undefined") return; _cssDone = true;
	const s = document.createElement("style"); s.setAttribute("data-oe-wiki", ""); s.textContent = BASE_CSS;
	document.head.prepend(s);   // 先頭＝呼び手の CSS（後で読まれる）が同じ強さで勝つ
};
const escHtml = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function createWikiFrame({ host, className = "", labels = {}, mobile = true, esc = true, logo = true, onOpen, onClose, stopEvents = true } = {}) {
	if (!host) throw new Error("createWikiFrame: host is required");
	ensureCss();
	const L = () => { const l = (typeof labels === "function" ? labels() : labels) || {}; return { newTab: l.newTab || "Open in a new tab", close: l.close || "Close" }; };
	const el = document.createElement("div");
	el.className = ("oe-wiki " + className).trim(); el.hidden = true;
	el.innerHTML = `<div class="oe-wiki-bar">${logo ? `<img class="oe-wiki-logo" alt="Wikipedia" src="${LOGO}">` : ""}<b class="oe-wiki-title"></b>` +
		`<a class="oe-wiki-newtab" target="_blank" rel="noopener">↗</a><button class="oe-wiki-close" type="button">✕</button></div>` +
		`<iframe class="oe-wiki-frame" title="Wikipedia" credentialless referrerpolicy="no-referrer"></iframe>`;
	const $ = c => el.querySelector("." + c);
	const title = $("oe-wiki-title"), newtab = $("oe-wiki-newtab"), closeBtn = $("oe-wiki-close"), frame = $("oe-wiki-frame");
	const relabel = () => { const l = L(); newtab.title = l.newTab; newtab.setAttribute("aria-label", l.newTab); closeBtn.title = l.close; closeBtn.setAttribute("aria-label", l.close); };
	relabel();
	if (stopEvents) for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu", "touchstart"]) el.addEventListener(ev, e => e.stopPropagation());   // 枠の上の操作を地図に渡さない
	let url = null;
	const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
	function open(u, name = "") {
		if (!u) return false;
		if (!CAN_FRAME) { window.open(u, "_blank", "noopener"); return false; }   // credentialless 非対応＝別タブ
		url = toDesktop(u);
		title.textContent = name || parseWikiUrl(url)?.title || "";
		newtab.href = url; relabel();
		frame.src = mobile ? toMobile(url) : url;
		el.hidden = false;
		if (esc) addEventListener("keydown", onKey);
		onOpen?.(url, name);
		return true;
	}
	function close() {
		if (el.hidden) return false;
		el.hidden = true; url = null;
		frame.src = "about:blank";   // 読み込み・音を止める（属性を外すだけでは止まらない）
		if (esc) removeEventListener("keydown", onKey);
		onClose?.();
		return true;
	}
	// <a> を枠のリンクにする：href は通常版（右クリック・修飾キー・非対応ブラウザ＝ブラウザの既定＝別タブ）
	function link(a, u, name = "") {
		a.href = u; a.target = "_blank"; a.rel = "noopener";
		a.addEventListener("click", e => { if (!CAN_FRAME || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return; e.preventDefault(); open(u, name); });
		return a;
	}
	closeBtn.addEventListener("click", close);
	host.appendChild(el);
	return { el, open, close, link, get url() { return url; }, get isOpen() { return !el.hidden; }, remove() { close(); el.remove(); } };
}
