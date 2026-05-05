// packages/native-bucket/workers/cors.js

export function getCorsHeaders(request, env) {
    const headers = new Headers();
    const origin = request.headers.get("Origin");
    const method = request.method;

    // GET, HEAD, OPTIONS（プリフライト）の場合は全開放
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        headers.set("Access-Control-Allow-Origin", "*");
    } 
    // PUT, POST, DELETE 等の書き込み処理は既存のドメイン制約を維持
    else if (origin && origin !== "null") {
        const allowedList = env.ALLOWED_DOMAINS.split(",").map(d => d.trim());
        const isAllowed = allowedList.some(t => !!(
            origin === t || 
            origin.endsWith("." + t) || 
            origin.endsWith("://" + t)
        ));
        if (isAllowed) {
            headers.set("Access-Control-Allow-Origin", origin);
        }
    }

    headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Range, Authorization, x-action, x-metadata-type, x-part-number, x-upload-id, x-content-encoding");
    headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, X-File-List");
    
    return headers;
}