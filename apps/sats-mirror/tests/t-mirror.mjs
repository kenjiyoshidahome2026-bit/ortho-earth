#!/usr/bin/env node
// sats-mirror の検定＝偽 KV＋偽 fetch。CelesTrak へは一度も触れない（触ると本物の 2 時間制限を食う）。
//   取得：保存 → 110 分以内は見送り → 断り文は見送り（古いミラー温存）→ 200 以外は停止札 → 札がある間は fetch しない → 札を消せば再開
//   配信：空は 503 → /active.csv は gzip のまま・CORS 開放 → /status → 知らない道は 404
//   node apps/sats-mirror/tests/t-mirror.mjs
import { mirror, serve } from "../worker.js";

const store = new Map();
const kv = {
	get: async (k, type) => { if (!store.has(k)) return null; const v = store.get(k); return type === "json" ? JSON.parse(v) : v; },
	put: async (k, v) => { store.set(k, v); },
	delete: async k => { store.delete(k); },
};
const env = { SATS: kv };
let calls = 0;
const reply = (status, body) => async () => { calls++; return new Response(body, { status }); };
const CSV = "OBJECT_NAME,OBJECT_ID,EPOCH\nISS (ZARYA),1998-067A,2026-09-18T15:48:46.939968\n";
const get = p => serve(new Request("https://www.ortho-earth.com/sats" + p), env);
let fail = 0;
const ok = (name, cond, got) => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${got !== undefined ? "  (" + got + ")" : ""}`); };
const T0 = Date.UTC(2026, 8, 19, 0, 25);
console.log = (...a) => a[0]?.startsWith?.("[sats-mirror]") || process.stdout.write(a.join(" ") + "\n");
console.warn = console.error = () => {};

ok("empty → 503", (await get("/active.csv")).status === 503);
ok("stored", (await mirror(env, T0, reply(200, CSV))) === "stored");
const r = await get("/active.csv"), buf = new Uint8Array(await r.arrayBuffer());
ok("serve gzip body + headers", r.status === 200 && buf[0] === 0x1f && buf[1] === 0x8b && r.headers.get("content-encoding") === "gzip" && r.headers.get("access-control-allow-origin") === "*");
const back = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
ok("round trip", back === CSV);
const st = await (await get("/status")).json();
ok("status", st.fetchedAt === T0 && st.rows === 1 && st.halted === false, JSON.stringify(st));
calls = 0;
const before = store.get("active.csv.gz");
ok("fresh (<110min) skips fetch", (await mirror(env, T0 + 60 * 60e3, reply(200, CSV))) === "fresh" && calls === 0, calls);
ok("403 not-updated (real CelesTrak form) = refused, no halt", (await mirror(env, T0 + 115 * 60e3, reply(403, "GP data has not updated since your last successful\r\ndownload of GROUP=active at 2026-09-18 23:19:34 UTC."))) === "refused" && !store.has("halt") && store.get("active.csv.gz") === before);
ok("200 non-CSV keeps old mirror", (await mirror(env, T0 + 120 * 60e3, reply(200, "GP data has not updated since your last successful\ndownload"))) === "refused" && store.get("active.csv.gz") === before);
ok("403 → halt", (await mirror(env, T0 + 180 * 60e3, reply(403, "Forbidden"))) === "error" && store.has("halt"));
ok("status shows halt", (await (await get("/status")).json()).halted.status === 403);
calls = 0;
ok("halted → no fetch", (await mirror(env, T0 + 300 * 60e3, reply(200, CSV))) === "halted" && calls === 0, calls);
ok("mirror still served while halted", (await get("/active.csv")).status === 200);
store.delete("halt");
ok("human clears halt → resumes", (await mirror(env, T0 + 360 * 60e3, reply(200, CSV))) === "stored");
ok("unknown path → 404", (await get("/x")).status === 404);
ok("POST → 405", (await serve(new Request("https://www.ortho-earth.com/sats/active.csv", { method: "POST" }), env)).status === 405);
process.stdout.write(fail ? `\n${fail} FAILED\n` : "\nall ok\n");
process.exit(fail ? 1 : 0);
