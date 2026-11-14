// unmap 配信 Worker：静的アセット（dist/site）に COOP/COEP と noindex を刻んで返すだけの薄い皮（yokohama・kyoto と同型）。
// COOP/COEP＝crossOriginIsolated（SharedArrayBuffer）。dev（vite.config.js の crossOriginIsolation）と同じ条件。
// X-Robots-Tag: noindex＝検索に載せない（本人の裁定 2026-11-15「本番に載せる・リンクなし」＝実験・国連職員向け）。
// robots.txt の Disallow は足さない＝道を公開の一覧に書くことになる・巡回が noindex を読めなくなる。
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === "/unmap") return Response.redirect(url.origin + "/unmap/", 301);   // 裸パス＝正規の末尾スラッシュへ
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("Cross-Origin-Opener-Policy", "same-origin");
		h.set("Cross-Origin-Embedder-Policy", "credentialless");
		h.set("X-Content-Type-Options", "nosniff");
		h.set("Referrer-Policy", "strict-origin-when-cross-origin");
		h.set("X-Robots-Tag", "noindex, nofollow");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
