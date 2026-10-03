// ガジェット：UI 言語の切替（26 言語）。標準装備でなくオプトイン＝map.gadget.lang() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 34px 規格のガラスのボタン（.qm-panel-btn・stack.js の約束）に、透明な <select> を重ねる＝押すと OS/ブラウザ標準の一覧が開く
//（スマホは下から出る車輪・PC はドロップダウン）＝自前のパネルを持たない最小の部品。
// 選ぶと ?lang=<code> を URL に書いて読み直す（parks・physical・geopbf-demo が各自でやっていた作法を 1 本に・2026-10-04 デモ品質の段）＝
// 地球儀の注記・地名表・エンジンの文言は起動時の言語で組まれるので、その場で差し替えず読み直すのが正。視点（hash）と他の ?引数 は URL に残る。
import { gadgetStack } from "./stack.js";
import { tr, getLang, LANGUAGES } from "../i18n.js";
const t = tr();
// 「文/A」の記号＝言語の切替の慣用。線色は本線インク直書き（quiet-mono の夜節が自動反転）
const ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
	<path d="M3 5h9M7.5 3v2M11 5c-.6 3.6-3 6.5-6.5 8.5M5.5 7.5c.9 2.3 2.8 4.3 5.5 5.5"/><path d="M13 20l4-10 4 10M14.4 16.6h5.2"/></svg>`;
export function lang({ onChange } = {}) {   // onChange(code)＝既定の「?lang= を書いて読み直す」を差し替える口（SDK の利用者向け）
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#lang-btn")) return;   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "lang-btn"; btn.className = "qm-panel-btn"; btn.type = "button";
	btn.dataset.tip = t("Change language"); btn.setAttribute("aria-label", t("Change language"));
	btn.style.position = "relative";
	btn.innerHTML = ICON;
	const sel = document.createElement("select");
	sel.setAttribute("aria-label", t("Change language"));
	Object.assign(sel.style, { position: "absolute", inset: "0", width: "100%", height: "100%", opacity: "0", cursor: "pointer", font: "16px system-ui" });   // 16px＝iOS の自動ズームを起こさない
	const cur = getLang();
	for (const l of LANGUAGES) { const o = document.createElement("option"); o.value = l.code; o.textContent = l.name; o.lang = l.code; if (l.code === cur) o.selected = true; sel.append(o); }
	sel.addEventListener("change", () => {
		const code = sel.value;
		if (onChange) return onChange(code);
		const u = new URL(location.href); u.searchParams.set("lang", code); location.assign(u);
	});
	btn.append(sel);
	gadgetStack(mapEl).append(btn);
	return btn;
}
