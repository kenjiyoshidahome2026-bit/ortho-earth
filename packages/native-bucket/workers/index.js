// packages/native-bucket/workers/index.js

import { getCorsHeaders } from './cors.js';
import { proxy } from './proxy.js';
import { bucket } from './bucket.js';

export default {
    async fetch(req, env) {
        const method = req.method;
        const origin = req.headers.get("Origin");
        
        // --- 1. CORSヘッダーの初期決定ロジック ---
        const h = getCorsHeaders(req, env); // cors.js の基本設定を読み込む

        if (method === "GET" || method === "HEAD") {
            h.set("Access-Control-Allow-Origin", "*");
        } else {
            // PUT/POST/OPTIONS 等は ALLOWED_DOMAINS を参照
            const allowedDomains = (env.ALLOWED_DOMAINS || "").split(',').map(d => d.trim());
            const isAllowed = origin && allowedDomains.some(domain => origin.includes(domain));

            if (isAllowed) {
                h.set("Access-Control-Allow-Origin", origin);
                h.set("Vary", "Origin");
            } else {
                h.set("Access-Control-Allow-Origin", "https://www.ortho-earth.com");
            }
        }

        // --- 2. プリフライト(OPTIONS)への即時応答 ---
        // これが抜けているか、ヘッダーが不十分だとPOST/PUTが死にます
        if (method === "OPTIONS") {
            return new Response(null, { 
                status: 204, 
                headers: h 
            });
        }

        // --- 3. メインルーティング ---
        try {
            const url = new URL(req.url);
            const { pathname } = url;
            let res;

            if (pathname.startsWith('/bucket')) {
                res = await bucket(req, env.MY_BUCKET);
            } else if (pathname.startsWith('/proxy')) {
                res = await proxy(req);
            }

            // res が null の場合や 404 の場合も CORS ヘッダーを付けて返す
            if (!res) {
                return new Response("Not Found", { status: 404, headers: h });
            }

            // 既存のレスポンスにCORSヘッダーを合成
            const outHeaders = new Headers(res.headers);
            h.forEach((v, k) => outHeaders.set(k, v));

            // キャッシュ設定
            if (method === "GET" && res.ok) {
                outHeaders.set("Cache-Control", "public, max-age=604800");
            }

            return new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers: outHeaders
            });

        } catch (e) { 
            return new Response(JSON.stringify({error: e.message}), { 
                status: 500, 
                headers: h 
            }); 
        }
    }
};