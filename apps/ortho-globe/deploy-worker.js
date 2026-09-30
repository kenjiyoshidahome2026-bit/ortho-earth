// ortho-globe の配信口（Workers assets の前段・run_worker_first）。
// ①全レスポンスに COOP/COEP（credentialless）を刻む＝dev の vite と同条件（gint の SharedArrayBuffer の点火条件。無くてもコピー経路で動く）
// ②/globe（末尾スラッシュなし）→ /globe/
// ③共有エンジン（/globe/engine/<版>/・縮小計画 項目 9）の旧版＝この deploy の assets に無い版は R2（GIS/engine/<版>/…）から返す。
//   assets に入るのは今の版だけ＝先に上がった他のアプリ（world・geopbf）が指す前の版を消さないための控え。控えは uploader の「共有エンジン」ボタンが置く。
//   R2 の実体は native-bucket の put が gzip で置いたもの（httpMetadata.contentEncoding）＝解かずに gzip のまま返す（encodeBody: "manual"＝二重に縮めない）。
const ENGINE = /^\/globe\/engine\/([0-9a-f]{10})\/(.+)$/;
const COI = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" };
const engineFromR2 = async (env, pathname) => {
	const m = pathname.match(ENGINE); if (!m || !env.BUCKET) return null;
	const obj = await env.BUCKET.get(`GIS/engine/${m[1]}/${m[2]}`); if (!obj) return null;
	const h = new Headers({ ...COI, "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable", "ETag": obj.httpEtag });
	const enc = obj.httpMetadata?.contentEncoding;
	if (enc) h.set("Content-Encoding", enc);
	return new Response(obj.body, { headers: h, encodeBody: enc ? "manual" : "automatic" });
};
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === "/globe") return Response.redirect(url.origin + "/globe/" + url.search, 301);
		const res = await env.ASSETS.fetch(req);
		if (res.status === 404) { const old = await engineFromR2(env, url.pathname); if (old) return old; }
		const h = new Headers(res.headers);
		for (const [k, v] of Object.entries(COI)) h.set(k, v);
		if (res.ok && ENGINE.test(url.pathname)) h.set("Cache-Control", "public, max-age=31536000, immutable");   // 版の中身は変わらない
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
	},
};
