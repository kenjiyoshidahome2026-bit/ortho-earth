// ガジェット：計器盤（デバッグログ・座標テーブル・距離スケール・出典）。DOMのみ＝更新は main.js。
// keys＝orthoJapan({instruments}) の起動パラメータ：true=全部（既定）／配列=選択的（"pos","scale","attr","log"）。
// 出典の文言＝日本のデータ源の名乗り。DOM順は最後尾群＝下辺の静かな層。
// ★"attr"（出典）を出さない場合でも、地理院タイル・PLATEAU・AW3D30 の出典明記義務は消えない＝
//   埋め込み側が自分のページのどこかに同等の出典を記述すること（README「出典表記」参照）。
import { tr } from "../i18n.ts";
import { dockStack } from "./stack.ts";
const t = tr();
/** true＝全部（既定）／配列＝選択的（"pos","scale","attr","log"）／false＝出さない */
export type InstrumentsSpec = boolean | string[];
/** 地域宣言の出典（行ごとの { href, key（i18n の英語キー）| text } ＋ 末尾の加工注記の鍵） */
export interface AttributionDecl { lines: { href?: string; key?: string; text?: string }[][]; note: string }
const KEYS = ["log", "pos", "scale", "attr"];
// 出典の組み立て＝地域宣言の attribution（{ lines:[[{href,key|text}…]…], note } の列）→ HTML。#attr の中身と、#attr の無い画面での
// shot の焼き込み（globe が圏ごとに組む）の共通の源。末尾は加工注記＋© を必ず付ける（地域に依らない）
// 宣言は地域・プラグインの手書き＝npm で外にも出る部品なので、href と生の text は HTML として逃がす（訳語 t(key) は自前の辞書＝そのまま）
const escAttr = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const A = (href: string | undefined, label: string | undefined) => href && /^(?:https?:|mailto:|\/)/i.test(href) ? `<a href="${escAttr(href)}" target="_blank" rel="noopener">${label}</a>` : label;
const renderAttribution = (at: AttributionDecl) => at.lines.map((line, i) => (i ? "" : t("Sources: ")) + line.map(x => A(x.href, x.key ? t(x.key) : escAttr(x.text ?? ""))).join("・")).join("<br>")
	+ `<br>${t(at.note)}© 2026 ` + A("https://www.ortho-earth.com/docs/introduction.html", "Kenji Yoshida");
