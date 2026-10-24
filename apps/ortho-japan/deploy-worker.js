// ortho-japan 配信 Worker：静的アセット（dist/site）に COOP/COEP を刻んで返すだけの薄い皮。
// この2ヘッダ＝crossOriginIsolated＝SharedArrayBuffer（gint バッファを worker へゼロコピーで渡す）の点火条件。
// ★必須ではない（2026-08-19 実測で訂正）：無ければ geopbf setGintBUF が通常 ArrayBuffer へ落ち、structured clone の
//   コピー1回を払って同じ結果を出す（Safari は COEP:credentialless 非対応＝元からこの世界で動いている）。
//   実測＝apps/ortho-japan `npm run verify:nocoi`（coi=false・SAB=false で gint/描画/識別 7ページ PASS）。
//   つまりここは「自前配信を速くする最適化」であって、SDK として第三者ページへ埋め込む条件ではない。
// dev（vite.config.js の middleware）と同一条件を本番にも刻む＝環境差ゼロ。
// run_worker_first（wrangler.toml）で全リクエストがここを通る＝worker の import graph 隅々までヘッダが乗る。
// 旧 /japan/… → /globe/…（apps/ortho-globe）。.html 付きの旧形も受ける
const MOVED_TO_GLOBE = {
	"/japan/earth": "/globe/", "/japan/earth.html": "/globe/",
	"/japan/quakes": "/globe/quakes/", "/japan/quakes.html": "/globe/quakes/",
	"/japan/sats": "/globe/sats", "/japan/sats.html": "/globe/sats",
};
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		// ルート/裸パスの導線：/ → /japan/（将来 www ルートに landing を置くまでの仮）。/japan → 正規の末尾スラッシュへ。
		if (url.pathname === "/" || url.pathname === "") return Response.redirect(url.origin + "/japan/", 302);
		if (url.pathname === "/japan") return Response.redirect(url.origin + "/japan/", 301);
		// 旧URL（初日だけ公開されていた /ortho-japan/…）は /japan/… へ恒久転送＝リンク切れゼロ。
		// 地域の申告を持たない頁は globe の家へ（2026-09-24）＝旧 URL（www のカード・共有リンク・QR）を 301 で送る。query は運ぶ（?start=equal 等）・hash はブラウザが運ぶ
		const moved = MOVED_TO_GLOBE[url.pathname];
		if (moved) return Response.redirect(url.origin + moved + url.search, 301);
		if (url.pathname === "/ortho-japan" || url.pathname.startsWith("/ortho-japan/"))
			return Response.redirect(url.origin + "/japan" + url.pathname.slice("/ortho-japan".length) + url.search, 301);
		const res = await env.ASSETS.fetch(req);
		const h = new Headers(res.headers);
		h.set("Cross-Origin-Opener-Policy", "same-origin");
		h.set("Cross-Origin-Embedder-Policy", "credentialless");
		h.set("X-Content-Type-Options", "nosniff");   // 配信物の型を推測させない（2026-10-24 監査）
		h.set("Referrer-Policy", "strict-origin-when-cross-origin");   // 外部のタイル鯖等へ URL の query（?g= 等）を漏らさない
		// lib/ortho-japan.d.ts＝拡張子 .ts をアセット配信が video/mp2t（MPEG-TS）と推定する＝型定義は text/plain で返す（2026-09-10・CDN 配信開始時に実測）
		if (url.pathname.endsWith(".d.ts")) h.set("Content-Type", "text/plain; charset=utf-8");
		// エディタ（ログイン・公開台帳・自分のファイルの操作がある頁）は他サイトの iframe に載せない＝クリックジャッキング封じ（2026-10-24 監査）。
		// /japan/ 本体は他サイトが iframe で埋め込む使い方（公開台帳の地図の共有）を残すため付けない
		if (url.pathname.startsWith("/japan/geoedit")) h.set("Content-Security-Policy", "frame-ancestors 'self'");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
