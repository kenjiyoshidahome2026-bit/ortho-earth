// ortho-solar の頁＝殻。部品（solar.js の createSolar）を画面いっぱいに置き、URL との往復と頁の顔（題名・言語・向き）だけを持つ。
// 部品は受け取った div の中だけで生きる＝サンプル集・埋め込みも同じ口（sample.html）。
import { createSolar } from "./solar.js";
import { tr, setLang, getLang, isRTL } from "./i18n.js";

// 言語：?lang=xx で固定・無指定はブラウザ既定（japan のガジェットからの導線は ?lang=<今の UI 言語> つき）
await setLang();
const t = tr();
document.documentElement.lang = getLang();
document.documentElement.dir = isRTL() ? "rtl" : "ltr";
document.title = t("ortho-solar — the Solar System, heliocentric");

// hash:true＝視点・時刻・速度・星座を URL のハッシュと往復（共有リンク・読み直しで同じ場面へ）
const app = await createSolar({ target: "#app", hash: true });

// 戻り口＝アプリ間の URL の約束（2026-09-19 本人裁定「単体なら要らない・統一的な考え方で」）：
//   呼び出し元が ?back=<戻り先の URL（同一オリジン）> を付けて開いた時だけ「← 戻る」を出す。単体で開いたら出さない。
//   押す＝来た道がその頁なら history.back()（出た時の状態そのまま＝japan の視点・bfcache）、でなければ back へ遷移。
//   部品は呼び出し元の名前も場所も知らない＝ボタンは殻が addButton で足す。他オリジンの back は捨てる＝開いたリダイレクトにしない。
//   開発は localhost/127.0.0.1 どうしなら別ポートでも可（japan 5173 → solar 5199）
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
