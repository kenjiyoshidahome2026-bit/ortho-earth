// ortho-japan 配信 Worker：静的アセット（dist/site）に COOP/COEP を刻んで返すだけの薄い皮。
// SharedArrayBuffer（gint）には crossOriginIsolated が必須＝この2ヘッダが無いと worker 全滅→黒画面。
// dev（vite.config.js の middleware）と同一条件を本番にも刻む＝環境差ゼロ。
// run_worker_first（wrangler.toml）で全リクエストがここを通る＝worker の import graph 隅々までヘッダが乗る。
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		// ルート/裸パスの導線：/ → /ortho-japan/（将来 www ルートに landing を置くまでの仮）。/ortho-japan → 正規の末尾スラッシュへ。
		if (url.pathname === "/" || url.pathname === "") return Response.redirect(url.origin + "/ortho-japan/", 302);
		if (url.pathname === "/ortho-japan") return Response.redirect(url.origin + "/ortho-japan/", 301);
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("Cross-Origin-Opener-Policy", "same-origin");
		h.set("Cross-Origin-Embedder-Policy", "credentialless");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
