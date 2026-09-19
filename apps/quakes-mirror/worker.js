// 世界の地震（USGS ANSS ComCat・M2+）の確定した過去分（archive）を配るだけの Worker。
// 2026-09-19 本人裁定：直近分は取り込まない＝ビューア（apps/ortho-japan/quakes-worker.js）がブラウザから USGS FDSN を直接取り、
//   月ごとに GeoPBF へ焼いて IDB に置く（「直接取りに行くのが ortho 流」）。cron と CSV 置き場（recent/）は同日に撤去した。
// 形：R2（binding QUAKES）
//   archive.geopbf … 確定した過去分（手元で焼いて置く。下の手順）
//   archive.json   … { start, end(排他), minmag, n, bytes, builtAt }。end＝ビューアが USGS を直接取りに行く起点
// 配信（CORS 開放・ETag で 304）：
//   GET /quakes/archive.geopbf   GET /quakes/archive.json   GET /quakes/status（見張り用＝archive.json の中身）
// archive の焼き直し（年 1 回程度＝直近分が 2 年に近づいたら。境目は月初にそろえる。M≥7 の地名が既定で載る）：
//   node scripts/usgs-quakes-build.mjs --end 2026-08-31 --manifest --out usgs-quakes-archive.geopbf
//   npx wrangler r2 object put ortho-quakes/archive.geopbf --file usgs-quakes-archive.geopbf --remote
//   npx wrangler r2 object put ortho-quakes/archive.json --file usgs-quakes-archive.geopbf.json --remote
const K = { archive: "archive.geopbf", archiveMeta: "archive.json" };
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Cross-Origin-Resource-Policy": "cross-origin" };
const json = (obj, status = 200, cache = "no-store") => new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache } });

export async function serve(req, env) {
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
	const path = new URL(req.url).pathname.replace(/^\/quakes/, "");
	if (path === "/status") {
		const o = await env.QUAKES.get(K.archiveMeta);
		return json({ archive: o ? await o.json() : null });
	}
	let key, type, cache;
	if (path === "/archive.geopbf") [key, type, cache] = [K.archive, "application/octet-stream", "public, max-age=86400"];
	else if (path === "/archive.json") [key, type, cache] = [K.archiveMeta, "application/json", "public, max-age=600"];
	else return json({ error: "not found" }, 404);
	const obj = await env.QUAKES.get(key, { onlyIf: req.headers });
	if (!obj) return json({ error: `${key} not built yet` }, 503);
	const headers = { ...CORS, "Content-Type": type, ETag: obj.httpEtag, "Last-Modified": obj.uploaded.toUTCString(), "Cache-Control": cache };
	if (!("body" in obj)) return new Response(null, { status: 304, headers });   // If-None-Match 一致
	return new Response(req.method === "HEAD" ? null : obj.body, { headers: { ...headers, "Content-Length": String(obj.size) } });
}

export default { fetch: (req, env) => serve(req, env) };
