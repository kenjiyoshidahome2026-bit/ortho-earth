// Wikipedia 連動（都道府県・市区町村ビューの顔）。日本語版のみ（裁定 2026-08-12）。
// タイトル解決は実行時に推測しない＝Wikidata P429（全国地方公共団体コード）から焼いた対応表
// （data/wiki-titles.json・scripts/build-wiki-titles.mjs）＝同名市区町村（府中市×2・伊達市×2・池田町×4…）を
// 構造的に封じる。取得は Wikimedia REST summary（CORS開放済み・proxy不要）＋IDBキャッシュ TTL30日。
// 差し込みは onDrill 購読の後追い（_fillTrends と同じ作法）＝ドリルUI本体は Wikipedia を知らない。
import { onDrill } from "./census/ui.js";
import { escHtml } from "./ui/shared.js";
import { nativeBucket } from "native-bucket";
import WIKI_TITLES from "./data/wiki-titles.json" with { type: "json" };

const TTL = 30 * 24 * 3600 * 1000;
let _cacheP = null;
const getCache = () => (_cacheP ||= nativeBucket("https://api.ortho-earth.com").Cache("census2020/wiki"));

export function initWiki() {
	onDrill(e => {
		closeFrame();   // ドリル遷移＝開いている記事は閉じる（古い記事が地図に残らない・本人要望2026-08-14）
		if (e.level !== "pref" && e.level !== "city" && e.level !== "designated") return;
		const title = WIKI_TITLES[e.code];
		if (title) inject(title);
	});
	// 右パネルでの操作（チップ/ドリル等のクリック）でも閉じる。capture＝wikiカード自身のクリックより先に走る
	// ＝「閉じてから開く」の順になり、カードから開く動作は壊れない。
	document.getElementById("panel")?.addEventListener("click", () => closeFrame(), { capture: true });
}

let _closeFrame = null;   // 現在開いている記事オーバーレイの閉じ手（Esc リスナ解除込み）
function closeFrame() { _closeFrame?.(); }

async function inject(title) {
	const wrap = document.querySelector("#panel-body .cs-drill-wrap");
	if (!wrap || wrap.querySelector(".c20-wiki")) return;
	const div = document.createElement("div");
	div.className = "c20-wiki";
	div.innerHTML = `<h3>Wikipedia</h3><div class="c20-wiki-body" style="color:#9ab;font-size:12px">読み込み中…</div>`;
	const head = wrap.querySelector(".cs-drill-head");
	head ? head.after(div) : wrap.appendChild(div);   // タイトル直下＝国勢調査の上（目立つ位置・本人要望2026-08-14）
	const body = div.querySelector(".c20-wiki-body");
	try {
		const s = await summary(title);
		if (!body.isConnected) return;   // 取得中に画面遷移＝捨てる
		if (!s?.extract) { div.remove(); return; }
		body.innerHTML = `
			${s.thumbnail ? `<img src="${escHtml(s.thumbnail)}" alt="">` : ""}
			<p>${escHtml(s.extract)}</p>
			<div style="clear:both;padding-top:5px;font-size:10px;color:#89a">テキスト: CC BY-SA 4.0</div>`;
		if (!CAN_FRAME) div.classList.add("c20-wiki-tab");   // credentialless iframe 非対応（Safari等）＝新しいタブへ（カードの文言も切替）
		div.addEventListener("click", () => CAN_FRAME ? openFrame(title, s.url) : window.open(s.url, "_blank", "noopener"));   // カード全体がリンク
	} catch { div.remove(); }
}

// 記事を地図の上に iframe で重ねて表示（ja.wikipedia.org 通常ページは frame-ancestors/X-Frame-Options
// 無し＝埋め込み可を実測確認 2026-08-14。REST 版 mobile-html は SAMEORIGIN で不可）。
// ★本アプリは SAB のため COEP:credentialless＝入れ子 iframe には CORP が要求され通常の iframe は
// エッジで遮断される（ERR_BLOCKED_BY_RESPONSE corp-…-by-coep を実測）。正式な逃げ道＝
// <iframe credentialless>（無資格・使い捨てコンテキスト＝COEP の埋め込み制約を免除・Chrome/Edge）。
// #stage の末尾に append＝DOM順で canvas/計器より上（z-index 不使用の掟）。✕ か Esc で閉じる。
const CAN_FRAME = "credentialless" in HTMLIFrameElement.prototype;
function openFrame(title, url) {
	const stage = document.getElementById("stage");
	if (!stage) return;
	closeFrame();   // 開き直し＝前の記事の Esc リスナごと確実に畳む
	const f = document.createElement("div");
	f.className = "c20-wiki-frame";
	f.innerHTML = `<div class="c20-wf-bar"><span class="c20-wf-title">Wikipedia — ${escHtml(title)}</span>
		<a href="${escHtml(url)}" target="_blank" rel="noopener">新しいタブで開く ↗</a>
		<button type="button" aria-label="閉じる">✕</button></div>
		<iframe credentialless src="${escHtml(url)}" referrerpolicy="no-referrer" title="Wikipedia: ${escHtml(title)}"></iframe>`;
	const close = () => { f.remove(); removeEventListener("keydown", esc); if (_closeFrame === close) _closeFrame = null; };
	const esc = e => { if (e.key === "Escape") close(); };
	f.querySelector("button").addEventListener("click", close);
	addEventListener("keydown", esc);
	stage.appendChild(f);
	_closeFrame = close;
}

async function summary(title) {
	const cache = await getCache();
	const key = `sum::${title}`;
	const hit = await cache(key).catch(() => null);
	if (hit?.data && Date.now() - hit.t < TTL) return hit.data;
	const r = await fetch(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
	if (!r.ok) return hit?.data ?? null;   // 失敗時は期限切れキャッシュでも出す（無いよりまし）
	const j = await r.json();
	const data = {
		extract: j.extract || "",
		thumbnail: j.thumbnail?.source || null,
		url: j.content_urls?.desktop?.page || `https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}`,
	};
	cache(key, { t: Date.now(), data }).catch(() => {});
	return data;
}
