import { getCorsHeaders } from './cors.js';
import { proxy } from './proxy.js';
import { bucket } from './bucket.js';

export default {
  async fetch(req, env) {
    const corsHeaders = getCorsHeaders(req, env);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const { pathname } = new URL(req.url);
      let res;

      if (pathname.startsWith('/bucket')) {
        res = await bucket(req, env.MY_BUCKET);
      } else if (pathname.startsWith('/proxy')) {
        res = await proxy(req);
      } else {
        return await env.ASSETS.fetch(req);
      }

      const finalHeaders = new Headers(res.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => finalHeaders.set(k, v));

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: finalHeaders
      });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};