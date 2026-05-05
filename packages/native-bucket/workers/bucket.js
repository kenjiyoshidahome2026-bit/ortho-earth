export async function bucket(request, bucket) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.split('/bucket/').pop());
    
    try {
        if (request.method === "GET") {
            // --- 💡 追加: 生存確認 & ディレクトリ参照のハンドリング ---
            // パスが空（ルート）またはフォルダ（/で終わる）へのGETは生存確認とみなす
            if (path === "" || path.endsWith("/")) {
                // 実際にR2へ接続を試みる（最小限のリスト取得）
                const check = await bucket.list({ prefix: path || undefined, limit: 1 });
                return new Response(JSON.stringify({ 
                    data: "ok", 
                    status: "alive",
                    path: path || "(root)" 
                }), { headers: { "Content-Type": "application/json" } });
            }

            const isMeta = url.searchParams.has("meta");
            const obj = await (isMeta ? bucket.head(path) : bucket.get(path));           
            if (!obj) return new Response(JSON.stringify({ data: null }), { status: 404 });

            if (isMeta) {
                const meta = { 
                    Key: obj.key, Size: obj.size, LastModified: obj.uploaded,
                    ETag: (obj.httpEtag || "").replace(/"/g, ""),
                    ContentEncoding: obj.httpMetadata?.contentEncoding || ""
                };
                return new Response(JSON.stringify({ data: meta }));
            }

            return new Response(obj.body, {
                headers: {
                    "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
                    "Content-Encoding": obj.httpMetadata?.contentEncoding || "",
                    "Content-Length": obj.size,
                    "ETag": obj.httpEtag
                }
            });
        }

        if (request.method === "POST") {
            const action = request.headers.get("X-Action");
            // ... (既存の POST ロジック: put, mp-create, mp-upload, complete, del, list)
            // ※生存確認としての list(POST) も残しておいて問題ありませんが、
            //   Viewer側の Bucket.js で isAlive() を GET に書き換えるのがベストです。
            if (action === "list") {
                const body = await request.json().catch(() => ({}));
                const list = await bucket.list({ 
                    prefix: path || undefined, 
                    cursor: body.continuationToken || undefined,
                    limit: body.limit || 1
                });
                return new Response(JSON.stringify({
                    data: {
                        Contents: (list.objects || []).map(o => ({ 
                            Key: o.key, Size: o.size, LastModified: o.uploaded,
                            ETag: (o.httpEtag || "").replace(/"/g, "") 
                        })),
                        IsTruncated: list.truncated,
                        NextContinuationToken: list.cursor || null
                    }
                }), { headers: { "Content-Type": "application/json" } });
            }
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
    return new Response("Method Not Allowed", { status: 405 });
}