export const attributionHTML = (attribution: AttributionDecl[] = []): string => attribution.map(renderAttribution).join("<br>");
// 出典の欄（#attr）の形（本人 2026-10-21「右下は (c) 2026 [logo] ortho-earth　データ一覧」・出典が増えて欄が大きくなりすぎた）：
// いつも出すのは 1 行の銘だけ。出典の全文は「データ一覧」で開く札（.attr-full）へ＝全文は DOM に残す（hidden）＝
// textContent で読む検定・shot／print の焼き込み（attrLines）は今まで通り全部を読める。開閉の状態は書き直し（圏・source の増減）でも保つ
const LOGO = `<svg class="attr-logo" viewBox="0 0 100 100" aria-hidden="true"><ellipse cx="50" cy="50" rx="45" ry="45"/><ellipse cx="50" cy="50" rx="25" ry="45"/><path d="M11 28H88M11 72H88M50 5V95M5 50H95"/></svg>`;
export function setAttrHTML(attr: HTMLElement, full: string): void {
	const open = attr.classList.contains("open");
	attr.innerHTML = `<div class="attr-full"${open ? "" : " hidden"}><button type="button" class="attr-close" aria-label="${t("Close")}">×</button><div class="attr-body">${full}</div></div>`
		+ `<div class="attr-bar">© 2026 <a class="attr-brand" href="https://www.ortho-earth.com/" target="_blank" rel="noopener">${LOGO}ortho-earth</a><button type="button" class="attr-more" aria-expanded="${open}">${t("Data sources")}</button></div>`;
	if (attr.dataset.wired) return;
	attr.dataset.wired = "1";
	attr.addEventListener("click", e => {
		const b = (e.target as Element | null)?.closest?.(".attr-more, .attr-close");
		if (!b) return;
		const on = b.classList.contains("attr-more") && !attr.classList.contains("open");
		attr.classList.toggle("open", on);
		attr.querySelector(".attr-full")?.toggleAttribute("hidden", !on);
		attr.querySelector(".attr-more")?.setAttribute("aria-expanded", String(on));
	});
}
/** 出典の全文（HTML）＝札の中身（setAttrHTML 前の素の #attr＝静的な先描きはそのまま） */
export const attrFullHTML = (attr: HTMLElement): string => attr.querySelector(".attr-body")?.innerHTML ?? attr.innerHTML;
export function mountInstruments(mapEl: HTMLElement, keys: InstrumentsSpec = true, attribution: AttributionDecl[] = []): void {
	if (Array.isArray(keys))   // typo は黙って0個になる＝開発時の迷子防止に一声
		for (const k of keys) if (!KEYS.includes(k)) console.warn(`[instruments] unknown key "${k}" (valid: ${KEYS.join(", ")})`);
	const want = (k: string) => keys === true || (Array.isArray(keys) && keys.includes(k));
	const els: HTMLElement[] = [];
	// 左下の読み物（log・pos）は #dock へ＝下から積む（重なりの構造的排除）。scale/attr は従来どおり #map 直下（下辺中央/右）。
	if (want("log")) {   // デバッグログ（常時非表示＝devtoolsで#logを出す人向け。表示時＝ドックの縁）
		const log = document.createElement("div");
		log.id = "log"; log.textContent = t("Starting…");
		dockStack(mapEl).append(log);
	}
	if (want("pos")) {   // 座標読み取り（左下＝ドックの定位置）。非搭載なら標高照会も止まる（main側 hasPos ゲート）
		const pos = document.createElement("div");
		pos.id = "pos";
		dockStack(mapEl).append(pos);
	}
	if (want("scale")) {   // 距離スケール（下辺中央・真俯瞰のみ）
		const scale = document.createElement("div");
		scale.id = "scale"; scale.innerHTML = `<span id="scale-txt"></span><div id="scale-bar"></div>`;
		els.push(scale);
	}
	if (want("attr")) {   // 出典（右下・最も静か）
		// 養子縁組（LCP前倒し・2026-08-04）：index.html が同文の静的 #attr[data-boot] を幕の上に先描き
		//（初回ペイントでLCP確定＝従来はここでの生成~2.0sが律速）。あれば実体を引き取り #map 配下へ移す。
		// data-boot を剥がすと boot 用インラインCSSが外れ quiet-mono の #attr 意匠へ自然に切り替わる。
		// 埋め込みページ（静的版なし）は従来どおり新規生成。
		const boot = document.querySelector<HTMLElement>("#attr[data-boot]");
		const attr = boot || document.createElement("div");
		if (boot) boot.removeAttribute("data-boot"); else attr.id = "attr";
		// 中身は**地域宣言が持つ**（packages/jp/src/region.ts・nl/region.js の attribution）＝この gadget は組み立てるだけ。
		// 入口ごとに出典が差し替わる理由：日本のデータを出していない画面に地理院・PLATEAU を並べるのは、
		// 表示義務以前に嘘になる（3DBAG は CC BY 4.0＝表示が義務）。2026-09-17 に宣言へ移設。
		// 行割りは iPhone 幅（375px・11px 字）で折り返さないことを基準＝宣言側が行で分ける。#attr の
		// text-wrap:balance は超狭幅の保険。末尾は加工注記＋© を必ず付ける（地域に依らない）。
		setAttrHTML(attr, attributionHTML(attribution));
		els.push(attr);
	} else document.querySelector("#attr[data-boot]")?.remove();   // 出典を出さない構成＝静的版も残さない（埋め込み側の出典明記義務は README どおり）
	mapEl.append(...els);
}
