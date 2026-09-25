import { keyMatches } from './proxy.js';

export async function bucket(request, bucket, ctx, env = {}) {
	const url = new URL(request.url);
	const path = decodeURIComponent(url.pathname.split('/bucket/').pop());
	const cache = caches.default;
	// 書いた・消した後はこの道の GET キャッシュを捨てる（B18・旧＝s-maxage=3600 の間、古い本体を返し続けた）。
	// ⚠ 本番の実測（2026-09-25・SJC）＝同じ拠点でも効かない回がある（3 回中 1 回だけ効いた・delete は "deleted" を返しても次の GET が HIT）＝best effort。
	//   確実にするには s-maxage を縮めるか、GET で R2 の ETag を照合する（未決）。結果は tail で見える（[bucket] purge …）
	// ⚠ Cache API はデータセンター単位＝消えるのは書き込みを受けた拠点の分だけ。他拠点は s-maxage（1 時間）で自然に切れる
	//   （全拠点を即時に消すにはゾーンの purge API＝API トークンが要る）。?v= 等の query 付きの版も別の鍵＝消えない
	const purge = () => ctx?.waitUntil?.(cache.delete(new Request(url.origin + url.pathname, { method: "GET" }))
		.then(ok => console.log(`[bucket] purge ${url.pathname} ${ok ? "deleted" : "not-cached"}`), e => console.warn(`[bucket] purge ${url.pathname} failed`, e?.message)));
	if (request.method === "GET") {
		const res = await cache.match(request); if (res) return res;
	} 
	try {
		if (request.method === "GET") {
			 if (path.endsWith('/') || path === "") {
				let allObjects = [];
				let cursor = undefined;
				let truncated = true;
				while (truncated) {
					const list = await bucket.list({ prefix: path || undefined, cursor: cursor, delimiter: '/' });
					allObjects.push(...(list.objects || []));
					truncated = list.truncated;
					cursor = list.cursor;
				}
				return new Response(JSON.stringify({
					data: {
						Contents: allObjects.map(o => ({
							Key: o.key,
							Size: o.size,
							LastModified: o.uploaded,
							ETag: (o.httpEtag || "").replace(/"/g, "")
						})),
						IsTruncated: false, // 全件取得済みのため
						NextContinuationToken: null
					}
				}), { headers: { "Content-Type": "application/json" } });
			}
			const isMeta = url.searchParams.has("meta");
			const obj = await (isMeta ? bucket.head(path) : bucket.get(path));
			if (!obj) return new Response(JSON.stringify({ data: null }), { status: 404 });
			if (isMeta) {
				const meta = { Key: obj.key, Size: obj.size, LastModified: obj.uploaded,
					ETag: (obj.httpEtag || "").replace(/"/g, ""),
					ContentEncoding: obj.httpMetadata?.contentEncoding || ""
				};
				return new Response(JSON.stringify({ data: meta }), { headers: { "Content-Type": "application/json" } });
			}
			const response = new Response(obj.body, {
				headers: {
					"Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
					"Content-Encoding": obj.httpMetadata?.contentEncoding || "",
					"Content-Length": obj.size, "ETag": obj.httpEtag,
					"Cache-Control": "public, s-maxage=3600, max-age=60"
				}
			});
			(response.status === 200) && ctx.waitUntil(cache.put(request, response.clone()));
			return response;
		}
		 if (request.method === "POST") {
			if (!keyMatches(request, env)) {   // 定数時間で比べる（API_KEY 未設定なら誰も書けない）
				return new Response(JSON.stringify({ error: "Unauthorized" }), { 
					status: 401, headers: { "Content-Type": "application/json" }
				});
			}
			const action = request.headers.get("X-Action");
			if (action === "put") { // 通常のアップロード
				const contentType = request.headers.get("X-Metadata-Type") || "application/octet-stream";
				const contentEncoding = request.headers.get("X-Content-Encoding");
				await bucket.put(path, request.body, { httpMetadata: { contentType, contentEncoding } });
				purge();
				return new Response(JSON.stringify({ data: "ok" }));
			}
			if (action === "mp-create") { // マルチパートアップロード: 開始
				const contentType = request.headers.get("X-Metadata-Type") || "application/octet-stream";
				const contentEncoding = request.headers.get("X-Content-Encoding");
				const upload = await bucket.createMultipartUpload(path, { httpMetadata: { contentType, contentEncoding } });
				return new Response(JSON.stringify({ uploadId: upload.uploadId }));
			}
			if (action === "mp-upload") { // マルチパートアップロード: パーツ送信
				const uploadId = request.headers.get("X-Upload-ID");
				const partNumber = parseInt(request.headers.get("X-Part-Number"));
				if (!uploadId || isNaN(partNumber)) return new Response(JSON.stringify({ error: "Missing X-Upload-ID or X-Part-Number" }), { status: 400, headers: { "Content-Type": "application/json" } });
				const upload = bucket.resumeMultipartUpload(path, uploadId);
				const part = await upload.uploadPart(partNumber, request.body);
				return new Response(JSON.stringify({ etag: part.etag }));
			}
			if (action === "mp-complete") { // マルチパートアップロード: 完了
				const { uploadId, parts } = await request.json();
				const upload = bucket.resumeMultipartUpload(path, uploadId);
				await upload.complete(parts.sort((a, b) => a.partNumber - b.partNumber));
				purge();
				return new Response(JSON.stringify({ data: "ok" }));
			}
			if (action === "del") { // 削除処理
				await bucket.delete(path);
				purge();
				return new Response(JSON.stringify({ data: "ok" }));
			}
		}
	} catch (e) {
		return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
	}
	return new Response("Method Not Allowed", { status: 405 });
}