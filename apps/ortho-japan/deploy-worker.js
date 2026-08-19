// ortho-japan 配信 Worker：静的アセット（dist/site）に COOP/COEP を刻んで返すだけの薄い皮。
// この2ヘッダ＝crossOriginIsolated＝SharedArrayBuffer（gint バッファを worker へゼロコピーで渡す）の点火条件。
// ★必須ではない（2026-08-19 実測で訂正）：無ければ geopbf setGintBUF が通常 ArrayBuffer へ落ち、structured clone の
//   コピー1回を払って同じ結果を出す（Safari は COEP:credentialless 非対応＝元からこの世界で動いている）。
//   実測＝apps/ortho-japan `npm run verify:nocoi`（coi=false・SAB=false で gint/描画/識別 7ページ PASS）。
//   つまりここは「自前配信を速くする最適化」であって、SDK として第三者ページへ埋め込む条件ではない。
// dev（vite.config.js の middleware）と同一条件を本番にも刻む＝環境差ゼロ。
// run_worker_first（wrangler.toml）で全リクエストがここを通る＝worker の import graph 隅々までヘッダが乗る。
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		// ルート/裸パスの導線：/ → /japan/（将来 www ルートに landing を置くまでの仮）。/japan → 正規の末尾スラッシュへ。
		if (url.pathname === "/" || url.pathname === "") return Response.redirect(url.origin + "/japan/", 302);
		if (url.pathname === "/japan") return Response.redirect(url.origin + "/japan/", 301);
		// 旧URL（初日だけ公開されていた /ortho-japan/…）は /japan/… へ恒久転送＝リンク切れゼロ。
		if (url.pathname === "/ortho-japan" || url.pathname.startsWith("/ortho-japan/"))
			return Response.redirect(url.origin + "/japan" + url.pathname.slice("/ortho-japan".length) + url.search, 301);
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("Cross-Origin-Opener-Policy", "same-origin");
		h.set("Cross-Origin-Embedder-Policy", "credentialless");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
