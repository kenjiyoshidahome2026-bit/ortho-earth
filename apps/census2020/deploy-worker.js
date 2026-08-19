// census2020 配信 Worker：静的アセット（dist/site）に COOP/COEP を刻んで返すだけの薄い皮（ortho-nl と同型）。
// この2ヘッダ＝crossOriginIsolated＝SharedArrayBuffer（gint バッファを worker へゼロコピーで渡す）の点火条件。
// ★必須ではない（2026-08-19 実測で訂正）：無ければ geopbf setGintBUF が通常 ArrayBuffer へ落ち、structured clone の
//   コピー1回を払って同じ結果を出す（Safari は COEP:credentialless 非対応＝元からこの世界で動いている）。
//   実測＝apps/ortho-japan `npm run verify:nocoi`（coi=false・SAB=false で gint/描画/識別 7ページ PASS）。
//   つまりここは「自前配信を速くする最適化」であって、SDK として第三者ページへ埋め込む条件ではない。
// dev（vite.config.js の middleware）と同一条件を本番にも刻む＝環境差ゼロ。
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		// 旧URL（/census2020…）→ 新居（/japan/census2020…）へ301。query温存・hashはブラウザが持ち越す（QR・ブックマーク・OGP互換）
		if (url.pathname === "/census2020" || url.pathname.startsWith("/census2020/"))
			return Response.redirect(url.origin + "/japan/census2020" + (url.pathname.slice("/census2020".length) || "/") + url.search, 301);
		if (url.pathname === "/japan/census2020") return Response.redirect(url.origin + "/japan/census2020/" + url.search, 301);   // 裸パス＝正規の末尾スラッシュへ
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("Cross-Origin-Opener-Policy", "same-origin");
		h.set("Cross-Origin-Embedder-Policy", "credentialless");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
