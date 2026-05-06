export async function bucket(request, bucket) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.split('/bucket/').pop());
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
                const meta = {
                    Key: obj.key,
                    Size: obj.size,
                    LastModified: obj.uploaded,
                    ETag: (obj.httpEtag || "").replace(/"/g, ""),
                    ContentEncoding: obj.httpMetadata?.contentEncoding || ""
                };
                return new Response(JSON.stringify({ data: meta }), { headers: { "Content-Type": "application/json" } });
            }
            return new Response(obj.body, {
                headers: {
                    "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
                    "Content-Encoding": obj.httpMetadata?.contentEncoding || "",
                    "Content-Length": obj.size, "ETag": obj.httpEtag
                }
            });
        }
         if (request.method === "POST") {
            const clientApiKey = request.headers.get("X-API-Key");
            if (clientApiKey !== env.API_KEY) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), { 
                    status: 401, headers: { "Content-Type": "application/json" }
                });
            }
            const action = request.headers.get("X-Action");
            if (action === "put") { // 通常のアップロード
                const contentType = request.headers.get("X-Metadata-Type") || "application/octet-stream";
                await bucket.put(path, request.body, { httpMetadata: { contentType } });
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
                const upload = bucket.resumeMultipartUpload(path, uploadId);
                const part = await upload.uploadPart(partNumber, request.body);
                return new Response(JSON.stringify({ etag: part.etag }));
            }
            if (action === "mp-complete") { // マルチパートアップロード: 完了
                const { uploadId, parts } = await request.json();
                const upload = bucket.resumeMultipartUpload(path, uploadId);
                await upload.complete(parts.sort((a, b) => a.partNumber - b.partNumber));
                return new Response(JSON.stringify({ data: "ok" }));
            }
            if (action === "del") { // 削除処理
                await bucket.delete(path);
                return new Response(JSON.stringify({ data: "ok" }));
            }
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    return new Response("Method Not Allowed", { status: 405 });
}