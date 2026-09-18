// ortho-equal の頁＝殻。部品（equal.js の createEqual）を画面いっぱいに置き、URL（?lang ?labels ?hypso ?choro ?g ?csv と #z/lat/lon）との往復だけを持つ。
// 部品は受け取った div の中だけで生きる＝サンプル集・埋め込みも同じ口（sample.html）。
import { createEqual } from "./equal.js";
import { t } from "./i18n.js";

const app = await createEqual({ target: "#app", params: location.search, hash: true });
globalThis.equal = app;   // 検証・コンソール用の口（旧来と同じ名前＝equal.setView(…)・equal.openCSV(file)…）

// 戻り口＝アプリ間の URL の約束（solar と同じ・2026-09-19）：呼び出し元が ?back=<同一オリジンの URL> を渡した時だけ「← 戻る」。
// 来た道なら history.back()（出た時の状態そのまま）・でなければ back へ。他オリジンは捨てる（開いたリダイレクトにしない）
const BACK = (() => {
	const b = new URLSearchParams(location.search).get("back"); if (!b) return null;
	try {
		const u = new URL(b, location.href), local = h => h === "localhost" || h === "127.0.0.1";
		return u.origin === location.origin || (local(u.hostname) && local(location.hostname)) ? u : null;
	} catch { return null; }
})();
if (BACK) app.addButton({
	text: t("Back"), title: t("Go back to the page you came from"), arrow: true,
	onClick: () => {
		const from = document.referrer ? new URL(document.referrer) : null;
		if (from && from.origin === BACK.origin && from.pathname === BACK.pathname && history.length > 1) history.back();
		else location.href = BACK.href;
	},
});
