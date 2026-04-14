export async function bucket(request, bucket) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname.split('/bucket/').pop());
     try {
        if (request.method === "GET") {
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
            if (action === "put") {
                const contentType = request.headers.get("X-Metadata-Type") || "application/octet-stream";
                await bucket.put(path, request.body, { httpMetadata: { contentType } });
                return new Response(JSON.stringify({ data: "ok" }));
            }
            if (action === "mp-create") {
                const contentType = request.headers.get("X-Metadata-Type") || "application/octet-stream";
                const contentEncoding = request.headers.get("X-Content-Encoding");
                const upload = await bucket.createMultipartUpload(path, {
                    httpMetadata: { contentType, contentEncoding }
                });
                return new Response(JSON.stringify({ uploadId: upload.uploadId }));
            }
            if (action === "mp-upload") {
                const uploadId = request.headers.get("X-Upload-ID");
                const partNumber = parseInt(request.headers.get("X-Part-Number"));
                const upload = bucket.resumeMultipartUpload(path, uploadId);
                const part = await upload.uploadPart(partNumber, request.body);
                return new Response(JSON.stringify({ etag: part.etag }));
            }
            if (action === "mp-complete") {
                const { uploadId, parts } = await request.json();
                const upload = bucket.resumeMultipartUpload(path, uploadId);
                await upload.complete(parts.sort((a, b) => a.partNumber - b.partNumber));
                return new Response(JSON.stringify({ data: "ok" }));
            }
            if (action === "del") {
                await bucket.delete(path);
                return new Response(JSON.stringify({ data: "ok" }));
            }
            if (action === "list") {
                const body = await request.json().catch(() => ({}));
                // path が空（バケット直下）でも動作するように prefix を調整
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