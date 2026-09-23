// ガジェット：計器盤（デバッグログ・座標テーブル・距離スケール・出典）。DOMのみ＝更新は main.js。
// keys＝orthoJapan({instruments}) の起動パラメータ：true=全部（既定）／配列=選択的（"pos","scale","attr","log"）。
// 出典の文言＝日本のデータ源の名乗り。DOM順は最後尾群＝下辺の静かな層。
// ★"attr"（出典）を出さない場合でも、地理院タイル・PLATEAU・AW3D30 の出典明記義務は消えない＝
//   埋め込み側が自分のページのどこかに同等の出典を記述すること（README「出典表記」参照）。
import { tr } from "../i18n.js";
import { dockStack } from "./stack.js";
const t = tr();
const KEYS = ["log", "pos", "scale", "attr"];
export function mountInstruments(mapEl, keys = true, attribution = []) {
	if (Array.isArray(keys))   // typo は黙って0個になる＝開発時の迷子防止に一声
		for (const k of keys) if (!KEYS.includes(k)) console.warn(`[instruments] unknown key "${k}" (valid: ${KEYS.join(", ")})`);
	const want = k => keys === true || (Array.isArray(keys) && keys.includes(k));
	const els = [];
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
		const boot = document.querySelector("#attr[data-boot]");
		const attr = boot || document.createElement("div");
		if (boot) boot.removeAttribute("data-boot"); else attr.id = "attr";
		// 中身は**地域宣言が持つ**（packages/jp/src/region.js・nl/region.js の attribution）＝この gadget は組み立てるだけ。
		// 入口ごとに出典が差し替わる理由：日本のデータを出していない画面に地理院・PLATEAU を並べるのは、
		// 表示義務以前に嘘になる（3DBAG は CC BY 4.0＝表示が義務）。2026-09-17 に宣言へ移設。
		// 行割りは iPhone 幅（375px・11px 字）で折り返さないことを基準＝宣言側が行で分ける。#attr の
		// text-wrap:balance は超狭幅の保険。末尾は加工注記＋© を必ず付ける（地域に依らない）。
		const A = (href, label) => href ? `<a href="${href}" target="_blank" rel="noopener">${label}</a>` : label;
		const render = at => at.lines.map((line, i) => (i ? "" : t("Sources: ")) + line.map(x => A(x.href, x.key ? t(x.key) : x.text)).join("・")).join("<br>")
			+ `<br>${t(at.note)}© 2026 ` + A("https://www.ortho-earth.com/docs/introduction.html", "Kenji Yoshida");
		attr.innerHTML = attribution.map(render).join("<br>");
		els.push(attr);
	} else document.querySelector("#attr[data-boot]")?.remove();   // 出典を出さない構成＝静的版も残さない（埋め込み側の出典明記義務は README どおり）
	mapEl.append(...els);
}
