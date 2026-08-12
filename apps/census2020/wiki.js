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
		if (e.level !== "pref" && e.level !== "city" && e.level !== "designated") return;
		const title = WIKI_TITLES[e.code];
		if (title) inject(title);
	});
}

async function inject(title) {
	const wrap = document.querySelector("#panel-body .cs-drill-wrap");
	if (!wrap || wrap.querySelector(".c20-wiki")) return;
	const div = document.createElement("div");
	div.className = "c20-wiki cs-drill-display";
	div.innerHTML = `<h3 class="cs-drill-sec-h3">Wikipedia</h3><div class="c20-wiki-body" style="color:#9ab;font-size:12px">読み込み中…</div>`;
	wrap.appendChild(div);
	const body = div.querySelector(".c20-wiki-body");
	try {
		const s = await summary(title);
		if (!body.isConnected) return;   // 取得中に画面遷移＝捨てる
		if (!s?.extract) { div.remove(); return; }
		body.innerHTML = `
			${s.thumbnail ? `<img src="${escHtml(s.thumbnail)}" alt="">` : ""}
			<p>${escHtml(s.extract)}</p>
			<div style="clear:both;padding-top:6px"><a class="c20-wiki-link" href="${escHtml(s.url)}" target="_blank" rel="noopener">Wikipediaで読む</a>
			<span style="font-size:10px;color:#89a">（テキスト: CC BY-SA 4.0）</span></div>`;
	} catch { div.remove(); }
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
