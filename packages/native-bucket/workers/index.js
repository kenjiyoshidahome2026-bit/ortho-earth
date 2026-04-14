// workers/index.js の修正
import { getCorsHeaders } from './cors.js';
import { proxy } from './proxy.js';
import { bucket } from './bucket.js';

export default {
  async fetch(req, env) {
    const h = getCorsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

    try {
      const { pathname } = new URL(req.url);
      let res;
      if (pathname.startsWith('/bucket')) {
        res = await bucket(req, env.MY_BUCKET);
      } else if (pathname.startsWith('/proxy')) {
        res = await proxy(req);
      }

      if (!res) return new Response("Not Found", { status: 404, headers: h });

      // 元のレスポンスヘッダーをコピーしつつ、CORSを上書き
      const outHeaders = new Headers(res.headers);
      h.forEach((v, k) => outHeaders.set(k, v));

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: outHeaders
      });
    } catch (e) { 
      return new Response(JSON.stringify({error: e.message}), { status: 500, headers: h }); 
    }
  }
};