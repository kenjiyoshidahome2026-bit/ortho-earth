// ortho-equal の頁＝殻。部品（equal.js の createEqual）を画面いっぱいに置き、URL（?lang ?labels ?hypso ?choro ?g ?csv と #z/lat/lon）との往復だけを持つ。
// 部品は受け取った div の中だけで生きる＝サンプル集・埋め込みも同じ口（sample.html）。
import { createEqual } from "@ortho-earth/equal";
import { t } from "@ortho-earth/equal/i18n";

const Q = new URLSearchParams(location.search);
const MORPH = Q.has("morph");   // 球から開いて着いた＝戻る時も球へ畳んでから
const EMBED = Q.get("embed") === "1" && window.parent !== window;   // japan の iframe に重なって開く（同一 URL の受け渡し・2026-09-20）
const app = await createEqual({ target: "#app", params: location.search, hash: true });
globalThis.equal = app;   // 検証・コンソール用の口（旧来と同じ名前＝equal.setView(…)・equal.openCSV(file)…）

// 埋め込み（japan の equal ガジェット）：親と postMessage で話す。origin は dev で別ポート＝"*"（親は event.source＝自分の iframe で見分ける）。
//   → 親へ: { type:"equal:frame" }（最初の 1 枚＝重ねてよい）・{ type:"equal:closed", view:{zoom,lat,lon} }（球へ畳み終えた＝この視点で下の japan を合わせて閉じる）
//   ← 親から: { type:"equal:go" }（見えたので開き始めよ）
if (EMBED) {
	const post = (m: unknown) => window.parent.postMessage(m, "*");
	if (app.drawn) post({ type: "equal:frame" }); else app.on("frame", () => post({ type: "equal:frame" }));
	addEventListener("message", e => { if (e.source === window.parent && e.data?.type === "equal:go") app.releaseMorph(); });
	app.on("closed", view => post({ type: "equal:closed", view }));   // 「地球儀」ボタン／Esc＝球へ畳んで japan へ返す（部品側が emit）
}

// 戻り口＝アプリ間の URL の約束（solar と同じ・2026-09-19）：呼び出し元が ?back=<同一オリジンの URL> を渡した時だけ「← 戻る」。
// 来た道なら history.back()（出た時の状態そのまま）・でなければ back へ。他オリジンは捨てる（開いたリダイレクトにしない）
const BACK = (() => {
	const b = new URLSearchParams(location.search).get("back"); if (!b) return null;
	try {
		const u = new URL(b, location.href), local = (h: string) => h === "localhost" || h === "127.0.0.1";
		return u.origin === location.origin || (local(u.hostname) && local(location.hostname)) ? u : null;
	} catch { return null; }
})();
// 球から開いて来た（?morph＋?back＝japan の低メモリ端末の道・2026-11-27）：球へ畳み終えたら（「← 戻る」・「地球儀」・右クリック「この地点を球体へ」のどれでも）
// その球の視点を呼び出し元の hash へ載せて戻る＝japan が同じ球で開く。重ねて開いた時（embed）の「地球儀＝japan へ返す」と同じ動き
if (BACK && MORPH && !EMBED) {
	let leaving = false;
	addEventListener("pageshow", e => { if (e.persisted) location.reload(); });   // bfcache から戻された＝畳んだ後の抜け殻（下の destroy）＝読み直す
	app.on("parked", v => {
		const s = v as { zoom: number; lat: number; lon: number } | undefined;
		if (leaving || !s) return; leaving = true;
		const rest = BACK.hash.replace(/^#/, "").split("/").filter(Boolean).slice(3);
		const u = new URL(BACK.href); u.hash = "#" + [s.zoom.toFixed(2), s.lat.toFixed(5), s.lon.toFixed(5), ...rest].join("/");
		// 移る前に畳む＝GPU・配列を今すぐ手放す（iOS Safari は離れた頁を bfcache に生かす＝畳まないと戻り先の地図と同時にメモリへ乗る）
		document.documentElement.style.background = document.body.style.background = "#000";   // 球のフレームの地色のまま渡す
		try { app.destroy(); } catch (e) { console.warn("[equal] destroy before leaving", e); }
		location.href = u.href;
	});
}
if (BACK && !EMBED) app.addButton({
	text: t("Back"), title: t("Go back to the page you came from"), arrow: true,
	onClick: () => {
		if (MORPH) { void app.morphOut(); return; }   // 球へ畳む → 上の "parked" が呼び出し元へ戻す
		const from = document.referrer ? new URL(document.referrer) : null;
		if (from && from.origin === BACK.origin && from.pathname === BACK.pathname && history.length > 1) history.back();
		else location.href = BACK.href;
	},
});
