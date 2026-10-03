// Wikipedia 連動（都道府県・市区町村ビューの顔）。日本語版のみ（裁定 2026-08-12）。
// タイトル解決は実行時に推測しない＝Wikidata P429（全国地方公共団体コード）から焼いた対応表
// （data/wiki-titles.json・scripts/build-wiki-titles.mjs）＝同名市区町村（府中市×2・伊達市×2・池田町×4…）を
// 構造的に封じる。取得と枠＝@ortho-earth/globe/wiki.js の共通の芯（2026-10-03・アプリ横断の統一）：
// 冒頭＝Wikimedia REST summary（IDB 30 日）、記事＝頁の上の <iframe credentialless>（この頁は COEP credentialless＝
// 素の iframe は遮断される・非対応ブラウザは別タブ）。
// 差し込みは onDrill 購読の後追い（_fillTrends と同じ作法）＝ドリルUI本体は Wikipedia を知らない。
import { onDrill } from "./census/ui.js";
import { escHtml } from "./ui/shared.js";
import { createWikiFrame, summary, CAN_FRAME } from "@ortho-earth/globe/wiki.js";
import WIKI_TITLES from "./data/wiki-titles.json" with { type: "json" };

let frame = null;   // 記事の枠（#stage の末尾＝DOM順で canvas/計器より上・z-index 不使用の掟）。✕ か Esc で閉じる
const getFrame = () => frame ||= createWikiFrame({ host: document.getElementById("stage"), className: "c20-wiki-frame", labels: { newTab: "新しいタブで開く", close: "閉じる" } });

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

function closeFrame() { frame?.close(); }

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
		const s = await summary(title, "ja");
		if (!body.isConnected) return;   // 取得中に画面遷移＝捨てる
		if (!s?.extract) { div.remove(); return; }
		body.innerHTML = `
			${s.thumbnail ? `<img src="${escHtml(s.thumbnail)}" alt="">` : ""}
			<p>${escHtml(s.extract)}</p>
			<div style="clear:both;padding-top:5px;font-size:10px;color:#89a">テキスト: CC BY-SA 4.0</div>`;
		if (!CAN_FRAME) div.classList.add("c20-wiki-tab");   // credentialless iframe 非対応（Safari等）＝新しいタブへ（カードの文言も切替）
		div.addEventListener("click", () => { if (document.getElementById("stage")) getFrame().open(s.url, title); else window.open(s.url, "_blank", "noopener"); });   // カード全体がリンク
	} catch { div.remove(); }
}
