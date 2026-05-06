/**
 * R2バケット操作モジュール
 * GET: リスト取得（末尾 / の場合）およびファイル取得/メタデータ取得
 * POST: アップロード（通常/マルチパート）および削除
 */
export async function bucket(request, bucket) {
    const url = new URL(request.url);
    // /bucket/ 以降のパスを取得し、デコードする
    const path = decodeURIComponent(url.pathname.split('/bucket/').pop());

    try {
        // --- GETリクエスト: 取得処理 ---
        if (request.method === "GET") {
            // 1. リスト取得処理 (パスが / で終わる場合)
            if (path.endsWith('/') || path === "") {
                let allObjects = [];
                let cursor = undefined;
                let truncated = true;

                // 1,000個以上のアイテムがある場合、すべて取得するまでループ
                while (truncated) {
                    const list = await bucket.list({
                        prefix: path || undefined,
                        cursor: cursor,
                        delimiter: '/' // フォルダ階層として扱う場合
                    });

                    allObjects.push(...(list.objects || []));
                    truncated = list.truncated;
                    cursor = list.cursor;
                }

                // フロントエンドが扱いやすい形式に整形して返却
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

            // 2. 個別ファイル取得またはメタデータ取得
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
                return new Response(JSON.stringify({ data: meta }), {
                    headers: { "Content-Type": "application/json" }
                });
            }

            // ファイル本体の返却
            return new Response(obj.body, {
                headers: {
                    "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
                    "Content-Encoding": obj.httpMetadata?.contentEncoding || "",
                    "Content-Length": obj.size,
                    "ETag": obj.httpEtag
                }
            });
        }

        // --- POSTリクエスト: 書き込み・削除処理 ---
        if (request.method === "POST") {
            const action = request.headers.get("X-Action");

            // 通常のアップロード
            if (action === "put") {
                const contentType = request.headers.get("X-Metadata-Type") || "application/octet-stream";
                await bucket.put(path, request.body, { httpMetadata: { contentType } });
                return new Response(JSON.stringify({ data: "ok" }));
            }

            // マルチパートアップロード: 開始
            if (action === "mp-create") {
                const contentType = request.headers.get("X-Metadata-Type") || "application/octet-stream";
                const contentEncoding = request.headers.get("X-Content-Encoding");
                const upload = await bucket.createMultipartUpload(path, {
                    httpMetadata: { contentType, contentEncoding }
                });
                return new Response(JSON.stringify({ uploadId: upload.uploadId }));
            }

            // マルチパートアップロード: パーツ送信
            if (action === "mp-upload") {
                const uploadId = request.headers.get("X-Upload-ID");
                const partNumber = parseInt(request.headers.get("X-Part-Number"));
                const upload = bucket.resumeMultipartUpload(path, uploadId);
                const part = await upload.uploadPart(partNumber, request.body);
                return new Response(JSON.stringify({ etag: part.etag }));
            }

            // マルチパートアップロード: 完了
            if (action === "mp-complete") {
                const { uploadId, parts } = await request.json();
                const upload = bucket.resumeMultipartUpload(path, uploadId);
                await upload.complete(parts.sort((a, b) => a.partNumber - b.partNumber));
                return new Response(JSON.stringify({ data: "ok" }));
            }

            // 削除処理
            if (action === "del") {
                await bucket.delete(path);
                return new Response(JSON.stringify({ data: "ok" }));
            }
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { 
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }

    return new Response("Method Not Allowed", { status: 405 });
}