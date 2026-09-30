// ortho-globe の配信口（Workers assets の前段・run_worker_first）。
// ①全レスポンスに COOP/COEP（credentialless）を刻む＝dev の vite と同条件（gint の SharedArrayBuffer の点火条件。無くてもコピー経路で動く）
// ②/globe（末尾スラッシュなし）→ /globe/
// ③共有エンジン（/globe/engine/<版>/・縮小計画 項目 9）の旧版＝この deploy の assets に無い版の入口（globe.js・maplibre.js・i18n.js・core.js・geopbf.js・globe.css）は
//   今の版の同じ名前へ 302 で送る。入口の名前は版を跨いで同じ＝前の版を指したまま出ている他のアプリ（world・geopbf）も今のエンジンで動く。
//   送った先の URL がモジュールの住所になる（import.meta.url）＝チャンク・worker は今の版から引かれ、4 つの入口は同じ実体に揃う。
//   今の版は assets の engine/current.json（ortho-globe の build が置く）。入口でない旧版のチャンクは 404 のまま（R2 に控えは置かない＝本人 2026-09-30）。
const ENGINE = /^\/globe\/engine\/([0-9a-f]{10})\/(.+)$/;
const ENTRY = /^(globe|maplibre|i18n|core|geopbf)\.js$|^globe\.css$/;   // maplibre＝MapLibre 互換の口（www の /maplibre/ の例が import map で指す・2026-10-01）
const COI = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" };
const toCurrent = async (env, url) => {
	const m = url.pathname.match(ENGINE); if (!m || !ENTRY.test(m[2])) return null;
	const cur = await env.ASSETS.fetch(new Request(url.origin + "/globe/engine/current.json")).then(r => r.ok ? r.json() : null).catch(() => null);
	if (!cur?.version || cur.version === m[1]) return null;
	return new Response(null, { status: 302, headers: { ...COI, Location: `/globe/engine/${cur.version}/${m[2]}`, "Cache-Control": "no-store" } });
};
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === "/globe") return Response.redirect(url.origin + "/globe/" + url.search, 301);
		const res = await env.ASSETS.fetch(req);
		if (res.status === 404) { const moved = await toCurrent(env, url); if (moved) return moved; }
		const h = new Headers(res.headers);
		for (const [k, v] of Object.entries(COI)) h.set(k, v);
		if (res.ok && ENGINE.test(url.pathname)) h.set("Cache-Control", "public, max-age=31536000, immutable");   // 版の中身は変わらない
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
